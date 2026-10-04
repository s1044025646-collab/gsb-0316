import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors";
import {
  DEFAULT_LIMITS,
  Limits,
  getMeta,
  setMeta,
  tx,
} from "./db";

export interface Addr {
  space: number;
  offset: number;
}

export interface HeapObject {
  id: number;
  payload: number;
  space: number;
  offset: number;
  fieldCount: number;
  refs: (number | null)[];
}

export interface RootEntry {
  name: string;
  targetId: number | null;
}

export interface ScanEvent {
  objectId: number;
  fieldIndex: number;
  oldAddr: Addr | null;
  newAddr: Addr | null;
  targetId: number | null;
}

export interface GcReport {
  reportId?: number;
  fromSpace: number;
  toSpace: number;
  capacity: number;
  copyOrder: number[];
  forwarding: { id: number; from: Addr; to: Addr }[];
  scanEvents: ScanEvent[];
  scanEventTotal: number;
  scanEventsTruncated: boolean;
  reclaimedUnits: number;
  usedBefore: number;
  usedAfter: number;
  remainingCapacity: number;
  survivors: number;
  roots: { name: string; targetId: number | null; newAddr: Addr | null }[];
  before: Snapshot;
  after: Snapshot;
}

export interface Snapshot {
  activeSpace: number;
  capacity: number;
  objects: HeapObject[];
  roots: RootEntry[];
}

export interface GcOptions {
  limits?: Limits;
  // 仅测试用：在事务提交前注入失败，验证回滚
  failBeforeCommit?: boolean;
}

function objSize(o: { fieldCount: number }): number {
  return 1 + o.fieldCount;
}

export function requireHeap(db: DatabaseSync): { capacity: number; activeSpace: number } {
  const cap = getMeta(db, "capacity");
  const active = getMeta(db, "active_space");
  if (cap === null || active === null) {
    fail("E_NO_HEAP", "堆尚未初始化，请先调用 initHeap / init-heap");
  }
  return { capacity: Number(cap), activeSpace: Number(active) };
}

export function initHeap(
  db: DatabaseSync,
  capacity: number,
  limits: Limits = DEFAULT_LIMITS
): void {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    fail("E_INVALID_ARG", "容量必须是正整数（单位：堆单元）");
  }
  if (capacity > limits.maxCapacity) {
    fail("E_LIMIT", `容量超过上限 ${limits.maxCapacity}`);
  }
  tx(db, () => {
    setMeta(db, "capacity", String(capacity));
    setMeta(db, "active_space", "0");
    setMeta(db, "alloc_ptr", "0");
    setMeta(db, "next_object_id", "1");
    db.prepare("DELETE FROM objects").run();
    db.prepare("DELETE FROM fields").run();
    db.prepare("DELETE FROM roots").run();
  });
}

export function loadObjects(db: DatabaseSync): HeapObject[] {
  const objs = db
    .prepare("SELECT id, payload, space, offset, field_count AS fieldCount FROM objects ORDER BY id")
    .all() as unknown as Omit<HeapObject, "refs">[];
  const fieldRows = db
    .prepare("SELECT object_id AS objectId, idx, target_id AS targetId FROM fields ORDER BY object_id, idx")
    .all() as unknown as { objectId: number; idx: number; targetId: number | null }[];
  const byId = new Map<number, HeapObject>();
  for (const o of objs) {
    const ho: HeapObject = { ...o, refs: new Array<null>(o.fieldCount).fill(null) };
    byId.set(o.id, ho);
  }
  for (const f of fieldRows) {
    const o = byId.get(f.objectId);
    if (o) o.refs[f.idx] = f.targetId;
  }
  return [...byId.values()];
}

export function loadRoots(db: DatabaseSync): RootEntry[] {
  return db
    .prepare("SELECT name, target_id AS targetId FROM roots ORDER BY name")
    .all() as unknown as RootEntry[];
}

export function snapshot(db: DatabaseSync): Snapshot {
  const { capacity, activeSpace } = requireHeap(db);
  return { activeSpace, capacity, objects: loadObjects(db), roots: loadRoots(db) };
}

export function usedUnits(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(1 + field_count), 0) AS used FROM objects")
    .get() as { used: number };
  return row.used;
}

export function allocPtr(db: DatabaseSync): number {
  const v = getMeta(db, "alloc_ptr");
  return v === null ? 0 : Number(v);
}

