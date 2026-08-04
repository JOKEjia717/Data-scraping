# 豆包 / DeepSeek / 千问 / 元宝参考来源爬虫

基于 TypeScript、Playwright 和 Chrome DevTools Protocol（CDP）的多平台参考来源采集工具。程序会同时驱动已登录的 AI 平台发送问题，等待各自回答完成，展开当前回答的引用列表，并导出结构化数据。

每条记录包含：问题、抓取平台、引用排名、文章来源、文章时间、标题、摘要、URL 和抓取时间。默认问题位于 `src/questions.ts`，也可以在运行时传入 TXT 或 JSON 问题文件。

## 正式 Worker：从零启动

如果目标是接管 `geno-digital-api` 的全部 RPA 任务，只按下面顺序操作。完整接管前必须执行
database migration；如果只有生产数据库，先按下方“生产库兼容测试”使用单平台和指定业务任务
验证，不能直接全量切换。

### 只有生产数据库时的兼容测试

首次验证可以先不部署 Java provider 代码、不执行 migration：保持
`PROVIDER_ROUTING_ENABLED=false` 和 `DATABASE_RETRY_SCHEDULE_ENABLED=false`，暂停旧 RPA，
通过现有后端创建一个专用测试业务任务，然后使用
`--gray-business-task-ids=<业务任务ID> --platforms=doubao --run-once=true --max-tasks=1`
限制新 Worker。dry-run 确认只命中该批次后，才临时增加
`--allow-production-claims=true --dry-run=false` 执行。完成后立即恢复禁止领取并核对数据库结果。

这只是现有表结构的兼容验证。验证成功后，生产升级仍应采用：兼容 migration（默认
`LEGACY`）→ 部署兼容后端 → 再执行独立 `cutover_to_new` 脚本。旧 RPA 在单任务真实执行窗口
和最终 cutover 前必须停止。

### 1. 安装并创建配置

```bash
cd /Users/joke/Desktop/爬虫
npm install
cp -n .env.example .env
```

然后编辑 `.env`，至少填写：

```env
RPA_DB_HOST=127.0.0.1
RPA_DB_PORT=3306
RPA_DB_USER=实际账号
RPA_DB_PASSWORD=实际密码
RPA_DB_NAME=实际数据库

RPA_WORKER_ENVIRONMENT=staging
RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
RPA_WORKER_DATABASE_RETRY_SCHEDULE_ENABLED=true

RPA_DIAGNOSIS_DRY_RUN=true
RPA_MONITOR_DRY_RUN=true
```

不要提交 `.env`，也不要在首次启动时填写
`RPA_WORKER_ALLOW_PRODUCTION_CLAIMS=true`。

### 2. 启动两个独立 Chrome

分别在两个终端执行：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/joke/Desktop/爬虫/.chrome-profiles/diagnosis
```

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 \
  --user-data-dir=/Users/joke/Desktop/爬虫/.chrome-profiles/monitor
```

在两个 Chrome 中分别打开豆包、DeepSeek、千问、元宝并完成登录。9222 专用于品牌诊断，
9223 专用于文章监测，两个窗口不能共用 Profile。

### 3. 健康检查

```bash
cd /Users/joke/Desktop/爬虫
npm run rpa:diagnosis:health
npm run rpa:monitor:health
```

只有数据库、CDP、平台标签页、登录状态和输入框全部正常后才继续。

### 4. dry-run 查看任务

```bash
npm run rpa:diagnosis
npm run rpa:monitor
```

默认 `dry-run=true`：只查询并显示将执行的完整品牌批次，不领取任务、不操作页面、不写结果。

### 5. 单平台单轮验证

```bash
npm run rpa:diagnosis -- \
  --dry-run=false --run-once=true --platforms=doubao --max-tasks=1

npm run rpa:monitor -- \
  --dry-run=false --run-once=true --platforms=doubao --max-tasks=1
```

确认任务领取、回答、引用、`answer_id`、双状态 `2/2` 和 Outbox 均正常后，才启动四平台常驻服务：

```bash
npm run rpa:diagnosis -- \
  --dry-run=false --platforms=doubao,deepseek,qianwen,yuanbao

npm run rpa:monitor -- \
  --dry-run=false --platforms=doubao,deepseek,qianwen,yuanbao
```

两个命令需要在两个独立终端或进程管理器中长期运行。按一次 `Ctrl+C` 会停止领取新批次，
等待当前品牌批次完成后安全退出。运行日志、Outbox、证据和指标默认位于
`rpa-runtime/diagnosis` 与 `rpa-runtime/monitor`。更完整的上线与回滚步骤见
[`docs/RPA_PRODUCTION_RUNBOOK.md`](docs/RPA_PRODUCTION_RUNBOOK.md)。

## 核心流程

```text
问题库
  ↓
四个平台并发提问（豆包 / DeepSeek / 千问 / 元宝）
  ↓
等待本题回答与引用列表稳定
  ↓
research 模式下参考资料缺失时按平台检查或重新提问
  ↓
各平台解析、清洗后更新内存快照
  ↓
单题事务写入 MySQL，同时刷新平台文件和根目录汇总
  ↓
research 完成整轮、business 每个品牌完成后立即新建对话
  ↓
按平台分桶 → 平台内按问题分组 → 合并四个平台的同题数据
```

默认 `research` 模式中，单道题没有参考资料时，豆包会最多重新发送同一问题 3 次，其他平台按各自策略检查；引用入口仍缺失、列表仍未稳定或解析结果仍为空时，只跳过当前题并继续下一题，对应平台数组保留为空。`business` 模式不会因引用为 0 重发或重新生成，只有输入框缺失、回答超时、正文为空或 DOM 解析异常等技术失败才会进入技术重试。登录失效或无法确认回答已经结束等会造成题目错位的严重异常，仍会停止当前平台任务。

## 运行环境

- Node.js 18 或更高版本
- npm
- Google Chrome
- 已登录豆包、DeepSeek、千问和元宝账号

程序连接本机已经打开的 Chrome，不会自动启动浏览器、登录账号或关闭标签页，也不需要安装 Playwright 自带的 Chromium。

## 快速开始

### 1. 安装依赖

在项目根目录执行：

```bash
npm install
```

### 2. 启动调试模式 Chrome

先退出普通 Chrome，再在终端 A 中执行：

#### macOS

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-ai-crawler
```

#### Windows PowerShell

Chrome 安装在系统默认目录时执行：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-ai-crawler"
```

如果提示找不到 `chrome.exe`，Chrome 可能安装在当前用户目录，改用：

```powershell
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-ai-crawler"
```

保持这个 Chrome 窗口打开。另开一个 PowerShell 窗口，可以用下面的命令确认调试端口已经启动：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

看到浏览器版本和 `webSocketDebuggerUrl` 等信息即表示启动成功。

### 3. 打开平台并登录

在该 Chrome 中打开需要采集的平台，登录后停留在聊天页面：

| 平台 | 页面地址 |
| --- | --- |
| 豆包 | `https://www.doubao.com/chat/` |
| DeepSeek | `https://chat.deepseek.com/` |
| 千问 | `https://www.qianwen.com/` 或 `https://chat.qwen.ai/` |
| 元宝 | `https://yuanbao.tencent.com/chat/` |

只采集某个平台时，只需打开对应页面。

### 4. 配置 MySQL

复制环境变量模板：

