import assert from "node:assert/strict";
import test from "node:test";
import {
  MultiPlatformExecutionLayer,
  PlatformExecutionError,
  type PlatformTaskOutcome
} from "../src/platformExecution.js";
import type { EnqueueBrandTaskInput } from "../src/scheduler.js";
import type { PlatformId } from "../src/types.js";

function task(
  id: string,
  brandId: string,
  platformId: PlatformId = "doubao",
  businessGroupId = "group-1"
): EnqueueBrandTaskInput {
  return {
    id,
    brandId,
    businessGroupId,
    platformId,
    question: `${id} 的问题`,
    createdAt: 1
  };
}

test("同平台并发固定为 1，且一个品牌批次连续执行完再切换品牌", async () => {
  const order: string[] = [];
  let activeCount = 0;
  let maximumActiveCount = 0;
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["doubao"],
    async executeTask({ task: currentTask }) {
      activeCount++;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      await Promise.resolve();
      order.push(currentTask.id);
      activeCount--;
      return { status: "success" };
    }
  });

  layer.enqueue(task("A1", "A"));
  layer.enqueue(task("A2", "A"));
  layer.enqueue(task("B1", "B"));

  const [firstCaller, secondCaller] = await Promise.all([
    layer.runNext("doubao"),
    layer.runNext("doubao")
  ]);
  assert.equal(firstCaller.kind, "completed");
  assert.equal(secondCaller.kind, "completed");
  assert.deepEqual(order, ["A1", "A2"]);
  assert.equal(maximumActiveCount, 1);

  const nextBatch = await layer.runNext("doubao");
  assert.equal(nextBatch.kind, "completed");
  assert.deepEqual(order, ["A1", "A2", "B1"]);
});

test("一个平台异常不会阻止其他平台完成自己的批次", async () => {
  const completed: string[] = [];
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["doubao", "qianwen"],
    config: { doubao: { technicalCooldownMs: 5_000 } },
    async executeTask({ platformId, task: currentTask }) {
      if (platformId === "doubao") throw new Error("豆包页面断开");
      completed.push(currentTask.id);
      return { status: "success" };
    }
  });

  layer.enqueue(task("D1", "D", "doubao"));
  layer.enqueue(task("Q1", "Q", "qianwen"));
  const result = await layer.tick();

  assert.equal(result.doubao?.kind, "failed");
  assert.equal(result.qianwen?.kind, "completed");
  assert.deepEqual(completed, ["Q1"]);
  assert.equal(layer.getPlatformHealth("doubao").status, "COOLING_DOWN");
  assert.equal(layer.getPlatformHealth("qianwen").status, "READY");
});

test("限流、验证码和登录异常均只暂停对应平台，恢复前不再操作页面", async () => {
  const cases: Array<{
    platformId: PlatformId;
    status: "RATE_LIMITED" | "CAPTCHA_REQUIRED" | "LOGIN_REQUIRED";
  }> = [
    { platformId: "doubao", status: "RATE_LIMITED" },
    { platformId: "deepseek", status: "CAPTCHA_REQUIRED" },
    { platformId: "qianwen", status: "LOGIN_REQUIRED" }
  ];
  const calls: string[] = [];
  const layer = new MultiPlatformExecutionLayer({
    platforms: cases.map(({ platformId }) => platformId),
    executeTask({ task: currentTask }): PlatformTaskOutcome {
      calls.push(currentTask.id);
      return { status: "success" };
    }
  });

  for (const { platformId, status } of cases) {
    layer.enqueue(task(`${platformId}-1`, platformId, platformId));
    layer.pausePlatform(platformId, status, `${status} 测试`);
  }

  const paused = await layer.tick();
  assert.deepEqual(calls, []);
  for (const { platformId, status } of cases) {
    assert.equal(paused[platformId]?.kind, "paused");
    assert.equal(layer.getPlatformHealth(platformId).status, status);
    layer.resumePlatform(platformId);
  }

  const resumed = await layer.tick();
  assert.equal(calls.length, 3);
  for (const { platformId } of cases) {
    assert.equal(resumed[platformId]?.kind, "completed");
    assert.equal(layer.getPlatformHealth(platformId).status, "READY");
  }
});

test("平台执行错误可进入强暂停，后续拉取不会连续操作页面", async () => {
  let callCount = 0;
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["yuanbao"],
    executeTask() {
      callCount++;
      throw new PlatformExecutionError("需要人工验证", "CAPTCHA_REQUIRED");
    }
  });

  layer.enqueue(task("Y1", "Y", "yuanbao"));
  const failed = await layer.runNext("yuanbao");
  assert.equal(failed.kind, "failed");
  assert.equal(layer.getPlatformHealth("yuanbao").status, "CAPTCHA_REQUIRED");

  layer.enqueue(task("Y2", "Y2", "yuanbao"));
  const paused = await layer.runNext("yuanbao");
  assert.equal(paused.kind, "paused");
  assert.equal(callCount, 1);
});

test("普通技术故障冷却到期后自动恢复并可执行下一批", async () => {
  let currentTime = 10_000;
  let callCount = 0;
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["doubao"],
    now: () => currentTime,
    config: { doubao: { technicalCooldownMs: 500 } },
    executeTask() {
      callCount++;
      if (callCount === 1) throw new Error("回答超时");
      return { status: "success" };
    }
  });

  layer.enqueue(task("D1", "D"));
  await layer.runNext("doubao");
  layer.enqueue(task("D2", "D2"));

  assert.equal((await layer.runNext("doubao")).kind, "paused");
  assert.equal(callCount, 1);
  currentTime += 500;
  assert.equal((await layer.runNext("doubao")).kind, "completed");
  assert.equal(callCount, 2);
  assert.equal(layer.getPlatformHealth("doubao").status, "READY");
});

test("零引用按成功处理，不重试也不触发冷却", async () => {
  let callCount = 0;
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["deepseek"],
    executeTask() {
      callCount++;
      return { status: "zero_references" };
    }
  });

  layer.enqueue(task("DS1", "DS", "deepseek"));
  const result = await layer.runNext("deepseek");
  assert.equal(result.kind, "completed");
  assert.equal(callCount, 1);
  assert.equal(layer.getPlatformHealth("deepseek").status, "READY");
});

test("题间和批次间等待可按平台配置", async () => {
  const waits: number[] = [];
  const layer = new MultiPlatformExecutionLayer({
    platforms: ["qianwen"],
    config: {
      qianwen: { taskIntervalMs: 120, batchIntervalMs: 450 }
    },
    sleep(milliseconds) {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    executeTask() {
      return { status: "success" };
    }
  });

  layer.enqueue(task("Q1", "Q", "qianwen"));
  layer.enqueue(task("Q2", "Q", "qianwen"));
  await layer.runNext("qianwen");

  assert.deepEqual(waits, [120, 450]);
  assert.equal(layer.getPlatformHealth("qianwen").status, "READY");
});
