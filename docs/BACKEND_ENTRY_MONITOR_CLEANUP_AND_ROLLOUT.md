# 后端 RPA business_type 清理与 ENTRY_MONITOR 灰度实施方案

> 面向：Java 后端、DBA、发布负责人  
> 基线日期：2026-08-08  
> 目标：在不影响 `DIAGNOSIS` 的前提下，隔离旧错误 ENTRY 任务、处理孤儿 execution，并按文章真实发布平台生成新的 ENTRY_MONITOR 任务。

## 1. 必须达成的结果

后端需要完成四件事：

1. 受控终止旧的四平台 ENTRY 批次，不在原 execution 上修改平台。
2. 从文章发布记录重新解析真实平台，只创建该平台的新 ENTRY execution。
3. 为每条新 ENTRY execution 在同一事务中写入完整 `rpa_task_execution_context`。
4. 对 12 条孤儿 execution 做历史追溯或归档清理，绝不把空类型默认成 `ENTRY_MONITOR`。

爬虫侧已经具备以下保护：

- execution 与 dispatch 类型不一致时拒绝领取；
- `business_type` 为空时不会默认成 ENTRY；
- ENTRY 与 CONTENT_STYLE 使用独立开关；
- 当前 `ENTRY_MONITOR_ENABLED=false`；
- 当前 `CONTENT_STYLE_MONITOR_ENABLED=false`。

## 2. 当前数据库事实

### 2.1 business_type 协议

当前字段：

```text
rpa_task_execution.business_type varchar(64) NULL
```

当前队列索引：

```text
idx_rpa_execution_business_queue
(business_type, worker_provider, status, task_status,
 next_retry_at, priority, id)
```

只读审计结果：

```text
execution/dispatch 类型冲突：0
未知 business_type：0
空 business_type：12
孤儿 execution：12
```

### 2.2 旧错误 ENTRY 批次

以下 4 条 execution 属于同一个旧 dispatch，均为 pending，没有回答和引用：

| executionId | dispatchTaskId | businessTaskId | projectId | intentEntryId | monitorDate | ai_model_id | 平台 | answer/reference |
|---:|---:|---:|---:|---:|---|---:|---|---|
| 1293 | 2085351936934309889 | 49 | 5 | 28 | 2026-08-07 | 1 | 豆包 | 0 / 0 |
| 1294 | 2085351936934309889 | 49 | 5 | 28 | 2026-08-07 | 4 | 千问 | 0 / 0 |
| 1295 | 2085351936934309889 | 49 | 5 | 28 | 2026-08-07 | 2 | DeepSeek | 0 / 0 |
| 1296 | 2085351936934309889 | 49 | 5 | 28 | 2026-08-07 | 3 | 元宝 | 0 / 0 |

共同状态：

```text
dispatch.status = DISPATCHED
execution.status = 0
execution.task_status = 0
execution.answer_id IS NULL
business_type = ENTRY_MONITOR
repetition_no = 1
```

这批任务是在“按文章发布平台生成 execution”逻辑完成前创建的，不能继续领取。

### 2.3 12 条孤儿 execution

这些 execution 的 `task_id` 对应 dispatch 已不存在或已被软删除，无法从真实 dispatch 推断类型。

| 缺失 dispatchTaskId | executionIds | 当前状态摘要 |
|---:|---|---|
| 2080261644182896641 | 65–72 | 6 条 `status=2, answer_id=0`；2 条 `status=1, answer_id=NULL` |
| 2085273925308399618 | 1065–1068 | 4 条 `status=0, task_status=0, answer_id=NULL` |

核对结果：

```text
12 条均没有 rpa_answer
12 条均没有 rpa_answer_reference
部分历史行的 answer_id=0 不是有效回答 ID
```

禁止直接执行：

```sql
UPDATE rpa_task_execution
SET business_type = 'ENTRY_MONITOR'
WHERE business_type IS NULL;
```

因为没有父 dispatch，无法证明它们属于 ENTRY。

## 3. 后端改造范围

### 3.1 统一 business_type 来源

Java 创建 execution 时必须直接写入：

```java
execution.setBusinessType(dispatch.getBusinessType());
```

允许值只能是：

```text
DIAGNOSIS
CONTENT_STYLE_MONITOR
ENTRY_MONITOR
ARTICLE_PROBE
```

禁止使用：

```java
businessType == null ? "ENTRY_MONITOR" : businessType
```

创建前应校验：

```text
execution.business_type == dispatch.business_type
```

### 3.2 ENTRY 平台来源

ENTRY 的目标平台只能来自发布链路：

