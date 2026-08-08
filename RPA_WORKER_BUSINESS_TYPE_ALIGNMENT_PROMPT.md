# 爬虫程序：RPA 执行类型与文章数据监测对齐实施提示词

> 本文档用于交给另一个 Codex，指导其对 `/Users/joke/Desktop/爬虫` 做增量修改。
>
> 目标：对齐 Java 后端最新的 RPA 执行协议，让正式文章数据监测只按发布文章的目标 AI 平台执行，同时兼容品牌诊断、内容风格监测和历史 `ARTICLE_PROBE`。
>
> 本文档生成时只进行了源码和数据库只读分析，没有修改爬虫源码、Java 源码或数据库。

---

## 一、任务目标

请根据当前真实源码，增量修改：

```text
/Users/joke/Desktop/爬虫
```

需要完成的最终协议是：

```text
business_type 决定执行哪一种业务流程
ai_model_id / ai_model_name 决定实际访问哪个 AI 平台
keyword 决定向目标 AI 平台发送什么内容
rpa_task_execution_context 决定项目、词条、自然日、重复序号和对话归属
```

正式支持四种业务类型：

| business_type | 平台来源 | Worker | 状态 |
|---|---|---|---|
| `DIAGNOSIS` | 品牌诊断启用平台 | diagnosis Worker | 保留原逻辑 |
| `CONTENT_STYLE_MONITOR` | 词条配置平台 | monitor Worker | 保留并补齐协议 |
| `ENTRY_MONITOR` | 成功发布文章的目标平台 | monitor Worker | 正式文章数据监测 |
| `ARTICLE_PROBE` | 历史全平台文章监测 | monitor Worker | 只兼容存量，停止新增 |

---

## 二、绝对禁止事项

### 2.1 不得修改品牌诊断业务逻辑

不得改变以下行为：

- `DIAGNOSIS` 的任务生成规则；
- diagnosis Worker 的任务范围；
- 品牌诊断的平台配置；
- 品牌诊断的品牌批次规则；
- 品牌诊断的对话创建规则；
- 品牌诊断的提问顺序；
- 品牌诊断的重试、恢复和结果写入语义；
- 品牌诊断现有页面适配和引用提取逻辑。

允许的品牌诊断相关修改只能是协议适配，例如：

```text
读取 rpa_task_execution.business_type
验证其值为 DIAGNOSIS
验证其与 dispatch.business_type 一致
```

不能借本次改造重构或改变品牌诊断行为。

### 2.2 爬虫不得反查文章平台

爬虫不得新增以下逻辑：

```text
查询 brand_article_publish_record
查询 brand_article_draft.platform
查询 brand_article_intent_entry
查询 probe_article_target
根据文章重新推导目标 AI 平台
覆盖 rpa_task_execution.ai_model_id
```

Java 后端已经负责：

```text
成功发布记录
→ article_draft_id
→ brand_article_draft.platform
→ 解析成 ai_model_id/name
→ 创建 probe_article_sample
→ 创建 rpa_task_execution
```

爬虫必须信任经过校验的：

```text
rpa_task_execution.ai_model_id
rpa_task_execution.ai_model_name
```

### 2.3 不得把空 business_type 默认成 ENTRY_MONITOR

禁止：

```sql
COALESCE(e.business_type, 'ENTRY_MONITOR')
```

历史空值只能通过它实际关联的：

```text
rpa_task_execution.task_id
→ brand_rpa_dispatch_task.id
→ brand_rpa_dispatch_task.business_type
```

进行兼容，不能凭空归类。

### 2.4 不得直接批量恢复历史失败 dispatch

不得将所有：

```text
brand_rpa_dispatch_task.status = FAILED
```

直接批量改成：

```text
DISPATCHED
```

历史任务中包含平台修正前生成的错误任务，必须先核对业务有效性。

### 2.5 不得直接执行生产迁移或修复 SQL

可以创建迁移文件、校验脚本和修复方案，但在没有用户明确授权前：

- 不执行生产数据库结构变更；
- 不批量更新业务数据；
- 不修改历史成功结果；
- 不删除 execution、answer、reference 或 dispatch。

---

## 三、当前真实后端协议

后端计划来源：

```text
/Users/joke/Downloads/PLAN.md
```

### 3.1 ENTRY_MONITOR 平台已经从文章反推

Java 当前实现已经完成：

```text
brand_article_publish_record.article_draft_id
→ brand_article_draft.platform
→ AiEngineEnum.fromArticlePlatform(...)
→ ProbeArticleTargetDO.aiModelId
→ ProbeArticleSampleDO.aiModelId
→ RpaTaskExecutionDO.aiModelId
```

平台映射：

| 文章 platform | ai_model_id | ai_model_name |
|---|---:|---|
| `doubao` | 1 | 豆包 |
| `deepseek` | 2 | DeepSeek |
| `yuanbao` | 3 | 元宝 |
| `qwen` / `qianwen` | 4 | 千问 |

