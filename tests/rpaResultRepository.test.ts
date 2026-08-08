import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionResult } from "../src/mockRpaWorker.js";
import {
  RpaResultRepository,
  toRpaCollectionResult,
  type RpaCollectionResult,
  type RpaResultDatabase,
  type RpaResultTransaction
} from "../src/rpaResultRepository.js";
import type { RpaSqlParameter } from "../src/rpaTaskRepository.js";

interface Operation {
  kind: "query" | "insert" | "update" | "commit" | "rollback" | "release";
  sql?: string;
  parameters?: readonly RpaSqlParameter[];
}

class FakeTransaction implements RpaResultTransaction {
  readonly operations: Operation[] = [];
  queryResults: unknown[][] = [];
  insertIds = ["801"];
  updateResults: number[] = [];
  failUpdateAt = -1;
  private updateCount = 0;

  async queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]> {
    this.operations.push({ kind: "query", sql, parameters });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async insertAndGetId(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<string> {
    this.operations.push({ kind: "insert", sql, parameters });
    return this.insertIds.shift() ?? "801";
  }

  async executeUpdate(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<number> {
    this.operations.push({ kind: "update", sql, parameters });
    if (this.updateCount++ === this.failUpdateAt) throw new Error("模拟数据库写入失败");
    return this.updateResults.shift() ?? 1;
  }

  async commit(): Promise<void> {
    this.operations.push({ kind: "commit" });
  }

  async rollback(): Promise<void> {
    this.operations.push({ kind: "rollback" });
  }

  release(): void {
    this.operations.push({ kind: "release" });
  }
}

class FakeDatabase implements RpaResultDatabase {
  readonly directUpdates: Operation[] = [];
  directUpdateResult = 1;
  directUpdateResults: number[] = [];

  constructor(readonly transaction = new FakeTransaction()) {}

  async beginTransaction(): Promise<RpaResultTransaction> {
    return this.transaction;
  }

  async executeUpdate(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<number> {
    this.directUpdates.push({ kind: "update", sql, parameters });
    return this.directUpdateResults.shift() ?? this.directUpdateResult;
  }
}

function executionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: "501",
    dispatchTaskId: "9001",
    businessType: "DIAGNOSIS",
    keyword: "原样业务问题",
    status: 1,
    taskStatus: 1,
    answerId: null,
    ...overrides
  };
}

function successfulResult(
  overrides: Partial<RpaCollectionResult> = {}
): RpaCollectionResult {
  return {
    executionId: "501",
    dispatchTaskId: "9001",
    businessType: "DIAGNOSIS",
    keyword: "原样业务问题",
    answerContent: "最终回答正文",
    responseDurationSeconds: 12,
    collectedAt: "2026-08-03T08:30:00.000Z",
    references: [
      {
        question: "原样业务问题",
        crawlPlatform: "DeepSeek",
        rank: 4,
        articlePlatform: "示例媒体",
        articleTime: "",
        title: "示例标题",
        summary: "示例摘要",
        url: "https://example.com/article",
        extractedAt: "2026-08-03T08:30:00.000Z"
      }
    ],
    answerShareUrl: null,
    ...overrides
  };
}

test("成功结果严格按回答、引用、answer_id、完成状态顺序提交", async () => {
  const database = new FakeDatabase();
  database.transaction.queryResults = [[executionRow()], []];
  database.transaction.updateResults = [1, 1, 1];

  const outcome = await new RpaResultRepository(database).saveSuccess(successfulResult());
  assert.deepEqual(outcome, { status: "saved", answerId: "801", referenceCount: 1 });

  const writes = database.transaction.operations.filter(
    ({ kind }) => kind === "insert" || kind === "update" || kind === "commit"
  );
  assert.deepEqual(writes.map(({ kind }) => kind), [
    "insert", "update", "update", "update", "commit"
  ]);
  assert.match(writes[0]!.sql!, /^\s*INSERT INTO rpa_answer/);
  assert.deepEqual(writes[0]!.parameters?.slice(0, 3), ["501", "9001", "原样业务问题"]);
  assert.deepEqual(writes[0]!.parameters?.slice(4), [
    12, 1, null, "最终回答正文", null, "", "[]"
  ]);
  assert.match(writes[1]!.sql!, /^INSERT INTO rpa_answer_reference/);
  assert.deepEqual(writes[1]!.parameters, [
    "501", "801", "示例媒体", 1, "示例标题", "https://example.com/article"
  ]);
  assert.match(writes[2]!.sql!, /SET\s+answer_id = \?/);
  assert.match(writes[3]!.sql!, /SET\s+status = 2,\s+task_status = 2/s);
  assert.doesNotMatch(writes.map(({ sql }) => sql ?? "").join("\n"), /brand_rpa_dispatch_task/);
  assert.equal(database.transaction.operations.at(-1)?.kind, "release");
});

test("结果 businessType 与 execution 不一致时回滚且不写回答", async () => {
  const transaction = new FakeTransaction();
  transaction.queryResults = [[executionRow({ businessType: "ENTRY_MONITOR" })], []];
  const repository = new RpaResultRepository(new FakeDatabase(transaction));
  await assert.rejects(
    () => repository.saveSuccess(successfulResult({ businessType: "DIAGNOSIS" })),
    (error: unknown) =>
      (error as { errorCode?: unknown }).errorCode === "BUSINESS_TYPE_MISMATCH"
  );
  assert.equal(transaction.operations.some(({ kind }) => kind === "insert"), false);
  assert.equal(transaction.operations.some(({ kind }) => kind === "rollback"), true);
});

test("零引用仍插入成功回答且不执行引用 INSERT", async () => {
  const database = new FakeDatabase();
  database.transaction.queryResults = [[executionRow()], []];
  database.transaction.updateResults = [1, 1];

  const outcome = await new RpaResultRepository(database).saveSuccess(
    successfulResult({ references: [] })
  );
  assert.deepEqual(outcome, { status: "saved", answerId: "801", referenceCount: 0 });
  const sql = database.transaction.operations.map(({ sql }) => sql ?? "").join("\n");
  assert.doesNotMatch(sql, /INSERT INTO rpa_answer_reference/);
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "commit"), true);
  assert.equal(database.directUpdates.length, 0);
});

