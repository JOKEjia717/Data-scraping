import assert from "node:assert/strict";
import test from "node:test";
import type { RpaWorkerRunSummary, RpaWorkerSession } from "../src/rpaWorker.js";
import { parseRpaWorkerConfig } from "../src/rpaWorkerConfig.js";
import {
  DefaultRpaWorkerCycleRunner,
  InterruptibleWaiter,
  RpaWorkerService,
  type RpaWorkerCycleRunner,
  type RpaWorkerWaiter
} from "../src/rpaWorkerService.js";

function config(overrides: string[] = []) {
  return parseRpaWorkerConfig("diagnosis", [
    "--dry-run=false",
    "--run-once=false",
    "--poll-interval-ms=100",
    "--poll-jitter-ms=0",
    ...overrides
  ], {}, "/workspace");
}

function runSummary(overrides: Partial<RpaWorkerRunSummary> = {}): RpaWorkerRunSummary {
  return {
    workerId: "diagnosis-worker",
    dryRun: false,
    selectedTaskCount: 0,
    selectedBatchCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    releasedTaskCount: 0,
    recoveredZombieCount: 0,
    replayedOutboxCount: 0,
    pendingOutboxCount: 0,
    retriedTaskCount: 0,
    pausedPlatforms: {},
    ...overrides
  };
}

class FakeWaiter implements RpaWorkerWaiter {
  readonly waits: number[] = [];
  wakeCount = 0;
  onWait?: (milliseconds: number) => void;

  async wait(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
    this.onWait?.(milliseconds);
  }

  wake(): void {
    this.wakeCount++;
  }
}

class FakeRunner implements RpaWorkerCycleRunner {
  calls = 0;
  closeCalls = 0;
  execute: (call: number, shouldStop: () => boolean) => Promise<RpaWorkerRunSummary> =
    async () => runSummary();

  runOnce(shouldStop: () => boolean): Promise<RpaWorkerRunSummary> {
    this.calls++;
    return this.execute(this.calls, shouldStop);
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

test("空队列等待 pollInterval 后继续查询", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  let service: RpaWorkerService;
  runner.execute = async (call) => {
    if (call === 2) service.requestStop("TEST");
    return runSummary();
  };
  service = new RpaWorkerService(config(), { runner, waiter, random: () => 0 });

  const summary = await service.run();
  assert.equal(runner.calls, 2);
  assert.deepEqual(waiter.waits, [100]);
  assert.equal(summary.cycleCount, 2);
  assert.equal(runner.closeCalls, 1);
});

test("空轮询后加入的任务能够在后续周期执行", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  let service: RpaWorkerService;
  runner.execute = async (call) => {
    if (call === 1) return runSummary();
    if (call === 2) {
      return runSummary({
        selectedBatchCount: 1,
        selectedTaskCount: 2,
        completedTaskCount: 2
      });
    }
    service.requestStop("TEST");
    return runSummary();
  };
  service = new RpaWorkerService(config(), { runner, waiter, random: () => 0 });

  const summary = await service.run();
  assert.equal(runner.calls, 3);
  assert.equal(summary.cycleCount, 3);
  assert.deepEqual(waiter.waits, [100]);
});

test("dry-run 只执行一个周期后退出", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  const service = new RpaWorkerService(config(["--dry-run=true"]), { runner, waiter });

  const summary = await service.run();
  assert.equal(runner.calls, 1);
  assert.equal(summary.cycleCount, 1);
  assert.deepEqual(waiter.waits, []);
});

test("停止信号唤醒空闲等待且不会启动新批次，第二次信号只告警", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  const warnings: string[] = [];
  let service: RpaWorkerService;
  waiter.onWait = () => {
    service.requestStop("TEST");
    service.requestStop("TEST");
  };
  service = new RpaWorkerService(config(), {
    runner,
    waiter,
    onWarn: (message) => warnings.push(message)
  });

  await service.run();
  assert.equal(runner.calls, 1);
  assert.equal(waiter.wakeCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /不执行强制退出/);
});

test("停止信号允许当前品牌批次安全结束", async () => {
  const runner = new FakeRunner();
  let finishBatch!: (summary: RpaWorkerRunSummary) => void;
  const batchFinished = new Promise<RpaWorkerRunSummary>((resolve) => {
    finishBatch = resolve;
  });
  runner.execute = async (_call, shouldStop) => {
    const result = await batchFinished;
    assert.equal(shouldStop(), true);
    return result;
  };
  const service = new RpaWorkerService(config(), { runner, waiter: new FakeWaiter() });

  const running = service.run();
  await Promise.resolve();
  service.requestStop("TEST");
  finishBatch(runSummary({ selectedBatchCount: 1, completedTaskCount: 3 }));
  const summary = await running;

  assert.equal(runner.calls, 1);
  assert.equal(summary.lastRun?.completedTaskCount, 3);
  assert.equal(summary.stopped, true);
});

test("数据库临时错误使用指数退避，不会形成忙循环", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  let service: RpaWorkerService;
  runner.execute = async (call) => {
    if (call === 4) service.requestStop("TEST");
    throw new Error("MySQL temporarily unavailable");
  };
  service = new RpaWorkerService(config(), {
    runner,
    waiter,
    random: () => 0,
    onError: () => undefined,
    maxDatabaseBackoffMs: 10_000
  });

  const summary = await service.run();
  assert.equal(runner.calls, 4);
  assert.deepEqual(waiter.waits, [1_000, 2_000, 4_000]);
  assert.equal(summary.errorCount, 4);
});

test("默认 CycleRunner 跨轮询复用同一个 CDP Session", async () => {
  const fakeSession = {} as RpaWorkerSession;
  let sessionCreations = 0;
  let sessionCloses = 0;
  const seenSessions: RpaWorkerSession[] = [];
  const runner = new DefaultRpaWorkerCycleRunner(config(), {
    createSession() {
      sessionCreations++;
      return fakeSession;
    },
    async runOnce(_config, session) {
      seenSessions.push(session);
      return runSummary();
    },
    async closeSession(session) {
      assert.equal(session, fakeSession);
      sessionCloses++;
    }
  });

  await runner.runOnce(() => false);
  await runner.runOnce(() => false);
  await runner.close();
  assert.equal(sessionCreations, 1);
  assert.deepEqual(seenSessions, [fakeSession, fakeSession]);
  assert.equal(sessionCloses, 1);
});

test("单次运行模式下异常会被抛出且仍会关闭 CycleRunner", async () => {
  const runner = new FakeRunner();
  const waiter = new FakeWaiter();
  const service = new RpaWorkerService(config(["--run-once=true"]), {
    runner,
    waiter,
    onError: () => undefined
  });
  runner.execute = async () => {
    throw new Error("boom");
  };

  await assert.rejects(() => service.run(), /boom/);
  assert.equal(runner.closeCalls, 1);
  assert.deepEqual(waiter.waits, []);
});

test("中断等待器对非法等待时长会立即报错", async () => {
  const waiter = new InterruptibleWaiter();
  await assert.rejects(() => waiter.wait(-1), /非负数/);
});

