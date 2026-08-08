# 爬虫程序：风格监测补齐与独立 Style Worker 改造清单

> 适用项目：`/Users/joke/Desktop/爬虫`
>
> 本文只整理当前最新版爬虫仍需新增或修改的内容，不重复已经具备的任务模型、execution context 查询、AI 平台映射、联网搜索、回答提取、引用提取、Outbox 和结果回写能力。
>
> 本文内容全部属于爬虫程序改造。Java 后端已经负责为 `CONTENT_STYLE_MONITOR` 创建 `rpa_task_execution_context`，不需要为了独立 Style Worker 再修改业务链路。

## 一、目标运行架构

新增第三个独立运行角色 `style`，三个 Worker 的任务边界固定如下：

| Worker | 专用 Chrome | 允许领取的 `business_type` |
|---|---|---|
| `diagnosis` | 品牌诊断 Chrome | `DIAGNOSIS` |
| `monitor` | 数据监测 Chrome | `ARTICLE_PROBE`、`ENTRY_MONITOR` |
| `style` | 风格监测 Chrome | `CONTENT_STYLE_MONITOR` |

必须保证 `monitor` 和 `style` 不会同时领取 `CONTENT_STYLE_MONITOR`。独立 Chrome 的意义不仅是界面隔离，还包括任务查询、平台锁、运行目录、会话和故障恢复全部隔离。

建议端口：

```text
品牌诊断 Chrome：9222
数据监测 Chrome：9223
风格监测 Chrome：9224
```

每个 Chrome 可以分别保留豆包、DeepSeek、元宝、千问页面。现有 Fleet 架构仍可按平台启动四个子进程，并让四个子进程连接同一个角色专用 Chrome。

## 二、P0：新增独立 Style Worker 角色

### 为什么修改

当前 `RpaWorkerType` 只有 `diagnosis` 和 `monitor`。`CONTENT_STYLE_MONITOR` 被预留在 `monitor` 中，无法真正独占第三个 Chrome，也无法和数据监测形成严格的任务边界。

### 怎么修改

建议引入“运行角色”和“底层任务类别”两个概念：

```ts
type RpaWorkerRole = "diagnosis" | "monitor" | "style";
type RpaWorkerType = "diagnosis" | "monitor";
```

其中：

```text
role=diagnosis -> workerType=diagnosis
role=monitor   -> workerType=monitor
role=style     -> workerType=monitor
```

业务类型白名单必须由 `role` 决定：

```ts
function businessTypesForWorkerRole(role: RpaWorkerRole): RpaBusinessType[] {
  if (role === "diagnosis") return ["DIAGNOSIS"];
  if (role === "monitor") return ["ARTICLE_PROBE", "ENTRY_MONITOR"];
  return ["CONTENT_STYLE_MONITOR"];
}
```

这样可以复用 monitor 的上下文任务查询能力，同时避免把大量 `workerType === "monitor"` 的旧判断直接扩成第三种语义。

### 主要修改文件

- `src/rpaWorkerCli.ts`：允许 `--worker=style`，并解析为独立 Role。
- `src/rpaWorkerConfig.ts`：保存 `workerRole`，增加 `RPA_STYLE_*` 配置前缀。
- `src/rpaTask.ts`：增加按 Role 返回业务类型白名单的方法。
- `src/rpaTaskRepository.ts`：查询、领取和状态统计严格使用当前 Role 白名单。
- `src/rpaWorkerState.ts`：心跳、僵尸任务查询和恢复严格限定当前 Role 的业务类型。
- `src/rpaWorkerFleetCli.ts`、`src/rpaWorkerFleet.ts`：将 Role 透传给平台子进程。

### 验收标准

- `diagnosis` 查询不到任何 monitor 任务。
- `monitor` 查询不到 `CONTENT_STYLE_MONITOR`。
- `style` 只能查询和领取 `CONTENT_STYLE_MONITOR`。
- 三个 Worker 同时运行时不会交叉领取任务。

## 三、P0：为 Style Worker 配置独立 Chrome 和运行资源

### 为什么修改

三个 Worker 如果共享 CDP、Chrome Profile、Outbox 或运行目录，会出现页面串用、结果文件冲突、监控混淆和错误恢复到其他业务窗口的问题。

### 新增配置

```env
RPA_STYLE_WORKER_ID=style-worker
RPA_STYLE_CDP_ENDPOINT=http://127.0.0.1:9224
RPA_STYLE_CHROME_PROFILE=/absolute/path/to/chrome-profiles/style
RPA_STYLE_LOG_DIR=/absolute/path/to/rpa-runtime/style/logs
RPA_STYLE_EVIDENCE_DIR=/absolute/path/to/rpa-runtime/style/evidence
RPA_STYLE_OUTBOX_DIR=/absolute/path/to/rpa-runtime/style/outbox
RPA_STYLE_METRICS_DIR=/absolute/path/to/rpa-runtime/style/metrics
RPA_STYLE_DRY_RUN=true
RPA_STYLE_MAX_TASKS=20
RPA_STYLE_PLATFORMS=doubao,deepseek,qianwen,yuanbao
RPA_STYLE_WEB_SEARCH_POLICY=REQUIRED
```

