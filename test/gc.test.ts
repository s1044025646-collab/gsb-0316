import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import {
  allocObject,
  collectGarbage,
  getObject,
  initHeap,
  loadObjects,
  loadRoots,
  removeRoot,
  setRef,
  setRoot,
  HeapObject,
} from "../src/heap";
import { GcError } from "../src/errors";
import { DatabaseSync } from "node:sqlite";

function mem(): DatabaseSync {
  return openDb(":memory:");
}

// 独立图遍历：从根出发计算可达编号集合（不依赖 GC 实现）
function reachableIds(objects: HeapObject[], roots: { targetId: number | null }[]): Set<number> {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const r of roots) if (r.targetId !== null) stack.push(r.targetId);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const o = byId.get(id);
    if (o) for (const t of o.refs) if (t !== null) stack.push(t);
  }
  return seen;
}

// 通用校验：回收后恰好保留可达集合，边/根/载荷不变，地址合法无重叠
function verifyAfterGc(
  db: DatabaseSync,
  beforeObjects: HeapObject[],
  beforeRoots: { name: string; targetId: number | null }[],
  capacity: number,
  activeSpace: number
): void {
  const expected = reachableIds(beforeObjects, beforeRoots);
  const after = loadObjects(db);
  assert.deepEqual(new Set(after.map((o) => o.id)), expected, "保留集合必须等于可达集合");
  const beforeById = new Map(beforeObjects.map((o) => [o.id, o]));
  const intervals: [number, number][] = [];
  for (const o of after) {
    const b = beforeById.get(o.id)!;
    assert.equal(o.payload, b.payload, `对象 #${o.id} 载荷不变`);
    assert.deepEqual(o.refs, b.refs, `对象 #${o.id} 引用字段不变`);
    assert.equal(o.space, 1 - activeSpace, "新地址必须落在目标空间");
    assert.ok(o.offset >= 0 && o.offset + 1 + o.fieldCount <= capacity, "地址必须在空间内");
    intervals.push([o.offset, o.offset + 1 + o.fieldCount]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i][0] >= intervals[i - 1][1], "对象地址不得重叠");
  }
  for (const r of loadRoots(db)) {
    if (r.targetId !== null) assert.ok(expected.has(r.targetId), "根必须指向存活对象");
  }
}

test("自引用对象：先登记转发再扫描子引用", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 7, [null]);
  setRef(db, a.id, 0, a.id);
  setRoot(db, "r", a.id);
  const before = loadObjects(db);
  const report = collectGarbage(db);
  assert.deepEqual(report.copyOrder, [a.id]);
  assert.equal(report.forwarding.length, 1, "只复制一次");
  const after = getObject(db, a.id);
  assert.equal(after.refs[0], a.id);
  assert.equal(after.payload, 7);
  verifyAfterGc(db, before, [{ name: "r", targetId: a.id }], 16, 0);
});

test("空根集合：全部回收，行为明确", () => {
  const db = mem();
  initHeap(db, 16);
  allocObject(db, 1, []);
  allocObject(db, 2, []);
  const report = collectGarbage(db);
  assert.equal(report.survivors, 0);
  assert.equal(report.reclaimedUnits, 2);
  assert.equal(loadObjects(db).length, 0);
  assert.equal(report.remainingCapacity, 16);
});

test("恰好满空间：存活对象正好填满目标空间", () => {
  const db = mem();
  initHeap(db, 3);
  const x = allocObject(db, 1, []);
  const y = allocObject(db, 2, [x.id]);
  setRoot(db, "r", y.id);
  const r2 = collectGarbage(db);
  assert.equal(r2.usedAfter, 3);
  assert.equal(r2.remainingCapacity, 0);
  // 满空间后无法继续分配，但再回收（无垃圾）仍成功
  assert.throws(() => allocObject(db, 9, []), (e: unknown) => e instanceof GcError && e.code === "E_NO_SPACE");
  const r3 = collectGarbage(db);
  assert.equal(r3.survivors, 2);
});

test("重复访问：多根共享与菱形引用只复制一次", () => {
  const db = mem();
  initHeap(db, 32);
  const shared = allocObject(db, 9, []);
  const a = allocObject(db, 1, [shared.id]);
  const b = allocObject(db, 2, [shared.id]);
  setRoot(db, "a", a.id);
  setRoot(db, "b", b.id);
  setRoot(db, "s", shared.id);
  const report = collectGarbage(db);
  assert.equal(report.copyOrder.filter((id) => id === shared.id).length, 1);
  assert.equal(report.survivors, 3);
  // 根按名称排序处理：先复制根直接指向的对象，扫描阶段再复制 shared
  assert.deepEqual(report.copyOrder, [a.id, b.id, shared.id]);
});

test("不可达环被回收，可达环保留", () => {
  const db = mem();
  initHeap(db, 32);
  const r1 = allocObject(db, 1, [null]);
  const r2 = allocObject(db, 2, [r1.id]);
  setRef(db, r1.id, 0, r2.id);
  const o1 = allocObject(db, 3, [null]);
  const o2 = allocObject(db, 4, [o1.id]);
  setRef(db, o1.id, 0, o2.id);
  setRoot(db, "ring", r1.id);
  const before = loadObjects(db);
  collectGarbage(db);
  verifyAfterGc(db, before, [{ name: "ring", targetId: r1.id }], 32, 0);
  assert.throws(() => getObject(db, o1.id), (e: unknown) => e instanceof GcError && e.code === "E_NOT_FOUND");
});

