import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MetricsJsonSnapshotWriter,
  MetricsRegistry
} from "../src/rpaMetrics.js";

test("MetricsRegistry 聚合任务、耗时、零引用和低基数平台指标", () => {
  let now = new Date("2026-08-03T00:00:00.000Z");
  const registry = new MetricsRegistry(
    "diagnosis",
    ["doubao", "deepseek"],
    () => now
  );
  registry.replaceTaskStates(new Map([
    ["doubao", { pending: 3, processing: 1, succeeded: 5, finalFailed: 2 }],
    ["deepseek", { pending: 4, processing: 2, succeeded: 6, finalFailed: 1 }]
  ]));
  registry.setOutboxPending(2);
  registry.replaceBusinessTypeTaskStates(new Map([
    ["DIAGNOSIS", { pending: 7, processing: 3, succeeded: 11, finalFailed: 3 }]
  ]));
  registry.transitionTaskState("doubao", "pending", "processing");
  registry.transitionTaskState("doubao", "processing", "succeeded");
  registry.observeTaskWait("doubao", 1_000);
  registry.observeTaskWait("doubao", 3_000);
  registry.observeAnswerDuration("doubao", 10_000);
  registry.observeAnswerDuration("deepseek", 20_000);
  registry.incrementZeroReferences("doubao");
  registry.observeBrandBatchDuration("doubao", 30_000, "completed");
  registry.observeBrandBatchDuration("deepseek", 40_000, "failed");
  registry.setPlatformHealth("doubao", "CAPTCHA_REQUIRED");
  registry.setPlatformHealth("doubao", "CAPTCHA_REQUIRED");
  registry.setPlatformHealth("deepseek", "RATE_LIMITED");
  now = new Date("2026-08-03T00:01:00.000Z");
  registry.heartbeat();

  const snapshot = registry.snapshot();
  assert.equal(snapshot.workerType, "diagnosis");
  assert.equal(snapshot.workerHeartbeatAt, now.toISOString());
  assert.equal(snapshot.outboxPending, 2);
  assert.deepEqual(snapshot.businessTypes.DIAGNOSIS, {
    pending: 7,
    processing: 3,
    succeeded: 11,
    finalFailed: 3
  });
  assert.deepEqual(snapshot.totals.taskStates, {
    pending: 6,
    processing: 3,
    succeeded: 12,
    finalFailed: 3
  });
  assert.equal(snapshot.totals.taskWait.averageMs, 2_000);
  assert.equal(snapshot.totals.answerDuration.averageMs, 15_000);
  assert.equal(snapshot.totals.zeroReferences, 1);
  assert.equal(snapshot.totals.captchaRequired, 1);
  assert.equal(snapshot.totals.rateLimited, 1);
  assert.equal(snapshot.totals.completedBrandBatchDuration.averageMs, 30_000);
  assert.equal(snapshot.totals.failedBrandBatchDuration.averageMs, 40_000);
  assert.equal(snapshot.platforms.find(({ platform }) => platform === "doubao")?.paused, true);
});

test("平台阻断离开后再次进入才计为新事件", () => {
  const registry = new MetricsRegistry("monitor", ["qianwen"]);
  registry.setPlatformHealth("qianwen", "LOGIN_REQUIRED");
  registry.setPlatformHealth("qianwen", "LOGIN_REQUIRED");
  registry.setPlatformHealth("qianwen", "READY");
  registry.setPlatformHealth("qianwen", "LOGIN_REQUIRED");
  assert.equal(registry.snapshot().totals.loginRequired, 2);
});

test("JSON 指标快照原子写入且不包含高基数或业务敏感字段", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rpa-metrics-"));
  try {
    const registry = new MetricsRegistry("monitor", ["yuanbao"]);
    registry.setOutboxPending(1);
    const writer = new MetricsJsonSnapshotWriter(directory);
    await writer.write(registry.snapshot());

    const files = await readdir(directory);
    assert.deepEqual(files, ["worker-metrics.json"]);
    const text = await readFile(writer.filePath, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(parsed.workerType, "monitor");
    assert.equal(text.includes("executionId"), false);
    assert.equal(text.includes("brandId"), false);
    assert.equal(text.includes("question"), false);
    assert.equal(text.includes("answerContent"), false);
    assert.equal(text.includes("tenantKey"), false);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