同一词条、同一文章平台的多篇文章共享查询样本；Java 聚合这些文章的成功发布 URL。

### 3.2 Java 已开始写 execution.business_type

Java 数据对象已经增加：

```java
private String businessType;
```

Java 创建 execution 时已经分别写入：

```text
DIAGNOSIS
CONTENT_STYLE_MONITOR
ENTRY_MONITOR
ARTICLE_PROBE（仅历史路径）
```

### 3.3 URL 匹配已经按平台隔离

Java 对 `ENTRY_MONITOR` 结果进行匹配时，只允许：

```text
sample.ai_model_id = target.ai_model_id
```

的回答引用与文章 URL 比较。

爬虫只负责返回回答正文和引用 URL，不负责判断曝光。

---

## 四、当前真实爬虫缺口

当前爬虫代码基线：

```text
/Users/joke/Desktop/爬虫
```

已具备：

- `DIAGNOSIS`；
- 历史 `ARTICLE_PROBE`；
- 带开关的 `ENTRY_MONITOR`；
- `ai_model_id` 到四个平台的正确映射；
- 项目 × 平台 × 上海自然日的 ENTRY 对话归属；
- 单题执行、回答正文提取、引用提取；
- `rpa_answer` 与 `rpa_answer_reference` 事务写入；
- Outbox、重试、stale recovery 和页面恢复；
- 引用未知保护；
- Provider 路由。

尚未具备或尚未对齐：

1. `RpaBusinessType` 不包含 `CONTENT_STYLE_MONITOR`；
2. 查询的业务类型仍主要来自 `brand_rpa_dispatch_task.business_type`；
3. 原子领取没有校验 execution 自身类型；
4. stale recovery 和指标仍硬编码有限的业务类型；
5. ENTRY 对话仓储硬编码 `ENTRY_MONITOR`；
6. `CONTENT_STYLE_MONITOR` 没有正式任务模型和执行分支；
7. 检查命令与正式 Worker 的 ENTRY 配置曾存在不一致风险；
8. 当前 `.env` 未开启 `ENTRY_MONITOR_ENABLED`；
9. 当前数据库尚未创建 `rpa_task_execution.business_type`。

---

## 五、当前数据库快照风险

以下结论来自 2026-08-08 的只读检查，执行任何修复前必须重新查询确认。

### 5.1 当前数据库没有 execution.business_type

当前爬虫 `.env` 所连接数据库的：

```text
rpa_task_execution
```

尚不存在：

```text
business_type
```

因此新版 Java 源码已经准备写入该字段，但数据库协议尚未完成。

这是部署新版 Java 和新版爬虫前的硬阻塞。

### 5.2 当前仍存在平台修正前的旧任务

只读检查发现仍有 4 条 `DISPATCHED + pending` 的旧 `ENTRY_MONITOR`：

| executionId | ai_model_id | 平台 |
|---:|---:|---|
| 1293 | 1 | 豆包 |
| 1294 | 4 | 千问 |
| 1295 | 2 | DeepSeek |
| 1296 | 3 | 元宝 |

这些任务是在文章平台修正前生成的全平台任务。

如果直接开启 ENTRY Worker，它们可能被领取。

不要原地把 2、3、4 改成 1，因为会造成重复序号、重复执行和历史审计失真。

### 5.3 FAILED dispatch 下还有大量任务

只读快照中还存在：

```text
ENTRY_MONITOR：120 条 pending execution 位于 FAILED dispatch
CONTENT_STYLE_MONITOR：1215 条 pending execution 位于 FAILED dispatch
```

由于 dispatch 不是 `DISPATCHED`，正式 Worker 当前不应领取。

这些任务不能批量恢复，必须先判断对应周期、自然日、平台和父任务是否仍然有效。

---

## 六、实施优先级

### P0：ENTRY_MONITOR 正式运行前必须完成

1. 增加 `rpa_task_execution.business_type` 迁移；
2. 回填并验证历史 execution 类型；
3. 爬虫读取 execution 类型并校验 dispatch 类型；
4. 原子领取同时校验两处类型；
5. stale recovery 同时校验两处类型；
6. 隔离旧错误平台任务；
7. 修复检查命令与正式 Worker 配置一致性；
8. 完成测试后再开启项目灰度。

### P1：完整支持后端计划

1. 增加 `CONTENT_STYLE_MONITOR` 类型；
2. 补齐风格监测通用 execution context；
3. 通用化监测对话仓储；
4. 加入联网、指标、恢复、Mock 和测试；
5. 在独立开关下灰度。

### P2：ARTICLE_PROBE 退役

1. 保留存量查询和结果写回；
2. 增加存量数量指标；
3. 存量清零后关闭领取；
4. 不删除历史代码、记录和展示能力。

---

## 七、数据库迁移

在爬虫仓库的：