test("悬空地址/引用报错", () => {
  const db = mem();
  initHeap(db, 16);
  assert.throws(() => allocObject(db, 1, [999]), (e: unknown) => e instanceof GcError && e.code === "E_DANGLING_REF");
  const a = allocObject(db, 1, [null]);
  assert.throws(() => setRef(db, a.id, 0, 999), (e: unknown) => e instanceof GcError && e.code === "E_DANGLING_REF");
  assert.throws(() => setRoot(db, "r", 999), (e: unknown) => e instanceof GcError && e.code === "E_DANGLING_REF");
  assert.throws(() => setRef(db, a.id, 5, null), (e: unknown) => e instanceof GcError && e.code === "E_INVALID_ARG");
  assert.throws(() => getObject(db, 12345), (e: unknown) => e instanceof GcError && e.code === "E_NOT_FOUND");
});

test("空间不足明确报错，不自动丢弃可达对象", () => {
  const db = mem();
  initHeap(db, 4);
  allocObject(db, 1, []);
  allocObject(db, 2, []);
  allocObject(db, 3, []);
  allocObject(db, 4, []);
  assert.throws(() => allocObject(db, 5, []), (e: unknown) => e instanceof GcError && e.code === "E_NO_SPACE");
  assert.equal(loadObjects(db).length, 4, "原对象不受影响");
});

test("等容量半空间下：能放下的存活数据回收必然成功", () => {
  const db = mem();
  initHeap(db, 4);
  const a = allocObject(db, 1, [null]);
  const b = allocObject(db, 2, [a.id]);
  setRoot(db, "a", a.id);
  setRoot(db, "b", b.id);
  const report = collectGarbage(db);
  assert.equal(report.survivors, 2);
  assert.equal(report.remainingCapacity, 0);
});

test("注入中途失败：事务回滚，不发布半份新堆", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 1, []);
  setRoot(db, "r", a.id);
  const beforeObjs = loadObjects(db);
  const beforeActive = db.prepare("SELECT value FROM meta WHERE key='active_space'").get() as { value: string };
  assert.throws(
    () => collectGarbage(db, { failBeforeCommit: true }),
    (e: unknown) => e instanceof GcError && e.code === "E_INTERNAL"
  );
  assert.deepEqual(loadObjects(db), beforeObjs);
  const afterActive = db.prepare("SELECT value FROM meta WHERE key='active_space'").get() as { value: string };
  assert.equal(afterActive.value, beforeActive.value, "活动空间身份未切换");
  // 回滚后再次正常回收成功
  const report = collectGarbage(db);
  assert.equal(report.survivors, 1);
});

test("连续两次空间交换，转发表不跨轮复用", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 1, []);
  setRoot(db, "r", a.id);
  const r1 = collectGarbage(db);
  assert.equal(r1.toSpace, 1);
  const addr1 = getObject(db, a.id);
  const r2 = collectGarbage(db);
  assert.equal(r2.toSpace, 0);
  const addr2 = getObject(db, a.id);
  assert.equal(addr2.space, 0);
  assert.equal(addr1.space, 1);
  // 第二轮从 0 开始重新紧凑布局
  assert.equal(addr2.offset, 0);
});

test("移除根后回收释放对象", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 1, []);
  const b = allocObject(db, 2, []);
  setRoot(db, "x", a.id);
  setRoot(db, "y", b.id);
  collectGarbage(db);
  removeRoot(db, "y");
  const report = collectGarbage(db);
  assert.equal(report.survivors, 1);
  assert.equal(loadObjects(db).length, 1);
});

test("零引用对象与空引用字段", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 42, []);
  const b = allocObject(db, 43, [null, null]);
  setRoot(db, "r", b.id);
  const report = collectGarbage(db);
  assert.equal(report.survivors, 1);
  assert.equal(getObject(db, b.id).refs.length, 2);
  assert.throws(() => getObject(db, a.id), (e: unknown) => e instanceof GcError && e.code === "E_NOT_FOUND");
});

test("限制：字段数与容量上限", () => {
  const db = mem();
  initHeap(db, 16);
  assert.throws(() => allocObject(db, 1, new Array(100).fill(null)), (e: unknown) => e instanceof GcError && e.code === "E_LIMIT");
  assert.throws(() => initHeap(db, 10_000_000), (e: unknown) => e instanceof GcError && e.code === "E_LIMIT");
});

test("报告绑定原快照：后续修改不改变历史地址含义", () => {
  const db = mem();
  initHeap(db, 16);
  const a = allocObject(db, 1, []);
  setRoot(db, "r", a.id);
  const report = collectGarbage(db);
  const snapOffset = report.after.objects[0].offset;
  allocObject(db, 2, []);
  collectGarbage(db);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getReport } = require("../src/heap");
  const loaded = getReport(db, report.reportId!);
  assert.equal(loaded.after.objects[0].offset, snapOffset);
  assert.equal(loaded.fromSpace, 0);
});
