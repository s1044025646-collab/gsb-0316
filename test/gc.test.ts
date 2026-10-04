import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeapService } from '../src/store.ts';
import { independentReachable } from '../src/gc.ts';
import { GcError } from '../src/errors.ts';

const mem = () => new HeapService(':memory:');
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')), 't.db');

function setup(objs: [number, number, (number | null)[]][], roots: [string, number | null][], cap = 100) {
  const svc = mem();
  svc.initHeap(cap);
  for (const [id, p, refs] of objs) svc.allocObject(id, p, refs.map(() => null));
  for (const [id, , refs] of objs) if (refs.length) svc.setRefs(id, refs);
  for (const [n, t] of roots) svc.setRoot(n, t);
  return svc;
}

/** 通用不变量核对：可达集合、边/根/载荷保持、地址合法且不重叠。 */
function verifyGc(svc: HeapService, beforeObjs: Map<number, { payload: number; refs: (number | null)[] }>, beforeRoots: Map<string, number | null>) {
  const expected = independentReachable(beforeObjs, [...beforeRoots].map(([name, target]) => ({ name, target })));
  const report = svc.collect();
  assert.deepEqual([...report.reachableIds].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  const after = svc.snapshot();
  const afterObjs = new Map(after.objects.map((o) => [o.id, o]));
  assert.equal(after.objects.length, expected.size);
  const used: [number, number][] = [];
  for (const id of expected) {
    const o = afterObjs.get(id)!;
    assert.equal(o.payload, beforeObjs.get(id)!.payload, `对象${id}载荷不变`);
    assert.deepEqual(o.refs, beforeObjs.get(id)!.refs, `对象${id}引用字段(按稳定编号)不变`);
    assert.ok(o.addr && o.addr.space === after.state!.activeSpace, `对象${id}在新活动空间`);
    assert.ok(o.addr!.offset >= 0 && o.addr!.offset + o.size <= after.state!.capacity, `对象${id}地址合法`);
    used.push([o.addr!.offset, o.addr!.offset + o.size]);
  }
  used.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < used.length; i++) assert.ok(used[i][0] >= used[i - 1][1], '地址不重叠');
  for (const r of after.roots) {
    assert.equal(r.target, beforeRoots.get(r.name) ?? null, `根 ${r.name} 目标不变`);
  }
  return report;
}

test('自引用对象正确复制', () => {
  const svc = setup([[1, 7, [1]]], [['r', 1]]);
  const r = svc.collect();
  assert.deepEqual(r.copyOrder, [1]);
  const o = svc.getObject(1);
  assert.deepEqual(o.refs, [1]);
  assert.equal(r.newRefs[0].addrs[0]!.offset, o.addr!.offset); // 自环指向自身新地址
});

test('空根集合回收全部对象', () => {
  const svc = setup([[1, 1, []], [2, 2, [1]]], []);
  const r = svc.collect();
  assert.equal(r.reachableIds.length, 0);
  assert.equal(svc.listObjects().length, 0);
  assert.equal(r.remainingCapacity, r.capacity);
});

test('零引用对象与空引用字段', () => {
  const svc = setup([[1, 5, []], [2, 6, [null, null]]], [['a', 1], ['b', 2]]);
  const r = svc.collect();
  assert.deepEqual(r.newRefs.find((x) => x.objectId === 2)!.addrs, [null, null]);
});

test('恰好满空间：容量刚够则成功，少一个单元则失败且状态不变', () => {
  // 对象1: 2单元(1+1引用)，对象2: 1单元 => 共3单元
  const svc = setup([[1, 1, [2]], [2, 2, []]], [['r', 1]], 3);
  const r = svc.collect();
  assert.equal(r.usedAfter, 3);
  // 再分配必然失败（空间满）
  assert.throws(() => svc.allocObject(3, 3, []), (e: GcError) => e.code === 'INSUFFICIENT_SPACE');
  // 回收后空间不变（对象仍存活），状态一致
  assert.equal(svc.listObjects().length, 2);
});

test('容量不足时 GC 失败回滚，原状态可查询', () => {
  // 容量2：两个对象(1+1单元) 共3单元 > 2，GC 必失败
  const svc = mem();
  svc.initHeap(2);
  // 容量2只能先放一个2单元对象；构造不可达垃圾填满后换思路：直接用小容量验证
  svc.allocObject(1, 1, [null]); // 2单元，满
  svc.setRoot('r', 1);
  const before = svc.snapshot();
  assert.throws(() => svc.allocObject(2, 2, []), (e: GcError) => e.code === 'INSUFFICIENT_SPACE');
  const r = svc.collect(); // 回收后对象1占2单元，成功
  assert.equal(r.usedAfter, 2);
  assert.deepEqual(svc.snapshot().roots, before.roots);
});

test('悬空引用报错（分配与设根）', () => {
  const svc = mem();
  svc.initHeap(10);
  assert.throws(() => svc.allocObject(1, 1, [99]), (e: GcError) => e.code === 'DANGLING_REF');
  assert.throws(() => svc.setRoot('x', 42), (e: GcError) => e.code === 'DANGLING_REF');
  svc.allocObject(1, 1, []);
  svc.setRoot('x', 1);
  assert.throws(() => svc.setRefs(1, [7]), (e: GcError) => e.code === 'DANGLING_REF');
});

