import fs from "node:fs/promises";
import type { CliOptions, PlatformId } from "./types.js";

const DEFAULT_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
const ALL_PLATFORMS: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
const DEFAULT_PROMPT_PREFIX = "";

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

function parsePlatforms(value?: string): PlatformId[] {
  if (!value) return DEFAULT_PLATFORMS;
  const platforms = value.split(",").map((item) => item.trim()).filter(Boolean) as PlatformId[];
  const unknown = platforms.filter((item) => !ALL_PLATFORMS.includes(item));
  if (unknown.length > 0) {
    throw new Error(`未知平台：${unknown.join(", ")}。可选值：${ALL_PLATFORMS.join(", ")}`);
  }
  return platforms;
}