```text
/Users/joke/Desktop/爬虫/migrations
```

新增成对迁移文件，名称使用实际时间戳，例如：

```text
migrations/20260808_rpa_execution_business_type.up.sql
migrations/20260808_rpa_execution_business_type.down.sql
```

### 7.1 第一阶段：增加 nullable 字段

建议 `up.sql` 第一阶段包含：

```sql
ALTER TABLE rpa_task_execution
ADD COLUMN business_type varchar(64) NULL
COMMENT 'DIAGNOSIS/CONTENT_STYLE_MONITOR/ENTRY_MONITOR/ARTICLE_PROBE'
AFTER task_id;

UPDATE rpa_task_execution e
JOIN brand_rpa_dispatch_task d
  ON d.id = e.task_id
SET e.business_type = d.business_type
WHERE e.business_type IS NULL;

CREATE INDEX idx_rpa_execution_business_queue
ON rpa_task_execution (
  business_type,
  worker_provider,
  status,
  task_status,
  next_retry_at,
  priority,
  id
);
```

迁移需要考虑重复执行安全：

- 判断字段是否已存在；
- 判断索引是否已存在；
- 回填可重复执行；
- 不覆盖已经存在且非空的 execution 类型；
- 不隐藏 execution/dispatch 冲突。

### 7.2 验证 SQL

至少提供：

```sql
-- 空类型
SELECT COUNT(*) AS null_type_count
FROM rpa_task_execution
WHERE deleted = 0
  AND business_type IS NULL;

-- execution 与 dispatch 类型冲突
SELECT
  e.id,
  e.task_id,
  e.business_type AS execution_type,
  d.business_type AS dispatch_type
FROM rpa_task_execution e
JOIN brand_rpa_dispatch_task d
  ON d.id = e.task_id
WHERE e.deleted = 0
  AND d.deleted = 0
  AND e.business_type IS NOT NULL
  AND e.business_type <> d.business_type;

-- 孤儿 execution
SELECT e.id, e.task_id
FROM rpa_task_execution e
LEFT JOIN brand_rpa_dispatch_task d
  ON d.id = e.task_id
 AND d.deleted = 0
WHERE e.deleted = 0
  AND d.id IS NULL;

-- 未知类型
SELECT business_type, COUNT(*)
FROM rpa_task_execution
WHERE deleted = 0
GROUP BY business_type
HAVING business_type IS NULL
   OR business_type NOT IN (
     'DIAGNOSIS',
     'CONTENT_STYLE_MONITOR',
     'ENTRY_MONITOR',
     'ARTICLE_PROBE'
   );
```

### 7.3 第二阶段：改成 NOT NULL

不要在第一阶段直接改成非空。

只有满足以下条件后才能增加第二阶段迁移：

- 所有生产端已经直接写入 execution 类型；
- 所有历史记录已经回填；
- 没有孤儿；
- 没有类型冲突；
- 新旧 Worker 都已经兼容新列；
- 灰度验证通过。

然后执行：

```sql
ALTER TABLE rpa_task_execution
MODIFY COLUMN business_type varchar(64) NOT NULL
COMMENT 'DIAGNOSIS/CONTENT_STYLE_MONITOR/ENTRY_MONITOR/ARTICLE_PROBE';
```

### 7.4 Down migration

可以提供回滚文件，但不得自动执行。

回滚前必须先停止所有已经依赖 `business_type` 的 Java 和 Worker。

---

## 八、修改 `src/rpaTask.ts`

### 8.1 扩展业务类型

当前：

```typescript
export type RpaBusinessType =
  | "DIAGNOSIS"
  | "ARTICLE_PROBE"
  | "ENTRY_MONITOR";
```

修改为：

```typescript
export type RpaBusinessType =
  | "DIAGNOSIS"
  | "CONTENT_STYLE_MONITOR"
  | "ENTRY_MONITOR"
  | "ARTICLE_PROBE";
```

### 8.2 增加内容风格监测任务类型

建议新增：

```typescript
export interface ContentStyleMonitorRpaTask extends BaseRpaTask {
  businessType: "CONTENT_STYLE_MONITOR";
  tenantId: string;
  projectId: string;
  intentEntryId: string;
  monitorDate: string;
  repetitionNo: number;
}
```

更新：

```typescript
export type RpaTask =
  | DiagnosisRpaTask
  | ArticleProbeRpaTask
  | EntryMonitorRpaTask
  | ContentStyleMonitorRpaTask;
```

### 8.3 Worker 类型范围

逻辑范围应为：

```text
diagnosis Worker：DIAGNOSIS
monitor Worker：ARTICLE_PROBE / ENTRY_MONITOR / CONTENT_STYLE_MONITOR
```

实际是否查询某个 monitor 类型还必须由功能开关控制，不能仅因为联合类型包含就立即领取。

### 8.4 CollectionTask 分组

