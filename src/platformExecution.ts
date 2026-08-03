/**
 * 面向长期运行的纯内存多平台执行层。
 *
 * 本模块只编排平台队列、品牌批次和健康状态；不连接数据库，也不直接操作
 * Chrome。浏览器侧的单题采集能力通过 executeTask 注入。
 */
import {
  BrandBatchScheduler,
  type BrandBatch,
  type BrandBatchTask,
  type EnqueueBrandTaskInput
} from "./scheduler.js";
import type { PlatformId } from "./types.js";

export const PLATFORM_IDS = ["doubao", "deepseek", "qianwen", "yuanbao"] as const;

export const PLATFORM_HEALTH_STATUSES = [
  "READY",
  "RUNNING",
  "COOLING_DOWN",
  "RATE_LIMITED",
  "CAPTCHA_REQUIRED",
  "LOGIN_REQUIRED",
  "DOM_CHANGED",
  "DISABLED"
] as const;

export type PlatformHealthStatus = (typeof PLATFORM_HEALTH_STATUSES)[number];

export interface PlatformHealthState {
  platformId: PlatformId;
  status: PlatformHealthStatus;
  updatedAt: number;
  reason?: string;
  /** 仅自动恢复型状态使用；到期后在下次读取或拉取任务时恢复 READY。 */
  resumeAt?: number;
  activeBatchId?: string;
}

export interface PlatformExecutionConfig {
  /** 同一品牌批次内，两题之间的等待时间。 */
  taskIntervalMs: number;
  /** 一个批次正常完成后，拉取下一批次前的等待时间。 */
  batchIntervalMs: number;
  /** 未明确分类的技术故障触发的默认冷却时间。 */
  technicalCooldownMs: number;
  enabled: boolean;
}

export interface PlatformTaskOutcomeDetails {
  /** 可观测层使用；缺省时按 0 记录。 */
  referenceCount?: number;
  retryCount?: number;
  /** 由 ConversationManager 在批次开始时生成。 */
  conversationGroupId?: string;
  /** 实际发送给平台的文本，可与原始 task.question 不同。 */
  submittedQuestion?: string;
  requestedDeepThinking?: boolean | null;
  actualDeepThinking?: boolean | null;
  webSearchRequested?: boolean;
  webSearchEnabled?: boolean;
  webSearchVerified?: boolean;
}

export type PlatformTaskOutcome = PlatformTaskOutcomeDetails & (
  | { status: "success" }
  | { status: "zero_references" }
);

export interface ExecutePlatformTaskContext {
  platformId: PlatformId;
  batch: BrandBatch;
  task: BrandBatchTask;
  taskIndex: number;
}

export interface PlatformExecutionHooks {
  onBatchStart?: (batch: BrandBatch) => void | Promise<void>;
  onBatchComplete?: (batch: BrandBatch) => void | Promise<void>;
  onBatchFailed?: (batch: BrandBatch, error: unknown) => void | Promise<void>;
}

export interface MultiPlatformExecutionOptions {
  executeTask: (
    context: ExecutePlatformTaskContext
  ) => PlatformTaskOutcome | Promise<PlatformTaskOutcome>;
  scheduler?: BrandBatchScheduler;
  platforms?: readonly PlatformId[];
  config?: Partial<Record<PlatformId, Partial<PlatformExecutionConfig>>>;
  hooks?: PlatformExecutionHooks;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type PlatformRunResult =
  | { kind: "idle"; platformId: PlatformId }
  | {
      kind: "paused";
      platformId: PlatformId;
      health: PlatformHealthState;
    }
  | { kind: "completed"; platformId: PlatformId; batch: BrandBatch }
  | {
      kind: "failed";
      platformId: PlatformId;
      batch: BrandBatch;
      health: PlatformHealthState;
      error: unknown;
    };

type ErrorHealthStatus = Exclude<
  PlatformHealthStatus,
  "READY" | "RUNNING" | "DISABLED"
>;

const DEFAULT_CONFIG: PlatformExecutionConfig = {
  taskIntervalMs: 0,
  batchIntervalMs: 0,
  technicalCooldownMs: 60_000,
  enabled: true
};

/**
 * 供浏览器适配层显式报告平台级故障。执行层不会重试当前任务；它只暂停对应
 * 平台，其他平台仍可继续运行。
 */
export class PlatformExecutionError extends Error {
  constructor(
    message: string,
    readonly healthStatus: ErrorHealthStatus,
    /** RATE_LIMITED 或 COOLING_DOWN 可指定自动恢复时间；不传表示手动恢复。 */
    readonly cooldownMs?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PlatformExecutionError";
  }
}

/**
 * 每个平台拥有独立的运行锁和健康状态。单次 runNext 会完整消费一个品牌批次，
 * 因而不会在批次中途切到其他品牌。
 */
export class MultiPlatformExecutionLayer {
  readonly scheduler: BrandBatchScheduler;

