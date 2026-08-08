import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ResultOutbox,
  ResultOutboxConflictError,
  ResultOutboxWriteError,
  classifyFilesystemError,
  persistResultThroughOutbox,
  replayResultOutbox,
  type SuccessResultWriter
} from "../src/resultOutbox.js";
import { persistResultWithOutboxRecovery } from "../src/rpaWorker.js";
import type {
  RpaCollectionResult,
  RpaResultSaveOutcome
} from "../src/rpaResultRepository.js";

function successfulResult(executionId = "10001"): RpaCollectionResult {
  return {
    executionId,
    dispatchTaskId: "90001",
    businessType: "DIAGNOSIS",
    keyword: "这个问题不允许出现在文件名中 / ../ ?",
    answerContent: "已经成功采集的回答",
    responseDurationSeconds: 12,
    collectedAt: "2026-08-03T08:00:00.000Z",
    references: [{
      question: "原始问题",
      submittedQuestion: "原始问题",
      crawlPlatform: "豆包",
      rank: 1,
      articlePlatform: "示例站点",
      articleTime: "2026-08-03",
      title: "引用标题",
      summary: "引用摘要",
      url: "https://example.com/article",
      extractedAt: "2026-08-03T08:00:00.000Z"
    }],
    answerShareUrl: null,
    webSearchRequested: true,
    webSearchEnabled: true,
    webSearchVerified: true
  };
}

async function temporaryOutbox(t: TestContext): Promise<{
  directory: string;
  outbox: ResultOutbox;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "result-outbox-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, outbox: new ResultOutbox({ directory }) };
}

test("采集成功但数据库失败时保留完整 Outbox，且不调用技术失败更新", async (t) => {
  const { directory, outbox } = await temporaryOutbox(t);
  let markFailureCalls = 0;
  let retryExecutionCalls = 0;
  const repository = {
    async saveSuccess(): Promise<RpaResultSaveOutcome> {
      throw new Error("MySQL connection lost");
    },
    async markFinalTechnicalFailure(): Promise<boolean> {
      markFailureCalls++;
      return true;
    },
    async retryExecution(): Promise<never> {
      retryExecutionCalls++;
      throw new Error("不应调用任务技术重试");
    }
  };

  const outcome = await persistResultThroughOutbox(
    successfulResult(),
    outbox,
    repository
  );

  assert.equal(outcome.status, "pending");
  assert.equal(markFailureCalls, 0);
  assert.equal(retryExecutionCalls, 0);
  const entries = await outbox.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.businessType, "DIAGNOSIS");
  assert.equal(entries[0]!.answerContent, "已经成功采集的回答");
  assert.equal(entries[0]!.references.length, 1);
  assert.equal(entries[0]!.webSearchRequested, true);
  assert.equal(entries[0]!.webSearchEnabled, true);
  assert.equal(entries[0]!.webSearchVerified, true);
  const names = await fs.readdir(directory);
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^execution-[A-Za-z0-9_-]+\.json$/);
  assert.equal(names[0]!.includes("问题"), false);
});

test("Worker 重启后只重放数据库写入，成功后清理 Outbox", async (t) => {
  const { directory, outbox } = await temporaryOutbox(t);
  await outbox.save(successfulResult("restart-1"));
  const calls: RpaCollectionResult[] = [];
  const repository: SuccessResultWriter = {
    async saveSuccess(result) {
      calls.push(result);
      return { status: "saved", answerId: "501", referenceCount: 1 };
    }
  };

  const afterRestart = new ResultOutbox({ directory });
  const replay = await replayResultOutbox(afterRestart, repository);

  assert.equal(replay.discoveredCount, 1);
  assert.equal(replay.replayedCount, 1);
  assert.deepEqual(replay.failures, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.executionId, "restart-1");
  assert.deepEqual(await afterRestart.list(), []);
});

test("数据库成功后 Outbox 清理失败仍返回 saved 并保留幂等重放文件", async (t) => {
  const { directory } = await temporaryOutbox(t);
  class CleanupFailingOutbox extends ResultOutbox {
    override async remove(): Promise<void> {
      throw Object.assign(new Error("Windows 文件暂时被占用"), { code: "EPERM" });
    }
  }
  const outbox = new CleanupFailingOutbox({ directory });
  let databaseWrites = 0;
  const outcome = await persistResultThroughOutbox(
    successfulResult("cleanup-failed"),
    outbox,
    {
      async saveSuccess() {
        databaseWrites++;
        return { status: "saved", answerId: "502", referenceCount: 1 };
      }
    }
  );

  assert.equal(outcome.status, "saved");
  assert.ok(outcome.cleanupError);
  assert.equal(databaseWrites, 1);
  assert.equal((await outbox.list()).length, 1);
});

test("同一 execution 重放两次依赖 saveSuccess 幂等且不会重复回答", async (t) => {
  const { outbox } = await temporaryOutbox(t);
  const completed = new Set<string>();
  let insertedAnswers = 0;
  const repository: SuccessResultWriter = {
    async saveSuccess(result) {
      if (completed.has(result.executionId)) {
        return { status: "already_completed", answerId: "601", referenceCount: 0 };
      }
      completed.add(result.executionId);
      insertedAnswers++;
      return {
        status: "saved",
        answerId: "601",
        referenceCount: result.references.length
      };
    }
  };
  const result = successfulResult("duplicate-safe");

  await outbox.save(result);
  assert.equal((await replayResultOutbox(outbox, repository)).replayedCount, 1);
  // 模拟数据库提交成功后、Outbox 清理前进程崩溃，启动时再次看到同一结果。
  await outbox.save(result);
  assert.equal((await replayResultOutbox(outbox, repository)).replayedCount, 1);

  assert.equal(insertedAnswers, 1);
  assert.deepEqual(await outbox.list(), []);
});