`ENTRY_MONITOR` 和 `CONTENT_STYLE_MONITOR` 建议统一使用上下文分组：

```typescript
JSON.stringify([
  task.tenantId,
  task.businessType,
  task.projectId,
  task.aiModelId,
  task.monitorDate
]);
```

业务类型应包含在内部键中，防止两类监测串对话。

用户层面的归属规则仍是：

```text
项目 × AI 平台 × 上海自然日
```

---

## 九、修改 `src/rpaTaskRepository.ts`

这是本次最核心的代码修改。

### 9.1 同时读取两处业务类型

当前主要读取：

```sql
d.business_type AS businessType
```

改为：

```sql
e.business_type AS executionBusinessType,
d.business_type AS dispatchBusinessType
```

`RpaTaskRow` 增加：

```typescript
executionBusinessType: unknown;
dispatchBusinessType: unknown;
```

不要在 SQL 中静默合并两个字段，否则无法发现冲突。

### 9.2 增加统一解析函数

示例：

```typescript
function resolveExecutionBusinessType(
  executionType: unknown,
  dispatchType: unknown
): RpaBusinessType {
  const normalizedDispatch = requireBusinessType(dispatchType);

  if (executionType == null || String(executionType).trim() === "") {
    // 仅用于迁移期历史数据；必须记录审计事件。
    return normalizedDispatch;
  }

  const normalizedExecution = requireBusinessType(executionType);
  if (normalizedExecution !== normalizedDispatch) {
    throw Object.assign(
      new Error(
        `execution 与 dispatch 的 business_type 不一致：` +
        `${normalizedExecution} != ${normalizedDispatch}`
      ),
      { errorCode: "BUSINESS_TYPE_MISMATCH" as const }
    );
  }

  return normalizedExecution;
}
```

空值使用 dispatch 兼容时记录：

```text
LEGACY_BUSINESS_TYPE_FALLBACK
```

类型冲突时记录：

```text
BUSINESS_TYPE_MISMATCH
```

冲突任务不得返回给执行器。

### 9.3 更新 requireBusinessType

必须接受：

```text
DIAGNOSIS
CONTENT_STYLE_MONITOR
ENTRY_MONITOR
ARTICLE_PROBE
```

其他任何值严格拒绝。

### 9.4 更新候选查询

新任务正式查询必须满足：

```sql
e.business_type = ?
AND d.business_type = e.business_type
```

迁移期历史空值可以显式兼容：

```sql
AND (
  (
    e.business_type IS NOT NULL
    AND e.business_type = ?
    AND d.business_type = e.business_type
  )
  OR
  (
    e.business_type IS NULL
    AND d.business_type = ?
  )
)
```

注意两个占位符参数必须传同一个期望业务类型。

不能将没有真实 dispatch 类型的空值自动归入任何业务。

### 9.5 ENTRY_MONITOR 查询保持通用队列边界

ENTRY 查询继续只以：

```text
rpa_task_execution
```

作为候选任务表，并关联：

```text
brand_rpa_dispatch_task
rpa_task_execution_context
```

不得关联文章或 probe 业务表决定是否领取。

上下文关联需要校验：

```sql
ctx.execution_id = e.id
ctx.business_type = resolved execution type
ctx.business_task_id = d.business_task_id
ctx.ai_model_id = e.ai_model_id
```

### 9.6 更新批次查询

`ENTRY_MONITOR` 批次继续按：

```text
tenantId
projectId
aiModelId
monitorDate
businessType
```

读取。

`CONTENT_STYLE_MONITOR` 在通用 context 准备完成后使用相同批次协议。

### 9.7 更新原子领取

领取必须同时验证：

```sql
e.business_type = ?
AND d.business_type = e.business_type
```

示意：

```sql
UPDATE rpa_task_execution e
INNER JOIN brand_rpa_dispatch_task d
  ON d.id = e.task_id
 AND d.deleted = 0
 AND d.status = 'DISPATCHED'
SET
  e.status = 1,
  e.task_status = 1,
  e.start_time = CURRENT_TIMESTAMP,
  e.modify_time = CURRENT_TIMESTAMP
WHERE e.id = ?
  AND e.status = 0
  AND e.task_status = 0
  AND e.deleted = 0
  AND e.business_type = ?
  AND d.business_type = e.business_type
  AND e.worker_provider = ?
  AND d.worker_provider = e.worker_provider
  AND (
    e.next_retry_at IS NULL
    OR e.next_retry_at <= CURRENT_TIMESTAMP
  );
```

历史空类型兼容领取必须走明确的旧路径，不能降低新任务的严格校验。

### 9.8 更新状态统计

所有按类型统计应优先按：

```text
e.business_type
```

聚合，并校验 dispatch 类型一致。

迁移期间另外统计：

- null execution type；
- fallback 数量；
- mismatch 数量。

---

## 十、修改 `src/rpaWorkerState.ts`

