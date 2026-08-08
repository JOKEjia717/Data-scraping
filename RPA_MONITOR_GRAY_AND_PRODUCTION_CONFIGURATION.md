# RPA 文章监测与风格监测：灰度及正式环境配置指南

> 适用项目：`Data-scraping` / `ai-reference-crawler`
>
> 目标：统一说明文章数据监测 `monitor` 与文章风格监测 `style` 在 Windows 上的灰度、正式配置和上线步骤。
>
> 安全边界：本文不记录数据库真实密码。RPA Worker 只消费 `rpa_task_execution`，不会扫描文章发布表、项目表或其他业务表。

## 1. 三个 Worker 的职责边界

| Worker Role | 业务职责 | 允许领取的业务类型 | Chrome 端口 | Profile | 是否在本文中调整 |
| --- | --- | --- | --- | --- | --- |
| `diagnosis` | 品牌诊断 | `DIAGNOSIS` | `9222` | `.chrome-profiles/diagnosis` | 否，保持现有逻辑和配置 |
| `monitor` | 已发布文章的词条数据监测 | `ENTRY_MONITOR`；旧链路开关开启时可含 `ARTICLE_PROBE` | `9223` | `.chrome-profiles/monitor` | 是 |
| `style` | 文章风格和平台偏好监测 | `CONTENT_STYLE_MONITOR` | `9224` | `.chrome-profiles/style` | 是 |

三个 Worker 必须使用不同的 Chrome 调试端口、Profile、日志、Outbox、指标、证据目录和停止文件。`monitor` 与 `style` 可以并行运行，但同一个 Role 内同一平台仍保持串行，不能让两个同 Role Worker 重复领取同一批任务。

## 2. 后端、数据库与爬虫的职责

完整链路固定为：

```text
Java 后端生成业务任务
    ↓
写入 rpa_task_execution 与 rpa_task_execution_context
    ↓
monitor 只领取 ENTRY_MONITOR
style 只领取 CONTENT_STYLE_MONITOR
    ↓
向 ai_model_id 指定的平台发送 keyword
    ↓
写入 rpa_answer 与 rpa_answer_reference
    ↓
Java 后端回收、分析和汇总结果
```

约束：

- Worker 只轮询 `rpa_task_execution`，不轮询 `brand_article_publish_record`、`probe_article_task` 或项目表。
- `keyword` 是需要提问的词条，不是文章标题。
- `ai_model_id` 决定实际目标 AI 平台，爬虫不自行反推或改写平台。
- 每日次数由 Java 后端生成 execution 保证；爬虫只消费任务，不自行补足每日次数。
- `CONFIRMED_EMPTY` 可以作为合法零引用成功；`UNKNOWN` 不能当成零引用成功。
- URL 标准化、目标文章 URL 对比和最终命中判断继续由 Java 后端完成。

## 3. 公共数据库与安全门禁配置

灰度和正式环境都需要配置以下公共项。将尖括号内容替换为真实值，密码只保存在服务器 `.env` 中。

```env
# RPA 必须连接 Java 后端使用的同一个 geno_digital 数据库。
RPA_DB_HOST=<MySQL地址>
RPA_DB_PORT=3306
RPA_DB_USER=<RPA数据库用户>
RPA_DB_PASSWORD=<真实密码>
RPA_DB_NAME=geno_digital
RPA_DB_CONNECTION_LIMIT=8
RPA_DB_MAX_IDLE=8
RPA_DB_IDLE_TIMEOUT_MS=60000
RPA_DB_QUEUE_LIMIT=50
RPA_DB_CONNECT_TIMEOUT_MS=10000
RPA_DB_ACQUIRE_TIMEOUT_MS=10000
RPA_DB_QUERY_TIMEOUT_MS=15000
RPA_DB_LOCK_QUERY_TIMEOUT_MS=5000
RPA_DB_SSL=false

# 当前连接真实共享/正式库，因此使用 production 双重领取门禁。
RPA_WORKER_ENVIRONMENT=production
RPA_WORKER_ALLOW_PRODUCTION_CLAIMS=true

# 新旧 Worker 通过 provider 隔离，只领取 NEW_RPA。
RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
RPA_WORKER_GRAY_PERCENTAGE=100

RPA_WORKER_RECOVER_STALE=true
RPA_WORKER_RUN_ONCE=false
RPA_WORKER_DATABASE_RETRY_SCHEDULE_ENABLED=false

# 新文章监测不领取旧 ARTICLE_PROBE 存量。
ARTICLE_PROBE_LEGACY_ENABLED=false
```

如果生产 MySQL 强制 TLS，必须同时改为 `RPA_DB_SSL=true` 并配置可信 CA：

