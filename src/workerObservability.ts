/**
 * 长期 RPA Worker 的结构化逐题日志和技术失败证据。
 *
 * 普通控制台不会接收截图、页面正文或大段错误信息；这些内容只写入配置目录。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  classifyTechnicalError,
  healthStatusForErrorCode,
  type PlatformSelfCheckResult,
  type WorkerErrorCode
} from "./browserDiagnostics.js";
import {
  PlatformExecutionError,
  type ExecutePlatformTaskContext,
  type MultiPlatformExecutionOptions,
  type PlatformTaskOutcome
} from "./platformExecution.js";
import type { PlatformId } from "./types.js";
import type { ExecuteQuestionResult } from "./crawler.js";
import type { RpaBusinessType } from "./rpaTask.js";

export type TaskLogEvent =
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "RESULT_PERSISTENCE_PENDING"
  | "TASK_RETRY_SCHEDULED"
  | "POST_SUBMIT_UNCERTAIN";

export interface StructuredTaskLogRecord {
  timestamp: string;
  event: TaskLogEvent;
  workerId: string;
  brandId: string;
  businessGroupId: string;
  platform: PlatformId;
  conversationGroupId: string;
  questionIndex: number;
  actualQuestion: string;
  questionTruncated: boolean;
  requestedDeepThinking: boolean | null;
  actualDeepThinking: boolean | null;
  webSearchRequested: boolean;
  webSearchEnabled: boolean;
  webSearchVerified: boolean;
  durationMs: number;
  referenceCount: number;
  retryCount: number;
  errorCode: WorkerErrorCode | null;
  errorMessage?: string;
  screenshotPath?: string;
  diagnosticPath?: string;
  businessType?: RpaBusinessType;
  executionId?: string;
  businessTaskId?: string;
  tenantId?: string;
  projectId?: string;
  intentEntryId?: string;
  monitorDate?: string;
  repetitionNo?: number;
  conversationKey?: string;
  conversationUrl?: string;
  submissionState?: string;
}

export interface StructuredTaskLoggerOptions {
  logDirectory: string;
  fileName?: string;
  maxQuestionChars?: number;
  maxErrorChars?: number;
  maxFileBytes?: number;
  retentionDays?: number;
}

export interface FailureEvidenceStoreOptions {
  evidenceDirectory: string;
  maxDiagnosticChars?: number;
  maxDomChars?: number;
  maxDomSnapshotsPerPlatform?: number;
  retentionDays?: number;
}

export interface DomHistorySnapshotInput {
  page: Page;
  workerId: string;
  brandId: string;
  businessGroupId: string;
  platformId: PlatformId;
  questionIndex: number;
  outcome: "success" | "failure" | "persistence_pending";
  errorCode?: WorkerErrorCode | null;
}

export interface FailureEvidenceInput {
  page: Page;
  workerId: string;
  brandId: string;
  businessGroupId: string;
  platformId: PlatformId;
  conversationGroupId: string;
  questionIndex: number;
  errorCode: WorkerErrorCode;
  error: unknown;
}

export interface FailureEvidenceResult {
  screenshotPath?: string;
  diagnosticPath: string;
}

export interface ObservedTaskMetadata {
  workerId: string;
  conversationGroupId: string;
  /** 缺省时使用 scheduler 中的 task.question。 */
  actualQuestion?: string;
  requestedDeepThinking?: boolean | null;
  webSearchRequested?: boolean;
}

export interface ObservedPlatformTaskExecutorOptions {
  executeTask: MultiPlatformExecutionOptions["executeTask"];
  logger: StructuredTaskLogger;
  evidenceStore: FailureEvidenceStore;
  getPage: (platformId: PlatformId) => Page | undefined;
  getMetadata: (
    context: ExecutePlatformTaskContext
  ) => ObservedTaskMetadata | Promise<ObservedTaskMetadata>;
  now?: () => number;
}

export interface SelfCheckEvidenceHandlerOptions {
  evidenceStore: FailureEvidenceStore;
  getWorkerId: (platformId: PlatformId) => string;
}

const DEFAULT_MAX_QUESTION_CHARS = 2_000;
const DEFAULT_MAX_ERROR_CHARS = 500;
const DEFAULT_MAX_DIAGNOSTIC_CHARS = 4_000;
const DEFAULT_MAX_DOM_CHARS = 200_000;
const DEFAULT_MAX_DOM_SNAPSHOTS_PER_PLATFORM = 10;

