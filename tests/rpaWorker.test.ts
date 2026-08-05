import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool, PoolConnection } from "mysql2/promise";
import type { CollectionTask } from "../src/rpaTask.js";
import type {
  RpaSqlClient,
  RpaSqlParameter,
  RpaTaskRepository
} from "../src/rpaTaskRepository.js";
import {
  deepThinkingRuntimeForTask,
  browserRuntimeNeedsReconnect,
  executionErrorFor,
  nextPlatformBatches,
  planGreyRpaBatches,
  readySessionPlatforms,
  referenceRecoveryRuntimeForTask,
  releaseableExecutionIds,
  routePlatformTaskFailure,
  taskInGrayScope,
  webSearchRuntimeForTask,
  type RpaWorkerSession
} from "../src/rpaWorker.js";
import { PlatformExecutionError } from "../src/platformExecution.js";

test("联网开关和引用入口短暂不可见时仅冷却到下一轮询", () => {
  for (const errorCode of ["WEB_SEARCH_UNVERIFIED", "REFERENCE_UNKNOWN"] as const) {
    const error = executionErrorFor(new Error(errorCode), errorCode, 900_000, 10_000);
    assert.ok(error instanceof PlatformExecutionError);
    assert.equal(error.healthStatus, "COOLING_DOWN");
    assert.equal(error.cooldownMs, 10_000);
  }
});

test("元宝参考列表重生成耗尽后释放同一题到下一轮有限重试", () => {
  assert.equal(
    routePlatformTaskFailure("yuanbao", "REFERENCE_UNKNOWN"),
    "retry_task"
  );
  assert.equal(
    routePlatformTaskFailure("doubao", "REFERENCE_UNKNOWN"),
    "pause_platform"
  );
});

test("批次失败只释放明确尚未发送的任务", () => {
  const states = new Map([
    ["not-sent", "NOT_SUBMITTED" as const],
    ["sent", "SUBMITTED" as const],
    ["visible", "ANSWER_VISIBLE" as const],
    ["uncertain", "POST_SUBMIT_UNCERTAIN" as const]
  ]);
  assert.deepEqual(
    releaseableExecutionIds(["not-sent", "sent", "visible", "uncertain"], states),
    ["not-sent"]
  );
});
import type { BrowserSelfCheckResult } from "../src/browserDiagnostics.js";
import { parseRpaWorkerConfig } from "../src/rpaWorkerConfig.js";
import {
  ExecutionHeartbeat,
  MysqlAdvisoryLeaseCoordinator,
  RpaWorkerStateRepository,
  executionLeaseName,
  platformLeaseName,
  waitForAdvisoryLease,
  type AdvisoryLeaseCoordinator
} from "../src/rpaWorkerState.js";

class FakeMysqlLockServer {
  readonly owners = new Map<string, number>();
  nextConnectionId = 1;

  connection(): PoolConnection {
    const id = this.nextConnectionId++;
    const emitter = new EventEmitter();
    const query = async (sql: string, parameters: readonly unknown[] = []) => {
      const name = String(parameters[0] ?? "");
      if (/GET_LOCK/.test(sql)) {
        const owner = this.owners.get(name);
        if (owner === undefined || owner === id) {
          this.owners.set(name, id);
          return [[{ acquired: 1 }], []];
        }
        return [[{ acquired: 0 }], []];
      }
      if (/IS_USED_LOCK/.test(sql)) {
        return [[{ ownerId: this.owners.get(name) ?? null, connectionId: id }], []];
      }
      if (/RELEASE_ALL_LOCKS/.test(sql)) {
        for (const [lockName, owner] of this.owners) {
          if (owner === id) this.owners.delete(lockName);
        }
        return [[{}], []];
      }
      if (/RELEASE_LOCK/.test(sql)) {
        if (this.owners.get(name) === id) this.owners.delete(name);
        return [[{}], []];
      }
      throw new Error(`未实现 SQL：${sql}`);
    };
    const originalEmit = emitter.emit.bind(emitter);
    emitter.emit = ((eventName: string | symbol, ...args: unknown[]) => {
      if (eventName === "error" || eventName === "end" || eventName === "close") {
        for (const [lockName, owner] of this.owners) {
          if (owner === id) this.owners.delete(lockName);
        }
      }
      return originalEmit(eventName, ...args);
    }) as typeof emitter.emit;
    return Object.assign(emitter, {
      query,
      release() {}
    }) as unknown as PoolConnection;
  }

  pool(): Pool {
    return {
      getConnection: async () => this.connection()
    } as unknown as Pool;
  }
}

