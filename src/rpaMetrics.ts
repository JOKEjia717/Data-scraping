import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import type { PlatformHealthStatus } from "./platformExecution.js";
import type { RpaBusinessType, RpaWorkerType } from "./rpaTask.js";
import type { PlatformId } from "./types.js";

export interface TaskStateMetrics {
  pending: number;
  processing: number;
  succeeded: number;
  finalFailed: number;
}

export type TaskStateMetricName = keyof TaskStateMetrics;

export interface DurationMetrics {
  count: number;
  totalMs: number;
  averageMs: number;
}

export interface PlatformMetricsSnapshot {
  platform: PlatformId;
  taskStates: TaskStateMetrics;
  taskWait: DurationMetrics;
  answerDuration: DurationMetrics;
  zeroReferences: number;
  healthStatus: PlatformHealthStatus;
  paused: boolean;
  captchaRequired: number;
  loginRequired: number;
  rateLimited: number;
  completedBrandBatchDuration: DurationMetrics;
  failedBrandBatchDuration: DurationMetrics;
}

export interface RpaMetricsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  workerType: RpaWorkerType;
  workerHeartbeatAt: string;
  outboxPending: number;
  outboxCorrupted: number;
  diskFreeBytes: number | null;
  businessTypes: Partial<Record<RpaBusinessType, TaskStateMetrics>>;
  totals: {
    taskStates: TaskStateMetrics;
    taskWait: DurationMetrics;
    answerDuration: DurationMetrics;
    zeroReferences: number;
    captchaRequired: number;
    loginRequired: number;
    rateLimited: number;
    completedBrandBatchDuration: DurationMetrics;
    failedBrandBatchDuration: DurationMetrics;
  };
  platforms: PlatformMetricsSnapshot[];
}

interface MutableDurationMetrics {
  count: number;
  totalMs: number;
}

interface MutablePlatformMetrics {
  taskStates: TaskStateMetrics;
  taskWait: MutableDurationMetrics;
  answerDuration: MutableDurationMetrics;
  zeroReferences: number;
  healthStatus: PlatformHealthStatus;
  captchaRequired: number;
  loginRequired: number;
  rateLimited: number;
  completedBrandBatchDuration: MutableDurationMetrics;
  failedBrandBatchDuration: MutableDurationMetrics;
}

/**
 * 正式 Worker 的低基数内部指标。API 刻意不接收 executionId、brandId、问题、
 * 回答或 URL，避免调用方误把业务数据变成指标标签。
 */
export class MetricsRegistry {
  private readonly metrics = new Map<PlatformId, MutablePlatformMetrics>();
  private outboxPending = 0;
  private outboxCorrupted = 0;
  private diskFreeBytes: number | null = null;
  private heartbeatAt: Date;
  private readonly businessTypeTaskStates = new Map<RpaBusinessType, TaskStateMetrics>();

  constructor(
    readonly workerType: RpaWorkerType,
    platforms: readonly PlatformId[],
    private readonly now: () => Date = () => new Date()
  ) {
    this.heartbeatAt = this.now();
    for (const platform of platforms) this.metrics.set(platform, initialPlatformMetrics());
  }

  heartbeat(at = this.now()): void {
    this.heartbeatAt = new Date(at.getTime());
  }

  setOutboxPending(count: number): void {
    this.outboxPending = nonNegativeInteger(count, "outboxPending");
  }

  incrementOutboxCorrupted(count = 1): void {
    this.outboxCorrupted += nonNegativeInteger(count, "outboxCorrupted");
  }

