import * as fs from 'node:fs';
import * as path from 'node:path';
import { HeapService } from './store.ts';
import { addrToString } from './types.ts';

const dbPath = path.join(process.cwd(), 'data', 'demo.db');
fs.rmSync(dbPath, { force: true });
const svc = new HeapService(dbPath);

const show = (title: string, fn: () => void) => {
  console.log(`\n=== ${title} ===`);
  fn();
};
const gc = () => {
  const r = svc.collect();
  console.log(`GC#${r.seq}: S${r.fromSpace}->S${r.toSpace} 复制顺序=[${r.copyOrder}] 回收单元=${r.freedUnits} 剩余=${r.remainingCapacity}/${r.capacity}`);
  for (const f of r.forwarding) console.log(`  对象${f.objectId}: ${addrToString(f.from)} -> ${addrToString(f.to)}`);
  return r;
};

svc.initHeap(64);

show('场景1: 两个根共享同一对象', () => {
  svc.allocObject(1, 100, [null]); // 根A -> 1 -> 3
  svc.allocObject(2, 200, [null]); // 根B -> 2 -> 3（共享对象3）
  svc.allocObject(3, 300, []);
  svc.setRefs(1, [3]); svc.setRefs(2, [3]);
  svc.setRoot('A', 1);
  svc.setRoot('B', 2);
  gc();
  console.log('共享对象3只被复制一次，两个根的新引用均指向同一新地址');
});

show('场景2: 可达环与孤立环共存', () => {
  svc.allocObject(4, 400, [null]);
  svc.allocObject(5, 500, [null]);
  svc.setRefs(4, [5]); svc.setRefs(5, [4]); // 可达环 4<->5（根C -> 4）
  svc.allocObject(8, 800, [null]);
  svc.allocObject(9, 900, [null]);
  svc.setRefs(8, [9]); svc.setRefs(9, [8]); // 孤立环 8<->9（无根引用）
  svc.setRoot('C', 4);
  gc();
  console.log(`存活对象: ${svc.listObjects().map((o) => o.id)} （孤立环 8,9 已回收）`);
});

show('场景3: 移除根后回收', () => {
  svc.removeRoot('C');
  gc();
  console.log(`存活对象: ${svc.listObjects().map((o) => o.id)} （环 4,5 已回收）`);
});

show('场景4: 连续两次空间交换', () => {
  svc.allocObject(10, 1000, []);
  svc.setRoot('D', 10);
  gc();
  gc();
  const snap = svc.snapshot();
  console.log(`当前活动空间: S${snap.state!.activeSpace}，对象10地址: ${addrToString(svc.getObject(10).addr)}`);
});

svc.close();
console.log('\n演示完成。');



