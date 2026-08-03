import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDiskSpace, classifyRuntimeError } from "../src/runtimeSafety.js";

test("磁盘监控支持不存在的目标目录并在停止阈值下阻止领取", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rpa-disk-check-"));
  try {
    const result = await checkDiskSpace(
      path.join(root, "not-created", "outbox"),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1
    );
    assert.equal(result.status, "STOP_CLAIMING");
    assert.ok(result.freeBytes >= 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("统一循环错误分类不再把所有异常记为 DATABASE_ERROR", () => {
  assert.equal(classifyRuntimeError({ errorCode: "CAPTCHA_REQUIRED" }), "CAPTCHA_REQUIRED");
  assert.equal(classifyRuntimeError({ errorCode: "BROWSER_DISCONNECTED" }), "BROWSER_DISCONNECTED");
  assert.equal(classifyRuntimeError(new Error("ENOSPC: no space left")), "FILESYSTEM_ERROR");
  assert.equal(classifyRuntimeError(new Error("MySQL connection lost")), "DATABASE_ERROR");
  assert.equal(classifyRuntimeError(new Error("普通逻辑异常")), "TECHNICAL_FAILURE");
});

test("无效磁盘阈值会被阻止并返回配置错误", async () => {
  await assert.rejects(
    () => checkDiskSpace("/tmp", 10, 20),
    (error: unknown) => error instanceof Error && /磁盘阈值配置无效/.test(error.message)
  );
});
