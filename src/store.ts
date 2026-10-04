import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cheneyCollect } from './gc.ts';
import { GcError, invalidParam, notFound } from './errors.ts';
import { objectSize } from './types.ts';
import type { Addr, Allocation, GcReport, HeapObject, RootEntry } from './types.ts';

export interface Limits {
  maxObjects: number;
  maxFields: number;
  maxCapacity: number;
  explainLimit: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxObjects: 10000,
  maxFields: 64,
  maxCapacity: 1_000_000,
  explainLimit: 1000,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS heap_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_space INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  alloc_ptr INTEGER NOT NULL,
  gc_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY,
  payload INTEGER NOT NULL,
  refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roots (
  name TEXT PRIMARY KEY,
  target INTEGER
);
CREATE TABLE IF NOT EXISTS allocations (
  space INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  object_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (space, offset)
);
CREATE TABLE IF NOT EXISTS reports (
  seq INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);
`;

export class HeapService {
  private db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath: string, limits: Limits = DEFAULT_LIMITS) {
    this.limits = limits;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private state(): { activeSpace: 0 | 1; capacity: number; allocPtr: number; gcSeq: number } | null {
    const row = this.db.prepare('SELECT active_space, capacity, alloc_ptr, gc_seq FROM heap_state WHERE id = 1')
      .get() as any;
    if (!row) return null;
    return { activeSpace: row.active_space, capacity: row.capacity, allocPtr: row.alloc_ptr, gcSeq: row.gc_seq };
  }

  private requireState() {
    const s = this.state();
    if (!s) throw new GcError('HEAP_NOT_INITIALIZED', '堆尚未初始化，请先 init', 409);
    return s;
  }

  initHeap(capacity: number, opts: { force?: boolean } = {}) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw invalidParam('capacity 必须是正整数（单元数）');
    if (capacity > this.limits.maxCapacity) {
      throw new GcError('LIMIT_EXCEEDED', `capacity 超过上限 ${this.limits.maxCapacity}`, 400);
    }
    return this.tx(() => {
      if (this.state() && !opts.force) {
        throw new GcError('HEAP_ALREADY_INITIALIZED', '堆已初始化；如需重建请使用 force', 409);
      }
      this.db.exec('DELETE FROM allocations; DELETE FROM objects; DELETE FROM roots; DELETE FROM reports; DELETE FROM heap_state;');
      this.db.prepare('INSERT INTO heap_state (id, active_space, capacity, alloc_ptr, gc_seq) VALUES (1, 0, ?, 0, 0)')
        .run(capacity);
      return { capacity, activeSpace: 0 };
    });
  }

  loadObjects(): Map<number, HeapObject> {
    const map = new Map<number, HeapObject>();
    for (const row of this.db.prepare('SELECT id, payload, refs FROM objects').all() as any[]) {
      map.set(row.id, { id: row.id, payload: row.payload, refs: JSON.parse(row.refs) });
    }
    return map;
  }

  loadRoots(): RootEntry[] {
    return (this.db.prepare('SELECT name, target FROM roots ORDER BY name').all() as any[])
      .map((r) => ({ name: r.name, target: r.target }));
  }

  loadAllocations(space?: number): Allocation[] {
    const rows = (space === undefined
      ? this.db.prepare('SELECT space, offset, object_id, size FROM allocations ORDER BY space, offset').all()
      : this.db.prepare('SELECT space, offset, object_id, size FROM allocations WHERE space = ? ORDER BY offset').all(space)) as any[];
    return rows.map((r) => ({ objectId: r.object_id, space: r.space, offset: r.offset, size: r.size }));
  }

  private validateRefs(refs: unknown): (number | null)[] {
    if (!Array.isArray(refs)) throw invalidParam('refs 必须是数组');
    if (refs.length > this.limits.maxFields) {
      throw new GcError('LIMIT_EXCEEDED', `引用字段数超过上限 ${this.limits.maxFields}`, 400);
    }
    return refs.map((r) => {
      if (r === null) return null;
      if (!Number.isInteger(r)) throw invalidParam(`非法引用目标：${String(r)}`);
      return r as number;
    });
  }

  private checkTargetsExist(refs: (number | null)[], objects: Map<number, HeapObject>, selfId: number) {
    for (const r of refs) {
      if (r !== null && r !== selfId && !objects.has(r)) {
        throw new GcError('DANGLING_REF', `引用目标 ${r} 不存在`, 409);
      }
    }
  }

  allocObject(id: number, payload: number, refs: (number | null)[]) {
    if (!Number.isInteger(id) || id < 0) throw invalidParam('id 必须是非负整数');
    if (!Number.isInteger(payload)) throw invalidParam('payload 必须是整数');
    const refList = this.validateRefs(refs);
    return this.tx(() => {
      const st = this.requireState();
      const objects = this.loadObjects();
      if (objects.has(id)) throw new GcError('CONFLICT', `对象 ${id} 已存在`, 409);
      if (objects.size >= this.limits.maxObjects) {
        throw new GcError('LIMIT_EXCEEDED', `对象数超过上限 ${this.limits.maxObjects}`, 400);
      }
      this.checkTargetsExist(refList, objects, id);
      const size = 1 + refList.length;
      if (st.allocPtr + size > st.capacity) {
        throw new GcError(
          'INSUFFICIENT_SPACE',
          `活动半空间容量不足：已用 ${st.allocPtr}，需要 ${size}，容量 ${st.capacity}。请执行回收后再分配。`,
          409,
        );
      }
      this.db.prepare('INSERT INTO objects (id, payload, refs) VALUES (?, ?, ?)')
        .run(id, payload, JSON.stringify(refList));
      this.db.prepare('INSERT INTO allocations (space, offset, object_id, size) VALUES (?, ?, ?, ?)')
        .run(st.activeSpace, st.allocPtr, id, size);
      this.db.prepare('UPDATE heap_state SET alloc_ptr = ? WHERE id = 1').run(st.allocPtr + size);
      return { id, addr: { space: st.activeSpace, offset: st.allocPtr }, size };
    });
  }

  setRefs(id: number, refs: (number | null)[]) {
    const refList = this.validateRefs(refs);
    return this.tx(() => {
      this.requireState();
      const objects = this.loadObjects();
      const obj = objects.get(id);
      if (!obj) throw notFound(`对象 ${id} 不存在`);
      this.checkTargetsExist(refList, objects, id);
      // 字段数变化会改变对象体积；为保持地址稳定，仅允许字段数不变
      if (refList.length !== obj.refs.length) {
        throw invalidParam(`字段数不可变（当前 ${obj.refs.length}，请求 ${refList.length}）；请新建对象`);
      }
      this.db.prepare('UPDATE objects SET refs = ? WHERE id = ?').run(JSON.stringify(refList), id);
      return { id, refs: refList };
    });
  }

  setRoot(name: string, target: number | null) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
      throw invalidParam('根名称必须是 1-64 字符的字符串');
    }
    if (target !== null && !Number.isInteger(target)) throw invalidParam('根目标必须是对象编号或 null');
    return this.tx(() => {
      this.requireState();
      if (target !== null && !this.loadObjects().has(target)) {
        throw new GcError('DANGLING_REF', `根目标 ${target} 不存在`, 409);
      }
      this.db.prepare('INSERT INTO roots (name, target) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET target = excluded.target')
        .run(name, target);
      return { name, target };
    });
  }

  removeRoot(name: string) {
    return this.tx(() => {
      this.requireState();
      const r = this.db.prepare('DELETE FROM roots WHERE name = ?').run(name);
      if (Number(r.changes) === 0) throw notFound(`根 "${name}" 不存在`);
      return { removed: name };
    });
  }

  collect(): GcReport {
    return this.tx(() => {
      const st = this.requireState();
      const objects = this.loadObjects();
      const roots = this.loadRoots();
      const allocs = this.loadAllocations(st.activeSpace);
      const addrOf = new Map<number, Addr>(allocs.map((a) => [a.objectId, { space: a.space as 0 | 1, offset: a.offset }]));
      const used = allocs.reduce((s, a) => s + a.size, 0);

      const out = cheneyCollect({
        objects, roots, activeSpace: st.activeSpace, capacity: st.capacity,
        usedUnits: used, seq: st.gcSeq + 1, explainLimit: this.limits.explainLimit,
      });

      // 补充旧地址到转发表与扫描明细（解释用）
      for (const f of out.report.forwarding) {
        f.from = addrOf.get(f.objectId) ?? { space: st.activeSpace, offset: -1 };
      }
      for (const s of out.report.scanSteps) {
        s.oldAddr = s.oldTarget === null ? null : addrOf.get(s.oldTarget) ?? null;
      }

      // 原子发布：清空两个空间的分配记录 -> 写入新空间 -> 切换活动空间 -> 删除不可达对象 -> 保存报告
      this.db.exec('DELETE FROM allocations');
      const ins = this.db.prepare('INSERT INTO allocations (space, offset, object_id, size) VALUES (?, ?, ?, ?)');
      for (const a of out.newAllocations) ins.run(a.space, a.offset, a.objectId, a.size);
      const reachable = new Set(out.reachableIds);
      const del = this.db.prepare('DELETE FROM objects WHERE id = ?');
      for (const id of objects.keys()) if (!reachable.has(id)) del.run(id);
      this.db.prepare('UPDATE heap_state SET active_space = ?, alloc_ptr = ?, gc_seq = ? WHERE id = 1')
        .run(out.newSpace, out.report.usedAfter, st.gcSeq + 1);
      this.db.prepare('INSERT INTO reports (seq, created_at, json) VALUES (?, ?, ?)')
        .run(out.report.seq, new Date().toISOString(), JSON.stringify(out.report));
      return out.report;
    });
  }

  getObject(id: number) {
    const obj = this.loadObjects().get(id);
    if (!obj) throw notFound(`对象 ${id} 不存在`);
    const alloc = this.db.prepare('SELECT space, offset, size FROM allocations WHERE object_id = ?').get(id) as any;
    return { ...obj, addr: alloc ? { space: alloc.space, offset: alloc.offset } : null, size: objectSize(obj) };
  }

  listObjects() {
    const addrOf = new Map<number, Addr>();
    for (const a of this.loadAllocations()) addrOf.set(a.objectId, { space: a.space, offset: a.offset });
    return [...this.loadObjects().values()].map((o) => ({
      ...o, addr: addrOf.get(o.id) ?? null, size: objectSize(o),
    }));
  }

  snapshot() {
    const st = this.state();
    return {
      state: st,
      objects: this.listObjects(),
      roots: this.loadRoots(),
      allocations: this.loadAllocations(),
    };
  }

  getReport(seq?: number): GcReport {
    const row = (seq === undefined
      ? this.db.prepare('SELECT json FROM reports ORDER BY seq DESC LIMIT 1').get()
      : this.db.prepare('SELECT json FROM reports WHERE seq = ?').get(seq)) as any;
    if (!row) throw notFound(seq === undefined ? '尚无回收报告' : `报告 ${seq} 不存在`);
    return JSON.parse(row.json);
  }

  listReports() {
    return (this.db.prepare('SELECT seq, created_at FROM reports ORDER BY seq').all() as any[]);
  }
}



