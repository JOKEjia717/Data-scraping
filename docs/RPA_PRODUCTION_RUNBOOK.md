# RPA 新 Worker 稳定性、灰度与回滚手册

## 1. 变更解决的问题

- 回答取得后，Outbox 写盘失败会保持 execution 心跳和 advisory lease，在内存中保留完整回答并按 `OUTBOX_WRITE_RETRY_MS` 重试；落盘前不会进入数据库、不会领取下一题。
- 引用状态改为 `EXTRACTED / CONFIRMED_EMPTY / UNKNOWN`。`UNKNOWN` 使用 `REFERENCE_UNKNOWN`，禁止写成空引用成功，ARTICLE_PROBE 同样适用。
- Outbox v2 增加 `schemaVersion=2` 和 SHA-256 `payloadChecksum`。损坏文件移动到 `outbox/quarantine` 并保留 metadata，正常文件继续回放；同 execution 冲突内容不会覆盖原始结果。
- MySQL advisory lock 的本地缓存随 `error/end/close` 立即失效；重新连接后通过 `IS_USED_LOCK + CONNECTION_ID` 验证或重新 `GET_LOCK`，不能只相信内存集合。
- Browser/CDP/标签页关闭或跳转支持有限次数重新连接和页面重新发现；若题目已经提交，重连路径只读检查原问题锚点、回答和引用，不再次点击发送，并把页面操作句柄重新绑定到原批次会话。登录、验证码、限流、DOM_CHANGED 不进行无限刷新。
- 可选数据库调度通过 `next_retry_at`、`last_error_code`、`last_error_at` 释放失败任务的平台执行权；退避采用有上限指数算法和随机抖动。
- 增加磁盘停止领取阈值、JSONL 日志滚动、日志/证据保留期、错误分类和指标输出；Outbox/quarantine 不属于清理范围。

## 2. 新数据结构和兼容边界

`rpa_task_execution` 新增可选字段：

- `worker_provider varchar(32) NOT NULL DEFAULT 'LEGACY'`
- `next_retry_at datetime NULL`
- `last_error_code varchar(64) NULL`
- `last_error_at datetime NULL`

`brand_rpa_dispatch_task` 新增：

- `worker_provider varchar(32) NOT NULL DEFAULT 'LEGACY'`

Java DO 只增加同名属性，回答表和引用表字段、事务顺序、状态 0/1/2/3 语义均未改变。旧代码忽略新增 nullable/default 字段仍可运行。

重要限制：兼容 migration 不会切换任务，最终切换由独立 `cutover_to_new` 脚本完成。如果旧 RPA 仍无条件扫描 `status=0`，单任务真实测试窗口和最终切换窗口都必须先停止旧 RPA。没有确认旧进程停止时，新 Worker 必须保持 dry-run。

## 3. Migration 与回滚

爬虫侧参考 migration 位于 `migrations/`；后端正式文件位于：

- `sql/mysql/20260803_rpa_worker_stability_up.sql`
- `sql/mysql/20260803_rpa_worker_stability_down.sql`

执行顺序：备份表结构 → 维护窗口执行兼容 up（默认 `LEGACY`）→ 检查新增列/索引 → 部署兼容代码且后端配置保持 `LEGACY` → 暂停旧 RPA 做白名单单任务验证 → 验证通过后停止旧 RPA并执行 `cutover_to_new` → 开启新 Worker provider 查询。

回滚前必须先安全停止新 Worker并确认 Outbox 为空。把尚未处理的 `NEW_RPA` dispatch/execution 改回 `LEGACY`，关闭 provider 和数据库重试调度开关，再执行 down。禁止在仍有待回写 Outbox 时删除新增字段。

## 4. 安全默认配置

参考 `examples/rpa-staging.env.example`。关键默认值：

- `ENVIRONMENT=staging`
- `ALLOW_PRODUCTION_CLAIMS=false`
- `DRY_RUN=true`
- `PROVIDER_ROUTING_ENABLED=false`
- `PROVIDER=NEW_RPA`
- `DATABASE_RETRY_SCHEDULE_ENABLED=false`
- `OUTBOX_WRITE_RETRY_MS=5000`
- `BROWSER_RECONNECT_ATTEMPTS=3`
- `BROWSER_RECONNECT_BACKOFF_MS=2000`
- `RETRY_JITTER_MS=5000`
- `DISK_WARNING_FREE_MB=5120`
- `DISK_STOP_FREE_MB=1024`
- `LOG_MAX_FILE_MB=100`
- `LOG_RETENTION_DAYS=14`
- `EVIDENCE_RETENTION_DAYS=7`

production 下即使指定 `dry-run=false`，没有 `ALLOW_PRODUCTION_CLAIMS=true` 也会拒绝启动。

## 5. 灰度前静态检查

首轮必须 staging、dry-run、单平台、`maxTasks<=4` 且有品牌/业务任务白名单：

```bash
npm run rpa:gray:validate -- --worker=diagnosis --platforms=doubao \
  --max-tasks=1 --gray-brand-ids=10001 \
  --provider-routing-enabled=true --provider=NEW_RPA
```

然后依次运行 `npm run rpa:diagnosis:health` 或 `npm run rpa:monitor:health`，确认数据库、CDP、平台页面、磁盘和 Outbox 正常。真实平台不得绕过验证码、登录或风控。

## 6. 十项有限灰度演练

每项都使用专门 staging execution、白名单品牌、`maxTasks=1` 起步，并在 SQL 中确认 provider：

