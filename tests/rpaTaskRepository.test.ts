import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { parseCheckOptions } from "../src/checkRpaTasks.js";
import { readRpaDatabaseConfig } from "../src/rpaDatabase.js";
import { JsonlRpaTaskAuditLogger } from "../src/rpaTaskAudit.js";
import {
  MysqlRpaSqlClient,
  RpaTaskRepository,
  mapRpaTaskRow,
  type RpaSqlClient,
  type RpaSqlParameter,
  type RpaTaskRow
} from "../src/rpaTaskRepository.js";

interface RecordedCall {
  sql: string;
  parameters: readonly RpaSqlParameter[];
}

class RecordingSqlClient implements RpaSqlClient {
  readonly queries: RecordedCall[] = [];
  readonly updates: RecordedCall[] = [];

  constructor(
    private readonly queryResults: unknown[][] = [],
    private readonly updateResults: number[] = []
  ) {}

  async queryRows<T>(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<T[]> {
    this.queries.push({ sql, parameters });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async executeUpdate(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<number> {
    this.updates.push({ sql, parameters });
    return this.updateResults.shift() ?? 0;
  }
}

function row(overrides: Partial<RpaTaskRow> = {}): RpaTaskRow {
  return {
    executionId: "90071992547409931",
    dispatchTaskId: "2080238709516197889",
    businessType: "DIAGNOSIS",
    businessTaskId: "3001",
    tenantKey: "tenant-a",
    brandId: "7001",
    keyword: "品牌诊断问题",
    aiModelId: "4",
    aiModelName: "千问",
    deepThinking: 0,
    failCount: 0,
    priority: 0,
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides
  };
}

test("diagnosis 查询只读 DIAGNOSIS，并从 diagnosis_task.profile_id 解析品牌", async () => {
  const client = new RecordingSqlClient([[row()]]);
  const repository = new RpaTaskRepository(client);

  const [task] = await repository.findPendingCollectionTasks("diagnosis", { limit: 25 });
  assert.ok(task);
  assert.equal(task.executionId, "90071992547409931");
  assert.equal(task.dispatchTaskId, "2080238709516197889");
  assert.equal(task.businessTaskId, "3001");
  assert.notEqual(task.dispatchTaskId, task.businessTaskId);
  assert.equal(task.brandId, "7001");
  assert.equal(task.id, task.executionId);
  assert.equal(task.question, task.keyword);
  assert.equal(task.platformId, "qianwen");
  assert.equal(task.mode, "business");
  assert.equal(
    task.businessGroupId,
    JSON.stringify(["tenant-a", "DIAGNOSIS", "3001"])
  );

  const query = client.queries[0]!;
  assert.match(query.sql, /INNER JOIN diagnosis_task AS business_task/);
  assert.match(query.sql, /business_task\.profile_id AS brandId/);
  assert.doesNotMatch(query.sql, /probe_article_task/);
  assert.match(query.sql, /e\.status = 0/);
  assert.match(query.sql, /e\.task_status = 0/);
  assert.match(query.sql, /d\.status = 'DISPATCHED'/);
  assert.deepEqual(query.parameters, ["DIAGNOSIS", 25]);
});

test("monitor 查询只读 ARTICLE_PROBE，并从 probe_article_task.brand_id 解析品牌", async () => {
  const client = new RecordingSqlClient([[
    row({
      businessType: "ARTICLE_PROBE",
      businessTaskId: "4701",
      brandId: "8801",
      aiModelId: "2",
      aiModelName: "DeepSeek"
    })
  ]]);
  const repository = new RpaTaskRepository(client);

  const [task] = await repository.findPendingCollectionTasks("monitor");
  assert.equal(task?.businessType, "ARTICLE_PROBE");
  assert.equal(task?.businessTaskId, "4701");
  assert.equal(task?.brandId, "8801");
  assert.equal(task?.platformId, "deepseek");

  const query = client.queries[0]!;
  assert.match(query.sql, /INNER JOIN probe_article_task AS business_task/);
  assert.match(query.sql, /business_task\.brand_id AS brandId/);
  assert.doesNotMatch(query.sql, /diagnosis_task/);
  assert.deepEqual(query.parameters, ["ARTICLE_PROBE", 100]);
});

test("完整批次查询按业务任务、租户和 AI 平台收齐任务", async () => {
  const client = new RecordingSqlClient([[row(), row({ executionId: "102" })]]);
  const repository = new RpaTaskRepository(client);
  const tasks = await repository.findPendingBatchTasks("diagnosis", {
    businessTaskId: "3001",
    tenantKey: "tenant-a",
    aiModelId: "4"
  });
  assert.equal(tasks.length, 2);
  const query = client.queries[0]!;
  assert.match(query.sql, /d\.business_task_id = \?/);
  assert.match(query.sql, /d\.tenant_key = \?/);
  assert.match(query.sql, /e\.ai_model_id = \?/);
  assert.deepEqual(query.parameters, [
    "DIAGNOSIS", "3001", "tenant-a", "4", 1_000
  ]);
});

test("领取使用双状态条件更新且绝不更新 dispatch 完成状态", async () => {
  const client = new RecordingSqlClient([], [1]);
  const repository = new RpaTaskRepository(client);

  assert.equal(await repository.claimTask("diagnosis", "9001"), true);
  const update = client.updates[0]!;
  assert.match(update.sql, /^\s*UPDATE rpa_task_execution AS e/);
  assert.match(update.sql, /SET\s+e\.status = 1,\s+e\.task_status = 1,/s);
  assert.match(update.sql, /WHERE e\.id = \?/);
  assert.match(update.sql, /e\.status = 0/);
  assert.match(update.sql, /e\.task_status = 0/);
  assert.match(update.sql, /d\.business_type = \?/);
  assert.doesNotMatch(update.sql, /SET[\s\S]*d\.status/);
  assert.doesNotMatch(update.sql, /UPDATE brand_rpa_dispatch_task/);
  assert.deepEqual(update.parameters, ["9001", "DIAGNOSIS"]);
});

test("并发领取失败时跳过已被抢走的候选并领取下一条", async () => {
  const first = row({ executionId: "101" });
  const second = row({ executionId: "102", keyword: "第二条" });
  const client = new RecordingSqlClient([[first, second]], [0, 1]);
  const repository = new RpaTaskRepository(client);

  const claimed = await repository.claimNextTask("diagnosis", { limit: 2 });
  assert.equal(claimed?.executionId, "102");
  assert.equal(claimed?.keyword, "第二条");
  assert.deepEqual(
    client.updates.map(({ parameters }) => parameters),
    [["101", "DIAGNOSIS"], ["102", "DIAGNOSIS"]]
  );
});

test("affectedRows 为 0 表示没有取得任务所有权", async () => {
  const repository = new RpaTaskRepository(new RecordingSqlClient([], [0]));
  assert.equal(await repository.claimTask("monitor", "501"), false);
});

test("迁移开关启用后查询和领取都排除未到 next_retry_at 的任务", async () => {
  const client = new RecordingSqlClient([[]], [1]);
  const repository = new RpaTaskRepository(client, undefined, {
    retryScheduleEnabled: true
  });
  await repository.findPendingTasks("diagnosis", { limit: 1 });
  await repository.claimTask("diagnosis", "501");
  assert.match(client.queries[0]!.sql, /next_retry_at IS NULL/);
  assert.match(client.updates[0]!.sql, /next_retry_at <= CURRENT_TIMESTAMP/);
});

test("provider 路由启用后查询和条件领取同时隔离 NEW_RPA", async () => {
  const client = new RecordingSqlClient([[]], [1]);
  const repository = new RpaTaskRepository(client, undefined, {
    workerProvider: "NEW_RPA"
  });
  await repository.findPendingTasks("monitor", { limit: 1 });
  await repository.claimTask("monitor", "501");
  assert.match(client.queries[0]!.sql, /d\.worker_provider = \?/);
  assert.match(client.queries[0]!.sql, /e\.worker_provider = d\.worker_provider/);
  assert.deepEqual(client.queries[0]!.parameters, ["ARTICLE_PROBE", "NEW_RPA", 1]);
  assert.match(client.updates[0]!.sql, /d\.worker_provider = \?/);
  assert.deepEqual(client.updates[0]!.parameters, ["501", "ARTICLE_PROBE", "NEW_RPA"]);
});

test("任务状态指标按业务类型只读聚合并按平台合并", async () => {
  const client = new RecordingSqlClient([[
    {
      aiModelId: "1",
      aiModelName: "豆包",
      pending: "2",
      processing: "1",
      succeeded: "5",
      finalFailed: "1"
    },
    {
      aiModelId: "1",
      aiModelName: "Doubao",
      pending: "3",
      processing: "0",
      succeeded: "4",
      finalFailed: "2"
    }
  ]]);
  const repository = new RpaTaskRepository(client);

  assert.deepEqual(await repository.countTaskStates("diagnosis"), [{
    platformId: "doubao",
    pending: 5,
    processing: 1,
    succeeded: 9,
    finalFailed: 3
  }]);
  assert.deepEqual(client.queries[0]?.parameters, ["DIAGNOSIS"]);
  assert.match(client.queries[0]!.sql, /SUM\(CASE WHEN e\.status = 0/);
  assert.match(client.queries[0]!.sql, /d\.business_type = \?/);
  assert.doesNotMatch(client.queries[0]!.sql, /^\s*(UPDATE|INSERT|DELETE)\b/i);
});

test("行映射拒绝把 dispatch task_id 误当业务任务或接受错误业务类型", () => {
  const mapped = mapRpaTaskRow(row());
  assert.equal(mapped.dispatchTaskId, "2080238709516197889");
  assert.equal(mapped.businessTaskId, "3001");
  assert.throws(
    () => mapRpaTaskRow(row(), "ARTICLE_PROBE"),
    /错误业务类型/
  );
});

test("RPA 数据库密码和库名必须来自环境变量", () => {
  const config = readRpaDatabaseConfig({
    RPA_DB_USER: "rpa_reader",
    RPA_DB_PASSWORD: "test-only-password",
    RPA_DB_NAME: "geno_digital_test"
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.database, "geno_digital_test");
  assert.equal(config.connectionLimit, 4);
  assert.throws(
    () => readRpaDatabaseConfig({
      RPA_DB_USER: "rpa_reader",
      RPA_DB_NAME: "geno_digital_test"
    }),
    /RPA_DB_PASSWORD/
  );
});

test("只读查询使用参数化文本协议以兼容不支持 LIMIT 预编译的 MySQL", async () => {
  let queryCalls = 0;
  let executeCalls = 0;
  const pool = {
    async query(sql: string, parameters: unknown[]) {
      queryCalls += 1;
      assert.equal(sql, "SELECT ? AS marker LIMIT ?");
      assert.deepEqual(parameters, ["ok", 1]);
      return [[{ marker: "ok" }], []];
    },
    async execute() {
      executeCalls += 1;
      return [[], []];
    }
  } as unknown as Pool;
  const client = new MysqlRpaSqlClient(pool);

  assert.deepEqual(
    await client.queryRows<{ marker: string }>("SELECT ? AS marker LIMIT ?", ["ok", 1]),
    [{ marker: "ok" }]
  );
  assert.equal(queryCalls, 1);
  assert.equal(executeCalls, 0);
});

test("查询与领取写本地审计 JSONL，但不记录 keyword", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpa-repository-audit-"));
  try {
    const audit = new JsonlRpaTaskAuditLogger({ logDirectory: root });
    const client = new RecordingSqlClient([[row({ keyword: "隐私问题正文" })]], [1]);
    const repository = new RpaTaskRepository(client, audit);
    await repository.claimNextTask("diagnosis", { limit: 1 });
    await audit.flush();

    const content = await fs.readFile(audit.outputPath, "utf8");
    const events = content.trim().split("\n").map((line) => JSON.parse(line) as {
      event: string;
      businessType: string;
      executionId?: string;
      claimed?: boolean;
    });
    assert.deepEqual(events.map(({ event }) => event), ["PENDING_QUERY", "CLAIM_ATTEMPT"]);
    assert.equal(events[1]?.businessType, "DIAGNOSIS");
    assert.equal(events[1]?.executionId, "90071992547409931");
    assert.equal(events[1]?.claimed, true);
    assert.doesNotMatch(content, /隐私问题正文/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("仓储验证 CLI 默认只读，领取必须显式开启", () => {
  assert.deepEqual(parseCheckOptions(["--worker=monitor", "--limit=5"]), {
    workerType: "monitor",
    limit: 5,
    claim: false,
    logDirectory: "rpa-task-logs"
  });
  assert.equal(parseCheckOptions(["--claim=true"]).claim, true);
});
