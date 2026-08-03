/**
 * 执行模式与品牌批次规则。这里不依赖页面或数据库，便于在真正操作浏览器前
 * 完成输入校验、批次合并和提问策略判定。
 */
import type {
  BusinessBatchInput,
  CollectionMode,
  CrawlBatch
} from "./types.js";

export const DEFAULT_RESEARCH_PROMPT_PREFIX =
  "请联网搜索后回答，并提供可点击的参考来源。问题：";

export interface CollectionModeDefaults {
  promptPrefix: string;
  retryOnNoReferences: boolean;
  regenerateOnNoReferences: boolean;
}

export interface PlannedBatchQuestion {
  batch: CrawlBatch;
  batchIndex: number;
  batchQuestionIndex: number;
  question: string;
  startsNewConversation: boolean;
}

/** 同租户、同业务任务、同品牌的多段输入必须合并到同一个对话批次。 */
export function normalizeBusinessBatches(input: unknown): CrawlBatch[] {
  const rawBatches = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.batches)
      ? input.batches
      : null;
  if (!rawBatches) {
    throw new Error("business 问题文件必须是批次数组，或包含 batches 数组的对象。");
  }
  if (rawBatches.length === 0) {
    throw new Error("business 问题文件至少需要一个品牌批次。");
  }

  const batches = new Map<string, CrawlBatch>();
  for (const [index, rawBatch] of rawBatches.entries()) {
    if (!isRecord(rawBatch)) {
      throw new Error(`business 第 ${index + 1} 个批次必须是对象。`);
    }
    const tenantId = requireNonEmptyString(rawBatch.tenantId, index, "tenantId");
    const businessTaskId = requireNonEmptyString(
      rawBatch.businessTaskId,
      index,
      "businessTaskId"
    );
    const brand = requireNonEmptyString(rawBatch.brand, index, "brand");
    if (!Array.isArray(rawBatch.questions) || rawBatch.questions.length === 0) {
      throw new Error(`business 第 ${index + 1} 个批次的 questions 必须是非空字符串数组。`);
    }
    const questions = rawBatch.questions.map((question, questionIndex) => {
      if (typeof question !== "string" || !question.trim()) {
        throw new Error(
          `business 第 ${index + 1} 个批次的第 ${questionIndex + 1} 个问题不能为空。`
        );
      }
      // 只用 trim 校验；实际发送时保留业务问题原字符串，不做改写。
      return question;
    });
    const key = JSON.stringify([tenantId, businessTaskId, brand]);
    const existing = batches.get(key);
    if (existing) {
      existing.questions.push(...questions);
    } else {
      batches.set(key, { key, tenantId, businessTaskId, brand, questions });
    }
  }

  return [...batches.values()];
}

/** research 仍把原问题库视为一个连续对话。 */
export function createResearchBatch(questions: readonly string[]): CrawlBatch {
  return {
    key: "research",
    tenantId: "",
    businessTaskId: "",
    brand: "",
    questions: [...questions]
  };
}

export function flattenBatchQuestions(batches: readonly CrawlBatch[]): string[] {
  return batches.flatMap((batch) => batch.questions);
}

/** 每个品牌批次只在第一题前创建对话，批内其余问题沿用该对话。 */
export function planBatchQuestions(
  batches: readonly CrawlBatch[]
): PlannedBatchQuestion[] {
  return batches.flatMap((batch, batchIndex) =>
    batch.questions.map((question, batchQuestionIndex) => ({
      batch,
      batchIndex,
      batchQuestionIndex,
      question,
      startsNewConversation: batchQuestionIndex === 0
    }))
  );
}

/** business 必须逐字发送原问题；research 保留可配置的提示词前缀。 */
export function buildSubmittedQuestion(
  mode: CollectionMode,
  promptPrefix: string,
  question: string
): string {
  return mode === "business" ? question : `${promptPrefix}${question}`;
}

/** 模式默认值集中定义，避免 CLI、单题执行器和批量执行器出现策略漂移。 */
export function getCollectionModeDefaults(
  mode: CollectionMode
): CollectionModeDefaults {
  return mode === "research"
    ? {
        promptPrefix: DEFAULT_RESEARCH_PROMPT_PREFIX,
        retryOnNoReferences: true,
        regenerateOnNoReferences: true
      }
    : {
        promptPrefix: "",
        retryOnNoReferences: false,
        regenerateOnNoReferences: false
      };
}

/** business 的“有回答、零引用”是成功；research 保留原 no_references 状态。 */
export function getNoReferencesStatus(
  mode: CollectionMode
): "success" | "no_references" {
  return mode === "business" ? "success" : "no_references";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNonEmptyString(
  value: unknown,
  batchIndex: number,
  field: string
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`business 第 ${batchIndex + 1} 个批次缺少非空 ${field}。`);
  }
  return value.trim();
}