```bash
cp .env.example .env
```

在 `.env` 中填写低权限数据库账号。默认连接本机 `127.0.0.1:3306` 的
`Data_Scraping` 数据库；真实密码只保存在 `.env`，该文件已被 Git 忽略。

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=crawler_app
DB_PASSWORD=你的数据库密码
DB_NAME=Data_Scraping
DB_CONNECTION_LIMIT=6
DB_SSL=false
```

如果密码包含 `#`，必须使用引号包住完整密码，否则 `#` 后面的内容会被
`dotenv` 当成注释：

```env
DB_PASSWORD="完整密码#后半段"
```

填写完成后执行只读连接检查：

```bash
npm run db:check
```

公网或生产环境建议将 `DB_SSL` 设置为 `true`，并通过 `DB_SSL_CA_PATH`
配置 MySQL CA 证书；开启 TLS 后程序始终验证服务端证书，不提供跳过验证的开关。

数据库入库默认开启。每次运行会自动创建一个 `question_batches` 批次和一个
`crawl_runs` 运行记录，并预先创建所有“问题 × 平台”任务。每完成一道题，
程序会在同一个事务中写入任务状态、最终答案和参考资料，同时继续保留原有
JSON/CSV 文件。临时只调试页面和文件输出时可加 `--database=false`。

### 5. 运行

在终端 B 中执行：

```bash
npm run crawl
```

默认运行模式是 `research`，完全保留原问题文件、提示词、CLI、数据库和本地
JSON/CSV 输出行为。

### Business 品牌批次模式

`business` 模式要求 `--questions` 指向 JSON 品牌批次文件。每个批次必须包含
`tenantId`、`businessTaskId`、`brand` 和非空 `questions`：

```json
[
  {
    "tenantId": "tenant-001",
    "businessTaskId": "task-20260803-01",
    "brand": "品牌甲",
    "questions": [
      "品牌甲的核心产品有哪些？",
      "品牌甲适合哪些消费人群？"
    ]
  },
  {
    "tenantId": "tenant-001",
    "businessTaskId": "task-20260803-02",
    "brand": "品牌甲",
    "questions": [
      "品牌甲近期有哪些新品？"
    ]
  }
]
```

运行示例：

```bash
npm run crawl -- --mode=business --questions=business-batches.json --database=false
```

执行器会先按 `tenantId + businessTaskId + brand` 合并重复批次。同一批次在
每个平台使用一个独立对话连续执行全部问题；品牌最后一道题保存完成后会立即创建
空白新对话，下一品牌直接认领该对话，避免重复点击。任一身份字段不同都不会复用
上一品牌的会话。
即使同一品牌稍后再次出现，只要属于新业务任务，也会完整执行新批次。问题文本
按 JSON 中的原字符串发送，不拼接 `--prompt-prefix`。`CollectionMode` 的 business
默认配置会同时关闭 `retryOnNoReferences` 和 `regenerateOnNoReferences`。联网已验证
开启（或策略明确为 DISABLED）且有正文但 0 引用时，独立单题调用返回 `success`，批量层
按原协议映射为 `completed`，`referenceCount` 为 `0`，不会重新提问或重新生成；请求了
联网但状态未确认时则返回技术失败，不能误记为正常未曝光。

本阶段只升级本项目的执行内核；尚未接入 `geno-digital-api` 数据库。原有 MySQL
持久化仍可按原方式使用，也可像上例通过 `--database=false` 仅写本地文件。

### 内存品牌批次调度器

`src/scheduler.ts` 提供独立的 `BrandBatchScheduler`。单条任务按
`brandId + businessGroupId + platformId` 聚合；同平台只有当前批次完成或失败后
才能取得下一批，不同平台可以分别调用 `getNextBatch(platformId)` 独立拉取。
批次选择顺序为：较高 `priority`、较早创建时间、较早入队顺序。调度器只维护
内存状态，不连接数据库、Chrome，也不创建新对话。

### 会话生命周期管理

`src/conversationManager.ts` 负责批次与平台页面会话之间的唯一映射。会话在
BrandBatch 开始时创建，批内问题通过 `acquireForQuestion` 复用；批次完成后立即
解除归属并创建空白新对话，下一品牌只认领该空白对话，不会复用上一品牌的内容。
品牌/任务/租户变化、损坏标记、
最大时长或最大题数都会强制轮换。`conversationGroupId` 由租户、业务任务、品牌、
业务组、平台、批次 ID 和轮换序号共同生成。

页面上的“新建对话”DOM 操作也封装在该模块；`crawlPlatform` 通过页面适配器使用
ConversationManager，`executeQuestion` 仍只在当前既有对话中执行单题，不具备创建
会话的能力。

### 多平台内存执行层

`src/platformExecution.ts` 在 BrandBatchScheduler 之上提供
`MultiPlatformExecutionLayer`。豆包、DeepSeek、千问和元宝拥有各自的健康状态与
运行锁；同平台并发固定为 1，一次 `runNext(platformId)` 会连续执行完整品牌批次，
`tick()` 则让各平台独立拉取一次。某个平台失败会返回该平台自己的失败结果，不会
中断其他平台。

平台状态包括 `READY`、`RUNNING`、`COOLING_DOWN`、`RATE_LIMITED`、
`CAPTCHA_REQUIRED`、`LOGIN_REQUIRED`、`DOM_CHANGED` 和 `DISABLED`。限流、验证码、
登录失效等状态会在领取批次前拦截执行；可通过 `resumePlatform` 人工恢复，限流和
普通技术冷却也可配置到期自动恢复。题间隔、批次间隔和默认技术冷却时间均可按平台
配置。单题执行器返回 `zero_references` 与正常成功走同一条完成路径，不重试，也不
触发技术冷却。

该层通过 `executeTask` 注入浏览器侧能力，不创建 Chrome、不创建对话、不读写 MySQL
或 JSON/CSV。后续适配时应由批次开始钩子调用 ConversationManager，再由
`executeTask` 在已存在的会话中调用 `executeQuestion`；本阶段未替换原有 CLI 流程。

### Worker 自检、结构化日志与失败证据

`src/browserDiagnostics.ts` 提供 `runBrowserSelfCheck`。Worker 启动时只连接一次 CDP，
然后分别检查豆包、DeepSeek、千问和元宝标签页及可用输入框；单个平台异常不会终止
其他平台的自检。页面对话框、警告和登录区域会识别登录失效、验证码、匿名额度耗尽
和限流，并转换成稳定错误码及平台健康状态。`onPlatformFailure` 可用于在启动失败时
接入告警或页面证据保存，CDP 不可连接及标签页不存在等无页面场景只返回受限错误
摘要。

`src/workerObservability.ts` 提供以下长期运行组件：

- `StructuredTaskLogger`：向可配置 `logDirectory` 写入逐题 JSONL；
- `FailureEvidenceStore`：向可配置 `evidenceDirectory` 写入视口截图和诊断 JSON；
- `createSelfCheckEvidenceHandler`：把存在页面的启动自检失败保存为证据；
- `createObservedPlatformTaskExecutor`：装饰执行层的 `executeTask`，统一记录成功、
  零引用和技术失败；
- `platformTaskOutcomeFromQuestionResult`：将现有 `executeQuestion` 结果转换成执行层
  结果，并保留实际发送问题、引用数和重试数。

