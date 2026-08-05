/** 最终 RPA Worker：任务领取、品牌批次、浏览器执行、结果事务和运行保护。 */
import type { Page } from "playwright";
import { inspectPlatformPage, runBrowserSelfCheck, classifyTechnicalError,
  healthStatusForErrorCode, type BrowserSelfCheckResult, type WorkerErrorCode } from "./browserDiagnostics.js";
import {
  conversationPageOperations,
  createPageConversationManager,
  type ConversationManager
} from "./conversationManager.js";
import {
  executeQuestion,
  inspectCurrentQuestionAnswer,
  isSafeSameQuestionRetryError,
  recoverSubmittedQuestionResult,
  type ExecuteQuestionRuntime
} from "./crawler.js";
import { PLATFORMS } from "./platforms.js";
import {
  MultiPlatformExecutionLayer,
  PlatformExecutionError,
  type PlatformHealthState,
  type PlatformHealthStatus
} from "./platformExecution.js";
import { JsonlRpaTaskAuditLogger } from "./rpaTaskAudit.js";
import { RpaTaskRepository } from "./rpaTaskRepository.js";
import { RpaResultRepository } from "./rpaResultRepository.js";
import {
  MetricsJsonSnapshotWriter,
  MetricsRegistry,
  MetricsSnapshotPublisher
} from "./rpaMetrics.js";
import {
  ResultOutbox,
  ResultOutboxWriteError,
  persistResultThroughOutbox,
  replayResultOutbox,
  type SuccessResultWriter
} from "./resultOutbox.js";
import type { CollectionTask } from "./rpaTask.js";
import {
  routeRpaFailure,
  taskRetryDelayMs,
  type RpaFailureCode,
  type RpaFailureRoute
} from "./rpaRetryPolicy.js";
import {
  ExecutionHeartbeat,
  MysqlAdvisoryLeaseCoordinator,
  RpaWorkerStateRepository,
  executionLeaseName,
  platformLeaseName,
  waitForAdvisoryLease,
  type AdvisoryLeaseCoordinator
} from "./rpaWorkerState.js";
import type { RpaWorkerConfig } from "./rpaWorkerConfig.js";
import type { BrandBatch } from "./scheduler.js";
import type {
  PlatformId,
  ReferenceExtractionStatus,
  ReferenceRecord
} from "./types.js";
import type {
  RpaCollectionResult,
  RpaResultSaveOutcome
} from "./rpaResultRepository.js";
import {
  webSearchPolicyForBusinessType,
  confirmWebSearchFromAnswerEvidence,
  type WebSearchActivationResult
} from "./webSearch.js";
import {
  FailureEvidenceStore,
  StructuredTaskLogger
} from "./workerObservability.js";
import {
  rpaConsoleError,
  rpaConsoleInfo,
  safeErrorSummary,
  safeExecutionId
} from "./consolePrivacy.js";
import { checkDiskSpace } from "./runtimeSafety.js";
import { assertPersistableReferenceResult } from "./referenceState.js";

export interface PlannedRpaBatch {
  key: string;
  tasks: readonly CollectionTask[];
}

export interface RpaWorkerRunSummary {
  workerId: string;
  dryRun: boolean;
  selectedTaskCount: number;
  selectedBatchCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  releasedTaskCount: number;
  recoveredZombieCount: number;
  replayedOutboxCount: number;
  pendingOutboxCount: number;
  retriedTaskCount: number;
  pausedPlatforms: Partial<Record<PlatformId, PlatformHealthStatus>>;
}

export interface RpaWorkerRunOptions {
  shouldStop?: () => boolean;
  session?: RpaWorkerSession;
}

/** Service 跨轮询复用的数据库、日志、CDP 页面与平台健康状态。 */
export interface RpaWorkerSession {
  audit: JsonlRpaTaskAuditLogger;
  taskRepository: RpaTaskRepository;
  resultRepository: RpaResultRepository;
  resultOutbox: ResultOutbox;
  stateRepository: RpaWorkerStateRepository;
  leases: MysqlAdvisoryLeaseCoordinator;
  logger: StructuredTaskLogger;
  evidenceStore: FailureEvidenceStore;
  metrics: MetricsRegistry;
  metricsPublisher: MetricsSnapshotPublisher;
  browserRuntime?: BrowserSelfCheckResult;
  platformHealth: Map<PlatformId, PlatformHealthState>;
  lastTaskStateMetricsAt?: number;
  filesystemDegraded: boolean;
  lockStateTrusted: boolean;
}

export function createRpaWorkerSession(config: RpaWorkerConfig): RpaWorkerSession {
  const audit = new JsonlRpaTaskAuditLogger({ logDirectory: config.logDirectory });
  const metrics = new MetricsRegistry(config.workerType, config.platforms);
  const metricsPublisher = new MetricsSnapshotPublisher(
    metrics,
    new MetricsJsonSnapshotWriter(config.metricsDirectory),
    config.metricsSnapshotIntervalMs
  );
  let sessionReference: RpaWorkerSession | undefined;
  const leases = new MysqlAdvisoryLeaseCoordinator(undefined, {
    onInvalidated() {
      if (sessionReference) sessionReference.lockStateTrusted = false;
    },
    onTrusted() {
      if (sessionReference) sessionReference.lockStateTrusted = true;
    }
  });
  const session: RpaWorkerSession = {
    audit,
    taskRepository: new RpaTaskRepository(undefined, audit, {
      retryScheduleEnabled: config.databaseRetryScheduleEnabled,
      ...(config.providerRoutingEnabled
        ? { workerProvider: config.workerProvider }
        : {})
    }),
    resultRepository: new RpaResultRepository(),
    resultOutbox: new ResultOutbox({ directory: config.outboxDirectory }),
    stateRepository: new RpaWorkerStateRepository(),
    leases,
    logger: new StructuredTaskLogger({
      logDirectory: config.logDirectory,
      fileName: `${config.workerId}-tasks.jsonl`,
      maxFileBytes: config.logMaxFileMb * 1024 * 1024,
      retentionDays: config.logRetentionDays
    }),
    evidenceStore: new FailureEvidenceStore({
      evidenceDirectory: config.evidenceDirectory,
      retentionDays: config.evidenceRetentionDays
    }),
    metrics,
    metricsPublisher,
    platformHealth: new Map(),
    filesystemDegraded: false,
    lockStateTrusted: true
  };
  sessionReference = session;
  metricsPublisher.start();
  return session;
}

export async function closeRpaWorkerSession(session: RpaWorkerSession): Promise<void> {
  await session.metricsPublisher.stop();
  await session.audit.flush();
  await session.logger.flush();
  await session.leases.close();
  const browser = session.browserRuntime?.browser;
  session.browserRuntime = undefined;
  // Playwright 对“连接获得”的 Browser 调用 close 只断开客户端连接，不关闭用户 Chrome。
  if (browser?.isConnected()) {
    await browser.close({ reason: "RPA Worker Service stopped" }).catch(() => undefined);
  }
}

class PlatformLeaseUnavailableError extends Error {
  constructor(readonly platformId: PlatformId) {
    super(`等待 ${platformId} 跨进程平台租约超时`);
    this.name = "PlatformLeaseUnavailableError";
  }
}

/**
 * 选择完整批次。maxTasks 是灰度软上限；若第一个品牌批次本身超过上限，仍保留完整批次。
 */