1. 单品牌单平台：只开一个平台，确认批内同 conversationGroupId。
2. 单品牌四平台：每个平台独立 Chrome 页面；确认平台间并行、平台内串行。
3. A 后 B：检查日志中同平台 A 批次完成时间早于 B 开始时间。
4. 回答后断 DB：等待 Outbox 文件出现，恢复 DB；确认只回放数据库且回答只有一条。
5. 关闭标签页：在未提交题或专门测试题中关闭，确认最多重连配置次数并重新发现页面。
6. Worker 异常终止：不得在 Outbox 写盘失败期间强杀；普通处理中断后等 stale 阈值，确认 advisory lock 互斥恢复。
7. 引用入口存在但解析失败：DOM fixture/受控页面必须产生 `REFERENCE_UNKNOWN`，数据库不得出现空引用成功。
8. ARTICLE_PROBE：分别验证 URL 严格命中、疑似转载、平台明确无引用；UNKNOWN 不进入未曝光统计。
9. 磁盘不足：把停止阈值临时设为高于测试机可用空间，确认不领取；已有 Outbox 仍优先回放。
10. MySQL 连接丢失竞争：两个测试 Worker 使用同一 staging execution；连接断开后只有重新获得 execution/platform 两把锁者可继续。

仓库自动测试不连接真实 Chrome/MySQL；上述真实演练需要运维提供 staging 数据库和已登录的独立 Chrome Profile 后人工执行。

## 7. 灰度上线步骤

1. 安全停止新 Worker，确认所有 Outbox/quarantine 数量。
2. 执行兼容 migration 并验证字段/索引；部署 Java 代码但配置保持 `LEGACY`。
3. 暂停旧 RPA，使用白名单和任务上限完成单任务验证。
4. 验证通过后停止旧 RPA，执行 `cutover_to_new`，确认新任务和待处理任务均为 `NEW_RPA`。
5. 新 Worker 开启 `PROVIDER_ROUTING_ENABLED=true`、数据库重试调度开关，先 dry-run。
6. 运行静态门禁和健康检查；核对 dry-run execution 数与白名单。
7. 单平台、单品牌、`maxTasks=1` 关闭 dry-run。
8. 检查任务状态、回答事务、引用状态、Outbox、quarantine、指标和 Java 消费结果。
9. 再逐平台、逐品牌或按稳定百分比扩大；diagnosis 和 monitor 独立扩容。

## 8. 生产回滚步骤

1. 第一次 SIGTERM 安全停止新 Worker；不要使用第二次信号强杀。
2. 保持数据库和 Outbox 目录可用，先完成/重放所有已取得回答。
3. 确认 `outboxPending=0`；quarantine 必须人工处理，不能删除。
4. 后端 provider 配置改回 `LEGACY`，停止产生新的 `NEW_RPA`。
5. 把未领取或已安全释放的 `NEW_RPA` 任务改回 `LEGACY`；处理中任务逐条核对 answer_id/lease。
6. 恢复旧 RPA 对应业务范围，再观察一个完整批次。
7. 关闭新 Worker 的 provider/重试调度开关。只有确认不再回滚到新 Worker时才执行 down migration。

## 9. 运维排查

- `FILESYSTEM_ERROR`：查看磁盘空间、目录权限、只读文件系统；不要删除 Outbox/quarantine。修复后 Worker 会原地重试写盘。
- `OUTBOX_CORRUPTED`：查看 quarantine metadata 和原文件；校验 executionId、schemaVersion、checksum，禁止直接复制回主目录。
- `DATABASE_ERROR`：确认连接池和 advisory lock 连接；连接恢复后必须看到重新 GET_LOCK，不能手工假定旧锁仍在。
- `BROWSER_DISCONNECTED`：检查 CDP 端口、Chrome 进程、Profile 和标签页；达到重连上限后人工恢复。
- `LOGIN_REQUIRED/CAPTCHA_REQUIRED/RATE_LIMITED/DOM_CHANGED`：只处理对应平台，其他平台继续；不得自动绕过或无限刷新。
- `REFERENCE_UNKNOWN`：检查引用入口、页面完整性和 DOM fixture；在确认前不得补写空引用。
- 磁盘停止领取：指标 `diskFreeBytes` 低于停止阈值。清理只能针对滚动日志和过期 evidence，不能清理 Outbox/quarantine。
- 僵尸任务：同时检查双状态、answer_id、modify_time 和 `IS_USED_LOCK`；有锁任务不能恢复。

## 10. 当前仍需现场确认的风险

- 旧 RPA 是否支持 provider 过滤必须由其维护方确认；这是并行灰度的硬前置条件。
- 四个平台 DOM 会变化，真实灰度前必须分别做受限页面检查。
- Outbox 写盘失败期间若操作系统或机器直接崩溃，内存回答仍可能丢失；应为 Outbox 使用本机可靠磁盘并监控剩余空间/只读状态。
- 提交后若浏览器进程重启导致原会话本身消失，只读恢复无法确认原回答时会进入 `REFERENCE_UNKNOWN` 并暂停平台；生产启用前仍需在 staging 验证平台会话恢复能力，并制定 quarantine/人工核对流程，不能直接恢复为普通重试。
- 当前环境没有 staging 数据库凭据、已登录 Chrome，也没有 Maven 命令，因此这里只完成自动化/静态验证，未声称真实平台或 Java 编译已经通过。
