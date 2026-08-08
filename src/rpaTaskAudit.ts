/** RPA 仓储查询/领取的本地 JSONL 审计；不记录 keyword 或数据库凭据。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RpaBusinessType, RpaWorkerType } from "./rpaTask.js";

export interface RpaTaskAuditEvent {
  timestamp: string;
  event:
    | "PENDING_QUERY"
    | "CLAIM_ATTEMPT"
    | "CLAIM_SKIPPED_PAUSED"
    | "INVALID_EXECUTION_CONTEXT"
    | "LEGACY_BUSINESS_TYPE_FALLBACK"
    | "BUSINESS_TYPE_MISMATCH";
  workerType: RpaWorkerType;
  businessType: RpaBusinessType;
  candidateCount?: number;
  executionId?: string;
  claimed?: boolean;
  executionBusinessType?: RpaBusinessType;
  dispatchBusinessType?: RpaBusinessType;
}

export interface RpaTaskAuditSink {
  write(event: RpaTaskAuditEvent): Promise<void>;
}

export interface JsonlRpaTaskAuditOptions {
  logDirectory: string;
  fileName?: string;
  now?: () => number;
}

export class JsonlRpaTaskAuditLogger implements RpaTaskAuditSink {
  private readonly filePath: string;
  private readonly now: () => number;
  private pendingWrite = Promise.resolve();

  constructor(options: JsonlRpaTaskAuditOptions) {
    if (!options.logDirectory.trim()) throw new Error("RPA 审计日志目录不能为空。");
    const fileName = options.fileName ?? "rpa-task-repository.jsonl";
    if (!/^[\w.-]+\.jsonl$/i.test(fileName)) {
      throw new Error("RPA 审计日志文件名必须是安全的 .jsonl 文件名。");
    }
    this.filePath = path.resolve(options.logDirectory, fileName);
    this.now = options.now ?? Date.now;
  }

  get outputPath(): string {
    return this.filePath;
  }

  write(event: RpaTaskAuditEvent): Promise<void> {
    const normalized: RpaTaskAuditEvent = {
      ...event,
      timestamp: event.timestamp || new Date(this.now()).toISOString(),
      ...(event.executionId === undefined
        ? {}
        : { executionId: event.executionId.slice(0, 64) })
    };
    const operation = this.pendingWrite.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8");
    });
    this.pendingWrite = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }
}