每条任务日志包含 worker、品牌、业务组、平台、会话组、批内问题序号、实际问题、
`requestedDeepThinking`、`actualDeepThinking`、`webSearchRequested`、
`webSearchEnabled`、`webSearchVerified`、耗时、引用数、重试数和错误码。无法取得
平台实际深度思考状态时 `actualDeepThinking` 为 `null`，不会用请求值冒充实际值。
问题与错误文本有固定长度上限，并对 token、密码、
Cookie、邮箱和手机号脱敏。失败证据中的页面文本同样限长，URL 中的敏感查询参数会
遮蔽；截图二进制和页面正文不会写入普通控制台或 JSONL。日志写盘异常也不会导致
已成功的问题被重复发送。

business/RPA 模式的普通控制台采用白名单事件格式：只显示 `workerId`、哈希后的
`executionId`、`brandId`、`platformId`、批次/事件进度、错误码和受限错误摘要。问题原文、
回答正文以及引用抽取中的标题和 URL 调试信息均不会打印；错误摘要会移除当前问题，
遮蔽 Cookie、Token、密码等凭据，并隐藏 URL 中 `token`、`code`、`key`、`session`、
`auth` 等查询参数。research 模式默认保留历史调试输出，可用 `--verbose=false` 显式
关闭。结构化 JSONL 仍保留业务所需的受限问题字段，但会先脱敏并截断。

这些组件不连接业务数据库，也不改变现有 CLI、MySQL 开关或 JSON/CSV 输出；长期
Worker 可按部署目录分别实例化日志器和证据存储，再将观察后的单题执行器注入
`MultiPlatformExecutionLayer`。

### Mock RPA Worker

`src/mockRpaWorker.ts` 提供不依赖项目数据库的模拟 Worker。任务可由
`JsonMockTaskSource` 从本地 JSON 加载，也可由 `InMemoryMockTaskSource` 直接注入。
每条任务包含：

```json
{
  "executionId": "exec-a-diagnosis-1",
  "businessType": "DIAGNOSIS",
  "businessTaskId": "diagnosis-20260803-a",
  "tenantKey": "tenant-demo",
  "brandId": "brand-a",
  "keyword": "品牌 A 的核心产品有哪些？",
  "aiModelId": "doubao",
  "aiModelName": "豆包",
  "deepThinking": false
}
```

`businessType` 只接受 `DIAGNOSIS` 和 `ARTICLE_PROBE`。`aiModelId` 可以直接使用
`doubao`、`deepseek`、`qianwen`、`yuanbao`，也可以使用项目侧模型 ID 并由
`aiModelName` 映射平台。任务按租户、业务类型、业务任务、品牌和平台归批；每个平台
独立串行，一个批次只由 ConversationManager 创建一次对话。`deepThinking` 会完整传给
单题执行器；发送 `keyword` 前先幂等确认对应平台的深度思考开关。统一结果同时保存
`requestedDeepThinking`、`actualDeepThinking` 和三个联网状态字段，便于验证页面实际
执行条件。

样例文件位于 `examples/mock-rpa-tasks.json`。先在 CDP Chrome 中登录并打开样例涉及的
四个平台，然后运行：

```bash
npm run mock:rpa -- \
  --tasks=examples/mock-rpa-tasks.json \
  --out=mock-rpa-output \
  --cdp=http://127.0.0.1:9222 \
  --task-interval-ms=1000 \
  --batch-interval-ms=3000 \
  --deep-thinking-unsupported-policy=fail \
  --web-search-policy=PREFERRED
```

CLI 固定使用 `business` 模式，逐字发送 `keyword`，并关闭缺少引用时的重新提问和
重新生成。联网执行条件已满足时，回答引用数为 0 仍保存为 `SUCCESS`；联网状态未确认时
不会生成普通零引用成功。输出目录包含：

- `collection-results.json`：统一的 `CollectionResult[]`；
- `execution-state.json`：每个 execution 的 `PENDING`、`RUNNING`、`SUCCESS` 或
  `FAILED` 模拟状态及结果快照。

状态在每题开始和结束时原子刷新。该 CLI 不导入数据库模块，不读取项目 MySQL，也不
修改原有 `npm run crawl` 的输出流程。

### geno-digital-api RPA 任务仓储（读取与领取阶段）

`src/rpaTaskRepository.ts` 已按 geno-digital-api 当前模型接入以下关系，但本阶段不写
采集结果：

```text
rpa_task_execution.task_id
  → brand_rpa_dispatch_task.id                  （dispatch ID）
  → brand_rpa_dispatch_task.business_task_id    （真正业务任务 ID）
      ├─ DIAGNOSIS → diagnosis_task.id → profile_id（brandId）
      └─ ARTICLE_PROBE → probe_article_task.id → brand_id（brandId）
```

所有 MySQL `bigint` 均按字符串进入 `RpaTask`，避免 JavaScript 精度丢失。
`CollectionTask` 额外包含供调度器直接入队的 `id`（execution ID）、原样问题
`question`、`platformId`、按租户/业务类型/业务任务生成的 `businessGroupId`，以及固定的
`mode: "business"`。geno-digital-api 中的模型映射为：
1=豆包、2=DeepSeek、3=元宝、4=千问。

仓储作用域严格区分 Worker：

- `findPendingTasks("diagnosis")` 只查询 `business_type = 'DIAGNOSIS'`；
- `findPendingTasks("monitor")` 只查询 `business_type = 'ARTICLE_PROBE'`。

领取通过单条条件 UPDATE 完成：只有 execution 的 `status = 0` 且
`task_status = 0` 时，才同时更新为 1，并写入开始/修改时间。dispatch 表只用于 JOIN、
`DISPATCHED` 和业务类型校验，不更新其状态。并发 Worker 中只有 `affectedRows = 1` 的
调用方获得任务；失败方继续尝试下一候选。

连接使用独立的 `RPA_DB_*` 环境变量，密码和库名均无代码默认值。复制
`.env.example` 后至少配置：

```env
RPA_DB_HOST=127.0.0.1
RPA_DB_PORT=3306
RPA_DB_USER=rpa_worker
RPA_DB_PASSWORD=真实密码
RPA_DB_NAME=geno_digital
```

建议该账号只授予相关表 SELECT、`rpa_answer`/`rpa_answer_reference` INSERT，以及
`rpa_task_execution` 领取、心跳、恢复和完成字段所需 UPDATE；不要授予 dispatch 状态写权限。
默认只读预览命令：

```bash
npm run rpa:tasks:check -- --worker=diagnosis --limit=10
npm run rpa:tasks:check -- --worker=monitor --limit=10
```

只有明确需要改变一条真实 execution 状态时才运行：

```bash
npm run rpa:tasks:check -- --worker=diagnosis --limit=10 --claim=true
```

查询和领取审计默认写入 `rpa-task-logs/rpa-task-repository.jsonl`；可用
`--log-dir=/absolute/path` 修改。审计不记录 keyword 和数据库凭据。任务查询/领取仓储
本身不写 `rpa_answer`、`rpa_answer_reference`，也不更新 dispatch 完成状态；结果写回由
下面独立的结果仓储负责。

### RPA 结果事务写回