  private readonly platformIds: readonly PlatformId[];
  private readonly configs = new Map<PlatformId, PlatformExecutionConfig>();
  private readonly health = new Map<PlatformId, PlatformHealthState>();
  private readonly running = new Map<PlatformId, Promise<PlatformRunResult>>();
  private readonly executeTask: MultiPlatformExecutionOptions["executeTask"];
  private readonly hooks: PlatformExecutionHooks;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: MultiPlatformExecutionOptions) {
    this.scheduler = options.scheduler ?? new BrandBatchScheduler();
    this.platformIds = [...new Set(options.platforms ?? PLATFORM_IDS)];
    this.executeTask = options.executeTask;
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;

    for (const platformId of this.platformIds) {
      const config = {
        ...DEFAULT_CONFIG,
        ...options.config?.[platformId]
      };
      validateConfig(platformId, config);
      this.configs.set(platformId, config);
      this.health.set(platformId, {
        platformId,
        status: config.enabled ? "READY" : "DISABLED",
        updatedAt: this.now(),
        reason: config.enabled ? undefined : "平台已通过配置禁用"
      });
    }
  }

  enqueue(input: EnqueueBrandTaskInput): BrandBatch {
    this.requirePlatform(input.platformId);
    return this.scheduler.enqueue(input);
  }

  getPlatformHealth(platformId: PlatformId): PlatformHealthState {
    this.requirePlatform(platformId);
    this.refreshAutomaticRecovery(platformId);
    return { ...this.health.get(platformId)! };
  }

  /**
   * 暂停单个平台。RATE_LIMITED/COOLING_DOWN 可传 cooldownMs 自动恢复；验证码、
   * 登录和 DOM 改版默认必须由外部确认后手动 resume。
   */
  pausePlatform(
    platformId: PlatformId,
    status: Exclude<PlatformHealthStatus, "READY" | "RUNNING">,
    reason?: string,
    cooldownMs?: number
  ): PlatformHealthState {
    this.requirePlatform(platformId);
    if (this.running.has(platformId)) {
      throw new Error(`平台 ${platformId} 正在执行，不能从外部覆盖运行状态。`);
    }
    if (cooldownMs !== undefined) validateDuration("cooldownMs", cooldownMs);
    return this.setHealth(platformId, status, {
      reason,
      resumeAt: cooldownMs === undefined ? undefined : this.now() + cooldownMs
    });
  }

  resumePlatform(platformId: PlatformId): PlatformHealthState {
    this.requirePlatform(platformId);
    if (this.running.has(platformId)) {
      return this.getPlatformHealth(platformId);
    }
    return this.setHealth(platformId, "READY");
  }

  disablePlatform(platformId: PlatformId, reason = "平台已禁用"): PlatformHealthState {
    return this.pausePlatform(platformId, "DISABLED", reason);
  }

  enablePlatform(platformId: PlatformId): PlatformHealthState {
    return this.resumePlatform(platformId);
  }

  /**
   * 拉取并完整执行一个品牌批次。同一平台的重复调用会复用正在运行的 Promise，
   * 因而任何时候都最多只有一个任务在操作该平台页面。
   */
  runNext(platformId: PlatformId): Promise<PlatformRunResult> {
    this.requirePlatform(platformId);
    const existing = this.running.get(platformId);
    if (existing) return existing;

    this.refreshAutomaticRecovery(platformId);
    const health = this.health.get(platformId)!;
    if (health.status !== "READY") {
      return Promise.resolve({
        kind: "paused",
        platformId,
        health: { ...health }
      });
    }

    const batch = this.scheduler.getNextBatch(platformId);
    if (!batch) return Promise.resolve({ kind: "idle", platformId });

    this.setHealth(platformId, "RUNNING", { activeBatchId: batch.id });
    const execution = this.executeBatch(batch).finally(() => {
      if (this.running.get(platformId) === execution) {
        this.running.delete(platformId);
      }
    });
    this.running.set(platformId, execution);
    return execution;
  }