test("第一次可重试错误恢复双状态为 0 且 fail_num 加 1", async () => {
  const database = new FakeDatabase();
  const outcome = await new RpaResultRepository(database).retryExecution({
    executionId: "501",
    failCount: 0,
    maxAttempts: 3,
    errorCode: "INPUT_UNAVAILABLE"
  });
  assert.deepEqual(outcome, { status: "released_for_retry", failCount: 1 });
  const update = database.directUpdates[0]!;
  assert.match(update.sql!, /fail_num = fail_num \+ 1/);
  assert.match(update.sql!, /status = 0,\s+task_status = 0/s);
  assert.match(update.sql!, /status = 1/);
  assert.match(update.sql!, /task_status = 1/);
  assert.match(update.sql!, /answer_id IS NULL/);
  assert.match(update.sql!, /fail_num = \?/);
  assert.deepEqual(update.parameters, ["501", 0, 3]);
  assert.doesNotMatch(update.sql!, /brand_rpa_dispatch_task/);
});

test("迁移开启后写 nextRetryAt、重试元数据并立即释放平台执行权", async () => {
  const database = new FakeDatabase();
  const nextRetryAt = new Date("2026-08-03T08:01:00.000Z");
  const outcome = await new RpaResultRepository(database).retryExecution({
    executionId: "501",
    failCount: 0,
    maxAttempts: 3,
    errorCode: "ANSWER_TIMEOUT",
    nextRetryAt
  });
  assert.deepEqual(outcome, { status: "released_for_retry", failCount: 1 });
  const update = database.directUpdates[0]!;
  assert.match(update.sql!, /next_retry_at = \?/);
  assert.match(update.sql!, /last_error_code = \?/);
  assert.match(update.sql!, /last_error_at = CURRENT_TIMESTAMP/);
  assert.deepEqual(update.parameters, [nextRetryAt, "ANSWER_TIMEOUT", "501", 0, 3]);
});

test("现有 failCount 达到最大尝试次数时才写最终失败 3", async () => {
  const database = new FakeDatabase();
  const outcome = await new RpaResultRepository(database).retryExecution({
    executionId: "501",
    failCount: 2,
    maxAttempts: 3,
    errorCode: "ANSWER_TIMEOUT"
  });
  assert.deepEqual(outcome, { status: "final_failed", failCount: 3 });
  const update = database.directUpdates[0]!;
  assert.match(update.sql!, /fail_num = fail_num \+ 1/);
  assert.match(update.sql!, /status = 3,\s+task_status = 3/s);
  assert.match(update.sql!, /fail_num \+ 1 >= \?/);
  assert.deepEqual(update.parameters, ["501", 2, 3]);
});

test("已有 answer_id 或状态已变化时不能释放重试", async () => {
  const database = new FakeDatabase();
  database.directUpdateResult = 0;
  const outcome = await new RpaResultRepository(database).retryExecution({
    executionId: "501",
    failCount: 1,
    maxAttempts: 3,
    errorCode: "PAGE_DISCONNECTED"
  });
  assert.deepEqual(outcome, { status: "not_updated", failCount: 1 });
  assert.match(database.directUpdates[0]!.sql!, /answer_id IS NULL/);
});

