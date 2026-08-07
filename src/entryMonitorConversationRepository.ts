import {
  serializeEntryMonitorConversationKey,
  type EntryMonitorConversationKey
} from "./entryMonitor.js";
import {
  MysqlRpaSqlClient,
  type RpaSqlClient
} from "./rpaTaskRepository.js";

export type EntryMonitorConversationStatus = "ACTIVE" | "UNAVAILABLE" | "CLOSED";

export interface EntryMonitorConversation extends EntryMonitorConversationKey {
  conversationKey: string;
  conversationUrl: string;
  status: EntryMonitorConversationStatus;
  questionCount: number;
  lastExecutionId?: string;
  ownerWorkerId?: string;
  createdAt: string;
  lastUsedAt: string;
  unavailableReason?: string;
}

export interface EntryMonitorConversationOwnership {
  executionId: string;
  workerId: string;
}

export interface EntryMonitorConversationRepository {
  find(key: EntryMonitorConversationKey): Promise<EntryMonitorConversation | undefined>;
  upsertActive(record: EntryMonitorConversation): Promise<void>;
  updateUrl(key: EntryMonitorConversationKey, url: string): Promise<void>;
  touch(
    key: EntryMonitorConversationKey,
    usedAt: Date,
    ownership?: EntryMonitorConversationOwnership
  ): Promise<void>;
  incrementQuestionCount(
    key: EntryMonitorConversationKey,
    ownership: EntryMonitorConversationOwnership,
    usedAt: Date
  ): Promise<void>;
  markUnavailable(key: EntryMonitorConversationKey, reason: string): Promise<void>;
  closeExpired(beforeDate: string): Promise<number>;
}

interface EntryMonitorConversationRow {
  tenantId: unknown;
  projectId: unknown;
  aiModelId: unknown;
  conversationDate: unknown;
  conversationUrl: unknown;
  status: unknown;
  questionCount: unknown;
  lastExecutionId: unknown;
  ownerWorkerId: unknown;
  lastUsedAt: unknown;
  failureReason: unknown;
  createdAt: unknown;
}

const FIND_SQL = `
SELECT
  tenant_id AS tenantId,
  project_id AS projectId,
  ai_model_id AS aiModelId,
  conversation_date AS conversationDate,
  conversation_url AS conversationUrl,
  status,
  question_count AS questionCount,
  last_execution_id AS lastExecutionId,
  owner_worker_id AS ownerWorkerId,
  last_used_at AS lastUsedAt,
  failure_reason AS failureReason,
  create_time AS createdAt
FROM rpa_conversation_session
WHERE tenant_id = ?
  AND business_type = 'ENTRY_MONITOR'
  AND project_id = ?
  AND ai_model_id = ?
  AND conversation_date = ?
  AND deleted = 0
LIMIT 1`;

const UPSERT_ACTIVE_SQL = `
INSERT INTO rpa_conversation_session (
  business_type,
  project_id,
  ai_model_id,
  conversation_date,
  conversation_url,
  status,
  question_count,
  last_execution_id,
  owner_worker_id,
  last_used_at,
  failure_reason,
  creator,
  updater,
  deleted,
  tenant_id
) VALUES ('ENTRY_MONITOR', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, NULL, ?, ?, 0, ?)
ON DUPLICATE KEY UPDATE
  conversation_url = VALUES(conversation_url),
  status = 'ACTIVE',
  question_count = VALUES(question_count),
  last_execution_id = VALUES(last_execution_id),
  owner_worker_id = VALUES(owner_worker_id),
  last_used_at = VALUES(last_used_at),
  failure_reason = NULL,
  updater = VALUES(updater),
  create_time = CURRENT_TIMESTAMP,
  update_time = CURRENT_TIMESTAMP`;

const UPDATE_URL_SQL = `
UPDATE rpa_conversation_session
SET conversation_url = ?,
    status = 'ACTIVE',
    failure_reason = NULL,
    update_time = CURRENT_TIMESTAMP
WHERE tenant_id = ?
  AND business_type = 'ENTRY_MONITOR'
  AND project_id = ?
  AND ai_model_id = ?
  AND conversation_date = ?
  AND deleted = 0`;

const TOUCH_SQL = `
UPDATE rpa_conversation_session
SET last_used_at = ?,
    last_execution_id = COALESCE(?, last_execution_id),
    owner_worker_id = COALESCE(?, owner_worker_id),
    updater = COALESCE(?, updater),
    update_time = CURRENT_TIMESTAMP
WHERE tenant_id = ?
  AND business_type = 'ENTRY_MONITOR'
  AND project_id = ?
  AND ai_model_id = ?
  AND conversation_date = ?
  AND deleted = 0`;