/** 逐行 JSON，方便长期运行时流式收集和按错误码聚合。 */
export class StructuredTaskLogger {
  private readonly filePath: string;
  private readonly maxQuestionChars: number;
  private readonly maxErrorChars: number;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private pendingWrite = Promise.resolve();

  constructor(options: StructuredTaskLoggerOptions) {
    requireDirectory(options.logDirectory, "logDirectory");
    const fileName = options.fileName ?? "worker-tasks.jsonl";
    if (!/^[\w.-]+\.jsonl$/i.test(fileName)) {
      throw new Error("结构化日志文件名必须是安全的 .jsonl 文件名。");
    }
    this.filePath = path.resolve(options.logDirectory, fileName);
    this.maxQuestionChars = positiveLimit(
      options.maxQuestionChars,
      DEFAULT_MAX_QUESTION_CHARS,
      "maxQuestionChars"
    );
    this.maxErrorChars = positiveLimit(
      options.maxErrorChars,
      DEFAULT_MAX_ERROR_CHARS,
      "maxErrorChars"
    );
    this.maxFileBytes = positiveLimit(options.maxFileBytes, 100 * 1024 * 1024, "maxFileBytes");
    this.retentionDays = positiveLimit(options.retentionDays, 14, "retentionDays");
  }

  get outputPath(): string {
    return this.filePath;
  }

  write(record: Omit<
    StructuredTaskLogRecord,
    "actualQuestion" | "questionTruncated" | "requestedDeepThinking" | "actualDeepThinking" |
    "webSearchRequested" | "webSearchEnabled" | "webSearchVerified"
  > & {
    actualQuestion: string;
    requestedDeepThinking?: boolean | null;
    actualDeepThinking?: boolean | null;
    webSearchRequested?: boolean;
    webSearchEnabled?: boolean;
    webSearchVerified?: boolean;
  }): Promise<void> {
    const boundedQuestion = redactAndLimit(record.actualQuestion, this.maxQuestionChars);
    const boundedError = record.errorMessage === undefined
      ? undefined
      : redactAndLimit(record.errorMessage, this.maxErrorChars).text;
    const normalized: StructuredTaskLogRecord = {
      ...record,
      workerId: boundedIdentifier(record.workerId),
      brandId: boundedIdentifier(record.brandId),
      businessGroupId: boundedIdentifier(record.businessGroupId),
      conversationGroupId: boundedIdentifier(record.conversationGroupId, 1_000),
      ...(record.executionId
        ? { executionId: boundedIdentifier(record.executionId) }
        : {}),
      ...(record.businessTaskId
        ? { businessTaskId: boundedIdentifier(record.businessTaskId) }
        : {}),
      ...(record.tenantId ? { tenantId: boundedIdentifier(record.tenantId) } : {}),
      ...(record.projectId ? { projectId: boundedIdentifier(record.projectId) } : {}),
      ...(record.intentEntryId
        ? { intentEntryId: boundedIdentifier(record.intentEntryId) }
        : {}),
      ...(record.conversationKey
        ? { conversationKey: boundedIdentifier(record.conversationKey, 1_000) }
        : {}),
      ...(record.conversationUrl
        ? { conversationUrl: sanitizeUrl(record.conversationUrl) }
        : {}),
      actualQuestion: boundedQuestion.text,
      questionTruncated: boundedQuestion.truncated,
      requestedDeepThinking: record.requestedDeepThinking ?? null,
      actualDeepThinking: record.actualDeepThinking ?? null,
      webSearchRequested: record.webSearchRequested ?? false,
      webSearchEnabled: record.webSearchEnabled ?? false,
      webSearchVerified: record.webSearchVerified ?? false,
      durationMs: nonNegativeInteger(record.durationMs),
      referenceCount: nonNegativeInteger(record.referenceCount),
      retryCount: nonNegativeInteger(record.retryCount),
      ...(boundedError === undefined ? {} : { errorMessage: boundedError })
    };
    const line = `${JSON.stringify(normalized)}\n`;
    const operation = this.pendingWrite.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await rotateJsonlIfNeeded(this.filePath, Buffer.byteLength(line), this.maxFileBytes);
      await fs.appendFile(this.filePath, line, "utf8");
      await pruneRotatedLogs(this.filePath, this.retentionDays);
    });
    // 前一次写入失败不应永久阻塞后续任务日志；调用方仍会收到本次失败。
    this.pendingWrite = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }
}