风格监测自身配置：

```env
CONTENT_STYLE_MONITOR_ENABLED=false
CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS=5
CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE=5
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_QUESTIONS=10000
CONTENT_STYLE_MONITOR_CONVERSATION_MAX_DURATION_MS=86400000
CONTENT_STYLE_MONITOR_TIMEZONE=Asia/Shanghai
```

### 资源冲突校验

扩展 `validateDistinctWorkerResources()`，对三个 Worker 做两两校验，以下值不能相同：

- Worker ID
- CDP Endpoint
- Chrome Profile
- Outbox 目录
- Metrics 目录
- Log 目录
- Evidence 目录
- Shutdown/Control 目录

默认目录建议为：

```text
.chrome-profiles/style
rpa-runtime/style/logs
rpa-runtime/style/evidence
rpa-runtime/style/outbox
rpa-runtime/style/metrics
rpa-runtime/style/stop.request
```

### 验收标准

- Style Worker 默认连接 `http://127.0.0.1:9224`。
- 任意两个 Worker 使用相同 CDP、Profile、Outbox 或 Metrics 时启动失败。
- Style Worker 重启、Outbox 回放和浏览器重连不会读取 diagnosis/monitor 的运行数据。

## 四、P0：修改平台锁维度

### 为什么修改

当前平台锁名称主要按照：

```text
workerType × platform
```

生成。如果 Style Worker 底层仍属于 `monitor`，它会和数据监测竞争相同的平台锁，即使两者连接不同 Chrome，也无法真正并行。

### 怎么修改

平台锁改为按 Worker Role 隔离：

```text
geno-rpa-platform:diagnosis:doubao
geno-rpa-platform:monitor:doubao
geno-rpa-platform:style:doubao
```

建议接口：

```ts
function platformLeaseName(
  workerRole: RpaWorkerRole,
  platformId: PlatformId
): string;
```

执行级别的锁继续使用：

```text
geno-rpa-exec:{executionId}
```

execution 锁不能加入 Role，因为它是阻止同一数据库任务被重复执行的最后一道保护。

### 验收标准

- monitor 豆包和 style 豆包可以同时持有各自平台锁。
- 同一个 execution 仍只能被一个进程持有。
- 同一 Role、同一平台仍保持串行，不能在同一平台穿插不同项目。

## 五、P0：放开 `CONTENT_STYLE_MONITOR` 启动保护

### 当前问题

当前配置即使设置：

```env
CONTENT_STYLE_MONITOR_ENABLED=true
```

也会主动抛出“通用 execution context 尚未完成”的异常。

### 怎么修改

完成本文其他 P0 项及自动化测试后，删除该固定异常，但保留以下安全门禁：

- 只有 `style` Role 可以启用 `CONTENT_STYLE_MONITOR`。
- 必须开启 `provider-routing-enabled`。
- 必须配置至少一个风格监测灰度项目 ID。
- 生产环境领取必须显式设置 `allow-production-claims=true`。
- Style Chrome 资源不得与其他 Worker 冲突。

禁止只删除异常然后直接打开开关，因为当前持久化对话和灰度逻辑仍没有完整覆盖 `CONTENT_STYLE_MONITOR`。

## 六、P0：把 ENTRY 专用会话仓储改成通用上下文监测会话仓储

### 当前问题

`src/entryMonitorConversationRepository.ts` 中的 SQL 写死：

```sql
business_type = 'ENTRY_MONITOR'
```

因此即使后端已经提供风格任务上下文，风格任务仍无法通过 `rpa_conversation_session` 恢复自己的项目对话。

### 怎么修改

将仓储泛化为类似：

```ts
interface ContextualMonitorConversationKey {
  businessType: "ENTRY_MONITOR" | "CONTENT_STYLE_MONITOR";
  tenantId: string;
  projectId: string;
  aiModelId: string;
  platformId: PlatformId;
  monitorDate: string;
}
```

SQL 的查询、插入、更新、计数、失效和跨日关闭全部使用参数化 `businessType`，不能通过字符串拼接 SQL。

对话的完整隔离键为：

```text
业务类型 × 租户 × 项目 × AI平台 × 上海自然日
```

在 Style Worker 内部，对用户表现出的业务规则仍是：

```text
一个项目 × 一个AI平台 × 一个自然日 = 一个对话
```