export function allocObject(
  db: DatabaseSync,
  payload: number,
  refs: (number | null)[],
  limits: Limits = DEFAULT_LIMITS
): HeapObject {
  const { capacity, activeSpace } = requireHeap(db);
  if (!Number.isInteger(payload)) fail("E_INVALID_ARG", "载荷必须是整数");
  if (!Array.isArray(refs)) fail("E_INVALID_ARG", "refs 必须是数组");
  if (refs.length > limits.maxFields) {
    fail("E_LIMIT", `字段数 ${refs.length} 超过上限 ${limits.maxFields}`);
  }
  for (const r of refs) {
    if (r !== null && !Number.isInteger(r)) {
      fail("E_INVALID_ARG", "引用必须是对象编号或 null");
    }
  }
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM objects").get() as { c: number };
  if (countRow.c >= limits.maxObjects) {
    fail("E_LIMIT", `对象数达到上限 ${limits.maxObjects}`);
  }
  const size = 1 + refs.length;
  const ptr = allocPtr(db);
  if (ptr + size > capacity) {
    fail(
      "E_NO_SPACE",
      `空间不足：需要 ${size} 单元，当前剩余 ${capacity - ptr} 单元。可执行回收后再申请。`
    );
  }
  return tx(db, () => {
    const id = Number(getMeta(db, "next_object_id") || "1");
    for (const r of refs) {
      if (r !== null) {
        const exists = db.prepare("SELECT 1 FROM objects WHERE id = ?").get(r);
        if (!exists) fail("E_DANGLING_REF", `引用了不存在的对象 #${r}`);
      }
    }
    db.prepare(
      "INSERT INTO objects (id, payload, space, offset, field_count) VALUES (?, ?, ?, ?, ?)"
    ).run(id, payload, activeSpace, ptr, refs.length);
    refs.forEach((t, idx) => {
      db.prepare("INSERT INTO fields (object_id, idx, target_id) VALUES (?, ?, ?)").run(
        id,
        idx,
        t
      );
    });
    setMeta(db, "next_object_id", String(id + 1));
    setMeta(db, "alloc_ptr", String(ptr + size));
    return { id, payload, space: activeSpace, offset: ptr, fieldCount: refs.length, refs };
  });
}

export function setRef(
  db: DatabaseSync,
  objectId: number,
  fieldIndex: number,
  targetId: number | null
): void {
  requireHeap(db);
  tx(db, () => {
    const obj = db
      .prepare("SELECT field_count AS fc FROM objects WHERE id = ?")
      .get(objectId) as { fc: number } | undefined;
    if (!obj) fail("E_NOT_FOUND", `对象 #${objectId} 不存在`);
    if (!Number.isInteger(fieldIndex) || fieldIndex < 0 || fieldIndex >= obj.fc) {
      fail("E_INVALID_ARG", `字段下标 ${fieldIndex} 越界（字段数 ${obj.fc}）`);
    }
    if (targetId !== null) {
      const exists = db.prepare("SELECT 1 FROM objects WHERE id = ?").get(targetId);
      if (!exists) fail("E_DANGLING_REF", `引用了不存在的对象 #${targetId}`);
    }
    db.prepare(
      "INSERT INTO fields (object_id, idx, target_id) VALUES (?, ?, ?) " +
        "ON CONFLICT(object_id, idx) DO UPDATE SET target_id = excluded.target_id"
    ).run(objectId, fieldIndex, targetId);
  });
}

export function setRoot(db: DatabaseSync, name: string, targetId: number | null): void {
  requireHeap(db);
  if (!name || typeof name !== "string") fail("E_INVALID_ARG", "根名称必须是非空字符串");
  tx(db, () => {
    if (targetId !== null) {
      const exists = db.prepare("SELECT 1 FROM objects WHERE id = ?").get(targetId);
      if (!exists) fail("E_DANGLING_REF", `根 ${name} 指向不存在的对象 #${targetId}`);
    }
    db.prepare(
      "INSERT INTO roots (name, target_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET target_id = excluded.target_id"
    ).run(name, targetId);
  });
}

export function removeRoot(db: DatabaseSync, name: string): void {
  requireHeap(db);
  tx(db, () => {
    db.prepare("DELETE FROM roots WHERE name = ?").run(name);
  });
}

export function getObject(db: DatabaseSync, id: number): HeapObject {
  requireHeap(db);
  const objs = loadObjects(db);
  const o = objs.find((x) => x.id === id);
  if (!o) fail("E_NOT_FOUND", `对象 #${id} 不存在`);
  return o;
}

// ---------- Cheney 复制回收 ----------