class RecordingClient implements RpaSqlClient {
  readonly queries: { sql: string; parameters: readonly RpaSqlParameter[] }[] = [];
  readonly updates: { sql: string; parameters: readonly RpaSqlParameter[] }[] = [];
  queryResults: unknown[][] = [];
  updateResults: number[] = [];

  async queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]> {
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

class FakeLeases implements AdvisoryLeaseCoordinator {
  readonly attempts: string[] = [];
  readonly releases: string[] = [];
  responses: boolean[] = [];

  async tryAcquire(lockName: string): Promise<boolean> {
    this.attempts.push(lockName);
    return this.responses.shift() ?? true;
  }

  async release(lockName: string): Promise<void> {
    this.releases.push(lockName);
  }

  async close(): Promise<void> {}
}

function task(
  executionId: string,
  businessTaskId: string,
  overrides: Partial<CollectionTask> = {}
): CollectionTask {
  return {
    executionId,
    id: executionId,
    dispatchTaskId: `9${executionId}`,
    businessType: "DIAGNOSIS",
    businessTaskId,
    tenantKey: "tenant-a",
    brandId: "brand-a",
    keyword: `问题-${executionId}`,
    question: `问题-${executionId}`,
    aiModelId: "1",
    aiModelName: "豆包",
    deepThinking: false,
    failCount: 0,
    priority: 0,
    createdAt: "2026-08-03T00:00:00.000Z",
    platformId: "doubao",
    businessGroupId: JSON.stringify(["tenant-a", "DIAGNOSIS", businessTaskId]),
    mode: "business",
    ...overrides
  };
}

test("diagnosis 与 monitor 默认使用独立 endpoint、workerId、目录和 Profile", () => {
  const diagnosis = parseRpaWorkerConfig("diagnosis", [], {}, "/workspace");
  const monitor = parseRpaWorkerConfig("monitor", [], {}, "/workspace");
  assert.equal(diagnosis.cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(monitor.cdpEndpoint, "http://127.0.0.1:9223");
  assert.notEqual(diagnosis.workerId, monitor.workerId);
  assert.notEqual(diagnosis.logDirectory, monitor.logDirectory);
  assert.notEqual(diagnosis.evidenceDirectory, monitor.evidenceDirectory);
  assert.notEqual(diagnosis.outboxDirectory, monitor.outboxDirectory);
  assert.notEqual(diagnosis.metricsDirectory, monitor.metricsDirectory);
  assert.notEqual(diagnosis.chromeProfileDirectory, monitor.chromeProfileDirectory);
  assert.equal(diagnosis.dryRun, true);
  assert.equal(diagnosis.maxTasks, 1);
  assert.equal(diagnosis.maxAttempts, 3);
  assert.equal(diagnosis.retryBackoffMs, 30_000);
  assert.equal(diagnosis.pollIntervalMs, 10_000);
  assert.equal(diagnosis.metricsSnapshotIntervalMs, 15_000);
  assert.equal(diagnosis.runOnce, false);
  assert.equal(diagnosis.deepThinkingUnsupportedPolicy, "fail");
  assert.equal(diagnosis.webSearchPolicy, "PREFERRED");
  assert.equal(monitor.webSearchPolicy, "REQUIRED");
});

test("灰度配置支持关闭 dry-run 和只启用一个平台", () => {
  const config = parseRpaWorkerConfig("monitor", [
    "--dry-run=false",
    "--platforms=qianwen",
    "--max-tasks=2",
    "--max-attempts=5",
    "--retry-backoff-ms=1000",
    "--poll-interval-ms=5000",
    "--poll-jitter-ms=250",
    "--run-once=true",
    "--deep-thinking-unsupported-policy=allow_degrade",
    "--web-search-policy=DISABLED"
  ], {}, "/workspace");
  assert.equal(config.dryRun, false);
  assert.deepEqual(config.platforms, ["qianwen"]);
  assert.equal(config.maxTasks, 2);
  assert.equal(config.maxAttempts, 5);
  assert.equal(config.retryBackoffMs, 1_000);
  assert.equal(config.pollIntervalMs, 5_000);
  assert.equal(config.pollJitterMs, 250);
  assert.equal(config.runOnce, true);
  assert.equal(config.deepThinkingUnsupportedPolicy, "allow_degrade");
  assert.equal(config.webSearchPolicy, "DISABLED");
  assert.throws(
    () => parseRpaWorkerConfig("monitor", [
      "--heartbeat-ms=30000",
      "--stale-after-ms=60000"
    ], {}, "/workspace"),
    /至少是 heartbeat-ms 的 3 倍/
  );
  assert.throws(
    () => parseRpaWorkerConfig("diagnosis", [], {
      RPA_DIAGNOSIS_CDP_ENDPOINT: "http://127.0.0.1:9222",
      RPA_MONITOR_CDP_ENDPOINT: "http://127.0.0.1:9222"
    }, "/workspace"),
    /CDP endpoint 不能相同/
  );
  assert.throws(
    () => parseRpaWorkerConfig("diagnosis", [], {
      RPA_DIAGNOSIS_OUTBOX_DIR: "/shared/outbox",
      RPA_MONITOR_OUTBOX_DIR: "/shared/outbox"
    }, "/workspace"),
    /Outbox 目录不能相同/
  );
});

test("生产领取必须双重显式授权，灰度白名单和比例按完整业务批次稳定生效", () => {
  assert.throws(() => parseRpaWorkerConfig("diagnosis", [
    "--environment=production",
    "--dry-run=false"
  ], {}, "/workspace"), /ALLOW_PRODUCTION_CLAIMS/);
  const config = parseRpaWorkerConfig("diagnosis", [
    "--environment=production",
    "--allow-production-claims=true",
    "--dry-run=false",
    "--provider-routing-enabled=true",
    "--provider=NEW_RPA",
    "--gray-brand-ids=10,20",
    "--gray-business-task-ids=100",
    "--gray-percentage=100"
  ], {}, "/workspace");
  assert.equal(config.allowProductionClaims, true);
  assert.equal(config.providerRoutingEnabled, true);
  assert.deepEqual(config.grayBrandIds, ["10", "20"]);
  assert.equal(taskInGrayScope({ brandId: "10", businessTaskId: "100" }, config), true);
  assert.equal(taskInGrayScope({ brandId: "30", businessTaskId: "100" }, config), false);
  assert.equal(taskInGrayScope({ brandId: "10", businessTaskId: "101" }, config), false);
  const percentageConfig = { grayPercentage: 25 };
  assert.equal(
    taskInGrayScope({ brandId: "10", businessTaskId: "100" }, percentageConfig),
    taskInGrayScope({ brandId: "10", businessTaskId: "100" }, percentageConfig)
  );
});

test("正式 Worker 将任务 deepThinking 原样映射到单题运行时", () => {
  const workerConfig = parseRpaWorkerConfig("diagnosis", [
    "--deep-thinking-unsupported-policy=allow_degrade"
  ], {}, "/workspace");

  assert.deepEqual(
    deepThinkingRuntimeForTask({ deepThinking: true }, workerConfig),
    {
      deepThinking: true,
      deepThinkingUnsupportedPolicy: "allow_degrade"
    }
  );
  assert.equal(
    deepThinkingRuntimeForTask({ deepThinking: false }, workerConfig).deepThinking,
    false
  );
});

test("正式 Worker 强制 ARTICLE_PROBE 联网并允许配置 DIAGNOSIS 策略", () => {
  const workerConfig = parseRpaWorkerConfig("diagnosis", [
    "--web-search-policy=DISABLED"
  ], {}, "/workspace");

  assert.deepEqual(
    webSearchRuntimeForTask({ businessType: "DIAGNOSIS" }, workerConfig),
    { webSearchPolicy: "DISABLED" }
  );
  assert.deepEqual(
    webSearchRuntimeForTask({ businessType: "DIAGNOSIS" }, workerConfig, "yuanbao"),
    { webSearchPolicy: "PREFERRED" }
  );
  assert.deepEqual(
    webSearchRuntimeForTask({ businessType: "DIAGNOSIS" }, workerConfig, "qianwen"),
    { webSearchPolicy: "DISABLED" }
  );
  assert.deepEqual(
    webSearchRuntimeForTask({ businessType: "ARTICLE_PROBE" }, workerConfig),
    { webSearchPolicy: "REQUIRED" }
  );
});

test("灰度任务上限不会截断第一个完整品牌批次", async () => {
  const first = [task("1", "task-a"), task("2", "task-a"), task("3", "task-a")];
  const second = [task("4", "task-b", { brandId: "brand-b" })];
  const repository = {
    async findPendingCollectionTasks() {
      return [first[0]!, second[0]!];
    },
    async findPendingBatchTasks(
      _workerType: string,
      seed: Pick<CollectionTask, "businessTaskId">
    ) {
      return seed.businessTaskId === "task-a" ? first : second;
    }
  } as unknown as RpaTaskRepository;

  const planned = await planGreyRpaBatches(repository, {
    workerType: "diagnosis",
    platforms: ["doubao"],
    maxTasks: 1,
    candidateLimit: 100
  });
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0]!.tasks.map(({ executionId }) => executionId), ["1", "2", "3"]);
});