```env
RPA_DB_SSL=true
RPA_DB_SSL_CA_PATH=C:/geno-rpa/certs/mysql-ca.pem
```

不要把真实密码写入本文或提交 `.env`。

## 4. 项目 5 灰度配置

### 4.1 monitor：文章数据监测

```env
RPA_MONITOR_WORKER_ID=monitor-worker
RPA_MONITOR_CDP_ENDPOINT=http://127.0.0.1:9223
RPA_MONITOR_CHROME_PROFILE=.chrome-profiles/monitor
RPA_MONITOR_LOG_DIR=rpa-runtime/monitor/logs
RPA_MONITOR_EVIDENCE_DIR=rpa-runtime/monitor/evidence
RPA_MONITOR_OUTBOX_DIR=rpa-runtime/monitor/outbox
RPA_MONITOR_METRICS_DIR=rpa-runtime/monitor/metrics

RPA_MONITOR_DRY_RUN=false
RPA_MONITOR_RUN_ONCE=false
RPA_MONITOR_MAX_TASKS=1
RPA_MONITOR_CANDIDATE_LIMIT=20
RPA_MONITOR_PLATFORMS=doubao,deepseek,qianwen,yuanbao
RPA_MONITOR_WEB_SEARCH_POLICY=REQUIRED
RPA_MONITOR_POLL_INTERVAL_MS=10000
RPA_MONITOR_TASK_INTERVAL_MS=15000
RPA_MONITOR_BATCH_INTERVAL_MS=30000
RPA_MONITOR_PLATFORM_MIN_INTERVAL_MS=15000

ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_SCOPE=GRAY
ENTRY_MONITOR_GRAY_PROJECT_IDS=5
ENTRY_MONITOR_PROJECT_CHUNK_SIZE=1
ENTRY_MONITOR_CONVERSATION_MAX_QUESTIONS=10000
ENTRY_MONITOR_CONVERSATION_MAX_DURATION_MS=86400000
ENTRY_MONITOR_TIMEZONE=Asia/Shanghai
```

### 4.2 style：文章风格偏好监测

当前代码要求开启 `CONTENT_STYLE_MONITOR` 时必须提供至少一个项目 ID。项目 5 灰度配置如下：

```env
RPA_STYLE_WORKER_ID=style-worker
RPA_STYLE_CDP_ENDPOINT=http://127.0.0.1:9224
RPA_STYLE_CHROME_PROFILE=.chrome-profiles/style
RPA_STYLE_LOG_DIR=rpa-runtime/style/logs
RPA_STYLE_EVIDENCE_DIR=rpa-runtime/style/evidence
RPA_STYLE_OUTBOX_DIR=rpa-runtime/style/outbox
RPA_STYLE_METRICS_DIR=rpa-runtime/style/metrics

RPA_STYLE_DRY_RUN=false
RPA_STYLE_RUN_ONCE=false
RPA_STYLE_MAX_TASKS=1
RPA_STYLE_CANDIDATE_LIMIT=20
RPA_STYLE_PLATFORMS=doubao,deepseek,qianwen,yuanbao
RPA_STYLE_WEB_SEARCH_POLICY=REQUIRED
RPA_STYLE_POLL_INTERVAL_MS=10000
RPA_STYLE_TASK_INTERVAL_MS=15000
RPA_STYLE_BATCH_INTERVAL_MS=30000
RPA_STYLE_PLATFORM_MIN_INTERVAL_MS=15000

CONTENT_STYLE_MONITOR_ENABLED=true
CONTENT_STYLE_MONITOR_SCOPE=GRAY
CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS=5
CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE=1
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_QUESTIONS=10000
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_DURATION_MS=86400000
CONTENT_STYLE_MONITOR_TIMEZONE=Asia/Shanghai
```

> `RPA_MONITOR_MAX_TASKS=1` 和 `RPA_STYLE_MAX_TASKS=1` 是每个平台进程的任务选择软上限。为保持同一业务批次和会话连续性，程序不会在批次中间强行截断；实际单轮题数可能高于 1，但不会跨越不允许的项目范围。

## 5. 正式环境配置

### 5.1 正式上线前置条件

文章监测当前已经支持：

```env
ENTRY_MONITOR_SCOPE=GRAY
ENTRY_MONITOR_SCOPE=ALL
```

风格监测当前同样支持：

```env
CONTENT_STYLE_MONITOR_SCOPE=GRAY
CONTENT_STYLE_MONITOR_SCOPE=ALL
```

正式切换前必须确认部署版本已经包含 style 的 `GRAY/ALL` 路由；旧版本仍会要求项目白名单。

### 5.2 monitor 正式全量配置