当前 stale recovery 主要按 dispatch 类型识别，并对 monitor 类型数量存在硬编码。

需要修改：

1. 支持三类 monitor：

```text
ARTICLE_PROBE
ENTRY_MONITOR
CONTENT_STYLE_MONITOR
```

2. 新任务恢复条件增加：

```sql
e.business_type IN (...)
AND d.business_type = e.business_type
```

3. business type 冲突任务不得自动恢复；
4. 空类型历史任务只能通过明确 fallback 路径恢复；
5. 统计恢复数量时按真实类型分组；
6. 不改变品牌诊断原有恢复语义。

监测任务发送后结果不确定时，继续保持严格恢复原则，不能因为新增类型而重复提问。

---

## 十一、修改 `src/rpaWorker.ts`

### 11.1 显式按 business_type 分流

建议把流程表达为明确分支：

```typescript
switch (task.businessType) {
  case "DIAGNOSIS":
    // 完全保留现有诊断行为
    break;
  case "ENTRY_MONITOR":
    // 正式文章数据监测
    break;
  case "CONTENT_STYLE_MONITOR":
    // 内容风格监测，待 context 合同完整后开启
    break;
  case "ARTICLE_PROBE":
    // 历史存量兼容
    break;
}
```

底层继续复用：

```text
executeQuestion()
```

### 11.2 ENTRY_MONITOR 行为保持

保持：

- 发送 `task.keyword` 原文；
- 根据 `task.aiModelId` 选择平台；
- 强制联网；
- 提取回答正文；
- 提取引用；
- 项目 × 平台 × 上海自然日对话；
- 发送前再次校验自然日；
- 不确定结果不得伪装成零引用；
- 结果写入后更新对话问题数量。

### 11.3 CONTENT_STYLE_MONITOR 执行行为

准备完成后复用：

```text
keyword
ai_model_id
deep_thinking
executeQuestion
rpa_answer
rpa_answer_reference
```

爬虫不负责：

- 下载引用文章全文；
- 调用 LLM 分析文章风格；
- 汇总平台偏好；
- 生成 Agent 报告。

这些由 Java 后端负责。

### 11.4 ARTICLE_PROBE

保留旧执行分支，但不得作为新文章数据监测默认类型。

---

## 十二、修改 `src/webSearch.ts`

两类正式监测和历史文章监测都要求联网：

```typescript
export function webSearchPolicyForBusinessType(
  businessType: RpaBusinessType,
  diagnosisPolicy: WebSearchPolicy
): WebSearchPolicy {
  return businessType === "ARTICLE_PROBE" ||
    businessType === "ENTRY_MONITOR" ||
    businessType === "CONTENT_STYLE_MONITOR"
    ? "REQUIRED"
    : diagnosisPolicy;
}
```

不要改变 `DIAGNOSIS` 的现有特殊策略。

---

## 十三、通用化监测上下文

当前 `src/entryMonitor.ts` 只服务 ENTRY。

建议新增：

```text
src/monitorTask.ts
```

或在保持兼容导出的前提下抽取通用能力。

定义：

```typescript
type ContextualMonitorBusinessType =
  | "ENTRY_MONITOR"
  | "CONTENT_STYLE_MONITOR";
```

通用校验字段：

- `executionId`；
- `tenantId`；
- `projectId`；
- `intentEntryId`；
- `aiModelId`；
- `monitorDate`；
- `repetitionNo`；
- `businessType`。

保留 ENTRY 原有的提交状态机和页面 owner 防重语义。

不要让抽取通用代码改变既有 ENTRY 行为。

---

## 十四、CONTENT_STYLE_MONITOR 上下文阻塞

当前 Java 的内容风格监测创建 execution 时，没有同步创建：

```text
rpa_task_execution_context
```

因此爬虫当前无法只通过通用 RPA 表获得：

- projectId；
- intentEntryId；
- cycleDate/monitorDate；
- repetitionNo。

推荐方案是由 Java 在创建 style execution 的同一事务中写：

```text
business_type = CONTENT_STYLE_MONITOR
business_task_id = content_style_monitor_cycle.id
project_id = cycle.project_id
intent_entry_id = sample.intent_entry_id
ai_model_id = sample.ai_model_id
monitor_date = cycle.cycle_date
repetition_no = sample.repetition_no
```

在此协议尚未完成前：

- 可以先实现 TypeScript 类型、解析、监控和 feature flag；
- `CONTENT_STYLE_MONITOR_ENABLED` 必须保持 `false`；
- 不得为了赶进度让爬虫直接依赖多个 style 业务表；
- 如果确实选择业务表 JOIN，必须先向用户报告架构取舍并获得确认。

---

## 十五、通用化对话仓储

当前：

```text
src/entryMonitorConversationRepository.ts
```

硬编码：

```text
business_type = ENTRY_MONITOR
```

建议保留兼容导出并新增通用实现：

