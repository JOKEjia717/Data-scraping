/**
 * CLI 参数与问题文件解析。命令行统一采用 --key=value；research 问题文件支持
 * JSON 字符串数组或纯文本，business 使用带执行身份的 JSON 品牌批次。
 */
import fs from "node:fs/promises";
import {
  getCollectionModeDefaults,
  normalizeBusinessBatches
} from "./execution.js";
import type {
  CliOptions,
  CollectionMode,
  CrawlBatch,
  DeepThinkingUnsupportedPolicy,
  PlatformId,
  WebSearchPolicy
} from "./types.js";

const DEFAULT_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
const ALL_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];

/** 将原始命令行参数转换为带默认值、可直接传给爬虫的配置。 */
export async function parseCli(argv: string[]): Promise<CliOptions> {
  const args = new Map<string, string>();
  for (const item of argv) {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }

  const mode = parseCollectionMode(args.get("mode"));
  const modeDefaults = getCollectionModeDefaults(mode);
  return {
    mode,
    cdpEndpoint: args.get("cdp") || "http://127.0.0.1:9222",
    outDir: args.get("out") || "results",
    platforms: parsePlatforms(args.get("platforms")),
    questionFile: args.get("questions"),
    promptPrefix: args.get("prompt-prefix") ?? modeDefaults.promptPrefix,
    retryOnNoReferences: modeDefaults.retryOnNoReferences,
    regenerateOnNoReferences: modeDefaults.regenerateOnNoReferences,
    resolveTitles: args.get("resolve-titles") !== "false",
    timeoutMs: Number(args.get("timeout-ms") || 300_000),
    // 四个平台默认关闭深度思考；仍允许通过 CLI 为特定运行显式开启。
    deepThinking: parseBoolean(args.get("deep-thinking") ?? "false", "deep-thinking"),
    deepThinkingUnsupportedPolicy: parseDeepThinkingUnsupportedPolicy(
      args.get("deep-thinking-unsupported-policy")
    ),
    ...(args.has("web-search-policy")
      ? { webSearchPolicy: parseWebSearchPolicy(args.get("web-search-policy")!) }
      : {}),
    verbose: mode === "research" && parseBoolean(args.get("verbose") ?? "true", "verbose"),
    databaseEnabled: args.get("database") !== "false",
    batchName: normalizeOptionalValue(args.get("batch-name"))
  };
}

/** business 模式只接受带租户、业务任务和品牌身份的 JSON 批次。 */
export async function readBusinessBatchFile(filePath: string): Promise<CrawlBatch[]> {
  if (!filePath.endsWith(".json")) {
    throw new Error("business 模式的 --questions 必须指向 JSON 批次文件。");
  }
  const content = await fs.readFile(filePath, "utf8");
  return normalizeBusinessBatches(JSON.parse(content) as unknown);
}

/** 读取自定义问题库；JSON 会额外校验顶层必须是字符串数组。 */
export async function readQuestionFile(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("JSON 问题文件必须是字符串数组。");
    }
    return parsed;
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 校验逗号分隔的平台 ID，防止未知值在运行中才触发空配置错误。 */
function parsePlatforms(value?: string): PlatformId[] {
  if (!value) return DEFAULT_PLATFORMS;
  const platforms = value.split(",").map((item) => item.trim()).filter(Boolean) as PlatformId[];
  const unknown = platforms.filter((item) => !ALL_PLATFORMS.includes(item));
  if (unknown.length > 0) {
    throw new Error(`未知平台：${unknown.join(", ")}。可选值：${ALL_PLATFORMS.join(", ")}`);
  }
  // 并发模式下重复平台会操作同一个标签页，必须在入口处去重。
  return [...new Set(platforms)];
}

function parseCollectionMode(value?: string): CollectionMode {
  if (!value || value === "research") return "research";
  if (value === "business") return "business";
  throw new Error("未知执行模式。--mode 可选值：research、business");
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} 只能是 true 或 false。`);
}

function parseDeepThinkingUnsupportedPolicy(
  value?: string
): DeepThinkingUnsupportedPolicy {
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

/** 把只包含空白的可选参数视为未配置，避免创建没有名称的数据库批次。 */
function normalizeOptionalValue(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
