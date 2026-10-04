import { objectSize } from './types.ts';
import type { Addr, Allocation, ForwardEntry, GcReport, HeapObject, RootEntry, ScanStep } from './types.ts';
import { GcError } from './errors.ts';

export interface GcInput {
  objects: Map<number, HeapObject>;
  roots: RootEntry[];
  activeSpace: 0 | 1;
  capacity: number;          // 每个半空间的单元容量
  usedUnits: number;         // 回收前活动空间已用单元
  seq: number;               // 报告序号
  explainLimit: number;      // 扫描明细最大记录条数（不影响实际扫描）
}

export interface GcOutput {
  report: GcReport;
  newAllocations: Allocation[];
  newSpace: 0 | 1;
  reachableIds: number[];
}

/**
 * Cheney 扫描复制：
 * 1. 按根名称排序处理根，首次遇到对象即复制到目标空间并登记转发地址；
 * 2. 用扫描指针依次扫描已复制对象的引用字段，直到追上分配指针；
 * 3. 再次遇到同一旧对象复用转发地址，不复制第二份。
 * 纯函数：失败抛错，不产生任何副作用，调用方据此保证不发布半份新堆。
 */
export function cheneyCollect(input: GcInput): GcOutput {
  const { objects, capacity } = input;
  const fromSpace = input.activeSpace;
  const toSpace: 0 | 1 = fromSpace === 0 ? 1 : 0;

  // 校验所有引用目标存在（悬空引用 => 失败，不修改任何状态）
  for (const o of objects.values()) {
    for (const r of o.refs) {
      if (r !== null && !objects.has(r)) {
        throw new GcError('DANGLING_REF', `对象 ${o.id} 的引用指向不存在的对象 ${r}`, 409);
      }
    }
  }
  for (const root of input.roots) {
    if (root.target !== null && !objects.has(root.target)) {
      throw new GcError('DANGLING_REF', `根 "${root.name}" 指向不存在的对象 ${root.target}`, 409);
    }
  }

  const forwarding = new Map<number, Addr>();
  const forwardList: ForwardEntry[] = [];
  const copied: { obj: HeapObject; addr: Addr }[] = [];
  const copyOrder: number[] = [];
  let allocPtr = 0;

  const copy = (id: number): Addr => {
    const existing = forwarding.get(id);
    if (existing) return existing; // 复用转发地址，绝不复制第二份
    const obj = objects.get(id)!;
    const size = objectSize(obj);
    if (allocPtr + size > capacity) {
      throw new GcError(
        'INSUFFICIENT_SPACE',
        `目标半空间容量不足：需要 ${allocPtr + size} 单元，容量 ${capacity}`,
        409,
      );
    }
    const addr: Addr = { space: toSpace, offset: allocPtr };
    allocPtr += size;
    // 在扫描其子引用之前登记转发信息，正确处理自环/互引/共享
    forwarding.set(id, addr);
    forwardList.push({ objectId: id, from: { space: fromSpace, offset: -1 }, to: addr });
    copied.push({ obj, addr });
    copyOrder.push(id);
    return addr;
  };

  // 1. 处理根（按名称排序，保证可复现）
  const sortedRoots = [...input.roots].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const newRoots = sortedRoots.map((r) => ({
    name: r.name,
    addr: r.target === null ? null : copy(r.target),
  }));

  // 2. 扫描指针追赶分配指针
  const scanSteps: ScanStep[] = [];
  let scanStepsTotal = 0;
  const newRefs: { objectId: number; addrs: (Addr | null)[] }[] = [];
  let scanIdx = 0;
  while (scanIdx < copied.length) {
    const { obj } = copied[scanIdx];
    const addrs: (Addr | null)[] = [];
    for (let i = 0; i < obj.refs.length; i++) {
      const target = obj.refs[i];
      const newAddr = target === null ? null : copy(target);
      addrs.push(newAddr);
      scanStepsTotal++;
      if (scanSteps.length < input.explainLimit) {
        scanSteps.push({
          objectId: obj.id,
          fieldIndex: i,
          oldTarget: target,
          oldAddr: null, // 由 store 层补充旧地址（此处逻辑层不依赖物理布局）
          newAddr,
        });
      }
    }
    newRefs.push({ objectId: obj.id, addrs });
    scanIdx++;
  }

  const newAllocations: Allocation[] = copied.map(({ obj, addr }) => ({
    objectId: obj.id,
    space: toSpace,
    offset: addr.offset,
    size: objectSize(obj),
  }));

  const reachableIds = copyOrder.slice();
  const usedAfter = allocPtr;
  const report: GcReport = {
    seq: input.seq,
    fromSpace,
    toSpace,
    copyOrder,
    forwarding: forwardList,
    scanSteps,
    scanStepsTotal,
    scanStepsTruncated: scanStepsTotal > scanSteps.length,
    newRoots,
    newRefs,
    allocations: newAllocations,
    freedUnits: input.usedUnits - usedAfter,
    usedBefore: input.usedUnits,
    usedAfter,
    capacity,
    remainingCapacity: capacity - usedAfter,
    reachableIds,
  };
  return { report, newAllocations, newSpace: toSpace, reachableIds };
}

/** 独立图遍历（BFS），用于测试中与 GC 结果交叉核对可达集合。 */
export function independentReachable(
  objects: Map<number, HeapObject>,
  roots: RootEntry[],
): Set<number> {
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const r of roots) if (r.target !== null) queue.push(r.target);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = objects.get(id);
    if (!obj) continue;
    for (const ref of obj.refs) if (ref !== null) queue.push(ref);
  }
  return seen;
}



