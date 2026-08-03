/** 普通控制台的隐私边界：business 抑制详细抓取日志，正式 Worker 只输出白名单字段。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { CollectionMode, PlatformId } from "./types.js";

export interface CollectionConsoleContext {
  mode: CollectionMode;
  verbose: boolean;
}

export interface RpaConsoleRecord {
  workerId: string;
  event: string;
  executionId?: string;
  brandId?: string;
  platformId?: PlatformId;
  batchProgress?: string;
  errorCode?: string;
  error?: unknown;
  /** 已知问题等任意文本，必须从错误摘要中完整移除。 */
  secrets?: readonly string[];
}

const contexts = new AsyncLocalStorage<CollectionConsoleContext>();
const MAX_ERROR_CHARS = 320;
const MAX_PROGRESS_CHARS = 180;
const CONSOLE_SECRETS = Symbol("consoleSecrets");

export function runWithConsolePrivacy<T>(
  context: CollectionConsoleContext,
  operation: () => T
): T {
  return contexts.run(context, operation);
}

/** research 默认保留历史调试输出；business 无条件抑制详细日志。 */
export function privacyDebugLog(...values: unknown[]): void {
  const context = contexts.getStore();
  if (context?.mode === "business" || context?.verbose === false) return;
  globalThis.console.log(...values);
}

export function safeExecutionId(value: string): string {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  return `exec_${digest}`;
}

/** 错误摘要脱敏、URL 查询参数遮蔽、单行限长，并可移除当前任务问题原文。 */
export function safeErrorSummary(
  error: unknown,
  secrets: readonly string[] = []
): string {
  let message = error instanceof Error ? error.message : String(error);
  const allSecrets = [...readAttachedSecrets(error), ...secrets];
  for (const secret of allSecrets) {
    if (!secret) continue;
    message = message.split(secret).join("[REDACTED_TEXT]");
  }
  message = sanitizeSensitiveText(message)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeConsoleUrl(url))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return limit(message || "unknown error", MAX_ERROR_CHARS);
}

/** 把问题原文附着到异常上，后续任何普通控制台摘要都会自动完整移除。 */
export function attachConsoleSecrets<T>(error: T, secrets: readonly string[]): T {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  const existing = readAttachedSecrets(error);
  try {
    Object.defineProperty(error, CONSOLE_SECRETS, {
      value: [...new Set([...existing, ...secrets.filter(Boolean)])],
      configurable: true
    });
  } catch {
    // 冻结的第三方 Error 不能附加元数据；保留原异常，不能让日志保护掩盖业务错误。
  }
  return error;
}

export function rpaConsoleInfo(record: RpaConsoleRecord): void {
  writeRpaConsole("log", record);
}

export function rpaConsoleWarn(record: RpaConsoleRecord): void {
  writeRpaConsole("warn", record);
}

export function rpaConsoleError(record: RpaConsoleRecord): void {
  writeRpaConsole("error", record);
}

function writeRpaConsole(
  level: "log" | "warn" | "error",
  record: RpaConsoleRecord
): void {
  const progress = [safeEvent(record.event), record.batchProgress]
    .filter((value): value is string => Boolean(value))
    .join(": ");
  const output = {
    workerId: safeIdentifier(record.workerId),
    ...(record.executionId === undefined
      ? {}
      : { executionId: safeExecutionId(record.executionId) }),
    ...(record.brandId === undefined
      ? {}
      : { brandId: safeIdentifier(record.brandId) }),
    ...(record.platformId === undefined ? {} : { platformId: record.platformId }),
    batchProgress: limit(sanitizeSensitiveText(progress), MAX_PROGRESS_CHARS),
    ...(record.errorCode === undefined
      ? {}
      : { errorCode: safeEvent(record.errorCode) }),
    ...(record.error === undefined
      ? {}
      : { errorSummary: safeErrorSummary(record.error, record.secrets) })
  };
  globalThis.console[level](`[RPA] ${JSON.stringify(output)}`);
}

function sanitizeSensitiveText(value: string): string {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|code|key|auth|secret|password|passwd|cookie|session)\s*[:=]\s*[^\s,;&]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[REDACTED_PHONE]")
    .replace(/\u0000/g, "");
}

function readAttachedSecrets(error: unknown): readonly string[] {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return [];
  const value = (error as Record<PropertyKey, unknown>)[CONSOLE_SECRETS];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function sanitizeConsoleUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|code|key|secret|password|passwd|session|cookie|auth/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

function safeIdentifier(value: string): string {
  return limit(sanitizeSensitiveText(String(value)).replace(/[\r\n\t]+/g, " "), 128);
}

function safeEvent(value: string): string {
  const normalized = String(value).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return normalized || "UNKNOWN";
}

function limit(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