```env
RPA_MONITOR_DRY_RUN=false
RPA_MONITOR_RUN_ONCE=false
RPA_MONITOR_MAX_TASKS=20
RPA_MONITOR_CANDIDATE_LIMIT=100
RPA_MONITOR_PLATFORMS=doubao,deepseek,qianwen,yuanbao
RPA_MONITOR_WEB_SEARCH_POLICY=REQUIRED
RPA_MONITOR_POLL_INTERVAL_MS=10000
RPA_MONITOR_TASK_INTERVAL_MS=15000
RPA_MONITOR_BATCH_INTERVAL_MS=30000
RPA_MONITOR_PLATFORM_MIN_INTERVAL_MS=15000

ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_SCOPE=ALL
ENTRY_MONITOR_GRAY_PROJECT_IDS=
ENTRY_MONITOR_PROJECT_CHUNK_SIZE=5
ENTRY_MONITOR_CONVERSATION_MAX_QUESTIONS=10000
ENTRY_MONITOR_CONVERSATION_MAX_DURATION_MS=86400000
ENTRY_MONITOR_TIMEZONE=Asia/Shanghai
```

规则：

- `ENTRY_MONITOR_SCOPE=ALL` 时项目白名单必须为空。
- `RPA_WORKER_GRAY_PERCENTAGE` 必须为 `100`。
- `ALL` 仅取消项目 ID 过滤，不取消业务类型、provider、状态、上海自然日、dispatch 和上下文校验。
- `ALL` 不是扫描发布文章表，而是消费全部合法的 `ENTRY_MONITOR` execution。

### 5.3 style 正式全量配置

```env
RPA_STYLE_DRY_RUN=false
RPA_STYLE_RUN_ONCE=false
RPA_STYLE_MAX_TASKS=20
RPA_STYLE_CANDIDATE_LIMIT=100
RPA_STYLE_PLATFORMS=doubao,deepseek,qianwen,yuanbao
RPA_STYLE_WEB_SEARCH_POLICY=REQUIRED
RPA_STYLE_POLL_INTERVAL_MS=10000
RPA_STYLE_TASK_INTERVAL_MS=15000
RPA_STYLE_BATCH_INTERVAL_MS=30000
RPA_STYLE_PLATFORM_MIN_INTERVAL_MS=15000

CONTENT_STYLE_MONITOR_ENABLED=true
CONTENT_STYLE_MONITOR_SCOPE=ALL
CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS=
CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE=5
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_QUESTIONS=10000
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_DURATION_MS=86400000
CONTENT_STYLE_MONITOR_TIMEZONE=Asia/Shanghai
```

规则与文章监测一致：`ALL` 必须清空项目白名单并保持灰度百分比为 100；它只取消项目过滤，
不会取消 `CONTENT_STYLE_MONITOR`、`NEW_RPA`、状态、自然日、dispatch 和完整上下文校验。

### 5.4 正式环境首轮限流

第一次从项目 5 切换到正式范围时，不要立刻使用最终值 `20`，先配置：

```env
RPA_MONITOR_MAX_TASKS=5
RPA_STYLE_MAX_TASKS=5
```

至少观察一个完整批次，确认平台风控、任务成功率、Outbox 和后端回收正常后，再分别提升为：

```env
RPA_MONITOR_MAX_TASKS=20
RPA_STYLE_MAX_TASKS=20
```

## 6. Windows 操作命令

以下命令均在爬虫项目根目录执行，例如：

```powershell
Set-Location C:\Users\xu\Desktop\data\Data-scraping
```

### 6.1 备份与切换 `.env`

修改前备份：

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item .env ".env.$stamp.bak"
```

如果分别保存了灰度和正式配置：

```powershell
# 切换到灰度配置
Copy-Item .env.gray .env -Force

# 切换到正式配置
Copy-Item .env.production .env -Force
```

`.env`、`.env.gray` 和 `.env.production` 都包含连接信息，必须保持在 `.gitignore` 中。

### 6.2 启动 monitor 和 style Chrome

分别在两个 PowerShell 窗口启动：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9223 `
  "--user-data-dir=$PWD\.chrome-profiles\monitor"
```

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9224 `
  "--user-data-dir=$PWD\.chrome-profiles\style"
