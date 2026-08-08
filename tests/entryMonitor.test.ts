import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntryMonitorCollectionContext,
  assertContextualMonitorTaskEligibleToday,
  contextualMonitorConversationKeyFor,
  createEntryMonitorPageOwner,
  entryMonitorConversationKeyFor,
  entryMonitorOwnerMatchesExecution,
  getShanghaiDate,
  isEntryMonitorTaskEligibleToday,
  serializeEntryMonitorConversationKey,
  serializeContextualMonitorConversationKey,
  transitionEntryMonitorPageOwner
} from "../src/entryMonitor.js";
import { MysqlEntryMonitorConversationRepository } from
  "../src/entryMonitorConversationRepository.js";
import {
  businessTypesForWorker,
  isBusinessTypeAllowedForWorker,
  toCollectionTask,
  type CollectionTask,
  type ContentStyleMonitorRpaTask,
  type EntryMonitorRpaTask
} from "../src/rpaTask.js";
import type {
  RpaSqlClient,
  RpaSqlParameter
} from "../src/rpaTaskRepository.js";

function entryTask(overrides: Partial<EntryMonitorRpaTask> = {}): EntryMonitorRpaTask {
  return {
    executionId: "90071992547409931",
    dispatchTaskId: "2080238709516197889",
    businessType: "ENTRY_MONITOR",
    businessTaskId: "3001",
    tenantKey: "1001",
    tenantId: "1001",
    projectId: "7001",
    intentEntryId: "8001",
    monitorDate: "2026-08-06",
    repetitionNo: 1,
    keyword: "相同词条",
    aiModelId: "1",
    aiModelName: "豆包",
    deepThinking: false,
    failCount: 0,
    priority: 0,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function styleTask(
  overrides: Partial<ContentStyleMonitorRpaTask> = {}
): ContentStyleMonitorRpaTask {
  return {
    ...entryTask(),
    businessType: "CONTENT_STYLE_MONITOR",
    ...overrides
  };
}

test("上海自然日不受 UTC 日期边界影响，且只允许当日 ENTRY_MONITOR", () => {
  const beforeShanghaiMidnight = new Date("2026-08-05T15:59:59.999Z");
  const afterShanghaiMidnight = new Date("2026-08-05T16:00:00.000Z");
  assert.equal(getShanghaiDate(beforeShanghaiMidnight), "2026-08-05");
  assert.equal(getShanghaiDate(afterShanghaiMidnight), "2026-08-06");
  assert.equal(isEntryMonitorTaskEligibleToday(entryTask(), afterShanghaiMidnight), true);
  assert.equal(isEntryMonitorTaskEligibleToday(entryTask(), beforeShanghaiMidnight), false);
});

test("风格任务发送前同样执行上海自然日最终校验", () => {
  assert.doesNotThrow(() => assertContextualMonitorTaskEligibleToday(
    styleTask(),
    new Date("2026-08-05T16:00:00.000Z")
  ));
  assert.throws(() => assertContextualMonitorTaskEligibleToday(
    styleTask(),
    new Date("2026-08-06T16:00:00.000Z")
  ), (error: unknown) => (error as { errorCode?: string }).errorCode === "DATE_WINDOW_EXPIRED");
});

test("三个 Role 的业务类型严格隔离", () => {
  assert.deepEqual(businessTypesForWorker("diagnosis"), ["DIAGNOSIS"]);
  assert.deepEqual(businessTypesForWorker("monitor"), [
    "ARTICLE_PROBE", "ENTRY_MONITOR"
  ]);
  assert.deepEqual(businessTypesForWorker("style"), ["CONTENT_STYLE_MONITOR"]);
  assert.equal(isBusinessTypeAllowedForWorker("diagnosis", "ENTRY_MONITOR"), false);
  assert.equal(isBusinessTypeAllowedForWorker("monitor", "DIAGNOSIS"), false);
  const collection = toCollectionTask(entryTask());
  assert.equal(collection.brandId, "7001");
  assert.equal(collection.businessGroupId, JSON.stringify([
    "1001", "ENTRY_MONITOR", "7001", "1", "2026-08-06"
  ]));
});

test("项目、AI 模型和上海自然日决定会话键，同项目多词条复用且跨日隔离", () => {
  const first = entryMonitorConversationKeyFor({
    ...entryTask({ intentEntryId: "8001" }),
    platformId: "doubao"
  });
  const second = entryMonitorConversationKeyFor({
    ...entryTask({ intentEntryId: "8002", repetitionNo: 30 }),
    platformId: "doubao"
  });
  const nextDay = entryMonitorConversationKeyFor({
    ...entryTask({ monitorDate: "2026-08-07" }),
    platformId: "doubao"
  });
  assert.equal(
    serializeEntryMonitorConversationKey(first),
    serializeEntryMonitorConversationKey(second)
  );
  assert.notEqual(
    serializeEntryMonitorConversationKey(first),
    serializeEntryMonitorConversationKey(nextDay)
  );
  assert.deepEqual(JSON.parse(serializeEntryMonitorConversationKey(first)), [
    "1001", "ENTRY_MONITOR", "7001", "1", "2026-08-06"
  ]);
});

test("ENTRY 与 CONTENT_STYLE 即使项目、平台和日期相同也使用不同会话", () => {
  const entry = contextualMonitorConversationKeyFor({
    ...entryTask(),
    platformId: "doubao"
  });
  const style = contextualMonitorConversationKeyFor({
    ...styleTask(),
    platformId: "doubao"
  });
  assert.notEqual(
    serializeContextualMonitorConversationKey(entry),
    serializeContextualMonitorConversationKey(style)
  );
  assert.deepEqual(JSON.parse(serializeContextualMonitorConversationKey(style)), [
    "1001", "CONTENT_STYLE_MONITOR", "7001", "1", "2026-08-06"
  ]);
});

test("相同 keyword 恢复身份使用 executionId、词条 ID、次数和顺序状态机", () => {
  const key = serializeEntryMonitorConversationKey(entryMonitorConversationKeyFor({
    ...entryTask(),
    platformId: "doubao"
  }));
  const first = entryTask({ executionId: "101", repetitionNo: 1 });
  const second = entryTask({ executionId: "102", repetitionNo: 2 });
  const prepared = createEntryMonitorPageOwner(first, key, {
    userMessageCount: 4,
    assistantMessageCount: 4
  }, new Date("2026-08-06T01:00:00.000Z"));
  assert.equal(entryMonitorOwnerMatchesExecution(prepared, first, key), true);
  assert.equal(entryMonitorOwnerMatchesExecution(prepared, second, key), false);
  const submitting = transitionEntryMonitorPageOwner(prepared, "SUBMITTING");
  const submitted = transitionEntryMonitorPageOwner(submitting, "SUBMITTED");
  const ready = transitionEntryMonitorPageOwner(submitted, "ANSWER_READY");
  assert.equal(transitionEntryMonitorPageOwner(ready, "PERSISTED").submissionState, "PERSISTED");
  assert.throws(
    () => transitionEntryMonitorPageOwner(prepared, "ANSWER_READY"),
    /非法上下文监测提交状态迁移/
  );

  const repeatedExecutions = Array.from({ length: 30 }, (_, index) =>
    entryTask({
      executionId: String(1_000 + index),
      intentEntryId: String(8_000 + index),
      repetitionNo: index + 1,
      keyword: "完全相同的关键词"
    })
  );
  const owners = repeatedExecutions.map((task) =>
    createEntryMonitorPageOwner(task, key, {
      userMessageCount: task.repetitionNo - 1,
      assistantMessageCount: task.repetitionNo - 1
    })
  );
  for (let index = 0; index < repeatedExecutions.length; index += 1) {
    assert.equal(entryMonitorOwnerMatchesExecution(
      owners[index]!,
      repeatedExecutions[index]!,
      key
    ), true);
    assert.equal(entryMonitorOwnerMatchesExecution(
      owners[index]!,
      repeatedExecutions[(index + 1) % repeatedExecutions.length]!,
      key
    ), false);
  }
});

test("ENTRY_MONITOR CollectionTask 缺少上下文字段时严格拒绝", () => {
  const collection = {
    ...entryTask(),
    id: "90071992547409931",
    brandId: "7001",
    platformId: "doubao",
    businessGroupId: "group",
    question: "相同词条",
    mode: "business"
  } satisfies CollectionTask;
  assert.doesNotThrow(() => assertEntryMonitorCollectionContext(collection));
  assert.throws(
    () => assertEntryMonitorCollectionContext({ ...collection, projectId: undefined }),
    (error: unknown) => (error as { errorCode?: string }).errorCode ===
      "INVALID_EXECUTION_CONTEXT"
  );
});

class ConversationSqlClient implements RpaSqlClient {
  readonly queries: Array<{ sql: string; parameters: readonly RpaSqlParameter[] }> = [];
  readonly updates: Array<{ sql: string; parameters: readonly RpaSqlParameter[] }> = [];

  constructor(
    private readonly queryResults: unknown[][] = [],
    private readonly updateResults: number[] = []
  ) {}

  async queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]> {
    this.queries.push({ sql, parameters });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number> {
    this.updates.push({ sql, parameters });
    return this.updateResults.shift() ?? 1;
  }
}

test("数据库会话仓储使用完整唯一键支持 A→B→A，并幂等累计 execution", async () => {
  const rowFor = (projectId: string, conversationUrl: string) => ({
    tenantId: "1001",
    projectId,
    aiModelId: "1",
    conversationDate: "2026-08-06",
    conversationUrl,
    status: "ACTIVE",
    questionCount: 3,
    lastExecutionId: "101",
    ownerWorkerId: "monitor-doubao",
    lastUsedAt: "2026-08-06 02:00:00",
    failureReason: null,
    createdAt: "2026-08-06 00:00:00"
  });
  const client = new ConversationSqlClient([
    [rowFor("7001", "https://www.doubao.com/chat/a")],
    [rowFor("7002", "https://www.doubao.com/chat/b")],
    [rowFor("7001", "https://www.doubao.com/chat/a")]
  ], [1, 1, 1, 1, 2]);
  const repository = new MysqlEntryMonitorConversationRepository(client);
  const keyA = contextualMonitorConversationKeyFor({ ...entryTask(), platformId: "doubao" });
  const keyB = contextualMonitorConversationKeyFor({
    ...entryTask({ projectId: "7002" }),
    platformId: "doubao"
  });

  assert.equal((await repository.find(keyA))?.conversationUrl, "https://www.doubao.com/chat/a");
  assert.equal((await repository.find(keyB))?.conversationUrl, "https://www.doubao.com/chat/b");
  assert.equal((await repository.find(keyA))?.conversationUrl, "https://www.doubao.com/chat/a");
  assert.deepEqual(client.queries.map(({ parameters }) => parameters), [
    ["1001", "ENTRY_MONITOR", "7001", "1", "2026-08-06"],
    ["1001", "ENTRY_MONITOR", "7002", "1", "2026-08-06"],
    ["1001", "ENTRY_MONITOR", "7001", "1", "2026-08-06"]
  ]);
  assert.match(client.queries[0]!.sql, /business_type = \?/);
  assert.match(client.queries[0]!.sql, /deleted = 0/);

  const now = new Date("2026-08-06T02:00:00.000Z");
  await repository.upsertActive({
    ...keyA,
    conversationKey: serializeContextualMonitorConversationKey(keyA),
    conversationUrl: "https://www.doubao.com/chat/a",
    status: "ACTIVE",
    questionCount: 0,
    ownerWorkerId: "monitor-doubao",
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString()
  });
  assert.match(client.updates[0]!.sql, /INSERT INTO rpa_conversation_session/);
  assert.match(client.updates[0]!.sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(client.updates[0]!.parameters.slice(0, 4), [
    "ENTRY_MONITOR", "7001", "1", "2026-08-06"
  ]);
  await repository.updateUrl(keyA, "https://www.doubao.com/chat/a-restored");
  await repository.touch(keyA, now, { executionId: "102", workerId: "monitor-doubao" });
  await repository.incrementQuestionCount(
    keyA,
    { executionId: "102", workerId: "monitor-doubao" },
    now
  );
  assert.match(client.updates[3]!.sql, /IF\(last_execution_id = \?, 0, 1\)/);
  assert.deepEqual(client.updates[3]!.parameters.slice(0, 3), [
    "102", "102", "monitor-doubao"
  ]);
  assert.equal(await repository.closeExpired("ENTRY_MONITOR", "2026-08-07"), 2);
  assert.match(client.updates[4]!.sql, /status = 'CLOSED'/);
});