test("单轮每个平台最多领取一个完整品牌批次", () => {
  const batches = [
    { key: "d-a", tasks: [task("1", "a")] },
    { key: "d-b", tasks: [task("2", "b", { brandId: "brand-b" })] },
    { key: "q-a", tasks: [task("3", "a", { platformId: "qianwen" })] }
  ];
  assert.deepEqual(
    nextPlatformBatches(batches).map(({ key }) => key),
    ["d-a", "q-a"]
  );
});

test("强暂停平台跨轮询保留，只有到期冷却自动恢复", () => {
  const workerConfig = parseRpaWorkerConfig("diagnosis", [], {}, "/workspace");
  const session = {
    platformHealth: new Map([
      ["doubao", { platformId: "doubao", status: "CAPTCHA_REQUIRED", updatedAt: 1 }],
      ["deepseek", { platformId: "deepseek", status: "LOGIN_REQUIRED", updatedAt: 1 }],
      ["qianwen", { platformId: "qianwen", status: "DOM_CHANGED", updatedAt: 1 }],
      ["yuanbao", {
        platformId: "yuanbao",
        status: "COOLING_DOWN",
        updatedAt: 1,
        resumeAt: 50
      }]
    ])
  } as RpaWorkerSession;

  assert.deepEqual(readySessionPlatforms(session, workerConfig, 100), ["yuanbao"]);
  assert.equal(session.platformHealth.get("doubao")?.status, "CAPTCHA_REQUIRED");
  assert.equal(session.platformHealth.get("deepseek")?.status, "LOGIN_REQUIRED");
  assert.equal(session.platformHealth.get("qianwen")?.status, "DOM_CHANGED");
  assert.equal(session.platformHealth.get("yuanbao")?.status, "READY");
});