`RpaResultRepository.saveSuccess` 先对 `rpa_task_execution` 执行 `FOR UPDATE`，核对
execution、dispatch ID、原始 keyword、处理状态和既有回答。通过校验后，在同一事务内
严格执行：插入 `rpa_answer`、插入零到多条 `rpa_answer_reference`、回填
`rpa_task_execution.answer_id`、将 `status` 和 `task_status` 同时置为 2，最后提交。
任何一步失败都会回滚，因此不会出现 execution 已完成但回答或引用尚未写完的状态。

零引用是正常成功结果，只跳过引用 INSERT。`thinking_process` 固定为空字符串，
`recommend_questions` 固定为 `[]`，分享 URL 可为 NULL。重复提交已完成的 execution
会幂等返回；如果发现历史遗留的回答半写状态，则拒绝再次插入，避免一个 execution
产生多条回答。

结果仓储保留低层 `markFinalTechnicalFailure` 条件更新能力，但正式 Worker 不再在首次
采集异常时直接调用它；正式入口统一通过 `retryExecution` 使用领取时的 `failCount`，到达
配置上限后才执行最终失败更新。所有失败更新仍只接受处理态且没有 `answer_id` 的 execution。
错误详情继续由本地结构化 Worker 日志保存，结果仓储不会更新
`brand_rpa_dispatch_task` 的任何状态。

### 最终 RPA Worker 灰度运行

生产稳定性、provider 灰度隔离、migration、十项故障演练、上线与回滚步骤见
[`docs/RPA_PRODUCTION_RUNBOOK.md`](docs/RPA_PRODUCTION_RUNBOOK.md)。新部署安全默认是
`staging + dry-run + provider 路由关闭`；未显式授权时不能领取生产任务。

提供两个完全独立的入口：

- `npm run rpa:diagnosis`：只读取和领取 `DIAGNOSIS`；默认 CDP 为 9222；
- `npm run rpa:monitor`：只读取和领取 `ARTICLE_PROBE`；默认 CDP 为 9223。

两个进程默认使用不同的 workerId、日志目录、失败证据目录和 Chrome Profile。每个 Worker
内部仍有豆包、DeepSeek、千问、元宝四条独立队列，单个平台并发固定为 1。跨进程使用
MySQL `GET_LOCK` advisory lease：同一个平台同一时刻只能被一个 Worker 操作，批次结束后
还会保持配置的最小间隔。两个 Worker 必须连接同一个 MySQL 实例，该保护才会生效。

#### 1. 启动两个独立 Chrome

先创建两个互不复用的用户目录，然后分别启动 Chrome。macOS 示例：

```bash
mkdir -p /absolute/path/to/chrome-profiles/diagnosis
mkdir -p /absolute/path/to/chrome-profiles/monitor

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/absolute/path/to/chrome-profiles/diagnosis

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 \
  --user-data-dir=/absolute/path/to/chrome-profiles/monitor
```

不要让两个 Chrome 指向同一个 `--user-data-dir`。分别在两个 Chrome 中打开需要启用的
平台标签页并完成登录。Worker 只连接已有 Chrome，不会替你启动 Chrome，也不会把一个
Profile 分配给另一个 Worker。

#### 2. 配置

数据库继续使用 `RPA_DB_*`。建议从 `.env.example` 复制 Worker 配置，至少核对：

```env
RPA_DIAGNOSIS_WORKER_ID=diagnosis-worker
RPA_DIAGNOSIS_CDP_ENDPOINT=http://127.0.0.1:9222
RPA_DIAGNOSIS_CHROME_PROFILE=/absolute/path/to/chrome-profiles/diagnosis
RPA_DIAGNOSIS_LOG_DIR=/absolute/path/to/rpa-runtime/diagnosis/logs
RPA_DIAGNOSIS_EVIDENCE_DIR=/absolute/path/to/rpa-runtime/diagnosis/evidence
RPA_DIAGNOSIS_OUTBOX_DIR=/absolute/path/to/rpa-runtime/diagnosis/outbox
RPA_DIAGNOSIS_METRICS_DIR=/absolute/path/to/rpa-runtime/diagnosis/metrics
RPA_DIAGNOSIS_DRY_RUN=true
RPA_DIAGNOSIS_MAX_TASKS=1
RPA_DIAGNOSIS_WEB_SEARCH_POLICY=PREFERRED

RPA_MONITOR_WORKER_ID=monitor-worker
RPA_MONITOR_CDP_ENDPOINT=http://127.0.0.1:9223
RPA_MONITOR_CHROME_PROFILE=/absolute/path/to/chrome-profiles/monitor
RPA_MONITOR_LOG_DIR=/absolute/path/to/rpa-runtime/monitor/logs
RPA_MONITOR_EVIDENCE_DIR=/absolute/path/to/rpa-runtime/monitor/evidence
RPA_MONITOR_OUTBOX_DIR=/absolute/path/to/rpa-runtime/monitor/outbox
RPA_MONITOR_METRICS_DIR=/absolute/path/to/rpa-runtime/monitor/metrics
RPA_MONITOR_DRY_RUN=true
RPA_MONITOR_MAX_TASKS=1
RPA_MONITOR_WEB_SEARCH_POLICY=REQUIRED

RPA_WORKER_HEARTBEAT_MS=30000
RPA_WORKER_STALE_AFTER_MS=900000
RPA_WORKER_RUN_ONCE=false
RPA_WORKER_POLL_INTERVAL_MS=10000
RPA_WORKER_POLL_JITTER_MS=1000
RPA_WORKER_METRICS_INTERVAL_MS=15000
RPA_WORKER_MAX_ATTEMPTS=3
RPA_WORKER_RETRY_BACKOFF_MS=30000
RPA_WORKER_PLATFORM_MIN_INTERVAL_MS=10000
RPA_WORKER_DEEP_THINKING_UNSUPPORTED_POLICY=fail
```

`STALE_AFTER_MS` 必须至少是心跳间隔的 3 倍。默认任务上限是 1，但品牌批次不可拆分：如果
最高优先级批次本身有多道题，本轮会完整执行该批次，因此实际题数可能超过软上限。
`MAX_ATTEMPTS` 是包含首次执行在内的任务级最大尝试次数，默认 3；`RETRY_BACKOFF_MS`
是首次任务失败后的退避基数，后续按已有 `fail_num` 指数增长，最长一小时。退避期间
execution 仍保持处理态并持有 advisory lock，避免另一 Worker 立即重新领取。
`POLL_INTERVAL_MS` 是空队列轮询间隔，默认 10 秒；`POLL_JITTER_MS` 默认增加最多 1 秒
随机抖动，避免 diagnosis、monitor 或同类 Worker 同时查询数据库。数据库异常会在该间隔
基础上指数退避，最高 5 分钟，不会形成报错忙循环。

运行指标默认每 15 秒原子更新到各 Worker 独立的
`metrics/worker-metrics.json`。快照按 `workerType` 和固定四个平台组织，包含待处理、
处理中、成功、最终失败、Outbox 待回写、Worker 心跳、平均任务等待/回答耗时、零引用、
平台暂停状态、验证码/登录/限流次数以及品牌批次完成或失败耗时。数据库状态聚合按同一
间隔限频；聚合查询或快照写盘失败不会影响任务领取和执行。指标结构不会接收或输出
executionId、brandId、完整问题、回答、租户凭据或 URL，不能把这些高基数/敏感字段追加为
监控标签。可用以下命令检查快照：

```bash
cat rpa-runtime/diagnosis/metrics/worker-metrics.json
cat rpa-runtime/monitor/metrics/worker-metrics.json
```

