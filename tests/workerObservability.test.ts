import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import {
  FailureEvidenceStore,
  StructuredTaskLogger,
  createObservedPlatformTaskExecutor,
  createSelfCheckEvidenceHandler,
  platformTaskOutcomeFromQuestionResult,
  redactAndLimit,
  sanitizeUrl
} from "../src/workerObservability.js";
import { MultiPlatformExecutionLayer } from "../src/platformExecution.js";

test("日志隐私函数会脱敏并限制无界文本和 URL 凭据", () => {
  const result = redactAndLimit(
    "email=user@example.com password=secret 13812345678 abcdefghijklmnop",
    60
  );
  assert.match(result.text, /\[REDACTED_EMAIL\]/);
  assert.match(result.text, /password=\[REDACTED\]/);
  assert.match(result.text, /\[REDACTED_PHONE\]/);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 60);

  const url = sanitizeUrl("https://example.com/chat?id=1&access_token=secret#private");
  assert.doesNotMatch(url, /secret|private/);
  assert.match(url, /access_token=/);
});

test("四个平台 DOM 历史写入同一个有界脱敏 JSON 文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpa-dom-history-"));
  try {
    const page = {
      url: () => "https://chat.example.com/path?access_token=secret#private",
      evaluate: async () =>
        "<!doctype html><html><body password=secret>DOM snapshot</body></html>"
    } as unknown as Page;
    const store = new FailureEvidenceStore({
      evidenceDirectory: path.join(root, "evidence"),
      maxDomChars: 1_000,
      maxDomSnapshotsPerPlatform: 2,
      retentionDays: 7
    });
    for (let index = 1; index <= 3; index++) {
      await store.captureDomSnapshot({
        page,
        workerId: "diagnosis-worker",
        brandId: "brand-1",
        businessGroupId: "business-1",
        platformId: "doubao",
        questionIndex: index,
        outcome: "success"
      });
    }
    await store.captureDomSnapshot({
      page,
      workerId: "diagnosis-worker",
      brandId: "brand-1",
      businessGroupId: "business-1",
      platformId: "yuanbao",
      questionIndex: 1,
      outcome: "failure",
      errorCode: "REFERENCE_UNKNOWN"
    });

    assert.equal(path.basename(store.domHistoryPath), "dom-history.json");
    const history = JSON.parse(await fs.readFile(store.domHistoryPath, "utf8")) as {
      schemaVersion: number;
      snapshots: Array<{
        platform: string;
        currentUrl: string;
        html: string;
      }>;
    };
    assert.equal(history.schemaVersion, 1);
    assert.equal(history.snapshots.filter(({ platform }) => platform === "doubao").length, 2);
    assert.equal(history.snapshots.filter(({ platform }) => platform === "yuanbao").length, 1);
    assert.doesNotMatch(JSON.stringify(history), /password=secret|access_token=secret|#private/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("结构化任务日志达到大小上限后滚动，且不触碰 Outbox 目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpa-log-rotation-"));
  try {
    const logDirectory = path.join(root, "logs");
    const outboxDirectory = path.join(root, "outbox");
    await fs.mkdir(outboxDirectory);
    await fs.writeFile(path.join(outboxDirectory, "execution-safe.json"), "preserve", "utf8");
    const logger = new StructuredTaskLogger({
      logDirectory,
      maxFileBytes: 200,
      retentionDays: 14
    });
    const record = {
      timestamp: "2026-08-03T00:00:00.000Z",
      event: "TASK_COMPLETED" as const,
      workerId: "worker",
      brandId: "brand",
      businessGroupId: "group",
      platform: "doubao" as const,
      conversationGroupId: "conversation",
      questionIndex: 1,
      actualQuestion: "问题",
      durationMs: 1,
      referenceCount: 0,
      retryCount: 0,
      errorCode: null
    };
    await logger.write(record);
    await logger.write(record);
    await logger.flush();
    assert.ok((await fs.readdir(logDirectory)).length >= 2);
    assert.equal(await fs.readFile(path.join(outboxDirectory, "execution-safe.json"), "utf8"), "preserve");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("观察执行器为成功和零引用任务写入完整结构化字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-observability-"));
  try {
    const logger = new StructuredTaskLogger({
      logDirectory: path.join(root, "logs"),
      maxQuestionChars: 80
    });
    const evidenceStore = new FailureEvidenceStore({
      evidenceDirectory: path.join(root, "evidence")
    });
    const observed = createObservedPlatformTaskExecutor({
      logger,
      evidenceStore,
      getPage: () => undefined,
      getMetadata: () => ({
        workerId: "worker-doubao-1",
        conversationGroupId: "conversation-A-1",
        actualQuestion: "品牌 A 的问题 password=private",
        requestedDeepThinking: true,
        webSearchRequested: true
      }),
      executeTask: () => ({
        status: "zero_references",
        referenceCount: 0,
        retryCount: 0,
        submittedQuestion: "品牌 A 的问题 password=private",
        requestedDeepThinking: true,
        actualDeepThinking: true,
        webSearchRequested: true,
        webSearchEnabled: true,
        webSearchVerified: true
      })
    });
    const layer = new MultiPlatformExecutionLayer({
      platforms: ["doubao"],
      executeTask: observed
    });
    layer.enqueue({
      id: "A1",
      brandId: "A",
      businessGroupId: "business-1",
      platformId: "doubao",
      question: "品牌 A 的问题"
    });

    assert.equal((await layer.runNext("doubao")).kind, "completed");
    await logger.flush();
    const lines = (await fs.readFile(logger.outputPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(record.event, "TASK_COMPLETED");
    assert.equal(record.workerId, "worker-doubao-1");
    assert.equal(record.brandId, "A");
    assert.equal(record.businessGroupId, "business-1");
    assert.equal(record.platform, "doubao");
    assert.equal(record.conversationGroupId, "conversation-A-1");
    assert.equal(record.questionIndex, 1);
    assert.equal(record.referenceCount, 0);
    assert.equal(record.retryCount, 0);
    assert.equal(record.errorCode, null);
    assert.equal(record.requestedDeepThinking, true);
    assert.equal(record.actualDeepThinking, true);
    assert.equal(record.webSearchRequested, true);
    assert.equal(record.webSearchEnabled, true);
    assert.equal(record.webSearchVerified, true);
    assert.doesNotMatch(String(record.actualQuestion), /private/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("技术失败保存截图与受限诊断，并暂停相应平台", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-evidence-"));
  try {
    const fakePage = {
      url: () => "https://chat.example.com/path?session=secret#message",
      screenshot: async ({ path: screenshotPath }: { path: string }) => {
        await fs.writeFile(screenshotPath, "fake-png", "utf8");
      },
      locator: () => ({
        innerText: async () =>
          `请先登录 password=secret ${"诊断文本".repeat(100)}`
      })
    } as unknown as Page;
    const logger = new StructuredTaskLogger({ logDirectory: path.join(root, "logs") });
    const evidenceStore = new FailureEvidenceStore({
      evidenceDirectory: path.join(root, "evidence"),
      maxDiagnosticChars: 120
    });
    const observed = createObservedPlatformTaskExecutor({
      logger,
      evidenceStore,
      getPage: () => fakePage,
      getMetadata: () => ({
        workerId: "worker-qianwen-1",
        conversationGroupId: "conversation-Q-1"
      }),
      executeTask: () => {
        throw new Error("请先登录后继续使用");
      }
    });
    const layer = new MultiPlatformExecutionLayer({
      platforms: ["qianwen"],
      executeTask: observed
    });
    layer.enqueue({
      id: "Q1",
      brandId: "Q",
      businessGroupId: "business-Q",
      platformId: "qianwen",
      question: "实际问题"
    });

    const result = await layer.runNext("qianwen");
    assert.equal(result.kind, "failed");
    assert.equal(layer.getPlatformHealth("qianwen").status, "LOGIN_REQUIRED");
    await logger.flush();
    const record = JSON.parse(
      (await fs.readFile(logger.outputPath, "utf8")).trim()
    ) as { errorCode: string; screenshotPath: string; diagnosticPath: string };
    assert.equal(record.errorCode, "LOGIN_REQUIRED");
    assert.ok(record.screenshotPath.endsWith(".png"));
    assert.ok(record.diagnosticPath.endsWith(".json"));
    assert.equal((await fs.stat(record.screenshotPath)).isFile(), true);

    const diagnostic = JSON.parse(
      await fs.readFile(record.diagnosticPath, "utf8")
    ) as { currentUrl: string; pageText: string; pageTextTruncated: boolean };
    assert.doesNotMatch(diagnostic.currentUrl, /secret|#message/);
    assert.doesNotMatch(diagnostic.pageText, /password=secret/);
    assert.ok(diagnostic.pageText.length <= 120);
    assert.equal(diagnostic.pageTextTruncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("executeQuestion 结果适配器保留实际问题、引用数和重试数", () => {
  const outcome = platformTaskOutcomeFromQuestionResult({
    questionIndex: 0,
    question: "原始问题",
    status: "no_references",
    referenceStatus: "CONFIRMED_EMPTY",
    attemptCount: 3,
    references: [],
    submittedQuestion: "实际发送的问题",
    requestedDeepThinking: true,
    actualDeepThinking: true,
    webSearchRequested: true,
    webSearchEnabled: true,
    webSearchVerified: true,
    webSearchFailureReason: null
  }, "conversation-1");
  assert.equal(outcome.status, "zero_references");
  assert.equal(outcome.referenceCount, 0);
  assert.equal(outcome.retryCount, 2);
  assert.equal(outcome.submittedQuestion, "实际发送的问题");
  assert.equal(outcome.conversationGroupId, "conversation-1");
  assert.equal(outcome.requestedDeepThinking, true);
  assert.equal(outcome.actualDeepThinking, true);
  assert.equal(outcome.webSearchRequested, true);
  assert.equal(outcome.webSearchEnabled, true);
  assert.equal(outcome.webSearchVerified, true);
});

test("引用 UNKNOWN 不能被适配为空引用成功", () => {
  assert.throws(() => platformTaskOutcomeFromQuestionResult({
    questionIndex: 0,
    question: "问题",
    status: "no_references",
    attemptCount: 1,
    references: [],
    referenceStatus: "UNKNOWN",
    submittedQuestion: "问题",
    requestedDeepThinking: false,
    actualDeepThinking: false,
    webSearchRequested: true,
    webSearchEnabled: true,
    webSearchVerified: true,
    webSearchFailureReason: null
  }, "conversation"), /引用状态 UNKNOWN/);
});

test("自检证据处理器会为失败的启动检查生成诊断文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-selfcheck-evidence-"));
  try {
    const fakePage = {
      url: () => "https://example.com/login?token=secret",
      screenshot: async ({ path: screenshotPath }: { path: string }) => {
        await fs.writeFile(screenshotPath, "png", "utf8");
      },
      locator: () => ({
        innerText: async () => "请先登录"
      })
    } as unknown as Page;
    const evidenceStore = new FailureEvidenceStore({
      evidenceDirectory: path.join(root, "evidence")
    });
    const handler = createSelfCheckEvidenceHandler({
      evidenceStore,
      getWorkerId: () => "worker-1"
    });

    await handler({
      platformId: "qianwen",
      ready: false,
      errorCode: "LOGIN_REQUIRED",
      healthStatus: "LOGIN_REQUIRED",
      reason: "请先登录"
    }, fakePage);

    const files = await fs.readdir(path.join(root, "evidence"));
    assert.equal(files.length, 1);
    const dayDirectory = path.join(root, "evidence", files[0]!);
    const platforms = await fs.readdir(dayDirectory);
    assert.deepEqual(platforms, ["qianwen"]);
    const nested = await fs.readdir(path.join(dayDirectory, platforms[0]!));
    assert.ok(nested.some((entry) => entry.endsWith(".json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
