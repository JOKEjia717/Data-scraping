/** 正式 RPA Worker 常驻服务生命周期。单轮业务继续由 runRpaWorkerOnce 承担。 */
import fs from "node:fs";
import {
  closeRpaWorkerSession,
  createRpaWorkerSession,
  runRpaWorkerOnce,
  type RpaWorkerRunSummary,
  type RpaWorkerSession
} from "./rpaWorker.js";
import type { RpaWorkerConfig } from "./rpaWorkerConfig.js";
import {
  rpaConsoleError,
  rpaConsoleInfo,
  rpaConsoleWarn,
  safeErrorSummary
} from "./consolePrivacy.js";
import { classifyRuntimeError } from "./runtimeSafety.js";
import type { WorkerErrorCode } from "./browserDiagnostics.js";

export interface RpaWorkerCycleRunner {
  runOnce(
    shouldStop: () => boolean,
    onProgress?: (stage: string) => void
  ): Promise<RpaWorkerRunSummary>;
  abort?(reason: Error): Promise<void>;
  close(): Promise<void>;
}

export interface RpaWorkerWaiter {
  wait(milliseconds: number): Promise<void>;
  wake(): void;
}

export interface RpaWorkerServiceOptions {
  runner?: RpaWorkerCycleRunner;
  waiter?: RpaWorkerWaiter;
  random?: () => number;
  onInfo?: (message: string) => void;
  onWarn?: (message: string) => void;
  onError?: (message: string, errorCode?: WorkerErrorCode) => void;
  maxDatabaseBackoffMs?: number;
  watchdogStallMs?: number;
  externalStopRequested?: () => boolean;
}

export interface RpaWorkerServiceSummary {
  cycleCount: number;
  errorCount: number;
  stopped: boolean;
  lastRun?: RpaWorkerRunSummary;
}

export interface DefaultCycleRunnerOptions {
  createSession?: (config: RpaWorkerConfig) => RpaWorkerSession;
  runOnce?: (
    config: RpaWorkerConfig,
    session: RpaWorkerSession,
    shouldStop: () => boolean,
    onProgress?: (stage: string) => void
  ) => Promise<RpaWorkerRunSummary>;
  closeSession?: (session: RpaWorkerSession) => Promise<void>;
}

export class DefaultRpaWorkerCycleRunner implements RpaWorkerCycleRunner {
  private readonly session: RpaWorkerSession;
  private readonly executeOnce: NonNullable<DefaultCycleRunnerOptions["runOnce"]>;
  private readonly closeSession: NonNullable<DefaultCycleRunnerOptions["closeSession"]>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: RpaWorkerConfig,
    options: DefaultCycleRunnerOptions = {}
  ) {
    // 整个 Service 只创建一次 Session，因此 CDP、页面、仓储和平台健康状态跨轮询复用。
    this.session = (options.createSession ?? createRpaWorkerSession)(config);
    this.executeOnce = options.runOnce ?? ((workerConfig, session, shouldStop, onProgress) =>
      runRpaWorkerOnce(workerConfig, { shouldStop, session, onProgress }));
    this.closeSession = options.closeSession ?? closeRpaWorkerSession;
  }

  runOnce(
    shouldStop: () => boolean,
    onProgress?: (stage: string) => void
  ): Promise<RpaWorkerRunSummary> {
    if (this.closed) throw new Error("RPA Worker CycleRunner 已关闭。");
    return this.executeOnce(this.config, this.session, shouldStop, onProgress);
  }

  abort(_reason: Error): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeSession(this.session);
    await this.closePromise;
  }
}

export class RpaWorkerService {
  private readonly runner: RpaWorkerCycleRunner;
  private readonly waiter: RpaWorkerWaiter;
  private readonly random: () => number;
  private readonly onInfo: (message: string) => void;
  private readonly onWarn: (message: string) => void;
  private readonly onError: (message: string, errorCode?: WorkerErrorCode) => void;
  private readonly maxDatabaseBackoffMs: number;
  private readonly watchdogStallMs: number;
  private readonly externalStopRequested: () => boolean;
  private stopRequested = false;
  private signalCount = 0;
  private running = false;

  constructor(
    private readonly config: RpaWorkerConfig,
    options: RpaWorkerServiceOptions = {}
  ) {
    this.runner = options.runner ?? new DefaultRpaWorkerCycleRunner(config);
    this.waiter = options.waiter ?? new InterruptibleWaiter();
    this.random = options.random ?? Math.random;
    this.onInfo = options.onInfo ?? ((message) => rpaConsoleInfo({
      workerId: config.workerId,
      event: "SERVICE_INFO",
      batchProgress: message
    }));
    this.onWarn = options.onWarn ?? ((message) => rpaConsoleWarn({
      workerId: config.workerId,
      event: "SERVICE_WARNING",
      batchProgress: message
    }));
    this.onError = options.onError ?? ((message, errorCode = "TECHNICAL_FAILURE") => rpaConsoleError({
      workerId: config.workerId,
      event: "SERVICE_ERROR",
      errorCode,
      error: message
    }));
    this.maxDatabaseBackoffMs = options.maxDatabaseBackoffMs ?? 300_000;
    this.watchdogStallMs = options.watchdogStallMs ?? config.watchdogStallMs;
    if (!Number.isFinite(this.watchdogStallMs) || this.watchdogStallMs <= 0) {
      throw new Error("watchdogStallMs must be greater than zero");
    }
    this.externalStopRequested = options.externalStopRequested ??
      (() => fs.existsSync(config.shutdownFile));
  }