正式 Worker 会把数据库任务的 `deep_thinking` 原值传到单题页面执行层。每题发送前，
豆包、DeepSeek、千问和元宝分别使用自己的 DOM 选择器识别开关状态：已是目标状态时不
点击，不一致时只点击一次并再次确认；找不到开关、状态属性无法识别或点击后无法确认时，
按明确技术错误处理，不会在未知状态下发送问题。平台配置声明不支持该能力时，由
`RPA_WORKER_DEEP_THINKING_UNSUPPORTED_POLICY` 决定行为：`fail`（默认）使任务进入有限
技术失败闭环；`allow_degrade` 允许继续执行，并在日志中记录
`actualDeepThinking: null`，不会静默忽略。

联网搜索同样是发送前的可验证执行条件。`activateWebSearch` 返回 `requested`、
`supported`、`enabled`、`verified` 和受限长度的 `failureReason`，四个平台优先读取
`aria-pressed`、`aria-checked`、checkbox 或 `data-state`：已经开启时不重复点击，关闭时
只点击一次并复核。业务策略为：

- `REQUIRED`：未确认开启或平台不支持时产生技术错误，不发送问题；
- `PREFERRED`：尝试开启，失败时记录降级并继续采集回答；但 business 最终为零引用时，
  仍会转为联网未确认技术错误，不能记作普通未曝光；
- `DISABLED`：不点击联网开关，只记录能够只读识别到的页面状态。

ARTICLE_PROBE 无条件使用 `REQUIRED`，即使 monitor 配置误写成其他值也不会降级。
DIAGNOSIS 默认 `PREFERRED`，可通过 `RPA_DIAGNOSIS_WEB_SEARCH_POLICY` 配置。平台明确不
支持时使用稳定错误码 `WEB_SEARCH_UNSUPPORTED`；开关存在但无法确认时使用
`WEB_SEARCH_UNVERIFIED`。两者都会暂停对应平台，避免继续产生不可解释的零引用结果。
research 不显式传 `--web-search-policy` 时继续保持历史宽松尝试行为。

#### 3. 健康检查和 dry-run

健康检查会验证数据库只读查询、CDP、目标标签页、输入框、登录/验证码/限流提示：

```bash
npm run rpa:diagnosis:health
npm run rpa:monitor:health
```

普通启动默认也是 dry-run，只展示将选择的完整批次，不领取、不操作页面、不写结果：

```bash
npm run rpa:diagnosis
npm run rpa:monitor
```

dry-run 和健康检查始终只运行一次。显式关闭 dry-run 后，diagnosis 与 monitor 默认进入
常驻轮询服务；每轮依次执行 Outbox 重放、僵尸恢复、待办查询，并且每个平台只领取一个
完整品牌批次。该批次结束后，下个轮询周期才能领取同平台下一个品牌批次。CDP 连接、页面、
数据库仓储和平台健康状态在整个进程内复用，不会每轮重新连接 Chrome。

首次灰度建议只启用一个平台，并明确关闭 dry-run：

```bash
npm run rpa:diagnosis -- --dry-run=false --platforms=doubao --max-tasks=1
npm run rpa:monitor -- --dry-run=false --platforms=doubao --max-tasks=1
```

只执行一轮后退出，用于灰度或测试：

```bash
npm run rpa:diagnosis -- --dry-run=false --run-once=true --platforms=doubao --max-tasks=1
npm run rpa:monitor -- --dry-run=false --run-once=true --platforms=doubao --max-tasks=1
```

确认后再分别启动两个 Worker；四平台运行示例：

```bash
npm run rpa:diagnosis -- --dry-run=false --platforms=doubao,deepseek,qianwen,yuanbao
npm run rpa:monitor -- --dry-run=false --platforms=doubao,deepseek,qianwen,yuanbao
```

单题内核的技术重试次数是有限的；满足联网执行条件后的零引用不会重试。遇到 `CAPTCHA_REQUIRED`、
`LOGIN_REQUIRED` 或 `RATE_LIMITED` 时，只暂停对应平台，释放尚未发题的任务，其他平台继续。
验证码或登录问题需要人工处理后重新运行；限流至少等待配置的冷却时间再恢复。

任务级技术失败使用 `rpa_task_execution.fail_num` 闭环：`INPUT_UNAVAILABLE`
（对应 INPUT_NOT_FOUND）、`ANSWER_TIMEOUT`、`PAGE_DISCONNECTED`（对应
BROWSER_DISCONNECTED）等错误在退避后通过条件 UPDATE 将 `fail_num` 加 1，并在未到上限时
恢复双状态为 0；达到上限的同一次条件更新才把双状态写为 3。UPDATE 同时要求原状态仍为
1、`answer_id IS NULL` 且数据库 `fail_num` 等于领取时读到的值，因此两个 Worker 不会同时
释放同一 execution，也不会覆盖已经写入的回答。该流程只更新 `rpa_task_execution`。

`CAPTCHA_REQUIRED`、`LOGIN_REQUIRED`、`RATE_LIMITED` 和 `DOM_CHANGED` 会暂停对应平台，
不会在当前进程中连续操作页面。问题发送后发生超时或断线时，Worker 先只读检查当前问题
锚点、最新回答正文和生成状态：能够确认回答且联网状态已验证时按零引用成功写入 Outbox；无法确认时记录
`POST_SUBMIT_UNCERTAIN`，再按退避和最大次数保守重试。数据库错误仍只由 Result Outbox
重放，不增加 `fail_num`；只有联网执行条件已满足的零引用才是正常成功。

#### 4. 心跳、僵尸恢复和安全停止

领取后的 execution 会持续更新 `modify_time`，同时持有以 executionId 命名的 MySQL
advisory lock。僵尸恢复必须同时满足：双状态仍为 1、没有 answer_id、`modify_time` 已超过
阈值，并且恢复进程能取得同一个 execution lock。仍在运行的其他 Worker 持有锁时只会被
记录为“仍锁定”，不会被抢占。

按一次 `Ctrl+C` 或发送 `SIGTERM` 会进入安全停止：唤醒空闲轮询、不再领取新批次，已开始
的品牌批次继续完整结束，尚未执行的已领取任务恢复为 0，任务心跳和 advisory lock 随后
停止并释放。第二次停止信号只记录警告，不会调用破坏性的强制退出。不要直接 `kill -9`；如果进程异常退出，等
待 stale 阈值后重新启动同类型 Worker，它会在领取新任务前安全恢复无锁僵尸任务。

#### 5. 日志、证据和回退

默认路径：

```text
rpa-runtime/diagnosis/logs/
rpa-runtime/diagnosis/evidence/
rpa-runtime/diagnosis/outbox/
rpa-runtime/diagnosis/metrics/worker-metrics.json
rpa-runtime/monitor/logs/
rpa-runtime/monitor/evidence/
rpa-runtime/monitor/outbox/
rpa-runtime/monitor/metrics/worker-metrics.json
```

普通 JSONL 日志只保存受限问题、错误码和证据路径；截图和页面诊断在 evidence 目录，不会
直接打印到控制台。页面回答成功后会先以临时文件写完并原子 rename 到 outbox，再提交
MySQL；数据库提交成功后删除对应文件。MySQL 断线、超时或事务失败只保留 outbox 和
`RESULT_PERSISTENCE_PENDING` 日志，不会把 execution 标为 3，也不会暂停 AI 平台或重新提问。
Worker 每次正式启动都在浏览器自检和领取新任务前优先重放 outbox；只要仍有数据库重放
失败，本轮就不领取新任务。临时 `.tmp` 文件不会参与重放。

