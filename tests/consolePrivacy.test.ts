import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  attachConsoleSecrets,
  privacyDebugLog,
  rpaConsoleError,
  runWithConsolePrivacy,
  safeExecutionId
} from "../src/consolePrivacy.js";
import { extractReferences } from "../src/extractReferences.js";
import { StructuredTaskLogger } from "../src/workerObservability.js";

interface CapturedConsole {
  lines: string[];
  restore(): void;
}

function captureConsole(): CapturedConsole {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  return {
    lines,
    restore() {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  };
}

test("business 异步上下文抑制完整问题、回答和引用 URL，且不改变抽取结果", async () => {
  const question = "机密问题 password=question-secret";
  const answer = "机密回答 token=answer-secret";
  const sensitiveUrl = "https://example.com/report?code=url-secret&session=session-secret";
  const captured = captureConsole();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
        <div>搜索 1 个关键词，参考 1 篇资料</div>
        <div class="relative mt-[-8px] flex w-full min-w-0 flex-col">
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="${sensitiveUrl}">敏感引用标题</a>
          </div>
        </div>
      </div>
    `);
    const records = await runWithConsolePrivacy(
      { mode: "business", verbose: true },
      async () => {
        privacyDebugLog(question, answer, sensitiveUrl);
        return extractReferences(page, question, "豆包", 0);
      }
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.question, question);
    assert.equal(records[0]?.url.includes("url-secret"), true, "隐私边界不能改写采集结果");
    assert.equal(captured.lines.join("\n"), "");
    await page.close();
  } finally {
    captured.restore();
    await browser?.close();
  }
});

test("research verbose 保留调试输出，显式关闭 verbose 后保持安静", async () => {
  const captured = captureConsole();
  try {
    await runWithConsolePrivacy({ mode: "research", verbose: true }, async () => {
      privacyDebugLog("research-visible");
      await Promise.resolve();
    });
    await runWithConsolePrivacy({ mode: "research", verbose: false }, async () => {
      privacyDebugLog("research-hidden");
      await Promise.resolve();
    });
    assert.match(captured.lines.join("\n"), /research-visible/);
    assert.doesNotMatch(captured.lines.join("\n"), /research-hidden/);
  } finally {
    captured.restore();
  }
});

test("正式 RPA 控制台只输出白名单字段并遮蔽 execution、问题、凭据和 URL 参数", () => {
  const executionId = "execution-raw-private-9988";
  const question = "完整机密问题：下一季度未发布产品是什么？";
  const captured = captureConsole();
  try {
    const error = attachConsoleSecrets(new Error(
      `${question} password=console-secret ` +
      "https://example.com/callback?token=url-token&code=url-code&auth=url-auth"
    ), [question]);
    rpaConsoleError({
      workerId: "diagnosis-worker",
      event: "TASK_FAILED",
      executionId,
      brandId: "brand-a",
      platformId: "doubao",
      batchProgress: "question=2/5",
      errorCode: "ANSWER_TIMEOUT",
      error
    });
  } finally {
    captured.restore();
  }

  const output = captured.lines.join("\n");
  assert.match(output, /diagnosis-worker|brand-a|doubao|ANSWER_TIMEOUT/);
  assert.match(output, new RegExp(safeExecutionId(executionId)));
  assert.doesNotMatch(output, new RegExp(executionId));
  for (const secret of [question, "console-secret", "url-token", "url-code", "url-auth"]) {
    assert.equal(output.includes(secret), false);
  }
  assert.ok(output.length < 1_000);
  const parsed = JSON.parse(output.replace(/^\[RPA\] /, "")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "batchProgress",
    "brandId",
    "errorCode",
    "errorSummary",
    "executionId",
    "platformId",
    "workerId"
  ]);
});

test("结构化 JSONL 对问题和错误中的 password、token、code、key、session、auth 脱敏限长", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-privacy-jsonl-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logger = new StructuredTaskLogger({
    logDirectory: root,
    maxQuestionChars: 180,
    maxErrorChars: 180
  });
  await logger.write({
    timestamp: "2026-08-03T00:00:00.000Z",
    event: "TASK_FAILED",
    workerId: "worker-1",
    brandId: "brand-1",
    businessGroupId: "business-1",
    platform: "yuanbao",
    conversationGroupId: "conversation-1",
    questionIndex: 1,
    actualQuestion:
      "问题 password=json-password https://example.com/q?token=json-token&code=json-code",
    requestedDeepThinking: false,
    actualDeepThinking: false,
    webSearchRequested: true,
    webSearchEnabled: false,
    webSearchVerified: false,
    durationMs: 1,
    referenceCount: 0,
    retryCount: 0,
    errorCode: "WEB_SEARCH_UNVERIFIED",
    errorMessage:
      "key=json-key session=json-session auth=json-auth " + "超长诊断".repeat(100)
  });
  await logger.flush();

  const output = await fs.readFile(logger.outputPath, "utf8");
  for (const secret of [
    "json-password",
    "json-token",
    "json-code",
    "json-key",
    "json-session",
    "json-auth"
  ]) {
    assert.equal(output.includes(secret), false);
  }
  const record = JSON.parse(output) as { actualQuestion: string; errorMessage: string };
  assert.ok(record.actualQuestion.length <= 180);
  assert.ok(record.errorMessage.length <= 180);
});