/** 截图与受限文本诊断按失败任务单独落盘，普通日志只保存文件路径。 */
export class FailureEvidenceStore {
  private readonly rootDirectory: string;
  private readonly domHistoryFilePath: string;
  private readonly maxDiagnosticChars: number;
  private readonly maxDomChars: number;
  private readonly maxDomSnapshotsPerPlatform: number;
  private readonly retentionDays: number;
  private lastCleanupDay = "";
  private sequence = 0;
  private pendingDomHistoryWrite = Promise.resolve();

  constructor(options: FailureEvidenceStoreOptions) {
    requireDirectory(options.evidenceDirectory, "evidenceDirectory");
    this.rootDirectory = path.resolve(options.evidenceDirectory);
    this.domHistoryFilePath = path.join(path.dirname(this.rootDirectory), "dom-history.json");
    this.maxDiagnosticChars = positiveLimit(
      options.maxDiagnosticChars,
      DEFAULT_MAX_DIAGNOSTIC_CHARS,
      "maxDiagnosticChars"
    );
    this.maxDomChars = positiveLimit(
      options.maxDomChars,
      DEFAULT_MAX_DOM_CHARS,
      "maxDomChars"
    );
    this.maxDomSnapshotsPerPlatform = positiveLimit(
      options.maxDomSnapshotsPerPlatform,
      DEFAULT_MAX_DOM_SNAPSHOTS_PER_PLATFORM,
      "maxDomSnapshotsPerPlatform"
    );
    this.retentionDays = positiveLimit(options.retentionDays, 7, "retentionDays");
  }

  get domHistoryPath(): string {
    return this.domHistoryFilePath;
  }

  async capture(input: FailureEvidenceInput): Promise<FailureEvidenceResult> {
    const occurredAt = new Date();
    await this.cleanupExpiredEvidence(occurredAt);
    const dayDirectory = path.join(
      this.rootDirectory,
      occurredAt.toISOString().slice(0, 10),
      safePathSegment(input.platformId)
    );
    await fs.mkdir(dayDirectory, { recursive: true });
    const stem = [
      occurredAt.toISOString().replace(/[:.]/g, "-"),
      safePathSegment(input.workerId),
      safePathSegment(input.brandId),
      `q${nonNegativeInteger(input.questionIndex)}`,
      String(++this.sequence)
    ].join("_");
    const screenshotPath = path.join(dayDirectory, `${stem}.png`);
    const diagnosticPath = path.join(dayDirectory, `${stem}.json`);

    const screenshotSaved = await input.page.screenshot({
      path: screenshotPath,
      fullPage: false
    }).then(() => true).catch(() => false);
    const bodyText = await input.page.locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
    const diagnosticText = redactAndLimit(bodyText, this.maxDiagnosticChars);
    const diagnostic = {
      capturedAt: occurredAt.toISOString(),
      workerId: boundedIdentifier(input.workerId),
      brandId: boundedIdentifier(input.brandId),
      businessGroupId: boundedIdentifier(input.businessGroupId),
      platform: input.platformId,
      conversationGroupId: boundedIdentifier(input.conversationGroupId, 1_000),
      questionIndex: nonNegativeInteger(input.questionIndex),
      errorCode: input.errorCode,
      errorMessage: redactAndLimit(formatError(input.error), DEFAULT_MAX_ERROR_CHARS).text,
      currentUrl: sanitizeUrl(safePageUrl(input.page)),
      pageText: diagnosticText.text,
      pageTextTruncated: diagnosticText.truncated
    };
    await fs.writeFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    await this.captureDomSnapshot({
      page: input.page,
      workerId: input.workerId,
      brandId: input.brandId,
      businessGroupId: input.businessGroupId,
      platformId: input.platformId,
      questionIndex: input.questionIndex,
      outcome: "failure",
      errorCode: input.errorCode
    }).catch(() => undefined);

    return {
      ...(screenshotSaved ? { screenshotPath } : {}),
      diagnosticPath
    };
  }

