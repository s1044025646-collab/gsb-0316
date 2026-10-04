import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openDb } from "../src/db";
import { allocObject, collectGarbage, initHeap, setRoot, getObject } from "../src/heap";

test("重启后继续分配与回收，结果与不中断一致", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "data", "restart-"));
  const file = path.join(dir, "gc.db");
  try {
    // 第一段进程
    let db = openDb(file);
    initHeap(db, 16);
    const a = allocObject(db, 1, []);
    const b = allocObject(db, 2, [a.id]);
    setRoot(db, "r", b.id);
    collectGarbage(db);
    db.close();

    // “重启”：重新打开同一数据库文件
    db = openDb(file);
    const c = allocObject(db, 3, [b.id]);
    setRoot(db, "c", c.id);
    const report = collectGarbage(db);
    assert.equal(report.survivors, 3);
    assert.equal(getObject(db, c.id).payload, 3);
    db.close();

    // 对照组：不中断执行同样操作
    const db2 = openDb(":memory:");
    initHeap(db2, 16);
    const a2 = allocObject(db2, 1, []);
    const b2 = allocObject(db2, 2, [a2.id]);
    setRoot(db2, "r", b2.id);
    collectGarbage(db2);
    const c2 = allocObject(db2, 3, [b2.id]);
    setRoot(db2, "c", c2.id);
    const report2 = collectGarbage(db2);
    assert.equal(report.survivors, report2.survivors);
    assert.deepEqual(
      report.forwarding.map((f) => [f.id, f.to.offset]),
      report2.forwarding.map((f) => [f.id, f.to.offset]),
      "重启与不中断的复制布局一致"
    );
    assert.equal(c.id, c2.id);
    db2.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows 下 SQLite 文件锁释放有延迟，临时目录可保留 */ }
  }
});
