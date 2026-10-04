# Cheney 半空间垃圾回收模拟器

教学用复制式垃圾回收（Cheney semispace copying GC）后端，仅提供 HTTP API 与 CLI。
TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖），Windows 本地直接运行。

## 快速开始

```powershell
npm install        # 仅需 devDependencies（typescript / @types/node）
npm test           # 运行全部测试（node --test，直接执行 TS）
npm run build      # 编译到 dist/
npm start          # 启动 HTTP 服务（编译产物）；或 npm run dev 直接跑 TS
npm run demo       # 运行演示场景
node src/cli.ts    # CLI 帮助
```

- 默认端口：`--port 0` 自动选择空闲端口并在启动日志中打印；`node src/server.ts --port 8080` 指定端口。
- 数据目录：项目内 `data/`（可用环境变量 `GC_DATA_DIR`、`GC_DB` 覆盖）。

## 模型

- **对象**：稳定编号 `id`、整数载荷 `payload`（视为头部一部分）、按顺序排列的引用字段 `refs`（指向其他对象编号或 `null`）。
- **地址**：模拟地址 `S<space>@<offset>`，即半空间编号 + 单元偏移。不触碰 Node 真实内存，也不依赖宿主 GC。
- **容量**：两个半空间容量相同，单位为“单元”。对象体积 = 1 头单元 + 引用字段数。一次只向活动空间分配。
- **根**：有名字的引用，回收时按名称排序处理，保证结果可复现。

## Cheney 复制流程

1. 按根名称排序处理根；首次遇到的对象复制到目标空间（分配指针顺序推进）并**立即登记转发地址**；
2. 扫描指针依次扫描已复制对象的引用字段，遇到未复制的对象同样复制并登记转发；
3. 扫描指针追上分配指针时结束。再次遇到同一旧对象复用其转发地址，绝不复制第二份，
   因此自环、互相引用、多根共享都正确；不可达对象（含孤立环）被整批回收。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/heap` | 初始化堆 `{capacity, force?}` |
| GET | `/heap` / `/snapshot` | 当前快照（状态、对象、根、分配布局） |
| POST | `/objects` | 分配对象 `{id, payload, refs}` |
| GET | `/objects` / `/objects/:id` | 列出 / 查看对象 |
| PUT | `/objects/:id/refs` | 修改引用字段（字段数不可变） |
| PUT | `/roots/:name` | 设置根 `{target}`（`null` 表示空根） |
| DELETE | `/roots/:name` | 删除根 |
| POST | `/gc` | 执行回收，返回完整报告 |
| GET | `/gc/reports` / `/gc/reports/:seq\|latest` | 历史报告 |

错误统一为 `{ "error": { "code", "message" } }`，错误码：
`INVALID_PARAM`、`NOT_FOUND`、`DANGLING_REF`、`INSUFFICIENT_SPACE`、
`LIMIT_EXCEEDED`、`HEAP_NOT_INITIALIZED`、`HEAP_ALREADY_INITIALIZED`、`CONFLICT`、`INTERNAL`。

## CLI

```
node src/cli.ts init <capacity> [--force]
node src/cli.ts alloc <id> <payload> [refs]   # refs 形如 "2,-,3"，- 表示 null
node src/cli.ts set-refs <id> <refs>
node src/cli.ts set-root <name> <id|->
node src/cli.ts del-root <name>
node src/cli.ts gc                            # 打印复制顺序、转发表、扫描明细、回收单元与剩余容量
node src/cli.ts show <id> | list | roots | snapshot
node src/cli.ts report [seq] | reports
```

## 回收报告

每轮回收输出：复制顺序、完整转发表（旧地址→新地址）、逐字段扫描明细（旧/新地址）、
新根地址、新空间布局、回收单元数与剩余容量。扫描明细超过 `explainLimit`（默认 1000）时截断，
但 `scanStepsTotal` 记录真实步数，扫描本身不受限量影响。

## 持久化与事务

SQLite 保存对象、根、空间身份（活动空间、分配指针、回收序号）、分配布局与全部回收报告。
所有修改与回收都在单事务内完成：GC 核心为纯函数，先完整计算新布局再原子发布；
容量不足、悬空引用或中途失败都会回滚，不会把半份新堆发布为活动堆，原状态仍可查询。
报告按序号绑定当轮快照，后续修改不会改变旧报告中地址的含义。服务重启后可继续分配与回收。

## 限制与假设

- 仅强引用；无弱引用、终结器、代际分区、并发屏障。
- 对象字段数分配后不可变（保持地址稳定）；引用目标必须在赋值时已存在（环通过先分配再 `set-refs` 构造）。
- 内置上限：对象数 10000、单对象字段数 64、空间容量 1e6 单元、解释明细 1000 条（`src/store.ts` 中 `DEFAULT_LIMITS` 可调）。
- `node:sqlite` 在 Node 25 仍为实验特性（启动有 ExperimentalWarning，不影响功能）。