  /** 四个平台共用一个有界 JSON 文件；只保存排查选择器所需的脱敏 DOM。 */
  captureDomSnapshot(input: DomHistorySnapshotInput): Promise<void> {
    const operation = this.pendingDomHistoryWrite.then(async () => {
      const capturedAt = new Date();
      const rawHtml = await captureSanitizedDom(input.page);
      if (!rawHtml) return;
      const boundedHtml = redactAndLimit(rawHtml, this.maxDomChars);
      const cutoff = capturedAt.getTime() - this.retentionDays * 86_400_000;
      const existing = await readDomHistory(this.domHistoryFilePath);
      const snapshots = existing.snapshots
        .filter((snapshot) => Date.parse(snapshot.capturedAt) >= cutoff)
        .concat({
          capturedAt: capturedAt.toISOString(),
          workerId: boundedIdentifier(input.workerId),
          brandId: boundedIdentifier(input.brandId),
          businessGroupId: boundedIdentifier(input.businessGroupId),
          platform: input.platformId,
          questionIndex: nonNegativeInteger(input.questionIndex),
          outcome: input.outcome,
          errorCode: input.errorCode ?? null,
          currentUrl: sanitizeUrl(safePageUrl(input.page)),
          html: boundedHtml.text,
          htmlTruncated: boundedHtml.truncated
        });
      const retained = retainRecentDomSnapshots(
        snapshots,
        this.maxDomSnapshotsPerPlatform
      );
      await fs.mkdir(path.dirname(this.domHistoryFilePath), { recursive: true });
      await fs.writeFile(this.domHistoryFilePath, `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: capturedAt.toISOString(),
        snapshots: retained
      }, null, 2)}\n`, "utf8");
    });
    this.pendingDomHistoryWrite = operation.catch(() => undefined);
    return operation;
  }

  private async cleanupExpiredEvidence(now: Date): Promise<void> {
    const today = now.toISOString().slice(0, 10);
    if (this.lastCleanupDay === today) return;
    this.lastCleanupDay = today;
    const cutoff = now.getTime() - this.retentionDays * 86_400_000;
    const names = await fs.readdir(this.rootDirectory).catch(() => []);
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      const timestamp = Date.parse(`${name}T00:00:00.000Z`);
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await fs.rm(path.join(this.rootDirectory, name), { recursive: true, force: true });
      }
    }
  }
}

interface DomHistorySnapshot {
  capturedAt: string;
  workerId: string;
  brandId: string;
  businessGroupId: string;
  platform: PlatformId;
  questionIndex: number;
  outcome: DomHistorySnapshotInput["outcome"];
  errorCode: WorkerErrorCode | null;
  currentUrl: string;
  html: string;
  htmlTruncated: boolean;
}

interface DomHistoryFile {
  schemaVersion: 1;
  updatedAt: string;
  snapshots: DomHistorySnapshot[];
}

async function captureSanitizedDom(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,noscript,svg,canvas").forEach((node) => node.remove());
    clone.querySelectorAll("input,textarea").forEach((node) => {
      node.removeAttribute("value");
      node.textContent = "";
    });
    clone.querySelectorAll("*").forEach((node) => {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (
          name === "srcdoc" ||
          name === "nonce" ||
          name === "integrity" ||
          /(?:token|secret|password|passwd|cookie|session|authorization)/i.test(name) ||
          (name.startsWith("data-") &&
            !["data-testid", "data-test", "data-role", "data-state", "data-desc"]
              .includes(name))
        ) {
          node.removeAttribute(attribute.name);
          continue;
        }
        if (name === "href" || name === "src") {
          try {
            const url = new URL(attribute.value, document.baseURI);
            url.search = "";
            url.hash = "";
            node.setAttribute(attribute.name, url.toString());
          } catch {
            node.removeAttribute(attribute.name);
          }
        }
      }
    });
    return `<!doctype html>\n${clone.outerHTML}`;
  }).catch(() => "");
}

async function readDomHistory(filePath: string): Promise<DomHistoryFile> {
  const empty: DomHistoryFile = {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    snapshots: []
  };
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content) return empty;
  try {
    const parsed = JSON.parse(content) as Partial<DomHistoryFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.snapshots)) return empty;
    return parsed as DomHistoryFile;
  } catch {
    return empty;
  }
}