  get isStopRequested(): boolean {
    return this.stopRequested;
  }

  /** 第一次进入安全停止；后续信号只告警，绝不调用 process.exit 或破坏页面。 */
  requestStop(
    signal: NodeJS.Signals | "TEST" | "DRAIN_FILE" | "FLEET" = "TEST"
  ): void {
    this.signalCount++;
    if (this.signalCount === 1) {
      this.stopRequested = true;
      this.waiter.wake();
      this.onInfo(
        `收到 ${signal}：停止领取新批次，等待正在执行的题安全结束并释放尚未提交的任务。`
      );
      return;
    }
    this.onWarn(
      `再次收到 ${signal}：仍按安全停止流程等待，不执行强制退出。`
    );
  }

  async run(): Promise<RpaWorkerServiceSummary> {
    if (this.running) throw new Error("RpaWorkerService 不能重复运行。");
    this.running = true;
    const summary: RpaWorkerServiceSummary = {
      cycleCount: 0,
      errorCount: 0,
      stopped: false
    };
    let consecutiveErrors = 0;
    const oneShot = this.config.dryRun || this.config.healthCheckOnly || this.config.runOnce;

    try {
      do {
        this.syncExternalStopRequest();
        if (this.stopRequested) break;
        try {
          const result = await this.runCycleWithWatchdog();
          summary.cycleCount++;
          summary.lastRun = result;
          consecutiveErrors = 0;
          if (oneShot || this.stopRequested) break;

          // 有任务时立即进入下一轮，以便不同平台持续吞吐；空队列或 Outbox
          // 仍待恢复时按 pollInterval 等待，避免数据库忙轮询。
          if (!cycleDidWork(result) || result.pendingOutboxCount > 0) {
            await this.waiter.wait(this.pollDelayMs());
          }
        } catch (error) {
          summary.errorCount++;
          consecutiveErrors++;
          this.onError(
            `Worker 轮询失败：${boundedError(error)}`,
            classifyRuntimeError(error)
          );
          if (error instanceof WorkerStalledError) throw error;
          if (oneShot || this.stopRequested) {
            if (oneShot) throw error;
            break;
          }
          await this.waiter.wait(this.databaseBackoffMs(consecutiveErrors));
        }
      } while (!this.stopRequested);
      summary.stopped = this.stopRequested;
      return summary;
    } finally {
      await this.runner.close();
      this.running = false;
    }
  }

  private pollDelayMs(): number {
    return this.config.pollIntervalMs + jitter(this.config.pollJitterMs, this.random);
  }

  private runCycleWithWatchdog(): Promise<RpaWorkerRunSummary> {
    return new Promise<RpaWorkerRunSummary>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      let lastStage = "cycle-start";
      const resetTimer = (): void => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const error = new WorkerStalledError(this.watchdogStallMs, lastStage);
          this.stopRequested = true;
          this.waiter.wake();
          const abort = this.runner.abort?.(error);
          if (!abort) {
            reject(error);
            return;
          }
          void abort.then(() => reject(error), () => reject(error));
        }, this.watchdogStallMs);
      };
      const cycle = this.runner.runOnce(
        () => {
          this.syncExternalStopRequest();
          return this.stopRequested;
        },
        (stage) => {
          lastStage = stage;
          resetTimer();
        }
      );
      resetTimer();
      void cycle.then((result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }, (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      });
    });
  }

  private syncExternalStopRequest(): void {
    if (!this.stopRequested && this.externalStopRequested()) {
      this.requestStop("DRAIN_FILE");
    }
  }

  private databaseBackoffMs(consecutiveErrors: number): number {
    const exponent = Math.min(8, Math.max(0, consecutiveErrors - 1));
    const base = Math.max(1_000, this.config.pollIntervalMs);
    return Math.min(this.maxDatabaseBackoffMs, base * (2 ** exponent)) +
      jitter(this.config.pollJitterMs, this.random);
  }
}

export class WorkerStalledError extends Error {
  readonly code = "RPA_WORKER_STALLED";

  constructor(readonly stallMs: number, readonly lastStage: string) {
    super(`Worker made no task progress for ${stallMs}ms; last stage: ${lastStage}`);
    this.name = "WorkerStalledError";
  }
}

export class InterruptibleWaiter implements RpaWorkerWaiter {
  private wakeCurrent?: () => void;

  async wait(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("轮询等待时间必须为非负数。");
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeCurrent === finish) this.wakeCurrent = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.wakeCurrent = finish;
    });
  }

  wake(): void {
    this.wakeCurrent?.();
  }
}

function cycleDidWork(summary: RpaWorkerRunSummary): boolean {
  return summary.selectedBatchCount > 0 ||
    summary.completedTaskCount > 0 ||
    summary.failedTaskCount > 0 ||
    summary.retriedTaskCount > 0 ||
    summary.replayedOutboxCount > 0;
}

function jitter(maximum: number, random: () => number): number {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.floor(maximum * normalized);
}

function boundedError(error: unknown): string {
  return safeErrorSummary(error);
}