额外加入业务类型是为了防止数据监测问题和风格监测问题进入同一段平台对话。

### 兼容要求

- 现有 `ENTRY_MONITOR` 的 `rpa_conversation_session` 数据继续可读。
- 不需要清空或迁移现有 ENTRY 会话。
- 新建风格会话时写入 `business_type = 'CONTENT_STYLE_MONITOR'`。
- 品牌诊断不得读取 `rpa_conversation_session`。

## 七、P0：让风格任务完整进入持久化对话执行链

### 当前问题

`src/rpaWorker.ts` 中的以下能力大量只判断：

```ts
task.businessType === "ENTRY_MONITOR"
```

如果仅放开 Style 开关，风格任务会进入普通批次逻辑，可能在批次结束后创建新对话，无法保持项目、平台、自然日维度的连续对话。

### 怎么修改

将适用于两种上下文监测任务的判断统一为：

```ts
isContextualMonitorTask(task)
```

必须覆盖：

1. execution context 严格校验。
2. 上海自然日校验。
3. `rpa_conversation_session` 查询和对话 URL 恢复。
4. 页面 Conversation Owner 写入。
5. DOM 用户/助手消息基线保存。
6. `PREPARED -> SUBMITTING -> SUBMITTED -> ANSWER_READY -> PERSISTED` 状态迁移。
7. 回答归属和中断恢复判断。
8. 对话 URL 更新。
9. 成功后 `question_count` 幂等累加。
10. 批次结束后保留对话，不创建空白新对话。
11. 跨日关闭会话。
12. 歧义恢复时停止执行，不能重新发送相同问题。

审计日志和错误信息需要携带真实 `businessType`，不能继续全部写成 `ENTRY_MONITOR_*`。

### 验收标准

- 同项目、同平台、同一天的多个风格任务只创建一个对话。
- 下一项目创建新对话。
- 第二天创建新对话。
- ENTRY 与 CONTENT_STYLE 即使项目、平台、日期相同，也不会共用对话。
- 相同 keyword 执行多次时，回答仍按 execution ID 准确归属。

## 八、P0：修复 Style Worker 项目灰度过滤

### 当前问题

当前 `taskInGrayScope()` 只对 `ENTRY_MONITOR` 使用项目白名单；`CONTENT_STYLE_MONITOR` 会落入普通品牌/业务任务灰度规则。

### 怎么修改

增加风格监测专用判断：

```ts
if (task.businessType === "CONTENT_STYLE_MONITOR") {
  if (!task.projectId) return false;
  if (!config.contentStyleMonitorGrayProjectIds.includes(task.projectId)) {
    return false;
  }
  return percentageScope(
    `${task.businessType}:${task.projectId}`,
    config.grayPercentage
  );
}
```

风格灰度必须以 `projectId` 为准，不能使用 cycle ID、dispatch ID、品牌 ID 或 execution ID。

### 验收标准

- 白名单外项目不会进入候选批次。
- 白名单内项目可以被 Style Worker 查询和领取。
- monitor 和 diagnosis 的原有灰度规则保持不变。

## 九、P1：增加风格任务批次切片配置

### 当前问题

当前只有 `ENTRY_MONITOR` 使用项目小批次；`CONTENT_STYLE_MONITOR` 会使用普通批次上限，最多可能一次读取 1000 条。

### 怎么修改

新增：

```env
CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE=5
```

规划批次时使用：

```ts
const batchLimit = task.businessType === "CONTENT_STYLE_MONITOR"
  ? config.contentStyleMonitorProjectChunkSize
  : ...;
```

同一风格批次必须满足：

```text
同一业务类型
同一租户
同一项目
同一AI平台
同一上海自然日
```

切片只控制单次处理数量，不改变对话归属。下一批仍应恢复同一个项目、平台、自然日对话。

## 十、P1：增加命令和 Windows 运维脚本

### package.json

新增：

```json
{
  "rpa:style": "tsx src/rpaWorkerFleetCli.ts --worker=style",
  "rpa:style:single": "tsx src/rpaWorkerCli.ts --worker=style",
  "rpa:style:health": "tsx src/rpaWorkerCli.ts --worker=style --health-check=true"
}
```

### Windows 脚本

以下脚本增加 `style`：

- `scripts/windows/run-rpa-worker.ps1`
- `scripts/windows/install-rpa-worker-tasks.ps1`
- `scripts/windows/request-rpa-worker-stop.ps1`

安装选项建议支持：

```text
diagnosis
monitor
style
all
```

任务计划程序中新增：

```text
Geno RPA Diagnosis
Geno RPA Monitor
Geno RPA Style
```

Style 任务必须使用 `rpa:style`，不能通过复制一个 `rpa:monitor` 任务代替。

