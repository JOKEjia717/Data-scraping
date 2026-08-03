import { statfs } from "node:fs/promises";
import path from "node:path";
import type { WorkerErrorCode } from "./browserDiagnostics.js";

export type DiskSpaceStatus = "OK" | "WARNING" | "STOP_CLAIMING";

export interface DiskSpaceResult {
  status: DiskSpaceStatus;
  freeBytes: number;
  warningBytes: number;
  stopBytes: number;
}

export async function checkDiskSpace(
  targetPath: string,
  warningBytes: number,
  stopBytes: number
): Promise<DiskSpaceResult> {
  if (warningBytes < stopBytes || stopBytes < 0) {
    throw Object.assign(new Error("磁盘阈值配置无效"), {
      errorCode: "CONFIGURATION_ERROR" satisfies WorkerErrorCode
    });
  }
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stats = await statfs(current);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return {
        status: freeBytes <= stopBytes
          ? "STOP_CLAIMING"
          : freeBytes <= warningBytes ? "WARNING" : "OK",
        freeBytes,
        warningBytes,
        stopBytes
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if (code !== "ENOENT" || parent === current) throw error;
      current = parent;
    }
  }
}

export function classifyRuntimeError(error: unknown): WorkerErrorCode {
  const explicit = error && typeof error === "object" && "errorCode" in error
    ? String((error as { errorCode?: unknown }).errorCode)
    : "";
  const supported: WorkerErrorCode[] = [
    "DATABASE_ERROR", "CDP_CONNECTION_FAILED", "BROWSER_DISCONNECTED", "PAGE_DISCONNECTED",
    "FILESYSTEM_ERROR", "CONFIGURATION_ERROR", "OUTBOX_CORRUPTED",
    "PLATFORM_BLOCKED", "LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "RATE_LIMITED",
    "DOM_CHANGED", "REFERENCE_UNKNOWN"
  ];
  if ((supported as string[]).includes(explicit)) return explicit as WorkerErrorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOSPC|EDQUOT|EACCES|EPERM|EROFS|disk|filesystem/i.test(message)) {
    return "FILESYSTEM_ERROR";
  }
  if (/mysql|database|ECONNRESET|PROTOCOL_CONNECTION_LOST/i.test(message)) {
    return "DATABASE_ERROR";
  }
  return "TECHNICAL_FAILURE";
}
