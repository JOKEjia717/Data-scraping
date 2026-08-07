/** geno-digital-api RPA 执行记录在爬虫侧的稳定任务模型。 */
import type { PlatformId } from "./types.js";

export type RpaBusinessType = "DIAGNOSIS" | "ARTICLE_PROBE" | "ENTRY_MONITOR";
export type RpaWorkerType = "diagnosis" | "monitor";

interface BaseRpaTask {
  /** rpa_task_execution.id；按字符串保存，避免 bigint 精度丢失。 */
  executionId: string;
  /** rpa_task_execution.task_id，即 brand_rpa_dispatch_task.id。 */
  dispatchTaskId: string;
  /** brand_rpa_dispatch_task.business_task_id，才是真正业务任务 ID。 */
  businessTaskId: string;
  tenantKey: string;
  keyword: string;
  aiModelId: string;
  aiModelName: string;
  deepThinking: boolean;
  failCount: number;
  priority: number;
  createdAt: string;
}

export interface DiagnosisRpaTask extends BaseRpaTask {
  businessType: "DIAGNOSIS";
  brandId: string;
}

export interface ArticleProbeRpaTask extends BaseRpaTask {
  businessType: "ARTICLE_PROBE";
  brandId: string;
}

/** Java 创建 execution 时固化的 ENTRY_MONITOR 不可变上下文。 */
export interface EntryMonitorRpaTask extends BaseRpaTask {
  businessType: "ENTRY_MONITOR";
  /** 与 tenantKey 值相同的协议别名，便于按最新版上下文命名消费。 */
  tenantId: string;
  projectId: string;
  intentEntryId: string;
  /** Asia/Shanghai 自然日，格式 YYYY-MM-DD。 */
  monitorDate: string;
  /** 同词条、同平台、当日的执行序号，从 1 开始。 */
  repetitionNo: number;
}

export type RpaTask = DiagnosisRpaTask | ArticleProbeRpaTask | EntryMonitorRpaTask;

/** 可直接进入 BrandBatchScheduler 和 business 单题执行器的任务。 */
export interface CollectionTask extends BaseRpaTask {
  businessType: RpaBusinessType;
  /** BrandBatchScheduler 使用 execution ID 做本地任务唯一键。 */
  id: string;
  /** 旧批次调度器的稳定分组字段；ENTRY_MONITOR 使用 projectId。 */
  brandId: string;
  platformId: PlatformId;
  businessGroupId: string;
  /** business 模式原样发送的题目；与 keyword 保持同一字符串。 */
  question: string;
  mode: "business";
  tenantId?: string;
  projectId?: string;
  intentEntryId?: string;
  monitorDate?: string;
  repetitionNo?: number;
}

export function businessTypesForWorker(
  workerType: RpaWorkerType
): readonly RpaBusinessType[] {
  return workerType === "diagnosis"
    ? ["DIAGNOSIS"]
    : ["ARTICLE_PROBE", "ENTRY_MONITOR"];
}

export function isBusinessTypeAllowedForWorker(
  workerType: RpaWorkerType,
  businessType: RpaBusinessType
): boolean {
  return businessTypesForWorker(workerType).includes(businessType);
}

/** @deprecated 新代码应使用 businessTypesForWorker 并携带任务真实 businessType。 */
export function businessTypeForWorker(workerType: RpaWorkerType): RpaBusinessType {
  return workerType === "diagnosis" ? "DIAGNOSIS" : "ARTICLE_PROBE";
}

export function toCollectionTask(task: RpaTask): CollectionTask {
  const platformId = resolveRpaPlatform(task.aiModelId, task.aiModelName);
  const brandId = task.businessType === "ENTRY_MONITOR" ? task.projectId : task.brandId;
  const businessGroupId = task.businessType === "ENTRY_MONITOR"
    ? JSON.stringify([
      task.tenantId,
      task.businessType,
      task.projectId,
      task.aiModelId,
      task.monitorDate
    ])
    : JSON.stringify([
      task.tenantKey,
      task.businessType,
      task.businessTaskId
    ]);
  return {
    ...task,
    id: task.executionId,
    brandId,
    platformId,
    businessGroupId,
    question: task.keyword,
    mode: "business"
  };
}

export function isEntryMonitorTask(task: RpaTask): task is EntryMonitorRpaTask {
  return task.businessType === "ENTRY_MONITOR";
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