```text
brand_article_publish_record.article_draft_id
→ brand_article_draft.platform
→ AiEngineEnum.fromArticlePlatform(platform)
→ ai_model_id / ai_model_name
```

映射：

| article platform | ai_model_id | ai_model_name |
|---|---:|---|
| doubao | 1 | 豆包 |
| deepseek | 2 | DeepSeek |
| yuanbao | 3 | 元宝 |
| qwen / qianwen | 4 | 千问 |

禁止：

- 默认创建四个平台；
- 从爬虫返回内容反推平台；
- 在旧 execution 上直接修改 `ai_model_id`；
- 用文章业务表补偿爬虫侧的平台判断。

### 3.3 execution 与 context 同事务创建

每条 ENTRY execution 创建时，同一事务内必须写入：

```text
rpa_task_execution
rpa_task_execution_context
```

context 必填字段：

```text
execution_id
business_type = ENTRY_MONITOR
business_task_id = dispatch.business_task_id
project_id
intent_entry_id
ai_model_id = execution.ai_model_id
monitor_date（Asia/Shanghai 自然日）
repetition_no（从 1 开始）
```

事务提交前必须验证：

```text
ctx.execution_id = execution.id
ctx.business_type = execution.business_type
ctx.business_task_id = dispatch.business_task_id
ctx.ai_model_id = execution.ai_model_id
```

任意一项失败，应整体回滚，不允许留下“有 execution、无 context”的半成品。

## 4. 旧四平台 ENTRY 的处置

### 4.1 处理原则

必须整批终止 execution `1293–1296`，然后创建新批次。

即使 1293 的平台恰好与文章真实平台一致，也不要单独保留 1293，因为：

- 它属于错误批次；
- 原批次幂等键和任务数量已经错误；
- 原地保留会让审计无法区分“旧批次残留”和“新逻辑生成”；
- 原地改次数或平台容易制造重复 repetition。

### 4.2 后端管理操作

建议新增一次性管理 Service/Command，例如：

```java
EntryMonitorRepairResult terminateLegacyEntryBatchAndRebuild(
    Long dispatchTaskId,
    String operator,
    String reason
)
```

不要把修复逻辑长期放在普通轮询任务里。

操作过程：

1. 开启数据库事务。
2. `SELECT ... FOR UPDATE` 锁定 dispatch `2085351936934309889`。
3. 锁定 execution `1293–1296`。
4. 再次校验四条 execution 都是 pending、没有有效 answer/reference。
5. 校验 dispatch 仍为 `DISPATCHED + ENTRY_MONITOR`。
6. 使用后端已有的“取消/过期/失败”领域状态终止旧 dispatch 和 executions。
7. 写入明确原因，例如：

```text
LEGACY_ENTRY_PLATFORM_FANOUT
旧版本按四平台错误生成，已由后端按文章真实平台重建
```

8. 提交旧批次终止事务。
9. 单独调用新版 ENTRY 创建流程生成新 dispatch/execution/context。

如果现有状态枚举没有 `CANCELLED/EXPIRED`，可以使用已有终态，但必须满足：

- Worker 查询不再满足 `dispatch.status = DISPATCHED`；
- execution 不再满足 `status=0 AND task_status=0`；
- 保留原行用于审计；
- 不伪装成采集成功；
- 不插入虚假 `rpa_answer`。

不要直接删除这 4 条旧任务。

### 4.3 终止前并发保护

处理前必须保持：

```env
ENTRY_MONITOR_ENABLED=false
```

后端还应在事务条件中再次限定：

```sql
e.status = 0
AND e.task_status = 0
AND e.answer_id IS NULL
AND NOT EXISTS (
  SELECT 1 FROM rpa_answer a
  WHERE a.execution_id = e.id AND a.deleted = 0
)
```

如果任何一条已经出现回答、引用或 processing 状态，立即停止修复并人工复核。

## 5. 新 ENTRY 批次的正确创建方式

### 5.1 重建流程

```text
读取成功发布记录
→ 找到 article_draft
→ 读取 article_draft.platform
→ 映射唯一 ai_model_id/name
→ 聚合该平台的成功发布 URL
→ 创建或复用该平台查询 sample
→ 创建 ENTRY_MONITOR dispatch
→ 创建 execution
→ 同事务创建 execution_context
```

当前案例的预期结果是：

```text
项目：5
词条：28
文章目标平台：以 brand_article_draft.platform 实际查询结果为准
首次监测：词条 × 目标平台 × 1
每日监测：词条 × 目标平台 × 30
```

如果实际文章平台为 `doubao`，首次监测只能创建：