回退时先安全停止两个 Worker，把两个 `DRY_RUN` 恢复为 `true`，再运行
健康检查或只读任务检查。该入口不修改 `brand_rpa_dispatch_task` 状态，也不改变原有
`npm run crawl`；未开始的任务会主动释放，异常退出的处理中任务由上述安全僵尸策略恢复。

默认同时运行豆包、DeepSeek、千问和元宝。四个平台的终端日志会交错出现，这是并发运行的正常现象。需要中止时按 `Ctrl+C`；程序每完成一道题都会提交数据库事务并更新文件快照，已经完成的数据不会因中止而丢失。

不要再同时打开四个终端分别执行 `crawl:doubao`、`crawl:deepseek`、`crawl:qianwen` 和 `crawl:yuanbao` 并指向同一个输出目录。默认的 `npm run crawl` 已经并发运行四个平台，而且只有这个主进程负责更新根目录汇总，因此不会出现“最后完成的平台覆盖其他平台”的问题。单平台命令保留用于调试；调试时建议通过 `--out` 使用单独的输出目录。

并发抓取期间，每个平台拥有独立的数据快照；文件写入使用同一条 Promise 队列，并采用“临时文件写完后再替换正式文件”的原子写入方式。数据库通过任务 ID 隔离四个平台，并按单题使用事务写入。某个平台发生异常时，其当前及未执行任务会标记为 `failed`，其他平台继续抓取和入库，最后再统一结束本次运行。

### 数据库写入关系

```text
question_batches
├── questions
└── crawl_runs
    └── question_platform_tasks（问题 × 平台）
        ├── answers（每个任务最多一条，重复生成时覆盖为最后一版）
        └── references（当前最终答案对应的多条引用）
```

任务状态说明：

| 状态 | 含义 |
| --- | --- |
| `pending` | 已创建，尚未开始 |
| `running` | 正在提问或等待回答 |
| `completed` | 最终答案和有效参考资料已入库 |
| `no_references` | 回答已入库，但多次检查后没有有效参考资料 |
| `skipped` | 当前题无法形成可保存的回答，已跳过 |
| `failed` | 平台发生会造成错位的异常，任务失败 |

查询最新一次运行的分组结果：

```sql
SELECT
  q.sort_order,
  q.content AS question,
  p.name AS platform,
  t.status,
  a.content AS answer,
  a.generation_number,
  a.reference_count,
  r.rank,
  r.title,
  r.url
FROM crawl_runs cr
JOIN question_platform_tasks t ON t.run_id = cr.id
JOIN questions q ON q.id = t.question_id
JOIN platforms p ON p.id = t.platform_id
LEFT JOIN answers a ON a.task_id = t.id
LEFT JOIN `references` r ON r.task_id = t.id
WHERE cr.id = (SELECT MAX(id) FROM crawl_runs)
ORDER BY q.sort_order, p.id, r.rank;
```

## 平台模块

四个平台均采用“记录提问前基线 → 等待新回答结束 → 只展开本题引用 → 等待列表稳定 → 结构化解析”的流程。business 模式下，每个平台完成一个品牌的最后一道题并保存数据后，会立即点击“新建对话”并确认空白输入界面，再允许进入下一品牌；research 模式仍在整轮问题完成后创建新对话。某个平台切换失败只会影响该平台，不会中断其他并发平台，已经写入的数据仍会保留。

### 豆包

- 优先以当前问题文本节点为锚点，只检查它之后的 `search_query_result_block`；提问前还会记录现存搜索块的元素身份。当长会话连问题气泡一起回收时，只接受提问后新挂载且含“参考 N 篇资料”的搜索块。块数量仅作为最后后备，因此 DOM 数量减少、复用数量或索引前移时也不会误读历史回答。
- 等待生成按钮消失和正文稳定；当前问题之后已经出现“参考 N 篇资料”且页面短暂稳定时可直接进入引用阶段，避免回答实际结束后仍等待到全局超时。
- 原始回答没有可用参考列表时，不点击容易变化的“重新生成”按钮，而是通过输入框重新发送同一问题；每次发送前重新记录 DOM 基线，最多重新提问 3 次。
- 每次回答结束后立即从当前 `block-v2` 的 `block_type:10000` 正文块缓存答案；重新提问产生的新答案会覆盖上一版，最终只保留最后一次实际生成的正文。搜索入口、引用列表、相关视频和操作按钮不会写入答案。
- 豆包展开入口最长等待 30 秒，展开后最长等待 15 秒确认引用子节点数量和 URL 集合稳定。
- 只遍历命中引用容器的直接子节点，从卡片内提取标题、来源、摘要和 URL，并进行 URL 清洗与去重。
- 3 次重新提问后仍找不到当前引用容器或列表仍未稳定时跳过当前题，且不会回退读取历史引用。

输出目录：`results/doubao/`

### DeepSeek

- 提问前记录页面正文、高度和 `._223dd7b` 引用容器数量，用于识别新回答是否开始。
- 回答结束后读取最后一个 `.ds-markdown.ds-assistant-message-main-content` 正文区，并移除只用于标注来源编号的链接和操作按钮；历史回答不会写入答案文件。
- 回答结束后，只点击页面最下方、文本严格符合“X个网页”的最新 `.f93f59e4` 按钮，不操作历史回答入口。
- 等待最后一个可见 `._223dd7b` 列表的引用数量和 URL 集合稳定，再逐个解析其直接子节点；同时兼容直接子节点为 `div` 或 `a` 的页面版本。
- 从单条引用卡片内提取来源、日期、标题、摘要和 URL。标题明显不完整时，默认访问文章页面并使用 `og:title`、`twitter:title` 或 `<title>` 补全，可用 `--resolve-titles=false` 关闭。
- 引用按钮缺失、列表未稳定或没有有效外部链接时最多检查 3 次，随后跳过当前题，不回退扫描整页。

输出目录：`results/deepseek/`

### 千问

- 提问前记录 `.link-title-igf0OC` 参考入口数量，只允许点击本题回答新增的最后一个入口。
- 如果首次回答结束后没有新参考入口，会通过 `reg_svg` 图标找到最新回答的重新生成控件，先点击其外层 `.flex.items-center.rounded` 打开菜单，再点击 `role="menuitem"`、文字严格为“重新生成”的长 class 菜单项。点击后 15 秒内检查生成是否启动；自动重新生成严格限制为一次。
- 从最新回答的 `.qk-markdown` 读取正文，排除引用编号、多模态视频推荐和操作按钮；自动重新生成成功时，新正文覆盖原始正文，最终只保存第 2 版。
- 等待回答时会单独分析本题新增正文；如果同一批长句高频重复、判定千问回答进入循环崩坏，程序会立即停止当前生成、跳过该题并继续下一题，不再耗尽单题 5 分钟超时。正常长列表和少量重复不会触发该保护。
- 点击入口后等待最后一个可见 `.list-XPxyL2`。列表达到入口标注的引用数并稳定，或其直接子节点与 URL 集合持续稳定后，才开始解析。
- 只遍历列表的直接子 `div`，优先从 `data-exposure-extra`、`data-click-extra` 读取标题、URL 和引用顺序，同时兼容卡片内的链接及数据属性。
- 重新生成后仍无入口、列表未稳定或解析为空时继续完成最多 3 次检查，随后跳过当前题。

