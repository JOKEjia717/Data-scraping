/**
 * CLI 参数与问题文件解析。命令行统一采用 --key=value，问题文件支持
 * JSON 字符串数组或一行一个问题的纯文本格式。
 */
import fs from "node:fs/promises";
import type { CliOptions, PlatformId } from "./types.js";

const DEFAULT_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
const ALL_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
const DEFAULT_PROMPT_PREFIX = "请联网搜索后回答，并提供可点击的参考来源。问题：";

/** 将原始命令行参数转换为带默认值、可直接传给爬虫的配置。 */
export async function parseCli(argv: string[]): Promise<CliOptions> {
  const args = new Map<string, string>();
  for (const item of argv) {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }

  return {
    cdpEndpoint: args.get("cdp") || "http://127.0.0.1:9222",
    outDir: args.get("out") || "results",
    platforms: parsePlatforms(args.get("platforms")),
    questionFile: args.get("questions"),
    promptPrefix: args.get("prompt-prefix") ?? DEFAULT_PROMPT_PREFIX,
    resolveTitles: args.get("resolve-titles") !== "false",
    timeoutMs: Number(args.get("timeout-ms") || 300_000)
  };
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
  return platforms;
}