```

如果 Chrome 安装在当前用户目录，将程序路径替换为：

```powershell
$env:LOCALAPPDATA + "\Google\Chrome\Application\chrome.exe"
```

在两个 Chrome 中分别打开豆包、DeepSeek、千问、元宝页面并完成登录。两个 Chrome 不能共用 Profile。

### 6.3 检查调试端口

```powershell
Invoke-RestMethod http://127.0.0.1:9223/json/version
Invoke-RestMethod http://127.0.0.1:9224/json/version
```

### 6.4 Worker 健康检查

健康检查不会领取任务：

```powershell
npm.cmd run rpa:monitor:health
npm.cmd run rpa:style:health
```

只有数据库、CDP、平台标签页、登录状态、输入框和配置校验全部通过后，才进入任务检查。

### 6.5 只读任务检查

```powershell
npm.cmd run rpa:tasks:check -- --worker=monitor --limit=20
npm.cmd run rpa:tasks:check -- --worker=style --limit=20
```

不要添加 `--claim=true`。灰度阶段必须确认：

- monitor 候选任务为 `businessType=ENTRY_MONITOR`、`projectId=5`。
- style 候选任务为 `businessType=CONTENT_STYLE_MONITOR`、`projectId=5`。
- `ai_model_id` 与候选任务显示的平台一致。

### 6.6 启动 Worker

分别在独立 PowerShell 窗口运行：

```powershell
npm.cmd run rpa:monitor
```

```powershell
npm.cmd run rpa:style
```

### 6.7 安全停止 Worker

不要直接关闭终端或强杀 Node 进程。创建停止请求：

```powershell
powershell.exe -ExecutionPolicy Bypass `
  -File .\scripts\windows\request-rpa-worker-stop.ps1 `
  -Worker monitor
```

```powershell
powershell.exe -ExecutionPolicy Bypass `
  -File .\scripts\windows\request-rpa-worker-stop.ps1 `
  -Worker style
```

等待对应终端输出 `WORKER_SUMMARY` 并退出后，才修改 `.env` 或 Chrome Profile。

准备重新启动时，确认旧 Worker 已退出，再清除停止请求：

```powershell
Remove-Item .\rpa-runtime\monitor\stop.request -ErrorAction SilentlyContinue
Remove-Item .\rpa-runtime\style\stop.request -ErrorAction SilentlyContinue
```

然后重新运行健康检查和任务只读检查。

## 7. 灰度验收清单

- [ ] monitor 健康检查通过，连接 `9223`。
- [ ] style 健康检查通过，连接 `9224`。
- [ ] 两个 Worker 使用不同 Profile、日志、Outbox、指标和停止文件。
- [ ] monitor 只看到项目 5 的 `ENTRY_MONITOR`。
- [ ] style 只看到项目 5 的 `CONTENT_STYLE_MONITOR`。
- [ ] 两个 Worker 都没有领取 `DIAGNOSIS`。
- [ ] 爬虫发送的是 execution 的 `keyword`，不是文章标题。
- [ ] execution 的 `ai_model_id` 与实际执行平台一致。
- [ ] execution 状态正常经过 `0 → 1 → 2`；最终技术失败为 `3`。
- [ ] `rpa_answer` 正确写入回答正文。
- [ ] 有引用时全部写入 `rpa_answer_reference`。
- [ ] 确认无引用可以正常成功，不将其误判为爬虫失败。
- [ ] Outbox 没有持续积压或损坏文件。
- [ ] Java 后端可以正常回收两类 execution。
- [ ] 品牌诊断 Worker、Chrome、任务、对话和结果没有变化。
- [ ] 项目 5 至少稳定运行一个完整上海自然日。

## 8. 正式上线清单

1. 发布同时支持 `ENTRY_MONITOR_SCOPE` 与 `CONTENT_STYLE_MONITOR_SCOPE` 的爬虫版本。
2. 保持项目 5 灰度至少一个完整上海自然日。
3. 安全停止 monitor 和 style，等待两个 `WORKER_SUMMARY`。
4. 备份当前 `.env`。
5. 设置 `ENTRY_MONITOR_SCOPE=ALL` 并清空文章项目白名单。
6. 设置 `CONTENT_STYLE_MONITOR_SCOPE=ALL` 并清空风格项目白名单。
7. 将两个 `MAX_TASKS` 暂时设置为 `5`。
8. 清除两个已确认完成的 `stop.request`。
9. 分别执行 monitor 和 style 健康检查。
10. 分别执行只读任务检查，确认能看到全部合法项目且业务类型没有混淆。
11. 启动 monitor，再启动 style，分别观察日志、指标和平台风控。
12. 稳定后将两个 `MAX_TASKS` 分别提升到 `20`。
13. 异常时只停止对应 Worker，不影响另一个 Worker和品牌诊断。

## 9. 禁止事项

- 不要让 monitor 和 style 共用 Chrome 端口或 Profile。
- 不要让 RPA 扫描发布文章表、项目表或 probe 业务表。
- 不要让爬虫自行补每日执行次数。
- 不要在旧版 style Worker 上使用 `ALL` 或清空风格项目白名单。
- 不要在 `ALL` 模式下继续保留项目白名单。
- 不要关闭 provider 路由后直接运行新旧两套 RPA。
- 不要把真实数据库密码提交到 Git 或写入本文。
- 不要通过强杀进程代替 `stop.request` 安全停止。