test("浏览器运行时区分断开、标签页关闭、跳转和人工阻断", () => {
  const runtime = (
    connected: boolean,
    closed: boolean,
    url: string,
    errorCode?: "LOGIN_REQUIRED" | "CAPTCHA_REQUIRED"
  ) => ({
    connected,
    browser: { isConnected: () => connected },
    platforms: {
      doubao: errorCode
        ? { platformId: "doubao", ready: false, healthStatus: errorCode, errorCode }
        : {
          platformId: "doubao",
          ready: true,
          healthStatus: "READY",
          page: { isClosed: () => closed, url: () => url }
        }
    }
  } as unknown as BrowserSelfCheckResult);
  const config = { platforms: ["doubao"] as const };

  assert.equal(browserRuntimeNeedsReconnect(runtime(false, false, "https://www.doubao.com"), config), true);
  assert.equal(browserRuntimeNeedsReconnect(runtime(true, true, "https://www.doubao.com"), config), true);
  assert.equal(browserRuntimeNeedsReconnect(runtime(true, false, "https://example.com"), config), true);
  assert.equal(browserRuntimeNeedsReconnect(runtime(true, false, "https://www.doubao.com/chat"), config), false);
  // 登录/验证码由人工处理，不能用重连循环刷新页面。
  assert.equal(browserRuntimeNeedsReconnect(runtime(true, false, "", "LOGIN_REQUIRED"), config), false);
});

test("心跳只更新仍在处理态的 execution", async () => {
  const client = new RecordingClient();
  client.updateResults = [2];
  const repository = new RpaWorkerStateRepository(client);
  assert.equal(await repository.heartbeat(["10", "11", "10"]), 2);
  const update = client.updates[0]!;
  assert.match(update.sql, /SET modify_time = CURRENT_TIMESTAMP/);
  assert.match(update.sql, /status = 1/);
  assert.match(update.sql, /task_status = 1/);
  assert.deepEqual(update.parameters, ["10", "11"]);

  client.updateResults = [2];
  const heartbeat = new ExecutionHeartbeat(repository, ["10", "11"], {
    intervalMs: 60_000
  });
  await heartbeat.start();
  assert.equal(heartbeat.has("10"), true);
  assert.equal(heartbeat.remove("10"), true);
  assert.equal(heartbeat.has("10"), false);
  await heartbeat.stop();
  assert.equal(client.updates.length, 2);
});