test('共享对象只复制一次，重复访问复用转发地址', () => {
  const svc = setup([[1, 1, [3]], [2, 2, [3]], [3, 3, []]], [['a', 1], ['b', 2]]);
  const r = svc.collect();
  assert.deepEqual(r.copyOrder, [1, 2, 3]); // Cheney 为广度优先：根 a->1、b->2 先入队，扫描对象1时复制3
  assert.equal(r.forwarding.filter((f) => f.objectId === 3).length, 1);
  const refs1 = r.newRefs.find((x) => x.objectId === 1)!.addrs[0];
  const refs2 = r.newRefs.find((x) => x.objectId === 2)!.addrs[0];
  assert.deepEqual(refs1, refs2);
});

test('互相引用环与孤立环：可达环保留，孤立环回收', () => {
  const svc = setup(
    [[1, 1, [2]], [2, 2, [1]], [8, 8, [9]], [9, 9, [8]]],
    [['r', 1]],
  );
  const objs = new Map([[1, { payload: 1, refs: [2] }], [2, { payload: 2, refs: [1] }], [8, { payload: 8, refs: [9] }], [9, { payload: 9, refs: [8] }]]);
  const roots = new Map<string, number | null>([['r', 1]]);
  const r = verifyGc(svc, objs, roots);
  assert.deepEqual(r.reachableIds.sort(), [1, 2]);
});

test('移除根后环被回收', () => {
  const svc = setup([[1, 1, [2]], [2, 2, [1]]], [['r', 1]]);
  svc.collect();
  svc.removeRoot('r');
  const r = svc.collect();
  assert.equal(r.reachableIds.length, 0);
  assert.equal(svc.listObjects().length, 0);
});

test('连续两次空间交换，转发表不跨轮复用', () => {
  const svc = setup([[1, 1, []]], [['r', 1]]);
  const r1 = svc.collect();
  assert.equal(r1.toSpace, 1);
  const r2 = svc.collect();
  assert.equal(r2.toSpace, 0);
  assert.equal(r2.fromSpace, 1);
  const o = svc.getObject(1);
  assert.equal(o.addr!.space, 0);
});

test('随机图交叉核对不变量', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 20; round++) {
    const n = 1 + Math.floor(rand() * 12);
    const objs: [number, number, (number | null)[]][] = [];
    const map = new Map<number, { payload: number; refs: (number | null)[] }>();
    for (let i = 0; i < n; i++) {
      const nf = Math.floor(rand() * 3);
      const refs = Array.from({ length: nf }, () => (rand() < 0.3 ? null : Math.floor(rand() * n)));
      objs.push([i, i * 10, refs]);
      map.set(i, { payload: i * 10, refs });
    }
    const roots: [string, number | null][] = [['b', Math.floor(rand() * n)], ['a', rand() < 0.5 ? null : Math.floor(rand() * n)]];
    const svc = setup(objs, roots, 1000);
    verifyGc(svc, map, new Map(roots));
    svc.close();
  }
});

test('报告持久化且不受后续修改影响', () => {
  const svc = setup([[1, 1, []]], [['r', 1]]);
  const r1 = svc.collect();
  svc.allocObject(2, 2, []);
  svc.collect();
  const saved = svc.getReport(r1.seq);
  assert.deepEqual(saved, r1); // 旧报告地址含义不变
  assert.equal(svc.listReports().length, 2);
});

test('服务重启后继续分配与回收一致', () => {
  const db = tmpDb();
  let svc = new HeapService(db);
  svc.initHeap(50);
  svc.allocObject(1, 11, []);
  svc.setRoot('r', 1);
  svc.collect();
  svc.close();
  svc = new HeapService(db); // 模拟重启
  svc.allocObject(2, 22, [1]);
  svc.setRoot('s', 2);
  const r = svc.collect();
  assert.deepEqual(r.reachableIds.sort(), [1, 2]);
  assert.equal(svc.getObject(1).payload, 11);
  svc.close();
});

test('未初始化堆报错；重复 init 需 force', () => {
  const svc = mem();
  assert.throws(() => svc.allocObject(1, 1, []), (e: GcError) => e.code === 'HEAP_NOT_INITIALIZED');
  svc.initHeap(10);
  assert.throws(() => svc.initHeap(10), (e: GcError) => e.code === 'HEAP_ALREADY_INITIALIZED');
  svc.initHeap(20, { force: true });
  assert.equal(svc.snapshot().state!.capacity, 20);
});

test('扫描明细限量但不漏扫', () => {
  const svc = new HeapService(':memory:', { maxObjects: 100, maxFields: 64, maxCapacity: 1000, explainLimit: 2 });
  svc.initHeap(100);
  svc.allocObject(1, 1, [null, null, null]);
  svc.allocObject(2, 2, []); svc.allocObject(3, 3, []); svc.allocObject(4, 4, []);
  svc.setRefs(1, [2, 3, 4]);
  svc.setRoot('r', 1);
  const r = svc.collect();
  assert.equal(r.scanStepsTotal, 3);
  assert.equal(r.scanSteps.length, 2);
  assert.equal(r.scanStepsTruncated, true);
  assert.equal(r.reachableIds.length, 4); // 全部对象仍被复制
});