  setDiskFreeBytes(bytes: number): void {
    this.diskFreeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  replaceTaskStates(
    states: ReadonlyMap<PlatformId, Readonly<TaskStateMetrics>>
  ): void {
    for (const [platform, metrics] of this.metrics) {
      const next = states.get(platform);
      metrics.taskStates = next ? normalizeTaskStates(next) : emptyTaskStates();
    }
  }

  replaceBusinessTypeTaskStates(
    states: ReadonlyMap<RpaBusinessType, Readonly<TaskStateMetrics>>
  ): void {
    this.businessTypeTaskStates.clear();
    for (const [businessType, taskStates] of states) {
      this.businessTypeTaskStates.set(businessType, normalizeTaskStates(taskStates));
    }
  }

  transitionBusinessTypeTaskState(
    businessType: RpaBusinessType,
    from: TaskStateMetricName,
    to: TaskStateMetricName,
    count = 1
  ): void {
    const amount = nonNegativeInteger(count, "businessTypeTaskStateTransitionCount");
    const states = this.businessTypeTaskStates.get(businessType) ?? emptyTaskStates();
    states[from] = Math.max(0, states[from] - amount);
    states[to] += amount;
    this.businessTypeTaskStates.set(businessType, states);
  }

  transitionTaskState(
    platform: PlatformId,
    from: TaskStateMetricName,
    to: TaskStateMetricName,
    count = 1
  ): void {
    const amount = nonNegativeInteger(count, "taskStateTransitionCount");
    const taskStates = this.requirePlatform(platform).taskStates;
    taskStates[from] = Math.max(0, taskStates[from] - amount);
    taskStates[to] += amount;
  }

  observeTaskWait(platform: PlatformId, durationMs: number): void {
    observe(this.requirePlatform(platform).taskWait, durationMs);
  }

  observeAnswerDuration(platform: PlatformId, durationMs: number): void {
    observe(this.requirePlatform(platform).answerDuration, durationMs);
  }

  incrementZeroReferences(platform: PlatformId): void {
    this.requirePlatform(platform).zeroReferences++;
  }

  /** 阻断计数仅在状态发生迁移时增加，跨轮询保留的暂停不会重复计数。 */
  setPlatformHealth(platform: PlatformId, status: PlatformHealthStatus): void {
    const metrics = this.requirePlatform(platform);
    if (metrics.healthStatus !== status) {
      if (status === "CAPTCHA_REQUIRED") metrics.captchaRequired++;
      if (status === "LOGIN_REQUIRED") metrics.loginRequired++;
      if (status === "RATE_LIMITED") metrics.rateLimited++;
    }
    metrics.healthStatus = status;
  }

  observeBrandBatchDuration(
    platform: PlatformId,
    durationMs: number,
    outcome: "completed" | "failed"
  ): void {
    const metrics = this.requirePlatform(platform);
    observe(
      outcome === "completed"
        ? metrics.completedBrandBatchDuration
        : metrics.failedBrandBatchDuration,
      durationMs
    );
  }

  snapshot(): RpaMetricsSnapshot {
    const generatedAt = this.now();
    const platforms = [...this.metrics.entries()].map(([platform, metrics]) =>
      platformSnapshot(platform, metrics)
    );
    return {
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      workerType: this.workerType,
      workerHeartbeatAt: this.heartbeatAt.toISOString(),
      outboxPending: this.outboxPending,
      outboxCorrupted: this.outboxCorrupted,
      diskFreeBytes: this.diskFreeBytes,
      businessTypes: Object.fromEntries(
        [...this.businessTypeTaskStates].map(([businessType, states]) => [
          businessType,
          { ...states }
        ])
      ),
      totals: {
        taskStates: sumTaskStates(platforms.map(({ taskStates }) => taskStates)),
        taskWait: sumDurations(platforms.map(({ taskWait }) => taskWait)),
        answerDuration: sumDurations(platforms.map(({ answerDuration }) => answerDuration)),
        zeroReferences: sum(platforms.map(({ zeroReferences }) => zeroReferences)),
        captchaRequired: sum(platforms.map(({ captchaRequired }) => captchaRequired)),
        loginRequired: sum(platforms.map(({ loginRequired }) => loginRequired)),
        rateLimited: sum(platforms.map(({ rateLimited }) => rateLimited)),
        completedBrandBatchDuration: sumDurations(
          platforms.map(({ completedBrandBatchDuration }) => completedBrandBatchDuration)
        ),
        failedBrandBatchDuration: sumDurations(
          platforms.map(({ failedBrandBatchDuration }) => failedBrandBatchDuration)
        )
      },
      platforms
    };
  }

  private requirePlatform(platform: PlatformId): MutablePlatformMetrics {
    const metrics = this.metrics.get(platform);
    if (!metrics) throw new Error(`指标未注册平台：${platform}`);
    return metrics;
  }
}

/** 使用临时文件 + rename 原子更新固定 JSON 快照。 */
export class MetricsJsonSnapshotWriter {
  readonly filePath: string;

