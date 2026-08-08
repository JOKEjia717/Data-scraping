/**
 * 正式 RPA Worker 的本地结果 Outbox。
 *
 * 页面采集完成后先原子落盘，再尝试 MySQL。目录中只有 rename 完成的 .json
 * 文件会参与重放；崩溃遗留的临时文件永远不会被当作完整结果读取。
 */
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  RpaCollectionResult,
  RpaResultSaveOutcome
} from "./rpaResultRepository.js";
import type { RpaBusinessType } from "./rpaTask.js";
import type { ReferenceRecord } from "./types.js";

const OUTBOX_VERSION = 3;
const COMPLETE_FILE_PATTERN = /^execution-([A-Za-z0-9_-]+)\.json$/;

export interface ResultOutboxEntry {
  version: 3;
  schemaVersion: 3;
  payloadChecksum: string;
  executionId: string;
  dispatchTaskId: string;
  businessType: RpaBusinessType;
  keyword: string;
  answerContent: string;
  references: ReferenceRecord[];
  responseDurationSeconds: number;
  collectedAt: string;
  answerShareUrl: string | null;
  webSearchRequested?: boolean;
  webSearchEnabled?: boolean;
  webSearchVerified?: boolean;
  storedAt: string;
}

export interface OutboxCorruptionRecord {
  fileName: string;
  executionId?: string;
  reason: string;
  discoveredAt: string;
  quarantinePath: string;
}

export interface ResultOutboxOptions {
  directory: string;
  now?: () => Date;
  quarantineDirectoryName?: string;
  onCorrupted?: (record: OutboxCorruptionRecord) => void | Promise<void>;
}

export interface SuccessResultWriter {
  saveSuccess(result: RpaCollectionResult): Promise<RpaResultSaveOutcome>;
}

export interface ResultPersistenceOutcome {
  status: "saved" | "pending";
  databaseOutcome?: RpaResultSaveOutcome;
  error?: unknown;
  /** 数据库已经提交，仅 Outbox 清理失败；保留文件供幂等重放，不得重做页面问答。 */
  cleanupError?: unknown;
}

export interface ResultPersistenceOptions {
  /** Outbox 已落盘后、数据库事务前用于重新确认 execution/platform 所有权。 */
  beforeDatabaseWrite?: () => Promise<void>;
  afterOutboxSave?: () => void | Promise<void>;
  afterDatabaseWrite?: (outcome: RpaResultSaveOutcome) => void | Promise<void>;
}

export interface OutboxReplayFailure {
  executionId: string;
  error: unknown;
}

export interface OutboxReplayResult {
  discoveredCount: number;
  replayedCount: number;
  failures: OutboxReplayFailure[];
  corruptions: OutboxCorruptionRecord[];
}

export class ResultOutboxWriteError extends Error {
  readonly errorCode: string = "FILESYSTEM_ERROR";
  readonly filesystemCode?: string;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ResultOutboxWriteError";
    this.filesystemCode = classifyFilesystemError(cause);
  }
}

export class ResultOutboxConflictError extends ResultOutboxWriteError {
  readonly errorCode = "OUTBOX_CORRUPTED";

  constructor(readonly executionId: string, cause: unknown) {
    super(`同一 executionId 的 Outbox 内容冲突：${executionId}`, cause);
    this.name = "ResultOutboxConflictError";
  }
}

export class ResultOutbox {
  private readonly directory: string;
  private readonly quarantineDirectory: string;
  private readonly now: () => Date;
  private readonly onCorrupted?: ResultOutboxOptions["onCorrupted"];
  private readonly corruptionRecords: OutboxCorruptionRecord[] = [];
  private saveQueue = Promise.resolve();

  constructor(options: ResultOutboxOptions) {
    if (!options.directory.trim()) throw new Error("Result Outbox 目录不能为空。");
    this.directory = path.resolve(options.directory);
    this.quarantineDirectory = path.join(
      this.directory,
      safeDirectoryName(options.quarantineDirectoryName ?? "quarantine")
    );
    this.now = options.now ?? (() => new Date());
    this.onCorrupted = options.onCorrupted;
  }