```text
src/monitorConversationRepository.ts
```

仓储方法接收：

```typescript
businessType: "ENTRY_MONITOR" | "CONTENT_STYLE_MONITOR"
```

对话唯一归属：

```text
tenantId
businessType
projectId
aiModelId
monitorDate
```

这样不会让 ENTRY 和风格监测串进同一个页面对话。

继续使用通用：

```text
rpa_conversation_session
```

除非后端与用户明确要求，否则不要同时维护两个会话事实表。

---

## 十六、修改 `src/rpaResultRepository.ts`

现有回答、引用、execution 完成事务必须保留。

建议增加结果类型防串校验。

### 16.1 结果携带业务类型

```typescript
export interface RpaCollectionResult {
  executionId: string;
  dispatchTaskId: string;
  businessType: RpaBusinessType;
  // 其他字段保持不变
}
```

Outbox JSON 同步携带业务类型，确保进程恢复后仍能验证。

### 16.2 锁定 execution 时读取类型

```sql
SELECT
  id AS executionId,
  task_id AS dispatchTaskId,
  business_type AS businessType,
  keyword,
  status,
  task_status AS taskStatus,
  answer_id AS answerId
FROM rpa_task_execution
WHERE id = ?
  AND deleted = 0
FOR UPDATE;
```

### 16.3 提交前验证

当 execution 类型非空时：

```text
result.businessType 必须等于 execution.business_type
```

类型不一致必须回滚事务。

不能修改 dispatch 状态；dispatch 仍由 Java 后端回收业务结果后完成。

---

## 十七、修改配置 `src/rpaWorkerConfig.ts`

### 17.1 ENTRY_MONITOR

保留：

```text
ENTRY_MONITOR_ENABLED
ENTRY_MONITOR_GRAY_PROJECT_IDS
ENTRY_MONITOR_PROJECT_CHUNK_SIZE
ENTRY_MONITOR_CONVERSATION_MAX_QUESTIONS
ENTRY_MONITOR_CONVERSATION_MAX_DURATION_MS
ENTRY_MONITOR_TIMEZONE
```

检查：

- 只由 monitor Worker 解析；
- diagnosis Worker 不受错误 ENTRY 配置影响；
- 启用时必须打开 provider routing；
- 启用时必须配置灰度项目；
- 时区必须为 `Asia/Shanghai`。

### 17.2 CONTENT_STYLE_MONITOR

新增独立配置，默认关闭：

```env
CONTENT_STYLE_MONITOR_ENABLED=false
CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS=
```

不要让开启 ENTRY 自动开启风格监测。

### 17.3 ARTICLE_PROBE

建议增加存量开关：

```env
ARTICLE_PROBE_LEGACY_ENABLED=true
```

存量清零后可关闭，但暂时不能删除兼容代码。

### 17.4 `.env.example`

补齐说明、默认值、依赖关系和上线顺序。

不得把真实数据库凭据写入示例文件或日志。

---

## 十八、修改 `src/checkRpaTasks.ts`

检查命令必须与正式 Worker 使用相同的配置构造方式。

不能再直接创建一个缺少 ENTRY、灰度和 provider 参数的 repository。

只读检查输出至少包含：

```text
executionId
executionBusinessType
dispatchBusinessType
businessTaskId
projectId
intentEntryId
keyword
aiModelId
aiModelName
monitorDate
repetitionNo
workerProvider
eligible
ineligibleReason
```

需要识别：

- `BUSINESS_TYPE_MISMATCH`；
- `LEGACY_BUSINESS_TYPE_FALLBACK`；
- `INVALID_EXECUTION_CONTEXT`；
- `UNKNOWN_BUSINESS_TYPE`；
- `OUT_OF_MONITOR_DATE`；
- `PROJECT_NOT_IN_GRAY_LIST`；
- `PROVIDER_MISMATCH`；
- `DISPATCH_NOT_DISPATCHED`。

检查命令默认只能查询，不能领取。

---

## 十九、修改监控和审计

涉及：

```text
src/rpaMetrics.ts
src/rpaTaskAudit.ts
src/workerObservability.ts
Dashboard 数据输出
```

新增或扩展指标：

```text
每种 business_type 的 pending
每种 business_type 的 processing
每种 business_type 的 succeeded
每种 business_type 的 failed
execution business_type 为空数量
execution/dispatch 类型冲突数量
legacy fallback 次数
未知业务类型数量
无效 execution context 数量
ARTICLE_PROBE 存量数量
```

日志不得输出数据库密码、Cookie、完整用户隐私内容或浏览器敏感状态。

---

## 二十、Mock 和类型守卫

修改：

```text
src/mockRpaWorker.ts
src/mockRpaCli.ts
```

Mock 类型允许值增加：

```text
CONTENT_STYLE_MONITOR
```

修正当前测试或错误文案中仅列出旧类型的内容。