test("崩溃遗留的临时文件不会被当成完整结果读取", async (t) => {
  const { directory, outbox } = await temporaryOutbox(t);
  await fs.writeFile(
    path.join(directory, ".execution-crashed-process.tmp"),
    `${JSON.stringify(successfulResult("temp-only"))}\n`,
    "utf8"
  );

  assert.deepEqual(await outbox.list(), []);
});

test("磁盘满、权限不足和 I/O 异常稳定分类为 FILESYSTEM_ERROR", () => {
  assert.equal(classifyFilesystemError({ code: "ENOSPC" }), "ENOSPC");
  assert.equal(classifyFilesystemError({ code: "EACCES" }), "EACCES");
  assert.equal(classifyFilesystemError({ code: "EIO" }), "EIO");
  assert.equal(classifyFilesystemError(new Error("普通异常")), undefined);
  const wrapped = new ResultOutboxWriteError("写入失败", { code: "ENOSPC" });
  assert.equal(wrapped.errorCode, "FILESYSTEM_ERROR");
  assert.equal(wrapped.filesystemCode, "ENOSPC");
});

test("Outbox 写入失败期间调用方保持任务所有权，落盘后才继续数据库和释放", async (t) => {
  const { directory } = await temporaryOutbox(t);
  let saveAttempts = 0;
  class FlakyOutbox extends ResultOutbox {
    override async save(input: RpaCollectionResult) {
      saveAttempts++;
      if (saveAttempts <= 3) {
        throw new ResultOutboxWriteError("模拟磁盘暂时不可写", { code: "ENOSPC" });
      }
      return super.save(input);
    }
  }
  const outbox = new FlakyOutbox({ directory });
  let heartbeatOwned = true;
  let leaseOwned = true;
  let databaseWrites = 0;
  const degraded: boolean[] = [];

  const outcome = await persistResultWithOutboxRecovery(
    successfulResult("filesystem-recovery"),
    outbox,
    {
      async saveSuccess() {
        databaseWrites++;
        assert.equal(heartbeatOwned, true);
        assert.equal(leaseOwned, true);
        return { status: "saved", answerId: "701", referenceCount: 1 };
      }
    },
    {
      retryIntervalMs: 1,
      async sleep() {
        assert.equal(heartbeatOwned, true);
        assert.equal(leaseOwned, true);
      },
      onFilesystemStateChange(value) {
        degraded.push(value);
      }
    }
  );
  // 与 Worker 的 finally 顺序一致：helper 返回以后才允许释放所有权。
  heartbeatOwned = false;
  leaseOwned = false;

  assert.equal(outcome.status, "saved");
  assert.equal(saveAttempts, 4);
  assert.equal(databaseWrites, 1);
  assert.deepEqual(degraded, [true, true, true, false]);
  assert.deepEqual(await outbox.list(), []);
});

test("截断 JSON、非法字段和校验值错误会隔离，正常 Outbox 继续回放", async (t) => {
  const { directory, outbox } = await temporaryOutbox(t);
  await outbox.save(successfulResult("valid-entry"));
  await outbox.save(successfulResult("truncated-entry"));
  await outbox.save(successfulResult("invalid-field"));
  await outbox.save(successfulResult("checksum-error"));
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  const byExecution = new Map<string, string>();
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) as {
      executionId: string;
    };
    byExecution.set(parsed.executionId, file);
  }
  await fs.writeFile(path.join(directory, byExecution.get("truncated-entry")!), "{", "utf8");
  const invalidPath = path.join(directory, byExecution.get("invalid-field")!);
  const invalid = JSON.parse(await fs.readFile(invalidPath, "utf8"));
  invalid.references = "not-an-array";
  await fs.writeFile(invalidPath, JSON.stringify(invalid), "utf8");
  const checksumPath = path.join(directory, byExecution.get("checksum-error")!);
  const checksum = JSON.parse(await fs.readFile(checksumPath, "utf8"));
  checksum.answerContent = "被篡改";
  await fs.writeFile(checksumPath, JSON.stringify(checksum), "utf8");

  const saved: string[] = [];
  const replay = await replayResultOutbox(outbox, {
    async saveSuccess(result) {
      saved.push(result.executionId);
      return { status: "saved", answerId: "801", referenceCount: result.references.length };
    }
  });

  assert.deepEqual(saved, ["valid-entry"]);
  assert.equal(replay.replayedCount, 1);
  assert.equal(replay.corruptions.length, 3);
  const quarantineFiles = await fs.readdir(path.join(directory, "quarantine"));
  assert.equal(quarantineFiles.filter((name) => name.endsWith(".metadata.json")).length, 3);
});

test("同一 executionId 冲突内容保留原始结果并隔离新内容", async (t) => {
  const { directory, outbox } = await temporaryOutbox(t);
  const original = successfulResult("conflict-entry");
  await outbox.save(original);

  await assert.rejects(
    outbox.save({ ...original, answerContent: "冲突的新回答" }),
    ResultOutboxConflictError
  );
  const [remaining] = await outbox.list();
  assert.equal(remaining?.answerContent, original.answerContent);
  const quarantineFiles = await fs.readdir(path.join(directory, "quarantine"));
  assert.ok(quarantineFiles.some((name) => name.includes("conflict")));
});
