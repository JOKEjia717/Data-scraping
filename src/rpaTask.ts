/** geno-digital-api RPA 执行记录在爬虫侧的稳定任务模型。 */
import type { PlatformId } from "./types.js";

export type RpaBusinessType = "DIAGNOSIS" | "ARTICLE_PROBE";
export type RpaWorkerType = "diagnosis" | "monitor";

export interface RpaTask {
  /** rpa_task_execution.id；按字符串保存，避免 bigint 精度丢失。 */
  executionId: string;
  /** rpa_task_execution.task_id，即 brand_rpa_dispatch_task.id。 */
  dispatchTaskId: string;
  businessType: RpaBusinessType;
  /** brand_rpa_dispatch_task.business_task_id，才是真正业务任务 ID。 */
  businessTaskId: string;
  tenantKey: string;
  brandId: string;
  keyword: string;
  aiModelId: string;
  aiModelName: string;
  deepThinking: boolean;
  failCount: number;
  priority: number;
  createdAt: string;
}

/** 可直接进入 BrandBatchScheduler 和 business 单题执行器的任务。 */
export interface CollectionTask extends RpaTask {
  /** BrandBatchScheduler 使用 execution ID 做本地任务唯一键。 */
  id: string;
  platformId: PlatformId;
  businessGroupId: string;
  /** business 模式原样发送的题目；与 keyword 保持同一字符串。 */
  question: string;
  mode: "business";
}

export function businessTypeForWorker(workerType: RpaWorkerType): RpaBusinessType {
  return workerType === "diagnosis" ? "DIAGNOSIS" : "ARTICLE_PROBE";
}

export function toCollectionTask(task: RpaTask): CollectionTask {
  return {
    ...task,
    id: task.executionId,
    platformId: resolveRpaPlatform(task.aiModelId, task.aiModelName),
    businessGroupId: JSON.stringify([
      task.tenantKey,
      task.businessType,
      task.businessTaskId
    ]),
    question: task.keyword,
    mode: "business"
  };
}

/** 与 geno-digital-api AiEngineEnum 的 1/2/3/4 映射保持一致。 */
export function resolveRpaPlatform(aiModelId: string, aiModelName: string): PlatformId {
  const byId: Record<string, PlatformId> = {
    "1": "doubao",
    "2": "deepseek",
    "3": "yuanbao",
    "4": "qianwen"
  };
  const idMatch = byId[aiModelId.trim()];
  if (idMatch) return idMatch;

  const normalizedName = aiModelName.replace(/\s+/g, "").toLowerCase();
  if (/豆包|doubao/.test(normalizedName)) return "doubao";
  if (/deepseek|深度求索/.test(normalizedName)) return "deepseek";
  if (/元宝|腾讯元宝|yuanbao/.test(normalizedName)) return "yuanbao";
  if (/千问|通义千问|qianwen|qwen/.test(normalizedName)) return "qianwen";
  throw new Error(`无法识别 RPA AI 模型：id=${aiModelId}, name=${aiModelName}`);
}