```text
ai_model_id = 1
ai_model_name = 豆包
execution 数量 = 1
```

不能同时再创建 DeepSeek、元宝和千问 execution。

### 5.2 幂等键

建议后端为 ENTRY 任务建立等价于以下字段的幂等约束：

```text
tenantId
businessType
projectId
intentEntryId
aiModelId
monitorDate
repetitionNo
```

如果数据库暂时不能增加唯一索引，Service 至少要在事务内：

1. 使用相同业务键查询并锁定；
2. 已存在有效 execution 时复用；
3. 已存在终止的旧错误批次时创建新的 generation/version；
4. 防止定时器重入生成重复 repetition。

### 5.3 provider

新 dispatch 和 execution 必须同时写入相同 provider：

```text
dispatch.worker_provider = NEW_RPA
execution.worker_provider = NEW_RPA
```

不得只更新其中一张表。

## 6. 12 条孤儿 execution 的处理

### 6.1 首选：从历史备份找回真实类型

先从以下来源追溯缺失 dispatch：

- 数据库备份；
- binlog；
- Java 业务日志；
- 删除审计表；
- 发布记录或历史任务导出。

如果能够证明原 dispatch 的真实 `business_type`，可以在审计留痕后回填 execution 类型。

回填条件必须是：

```text
有可验证的历史 dispatch 证据
execution 与历史 dispatch 一一对应
类型属于四种合法类型
没有与正式结果冲突
```

### 6.2 无法追溯时：归档后清理

如果无法找回父 dispatch，不能猜测类型。

建议流程：

1. 导出 12 条 execution 的完整行和关联审计信息。
2. 计算导出文件 SHA-256，记录操作人、时间、工单号和原因。
3. 再次确认没有 `rpa_answer`、`rpa_answer_reference`、Outbox 或其他外键引用。
4. 保存到历史归档表或受控归档文件。
5. 经业务负责人和 DBA 审批后，硬删除这 12 条孤儿 execution。

仅执行 `deleted=1` 不能解决最终 `NOT NULL`：MySQL 修改列为 `NOT NULL` 时会检查所有物理行，包括软删除行。

不要采用以下方案：

- 把孤儿统一补成 ENTRY；
- 创建虚假 dispatch 只为通过外键；
- 把 `business_type` 填成 `UNKNOWN` 或 `LEGACY_ORPHAN`；
- 用 `answer_id=0` 当作已有正式回答；
- 未归档直接删除。

## 7. 推荐的后端伪代码

```java
@Transactional
public EntryExecution createEntryExecution(EntryCreateCommand command) {
    PublishRecord publish = publishRepository.requireSuccessful(command.publishRecordId());
    ArticleDraft draft = draftRepository.requireById(publish.getArticleDraftId());
    AiEngine engine = AiEngineEnum.fromArticlePlatform(draft.getPlatform());

    DispatchTask dispatch = dispatchRepository.createOrGetByIdempotencyKey(
        command.tenantId(),
        "ENTRY_MONITOR",
        command.projectId(),
        command.intentEntryId(),
        engine.getId(),
        command.monitorDate(),
        command.repetitionNo()
    );

    if (!"ENTRY_MONITOR".equals(dispatch.getBusinessType())) {
        throw new BusinessTypeMismatchException();
    }

    RpaTaskExecution execution = executionRepository.insert(
        dispatch.getId(),
        dispatch.getBusinessType(),
        engine.getId(),
        engine.getName(),
        "NEW_RPA",
        command.keyword()
    );

    executionContextRepository.insert(
        execution.getId(),
        "ENTRY_MONITOR",
        dispatch.getBusinessTaskId(),
        command.projectId(),
        command.intentEntryId(),
        engine.getId(),
        command.monitorDate(),
        command.repetitionNo()
    );

    return execution;
}
```

## 8. 上线前验证 SQL

以下 SQL 默认只读。

### 8.1 空类型、冲突、未知和孤儿

```sql
SELECT COUNT(*) AS null_type_count
FROM rpa_task_execution
WHERE business_type IS NULL OR TRIM(business_type) = '';

SELECT e.id, e.task_id, e.business_type, d.business_type
FROM rpa_task_execution e
JOIN brand_rpa_dispatch_task d ON d.id = e.task_id
WHERE e.deleted = 0
  AND d.deleted = 0
  AND e.business_type <> d.business_type;

SELECT e.id, e.task_id
FROM rpa_task_execution e
LEFT JOIN brand_rpa_dispatch_task d
  ON d.id = e.task_id AND d.deleted = 0
WHERE e.deleted = 0 AND d.id IS NULL;

SELECT business_type, COUNT(*)
FROM rpa_task_execution
GROUP BY business_type
HAVING business_type IS NULL
   OR business_type NOT IN (
     'DIAGNOSIS', 'CONTENT_STYLE_MONITOR',
     'ENTRY_MONITOR', 'ARTICLE_PROBE'
   );
```