Mock 的 monitor 上下文必须和正式任务一致，不能用缺字段的简化对象掩盖生产问题。

---

## 二十一、需要更新的测试

### 21.1 类型协议测试

至少覆盖：

1. 四种合法业务类型都能解析；
2. 未知类型严格拒绝；
3. execution 与 dispatch 类型一致时正常；
4. 两者不一致时拒绝并审计；
5. execution 类型为空时按真实 dispatch 兼容；
6. 空值不会默认成 ENTRY；
7. diagnosis Worker 拒绝三种 monitor 类型；
8. monitor Worker 拒绝 DIAGNOSIS。

### 21.2 查询与领取测试

至少覆盖：

1. SELECT 同时返回 execution 和 dispatch 类型；
2. claim 同时校验两种类型；
3. provider 不一致无法领取；
4. dispatch 非 `DISPATCHED` 无法领取；
5. status 不为双 0 无法领取；
6. next_retry_at 未到无法领取；
7. 并发领取只有一个 Worker 成功；
8. 类型冲突任务不进入执行器。

### 21.3 ENTRY_MONITOR 测试

至少覆盖：

1. `ai_model_id=1` 只映射豆包；
2. `ai_model_id=2` 只映射 DeepSeek；
3. `ai_model_id=3` 只映射元宝；
4. `ai_model_id=4` 只映射千问；
5. 不查询文章表；
6. keyword 原样发送；
7. 强制联网；
8. 项目 × 平台 × 自然日复用对话；
9. 跨自然日发送前阻断；
10. 一个任务失败不终止整批；
11. `CONFIRMED_EMPTY` 可以保存零引用；
12. `UNKNOWN` 不得保存为零引用成功；
13. 回答和引用事务写入；
14. Outbox 回放保留 business type。

### 21.4 CONTENT_STYLE_MONITOR 测试

在上下文合同完成后覆盖：

1. 只能被 monitor Worker 领取；
2. 强制联网；
3. 读取 keyword 和 ai_model_id；
4. 上下文字段齐全；
5. 与 ENTRY 不共用对话；
6. 回写回答和引用；
7. 爬虫不做文章风格 LLM 分析。

### 21.5 ARTICLE_PROBE 测试

至少覆盖：

1. 历史存量仍可查询；
2. 历史存量仍可领取；
3. 回答和引用仍可写入；
4. legacy 开关关闭后不领取；
5. 不把 ARTICLE_PROBE 改写成 ENTRY_MONITOR。

### 21.6 品牌诊断回归测试

必须证明：

1. diagnosis Worker 只领取 `DIAGNOSIS`；
2. 原品牌批次规则不变；
3. 原问题发送顺序不变；
4. 原平台配置不变；
5. 原对话规则不变；
6. 原重试和页面恢复不变；
7. 原结果写入不变；
8. 现有 diagnosis 测试全部通过。

---

## 二十二、历史错误任务处理方案

另一个 Codex 只能生成只读审计 SQL 和候选修复 SQL，不得自行执行。

处理原则：

1. 先停止 monitor Worker；
2. 查询旧任务的父 probe task、sample、dispatch、context；
3. 判断这些任务是否在文章平台修正前生成；
4. 判断父任务是否已经 `TIMEOUT/FAILED/EXPIRED`；
5. 不修改已经成功的回答历史；
6. 不把错误平台任务原地改成正确平台；
7. 通过受控终止旧批次并创建新批次解决；
8. 新批次必须由新版 Java 按文章平台重新生成；
9. 新任务创建后校验平台、次数、上下文和 idempotency；
10. 最后才允许 Worker 领取。

对于当前文章案例，正确验收应为：

```text
文章目标平台：doubao
首次监测：词条 × 豆包 × 1
每日监测：词条 × 豆包 × 30
```

不能再出现同一篇豆包文章自动生成 DeepSeek、元宝和千问 execution。

---

## 二十三、部署顺序

严格建议按以下顺序：

```text
1. 停止 Java 新任务生产和 monitor Worker
2. 备份并只读审计当前任务状态
3. 执行 nullable business_type 迁移
4. 从 dispatch 回填历史 execution 类型
5. 验证空值、孤儿、未知类型和类型冲突
6. 部署兼容 nullable 的新版爬虫
7. 部署直接写 execution.business_type 的新版 Java
8. 隔离平台修正前的错误 ENTRY_MONITOR
9. 创建一条新的文章数据监测任务
10. 只读检查 business_type、ai_model_id 和 context
11. 启用单项目 ENTRY 灰度
12. 验证领取、对话、回答、引用和 URL 匹配
13. 扩大灰度
14. 确认历史回填完整后再改 business_type 为 NOT NULL
15. 补齐 CONTENT_STYLE_MONITOR context
16. 单独开启风格监测灰度
17. 观察 ARTICLE_PROBE 存量并最终关闭旧类型领取
```

不能颠倒为：