  /** 各平台并行拉取一次；单个平台失败会被转换成结果，不会拒绝其他平台。 */
  async tick(): Promise<Partial<Record<PlatformId, PlatformRunResult>>> {
    const results = await Promise.all(
      this.platformIds.map(async (platformId) => {
        const result = await this.runNext(platformId);
        return [platformId, result] as const;
      })
    );
    const output = Object.fromEntries(results) as Partial<
      Record<PlatformId, PlatformRunResult>
    >;
    return output;
  }

  private async executeBatch(batch: BrandBatch): Promise<PlatformRunResult> {
    const { platformId } = batch;
    const config = this.configs.get(platformId)!;

    try {
      await this.hooks.onBatchStart?.(batch);

      // tasks 可在批次运行期间由调度器追加，因此每次重新读取长度。
      for (let taskIndex = 0; taskIndex < batch.tasks.length; taskIndex++) {
        if (taskIndex > 0) await this.wait(config.taskIntervalMs);
        const task = batch.tasks[taskIndex]!;
        const outcome = await this.executeTask({
          platformId,
          batch,
          task,
          taskIndex
        });
        validateOutcome(outcome);
        // zero_references 与 success 完全同路：不重试、不抛错、不触发冷却。
      }

      await this.hooks.onBatchComplete?.(batch);
      const completedBatch = this.scheduler.completeBatch(batch.id);
      // 正常批次间隔保持 RUNNING，避免被误解为技术故障冷却。
      await this.wait(config.batchIntervalMs);
      this.setHealth(platformId, "READY");
      return { kind: "completed", platformId, batch: completedBatch };
    } catch (error) {
      const failedBatch = this.failRunningBatch(batch, error);
      await this.notifyBatchFailed(failedBatch, error);
      const failureHealth = this.applyFailureHealth(platformId, error);
      return {
        kind: "failed",
        platformId,
        batch: failedBatch,
        health: failureHealth,
        error
      };
    }
  }

  private failRunningBatch(batch: BrandBatch, error: unknown): BrandBatch {
    if (batch.status === "running") return this.scheduler.failBatch(batch.id, error);
    return batch;
  }

  private async notifyBatchFailed(batch: BrandBatch, error: unknown): Promise<void> {
    try {
      await this.hooks.onBatchFailed?.(batch, error);
    } catch {
      // 健康状态必须由原始平台故障决定，失败通知不能遮蔽它。
    }
  }

  private applyFailureHealth(platformId: PlatformId, error: unknown): PlatformHealthState {
    if (error instanceof PlatformExecutionError) {
      return this.setHealth(platformId, error.healthStatus, {
        reason: error.message,
        resumeAt: error.cooldownMs === undefined
          ? undefined
          : this.now() + error.cooldownMs
      });
    }

    const cooldownMs = this.configs.get(platformId)!.technicalCooldownMs;
    return this.setHealth(platformId, "COOLING_DOWN", {
      reason: formatError(error),
      resumeAt: this.now() + cooldownMs
    });
  }

  private refreshAutomaticRecovery(platformId: PlatformId): void {
    const health = this.health.get(platformId)!;
    if (
      health.resumeAt !== undefined &&
      health.resumeAt <= this.now() &&
      health.status !== "DISABLED"
    ) {
      this.setHealth(platformId, "READY");
    }
  }

  private setHealth(
    platformId: PlatformId,
    status: PlatformHealthStatus,
    details: Pick<PlatformHealthState, "reason" | "resumeAt" | "activeBatchId"> = {}
  ): PlatformHealthState {
    const next: PlatformHealthState = {
      platformId,
      status,
      updatedAt: this.now(),
      ...details
    };
    this.health.set(platformId, next);
    return { ...next };
  }

  private requirePlatform(platformId: PlatformId): void {
    if (!this.health.has(platformId)) {
      throw new Error(`执行层未配置平台：${platformId}`);
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    if (milliseconds > 0) await this.sleep(milliseconds);
  }
}

function validateConfig(platformId: PlatformId, config: PlatformExecutionConfig): void {
  validateDuration(`${platformId}.taskIntervalMs`, config.taskIntervalMs);
  validateDuration(`${platformId}.batchIntervalMs`, config.batchIntervalMs);
  validateDuration(`${platformId}.technicalCooldownMs`, config.technicalCooldownMs);
}

function validateDuration(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须是大于等于 0 的有限数值。`);
  }
}

function validateOutcome(outcome: PlatformTaskOutcome): void {
  if (outcome.status !== "success" && outcome.status !== "zero_references") {
    throw new Error(`单题执行器返回了未知状态：${String((outcome as { status?: unknown }).status)}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