const INCREMENT_QUESTION_COUNT_SQL = `
UPDATE rpa_conversation_session
SET question_count = question_count + IF(last_execution_id = ?, 0, 1),
    last_execution_id = ?,
    owner_worker_id = ?,
    last_used_at = ?,
    updater = ?,
    update_time = CURRENT_TIMESTAMP
WHERE tenant_id = ?
  AND business_type = 'ENTRY_MONITOR'
  AND project_id = ?
  AND ai_model_id = ?
  AND conversation_date = ?
  AND deleted = 0
  AND status = 'ACTIVE'`;

const MARK_UNAVAILABLE_SQL = `
UPDATE rpa_conversation_session
SET status = 'UNAVAILABLE',
    failure_reason = ?,
    update_time = CURRENT_TIMESTAMP
WHERE tenant_id = ?
  AND business_type = 'ENTRY_MONITOR'
  AND project_id = ?
  AND ai_model_id = ?
  AND conversation_date = ?
  AND deleted = 0`;

const CLOSE_EXPIRED_SQL = `
UPDATE rpa_conversation_session
SET status = 'CLOSED',
    failure_reason = COALESCE(failure_reason, 'Shanghai date expired'),
    update_time = CURRENT_TIMESTAMP
WHERE business_type = 'ENTRY_MONITOR'
  AND conversation_date < ?
  AND status = 'ACTIVE'
  AND deleted = 0`;

/** Database-backed ENTRY_MONITOR session ownership; never read by DIAGNOSIS. */
export class MysqlEntryMonitorConversationRepository
implements EntryMonitorConversationRepository {
  constructor(private readonly client: RpaSqlClient = new MysqlRpaSqlClient()) {}

  async find(key: EntryMonitorConversationKey): Promise<EntryMonitorConversation | undefined> {
    const normalized = normalizeKey(key);
    const rows = await this.client.queryRows<EntryMonitorConversationRow>(
      FIND_SQL,
      keyParameters(normalized)
    );
    return rows[0] ? mapRow(rows[0], normalized.platformId) : undefined;
  }

  async upsertActive(record: EntryMonitorConversation): Promise<void> {
    const normalized = normalizeRecord(record);
    await this.client.executeUpdate(UPSERT_ACTIVE_SQL, [
      normalized.projectId,
      normalized.aiModelId,
      normalized.monitorDate,
      normalized.conversationUrl,
      normalized.questionCount,
      normalized.lastExecutionId ?? null,
      normalized.ownerWorkerId ?? null,
      mysqlDateTime(new Date(normalized.lastUsedAt), "lastUsedAt"),
      normalized.ownerWorkerId ?? "ENTRY_MONITOR",
      normalized.ownerWorkerId ?? "ENTRY_MONITOR",
      normalized.tenantId
    ]);
  }

  async updateUrl(key: EntryMonitorConversationKey, url: string): Promise<void> {
    const normalized = normalizeKey(key);
    await requireUpdated(this.client.executeUpdate(UPDATE_URL_SQL, [
      safeHttpUrl(url),
      ...keyParameters(normalized)
    ]), normalized, "updateUrl");
  }

  async touch(
    key: EntryMonitorConversationKey,
    usedAt: Date,
    ownership?: EntryMonitorConversationOwnership
  ): Promise<void> {
    const normalized = normalizeKey(key);
    const owner = ownership ? normalizeOwnership(ownership) : undefined;
    await requireUpdated(this.client.executeUpdate(TOUCH_SQL, [
      mysqlDateTime(usedAt, "usedAt"),
      owner?.executionId ?? null,
      owner?.workerId ?? null,
      owner?.workerId ?? null,
      ...keyParameters(normalized)
    ]), normalized, "touch");
  }

  async incrementQuestionCount(
    key: EntryMonitorConversationKey,
    ownership: EntryMonitorConversationOwnership,
    usedAt: Date
  ): Promise<void> {
    const normalized = normalizeKey(key);
    const owner = normalizeOwnership(ownership);
    await requireUpdated(this.client.executeUpdate(INCREMENT_QUESTION_COUNT_SQL, [
      owner.executionId,
      owner.executionId,
      owner.workerId,
      mysqlDateTime(usedAt, "usedAt"),
      owner.workerId,
      ...keyParameters(normalized)
    ]), normalized, "incrementQuestionCount");
  }

  async markUnavailable(key: EntryMonitorConversationKey, reason: string): Promise<void> {
    const normalized = normalizeKey(key);
    await requireUpdated(this.client.executeUpdate(MARK_UNAVAILABLE_SQL, [
      nonEmpty(reason, "reason").slice(0, 1_000),
      ...keyParameters(normalized)
    ]), normalized, "markUnavailable");
  }

  closeExpired(beforeDate: string): Promise<number> {
    return this.client.executeUpdate(CLOSE_EXPIRED_SQL, [monitorDate(beforeDate)]);
  }
}

function keyParameters(key: EntryMonitorConversationKey): string[] {
  return [key.tenantId, key.projectId, key.aiModelId, key.monitorDate];
}