```text
先启动新版 Java
→ 再建 business_type 列
```

否则 Java 创建 execution 时可能直接失败。

---

## 二十四、配置上线示例

迁移、历史任务隔离和测试完成前：

```env
ENTRY_MONITOR_ENABLED=false
CONTENT_STYLE_MONITOR_ENABLED=false
ARTICLE_PROBE_LEGACY_ENABLED=true
```

ENTRY 单项目灰度：

```env
RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_GRAY_PROJECT_IDS=5
CONTENT_STYLE_MONITOR_ENABLED=false
ARTICLE_PROBE_LEGACY_ENABLED=true
```

修改 `.env` 后必须重启 monitor Worker。

不要把真实凭据提交到 Git。

---

## 二十五、最终验收标准

### 数据库协议

- [ ] `rpa_task_execution.business_type` 已创建；
- [ ] 新 execution 类型非空；
- [ ] execution 与 dispatch 类型一致；
- [ ] 没有未知类型；
- [ ] 没有孤儿 execution；
- [ ] 历史 fallback 可审计；
- [ ] 索引覆盖正式队列查询。

### ENTRY_MONITOR

- [ ] 新文章监测只创建 `ENTRY_MONITOR`；
- [ ] 豆包文章只生成 `ai_model_id=1`；
- [ ] 爬虫不反查文章平台；
- [ ] keyword 原样发送；
- [ ] 强制联网；
- [ ] 项目 × 平台 × 自然日对话不串；
- [ ] 回答正文写入 `rpa_answer`；
- [ ] 引用写入 `rpa_answer_reference`；
- [ ] URL 匹配由 Java 完成；
- [ ] 旧错误任务没有被误领取。

### CONTENT_STYLE_MONITOR

- [ ] TypeScript 类型支持；
- [ ] 功能开关独立；
- [ ] 通用 context 准备完成前不会领取；
- [ ] 准备完成后可使用 monitor Worker；
- [ ] 不与 ENTRY 串对话；
- [ ] 爬虫只采集回答与引用。

### ARTICLE_PROBE

- [ ] 不再作为新文章监测类型；
- [ ] 存量仍可完成；
- [ ] 存量数量可监控；
- [ ] 不伪装成 ENTRY。

### DIAGNOSIS

- [ ] 品牌诊断逻辑没有改变；
- [ ] diagnosis Worker 只领取 DIAGNOSIS；
- [ ] 原有测试全部通过；
- [ ] 原有对话、重试、恢复和写回语义保持。

### 质量

- [ ] TypeScript 检查通过；
- [ ] 全量测试通过；
- [ ] 新增迁移具备验证和回滚说明；
- [ ] 没有输出敏感信息；
- [ ] 没有修改用户无关文件；
- [ ] 没有自动执行破坏性 SQL。

---

## 二十六、交付要求

修改完成后，请另一个 Codex 输出：

1. 修改文件清单；
2. 每个文件为什么修改；
3. 数据库迁移内容；
4. 哪些 SQL 只生成但未执行；
5. 类型兼容规则；
6. `ENTRY_MONITOR` 新查询和领取规则；
7. `CONTENT_STYLE_MONITOR` 是否因 context 合同仍被阻塞；
8. 历史错误任务审计结果；
9. TypeScript 检查结果；
10. 测试结果；
11. 品牌诊断回归结果；
12. 尚未完成或需要用户确认的事项；
13. 推荐的灰度启动命令和回滚步骤。

如果遇到以下情况，必须停止并报告，不得自行猜测：

- 数据库已存在不同定义的 `business_type`；
- execution 与 dispatch 出现大量类型冲突；
- `CONTENT_STYLE_MONITOR` 上下文来源与本文档不一致；
- 新 Java 尚未部署但旧任务仍在持续产生；
- 历史错误任务中已经存在用户需要保留的正式结果；
- 修改会影响品牌诊断行为；
- 必须直接操作生产数据库才能继续。

---

## 二十七、最终业务链路

```text
成功发布文章
→ Java 读取 article_draft.platform
→ Java 映射 ai_model_id/name
→ Java 按“词条 × 文章平台”创建 ENTRY_MONITOR
→ execution 直接保存 business_type
→ execution 直接保存 ai_model_id/name
→ RPA Worker 只轮询 rpa_task_execution
→ Worker 校验 execution 与 dispatch 类型一致
→ Worker 按 ai_model_id 打开目标 AI 平台
→ Worker 原样发送 keyword
→ Worker 抓取回答正文和引用
→ Worker 写入 rpa_answer / rpa_answer_reference
→ Java 按相同 ai_model_id 匹配该平台文章 URL
→ Java 计算文章曝光、引用和平台覆盖指标
```

必须始终保持职责边界：

```text
Java 决定业务类型、目标平台和监测范围
爬虫负责可靠执行和结构化采集
Java 负责 URL 命中与业务统计
```