function retainRecentDomSnapshots(
  snapshots: readonly DomHistorySnapshot[],
  maxPerPlatform: number
): DomHistorySnapshot[] {
  const counts = new Map<PlatformId, number>();
  return [...snapshots]
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
    .filter((snapshot) => {
      const count = counts.get(snapshot.platform) ?? 0;
      if (count >= maxPerPlatform) return false;
      counts.set(snapshot.platform, count + 1);
      return true;
    })
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

/**
 * 装饰多平台执行层的 executeTask。每题无论成功或技术失败都写一条结构化记录；
 * 失败时额外保存证据，并把需要人工处理的错误映射为平台暂停状态。
 */
export function createObservedPlatformTaskExecutor(
  options: ObservedPlatformTaskExecutorOptions
): MultiPlatformExecutionOptions["executeTask"] {
  const now = options.now ?? Date.now;

  return async (context): Promise<PlatformTaskOutcome> => {
    const startedAt = now();
    const metadata = await options.getMetadata(context);
    const initialQuestion = metadata.actualQuestion ?? context.task.question;

    try {
      const outcome = await options.executeTask(context);
      await safeWriteLog(options.logger, {
        timestamp: new Date(now()).toISOString(),
        event: "TASK_COMPLETED",
        workerId: metadata.workerId,
        brandId: context.batch.brandId,
        businessGroupId: context.batch.businessGroupId,
        platform: context.platformId,
        conversationGroupId: outcome.conversationGroupId ?? metadata.conversationGroupId,
        questionIndex: context.taskIndex + 1,
        actualQuestion: outcome.submittedQuestion ?? initialQuestion,
        requestedDeepThinking:
          outcome.requestedDeepThinking ?? metadata.requestedDeepThinking ?? null,
        actualDeepThinking: outcome.actualDeepThinking ?? null,
        webSearchRequested:
          outcome.webSearchRequested ?? metadata.webSearchRequested ?? false,
        webSearchEnabled: outcome.webSearchEnabled ?? false,
        webSearchVerified: outcome.webSearchVerified ?? false,
        durationMs: now() - startedAt,
        referenceCount: outcome.referenceCount ?? 0,
        retryCount: outcome.retryCount ?? 0,
        errorCode: null
      });
      return outcome;
    } catch (error) {
      const errorCode = classifyTechnicalError(error);
      const page = options.getPage(context.platformId);
      const evidence = page
        ? await options.evidenceStore.capture({
            page,
            workerId: metadata.workerId,
            brandId: context.batch.brandId,
            businessGroupId: context.batch.businessGroupId,
            platformId: context.platformId,
            conversationGroupId: metadata.conversationGroupId,
            questionIndex: context.taskIndex + 1,
            errorCode,
            error
          }).catch(() => undefined)
        : undefined;
      await safeWriteLog(options.logger, {
        timestamp: new Date(now()).toISOString(),
        event: "TASK_FAILED",
        workerId: metadata.workerId,
        brandId: context.batch.brandId,
        businessGroupId: context.batch.businessGroupId,
        platform: context.platformId,
        conversationGroupId: metadata.conversationGroupId,
        questionIndex: context.taskIndex + 1,
        actualQuestion: initialQuestion,
        requestedDeepThinking: metadata.requestedDeepThinking ?? null,
        actualDeepThinking: null,
        webSearchRequested: metadata.webSearchRequested ?? false,
        webSearchEnabled: false,
        webSearchVerified: false,
        durationMs: now() - startedAt,
        referenceCount: 0,
        retryCount: readRetryCount(error),
        errorCode,
        errorMessage: formatError(error),
        ...evidence
      });

      if (error instanceof PlatformExecutionError) throw error;
      const healthStatus = healthStatusForErrorCode(errorCode);
      if (
        healthStatus === "RATE_LIMITED" ||
        healthStatus === "CAPTCHA_REQUIRED" ||
        healthStatus === "LOGIN_REQUIRED" ||
        healthStatus === "DOM_CHANGED"
      ) {
        throw new PlatformExecutionError(
          formatError(error),
          healthStatus,
          undefined,
          { cause: error }
        );
      }
      // 普通技术故障保留原异常，由 MultiPlatformExecutionLayer 使用默认冷却时间。
      throw error;
    }
  };
}

/** 为 runBrowserSelfCheck.onPlatformFailure 创建启动失败证据回调。 */
export function createSelfCheckEvidenceHandler(
  options: SelfCheckEvidenceHandlerOptions
): (result: PlatformSelfCheckResult, page?: Page) => Promise<void> {
  return async (result, page) => {
    if (!page || !result.errorCode) return;
    await options.evidenceStore.capture({
      page,
      workerId: options.getWorkerId(result.platformId),
      brandId: "worker-startup",
      businessGroupId: "worker-startup",
      platformId: result.platformId,
      conversationGroupId: "worker-startup",
      questionIndex: 0,
      errorCode: result.errorCode,
      error: new Error(result.reason ?? result.errorCode)
    });
  };
}

/** 将现有 executeQuestion 结果适配为执行层结果，不改变原有本地输出结构。 */
export function platformTaskOutcomeFromQuestionResult(
  result: ExecuteQuestionResult,
  conversationGroupId: string
): PlatformTaskOutcome {
  const referenceCount = result.answer?.referenceCount ?? result.references.length;
  if (
    (referenceCount === 0 && result.referenceStatus !== "CONFIRMED_EMPTY") ||
    (referenceCount > 0 && result.referenceStatus !== "EXTRACTED")
  ) {
    throw Object.assign(new Error("引用状态 UNKNOWN，禁止转换为成功执行结果"), {
      errorCode: "REFERENCE_UNKNOWN"
    });
  }
  return {
    status: referenceCount === 0 ? "zero_references" : "success",
    referenceCount,
    retryCount: Math.max(0, result.attemptCount - 1),
    conversationGroupId,
    submittedQuestion: result.submittedQuestion,
    requestedDeepThinking: result.requestedDeepThinking,
    actualDeepThinking: result.actualDeepThinking,
    webSearchRequested: result.webSearchRequested,
    webSearchEnabled: result.webSearchEnabled,
    webSearchVerified: result.webSearchVerified
  };
}

/** 纯函数：隐私字段脱敏并限制长度，禁止无界页面正文进入普通日志。 */
export function redactAndLimit(
  value: string,
  maxChars: number
): { text: string; truncated: boolean } {
  const redacted = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|code|key|auth|secret|password|passwd|cookie|session)\s*[:=]\s*[^\s,;&]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[REDACTED_PHONE]");
  const normalized = redacted.replace(/\u0000/g, "");
  const safeLimit = Math.max(1, Math.floor(maxChars));
  if (normalized.length <= safeLimit) return { text: normalized, truncated: false };
  return {
    text: `${normalized.slice(0, Math.max(0, safeLimit - 1))}…`,
    truncated: true
  };
}