function mapRow(
  row: EntryMonitorConversationRow,
  platformId: EntryMonitorConversationKey["platformId"]
): EntryMonitorConversation {
  const key = normalizeKey({
    tenantId: databaseId(row.tenantId, "tenantId"),
    projectId: databaseId(row.projectId, "projectId"),
    aiModelId: databaseId(row.aiModelId, "aiModelId"),
    platformId,
    monitorDate: databaseDateOnly(row.conversationDate, "conversationDate")
  });
  const status = row.status;
  if (status !== "ACTIVE" && status !== "UNAVAILABLE" && status !== "CLOSED") {
    throw new Error(`Invalid ENTRY_MONITOR conversation status: ${String(status)}`);
  }
  const conversationUrl = typeof row.conversationUrl === "string" && row.conversationUrl.trim()
    ? safeHttpUrl(row.conversationUrl)
    : "";
  return {
    ...key,
    conversationKey: serializeEntryMonitorConversationKey(key),
    conversationUrl,
    status,
    questionCount: nonNegativeInteger(row.questionCount, "questionCount"),
    ...(row.lastExecutionId === null || row.lastExecutionId === undefined
      ? {}
      : { lastExecutionId: databaseId(row.lastExecutionId, "lastExecutionId") }),
    ...(typeof row.ownerWorkerId === "string" && row.ownerWorkerId.trim()
      ? { ownerWorkerId: row.ownerWorkerId.trim() }
      : {}),
    createdAt: databaseDateTime(row.createdAt, "createdAt"),
    lastUsedAt: row.lastUsedAt === null || row.lastUsedAt === undefined
      ? databaseDateTime(row.createdAt, "createdAt")
      : databaseDateTime(row.lastUsedAt, "lastUsedAt"),
    ...(typeof row.failureReason === "string" && row.failureReason.trim()
      ? { unavailableReason: row.failureReason.trim() }
      : {})
  };
}

function normalizeRecord(record: EntryMonitorConversation): EntryMonitorConversation {
  const key = normalizeKey(record);
  const normalized: EntryMonitorConversation = {
    ...key,
    conversationKey: serializeEntryMonitorConversationKey(key),
    conversationUrl: safeHttpUrl(record.conversationUrl),
    status: "ACTIVE",
    questionCount: nonNegativeInteger(record.questionCount, "questionCount"),
    createdAt: validDate(new Date(record.createdAt), "createdAt").toISOString(),
    lastUsedAt: validDate(new Date(record.lastUsedAt), "lastUsedAt").toISOString()
  };
  if (record.conversationKey !== normalized.conversationKey) {
    throw new Error("ENTRY_MONITOR conversationKey does not match its ownership fields");
  }
  if (record.lastExecutionId !== undefined) {
    normalized.lastExecutionId = databaseId(record.lastExecutionId, "lastExecutionId");
  }
  if (record.ownerWorkerId !== undefined) {
    normalized.ownerWorkerId = nonEmpty(record.ownerWorkerId, "ownerWorkerId").slice(0, 128);
  }
  return normalized;
}

function normalizeKey(key: EntryMonitorConversationKey): EntryMonitorConversationKey {
  return {
    tenantId: databaseId(key.tenantId, "tenantId"),
    projectId: databaseId(key.projectId, "projectId"),
    aiModelId: databaseId(key.aiModelId, "aiModelId"),
    platformId: key.platformId,
    monitorDate: monitorDate(key.monitorDate)
  };
}

function normalizeOwnership(
  ownership: EntryMonitorConversationOwnership
): EntryMonitorConversationOwnership {
  return {
    executionId: databaseId(ownership.executionId, "executionId"),
    workerId: nonEmpty(ownership.workerId, "workerId").slice(0, 128)
  };
}

async function requireUpdated(
  result: Promise<number>,
  key: EntryMonitorConversationKey,
  operation: string
): Promise<void> {
  if (await result !== 1) {
    throw new Error(
      `ENTRY_MONITOR conversation ${operation} did not update one row: ` +
      serializeEntryMonitorConversationKey(key)
    );
  }
}

function safeHttpUrl(value: string): string {
  const parsed = new URL(nonEmpty(value, "conversationUrl"));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("conversationUrl must use http or https");
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function databaseId(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  throw new Error(`${field} is not a valid database ID`);
}

function databaseDateOnly(value: unknown, field: string): string {
  if (typeof value === "string") return monitorDate(value.slice(0, 10));
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return monitorDate(`${year}-${month}-${day}`);
  }
  throw new Error(`${field} is not a valid date`);
}

function databaseDateTime(value: unknown, field: string): string {
  if (value instanceof Date) return validDate(value, field).toISOString();
  if (typeof value === "string") {
    const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
    return validDate(new Date(normalized), field).toISOString();
  }
  throw new Error(`${field} is not a valid datetime`);
}

function mysqlDateTime(value: Date, field: string): Date {
  return validDate(value, field);
}

function monitorDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("monitorDate must use YYYY-MM-DD");
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${field} is not a valid date`);
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} cannot be empty`);
  return value.trim();
}