  get rootDirectory(): string {
    return this.directory;
  }

  /** 先完整写入并 fsync 临时文件，随后通过同目录 rename 原子发布。 */
  async save(input: RpaCollectionResult): Promise<ResultOutboxEntry> {
    const operation = this.saveQueue.then(() => this.saveInternal(input));
    this.saveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveInternal(input: RpaCollectionResult): Promise<ResultOutboxEntry> {
    const entry = normalizeEntry(input, this.now());
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new ResultOutboxWriteError("无法创建 Result Outbox 目录", error);
    }
    const finalPath = this.entryPath(entry.executionId);
    const temporaryPath = path.join(
      this.directory,
      `.execution-${safeExecutionId(entry.executionId)}-${process.pid}-${randomToken()}.tmp`
    );
    let handle;
    try {
      handle = await fs.open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
    } catch (error) {
      throw new ResultOutboxWriteError("无法创建 Result Outbox 临时文件", error);
    }
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new ResultOutboxWriteError("Result Outbox 临时文件写入失败", error);
    }
    await handle.close();
    try {
      const existing = await fs.readFile(finalPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)
      );
      if (existing !== undefined) {
        let existingEntry: ResultOutboxEntry;
        try {
          existingEntry = parseEntry(existing, path.basename(finalPath));
        } catch (error) {
          await this.quarantine(finalPath, path.basename(finalPath), error);
          existingEntry = undefined as never;
        }
        if (existingEntry && existingEntry.payloadChecksum === entry.payloadChecksum) {
          await fs.unlink(temporaryPath);
          return existingEntry;
        }
        if (existingEntry) {
          const record = await this.quarantine(
            temporaryPath,
            path.basename(temporaryPath),
            new Error("同一 executionId 出现不同 payloadChecksum"),
            entry.executionId,
            "conflict"
          );
          throw new ResultOutboxConflictError(entry.executionId, new Error(record.reason));
        }
      }
      await fs.rename(temporaryPath, finalPath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ResultOutboxConflictError) throw error;
      throw new ResultOutboxWriteError("Result Outbox 原子发布失败", error);
    }
    return entry;
  }

  /** 仅枚举已原子发布的文件；.tmp、隐藏文件和其他扩展名全部忽略。 */
  async list(): Promise<ResultOutboxEntry[]> {
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const completeNames = names.filter((name) => COMPLETE_FILE_PATTERN.test(name)).sort();
    const entries: ResultOutboxEntry[] = [];
    for (const name of completeNames) {
      const filePath = path.join(this.directory, name);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const entry = parseEntry(content, name);
        if (name !== path.basename(this.entryPath(entry.executionId))) {
          throw new Error(`Result Outbox 文件名与 executionId 不一致：${name}`);
        }
        entries.push(entry);
      } catch (error) {
        await this.quarantine(filePath, name, error).catch(() => undefined);
      }
    }
    return entries;
  }

  drainCorruptionRecords(): OutboxCorruptionRecord[] {
    return this.corruptionRecords.splice(0, this.corruptionRecords.length);
  }

  async remove(executionId: string): Promise<void> {
    await fs.unlink(this.entryPath(executionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private entryPath(executionId: string): string {
    return path.join(this.directory, `execution-${safeExecutionId(executionId)}.json`);
  }

  private async quarantine(
    sourcePath: string,
    fileName: string,
    error: unknown,
    executionId = executionIdFromFileName(fileName),
    kind = "corrupted"
  ): Promise<OutboxCorruptionRecord> {
    await fs.mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    const discoveredAt = this.now().toISOString();
    const suffix = `${Date.parse(discoveredAt)}-${kind}`;
    const quarantinedName = `${safeQuarantineName(fileName)}.${suffix}`;
    const quarantinePath = path.join(this.quarantineDirectory, quarantinedName);
    await fs.rename(sourcePath, quarantinePath);
    const record: OutboxCorruptionRecord = {
      fileName,
      ...(executionId ? { executionId } : {}),
      reason: boundedReason(error),
      discoveredAt,
      quarantinePath
    };
    await writeMetadataAtomically(`${quarantinePath}.metadata.json`, record);
    this.corruptionRecords.push(record);
    if (this.onCorrupted) {
      await Promise.resolve(this.onCorrupted(record)).catch(() => undefined);
    }
    return record;
  }
}

/**
 * 错误边界：Outbox 落盘成功后，数据库失败被转换成 pending，不再冒充页面失败。
 */
export async function persistResultThroughOutbox(
  result: RpaCollectionResult,
  outbox: ResultOutbox,
  repository: SuccessResultWriter,
  options: ResultPersistenceOptions = {}
): Promise<ResultPersistenceOutcome> {
  await outbox.save(result);
  await options.afterOutboxSave?.();
  let databaseOutcome: RpaResultSaveOutcome;
  try {
    await options.beforeDatabaseWrite?.();
    databaseOutcome = await repository.saveSuccess(result);
  } catch (error) {
    return { status: "pending", error };
  }
  await options.afterDatabaseWrite?.(databaseOutcome);
  try {
    await outbox.remove(result.executionId);
    return { status: "saved", databaseOutcome };
  } catch (cleanupError) {
    // 数据库事务已经成功，删除失败不能倒退成 pending，否则 Worker 会把已保存结果
    // 当成数据库故障。文件保留后由启动重放依赖 saveSuccess 幂等清理。
    return { status: "saved", databaseOutcome, cleanupError };
  }
}

/** 重放只调用结果仓储和清理文件，不接触浏览器、ConversationManager 或采集函数。 */
export async function replayResultOutbox(
  outbox: ResultOutbox,
  repository: SuccessResultWriter
): Promise<OutboxReplayResult> {
  const entries = await outbox.list();
  const failures: OutboxReplayFailure[] = [];
  let replayedCount = 0;
  for (const entry of entries) {
    try {
      await repository.saveSuccess(entry);
      await outbox.remove(entry.executionId);
      replayedCount++;
    } catch (error) {
      failures.push({ executionId: entry.executionId, error });
    }
  }
  const corruptions = outbox.drainCorruptionRecords();
  return {
    discoveredCount: entries.length,
    replayedCount,
    failures,
    corruptions
  };
}

function normalizeEntry(input: RpaCollectionResult, now: Date): ResultOutboxEntry {
  const executionId = requiredText(input.executionId, "executionId", 256);
  const collectedAt = input.collectedAt instanceof Date
    ? input.collectedAt
    : new Date(input.collectedAt);
  if (Number.isNaN(collectedAt.getTime())) throw new Error("collectedAt 不是有效时间。");
  if (!Number.isFinite(input.responseDurationSeconds) || input.responseDurationSeconds < 0) {
    throw new Error("responseDurationSeconds 必须是非负数。");
  }
  if (!Array.isArray(input.references)) throw new Error("references 必须是数组。");
  const payload = {
    version: OUTBOX_VERSION,
    schemaVersion: OUTBOX_VERSION,
    executionId,
    dispatchTaskId: requiredText(input.dispatchTaskId, "dispatchTaskId", 256),
    businessType: requiredBusinessType(input.businessType),
    keyword: requiredText(input.keyword, "keyword", 100_000),
    answerContent: requiredText(input.answerContent, "answerContent", 10_000_000),
    references: input.references.map((reference) => ({ ...reference })),
    responseDurationSeconds: input.responseDurationSeconds,
    collectedAt: collectedAt.toISOString(),
    answerShareUrl: input.answerShareUrl?.trim() || null,
    ...(typeof input.webSearchRequested === "boolean"
      ? { webSearchRequested: input.webSearchRequested }
      : {}),
    ...(typeof input.webSearchEnabled === "boolean"
      ? { webSearchEnabled: input.webSearchEnabled }
      : {}),
    ...(typeof input.webSearchVerified === "boolean"
      ? { webSearchVerified: input.webSearchVerified }
      : {}),
    storedAt: now.toISOString()
  } as const;
  return {
    ...payload,
    payloadChecksum: checksumPayload(payload)
  };
}

function parseEntry(content: string, fileName: string): ResultOutboxEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Result Outbox JSON 损坏：${fileName}`, { cause: error });
  }
  if (!isRecord(parsed) || ![1, 2, OUTBOX_VERSION].includes(Number(parsed.version))) {
    throw new Error(`Result Outbox 版本无效：${fileName}`);
  }
  const normalized = normalizeStoredEntry(parsed, fileName);
  if (parsed.version === OUTBOX_VERSION) {
    if (parsed.schemaVersion !== OUTBOX_VERSION) {
      throw new Error(`Result Outbox schemaVersion 无效：${fileName}`);
    }
    const expected = requiredChecksum(parsed.payloadChecksum, fileName);
    if (expected !== normalized.payloadChecksum) {
      throw new Error(`Result Outbox payloadChecksum 校验失败：${fileName}`);
    }
  }
  return normalized;
}

function normalizeStoredEntry(
  value: Record<string, unknown>,
  fileName: string
): ResultOutboxEntry {
  if (!Array.isArray(value.references)) {
    throw new Error(`Result Outbox references 无效：${fileName}`);
  }
  const responseDurationSeconds = Number(value.responseDurationSeconds);
  const result = normalizeEntry({
    executionId: requiredText(value.executionId, "executionId", 256),
    dispatchTaskId: requiredText(value.dispatchTaskId, "dispatchTaskId", 256),
    businessType: requiredBusinessType(value.businessType),
    keyword: requiredText(value.keyword, "keyword", 100_000),
    answerContent: requiredText(value.answerContent, "answerContent", 10_000_000),
    references: value.references as ReferenceRecord[],
    responseDurationSeconds,
    collectedAt: requiredText(value.collectedAt, "collectedAt", 100),
    answerShareUrl: typeof value.answerShareUrl === "string" ? value.answerShareUrl : null,
    ...(typeof value.webSearchRequested === "boolean"
      ? { webSearchRequested: value.webSearchRequested }
      : {}),
    ...(typeof value.webSearchEnabled === "boolean"
      ? { webSearchEnabled: value.webSearchEnabled }
      : {}),
    ...(typeof value.webSearchVerified === "boolean"
      ? { webSearchVerified: value.webSearchVerified }
      : {})
  }, new Date(requiredText(value.storedAt, "storedAt", 100)));
  return result;
}

function safeExecutionId(executionId: string): string {
  const normalized = requiredText(executionId, "executionId", 256);
  return Buffer.from(normalized, "utf8").toString("base64url");
}

function randomToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function requiredText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  if (value.length > maximumLength) throw new Error(`${field} 长度超过限制。`);
  return value;
}

function requiredBusinessType(value: unknown): RpaBusinessType {
  if (
    value === "DIAGNOSIS" || value === "CONTENT_STYLE_MONITOR" ||
    value === "ENTRY_MONITOR" || value === "ARTICLE_PROBE"
  ) return value;
  throw new Error(`Result Outbox businessType 无效：${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只对稳定错误码分类，消息中不拼接路径、问题或回答。 */
export function classifyFilesystemError(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EIO", "ENOTDIR"]
    .includes(error.code)
    ? error.code
    : undefined;
}

function checksumPayload(value: object): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredChecksum(value: unknown, fileName: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Result Outbox payloadChecksum 格式无效：${fileName}`);
  }
  return value;
}

function executionIdFromFileName(fileName: string): string | undefined {
  const match = COMPLETE_FILE_PATTERN.exec(fileName);
  if (!match?.[1]) return undefined;
  try {
    const value = Buffer.from(match[1], "base64url").toString("utf8");
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeDirectoryName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error("Outbox quarantine 目录名无效。");
  }
  return value;
}

function safeQuarantineName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 220) || "unknown";
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}

async function writeMetadataAtomically(
  filePath: string,
  record: OutboxCorruptionRecord
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}