test("两个 Worker 竞争重试同一 execution 时只有一个条件更新成功", async () => {
  const database = new FakeDatabase();
  database.directUpdateResults = [1, 0];
  const repository = new RpaResultRepository(database);
  const input = {
    executionId: "501",
    failCount: 0,
    maxAttempts: 3,
    errorCode: "ANSWER_TIMEOUT" as const
  };
  const [first, second] = await Promise.all([
    repository.retryExecution(input),
    repository.retryExecution(input)
  ]);
  assert.deepEqual(first, { status: "released_for_retry", failCount: 1 });
  assert.deepEqual(second, { status: "not_updated", failCount: 0 });
  assert.equal(database.directUpdates.length, 2);
  assert.deepEqual(database.directUpdates[0]!.parameters, ["501", 0, 3]);
  assert.deepEqual(database.directUpdates[1]!.parameters, ["501", 0, 3]);
});

test("同一 execution 已完成时幂等返回，不重复插入回答", async () => {
  const database = new FakeDatabase();
  database.transaction.queryResults = [[executionRow({
    status: 2,
    taskStatus: 2,
    answerId: "700"
  })], [{ answerId: "700" }]];

  const outcome = await new RpaResultRepository(database).saveSuccess(successfulResult());
  assert.deepEqual(outcome, {
    status: "already_completed",
    answerId: "700",
    referenceCount: 0
  });
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "insert"), false);
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "commit"), true);
});

test("历史半写状态存在回答时拒绝重复插入并回滚", async () => {
  const database = new FakeDatabase();
  database.transaction.queryResults = [[executionRow()], [{ answerId: "699" }]];

  await assert.rejects(
    new RpaResultRepository(database).saveSuccess(successfulResult()),
    /拒绝重复插入/
  );
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "insert"), false);
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "rollback"), true);
  assert.equal(database.transaction.operations.some(({ kind }) => kind === "commit"), false);
});

test("引用写入失败会回滚回答，且绝不提前标记 execution 完成", async () => {
  const database = new FakeDatabase();
  database.transaction.queryResults = [[executionRow()], []];
  database.transaction.failUpdateAt = 0;

  await assert.rejects(
    new RpaResultRepository(database).saveSuccess(successfulResult()),
    /模拟数据库写入失败/
  );
  const operations = database.transaction.operations;
  assert.equal(operations.some(({ kind }) => kind === "rollback"), true);
  assert.equal(operations.some(({ kind }) => kind === "commit"), false);
  assert.equal(operations.some(({ sql }) => /status = 2/.test(sql ?? "")), false);
});

test("最终技术失败只条件更新 execution 双状态为 3", async () => {
  const database = new FakeDatabase();
  const repository = new RpaResultRepository(database);
  assert.equal(await repository.markFinalTechnicalFailure({
    executionId: "501",
    final: true,
    errorCode: "ANSWER_TIMEOUT"
  }), true);
  const update = database.directUpdates[0]!;
  assert.match(update.sql!, /^\s*UPDATE rpa_task_execution/);
  assert.match(update.sql!, /status = 3,\s+task_status = 3/s);
  assert.match(update.sql!, /status = 1/);
  assert.match(update.sql!, /task_status = 1/);
  assert.match(update.sql!, /answer_id IS NULL/);
  assert.doesNotMatch(update.sql!, /brand_rpa_dispatch_task|rpa_answer/);
  assert.deepEqual(update.parameters, ["501"]);

  database.directUpdateResult = 0;
  assert.equal(await repository.markFinalTechnicalFailure({
    executionId: "501",
    final: true,
    errorCode: "ANSWER_TIMEOUT"
  }), false);
});

test("统一 CollectionResult 映射回答字段、秒级耗时和采集时间", () => {
  const collectionResult = {
    executionId: "501",
    status: "SUCCESS",
    answer: "采集回答",
    durationMs: 1_001,
    completedAt: "2026-08-03T09:00:00.000Z",
    references: [],
    webSearchRequested: true,
    webSearchEnabled: true,
    webSearchVerified: true
  } as Pick<
    CollectionResult,
    "executionId" | "status" | "answer" | "durationMs" | "completedAt" | "references" |
    "webSearchRequested" | "webSearchEnabled" | "webSearchVerified"
  >;
  const mapped = toRpaCollectionResult({
    executionId: "501",
    dispatchTaskId: "9001",
    businessType: "DIAGNOSIS",
    keyword: "原样业务问题"
  }, collectionResult);
  assert.equal(mapped.answerContent, "采集回答");
  assert.equal(mapped.responseDurationSeconds, 2);
  assert.equal((mapped.collectedAt as Date).toISOString(), "2026-08-03T09:00:00.000Z");
  assert.equal(mapped.answerShareUrl, null);
  assert.equal(mapped.webSearchRequested, true);
  assert.equal(mapped.webSearchEnabled, true);
  assert.equal(mapped.webSearchVerified, true);
});