export async function planGreyRpaBatches(
  repository: RpaTaskRepository,
  config: Pick<RpaWorkerConfig, "workerType" | "platforms" | "maxTasks" | "candidateLimit"> &
    Partial<Pick<RpaWorkerConfig, "grayBrandIds" | "grayBusinessTaskIds" | "grayPercentage">>
): Promise<PlannedRpaBatch[]> {
  const enabledPlatforms = new Set(config.platforms);
  const seeds = (await repository.findPendingCollectionTasks(config.workerType, {
    limit: config.candidateLimit
  })).filter((task) =>
    enabledPlatforms.has(task.platformId) && taskInGrayScope(task, config)
  );
  const seen = new Set<string>();
  const batches: PlannedRpaBatch[] = [];
  let taskCount = 0;

  for (const seed of seeds) {
    const key = batchIdentity(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    const tasks = (await repository.findPendingBatchTasks(config.workerType, seed, {
      limit: 1_000
    })).filter((task) =>
      task.platformId === seed.platformId && taskInGrayScope(task, config)
    );
    if (tasks.length === 0) continue;
    if (taskCount > 0 && taskCount + tasks.length > config.maxTasks) break;
    batches.push({ key, tasks });
    taskCount += tasks.length;
    if (taskCount >= config.maxTasks) break;
  }
  return batches;
}

export function taskInGrayScope(
  task: Pick<CollectionTask, "brandId" | "businessTaskId">,
  config: Partial<Pick<
    RpaWorkerConfig,
    "grayBrandIds" | "grayBusinessTaskIds" | "grayPercentage"
  >>
): boolean {
  if (config.grayBrandIds?.length && !config.grayBrandIds.includes(task.brandId)) return false;
  if (
    config.grayBusinessTaskIds?.length &&
    !config.grayBusinessTaskIds.includes(task.businessTaskId)
  ) return false;
  const percentage = config.grayPercentage ?? 100;
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  let hash = 2166136261;
  for (const char of `${task.businessTaskId}:${task.brandId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < percentage;
}

export async function runRpaWorkerOnce(
  config: RpaWorkerConfig,
  options: RpaWorkerRunOptions = {}
): Promise<RpaWorkerRunSummary> {
  const ownsSession = options.session === undefined;
  const session = options.session ?? createRpaWorkerSession(config);
  const {
    audit,
    taskRepository,
    resultRepository,
    resultOutbox,
    stateRepository,
    leases,
    logger,
    evidenceStore
  } = session;
  const summary: RpaWorkerRunSummary = {
    workerId: config.workerId,
    dryRun: config.dryRun,
    selectedTaskCount: 0,
    selectedBatchCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    releasedTaskCount: 0,
    recoveredZombieCount: 0,
    replayedOutboxCount: 0,
    pendingOutboxCount: 0,
    retriedTaskCount: 0,
    pausedPlatforms: {}
  };
  const shouldStop = options.shouldStop ?? (() => false);

  try {
    await refreshWorkerMetrics(session, config);
    if (config.healthCheckOnly) {
      await runRpaWorkerHealthCheck(config, taskRepository, evidenceStore);
      return summary;
    }

    if (config.dryRun) {
      const planned = await planGreyRpaBatches(taskRepository, config);
      summary.selectedBatchCount = planned.length;
      summary.selectedTaskCount = countPlannedTasks(planned);
      printDryRun(config, planned);
      return summary;
    }

    // 结果已在本地安全落盘时，数据库恢复必须先于浏览器自检和新任务领取。
    // 重放路径只调用 saveSuccess，不创建页面、不获取会话，也不再次发送问题。
    const replay = await replayResultOutbox(resultOutbox, resultRepository);
    summary.replayedOutboxCount = replay.replayedCount;
    summary.pendingOutboxCount = replay.failures.length;
    session.metrics.setOutboxPending(replay.failures.length);
    if (replay.corruptions.length > 0) {
      session.metrics.incrementOutboxCorrupted(replay.corruptions.length);
      for (const corruption of replay.corruptions) {
        rpaConsoleError({
          workerId: config.workerId,
          event: "OUTBOX_CORRUPTED",
          executionId: corruption.executionId,
          errorCode: "OUTBOX_CORRUPTED",
          error: corruption.reason,
          batchProgress: `file=${corruption.fileName.slice(0, 160)}`
        });
      }
    }
    if (replay.replayedCount > 0) {
      session.lastTaskStateMetricsAt = undefined;
      await refreshWorkerMetrics(session, config);
    }
    if (replay.discoveredCount > 0) {
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "OUTBOX_REPLAY",
        batchProgress:
          `discovered=${replay.discoveredCount},replayed=${replay.replayedCount},pending=${replay.failures.length}`
      });
    }
    if (replay.failures.length > 0) {
      for (const failure of replay.failures) {
        rpaConsoleError({
          workerId: config.workerId,
          event: "OUTBOX_REPLAY_FAILED",
          executionId: failure.executionId,
          errorCode: "DATABASE_ERROR",
          error: failure.error
        });
      }
      rpaConsoleError({
        workerId: config.workerId,
        event: "OUTBOX_PENDING",
        errorCode: "DATABASE_ERROR",
        batchProgress: `pending=${replay.failures.length}`
      });
      return summary;
    }
    let diskCheckFailed = false;
    const disk = await checkDiskSpace(
      config.outboxDirectory,
      config.diskWarningFreeMb * 1024 * 1024,
      config.diskStopFreeMb * 1024 * 1024
    ).catch((error) => {
      diskCheckFailed = true;
      rpaConsoleError({
        workerId: config.workerId,
        event: "DISK_CHECK_FAILED",
        errorCode: "FILESYSTEM_ERROR",
        error
      });
      return undefined;
    });
    if (diskCheckFailed) return summary;
    if (disk) {
      session.metrics.setDiskFreeBytes(disk.freeBytes);
      if (disk.status !== "OK") {
        rpaConsoleError({
          workerId: config.workerId,
          event: disk.status === "STOP_CLAIMING" ? "DISK_STOP_CLAIMING" : "DISK_WARNING",
          errorCode: "FILESYSTEM_ERROR",
          batchProgress: `freeMb=${Math.floor(disk.freeBytes / 1024 / 1024)}`
        });
      }
      if (disk.status === "STOP_CLAIMING") return summary;
    }
    if (shouldStop()) return summary;

    if (!session.lockStateTrusted) {
      const healthLock = `rpa:lease-health:${config.workerId}`;
      try {
        const restored = await leases.tryAcquire(healthLock);
        if (!restored) return summary;
        await leases.release(healthLock);
        session.lockStateTrusted = true;
      } catch (error) {
        rpaConsoleError({
          workerId: config.workerId,
          event: "ADVISORY_LOCK_CONNECTION_UNTRUSTED",
          errorCode: "DATABASE_ERROR",
          error
        });
        return summary;
      }
    }

    const selfCheck = await ensureBrowserRuntime(session, config);
    if (!selfCheck.connected) throw new Error(`无法连接 CDP：${config.cdpEndpoint}`);
    const readyPlatforms = readySessionPlatforms(session, config);
    for (const platformId of config.platforms) {
      const state = session.platformHealth.get(platformId);
      if (state && state.status !== "READY") {
        summary.pausedPlatforms[platformId] = state.status;
      }
    }
    if (readyPlatforms.length === 0) {
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "NO_READY_PLATFORM",
        batchProgress: "claimed=0"
      });
      return summary;
    }

    if (config.recoverStale) {
      const staleBefore = new Date(Date.now() - config.staleAfterMs);
      const recovered = await stateRepository.recoverStaleExecutions(
        config.workerType,
        staleBefore,
        leases,
        { limit: config.candidateLimit }
      );
      summary.recoveredZombieCount = recovered.recoveredExecutionIds.length;
      if (recovered.recoveredExecutionIds.length > 0) {
        session.lastTaskStateMetricsAt = undefined;
        await refreshWorkerMetrics(session, config);
      }
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "STALE_RECOVERY",
        batchProgress:
          `candidates=${recovered.candidates.length},recovered=${recovered.recoveredExecutionIds.length},locked=${recovered.skippedLockedExecutionIds.length}`
      });
    }
    if (shouldStop()) return summary;

    const runtimeConfig = { ...config, platforms: readyPlatforms };
    const planned = nextPlatformBatches(
      await planGreyRpaBatches(taskRepository, runtimeConfig)
    );
    summary.selectedBatchCount = planned.length;
    summary.selectedTaskCount = countPlannedTasks(planned);
    if (planned.length === 0) {
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "QUEUE_EMPTY",
        batchProgress: "batches=0,tasks=0"
      });
      return summary;
    }

    const claimed = await claimCompleteBatches(
      taskRepository,
      stateRepository,
      leases,
      planned,
      config.workerType,
      shouldStop
    );
    summary.selectedBatchCount = claimed.length;
    summary.selectedTaskCount = countPlannedTasks(claimed);
    if (claimed.length === 0) {
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "CLAIM_CONTENDED",
        batchProgress: `batches=${planned.length},claimed=0`
      });
      return summary;
    }
    for (const { tasks } of claimed) {
      for (const task of tasks) {
        session.metrics.transitionTaskState(task.platformId, "pending", "processing");
      }
    }
    // 批次执行期间使用本地状态迁移；批次结束后再通过数据库聚合校准。
    session.lastTaskStateMetricsAt = undefined;

    await executeClaimedBatches({
      config: runtimeConfig,
      batches: claimed,
      pages: Object.fromEntries(readyPlatforms.map((platformId) => [
        platformId,
        selfCheck.platforms[platformId]!.page!
      ])) as Partial<Record<PlatformId, Page>>,
      resultRepository,
      resultOutbox,
      stateRepository,
      leases,
      logger,
      evidenceStore,
      summary,
      metrics: session.metrics,
      onFilesystemDegraded(degraded) {
        session.filesystemDegraded = degraded;
      },
      invalidateBrowserRuntime() {
        const browser = session.browserRuntime?.browser;
        session.browserRuntime = undefined;
        if (browser?.isConnected()) {
          void browser.close({ reason: "RPA browser runtime invalidated" }).catch(() => undefined);
        }
      },
      async recoverPlatformPage(platformId) {
        const runtime = await ensureBrowserRuntime(session, config);
        const result = runtime.platforms[platformId];
        if (!result?.ready || !result.page || result.page.isClosed()) {
          throw Object.assign(new Error(result?.reason ?? "平台页面重连后仍不可用"), {
            errorCode: result?.errorCode ?? "BROWSER_DISCONNECTED"
          });
        }
        return result.page;
      },
      platformHealth: session.platformHealth,
      shouldStop
    });
    return summary;
  } finally {
    await refreshWorkerMetrics(session, config);
    await session.metricsPublisher.publish().catch(() => undefined);
    await audit.flush();
    await logger.flush();
    if (ownsSession) await closeRpaWorkerSession(session);
  }
}

/** 单轮每个平台至多领取一个完整批次；下一品牌必须等下个轮询周期。 */
export function nextPlatformBatches(
  batches: readonly PlannedRpaBatch[]
): PlannedRpaBatch[] {
  const selected: PlannedRpaBatch[] = [];
  const platforms = new Set<PlatformId>();
  for (const batch of batches) {
    const platformId = batch.tasks[0]?.platformId;
    if (!platformId || platforms.has(platformId)) continue;
    platforms.add(platformId);
    selected.push(batch);
  }
  return selected;
}

/** 向后兼容已有调用；新代码优先使用语义明确的 runRpaWorkerOnce。 */
export const runRpaWorker = runRpaWorkerOnce;

async function ensureBrowserRuntime(
  session: RpaWorkerSession,
  config: RpaWorkerConfig
): Promise<BrowserSelfCheckResult> {
  const existing = session.browserRuntime;
  if (existing && !browserRuntimeNeedsReconnect(existing, config)) return existing;
  if (
    existing?.connected && existing.browser?.isConnected() !== false &&
    config.platforms.every((platformId) => {
      const result = existing.platforms[platformId];
      const health = session.platformHealth.get(platformId);
      return !result?.errorCode ||
        !["BROWSER_DISCONNECTED", "PAGE_DISCONNECTED", "PLATFORM_TAB_MISSING", "CDP_CONNECTION_FAILED"]
          .includes(result.errorCode) ||
        health?.status === "DISABLED";
    })
  ) {
    // 本次断线事件已耗尽重连次数，保持人工暂停；进程重启后才开始新一轮。
    return existing;
  }
  if (existing?.browser?.isConnected()) {
    await existing.browser.close({ reason: "RPA reconnecting invalid browser runtime" })
      .catch(() => undefined);
  }
  session.browserRuntime = undefined;

  let selfCheck: BrowserSelfCheckResult | undefined;
  for (let attempt = 1; attempt <= config.browserReconnectAttempts; attempt++) {
    selfCheck = await runBrowserSelfCheck({
    cdpEndpoint: config.cdpEndpoint,
    platforms: config.platforms.map((platformId) => PLATFORMS[platformId]),
    onPlatformFailure: async (result, page) => {
      if (!page || !result.errorCode) return;
      await session.evidenceStore.capture({
        page,
        workerId: config.workerId,
        brandId: "worker-startup",
        businessGroupId: "worker-startup",
        platformId: result.platformId,
        conversationGroupId: "worker-startup",
        questionIndex: 0,
        errorCode: result.errorCode,
        error: new Error(result.reason ?? result.errorCode)
      }).catch(() => undefined);
    }
    });
    const hasReconnectableFailure = config.platforms.some((platformId) => {
      const result = selfCheck!.platforms[platformId];
      return result?.errorCode === "BROWSER_DISCONNECTED" ||
        result?.errorCode === "PAGE_DISCONNECTED" ||
        result?.errorCode === "PLATFORM_TAB_MISSING" ||
        result?.errorCode === "CDP_CONNECTION_FAILED";
    });
    if (selfCheck.connected && !hasReconnectableFailure) break;
    if (attempt < config.browserReconnectAttempts) {
      await delay(config.browserReconnectBackoffMs * attempt);
    }
  }
  if (!selfCheck) throw new Error("浏览器自检没有返回结果");
  if (selfCheck.connected) session.browserRuntime = selfCheck;
  for (const platformId of config.platforms) {
    const previous = session.platformHealth.get(platformId);
    if (
      previous &&
      ["CAPTCHA_REQUIRED", "LOGIN_REQUIRED", "DOM_CHANGED", "RATE_LIMITED"]
        .includes(previous.status)
    ) continue;
    const result = selfCheck.platforms[platformId];
    session.platformHealth.set(platformId, {
      platformId,
      status: result?.ready ? "READY" : result?.healthStatus ?? "DISABLED",
      updatedAt: Date.now(),
      ...(result?.reason ? { reason: result.reason } : {})
    });
    session.metrics.setPlatformHealth(
      platformId,
      result?.ready ? "READY" : result?.healthStatus ?? "DISABLED"
    );
  }
  return selfCheck;
}

export function browserRuntimeNeedsReconnect(
  runtime: BrowserSelfCheckResult,
  config: { platforms: readonly PlatformId[] }
): boolean {
  if (!runtime.connected || runtime.browser?.isConnected() === false) return true;
  return config.platforms.some((platformId) => {
    const result = runtime.platforms[platformId];
    if (
      result?.errorCode &&
      result.errorCode !== "BROWSER_DISCONNECTED" &&
      result.errorCode !== "PAGE_DISCONNECTED" &&
      result.errorCode !== "PLATFORM_TAB_MISSING" &&
      result.errorCode !== "CDP_CONNECTION_FAILED"
    ) {
      // 登录、验证码、限流和 DOM 异常需要人工处理，不能靠无限重连刷新。
      return false;
    }
    const page = result?.page;
    if (!page || page.isClosed()) return true;
    try {
      const currentHost = new URL(page.url()).hostname.replace(/^www\./, "");
      const platform = PLATFORMS[platformId];
      const expected = (platform.hostnames ?? [new URL(platform.url).hostname])
        .map((host) => host.replace(/^www\./, ""));
      return !expected.some((host) => currentHost === host || currentHost.endsWith(`.${host}`));
    } catch {
      return true;
    }
  });
}

export function readySessionPlatforms(
  session: RpaWorkerSession,
  config: RpaWorkerConfig,
  now = Date.now()
): PlatformId[] {
  const ready: PlatformId[] = [];
  for (const platformId of config.platforms) {
    const state = session.platformHealth.get(platformId);
    if (!state) continue;
    if (
      (state.status === "COOLING_DOWN" || state.status === "RATE_LIMITED") &&
      state.resumeAt !== undefined &&
      state.resumeAt <= now
    ) {
      session.platformHealth.set(platformId, {
        platformId,
        status: "READY",
        updatedAt: now
      });
      ready.push(platformId);
      continue;
    }
    if (state.status === "READY") ready.push(platformId);
    // CAPTCHA_REQUIRED、LOGIN_REQUIRED、DOM_CHANGED 和 DISABLED 不自动恢复。
  }
  return ready;
}

export async function runRpaWorkerHealthCheck(
  config: RpaWorkerConfig,
  taskRepository = new RpaTaskRepository(),
  evidenceStore = new FailureEvidenceStore({ evidenceDirectory: config.evidenceDirectory })
): Promise<void> {
  const tasks = await taskRepository.findPendingTasks(config.workerType, { limit: 1 });
  const selfCheck = await runBrowserSelfCheck({
    cdpEndpoint: config.cdpEndpoint,
    platforms: config.platforms.map((platformId) => PLATFORMS[platformId])
  });
  try {
    rpaConsoleInfo({
      workerId: config.workerId,
      event: "HEALTH_CHECK",
      batchProgress: `pendingSample=${tasks.length},cdp=${selfCheck.connected ? "READY" : "FAILED"}`
    });
    let failed = !selfCheck.connected;
    for (const platformId of config.platforms) {
      const result = selfCheck.platforms[platformId];
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "PLATFORM_HEALTH",
        platformId,
        errorCode: result?.ready ? "READY" : result?.errorCode ?? result?.healthStatus ?? "UNKNOWN"
      });
      if (!result?.ready) failed = true;
    }
    // 保留参数，避免健康检查和正式运行使用不同的证据目录配置。
    void evidenceStore;
    if (failed) throw new Error("Worker 健康检查未全部通过。");
  } finally {
    // health-check 路径不进入 session.browserRuntime，必须在这里释放 CDP
    // 连接，否则已经输出 SUMMARY 的一次性进程仍会占住事件循环。
    if (selfCheck.browser?.isConnected()) {
      await selfCheck.browser.close({ reason: "RPA health check completed" })
        .catch(() => undefined);
    }
  }
}

interface ExecuteClaimedInput {
  config: RpaWorkerConfig;
  batches: readonly PlannedRpaBatch[];
  pages: Partial<Record<PlatformId, Page>>;
  resultRepository: RpaResultRepository;
  resultOutbox: ResultOutbox;
  stateRepository: RpaWorkerStateRepository;
  leases: AdvisoryLeaseCoordinator;
  logger: StructuredTaskLogger;
  evidenceStore: FailureEvidenceStore;
  summary: RpaWorkerRunSummary;
  metrics: MetricsRegistry;
  onFilesystemDegraded: (degraded: boolean) => void;
  invalidateBrowserRuntime: () => void;
  recoverPlatformPage: (platformId: PlatformId) => Promise<Page>;
  platformHealth: Map<PlatformId, PlatformHealthState>;
  shouldStop: () => boolean;
}

/** 纯映射用于防止正式 Worker 再次遗漏数据库任务的 deepThinking。 */
export function deepThinkingRuntimeForTask(
  task: Pick<CollectionTask, "deepThinking">,
  config: Pick<RpaWorkerConfig, "deepThinkingUnsupportedPolicy">
): Pick<ExecuteQuestionRuntime, "deepThinking" | "deepThinkingUnsupportedPolicy"> {
  return {
    deepThinking: task.deepThinking,
    deepThinkingUnsupportedPolicy: config.deepThinkingUnsupportedPolicy
  };
}

/** ARTICLE_PROBE 永远 REQUIRED；元宝诊断允许入口探测降级，但仍由参考列表结果严格验收。 */
export function webSearchRuntimeForTask(
  task: Pick<CollectionTask, "businessType">,
  config: Pick<RpaWorkerConfig, "webSearchPolicy">,
  platformId?: PlatformId
): Pick<ExecuteQuestionRuntime, "webSearchPolicy"> {
  return {
    webSearchPolicy: task.businessType === "DIAGNOSIS" && platformId === "yuanbao"
      ? "PREFERRED"
      : webSearchPolicyForBusinessType(task.businessType, config.webSearchPolicy)
  };
}

/** 正式诊断的元宝回答必须经过“参考列表检查 + 缺失时重新生成”闭环。 */
export function referenceRecoveryRuntimeForTask(
  task: Pick<CollectionTask, "businessType">,
  platformId: PlatformId
): Pick<ExecuteQuestionRuntime, "retryOnNoReferences" | "regenerateOnNoReferences" | "requireReferences"> {
  const enabled = task.businessType === "DIAGNOSIS" && platformId === "yuanbao";
  return {
    retryOnNoReferences: enabled,
    regenerateOnNoReferences: enabled,
    requireReferences: enabled
  };
}

export type RpaTaskLifecycleState =
  | "NOT_SUBMITTED"
  | "SUBMITTED"
  | "ANSWER_VISIBLE"
  | "ANSWER_CAPTURED"
  | "REFERENCES_CONFIRMED"
  | "OUTBOX_SAVED"
  | "DATABASE_SAVED"
  | "POST_SUBMIT_UNCERTAIN";

/** 释放 DB claim 的唯一白名单；发送后的任何状态都必须保留结果恢复语义。 */
export function releaseableExecutionIds(
  executionIds: readonly string[],
  states: ReadonlyMap<string, RpaTaskLifecycleState>
): string[] {
  return executionIds.filter((executionId) => states.get(executionId) === "NOT_SUBMITTED");
}

async function executeClaimedBatches(input: ExecuteClaimedInput): Promise<void> {
  const { config } = input;
  const allTasks = input.batches.flatMap(({ tasks }) => tasks);
  const taskById = new Map(allTasks.map((task) => [task.executionId, task]));
  const owned = new Set(taskById.keys());
  const lifecycleStates = new Map<string, RpaTaskLifecycleState>(
    allTasks.map((task) => [task.executionId, "NOT_SUBMITTED"])
  );
  const conversationManagers = new Map<PlatformId, ConversationManager>();
  const batchPlatformLeases = new Map<string, string>();
  const lastQuestion = new Map<PlatformId, string>();
  const resumedCurrentAnswerBatches = new Set<string>();
  const heartbeat = new ExecutionHeartbeat(input.stateRepository, [...owned], {
    intervalMs: config.heartbeatIntervalMs,
    onError: (error) => rpaConsoleError({
      workerId: config.workerId,
      event: "HEARTBEAT_FAILED",
      errorCode: "DATABASE_ERROR",
      error
    })
  });

  for (const platformId of config.platforms) {
    conversationManagers.set(platformId, createPageConversationManager(
      requirePage(input.pages, platformId),
      PLATFORMS[platformId],
      {
        maxDurationMs: config.maxConversationDurationMs,
        maxQuestions: config.maxConversationQuestions
      }
    ));
  }

  const layer = new MultiPlatformExecutionLayer({
    platforms: config.platforms,
    config: Object.fromEntries(config.platforms.map((platformId) => [platformId, {
      enabled: true,
      taskIntervalMs: config.taskIntervalMs,
      batchIntervalMs: config.batchIntervalMs,
      technicalCooldownMs: config.technicalCooldownMs
    }])),
    hooks: {
      async onBatchStart(batch) {
        const lockName = platformLeaseName(batch.platformId);
        const acquired = await waitForAdvisoryLease(input.leases, lockName, {
          waitMs: config.leaseWaitMs,
          pollMs: config.leasePollMs
        });
        if (!acquired) throw new PlatformLeaseUnavailableError(batch.platformId);
        batchPlatformLeases.set(batch.id, lockName);
        const task = requireTask(taskById, batch.tasks[0]?.id);
        const context = {
          batchId: batch.id,
          tenantId: task.tenantKey,
          brandId: task.brandId,
          businessTaskId: task.businessTaskId,
          businessGroupId: task.businessGroupId,
          platformId: batch.platformId
        };
        const page = requirePage(input.pages, batch.platformId);
        const manager = conversationManagers.get(batch.platformId)!;
        // 只有页面上的持久化业务归属标记与本批次完全一致，且当前第一题已有完整回答，
        // 才接管中断会话。仅凭问题文本相同不足以跨进程恢复，避免跨品牌误复用。
        const ownerMatches = await currentPageMatchesConversationOwner(page, context);
        const inspection = ownerMatches
          ? await inspectCurrentQuestionAnswer(
            page,
            PLATFORMS[batch.platformId],
            task.keyword,
            "business"
          ).catch(() => ({ status: "uncertain" as const, reason: "页面检查异常" }))
          : { status: "uncertain" as const, reason: "页面不属于当前批次" };
        if (inspection.status === "answered") {
          lifecycleStates.set(task.executionId, "ANSWER_VISIBLE");
          manager.resumeVerifiedBatch(context);
          resumedCurrentAnswerBatches.add(batch.id);
          rpaConsoleInfo({
            workerId: config.workerId,
            event: "BATCH_CONVERSATION_RESUMED",
            executionId: task.executionId,
            brandId: task.brandId,
            platformId: batch.platformId,
            batchProgress: "existing-answer"
          });
          return;
        }
        if (ownerMatches && inspection.status === "uncertain") {
          throw Object.assign(
            new Error(`已有本批次页面，但无法证明当前问题尚未发送：${inspection.reason ?? "未知"}`),
            { errorCode: "REFERENCE_UNKNOWN" }
          );
        }
        await manager.startBatch(context, lastQuestion.get(batch.platformId) ?? "");
        await storeConversationOwner(page, context);
      },
      async onBatchComplete(batch) {
        input.metrics.observeBrandBatchDuration(
          batch.platformId,
          Math.max(0, Date.now() - (batch.startedAt ?? Date.now())),
          "completed"
        );
        const manager = conversationManagers.get(batch.platformId)!;
        manager.finishBatch(batch.id, "completed");
        await clearConversationOwner(requirePage(input.pages, batch.platformId));
        const opened = await manager.resetToBlank(lastQuestion.get(batch.platformId) ?? "");
        if (!opened) {
          throw Object.assign(
            new Error(`${PLATFORMS[batch.platformId].name} 完成品牌批次后无法创建新对话。`),
            { errorCode: "NEW_CONVERSATION_FAILED" }
          );
        }
        await releasePlatformLeaseAfterInterval(input, batch, batchPlatformLeases);
      },
      async onBatchFailed(batch, error) {
        input.metrics.observeBrandBatchDuration(
          batch.platformId,
          Math.max(0, Date.now() - (batch.startedAt ?? Date.now())),
          "failed"
        );
        const manager = conversationManagers.get(batch.platformId)!;
        if (manager.currentState?.batchId === batch.id) {
          if (manager.currentState.status === "active") manager.markDamaged(error);
          manager.finishBatch(batch.id, "failed");
        }
        const uncompleted = batch.tasks
          .map(({ id }) => id)
          .filter((executionId) => owned.has(executionId));
        if (uncompleted.length > 0) {
          for (const executionId of uncompleted) heartbeat.remove(executionId);
          const releaseable = releaseableExecutionIds(uncompleted, lifecycleStates);
          summaryRelease(input.summary, await input.stateRepository.releaseClaims(releaseable));
          for (const executionId of uncompleted) {
            const task = taskById.get(executionId);
            if (task && releaseable.includes(executionId)) {
              input.metrics.transitionTaskState(task.platformId, "processing", "pending");
            }
            owned.delete(executionId);
            await input.leases.release(executionLeaseName(executionId));
          }
        }
        await releasePlatformLeaseAfterInterval(input, batch, batchPlatformLeases);
      }
    },
    executeTask: async (context) => {
      const task = requireTask(taskById, context.task.id);
      await ensureBatchLeaseOwnership(input, context.batch, task.executionId);
      const manager = conversationManagers.get(context.platformId)!;
      const conversation = await manager.acquireForQuestion({
        batchId: context.batch.id,
        tenantId: task.tenantKey,
        brandId: task.brandId,
        businessTaskId: task.businessTaskId,
        businessGroupId: task.businessGroupId,
        platformId: context.platformId
      }, lastQuestion.get(context.platformId) ?? "");
      const page = requirePage(input.pages, context.platformId);
      const preflight = await inspectPlatformPage(page, PLATFORMS[context.platformId], 2_000);
      const preflightError = preflight.ready
        ? undefined
        : Object.assign(
          platformBlockedError(
            preflight.errorCode,
            preflight.reason,
            config.technicalCooldownMs
          ),
          { errorCode: preflight.errorCode ?? "TECHNICAL_FAILURE" }
        );

      const startedAt = Date.now();
      const createdAt = Date.parse(task.createdAt);
      if (Number.isFinite(createdAt)) {
        input.metrics.observeTaskWait(context.platformId, Math.max(0, startedAt - createdAt));
      }
      let submissionState: "not_submitted" | "submitted" | "uncertain" = "not_submitted";
      let actualDeepThinking: boolean | null = null;
      const taskWebSearchRuntime = webSearchRuntimeForTask(task, config, context.platformId);
      const referenceRecoveryRuntime = referenceRecoveryRuntimeForTask(task, context.platformId);
      const allowUnverifiedZeroReferences =
        task.businessType === "DIAGNOSIS" && context.platformId === "qianwen";
      let webSearchState: WebSearchActivationResult = {
        requested: taskWebSearchRuntime.webSearchPolicy !== "DISABLED",
        supported: PLATFORMS[context.platformId].webSearchSupported,
        enabled: false,
        verified: false,
        failureReason: "尚未执行联网状态检查"
      };
      const finalizeSuccessfulAnswer = async (
        answerContent: string,
        references: readonly ReferenceRecord[],
        submittedQuestion: string,
        retryCount: number,
        confirmedDeepThinking: boolean | null,
        confirmedWebSearch: WebSearchActivationResult,
        referenceStatus: ReferenceExtractionStatus
      ) => {
        assertPersistableReferenceResult(referenceStatus, references, task.businessType);
        lifecycleStates.set(task.executionId, "ANSWER_CAPTURED");
        lifecycleStates.set(task.executionId, "REFERENCES_CONFIRMED");
        manager.recordQuestion(task.keyword);
        lastQuestion.set(context.platformId, task.keyword);
        const completedAt = new Date();
        input.metrics.observeAnswerDuration(
          context.platformId,
          Math.max(0, completedAt.getTime() - startedAt)
        );
        if (references.length === 0) input.metrics.incrementZeroReferences(context.platformId);
        const result = {
          executionId: task.executionId,
          dispatchTaskId: task.dispatchTaskId,
          keyword: task.keyword,
          answerContent,
          responseDurationSeconds: Math.ceil((completedAt.getTime() - startedAt) / 1_000),
          collectedAt: completedAt,
          references,
          answerShareUrl: null,
          webSearchRequested: confirmedWebSearch.requested,
          webSearchEnabled: confirmedWebSearch.enabled,
          webSearchVerified: confirmedWebSearch.verified
        };
        const persistence = await persistResultWithOutboxRecovery(
          result,
          input.resultOutbox,
          input.resultRepository,
          {
            retryIntervalMs: config.outboxWriteRetryMs,
            onFilesystemStateChange(degraded, error, retryCount) {
              input.onFilesystemDegraded(degraded);
              if (degraded && (retryCount === 1 || retryCount % 12 === 0)) {
                rpaConsoleError({
                  workerId: config.workerId,
                  event: "OUTBOX_WRITE_RETRY",
                  executionId: task.executionId,
                  brandId: task.brandId,
                  platformId: context.platformId,
                  errorCode: "FILESYSTEM_ERROR",
                  error,
                  batchProgress: `retry=${retryCount}`,
                  secrets: [task.keyword]
                });
              }
            },
            beforeDatabaseWrite: () =>
              ensureBatchLeaseOwnership(input, context.batch, task.executionId),
            afterOutboxSave() {
              lifecycleStates.set(task.executionId, "OUTBOX_SAVED");
            },
            afterDatabaseWrite() {
              lifecycleStates.set(task.executionId, "DATABASE_SAVED");
            }
          }
        );
        const persistenceStatus = persistence.status;
        const persistenceError = persistence.error;
        const databasePersistenceError = persistence.status === "pending";

        heartbeat.remove(task.executionId);
        owned.delete(task.executionId);
        await input.leases.release(executionLeaseName(task.executionId)).catch((error) => {
          rpaConsoleError({
            workerId: config.workerId,
            event: "EXECUTION_LEASE_RELEASE_FAILED",
            executionId: task.executionId,
            brandId: task.brandId,
            platformId: context.platformId,
            errorCode: "TECHNICAL_FAILURE",
            error,
            secrets: [task.keyword]
          });
        });
        if (persistenceStatus === "saved") {
          input.summary.completedTaskCount += 1;
          input.metrics.transitionTaskState(
            context.platformId,
            "processing",
            "succeeded"
          );
        } else {
          input.summary.pendingOutboxCount += 1;
        }
        const pendingOutbox = await input.resultOutbox.list().catch(() => undefined);
        if (pendingOutbox) input.metrics.setOutboxPending(pendingOutbox.length);
        await input.logger.write({
          timestamp: completedAt.toISOString(),
          event: persistenceStatus === "saved"
            ? "TASK_COMPLETED"
            : "RESULT_PERSISTENCE_PENDING",
          workerId: config.workerId,
          brandId: task.brandId,
          businessGroupId: task.businessGroupId,
          platform: context.platformId,
          conversationGroupId: conversation.conversationGroupId,
          questionIndex: context.taskIndex + 1,
          actualQuestion: submittedQuestion,
          requestedDeepThinking: task.deepThinking,
          actualDeepThinking: confirmedDeepThinking,
          webSearchRequested: confirmedWebSearch.requested,
          webSearchEnabled: confirmedWebSearch.enabled,
          webSearchVerified: confirmedWebSearch.verified,
          durationMs: completedAt.getTime() - startedAt,
          referenceCount: references.length,
          retryCount,
          errorCode: databasePersistenceError ? "DATABASE_ERROR" : null,
          ...(persistenceError === undefined
            ? {}
            : { errorMessage: `结果待持久化：${boundedError(persistenceError)}` })
        }).catch(() => undefined);
        await input.evidenceStore.captureDomSnapshot({
          page,
          workerId: config.workerId,
          brandId: task.brandId,
          businessGroupId: task.businessGroupId,
          platformId: context.platformId,
          questionIndex: context.taskIndex + 1,
          outcome: persistenceStatus === "saved" ? "success" : "persistence_pending",
          errorCode: databasePersistenceError ? "DATABASE_ERROR" : null
        }).catch(() => undefined);
        return {
          status: references.length === 0 ? "zero_references" as const : "success" as const,
          referenceCount: references.length,
          retryCount,
          conversationGroupId: conversation.conversationGroupId,
          submittedQuestion
        };
      };

      let collected: Awaited<ReturnType<typeof executeQuestion>>;
      try {
        if (preflightError) throw preflightError;
        if (resumedCurrentAnswerBatches.has(context.batch.id) && context.taskIndex === 0) {
          submissionState = "submitted";
          lifecycleStates.set(task.executionId, "ANSWER_VISIBLE");
          const recovered = await recoverSubmittedQuestionResult(
            page,
            PLATFORMS[context.platformId],
            task.keyword,
            webSearchState,
            {
              allowUnverifiedZeroReferences,
              requireReferences: referenceRecoveryRuntime.requireReferences
            }
          );
          const recoveredWebSearch = recovered.references.length > 0
            ? confirmWebSearchFromAnswerEvidence(webSearchState)
            : webSearchState;
          return await finalizeSuccessfulAnswer(
            recovered.answerContent,
            recovered.references,
            task.keyword,
            task.failCount,
            actualDeepThinking,
            recoveredWebSearch,
            recovered.referenceStatus
          );
        }
        collected = await executeQuestion({
          questionIndex: context.taskIndex,
          question: task.keyword
        }, {
          page,
          config: PLATFORMS[context.platformId],
          mode: "business",
          promptPrefix: "",
          ...referenceRecoveryRuntime,
          resolveTitles: config.resolveTitles,
          timeoutMs: config.questionTimeoutMs,
          ...deepThinkingRuntimeForTask(task, config),
          ...taskWebSearchRuntime,
          allowUnverifiedZeroReferences,
          onDeepThinkingStateResolved(_requested, actual) {
            actualDeepThinking = actual;
          },
          onWebSearchStateResolved(result) {
            webSearchState = result;
          },
          onSubmissionStateChange(state) {
            submissionState = state;
            lifecycleStates.set(
              task.executionId,
              state === "submitted" ? "SUBMITTED" : "POST_SUBMIT_UNCERTAIN"
            );
          }
        });
        const answerContent = collected.answer?.answer;
        if (collected.status === "skipped" || !answerContent?.trim()) {
          throw Object.assign(new Error("回答正文为空"), { errorCode: "EMPTY_ANSWER" });
        }
      } catch (error) {
        let errorCode = classifyTechnicalError(error);
        const reconnectable =
          errorCode === "BROWSER_DISCONNECTED" ||
          errorCode === "PAGE_DISCONNECTED" ||
          errorCode === "CDP_CONNECTION_FAILED";
        if (reconnectable) {
          input.invalidateBrowserRuntime();
        }
        if (submissionState !== "not_submitted") {
          try {
            const recoveredPage = reconnectable
              ? await input.recoverPlatformPage(context.platformId)
              : page;
            if (reconnectable) {
              input.pages[context.platformId] = recoveredPage;
              manager.rebindOperations(conversationPageOperations(
                recoveredPage,
                PLATFORMS[context.platformId]
              ));
            }
            const recovered = await recoverSubmittedQuestionResult(
              recoveredPage,
              PLATFORMS[context.platformId],
              task.keyword,
              webSearchState,
              {
                allowUnverifiedZeroReferences,
                requireReferences: referenceRecoveryRuntime.requireReferences
              }
            );
            const recoveredWebSearch = recovered.references.length > 0
              ? confirmWebSearchFromAnswerEvidence(webSearchState)
              : webSearchState;
            return await finalizeSuccessfulAnswer(
              recovered.answerContent,
              recovered.references,
              task.keyword,
              task.failCount,
              actualDeepThinking,
              recoveredWebSearch,
              recovered.referenceStatus
            );
          } catch (recoveryError) {
            error = recoveryError;
            errorCode = classifyTechnicalError(recoveryError);
            if (
              errorCode !== "REFERENCE_UNKNOWN" &&
              !isSafeSameQuestionRetryError(recoveryError)
            ) errorCode = "REFERENCE_UNKNOWN";
          }
        }
        let postSubmitUncertain = false;
        let inspectionReason: string | undefined;
        if (submissionState !== "not_submitted") {
          const inspection = await inspectCurrentQuestionAnswer(
            page,
            PLATFORMS[context.platformId],
            task.keyword,
            "business"
          ).catch((inspectionError) => ({
            status: "uncertain" as const,
            reason: `发送后检查异常：${boundedError(inspectionError)}`
          }));
          if (inspection.status === "retryable") {
            // 明确的千问系统超时已经由题内重发达到上限，可安全走任务级退避重试，
            // 不应误判成结果未知并暂停整个平台。
            errorCode = "ANSWER_TIMEOUT";
            inspectionReason = inspection.reason;
          } else if (inspection.status === "answered" && inspection.answerContent?.trim()) {
            // 只确认正文不能证明引用为空。保留页面回答，不再把提取异常伪造成零引用。
            errorCode = "REFERENCE_UNKNOWN";
            postSubmitUncertain = true;
          } else {
            postSubmitUncertain = true;
            if (inspection.status !== "answered") errorCode = "REFERENCE_UNKNOWN";
          }
          if (postSubmitUncertain) {
            lifecycleStates.set(task.executionId, "POST_SUBMIT_UNCERTAIN");
            inspectionReason = errorCode === "WEB_SEARCH_UNSUPPORTED" ||
              errorCode === "WEB_SEARCH_UNVERIFIED"
              ? "已取得回答，但联网状态未确认，不能作为普通零引用成功"
              : inspection.reason;
          }
        }
        const evidence = await input.evidenceStore.capture({
          page,
          workerId: config.workerId,
          brandId: task.brandId,
          businessGroupId: task.businessGroupId,
          platformId: context.platformId,
          conversationGroupId: conversation.conversationGroupId,
          questionIndex: context.taskIndex + 1,
          errorCode,
          error
        }).catch(() => undefined);
        await input.logger.write({
          timestamp: new Date().toISOString(),
          event: postSubmitUncertain ? "POST_SUBMIT_UNCERTAIN" : "TASK_FAILED",
          workerId: config.workerId,
          brandId: task.brandId,
          businessGroupId: task.businessGroupId,
          platform: context.platformId,
          conversationGroupId: conversation.conversationGroupId,
          questionIndex: context.taskIndex + 1,
          actualQuestion: task.keyword,
          requestedDeepThinking: task.deepThinking,
          actualDeepThinking,
          webSearchRequested: webSearchState.requested,
          webSearchEnabled: webSearchState.enabled,
          webSearchVerified: webSearchState.verified,
          durationMs: Math.max(0, Date.now() - startedAt),
          referenceCount: 0,
          retryCount: task.failCount,
          errorCode,
          errorMessage: postSubmitUncertain
            ? `post-submit-uncertain：${inspectionReason ?? "无法确认当前回答"}；原错误=${boundedError(error)}`
            : boundedError(error),
          ...evidence
        }).catch(() => undefined);

        const route = routePlatformTaskFailure(context.platformId, errorCode);
        // 平台阻断发生在发送前时不消耗任务次数；批次失败钩子会安全释放未发题任务。
        if (route === "pause_platform") {
          throw executionErrorFor(
            error,
            errorCode,
            config.rateLimitCooldownMs,
            config.pollIntervalMs
          );
        }

        // 任务级重试闭环：先从心跳集合移除，退避期间继续持有 execution lock；
        // 条件 UPDATE 成功改变状态后再释放 lock，避免其他 Worker 同时重试。
        heartbeat.remove(task.executionId);
        const backoffMs = taskRetryDelayMs(
          config.retryBackoffMs,
          task.failCount,
          config.retryJitterMs
        );
        // migration 开启后立即释放平台执行权，由 next_retry_at 阻止提前领取；
        // 兼容旧表时保留原睡眠语义，避免旧 RPA 立即抢回失败任务。
        if (!config.databaseRetryScheduleEnabled && backoffMs > 0) await delay(backoffMs);
        let retryOutcome: Awaited<ReturnType<RpaResultRepository["retryExecution"]>>;
        try {
          retryOutcome = await input.resultRepository.retryExecution({
            executionId: task.executionId,
            failCount: task.failCount,
            maxAttempts: config.maxAttempts,
            errorCode,
            ...(config.databaseRetryScheduleEnabled
              ? { nextRetryAt: new Date(Date.now() + backoffMs) }
              : {})
          });
        } catch (databaseError) {
          // 重试状态本身的数据库故障不增加 fail_num，也不能伪造最终失败。
          owned.delete(task.executionId);
          await input.leases.release(executionLeaseName(task.executionId)).catch(() => undefined);
          rpaConsoleError({
            workerId: config.workerId,
            event: "RETRY_STATE_UPDATE_FAILED",
            executionId: task.executionId,
            brandId: task.brandId,
            platformId: context.platformId,
            errorCode: "DATABASE_ERROR",
            error: databaseError,
            secrets: [task.keyword]
          });
          throw executionErrorFor(
            error,
            errorCode,
            config.rateLimitCooldownMs,
            config.pollIntervalMs
          );
        }
        owned.delete(task.executionId);
        await input.leases.release(executionLeaseName(task.executionId)).catch(() => undefined);
        if (retryOutcome.status === "released_for_retry") {
          input.summary.retriedTaskCount += 1;
          input.summary.releasedTaskCount += 1;
          input.metrics.transitionTaskState(
            context.platformId,
            "processing",
            "pending"
          );
          await input.logger.write({
            timestamp: new Date().toISOString(),
            event: "TASK_RETRY_SCHEDULED",
            workerId: config.workerId,
            brandId: task.brandId,
            businessGroupId: task.businessGroupId,
            platform: context.platformId,
            conversationGroupId: conversation.conversationGroupId,
            questionIndex: context.taskIndex + 1,
            actualQuestion: task.keyword,
            requestedDeepThinking: task.deepThinking,
            actualDeepThinking,
            webSearchRequested: webSearchState.requested,
            webSearchEnabled: webSearchState.enabled,
            webSearchVerified: webSearchState.verified,
            durationMs: Math.max(0, Date.now() - startedAt),
            referenceCount: 0,
            retryCount: retryOutcome.failCount,
            errorCode,
            errorMessage: `任务已退避 ${backoffMs}ms 后释放，fail_num=${retryOutcome.failCount}`
          }).catch(() => undefined);
        } else if (retryOutcome.status === "final_failed") {
          input.summary.failedTaskCount += 1;
          input.metrics.transitionTaskState(
            context.platformId,
            "processing",
            "finalFailed"
          );
        }
        throw executionErrorFor(
          error,
          errorCode,
          config.rateLimitCooldownMs,
          config.pollIntervalMs
        );
      }

      return finalizeSuccessfulAnswer(
        collected.answer!.answer,
        collected.references,
        collected.submittedQuestion,
        task.failCount + Math.max(0, collected.attemptCount - 1),
        collected.actualDeepThinking,
        webSearchState,
        collected.referenceStatus
      );
    }
  });

  for (const { tasks } of input.batches) {
    for (const task of tasks) {
      layer.enqueue({
        id: task.executionId,
        brandId: task.brandId,
        businessGroupId: task.businessGroupId,
        platformId: task.platformId,
        question: task.keyword,
        // geno-digital-api 数字越小优先级越高；调度器数字越大越高，因此取反。
        priority: -task.priority,
        createdAt: task.createdAt
      });
    }
  }

  await heartbeat.start();
  try {
    while (owned.size > 0 && !input.shouldStop()) {
      const results = await layer.tick();
      for (const [platformId, result] of Object.entries(results) as [
        PlatformId,
        NonNullable<(typeof results)[PlatformId]>
      ][]) {
        if (result.kind === "paused" || result.kind === "failed") {
          input.summary.pausedPlatforms[platformId] = result.health.status;
          input.platformHealth.set(platformId, { ...result.health });
          input.metrics.setPlatformHealth(platformId, result.health.status);
        } else if (result.kind === "completed") {
          input.platformHealth.set(platformId, {
            platformId,
            status: "READY",
            updatedAt: Date.now()
          });
          input.metrics.setPlatformHealth(platformId, "READY");
        }
      }
      const activeResult = Object.values(results).some(
        (result) => result?.kind === "completed" || result?.kind === "failed"
      );
      if (!activeResult) break;
    }
  } finally {
    await heartbeat.stop();
    const remaining = [...owned];
    if (remaining.length > 0) {
      for (const executionId of remaining) heartbeat.remove(executionId);
      const releaseable = releaseableExecutionIds(remaining, lifecycleStates);
      summaryRelease(input.summary, await input.stateRepository.releaseClaims(releaseable));
      for (const executionId of remaining) {
        const task = taskById.get(executionId);
        if (task && releaseable.includes(executionId)) {
          input.metrics.transitionTaskState(task.platformId, "processing", "pending");
        }
        await input.leases.release(executionLeaseName(executionId));
      }
      owned.clear();
    }
    for (const lockName of batchPlatformLeases.values()) {
      await input.leases.release(lockName);
    }
  }
}

async function claimCompleteBatches(
  taskRepository: RpaTaskRepository,
  stateRepository: RpaWorkerStateRepository,
  leases: AdvisoryLeaseCoordinator,
  batches: readonly PlannedRpaBatch[],
  workerType: RpaWorkerConfig["workerType"],
  shouldStop: () => boolean = () => false
): Promise<PlannedRpaBatch[]> {
  const claimedBatches: PlannedRpaBatch[] = [];
  for (const batch of batches) {
    if (shouldStop()) break;
    const claimed: CollectionTask[] = [];
    let complete = true;
    for (const task of batch.tasks) {
      if (shouldStop()) {
        complete = false;
        break;
      }
      if (!await taskRepository.claimTask(workerType, task.executionId)) {
        complete = false;
        break;
      }
      claimed.push(task);
      const lockName = executionLeaseName(task.executionId);
      if (!await leases.tryAcquire(lockName)) {
        complete = false;
        break;
      }
    }
    if (!complete) {
      await stateRepository.releaseClaims(claimed.map(({ executionId }) => executionId));
      for (const task of claimed) await leases.release(executionLeaseName(task.executionId));
      continue;
    }
    claimedBatches.push({ key: batch.key, tasks: claimed });
  }
  return claimedBatches;
}

async function releasePlatformLeaseAfterInterval(
  input: ExecuteClaimedInput,
  batch: BrandBatch,
  leasesByBatch: Map<string, string>
): Promise<void> {
  const lockName = leasesByBatch.get(batch.id);
  if (!lockName) return;
  leasesByBatch.delete(batch.id);
  if (input.config.crossProcessMinIntervalMs > 0) {
    await delay(input.config.crossProcessMinIntervalMs);
  }
  await input.leases.release(lockName).catch((error) => {
    rpaConsoleError({
      workerId: input.config.workerId,
      event: "PLATFORM_LEASE_RELEASE_FAILED",
      platformId: batch.platformId,
      errorCode: "TECHNICAL_FAILURE",
      error
    });
  });
}

async function ensureBatchLeaseOwnership(
  input: ExecuteClaimedInput,
  batch: BrandBatch,
  executionId: string
): Promise<void> {
  const platformLock = platformLeaseName(batch.platformId);
  const executionLock = executionLeaseName(executionId);
  const platformOwned = await input.leases.tryAcquire(platformLock);
  if (!platformOwned) {
    throw Object.assign(new Error("平台 advisory lock 未重新确认"), {
      errorCode: "DATABASE_ERROR"
    });
  }
  const executionOwned = await input.leases.tryAcquire(executionLock);
  if (!executionOwned) {
    await input.leases.release(platformLock).catch(() => undefined);
    throw Object.assign(new Error("execution advisory lock 未重新确认"), {
      errorCode: "DATABASE_ERROR"
    });
  }
}

function platformBlockedError(
  errorCode: WorkerErrorCode | undefined,
  reason: string | undefined,
  technicalCooldownMs: number
): PlatformExecutionError {
  const code = errorCode ?? "TECHNICAL_FAILURE";
  const health = healthStatusForErrorCode(code);
  return new PlatformExecutionError(
    reason ?? code,
    health === "CAPTCHA_REQUIRED" ||
      health === "LOGIN_REQUIRED" ||
      health === "RATE_LIMITED" ||
      health === "DOM_CHANGED"
      ? health
      : "COOLING_DOWN",
    health === "COOLING_DOWN" ? technicalCooldownMs : undefined
  );
}

export function executionErrorFor(
  error: unknown,
  errorCode: WorkerErrorCode,
  rateLimitCooldownMs: number,
  pollIntervalMs: number
): unknown {
  const health = healthStatusForErrorCode(errorCode);
  if (health === "RATE_LIMITED") {
    return new PlatformExecutionError(boundedError(error), health, rateLimitCooldownMs);
  }
  if (
    health === "COOLING_DOWN" &&
    (errorCode === "WEB_SEARCH_UNVERIFIED" || errorCode === "REFERENCE_UNKNOWN")
  ) {
    // 这两类错误通常来自入口动画、懒加载或 A/B DOM 的短暂不可见。
    // 冷却时间与轮询周期对齐，使平台在下一轮恢复，而不是永久熔断。
    return new PlatformExecutionError(
      boundedError(error),
      "COOLING_DOWN",
      pollIntervalMs
    );
  }
  if (health === "CAPTCHA_REQUIRED" || health === "LOGIN_REQUIRED" || health === "DOM_CHANGED") {
    return new PlatformExecutionError(boundedError(error), health);
  }
  return error;
}

/**
 * 元宝诊断已在题内完成有限次参考列表检查与重新生成；仍无列表时允许把同一题
 * 释放回数据库做有上限的跨轮询重试。其他平台的发送后引用未知仍保持平台级保护，
 * 避免在不能确认页面结果时盲目重复提交。
 */
export function routePlatformTaskFailure(
  platformId: PlatformId,
  errorCode: RpaFailureCode
): RpaFailureRoute {
  if (platformId === "yuanbao" && errorCode === "REFERENCE_UNKNOWN") {
    return "retry_task";
  }
  return routeRpaFailure(errorCode);
}

/** 指标是旁路能力：数据库聚合或本地 Outbox 扫描失败都不得改变业务结果。 */
async function refreshWorkerMetrics(
  session: RpaWorkerSession,
  config: RpaWorkerConfig
): Promise<void> {
  session.metrics.heartbeat();
  const now = Date.now();
  if (
    session.lastTaskStateMetricsAt === undefined ||
    now - session.lastTaskStateMetricsAt >= config.metricsSnapshotIntervalMs
  ) {
    // 无论成功失败都限频，避免数据库故障时指标查询形成额外忙循环。
    session.lastTaskStateMetricsAt = now;
    const taskStates = await session.taskRepository.countTaskStates(config.workerType)
      .catch(() => undefined);
    if (taskStates) {
      session.metrics.replaceTaskStates(new Map(taskStates.map((state) => [
        state.platformId,
        {
          pending: state.pending,
          processing: state.processing,
          succeeded: state.succeeded,
          finalFailed: state.finalFailed
        }
      ])));
    }
  }
  const outboxEntries = await session.resultOutbox.list().catch(() => undefined);
  if (outboxEntries) session.metrics.setOutboxPending(outboxEntries.length);
  for (const [platformId, health] of session.platformHealth) {
    session.metrics.setPlatformHealth(platformId, health.status);
  }
}

const CONVERSATION_OWNER_STORAGE_KEY = "geno-rpa:conversation-owner:v1";

interface ConversationOwnerContext {
  batchId: string;
  tenantId: string;
  brandId: string;
  businessTaskId: string;
  businessGroupId: string;
  platformId: PlatformId;
}

/** 在平台标签页的 sessionStorage 保存低敏感度归属，供同一标签页进程恢复使用。 */
async function storeConversationOwner(
  page: Page,
  context: ConversationOwnerContext
): Promise<void> {
  await page.evaluate(({ key, owner }) => {
    sessionStorage.setItem(key, JSON.stringify(owner));
  }, { key: CONVERSATION_OWNER_STORAGE_KEY, owner: context });
}

/**
 * 必须由租户、品牌、业务任务、业务分组和平台共同确认。batchId 是内存调度序号，
 * 进程重启后会重新生成，不能作为跨进程恢复身份；解析失败或跨域则拒绝恢复。
 */
async function currentPageMatchesConversationOwner(
  page: Page,
  context: ConversationOwnerContext
): Promise<boolean> {
  return page.evaluate(({ key, expected }) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return false;
    try {
      const actual = JSON.parse(raw) as Record<string, unknown>;
      return [
        "tenantId",
        "brandId",
        "businessTaskId",
        "businessGroupId",
        "platformId"
      ].every((field) => actual[field] === expected[field as keyof typeof expected]);
    } catch {
      return false;
    }
  }, { key: CONVERSATION_OWNER_STORAGE_KEY, expected: context }).catch(() => false);
}

async function clearConversationOwner(page: Page): Promise<void> {
  await page.evaluate((key) => sessionStorage.removeItem(key), CONVERSATION_OWNER_STORAGE_KEY)
    .catch(() => undefined);
}

function batchIdentity(task: CollectionTask): string {
  return JSON.stringify([task.brandId, task.businessGroupId, task.platformId]);
}

function countPlannedTasks(batches: readonly PlannedRpaBatch[]): number {
  return batches.reduce((count, batch) => count + batch.tasks.length, 0);
}

function printDryRun(config: RpaWorkerConfig, batches: readonly PlannedRpaBatch[]): void {
  rpaConsoleInfo({
    workerId: config.workerId,
    event: "DRY_RUN",
    batchProgress: `batches=${batches.length},tasks=${countPlannedTasks(batches)},claimed=0`
  });
  for (const batch of batches) {
    const first = batch.tasks[0]!;
    rpaConsoleInfo({
      workerId: config.workerId,
      event: "DRY_RUN_BATCH",
      executionId: first.executionId,
      brandId: first.brandId,
      platformId: first.platformId,
      batchProgress: `tasks=${batch.tasks.length}`
    });
  }
}

function requireTask(
  tasks: Map<string, CollectionTask>,
  executionId: string | undefined
): CollectionTask {
  const task = executionId ? tasks.get(executionId) : undefined;
  if (!task) {
    throw new Error(
      `找不到 execution 任务：${executionId ? safeExecutionId(executionId) : "undefined"}`
    );
  }
  return task;
}

function requirePage(
  pages: Partial<Record<PlatformId, Page>>,
  platformId: PlatformId
): Page {
  const page = pages[platformId];
  if (!page) throw new Error(`平台 ${platformId} 没有通过自检的标签页。`);
  return page;
}

function summaryRelease(summary: RpaWorkerRunSummary, affectedRows: number): void {
  summary.releasedTaskCount += affectedRows;
}

function boundedError(error: unknown): string {
  return safeErrorSummary(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface OutboxRecoveryOptions {
  retryIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onFilesystemStateChange?: (
    degraded: boolean,
    error: unknown,
    retryCount: number
  ) => void;
  beforeDatabaseWrite?: () => Promise<void>;
  afterOutboxSave?: () => void | Promise<void>;
  afterDatabaseWrite?: (outcome: RpaResultSaveOutcome) => void | Promise<void>;
}

/**
 * 回答已经取得后的不可越过边界：Outbox 未真正落盘时一直保留调用栈中的完整回答，
 * 不返回给释放心跳/lease 的后续代码。这里只重试文件落盘，不重新操作页面。
 */
export async function persistResultWithOutboxRecovery(
  result: RpaCollectionResult,
  outbox: ResultOutbox,
  repository: SuccessResultWriter,
  options: OutboxRecoveryOptions
): Promise<Awaited<ReturnType<typeof persistResultThroughOutbox>>> {
  const sleep = options.sleep ?? delay;
  let retryCount = 0;
  while (true) {
    try {
      const outcome = await persistResultThroughOutbox(result, outbox, repository, {
        beforeDatabaseWrite: options.beforeDatabaseWrite,
        afterOutboxSave: options.afterOutboxSave,
        afterDatabaseWrite: options.afterDatabaseWrite
      });
      options.onFilesystemStateChange?.(false, undefined, retryCount);
      return outcome;
    } catch (error) {
      retryCount++;
      const filesystemError = error instanceof ResultOutboxWriteError
        ? error
        : new ResultOutboxWriteError("Result Outbox 写入失败", error);
      options.onFilesystemStateChange?.(true, filesystemError, retryCount);
      await sleep(options.retryIntervalMs);
    }
  }
}