## 十一、P1：增加 Style Worker 专项测试

至少增加以下测试：

1. `style` 只查询和领取 `CONTENT_STYLE_MONITOR`。
2. `monitor` 不再查询和领取 `CONTENT_STYLE_MONITOR`。
3. `diagnosis` 行为完全不变。
4. 三个 Worker 的 CDP、Profile、Outbox、Metrics 不能重复。
5. style 与 monitor 的平台锁不同。
6. 同项目、平台、自然日的风格任务复用同一对话。
7. ENTRY 和 CONTENT_STYLE 不共用对话。
8. 风格任务在发送前再次校验上海自然日。
9. 跨过上海 00:00 后旧风格任务不再发送。
10. `repetitionNo` 不连续或相同 keyword 多次执行时不会混淆回答。
11. 对话恢复时页面 Owner 与 execution ID 不一致会安全失败。
12. 回答和全部引用正确写入数据库。
13. Outbox 回放保留 `businessType = CONTENT_STYLE_MONITOR`。
14. Style Worker 只恢复自己的僵尸 execution。
15. 全部现有品牌诊断测试继续通过。

## 十二、不需要重复修改的现有能力

以下能力当前源码已经具备，应直接复用：

- `CONTENT_STYLE_MONITOR` 任务类型定义。
- `rpa_task_execution` 唯一任务轮询入口。
- `rpa_task_execution_context` JOIN 查询。
- `projectId`、`intentEntryId`、`monitorDate`、`repetitionNo` 映射。
- `ai_model_id` 到豆包、DeepSeek、元宝、千问的映射。
- 原子领取 execution。
- execution 心跳和执行锁。
- monitor 业务强制联网搜索。
- 回答正文提取。
- 引用 URL 和引用内容提取。
- `rpa_answer`、`rpa_answer_reference` 结果写入。
- Result Outbox 和失败回放。
- `businessType` 结果一致性校验。

不要让 Style Worker 读取 `content_style_monitor_*` 业务表。Style Worker 仍然只领取 `rpa_task_execution`，业务上下文统一来自 `rpa_task_execution_context`。

## 十三、改造后的执行链路

```text
Java 后端创建 CONTENT_STYLE_MONITOR cycle/sample
        ↓
Java 后端创建 rpa_task_execution
        ↓
Java 后端同步写入 rpa_task_execution_context
        ↓
Style Worker 只查询 CONTENT_STYLE_MONITOR execution
        ↓
读取 projectId、monitorDate、repetitionNo、aiModelId
        ↓
按“业务类型 × 项目 × 平台 × 自然日”恢复或创建对话
        ↓
向 ai_model_id 对应的平台发送 keyword
        ↓
提取回答正文及全部引用
        ↓
写入 rpa_answer / rpa_answer_reference
        ↓
更新 rpa_task_execution 为成功
        ↓
Java 后端抓取引用文章并调用 LLM 分析文章风格
        ↓
Java 后端生成平台风格偏好和 Agent 报告
```

## 十四、推荐上线顺序

1. 完成 Style Worker Role、任务白名单和独立资源配置。
2. 完成通用上下文监测会话仓储。
3. 完成风格任务持久化对话执行链。
4. 完成项目灰度和批次切片。
5. 完成平台锁隔离。
6. 运行 TypeScript 检查和全部自动化测试。
7. 发布已经会写风格 execution context 的 Java 后端。
8. 按安全脚本补偿当天仍可执行的风格任务上下文。
9. 启动端口为 9224 的 Style Chrome，并准备四个平台页面。
10. 运行 `npm run rpa:style:health`。
11. 保持 `dry-run=true`，检查候选任务只包含灰度项目。
12. 设置 `CONTENT_STYLE_MONITOR_ENABLED=true` 并仅放行一个项目。
13. 使用 `run-once=true` 先执行一小批真实任务。
14. 核对对话复用、回答、引用、execution 状态和后端风格报告。
15. 验证稳定后逐步扩大灰度范围。

## 十五、最终验收标准

- 品牌诊断、数据监测、风格监测分别使用独立 Chrome。
- Style Worker 只领取 `CONTENT_STYLE_MONITOR`。
- monitor Worker 不会抢风格监测任务。
- 风格对话按项目、AI 平台、上海自然日复用。
- 不同业务类型、不同项目、不同平台、不同自然日绝不共用对话。
- 四个平台可以并行，同一平台内部保持串行。
- 同一个 execution 不会被重复领取或重复发送。
- 风格回答和引用能正确写回，并被 Java 后端继续分析。
- 任意 Style Worker 故障不会影响品牌诊断 Worker。
- 所有现有品牌诊断测试保持通过，品牌诊断业务逻辑没有改动。