### 8.2 旧批次必须不可领取

```sql
SELECT e.id, d.status AS dispatch_status,
       e.status, e.task_status, e.answer_id
FROM rpa_task_execution e
JOIN brand_rpa_dispatch_task d ON d.id = e.task_id
WHERE e.id IN (1293, 1294, 1295, 1296);
```

验收要求：

```text
dispatch 不再是 DISPATCHED，或 execution 不再是 pending
四条均没有伪造 answer
```

### 8.3 新任务的平台和 context

```sql
SELECT
  e.id,
  e.business_type AS execution_type,
  d.business_type AS dispatch_type,
  e.ai_model_id,
  e.ai_model_name,
  e.worker_provider AS execution_provider,
  d.worker_provider AS dispatch_provider,
  ctx.project_id,
  ctx.intent_entry_id,
  ctx.monitor_date,
  ctx.repetition_no,
  ctx.business_type AS context_type,
  ctx.ai_model_id AS context_ai_model_id
FROM rpa_task_execution e
JOIN brand_rpa_dispatch_task d ON d.id = e.task_id
JOIN rpa_task_execution_context ctx ON ctx.execution_id = e.id
WHERE e.business_type = 'ENTRY_MONITOR'
  AND ctx.project_id = 5
  AND ctx.intent_entry_id = 28
ORDER BY e.id DESC;
```

验收要求：

```text
execution_type = dispatch_type = context_type = ENTRY_MONITOR
execution.ai_model_id = context.ai_model_id
dispatch.worker_provider = execution.worker_provider = NEW_RPA
只有文章真实发布平台对应的 ai_model_id
同一幂等键没有重复 execution
```

## 9. 灰度顺序

严格按以下顺序执行：

```text
1. 保持 ENTRY_MONITOR_ENABLED=false
2. 部署后端平台映射、execution business_type 和 context 同事务逻辑
3. 受控终止旧 dispatch 2085351936934309889
4. 处理或归档 12 条孤儿 execution
5. 创建一条全新的项目 5 ENTRY 任务
6. 执行本文只读验收 SQL
7. 确认只生成文章真实平台的一条首次监测 execution
8. 开启项目 5 灰度
9. 重启 monitor Worker
10. 验证领取、回答、引用和 Java URL 匹配
11. 再逐步扩大灰度
12. 所有物理行 business_type 非空后，另行评审 NOT NULL migration
```

灰度配置：

```env
RPA_WORKER_PROVIDER_ROUTING_ENABLED=true
RPA_WORKER_PROVIDER=NEW_RPA
ENTRY_MONITOR_ENABLED=true
ENTRY_MONITOR_GRAY_PROJECT_IDS=5
CONTENT_STYLE_MONITOR_ENABLED=false
ARTICLE_PROBE_LEGACY_ENABLED=true
```

## 10. 回滚

发现新任务平台、context、次数或幂等键错误时：

1. 立即设置 `ENTRY_MONITOR_ENABLED=false`。
2. 重启 monitor Worker，使其停止领取 ENTRY。
3. 不恢复旧 dispatch `2085351936934309889`。
4. 受控终止本次新建的错误批次。
5. 修正 Java 生产逻辑后创建新的 generation/batch。
6. 不删除已成功产生的正式回答和引用。
7. 不执行 business_type down migration，除非所有新 Java 和 Worker 已停止且明确回退整个协议。

## 11. 后端完成定义

- [ ] execution 创建时直接写合法 business_type；
- [ ] execution 与 dispatch 类型始终一致；
- [ ] ENTRY 平台只来自 `article_draft.platform`；
- [ ] 新 ENTRY 不再默认四平台展开；
- [ ] execution 与 context 同事务创建；
- [ ] 新任务 context 字段完整且与 execution 一致；
- [ ] 旧 execution 1293–1296 已受控终止且保留审计；
- [ ] 没有在旧 execution 上原地修改 ai_model_id；
- [ ] 12 条孤儿已追溯回填，或经审批归档清理；
- [ ] 空值、孤儿、未知类型、类型冲突均为 0；
- [ ] 项目 5 单项目灰度通过；
- [ ] 品牌诊断生产与回归行为未变化；
- [ ] CONTENT_STYLE_MONITOR context 未补齐前保持关闭。
