# Cheney 半空间垃圾回收教学模拟器

纯后端项目：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无 Docker、无外部服务）。模拟 Cheney 半空间复制式垃圾回收与引用重定位，提供 HTTP API 与 CLI。

## 快速开始

```powershell
npm install        # 仅需开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 内置演示：共享对象、可达环/孤立环、移除根、连续两次空间交换
npm start          # 启动 HTTP API（默认自动选择空闲端口）
npm run cli -- gc  # 运行任意 CLI 命令
```

数据目录默认为项目内 `data/`（数据库文件 `data/gc.db`），可用环境变量 `GC_DATA_DIR`、`GC_DB_FILE` 覆盖。

## 模拟模型

- **地址**：`(space, offset)` 二元组。`space ∈ {0, 1}` 表示半空间编号，`offset` 为整数单元下标。不操作 Node 真实内存，也不依赖宿主 GC。
- **对象**：稳定编号 `id`、整数载荷 `payload`、按顺序排列的引用字段 `refs`（元素为对象编号或 `null`）。
- **对象大小**：`1 + 字段数` 个单元；载荷视为头单元的一部分。对象地址互不重叠，引用必须指向对象起点（由实现按顺序紧凑布局保证）。
- **两个半空间**容量相同，一次只向活动空间分配，另一个在回收时作为目标空间。
- **根**：有名字的引用，回收时按根名称字典序处理，结果可复现。

## Cheney 复制流程

1. 按根名称排序，依次处理根：首次遇到某旧对象时，在目标空间按分配指针顺序复制，并**立即登记转发地址**（在扫描其子引用之前），因此自环、互相引用、多根共享都能正确处理。
2. 再次遇到同一旧对象时复用转发表中的地址，绝不复制第二份。
3. 用扫描指针按复制顺序逐个扫描已复制对象的引用字段，直到扫描指针追上分配指针（非递归，无深拷贝）。
4. 回收后：仅保留根可达对象；全部根与存活引用改指新地址；载荷与稳定编号不变；不可达环被回收；活动空间身份交换，转发表随即作废，不跨轮复用。

## 容量计算

- 已用单元 = Σ(1 + 字段数)；分配指针单调递增，只有回收能将其重置为存活对象总大小。
- 分配时 `allocPtr + 对象大小 > capacity` 返回 `E_NO_SPACE`，不自动丢弃任何可达对象；用户可修改根后执行回收再申请。
- 两个半空间等容量，因此能放下的存活数据在回收时必然放得下。

## 回收报告

每次回收持久化一份报告（`reports` 表），包含：复制顺序 `copyOrder`、转发表 `forwarding`（旧/新地址）、扫描明细 `scanEvents`（每条引用的旧新地址，超过 `maxExplain` 条会截断展示但**扫描不会少做**，`scanEventTotal` 给出真实总数）、回收单元数、剩余容量、回收前后完整快照。报告绑定当时快照，后续修改不会改变历史地址的含义。

## CLI

```
node dist/src/cli.js init-heap <capacity>     初始化堆
node dist/src/cli.js alloc <payload> [refs]   分配对象，refs 形如 "2,null,3"
node dist/src/cli.js set-ref <id> <idx> <t|-> 修改引用字段（- 表示空）
node dist/src/cli.js set-root <name> <t|->    设置/清空根
node dist/src/cli.js del-root <name>          删除根
node dist/src/cli.js gc                       执行回收并输出报告
node dist/src/cli.js show <id>                查看对象
node dist/src/cli.js objects | roots          列出对象 / 根
node dist/src/cli.js snapshot                 导出当前快照
node dist/src/cli.js reports                  列出历史报告
node dist/src/cli.js explain <reportId>       解释某次回收的转发表与扫描明细
node dist/src/cli.js serve [port]             启动 API（缺省自动选空闲端口）
node dist/src/cli.js demo                     内置演示
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/heap` | 建堆 `{capacity}` |
| POST | `/objects` | 分配 `{payload, refs:[id|null]}` |
| GET | `/objects` / `/objects/:id` | 列出 / 查看对象 |
| PUT | `/objects/:id/refs/:idx` | 改引用 `{target}` |
| PUT/DELETE | `/roots/:name` | 设置 `{target}` / 删除根 |
| GET | `/roots` | 列出根 |
| POST | `/gc` | 执行回收，返回报告 |
| GET | `/snapshot` | 当前快照 |
| GET | `/state` | 容量、活动空间、分配指针 |
| GET | `/reports` / `/reports/:id` | 报告列表 / 解释转发表 |

## 错误码

`E_INVALID_ARG`(400) 参数非法 · `E_NOT_FOUND`(404) 对象/报告不存在 · `E_DANGLING_REF`(422) 悬空引用 · `E_NO_SPACE`(507) 空间不足 · `E_LIMIT`(413) 超过限制 · `E_NO_HEAP`(409) 未建堆 · `E_INTERNAL`(500)

## 持久化与事务

- SQLite 保存对象、引用字段、根、空间身份（`active_space`、`alloc_ptr`、下一个对象编号）与回收报告。
- 分配、改引用、改根、回收各自在 `BEGIN IMMEDIATE ... COMMIT` 事务内完成；回收先在内存中完整计算新布局，再在单个事务里原子发布，注入的中途失败会整体回滚，原状态仍可查询。
- 服务重启后从同一数据库继续分配与回收，结果与不中断执行一致（有测试保证）。

## 限制（教学范围）

- 上限：对象数 100000、单对象字段数 64、半空间容量 1000000 单元、报告扫描明细展示 1000 条。
- 仅支持强引用；无弱引用、终结器、代际分区、并发屏障。
- 载荷仅为整数；引用字段数在分配时固定。