输出目录：`results/qianwen/`

### 元宝

- 每道题开始前先关闭上一题的引用抽屉，并给当前已有的 `.ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b` 入口加本轮身份标记。
- “源”入口和回答操作栏可能在正文流式输出期间提前出现，因此不再把入口出现视为回答完成。程序以当前问题为 DOM 锚点，只观察它之后的最新 AI 正文；正文至少连续 15 秒不再增长且本题已等待 20 秒后，才缓存答案并进入引用阶段。
- 回答完成后优先点击未标记的新入口；长会话发生 DOM 回收、入口总数不再增长时，改用当前问题文本作为 DOM 锚点，只接受问题之后的参考入口。
- 入口点击依次尝试外层普通点击、内部可点击节点、强制点击和 DOM 点击；每一步都必须确认可见引用抽屉已经出现，避免把事件派发成功误判为列表打开。
- 如果入口已经定位但仍打不开，日志会打印尺寸、CSS 可见性、`pointer-events`、禁用状态、视口状态、中心点遮挡元素和每种点击方式的实际错误；完全没有候选时才打印入口定位失败。
- 点击入口后优先读取已打开抽屉中的 `.agent-dialogue-references__list`，同时兼容抽屉存在但 `t-drawer--open` class 发生变化的页面版本。
- 持续检查列表直接子 `li` 的数量、标题和 URL；这些内容稳定后才进行提取，避免抽屉仍在加载时漏抓。
- 每个 `li` 作为一条引用解析，优先读取 `.hyc-common-markdown__ref_card[data-url]` 及卡片标题、来源、时间和摘要，随后清洗 URL、去重并保持页面顺序。
- 从最新 AI 消息的 `.agent-chat__speech-card__text` 读取正文，并排除图片替换卡片和操作按钮，避免车型图片标题在答案中重复出现。
- 抓取结束后自动关闭引用抽屉；入口缺失、列表未稳定或结果为空时最多检查 3 次，随后跳过当前题，不读取历史抽屉内容。

输出目录：`results/yuanbao/`

## 输出文件

```text
results/
├── doubao/references.json
├── doubao/references.csv
├── doubao/answers.json
├── doubao/answers.csv
├── deepseek/references.json
├── deepseek/references.csv
├── deepseek/answers.json
├── deepseek/answers.csv
├── qianwen/references.json
├── qianwen/references.csv
├── qianwen/answers.json
├── qianwen/answers.csv
├── yuanbao/references.json
├── yuanbao/references.csv
├── yuanbao/answers.json
├── yuanbao/answers.csv
├── references.json
└── references.csv
```

平台子目录中的引用 JSON、CSV 均保持原有的扁平记录格式。豆包、DeepSeek、千问和元宝都会生成各自的 `answers.json` 与 `answers.csv`，每道题仅保存最后一次实际生成的回答；即使最终没有可用参考资料，也会保留已抓到的答案正文并将 `referenceCount` 写为 `0`。生成引用汇总数据时，程序先把记录放入豆包、DeepSeek、千问、元宝各自的数据组，再在每个平台内按问题分组，最后合并四个平台中的相同问题。根目录的 `results/references.json` 因此按“问题 → 平台 → 引用记录”组织，平台内部不再重复保存 `question` 字段；四个平台键始终存在，没有结果时为 `[]`。根目录的 `results/references.csv` 继续使用便于表格处理的扁平格式。

### 清洗规则

1. 原始引用先按 `crawlPlatform` 放入四个平台数据组，平台独立文件保持原字段不变。
2. 每个平台内部再按 `question` 建立索引。
3. 按问题库顺序合并四个平台的同题数组；未采集到数据的平台保留空数组。
4. 平台内部记录移除已经由父节点表达的 `question`，其余字段和顺序保持不变。
5. URL 会解开常见中转参数、删除营销跟踪参数和锚点，再按规范化 URL 去重。
6. 平台自身链接、无效 URL、重复引用和引用容器之外的页面链接不会进入结果。

### 字段说明

| 字段 | 含义 |
| --- | --- |
| `question` | 本条引用对应的问题；汇总 JSON 中只出现在问题父节点 |
| `submittedQuestion` | 实际发送到平台的完整问题文本 |
| `crawlPlatform` | 获取回答的平台：豆包、DeepSeek、千问或元宝 |
| `rank` | 该平台在当前问题下的引用顺序，从 1 开始 |
| `articlePlatform` | 引用文章所属媒体或站点，无法识别时使用域名 |
| `articleTime` | 卡片中抽取到的发布日期或相对时间，缺失时为空字符串 |
| `title` | 清洗后的文章标题 |
| `summary` | 引用卡片摘要，页面未提供时为空字符串 |
| `url` | 解跳转、去跟踪参数后的文章地址 |
| `extractedAt` | 抓取时间，使用 ISO 8601 UTC 字符串 |

四个平台答案文件字段：

| 字段 | 含义 |
| --- | --- |
| `question` | 当前回答对应的问题 |
| `submittedQuestion` | 实际发送到平台的完整问题文本 |
| `crawlPlatform` | 生成该回答的平台：豆包、DeepSeek、千问或元宝 |
| `answer` | 最后一次实际生成的回答正文 |
| `generationNumber` | 生成版本，从 1 开始；豆包重新提问或千问重新生成成功后递增 |
| `referenceCount` | 该最终答案成功解析出的参考文献数量；没有有效引用时为 0 |
| `extractedAt` | 最终正文缓存时间，使用 ISO 8601 UTC 字符串 |

汇总 JSON 示例：

```json
[
  {
    "question": "互联网行业内有哪些大品牌？",
    "platforms": {
      "豆包": [
        {
          "crawlPlatform": "豆包",
          "rank": 1,
          "articlePlatform": "文章来源",
          "articleTime": "文章时间",
          "title": "文章标题",
          "summary": "文章摘要",
          "url": "文章地址",
          "extractedAt": "抓取时间"
        }
      ],
      "DeepSeek": [],
      "千问": [],
      "元宝": []
    }
  }
]
```

## 运行命令

只运行一个平台：

```bash
npm run crawl:doubao
npm run crawl:deepseek
npm run crawl:qianwen
npm run crawl:yuanbao
```

