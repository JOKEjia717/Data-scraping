/**
 * 纯内存品牌批次调度器。
 *
 * 本模块只负责分组、排序和平台运行锁；不连接数据库、浏览器，也不创建对话。
 */
import type { PlatformId } from "./types.js";

export type BrandBatchStatus = "queued" | "running" | "completed" | "failed";

export interface EnqueueBrandTaskInput {
  id: string;
  brandId: string;
  businessGroupId: string;
  platformId: PlatformId;
  question: string;
  /** 数值越大优先级越高，默认 0。 */
  priority?: number;
  /** 用于批次排序；缺省时使用入队时间。 */
  createdAt?: Date | string | number;
}

export interface BrandBatchTask {
  id: string;
  brandId: string;
  businessGroupId: string;
  platformId: PlatformId;
  question: string;
  priority: number;
  createdAt: number;
  enqueueSequence: number;
}

export interface BrandBatch {
  id: string;
  key: string;
  brandId: string;
  businessGroupId: string;
  platformId: PlatformId;
  /** 批内最高任务优先级。 */
  priority: number;
  /** 批内最早任务创建时间。 */
  createdAt: number;
  enqueueSequence: number;
  status: BrandBatchStatus;
  tasks: readonly BrandBatchTask[];
  startedAt?: number;
  completedAt?: number;
  errorMessage?: string;
}

interface MutableBrandBatch extends Omit<BrandBatch, "tasks"> {
  tasks: BrandBatchTask[];
}

/**
 * 同平台最多运行一个批次；调用方完成当前批次后必须显式 complete/fail，平台锁
 * 才会释放。不同平台持有独立锁，可由未来的执行器分别拉取。
 */
export class BrandBatchScheduler {
  private enqueueSequence = 0;
  private batchSequence = 0;
  private readonly taskIds = new Set<string>();
  private readonly batchesById = new Map<string, MutableBrandBatch>();
  private readonly activeBatchesByKey = new Map<string, MutableBrandBatch>();
  private readonly runningBatchByPlatform = new Map<PlatformId, string>();

  /** 将单条任务并入对应的 brandId + businessGroupId + platformId 批次。 */
  enqueue(input: EnqueueBrandTaskInput): BrandBatch {
    const task = this.normalizeTask(input);
    if (this.taskIds.has(task.id)) {
      throw new Error(`任务已入队，不能重复添加：${task.id}`);
    }

    const key = createBrandBatchKey(task.brandId, task.businessGroupId, task.platformId);
    let batch = this.activeBatchesByKey.get(key);
    if (!batch) {
      batch = {
        id: `brand-batch-${++this.batchSequence}`,
        key,
        brandId: task.brandId,
        businessGroupId: task.businessGroupId,
        platformId: task.platformId,
        priority: task.priority,
        createdAt: task.createdAt,
        enqueueSequence: task.enqueueSequence,
        status: "queued",
        tasks: []
      };
      this.activeBatchesByKey.set(key, batch);
      this.batchesById.set(batch.id, batch);
    }

    // 运行中的同组任务仍追加到当前批次，避免调度器切到其他品牌后再回头执行。
    batch.tasks.push(task);
    batch.priority = Math.max(batch.priority, task.priority);
    batch.createdAt = Math.min(batch.createdAt, task.createdAt);
    this.taskIds.add(task.id);
    return batch;
  }

  /**
   * 获取指定平台的下一个完整批次并加平台运行锁。锁存在时返回 undefined，保证
   * 同平台内部串行。选择顺序：高优先级、早创建、早入队。
   */
  getNextBatch(platformId: PlatformId): BrandBatch | undefined {
    if (this.runningBatchByPlatform.has(platformId)) return undefined;

    const nextBatch = [...this.batchesById.values()]
      .filter((batch) => batch.platformId === platformId && batch.status === "queued")
      .sort(compareBrandBatches)[0];
    if (!nextBatch) return undefined;

    nextBatch.status = "running";
    nextBatch.startedAt = Date.now();
    this.runningBatchByPlatform.set(platformId, nextBatch.id);
    return nextBatch;
  }

  /** 标记运行批次完成并释放对应平台。 */
  completeBatch(batchId: string): BrandBatch {
    return this.finishBatch(batchId, "completed");
  }

  /** 标记运行批次失败、记录错误并释放对应平台。 */
  failBatch(batchId: string, error: unknown): BrandBatch {
    return this.finishBatch(batchId, "failed", formatError(error));
  }

  private finishBatch(
    batchId: string,
    status: "completed" | "failed",
    errorMessage?: string
  ): BrandBatch {
    const batch = this.batchesById.get(batchId);
    if (!batch) throw new Error(`品牌批次不存在：${batchId}`);
    if (batch.status !== "running") {
      throw new Error(`品牌批次不是运行状态，不能标记为 ${status}：${batchId}`);
    }

    batch.status = status;
    batch.completedAt = Date.now();
    batch.errorMessage = errorMessage;
    this.runningBatchByPlatform.delete(batch.platformId);
    this.activeBatchesByKey.delete(batch.key);
    return batch;
  }

  private normalizeTask(input: EnqueueBrandTaskInput): BrandBatchTask {
    const id = requireNonEmpty(input.id, "id");
    const brandId = requireNonEmpty(input.brandId, "brandId");
    const businessGroupId = requireNonEmpty(input.businessGroupId, "businessGroupId");
    const question = requireNonEmpty(input.question, "question", false);
    const priority = input.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error("priority 必须是有限数值。");
    const createdAt = normalizeCreatedAt(input.createdAt);

    return {
      id,
      brandId,
      businessGroupId,
      platformId: input.platformId,
      question,
      priority,
      createdAt,
      enqueueSequence: ++this.enqueueSequence
    };
  }
}

export function createBrandBatchKey(
  brandId: string,
  businessGroupId: string,
  platformId: PlatformId
): string {
  return JSON.stringify([brandId, businessGroupId, platformId]);
}

function compareBrandBatches(a: BrandBatch, b: BrandBatch): number {
  return b.priority - a.priority ||
    a.createdAt - b.createdAt ||
    a.enqueueSequence - b.enqueueSequence;
}

function normalizeCreatedAt(value: Date | string | number | undefined): number {
  const timestamp = value === undefined
    ? Date.now()
    : value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("createdAt 不是有效时间。");
  return timestamp;
}

function requireNonEmpty(value: string, field: string, trim = true): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} 不能为空。`);
  }
  return trim ? value.trim() : value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