for (const connectionEvent of ["error", "end", "close"] as const) {
  test(`MySQL ${connectionEvent} 事件立即清空本地锁并在新连接重新申请`, async () => {
    const server = new FakeMysqlLockServer();
    const connections: PoolConnection[] = [];
    const pool = {
      async getConnection() {
        const connection = server.connection();
        connections.push(connection);
        return connection;
      }
    } as unknown as Pool;
    let invalidations = 0;
    const coordinator = new MysqlAdvisoryLeaseCoordinator(pool, {
      onInvalidated() {
        invalidations++;
      }
    });

    assert.equal(await coordinator.tryAcquire("rpa:test:disconnect"), true);
    assert.equal(coordinator.isTrusted(), true);
    connections[0]!.emit(connectionEvent, new Error("connection lost"));
    assert.equal(coordinator.isTrusted(), false);
    assert.equal(invalidations, 1);
    assert.equal(await coordinator.tryAcquire("rpa:test:disconnect"), true);
    assert.equal(connections.length, 2);
    assert.equal(coordinator.isTrusted(), true);
    await coordinator.close();
  });
}

test("连接断开后不能凭 heldLocks 继续执行，两个 Worker 重新竞争只有一个成功", async () => {
  const server = new FakeMysqlLockServer();
  const firstConnections: PoolConnection[] = [];
  const firstPool = {
    async getConnection() {
      const connection = server.connection();
      firstConnections.push(connection);
      return connection;
    }
  } as unknown as Pool;
  const workerA = new MysqlAdvisoryLeaseCoordinator(firstPool);
  const workerB = new MysqlAdvisoryLeaseCoordinator(server.pool());
  const lockName = "rpa:execution:competition";

  assert.equal(await workerA.tryAcquire(lockName), true);
  firstConnections[0]!.emit("close");
  assert.equal(await workerB.tryAcquire(lockName), true);
  // A 必须通过新连接重新 GET_LOCK，不能因为旧 heldLocks 返回 true。
  assert.equal(await workerA.tryAcquire(lockName), false);
  assert.equal(firstConnections.length, 2);
  await workerA.close();
  await workerB.close();
});

test("僵尸恢复跳过仍持有 execution 锁的其他 Worker", async () => {
  const client = new RecordingClient();
  client.queryResults = [[
    { executionId: "20", modifiedAt: "2026-08-03T00:00:00.000Z" },
    { executionId: "21", modifiedAt: "2026-08-03T00:00:00.000Z" }
  ]];
  client.updateResults = [1];
  const leases = new FakeLeases();
  leases.responses = [false, true];
  const repository = new RpaWorkerStateRepository(client);
  const cutoff = new Date("2026-08-03T01:00:00.000Z");
  const result = await repository.recoverStaleExecutions(
    "diagnosis",
    cutoff,
    leases
  );
  assert.deepEqual(result.skippedLockedExecutionIds, ["20"]);
  assert.deepEqual(result.recoveredExecutionIds, ["21"]);
  assert.equal(client.updates.length, 1);
  assert.deepEqual(client.updates[0]!.parameters, ["21", cutoff, "DIAGNOSIS"]);
  assert.match(client.updates[0]!.sql, /UTC_TIMESTAMP\(\)/);
  assert.match(client.updates[0]!.sql, /CURRENT_TIMESTAMP\(\)/);
  assert.deepEqual(leases.releases, [executionLeaseName("21")]);
});

test("跨进程平台租约使用两个 Worker 共享的稳定名称并有限等待", async () => {
  assert.equal(platformLeaseName("doubao"), "geno-rpa-platform:doubao");
  const leases = new FakeLeases();
  leases.responses = [false, false, true];
  let now = 0;
  const acquired = await waitForAdvisoryLease(leases, platformLeaseName("doubao"), {
    waitMs: 1_000,
    pollMs: 200,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });
  assert.equal(acquired, true);
  assert.equal(leases.attempts.length, 3);
});

test("正式诊断仅为元宝开启缺少参考列表时的重新生成闭环", () => {
  assert.deepEqual(
    referenceRecoveryRuntimeForTask({ businessType: "DIAGNOSIS" }, "yuanbao"),
    {
      retryOnNoReferences: true,
      regenerateOnNoReferences: true,
      requireReferences: true
    }
  );
  assert.deepEqual(
    referenceRecoveryRuntimeForTask({ businessType: "DIAGNOSIS" }, "doubao"),
    {
      retryOnNoReferences: false,
      regenerateOnNoReferences: false,
      requireReferences: false
    }
  );
  assert.deepEqual(
    referenceRecoveryRuntimeForTask({ businessType: "ARTICLE_PROBE" }, "yuanbao"),
    {
      retryOnNoReferences: false,
      regenerateOnNoReferences: false,
      requireReferences: false
    }
  );
});
