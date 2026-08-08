import type {
  CollectionTask,
  ContextualMonitorBusinessType,
  ContentStyleMonitorRpaTask,
  EntryMonitorRpaTask
} from "./rpaTask.js";
import type { PlatformId } from "./types.js";

export const ENTRY_MONITOR_TIMEZONE = "Asia/Shanghai";

export type EntryMonitorErrorCode =
  | "INVALID_EXECUTION_CONTEXT"
  | "WORKER_BUSINESS_MISMATCH"
  | "DATE_WINDOW_EXPIRED"
  | "CONVERSATION_RESTORE_FAILED"
  | "AMBIGUOUS_RECOVERY";

export interface EntryMonitorConversationKey {
  tenantId: string;
  projectId: string;
  aiModelId: string;
  platformId: PlatformId;
  monitorDate: string;
}

export interface ContextualMonitorConversationKey extends EntryMonitorConversationKey {
  businessType: ContextualMonitorBusinessType;
}

export type EntryMonitorSubmissionState =
  | "PREPARED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "ANSWER_READY"
  | "PERSISTED";

/** 相同 keyword 多次执行时，页面恢复只依赖 execution 身份和 DOM baseline。 */
export interface EntryMonitorPageOwner {
  conversationKey: string;
  executionId: string;
  intentEntryId: string;
  repetitionNo: number;
  submissionState: EntryMonitorSubmissionState;
  baselineUserMessageCount: number;
  baselineAssistantMessageCount: number;
  preparedAt: string;
  submittedAt?: string;
}

export class EntryMonitorError extends Error {
  constructor(
    readonly errorCode: EntryMonitorErrorCode,
    message: string
  ) {
    super(message);
    this.name = "EntryMonitorError";
  }
}

/** 固定使用上海时区，不能用 UTC 的 toISOString().slice(0, 10)。 */
export function getShanghaiDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("now 不是有效日期。");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ENTRY_MONITOR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function isMonitorDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day!));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month! - 1 &&
    candidate.getUTCDate() === day;
}

export function isEntryMonitorTaskEligibleToday(
  task: Pick<EntryMonitorRpaTask, "monitorDate">,
  now = new Date()
): boolean {
  return isMonitorDate(task.monitorDate) && task.monitorDate === getShanghaiDate(now);
}

export function assertEntryMonitorTaskEligibleToday(
  task: Pick<EntryMonitorRpaTask, "executionId" | "monitorDate">,
  now = new Date()
): void {
  if (!isEntryMonitorTaskEligibleToday(task, now)) {
    throw new EntryMonitorError(
      "DATE_WINDOW_EXPIRED",
      `ENTRY_MONITOR execution ${task.executionId} 不属于上海当前自然日。`
    );
  }
}

export function assertContextualMonitorTaskEligibleToday(
  task: Pick<
    EntryMonitorRpaTask | ContentStyleMonitorRpaTask,
    "businessType" | "executionId" | "monitorDate"
  >,
  now = new Date()
): void {
  if (!isEntryMonitorTaskEligibleToday(task, now)) {
    throw new EntryMonitorError(
      "DATE_WINDOW_EXPIRED",
      `${task.businessType} execution ${task.executionId} 不属于上海当前自然日。`
    );
  }
}

export type EntryMonitorCollectionTask = CollectionTask & {
  businessType: "ENTRY_MONITOR";
  tenantId: string;
  projectId: string;
  intentEntryId: string;
  monitorDate: string;
  repetitionNo: number;
};

export type ContextualMonitorCollectionTask = CollectionTask & {
  businessType: ContextualMonitorBusinessType;
  tenantId: string;
  projectId: string;
  intentEntryId: string;
  monitorDate: string;
  repetitionNo: number;
};