常用参数：

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `--mode` | 执行模式：`research`（默认）或 `business` | `--mode=business` |
| `--questions` | research 使用 TXT/字符串数组 JSON；business 使用品牌批次 JSON | `--questions=questions.txt` |
| `--out` | 修改输出目录 | `--out=results-2026-07-17` |
| `--cdp` | 修改 CDP 地址，默认 `http://127.0.0.1:9222` | `--cdp=http://127.0.0.1:9333` |
| `--timeout-ms` | 修改单题最长等待时间，默认 300000（5 分钟） | `--timeout-ms=600000` |
| `--prompt-prefix` | 覆盖 research 全局提问前缀；business 始终忽略该值并原样发送问题 | `--prompt-prefix="请联网搜索并保留参考来源。问题："` |
| `--verbose=true\|false` | research 是否输出详细采集调试日志，默认 `true`；business 始终关闭 | `--verbose=false` |
| `--resolve-titles=false` | 关闭 DeepSeek 文章标题补全 | `npm run crawl:deepseek -- --resolve-titles=false` |
| `--deep-thinking=true\|false` | 设置每题发送前的深度思考状态；豆包、DeepSeek、千问、元宝默认均为 `false`（关闭） | `--deep-thinking=true` |
| `--deep-thinking-unsupported-policy` | 平台不支持时选择 `fail`（默认）或 `allow_degrade` | `--deep-thinking-unsupported-policy=allow_degrade` |
| `--web-search-policy` | 联网条件：`REQUIRED`、`PREFERRED` 或 `DISABLED`；research 未传时保持原行为 | `--web-search-policy=REQUIRED` |
| `--batch-name` | 自定义本次数据库批次名称；默认使用运行时间 | `--batch-name="理想L7调研第一轮"` |
| `--database=false` | 临时关闭 MySQL 入库，仅保留 JSON/CSV 输出 | `npm run crawl -- --database=false` |

参数需要放在 npm 脚本后的 `--` 之后，例如：

```bash
npm run crawl:qianwen -- --questions=questions.json --timeout-ms=600000
```

## 常见问题

### Windows PowerShell 禁止执行 npm.ps1

如果运行 `npm install` 时出现“在此系统上禁止运行脚本”，可为当前用户允许本地脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

确认后关闭并重新打开 PowerShell，再运行 `npm install`。如果电脑受公司或学校的组策略限制，无法修改执行策略，可在当前窗口让 `npm` 直接调用同目录下的 `npm.cmd`：

```powershell
Set-Alias npm npm.cmd
npm install
```

`npm.ps1` 和 `npm.cmd` 都是 npm 的 Windows 启动入口，不影响项目功能。

### 找不到平台标签页或输入框

确认平台是在带 `--remote-debugging-port=9222` 的 Chrome 中打开，页面已经登录并停留在聊天界面。

### 回答完成后找不到引用入口

先确认页面上确实出现了当前题的参考来源入口。程序默认会在每道题前添加“请联网搜索后回答，并提供可点击的参考来源。问题：”。如果页面上已有引用但程序无法识别，通常是平台更新了 DOM class，需要同步调整 `src/platforms.ts` 或 `src/extractReferences.ts`。

### 等待回答超时

默认单题上限为 5 分钟。长回答可改为 10 分钟：

```bash
npm run crawl -- --timeout-ms=600000
```

### 输出中断

单题参考资料缺失不会中断整个平台：程序检查 3 次后会记录“跳过本题”并继续。如果任务真正中断，通常是登录失效、输入框不可用或等待回答完成超时。检查终端最后一条平台日志，修复登录、网络或页面结构问题后重新运行对应平台即可。

## 开发与验证

修改代码后先运行类型检查和完整测试：

```bash
npm run check
npm test
```

测试使用本机 Chrome 的无头模式构造平台 DOM 夹具，覆盖以下关键边界：

- 只抽取当前回答的直接引用子节点；
- 不把历史回答、正文或导航链接当作引用；
- 正确处理豆包重新提问、千问重新生成菜单、DeepSeek 最新“X个网页”和元宝最新来源入口；
- business 同身份批次合并、跨租户/任务/品牌隔离、原样提问和 0 引用不恢复生成；
- 一轮问题完成后正确点击“新建对话”并确认空白输入界面；
- URL 解跳转、跟踪参数清理、内部域名过滤与去重；
- 汇总数据按“平台 → 平台内问题 → 跨平台同题”三阶段清洗。

### 页面改版维护

平台 DOM class 可能随版本变化。页面上已有引用但程序报告入口或容器缺失时，按以下顺序排查：

1. 在 Chrome 开发者工具中确认最新回答的入口、列表和单条卡片结构。
2. 在 `src/platforms.ts` 中更新输入框、发送、新建对话、联网搜索或通用引用入口选择器。
3. 在 `src/extractReferences.ts` 中更新平台专属容器常量和浏览器上下文解析脚本。
4. 在 `tests/doubao-extraction.test.ts` 中增加对应 DOM 夹具，确保仍只读取最新容器的直接子节点。
5. 运行 `npm run check && npm test`，确认全部检查通过后再实际抓取。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 组织多平台任务并写入平台数据与汇总数据 |
| `src/cli.ts` | 解析命令行参数和外部问题文件 |
| `src/crawler.ts` | 平台批量编排，以及可独立调用的 `executeQuestion` 单题采集 |
| `src/deepThinking.ts` | 四平台深度思考状态识别、幂等切换、确认与显式降级策略 |
| `src/webSearch.ts` | 四平台联网状态探测、幂等开启、业务策略和零引用保护 |
| `src/scheduler.ts` | 按品牌、业务组和平台聚合任务的内存批次调度器 |
| `src/conversationManager.ts` | BrandBatch 会话归属、轮换策略和新建对话页面操作 |
| `src/platformExecution.ts` | 四个平台独立串行队列、健康状态、暂停恢复与冷却 |
| `src/browserDiagnostics.ts` | CDP、平台标签页、输入框及页面阻断提示启动自检 |
| `src/workerObservability.ts` | 逐题 JSONL 日志、隐私脱敏和技术失败证据存储 |
| `src/mockRpaWorker.ts` | 本地 JSON/内存任务源、统一结果和模拟执行状态 |
| `src/mockRpaCli.ts` | 连接 CDP 并运行 Mock RPA Worker 的独立 CLI |
| `src/rpaTask.ts` | geno-digital-api RPA 任务与 CollectionTask 稳定模型 |
| `src/rpaDatabase.ts` | 独立的 RPA_DB 环境配置和 MySQL 连接池 |
| `src/rpaTaskRepository.ts` | 待处理查询、业务品牌解析和双状态原子领取 |
| `src/rpaTaskAudit.ts` | 不含 keyword 的仓储查询/领取本地审计 |
| `src/checkRpaTasks.ts` | 默认只读、可显式领取的仓储验证 CLI |
| `src/resultOutbox.ts` | 采集成功结果的原子本地落盘、数据库重放和安全清理 |
| `src/rpaRetryPolicy.ts` | 技术错误、平台暂停、Outbox 与零引用成功的纯重试策略 |
| `src/rpaWorkerService.ts` | 正式 Worker 常驻轮询、退避、信号停止和跨轮询运行时复用 |
| `src/extractReferences.ts` | 提取各平台最终回答，并展开、解析引用列表 |
| `src/platforms.ts` | 平台地址与页面选择器配置 |
| `src/questions.ts` | 默认问题列表 |
| `src/resolveTitles.ts` | DeepSeek 外部文章标题补全 |
| `src/text.ts` | 标题、来源、日期和 URL 的公共清洗规则 |
| `src/output.ts` | 平台分桶、问题分组以及 JSON、CSV 输出 |
| `src/types.ts` | CLI、平台配置、候选记录与输出记录类型 |
| `tests/doubao-extraction.test.ts` | 四个平台回答、引用入口与结构化抽取回归测试 |
| `tests/deepThinking.test.ts` | 四平台深度思考开关 DOM fixture 与不支持策略回归测试 |
| `tests/webSearch.test.ts` | 四平台联网开关、策略降级和监测任务零引用保护测试 |
| `tests/output.test.ts` | 三阶段汇总分组与平台答案文件测试 |
