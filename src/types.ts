/** 模拟地址：半空间编号 + 单元偏移。 */
export interface Addr {
  space: 0 | 1;
  offset: number;
}

/** 堆对象（逻辑描述，与所在空间无关）。 */
export interface HeapObject {
  id: number;            // 稳定编号
  payload: number;       // 普通整数载荷（视为头部的一部分）
  refs: (number | null)[]; // 按顺序排列的引用字段，指向对象稳定编号或 null
}

export interface RootEntry {
  name: string;
  target: number | null;
}

/** 一次空间内的物理分配记录。 */
export interface Allocation {
  objectId: number;
  space: 0 | 1;
  offset: number;
  size: number; // 占用单元数 = 1 头 + 引用字段数
}

export interface ForwardEntry {
  objectId: number;
  from: Addr;
  to: Addr;
}

export interface ScanStep {
  objectId: number;      // 被扫描的对象
  fieldIndex: number;    // 引用字段下标
  oldTarget: number | null;
  oldAddr: Addr | null;
  newAddr: Addr | null;
}

export interface GcReport {
  seq: number;
  fromSpace: 0 | 1;
  toSpace: 0 | 1;
  copyOrder: number[];                 // 复制顺序（稳定编号）
  forwarding: ForwardEntry[];          // 完整转发表
  scanSteps: ScanStep[];               // 扫描明细（可能被截断）
  scanStepsTotal: number;              // 实际扫描步数（不受截断影响）
  scanStepsTruncated: boolean;
  newRoots: { name: string; addr: Addr | null }[];
  newRefs: { objectId: number; addrs: (Addr | null)[] }[];
  allocations: Allocation[];           // 新空间布局
  freedUnits: number;                  // 本轮回收的单元数
  usedBefore: number;
  usedAfter: number;
  capacity: number;
  remainingCapacity: number;
  reachableIds: number[];
}

export const addrToString = (a: Addr | null): string | null =>
  a === null ? null : `S${a.space}@${a.offset}`;

export const objectSize = (o: HeapObject): number => 1 + o.refs.length;