export function assertEntryMonitorCollectionContext(
  task: CollectionTask
): asserts task is EntryMonitorCollectionTask {
  if (task.businessType !== "ENTRY_MONITOR") return;
  try {
    requireNonEmpty(task.tenantId ?? "", "tenantId");
    requireDatabaseId(task.projectId ?? "", "projectId");
    requireDatabaseId(task.intentEntryId ?? "", "intentEntryId");
    requireMonitorDate(task.monitorDate ?? "");
    requirePositiveInteger(task.repetitionNo ?? 0, "repetitionNo");
  } catch (error) {
    throw new EntryMonitorError(
      "INVALID_EXECUTION_CONTEXT",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function assertContextualMonitorCollectionContext(
  task: CollectionTask
): asserts task is ContextualMonitorCollectionTask {
  if (task.businessType !== "ENTRY_MONITOR" && task.businessType !== "CONTENT_STYLE_MONITOR") {
    return;
  }
  try {
    requireNonEmpty(task.tenantId ?? "", "tenantId");
    requireDatabaseId(task.projectId ?? "", "projectId");
    requireDatabaseId(task.intentEntryId ?? "", "intentEntryId");
    requireMonitorDate(task.monitorDate ?? "");
    requirePositiveInteger(task.repetitionNo ?? 0, "repetitionNo");
  } catch (error) {
    throw new EntryMonitorError(
      "INVALID_EXECUTION_CONTEXT",
      `${task.businessType}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function entryMonitorConversationKeyFor(
  task: Pick<EntryMonitorRpaTask, "tenantId" | "projectId" | "aiModelId" | "monitorDate"> & {
    platformId: PlatformId;
  }
): EntryMonitorConversationKey {
  return {
    tenantId: requireNonEmpty(task.tenantId, "tenantId"),
    projectId: requireDatabaseId(task.projectId, "projectId"),
    aiModelId: requireDatabaseId(task.aiModelId, "aiModelId"),
    platformId: task.platformId,
    monitorDate: requireMonitorDate(task.monitorDate)
  };
}

export function contextualMonitorConversationKeyFor(
  task: Pick<
    EntryMonitorRpaTask | ContentStyleMonitorRpaTask,
    "businessType" | "tenantId" | "projectId" | "aiModelId" | "monitorDate"
  > & { platformId: PlatformId }
): ContextualMonitorConversationKey {
  return {
    businessType: task.businessType,
    ...entryMonitorConversationKeyFor(task)
  };
}

export function serializeEntryMonitorConversationKey(
  key: EntryMonitorConversationKey
): string {
  return JSON.stringify([
    requireNonEmpty(key.tenantId, "tenantId"),
    "ENTRY_MONITOR",
    requireDatabaseId(key.projectId, "projectId"),
    requireDatabaseId(key.aiModelId, "aiModelId"),
    requireMonitorDate(key.monitorDate)
  ]);
}

export function serializeContextualMonitorConversationKey(
  key: ContextualMonitorConversationKey
): string {
  return JSON.stringify([
    requireNonEmpty(key.tenantId, "tenantId"),
    contextualBusinessType(key.businessType),
    requireDatabaseId(key.projectId, "projectId"),
    requireDatabaseId(key.aiModelId, "aiModelId"),
    requireMonitorDate(key.monitorDate)
  ]);
}

export function createEntryMonitorPageOwner(
  task: Pick<EntryMonitorRpaTask, "executionId" | "intentEntryId" | "repetitionNo">,
  conversationKey: string,
  baseline: { userMessageCount: number; assistantMessageCount: number },
  now = new Date()
): EntryMonitorPageOwner {
  return {
    conversationKey: requireNonEmpty(conversationKey, "conversationKey"),
    executionId: requireDatabaseId(task.executionId, "executionId"),
    intentEntryId: requireDatabaseId(task.intentEntryId, "intentEntryId"),
    repetitionNo: requirePositiveInteger(task.repetitionNo, "repetitionNo"),
    submissionState: "PREPARED",
    baselineUserMessageCount: requireNonNegativeInteger(
      baseline.userMessageCount,
      "baselineUserMessageCount"
    ),
    baselineAssistantMessageCount: requireNonNegativeInteger(
      baseline.assistantMessageCount,
      "baselineAssistantMessageCount"
    ),
    preparedAt: validDate(now, "preparedAt").toISOString()
  };
}

export function transitionEntryMonitorPageOwner(
  owner: Readonly<EntryMonitorPageOwner>,
  next: EntryMonitorSubmissionState,
  now = new Date()
): EntryMonitorPageOwner {
  const order: EntryMonitorSubmissionState[] = [
    "PREPARED", "SUBMITTING", "SUBMITTED", "ANSWER_READY", "PERSISTED"
  ];
  const currentIndex = order.indexOf(owner.submissionState);
  const nextIndex = order.indexOf(next);
  if (nextIndex !== currentIndex + 1) {
    throw new EntryMonitorError(
      "AMBIGUOUS_RECOVERY",
      `非法上下文监测提交状态迁移：${owner.submissionState} -> ${next}`
    );
  }
  return {
    ...owner,
    submissionState: next,
    ...(next === "SUBMITTED" ? { submittedAt: validDate(now, "submittedAt").toISOString() } : {})
  };
}

export function entryMonitorOwnerMatchesExecution(
  owner: Readonly<EntryMonitorPageOwner>,
  task: Pick<EntryMonitorRpaTask, "executionId" | "intentEntryId" | "repetitionNo">,
  conversationKey: string
): boolean {
  return owner.conversationKey === conversationKey &&
    owner.executionId === task.executionId &&
    owner.intentEntryId === task.intentEntryId &&
    owner.repetitionNo === task.repetitionNo;
}

function requireMonitorDate(value: string): string {
  if (!isMonitorDate(value)) throw new Error("monitorDate 必须是有效的 YYYY-MM-DD。");
  return value;
}

function contextualBusinessType(value: string): ContextualMonitorBusinessType {
  if (value === "ENTRY_MONITOR" || value === "CONTENT_STYLE_MONITOR") return value;
  throw new Error("businessType 不是上下文监测任务。");
}

function requireDatabaseId(value: string, field: string): string {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${field} 不是有效数据库 ID。`);
  return value.trim();
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  return value.trim();
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数。`);
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负整数。`);
  return value;
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${field} 不是有效日期。`);
  return value;
}