export function sanitizeUrl(value: string): string {
  const bounded = redactAndLimit(value, 2_000).text;
  try {
    const url = new URL(bounded);
    for (const key of url.searchParams.keys()) {
      if (/token|code|key|secret|password|passwd|session|cookie|auth/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return bounded;
  }
}

async function safeWriteLog(
  logger: StructuredTaskLogger,
  record: Parameters<StructuredTaskLogger["write"]>[0]
): Promise<void> {
  // 日志盘异常不能让已成功的问题被再次发送。
  await logger.write(record).catch(() => undefined);
}

function readRetryCount(error: unknown): number {
  if (!error || typeof error !== "object" || !("retryCount" in error)) return 0;
  const retryCount = (error as { retryCount?: unknown }).retryCount;
  return typeof retryCount === "number" ? nonNegativeInteger(retryCount) : 0;
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function boundedIdentifier(value: string, maxChars = 256): string {
  return redactAndLimit(String(value), maxChars).text.replace(/[\r\n]+/g, " ");
}

function safePathSegment(value: string): string {
  const normalized = String(value).replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80);
  return normalized || "unknown";
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function requireDirectory(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${field} 必须是大于 0 的有限数值。`);
  }
  return Math.floor(resolved);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rotateJsonlIfNeeded(
  filePath: string,
  incomingBytes: number,
  maximumBytes: number
): Promise<void> {
  const stats = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats || stats.size + incomingBytes <= maximumBytes) return;
  const rotatedPath = `${filePath}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.rename(filePath, rotatedPath);
}

async function pruneRotatedLogs(filePath: string, retentionDays: number): Promise<void> {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const names = await fs.readdir(directory).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(directory, name);
    const stats = await fs.stat(candidate).catch(() => undefined);
    if (stats?.isFile() && stats.mtimeMs < cutoff) {
      await fs.unlink(candidate).catch(() => undefined);
    }
  }
}