  constructor(
    directory: string,
    fileName = "worker-metrics.json"
  ) {
    this.filePath = path.join(path.resolve(directory), safeFileName(fileName));
  }

  async write(snapshot: RpaMetricsSnapshot): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
  }
}

/** 长批次执行时也会持续刷新 Worker 心跳和磁盘快照。 */
export class MetricsSnapshotPublisher {
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: MetricsRegistry,
    private readonly writer: MetricsJsonSnapshotWriter,
    private readonly intervalMs: number
  ) {}

  start(): void {
    if (this.timer) return;
    this.schedulePublish();
    this.timer = setInterval(() => this.schedulePublish(), this.intervalMs);
    this.timer.unref();
  }

  publish(): Promise<void> {
    this.registry.heartbeat();
    const snapshot = this.registry.snapshot();
    const operation = this.queue.then(() => this.writer.write(snapshot));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.publish().catch(() => undefined);
    await this.queue;
  }

  private schedulePublish(): void {
    void this.publish().catch(() => undefined);
  }
}

function initialPlatformMetrics(): MutablePlatformMetrics {
  return {
    taskStates: emptyTaskStates(),
    taskWait: emptyDuration(),
    answerDuration: emptyDuration(),
    zeroReferences: 0,
    // 创建 Session 尚未完成浏览器自检，不能提前宣称平台 READY。
    healthStatus: "DISABLED",
    captchaRequired: 0,
    loginRequired: 0,
    rateLimited: 0,
    completedBrandBatchDuration: emptyDuration(),
    failedBrandBatchDuration: emptyDuration()
  };
}

function platformSnapshot(
  platform: PlatformId,
  metrics: MutablePlatformMetrics
): PlatformMetricsSnapshot {
  return {
    platform,
    taskStates: { ...metrics.taskStates },
    taskWait: durationSnapshot(metrics.taskWait),
    answerDuration: durationSnapshot(metrics.answerDuration),
    zeroReferences: metrics.zeroReferences,
    healthStatus: metrics.healthStatus,
    paused: metrics.healthStatus !== "READY" && metrics.healthStatus !== "RUNNING",
    captchaRequired: metrics.captchaRequired,
    loginRequired: metrics.loginRequired,
    rateLimited: metrics.rateLimited,
    completedBrandBatchDuration: durationSnapshot(metrics.completedBrandBatchDuration),
    failedBrandBatchDuration: durationSnapshot(metrics.failedBrandBatchDuration)
  };
}

function emptyTaskStates(): TaskStateMetrics {
  return { pending: 0, processing: 0, succeeded: 0, finalFailed: 0 };
}

function normalizeTaskStates(states: Readonly<TaskStateMetrics>): TaskStateMetrics {
  return {
    pending: nonNegativeInteger(states.pending, "pending"),
    processing: nonNegativeInteger(states.processing, "processing"),
    succeeded: nonNegativeInteger(states.succeeded, "succeeded"),
    finalFailed: nonNegativeInteger(states.finalFailed, "finalFailed")
  };
}

function emptyDuration(): MutableDurationMetrics {
  return { count: 0, totalMs: 0 };
}

function observe(metrics: MutableDurationMetrics, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  metrics.count++;
  metrics.totalMs += durationMs;
}

function durationSnapshot(metrics: MutableDurationMetrics): DurationMetrics {
  return {
    count: metrics.count,
    totalMs: metrics.totalMs,
    averageMs: metrics.count === 0 ? 0 : metrics.totalMs / metrics.count
  };
}

function sumTaskStates(states: readonly TaskStateMetrics[]): TaskStateMetrics {
  return states.reduce((total, current) => ({
    pending: total.pending + current.pending,
    processing: total.processing + current.processing,
    succeeded: total.succeeded + current.succeeded,
    finalFailed: total.finalFailed + current.finalFailed
  }), emptyTaskStates());
}

function sumDurations(durations: readonly DurationMetrics[]): DurationMetrics {
  return durationSnapshot(durations.reduce((total, current) => ({
    count: total.count + current.count,
    totalMs: total.totalMs + current.totalMs
  }), emptyDuration()));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负安全整数。`);
  }
  return value;
}

function safeFileName(fileName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new Error("metrics fileName 只能包含字母、数字、点、下划线和连字符。");
  }
  return fileName;
}
