/** 可运行的本地 Mock RPA Worker CLI；只读任务 JSON，结果写本地文件。 */
import { executeQuestion } from "./crawler.js";
import { pathToFileURL } from "node:url";
import { runBrowserSelfCheck } from "./browserDiagnostics.js";
import { createPageConversationManager } from "./conversationManager.js";
import {
  InMemoryMockTaskSource,
  JsonMockTaskSource,
  MockExecutionStateStore,
  MockRpaWorker,
  resolveMockPlatformId,
  type MockQuestionExecutor
} from "./mockRpaWorker.js";
import { PLATFORMS } from "./platforms.js";
import type {
  DeepThinkingUnsupportedPolicy,
  WebSearchPolicy
} from "./types.js";
import { webSearchPolicyForBusinessType } from "./webSearch.js";
import { safeErrorSummary } from "./consolePrivacy.js";

interface MockRpaCliOptions {
  taskFile: string;
  outputDirectory: string;
  cdpEndpoint: string;
  timeoutMs: number;
  taskIntervalMs: number;
  batchIntervalMs: number;
  deepThinkingUnsupportedPolicy: DeepThinkingUnsupportedPolicy;
  diagnosisWebSearchPolicy: WebSearchPolicy;
}

export async function runMockRpaCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseMockRpaCli(argv);
  const tasks = await new JsonMockTaskSource(options.taskFile).load();
  const usedPlatforms = [...new Set(tasks.map(resolveMockPlatformId))];
  const selfCheck = await runBrowserSelfCheck({
    cdpEndpoint: options.cdpEndpoint,
    platforms: usedPlatforms.map((platformId) => PLATFORMS[platformId])
  });
  const unavailable = usedPlatforms.flatMap((platformId) => {
    const result = selfCheck.platforms[platformId];
    return result?.ready
      ? []
      : [`${PLATFORMS[platformId].name}: ${result?.errorCode ?? "SELF_CHECK_FAILED"}`];
  });
  if (unavailable.length > 0) {
    throw new Error(`Mock Worker 启动自检未通过：${unavailable.join("；")}`);
  }

  const conversationManagers = Object.fromEntries(
    usedPlatforms.map((platformId) => {
      const page = selfCheck.platforms[platformId]?.page;
      if (!page) throw new Error(`自检没有返回 ${platformId} 页面。`);
      return [
        platformId,
        createPageConversationManager(page, PLATFORMS[platformId])
      ];
    })
  );
  const executeMockQuestion: MockQuestionExecutor = async (context) => {
    const page = selfCheck.platforms[context.platformId]?.page;
    if (!page) throw new Error(`${context.platformId} 页面不可用。`);
    const result = await executeQuestion(
      {
        questionIndex: context.questionIndex - 1,
        question: context.task.keyword
      },
      {
        page,
        config: PLATFORMS[context.platformId],
        mode: "business",
        promptPrefix: "",
        retryOnNoReferences: false,
        regenerateOnNoReferences: false,
        resolveTitles: true,
        timeoutMs: options.timeoutMs,
        deepThinking: context.task.deepThinking,
        deepThinkingUnsupportedPolicy: options.deepThinkingUnsupportedPolicy,
        webSearchPolicy: webSearchPolicyForBusinessType(
          context.task.businessType,
          options.diagnosisWebSearchPolicy
        )
      }
    );
    return {
      submittedQuestion: result.submittedQuestion,
      answer: result.answer?.answer ?? "",
      references: result.references,
      referenceCount: result.answer?.referenceCount ?? result.references.length,
      retryCount: Math.max(0, result.attemptCount - 1),
      actualDeepThinking: result.actualDeepThinking,
      webSearchRequested: result.webSearchRequested,
      webSearchEnabled: result.webSearchEnabled,
      webSearchVerified: result.webSearchVerified
    };
  };
  const perPlatformConfig = Object.fromEntries(
    usedPlatforms.map((platformId) => [
      platformId,
      {
        taskIntervalMs: options.taskIntervalMs,
        batchIntervalMs: options.batchIntervalMs
      }
    ])
  );
  const worker = new MockRpaWorker({
    taskSource: new InMemoryMockTaskSource(tasks),
    conversationManagers,
    executeQuestion: executeMockQuestion,
    stateStore: new MockExecutionStateStore({
      outputDirectory: options.outputDirectory
    }),
    platformConfig: perPlatformConfig
  });

  const result = await worker.run();
  const successCount = result.executionStates.filter(({ status }) => status === "SUCCESS").length;
  const failedCount = result.executionStates.filter(({ status }) => status === "FAILED").length;
  console.log(
    `Mock RPA Worker 完成：成功 ${successCount}，失败 ${failedCount}；` +
    `本地结果目录 ${options.outputDirectory}`
  );
}

export function parseMockRpaCli(argv: readonly string[]): MockRpaCliOptions {
  const args = new Map<string, string>();
  for (const item of argv) {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }
  return {
    taskFile: args.get("tasks") ?? "examples/mock-rpa-tasks.json",
    outputDirectory: args.get("out") ?? "mock-rpa-output",
    cdpEndpoint: args.get("cdp") ?? "http://127.0.0.1:9222",
    timeoutMs: positiveNumber(args.get("timeout-ms"), 300_000, "timeout-ms"),
    taskIntervalMs: nonNegativeNumber(
      args.get("task-interval-ms"),
      1_000,
      "task-interval-ms"
    ),
    batchIntervalMs: nonNegativeNumber(
      args.get("batch-interval-ms"),
      3_000,
      "batch-interval-ms"
    ),
    deepThinkingUnsupportedPolicy: parseUnsupportedPolicy(
      args.get("deep-thinking-unsupported-policy")
    ),
    diagnosisWebSearchPolicy: parseWebSearchPolicy(
      args.get("web-search-policy") ?? "PREFERRED"
    )
  };
}

function parseUnsupportedPolicy(value?: string): DeepThinkingUnsupportedPolicy {
  if (!value || value === "fail") return "fail";
  if (value === "allow_degrade") return "allow_degrade";
  throw new Error(
    "--deep-thinking-unsupported-policy 只能是 fail 或 allow_degrade。"
  );
}

function parseWebSearchPolicy(value: string): WebSearchPolicy {
  const normalized = value.trim().toUpperCase();
  if (normalized === "REQUIRED" || normalized === "PREFERRED" || normalized === "DISABLED") {
    return normalized;
  }
  throw new Error("--web-search-policy 只能是 REQUIRED、PREFERRED 或 DISABLED。");
}

function positiveNumber(value: string | undefined, fallback: number, field: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`--${field} 必须大于 0。`);
  }
  return resolved;
}

function nonNegativeNumber(
  value: string | undefined,
  fallback: number,
  field: string
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`--${field} 必须大于等于 0。`);
  }
  return resolved;
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runMockRpaCli()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(safeErrorSummary(error));
      process.exit(1);
    });
}
