/** 正式 RPA 任务级失败分类；纯函数，避免数据库、页面与平台状态互相串错。 */
import type { WorkerErrorCode } from "./browserDiagnostics.js";

export type RpaFailureCode =
  | WorkerErrorCode
  | "INPUT_NOT_FOUND"
  | "BROWSER_DISCONNECTED"
  | "DATABASE_ERROR"
  | "ZERO_REFERENCES"
  | "POST_SUBMIT_UNCERTAIN";

export type RpaFailureRoute = "retry_task" | "pause_platform" | "result_outbox" | "success";

export function routeRpaFailure(code: RpaFailureCode): RpaFailureRoute {
  if (code === "DATABASE_ERROR") return "result_outbox";
  if (code === "ZERO_REFERENCES") return "success";
  if (
    code === "CAPTCHA_REQUIRED" ||
    code === "LOGIN_REQUIRED" ||
    code === "RATE_LIMITED" ||
    code === "ANONYMOUS_QUOTA_EXCEEDED" ||
    code === "DOM_CHANGED" ||
    code === "WEB_SEARCH_UNSUPPORTED" ||
    code === "WEB_SEARCH_UNVERIFIED" ||
    code === "REFERENCE_UNKNOWN" ||
    code === "PLATFORM_TAB_MISSING"
  ) {
    return "pause_platform";
  }
  return "retry_task";
}

/** failCount 是本次领取前已有失败次数；每次任务失败使用指数退避。 */
export function taskRetryBackoffMs(baseMs: number, failCount: number): number {
  if (!Number.isSafeInteger(baseMs) || baseMs < 0) {
    throw new Error("retryBackoffMs 必须是非负整数。");
  }
  if (!Number.isSafeInteger(failCount) || failCount < 0) {
    throw new Error("failCount 必须是非负整数。");
  }
  return Math.min(3_600_000, baseMs * (2 ** Math.min(failCount, 16)));
}

export function taskRetryDelayMs(
  baseMs: number,
  failCount: number,
  jitterMs: number,
  random: () => number = Math.random
): number {
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0) {
    throw new Error("retryJitterMs 必须是非负整数。");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error("random 必须返回 0 到 1。 ");
  }
  return Math.min(3_600_000, taskRetryBackoffMs(baseMs, failCount) + Math.floor(sample * jitterMs));
}