export function collectGarbage(db: DatabaseSync, opts: GcOptions = {}): GcReport {
  const limits = opts.limits || DEFAULT_LIMITS;
  const { capacity, activeSpace: fromSpace } = requireHeap(db);
  const toSpace = 1 - fromSpace;

  const beforeObjects = loadObjects(db);
  const roots = loadRoots(db);
  const byId = new Map(beforeObjects.map((o) => [o.id, o]));

  for (const r of roots) {
    if (r.targetId !== null && !byId.has(r.targetId)) {
      fail("E_DANGLING_REF", `根 ${r.name} 悬空指向 #${r.targetId}`);
    }
  }

  // —— 纯计算阶段：不写库，任何失败都不会污染状态 ——
  const forwarding = new Map<number, Addr>();
  const copyOrder: number[] = [];
  const scanEvents: ScanEvent[] = [];
  let alloc = 0;

  const copy = (id: number): Addr => {
    const existing = forwarding.get(id);
    if (existing) return existing; // 重复访问：复用转发地址，绝不复制第二份
    const obj = byId.get(id);
    if (!obj) fail("E_DANGLING_REF", `悬空引用指向 #${id}`);
    const size = objSize(obj);
    if (alloc + size > capacity) {
      fail(
        "E_NO_SPACE",
        `目标空间容量不足：存活对象需要 ${alloc + size} 单元，容量 ${capacity}`
      );
    }
    const addr: Addr = { space: toSpace, offset: alloc };
    alloc += size;
    // 先登记转发地址，再扫描子引用 —— 自环/互环/共享都能正确处理
    forwarding.set(id, addr);
    copyOrder.push(id);
    return addr;
  };

  // 按根名称排序处理根（loadRoots 已按 name 排序）
  for (const r of roots) {
    if (r.targetId !== null) copy(r.targetId);
  }

  // Cheney 扫描指针：追上复制顺序末尾即结束
  let scanIdx = 0;
  while (scanIdx < copyOrder.length) {
    const obj = byId.get(copyOrder[scanIdx])!;
    scanIdx++;
    obj.refs.forEach((targetId, fieldIndex) => {
      if (targetId === null) {
        scanEvents.push({ objectId: obj.id, fieldIndex, oldAddr: null, newAddr: null, targetId: null });
        return;
      }
      const oldObj = byId.get(targetId);
      const oldAddr: Addr | null = oldObj
        ? { space: oldObj.space, offset: oldObj.offset }
        : null;
      const newAddr = copy(targetId);
      scanEvents.push({ objectId: obj.id, fieldIndex, oldAddr, newAddr, targetId });
    });
  }

  const usedBefore = beforeObjects.reduce((s, o) => s + objSize(o), 0);
  const usedAfter = alloc;

  const report: GcReport = {
    fromSpace,
    toSpace,
    capacity,
    copyOrder,
    forwarding: [...forwarding.entries()].map(([id, a]) => {
      const oldObj = byId.get(id)!;
      return { id, from: { space: oldObj.space, offset: oldObj.offset }, to: a };
    }),
    scanEvents: scanEvents.slice(0, limits.maxExplain),
    scanEventTotal: scanEvents.length,
    scanEventsTruncated: scanEvents.length > limits.maxExplain,
    reclaimedUnits: usedBefore - usedAfter,
    usedBefore,
    usedAfter,
    remainingCapacity: capacity - usedAfter,
    survivors: copyOrder.length,
    roots: roots.map((r) => ({
      name: r.name,
      targetId: r.targetId,
      newAddr: r.targetId !== null ? forwarding.get(r.targetId)! : null,
    })),
    before: { activeSpace: fromSpace, capacity, objects: beforeObjects, roots },
    after: { activeSpace: toSpace, capacity, objects: [], roots: [] }, // 提交后填充
  };

  // —— 提交阶段：单个事务发布新堆 ——
  tx(db, () => {
    db.prepare("DELETE FROM fields").run();
    db.prepare("DELETE FROM objects").run();
    const insObj = db.prepare(
      "INSERT INTO objects (id, payload, space, offset, field_count) VALUES (?, ?, ?, ?, ?)"
    );
    const insField = db.prepare(
      "INSERT INTO fields (object_id, idx, target_id) VALUES (?, ?, ?)"
    );
    const afterObjects: HeapObject[] = [];
    for (const id of copyOrder) {
      const old = byId.get(id)!;
      const addr = forwarding.get(id)!;
      insObj.run(id, old.payload, toSpace, addr.offset, old.fieldCount);
      old.refs.forEach((t, idx) => insField.run(id, idx, t));
      afterObjects.push({ ...old, space: toSpace, offset: addr.offset });
    }
    afterObjects.sort((a, b) => a.id - b.id);
    report.after.objects = afterObjects;
    report.after.roots = roots;
    setMeta(db, "active_space", String(toSpace));
    setMeta(db, "alloc_ptr", String(alloc));
    if (opts.failBeforeCommit) {
      fail("E_INTERNAL", "注入的中途失败（测试用）");
    }
    const info = db
      .prepare("INSERT INTO reports (created_at, json) VALUES (?, ?)")
      .run(new Date().toISOString(), JSON.stringify(report));
    report.reportId = Number(info.lastInsertRowid);
    // 把 reportId 写回持久化的报告 JSON，保证重启后一致
    db.prepare("UPDATE reports SET json = ? WHERE id = ?").run(
      JSON.stringify(report),
      report.reportId
    );
  });

  return report;
}

export function getReport(db: DatabaseSync, id: number): GcReport {
  const row = db.prepare("SELECT json FROM reports WHERE id = ?").get(id) as
    | { json: string }
    | undefined;
  if (!row) fail("E_NOT_FOUND", `报告 #${id} 不存在`);
  return JSON.parse(row.json) as GcReport;
}

export function listReports(db: DatabaseSync): { id: number; createdAt: string }[] {
  return db
    .prepare("SELECT id, created_at AS createdAt FROM reports ORDER BY id")
    .all() as unknown as { id: number; createdAt: string }[];
}
