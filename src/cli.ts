import * as path from 'node:path';
import { HeapService } from './store.ts';
import { addrToString } from './types.ts';

const DATA_DIR = process.env.GC_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.GC_DB ?? path.join(DATA_DIR, 'heap.db');

function usage(): never {
  console.log(`用法: node src/cli.ts <命令> [参数]
  init <capacity> [--force]        初始化/重建堆（容量单位：单元）
  alloc <id> <payload> [refs]      分配对象，refs 为逗号分隔编号或 -（空），如 "2,-,3"
  set-refs <id> <refs>             修改对象引用字段（字段数不可变）
  set-root <name> <id|->           设置/更新根
  del-root <name>                  删除根
  gc                               执行 Cheney 回收并打印报告摘要
  show <id>                        查看对象
  list                             列出全部对象
  roots                            列出根
  snapshot                         导出当前快照（JSON）
  report [seq]                     查看回收报告（默认最近一次）
  reports                          列出全部报告`);
  process.exit(1);
}

function parseRefs(s: string): (number | null)[] {
  if (s === '' || s === '-') return [];
  return s.split(',').map((t) => (t === '-' ? null : Number(t)));
}

function fmtAddr(a: any) { return a ? addrToString(a) : 'null'; }

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

const svc = new HeapService(DB_PATH);
try {
  switch (cmd) {
    case 'init': {
      const capacity = Number(args[0]);
      const force = args.includes('--force');
      console.log(svc.initHeap(capacity, { force }));
      break;
    }
    case 'alloc': {
      const [id, payload] = args.map(Number);
      console.log(svc.allocObject(id, payload, parseRefs(args[2] ?? '')));
      break;
    }
    case 'set-refs':
      console.log(svc.setRefs(Number(args[0]), parseRefs(args[1] ?? '')));
      break;
    case 'set-root':
      console.log(svc.setRoot(args[0], args[1] === '-' ? null : Number(args[1])));
      break;
    case 'del-root':
      console.log(svc.removeRoot(args[0]));
      break;
    case 'gc': {
      const r = svc.collect();
      console.log(`回收完成 #${r.seq}: S${r.fromSpace} -> S${r.toSpace}`);
      console.log(`复制顺序: [${r.copyOrder.join(', ')}]`);
      for (const f of r.forwarding) {
        console.log(`  对象 ${f.objectId}: ${fmtAddr(f.from)} -> ${fmtAddr(f.to)}`);
      }
      console.log(`扫描步数: ${r.scanStepsTotal}${r.scanStepsTruncated ? `（明细仅显示前 ${r.scanSteps.length} 条）` : ''}`);
      for (const s of r.scanSteps) {
        console.log(`  扫描 对象${s.objectId}.字段${s.fieldIndex}: ${fmtAddr(s.oldAddr)} -> ${fmtAddr(s.newAddr)}`);
      }
      console.log(`回收单元: ${r.freedUnits}，剩余容量: ${r.remainingCapacity}/${r.capacity}`);
      break;
    }
    case 'show':
      console.log(JSON.stringify(svc.getObject(Number(args[0])), null, 2));
      break;
    case 'list':
      console.log(JSON.stringify(svc.listObjects(), null, 2));
      break;
    case 'roots':
      console.log(JSON.stringify(svc.loadRoots(), null, 2));
      break;
    case 'snapshot':
      console.log(JSON.stringify(svc.snapshot(), null, 2));
      break;
    case 'report':
      console.log(JSON.stringify(svc.getReport(args[0] ? Number(args[0]) : undefined), null, 2));
      break;
    case 'reports':
      console.log(JSON.stringify(svc.listReports(), null, 2));
      break;
    default:
      usage();
  }
} catch (e: any) {
  console.error(`错误 [${e.code ?? 'INTERNAL'}] ${e.message}`);
  process.exitCode = 1;
} finally {
  svc.close();
}


