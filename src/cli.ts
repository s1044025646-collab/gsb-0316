import { openDb } from "./db";
import {
  allocObject,
  collectGarbage,
  getObject,
  getReport,
  initHeap,
  listReports,
  loadObjects,
  loadRoots,
  removeRoot,
  setRef,
  setRoot,
  snapshot,
} from "./heap";
import { serve } from "./api";
import { GcError } from "./errors";

function out(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function parseRefs(s: string | undefined): (number | null)[] {
  if (!s) return [];
  if (s.trim() === "") return [];
  return s.split(",").map((t) => (t === "null" || t === "-" ? null : Number(t)));
}

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  init-heap <capacity>            初始化堆（两个半空间各 capacity 单元）
  alloc <payload> [refs]          分配对象，refs 形如 "2,null,3"
  set-ref <id> <idx> <target|->   修改引用字段
  set-root <name> <target|->      设置/更新根
  del-root <name>                 删除根
  gc                              执行 Cheney 复制回收
  show <id>                       查看对象
  objects                         列出全部对象
  roots                           列出根
  snapshot                        导出当前快照
  reports                         列出回收报告
  explain <reportId>              解释转发表与扫描明细
  serve [port]                    启动 HTTP API（默认自动选空闲端口）
  demo                            运行内置演示`);
}

function runDemo(): void {
  const db = openDb(":memory:");
  console.log("== 演示 1: 两个根共享对象 + 可达环与孤立环共存 ==");
  initHeap(db, 64);
  const shared = allocObject(db, 100, []);
  const a = allocObject(db, 1, [shared.id]);
  const b = allocObject(db, 2, [shared.id]);
  // 可达环 r1 <-> r2
  const r1 = allocObject(db, 10, [null]);
  const r2 = allocObject(db, 11, [r1.id]);
  setRef(db, r1.id, 0, r2.id);
  // 孤立环 o1 <-> o2（不可达，应被回收）
  const o1 = allocObject(db, 20, [null]);
  const o2 = allocObject(db, 21, [o1.id]);
  setRef(db, o1.id, 0, o2.id);
  setRoot(db, "left", a.id);
  setRoot(db, "right", b.id);
  setRoot(db, "ring", r1.id);
  let report = collectGarbage(db);
  console.log(`复制顺序: [${report.copyOrder.join(", ")}]，存活 ${report.survivors}，回收 ${report.reclaimedUnits} 单元`);
  console.log(`孤立环 #${o1.id}, #${o2.id} 已回收: ${!hasObj(db, o1.id) && !hasObj(db, o2.id)}`);
  console.log(`共享对象 #${shared.id} 仅复制一次: ${report.forwarding.filter((f) => f.id === shared.id).length === 1}`);

  console.log("\n== 演示 2: 移除根后再次回收 ==");
  removeRoot(db, "left");
  removeRoot(db, "right");
  report = collectGarbage(db);
  console.log(`存活 ${report.survivors}（仅剩可达环），回收 ${report.reclaimedUnits} 单元`);

  console.log("\n== 演示 3: 连续两次空间交换 ==");
  const s0 = db.prepare("SELECT value FROM meta WHERE key='active_space'").get() as { value: string };
  collectGarbage(db);
  const s1 = db.prepare("SELECT value FROM meta WHERE key='active_space'").get() as { value: string };
  collectGarbage(db);
  const s2 = db.prepare("SELECT value FROM meta WHERE key='active_space'").get() as { value: string };
  console.log(`活动空间: ${s0.value} -> ${s1.value} -> ${s2.value}（两次交换回到原空间）`);
  const n = allocObject(db, 999, []);
  console.log(`交换后仍可分配: 新对象 #${n.id} @ 空间${n.space} 偏移${n.offset}`);
}

function hasObj(db: ReturnType<typeof openDb>, id: number): boolean {
  return !!db.prepare("SELECT 1 FROM objects WHERE id = ?").get(id);
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") return usage();
  if (cmd === "demo") return runDemo();
  const db = openDb();
  try {
    switch (cmd) {
      case "init-heap":
        initHeap(db, Number(args[0]));
        return console.log("堆已初始化");
      case "alloc":
        out(allocObject(db, Number(args[0]), parseRefs(args[1])));
        return;
      case "set-ref":
        setRef(db, Number(args[0]), Number(args[1]), args[2] === "-" ? null : Number(args[2]));
        return console.log("ok");
      case "set-root":
        setRoot(db, args[0], args[1] === "-" || args[1] === undefined ? null : Number(args[1]));
        return console.log("ok");
      case "del-root":
        removeRoot(db, args[0]);
        return console.log("ok");
      case "gc":
        return out(collectGarbage(db));
      case "show":
        return out(getObject(db, Number(args[0])));
      case "objects":
        return out(loadObjects(db));
      case "roots":
        return out(loadRoots(db));
      case "snapshot":
        return out(snapshot(db));
      case "reports":
        return out(listReports(db));
      case "explain":
        return out(getReport(db, Number(args[0])));
      case "serve":
        await serve(db, args[0] ? Number(args[0]) : undefined);
        return;
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof GcError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}

if (require.main === module) {
  void main(process.argv.slice(2));
}
