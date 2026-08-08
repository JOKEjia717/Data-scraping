# ENTRY_MONITOR 发布后无法轮询修复提示词

> 用于同步修复爬虫、Java 后端和数据库状态一致性问题。最高约束：不得影响品牌诊断 `DIAGNOSIS`。

## 使用说明

下面内容可以直接交给另一个 Codex 执行。修复顺序、数据保护规则和验收标准均已包含。

```text
请修复“文章发布成功后，ENTRY_MONITOR 爬虫无法轮询任务”的问题。

涉及两个项目：

Java 后端：
/Users/joke/Desktop/project/geno-digital-api

爬虫程序：
/Users/joke/Desktop/爬虫

最高级约束：

1. 不能改变品牌诊断 DIAGNOSIS 的任何业务逻辑；
2. 不修改 DIAGNOSIS 查询SQL；
3. 不修改 DIAGNOSIS 原子领取；
4. 不修改 DIAGNOSIS 批次分组；
5. 不修改 DIAGNOSIS 对话管理；
6. 不修改 DIAGNOSIS 联网、回答、引用、Outbox、重试和僵尸恢复；
7. ENTRY_MONITOR 特有逻辑必须按 businessType 隔离；
8. RPA唯一任务队列仍然是 rpa_task_execution；
9. 爬虫不得通过JOIN probe_article_task过滤ENTRY_MONITOR；
10. 过期和业务失效execution必须由Java后端更新队列状态；
11. 不执行破坏性Git命令；
12. 不覆盖用户已有修改；
13. 不直接删除数据库记录；
14. 数据修复SQL先生成脚本并给出验证查询，未经确认不直接执行。

一、当前已确认的数据库事实

成功发布记录：

brand_article_publish_record.id = 12
tenant_id = 1
project_id = 5
article_draft_id = 37
status = succeeded
URL已存在

文章关联词条：

intent_entry_id = 28
project_id = 5
enabled = 1
status = 0
词条文本：
臻奥数智做GEO优化的专业能力靠谱吗

后端已经生成：

probe_article_task.id = 49
scope_type = ENTRY
trigger_type = PUBLISH_RECORD
business_type = ENTRY_MONITOR
dispatch_task_id = 2085351936934309889
worker_provider = NEW_RPA

对应execution：

1293 豆包
1294 千问
1295 DeepSeek
1296 元宝

execution当前全部是：

status = 0
task_status = 0
answer_id = null
worker_provider = NEW_RPA

但业务状态已经变成：

probe_article_task.id = 49
status = TIMEOUT
failure_reason = 失败样本 4 / 4

probe_article_sample.id = 604–607
status = TIMEOUT
failure_reason = RPA执行超过60分钟

还存在日期不一致：

probe_article_task.monitor_date = NULL
probe_article_sample.monitor_date = 2026-08-06
rpa_task_execution_context.monitor_date = 2026-08-07

二、当前直接根因

爬虫实际配置文件：

/Users/joke/Desktop/爬虫/.env

已经有：

RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
RPA_MONITOR_DRY_RUN=false
RPA_WORKER_ALLOW_PRODUCTION_CLAIMS=true

但缺少：

ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_GRAY_PROJECT_IDS=5

因此正式monitor Worker当前只查询ARTICLE_PROBE，不查询ENTRY_MONITOR。

注意：

不能现在直接打开开关。

因为execution 1293–1296虽然还是pending，但对应父任务和sample已经TIMEOUT。如果爬虫领取这些execution，可能成功写入answer，但Java不会按照正常RUNNING任务继续回收结果。

三、P0：修复Java超时后的队列状态一致性

重点检查：

/Users/joke/Desktop/project/geno-digital-api/genodigital-module-brand/genodigital-module-brand-biz/src/main/java/cn/geno/digital/module/brand/service/probe/ArticleProbeServiceImpl.java

当前问题：

sample执行超过60分钟时，只调用failSample把sample标成TIMEOUT，没有同步终止对应的pending execution。

最终形成：

sample = TIMEOUT
task = TIMEOUT
execution = pending

这是错误状态。

修改要求：

1. 当sample关联的execution仍是未领取状态：
   execution.status = 0
   execution.task_status = 0

   sample超时时必须条件更新execution为：

   status = 3
   task_status = 3
   task_end_time = 当前时间
   end_time = 当前时间
   last_error_code = RPA_EXECUTION_TIMEOUT
   last_error_at = 当前时间

2. 更新必须带原状态条件，避免和Worker领取竞争：

   WHERE id = ?
     AND status = 0
     AND task_status = 0
     AND answer_id IS NULL
     AND deleted = 0

3. 只有条件更新成功后，才能确认该pending execution已经过期。

4. 如果execution正在处理中：

   status = 1
   task_status = 1

   不要只根据sample.started_at无条件判定超时。

   必须检查execution最近心跳/modify_time，避免Worker仍在正常执行时被Java提前标记失败。

5. 如果processing execution心跳已过期：
   使用条件更新把execution和sample统一结束。

6. 如果execution已经成功：
   status = 2
   task_status = 2

   不能再把sample覆盖成TIMEOUT，应优先进入正常结果回收。

7. 如果execution已经失败：
   sample同步失败状态。

8. Probe父任务进入TIMEOUT/FAILED前，必须保证其所有关联execution都已经进入终态：

   2 = 成功
   3 = 失败

9. 增加状态一致性测试：

   - pending execution超时；
   - processing但心跳正常；
   - processing且心跳过期；
   - execution刚好并发成功；
   - execution刚好被Worker领取；
   - sample terminal但execution pending；
   - 父任务结束时不存在非终态execution。

四、P0：修复monitorDate一致性

创建ENTRY_MONITOR任务时必须保证：

probe_article_task.monitor_date
=
probe_article_sample.monitor_date
=
rpa_task_execution_context.monitor_date

检查以下代码：

triggerEntry
buildSamples
buildExecutionContext
dispatchPendingSamples

修改要求：

1. monitorDate只计算一次；
2. 使用Asia/Shanghai；
3. 创建task时写入；
4. 创建所有sample时使用同一个值；
5. 创建execution context时使用task.monitorDate；
6. 写context前校验：

   task.monitorDate != null
   sample.monitorDate != null
   task.monitorDate.equals(sample.monitorDate)

7. 不一致时：
   - 不创建execution；
   - 回滚当前sample的execution/context写入；
   - 记录INVALID_MONITOR_DATE_CONTEXT；
   - 不生成半条任务。

8. 数据库字段约束需要评估：

   - ENTRY scope的monitor_date必须非空；
   - ARTICLE_LEGACY兼容任务不能被误伤。

   如果无法直接把整列设为NOT NULL，应通过业务校验或CHECK约束限制ENTRY任务。

9. 增加测试：

   - task/sample/context日期完全一致；
   - 上海00:00边界；
   - task日期为空拒绝下发；
   - sample日期与task不同拒绝下发；
   - DIAGNOSIS不受影响；
   - ARTICLE_PROBE历史任务不受影响。

五、P0：修复历史脏execution

不要直接删除1293–1296。

新增一个明确、可审计、幂等的数据修复SQL，例如：

/Users/joke/Desktop/project/geno-digital-api/sql/mysql/20260807_repair_stale_entry_monitor_execution.sql

脚本执行前必须检查：

1. execution属于ENTRY_MONITOR；
2. business_task_id = 49；
3. execution.id IN (1293,1294,1295,1296)；
4. execution仍然status=0/task_status=0；
5. answer_id为空；
6. sample已经TIMEOUT；
7. probe任务已经TIMEOUT；
8. 不存在rpa_answer。

满足全部条件后才允许更新：

status = 3
task_status = 3
task_end_time = 当前时间
end_time = 当前时间
last_error_code = DATE_WINDOW_EXPIRED
last_error_at = 当前时间

不得删除execution、answer或reference。

脚本必须：

- 可重复执行；
- 第二次执行affected rows为0；
- 包含执行前查询；
- 包含执行后验证；
- 包含回滚说明；
- 不影响其他任务。

同时处理monitorDate脏数据：

不要把已终止历史任务强行改成今天可执行。

历史任务49应保持终态，只修正队列状态，不能重新开放。

六、P0：确认DAILY每日任务生成

当前数据库没有看到：

trigger_type = DAILY
runs_per_platform = 30

检查：

ArticleProbeJob.ensureDailyEntryMonitors
ArticleProbeService.ensureDailyEntryMonitorTasks
ArticleProbeServiceImpl.ensureDailyEntryMonitorTasks
TenantJob租户遍历
Spring定时任务是否启用

要求：

1. 每5分钟幂等检查当天DAILY任务；
2. 当前租户1必须被扫描；
3. 项目5、词条28、成功发布URL存在时能够生成；
4. DAILY幂等键必须包含：

   tenant
   intentEntryId
   monitorDate
   DAILY

5. 同一天多节点并发只能创建一个DAILY父任务；
6. 一个词条×4个平台×30次应生成120个sample；
7. 爬虫不能自行补30次；
8. 如果旧PUBLISH_RECORD任务已TIMEOUT，不应永久阻止新一天的DAILY任务；
9. 当天已有DAILY任务时不能重复创建；
10. 增加明确日志：

   DAILY_SCAN_STARTED
   DAILY_ENTRY_SKIPPED
   DAILY_TASK_CREATED
   DAILY_TASK_ALREADY_EXISTS
   DAILY_TASK_CREATE_FAILED

日志不要记录完整词条正文或URL。

如果代码已经正确但数据库仍没有DAILY任务，需要检查实际运行的Java包是否为最新编译版本。

输出：

- 当前运行版本判断依据；
- 定时任务是否执行；
- 租户1是否进入调度；
- 为什么项目5没有DAILY任务。

七、P0：修复爬虫任务检查CLI

文件：

/Users/joke/Desktop/爬虫/src/checkRpaTasks.ts

当前问题：

代码使用：

new RpaTaskRepository(undefined, audit)

没有传入：

retryScheduleEnabled
workerProvider
entryMonitorEnabled
entryMonitorGrayProjectIds

导致：

即使.env配置ENTRY_MONITOR_ENABLED=true，
npm run rpa:tasks:check -- --worker=monitor

仍然只检查ARTICLE_PROBE，无法显示ENTRY_MONITOR。

修改要求：

1. 让检查CLI与正式Worker使用同一套仓储配置构造逻辑；
2. 不复制第二套环境变量解析；
3. 抽取共享函数，例如：

   createRpaTaskRepositoryOptions(config)

4. 正式Worker和check CLI都调用同一个函数；
5. check CLI继续默认只读；
6. 除非显式--claim=true，否则不能更新任务；
7. check CLI输出时增加businessType，但不要输出keyword；
8. 输出项目ID时仍需做隐私控制；
9. diagnosis检查行为保持原样；
10. 增加测试：

   - 默认monitor只显示ARTICLE_PROBE；
   - ENTRY_MONITOR_ENABLED=true后显示ENTRY_MONITOR；
   - 项目不在灰度白名单时不显示；
   - provider不匹配时不显示；
   - diagnosis仍只显示DIAGNOSIS；
   - 默认不领取；
   - --claim=true才领取。

八、P0：修复爬虫部署配置

在完成数据库脏任务修复并确认Java生成新的有效任务后，再修改本地：

/Users/joke/Desktop/爬虫/.env

增加：

ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_GRAY_PROJECT_IDS=5

保留：

RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
RPA_MONITOR_DRY_RUN=false

注意：

1. 不提交.env；
2. 不输出数据库密码；
3. 不输出会话凭据；
4. 修改后重启monitor Worker；
5. 先使用dry-run验证，再正式领取。

推荐灰度顺序：

第一步：

RPA_MONITOR_DRY_RUN=true
ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_GRAY_PROJECT_IDS=5

运行只读任务检查，确认能看到新生成且状态正常的ENTRY_MONITOR。

第二步：

只启用一个平台，例如豆包。

第三步：

确认answer/reference/Java回收全部正常。

第四步：

再启用四个平台。

九、禁止在爬虫中增加错误业务依赖

不能为了解决“父任务已TIMEOUT但execution仍pending”，让爬虫查询：

probe_article_task
probe_article_sample
probe_article_target
brand_article_publish_record

原因：

RPA唯一任务入口必须保持rpa_task_execution。

正确职责是：

Java在业务任务结束时同步终止execution；
爬虫只相信execution队列状态。

十、验证新的有效任务

修复后，应重新生成一组新的任务，不复用1293–1296。

新的任务必须满足：

1. probe task状态为RUNNING；
2. sample状态为DISPATCHED；
3. execution状态为0/0；
4. worker_provider=NEW_RPA；
5. dispatch状态为DISPATCHED；
6. context存在；
7. task/sample/context monitorDate一致；
8. projectId=5；
9. intentEntryId=28；
10. keyword正确；
11. 不存在answer；
12. 当天任务没有过期。

爬虫只读查询应该能够返回：

businessType = ENTRY_MONITOR
projectId = 5
intentEntryId = 28
monitorDate = 上海当天
四个平台任务

十一、真实灰度验收

1. 先运行：

   npm run check
   npm test
   npm run build

2. 当前爬虫基线是：

   TypeScript检查通过；
   290个测试通过。

   修改后不能少于当前测试覆盖，不能删除或skip测试。

3. Java运行：

   品牌模块完整编译；
   ENTRY_MONITOR专项测试；
   ArticleProbe专项测试；
   品牌诊断专项回归。

4. 单项目单平台灰度：

   项目5
   词条28
   豆包
   1条新的execution

5. 验证爬虫：

   - 能查询；
   - 能原子领取；
   - 原样发送keyword；
   - 写rpa_answer；
   - 写rpa_answer_reference；
   - execution更新为2/2。

6. 验证Java：

   - sample更新为SUCCEEDED；
   - task正常汇总；
   - 引用快照生成；
   - URL匹配执行；
   - LLM分析执行；
   - 不出现“sample超时但execution pending”。

7. 再验证：

   4个平台×1次；
   DAILY 4个平台×30次；
   跨上海00:00；
   数据库断线；
   Worker领取和Java超时并发；
   Java重启；
   多节点定时任务并发。

十二、品牌诊断回归保护

修改前后必须验证：

1. diagnosis只查询DIAGNOSIS；
2. diagnosis领取SQL不变；
3. diagnosis批次顺序不变；
4. diagnosis会话归属不变；
5. diagnosis联网策略不变；
6. diagnosis回答提取不变；
7. diagnosis引用提取不变；
8. diagnosis Outbox不变；
9. diagnosis重试不变；
10. diagnosis僵尸恢复不变；
11. diagnosis Fleet启动不变；
12. diagnosis不读取ENTRY_MONITOR上下文；
13. diagnosis不读取ENTRY_MONITOR会话表。

十三、完成后输出

请输出：

1. 根因确认；
2. Java修改文件；
3. 爬虫修改文件；
4. 数据修复SQL文件；
5. 超时状态一致性实现；
6. monitorDate一致性实现；
7. DAILY任务生成结果；
8. check CLI修复结果；
9. 配置修改说明；
10. 数据库修复前后查询结果；
11. 新任务ID和execution ID；
12. npm run check结果；
13. npm test结果和测试总数；
14. npm run build结果；
15. Java编译测试结果；
16. 品牌诊断回归结果；
17. 灰度执行结果；
18. 尚未解决的风险。

再次强调：

不要让爬虫通过查询probe业务表规避后端状态问题。

必须从Java端保证：

业务任务结束
→ sample进入终态
→ 对应execution也进入终态

只有新的、状态一致、日期一致的execution才能被爬虫领取。
```

最优先要修改的是：

1. Java 超时后同步终止 execution。
2. 修复 task/sample/context 日期一致性。
3. 修复历史 `1293–1296` 脏任务。
4. 确认 DAILY 定时任务实际运行。
5. 修复 `rpa:tasks:check` 不读取 ENTRY_MONITOR 配置。
6. 最后再开启项目 `5` 的爬虫灰度。
