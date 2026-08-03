/**
 * geno-digital-api RPA 任务仓储。
 *
 * 当前阶段只查询待处理 execution 并通过条件 UPDATE 原子领取；不写回答、引用，
 * 也不修改 brand_rpa_dispatch_task 的状态。
 */
import {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";
import { getRpaDatabasePool } from "./rpaDatabase.js";
import type { RpaTaskAuditSink } from "./rpaTaskAudit.js";
import {
  businessTypeForWorker,
  resolveRpaPlatform,
  toCollectionTask,
  type CollectionTask,
  type RpaBusinessType,
  type RpaTask,
  type RpaWorkerType
} from "./rpaTask.js";
import type { PlatformId } from "./types.js";

export interface RpaTaskQueryOptions {
  limit?: number;
}

export interface RpaTaskRepositoryOptions {
  retryScheduleEnabled?: boolean;
  workerProvider?: string;
}

export type RpaSqlParameter = string | number | boolean | null | Date | Buffer;

export interface RpaSqlClient {
  queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]>;
  executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number>;
}

export interface RpaTaskRow {
  executionId: unknown;
  dispatchTaskId: unknown;
  businessType: unknown;
  businessTaskId: unknown;
  tenantKey: unknown;
  brandId: unknown;
  keyword: unknown;
  aiModelId: unknown;
  aiModelName: unknown;
  deepThinking: unknown;
  failCount: unknown;
  priority: unknown;
  createdAt: unknown;
}

export interface RpaTaskStateCount {
  platformId: PlatformId;
  pending: number;
  processing: number;
  succeeded: number;
  finalFailed: number;
}

interface RpaTaskStateCountRow {
  aiModelId: unknown;
  aiModelName: unknown;
  pending: unknown;
  processing: unknown;
  succeeded: unknown;
  finalFailed: unknown;
}

export class MysqlRpaSqlClient implements RpaSqlClient {
  constructor(private readonly pool: Pool = getRpaDatabasePool()) {}

  async queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]> {
    // 部分生产 MySQL/代理不支持 LIMIT ? 的 prepared statement，会返回
    // ER_WRONG_ARGUMENTS。query 仍由 mysql2 对参数进行转义，但不走服务端预编译；
    // 写入和原子领取继续使用 execute。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [...parameters]);
    return rows as unknown as T[];
  }

  async executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, [...parameters]);
    return result.affectedRows;
  }
}

export class RpaTaskRepository {
  constructor(
    private readonly client: RpaSqlClient = new MysqlRpaSqlClient(),
    private readonly audit?: RpaTaskAuditSink,
    private readonly options: RpaTaskRepositoryOptions = {}
  ) {}

  /** diagnosis 只查 DIAGNOSIS；monitor 只查 ARTICLE_PROBE。 */
  async findPendingTasks(
    workerType: RpaWorkerType,
    options: RpaTaskQueryOptions = {}
  ): Promise<RpaTask[]> {
    const limit = normalizeLimit(options.limit);
    const businessType = businessTypeForWorker(workerType);
    const rows = await this.client.queryRows<RpaTaskRow>(
      pendingQueryFor(
        workerType,
        this.options.retryScheduleEnabled === true,
        this.options.workerProvider !== undefined
      ),
      [businessType, ...(this.options.workerProvider ? [this.options.workerProvider] : []), limit]
    );
    const tasks = rows.map((row) => mapRpaTaskRow(row, businessType));
    await this.safeAudit({
      timestamp: new Date().toISOString(),
      event: "PENDING_QUERY",
      workerType,
      businessType,
      candidateCount: tasks.length
    });
    return tasks;
  }

  async findPendingCollectionTasks(
    workerType: RpaWorkerType,
    options: RpaTaskQueryOptions = {}
  ): Promise<CollectionTask[]> {
    return (await this.findPendingTasks(workerType, options)).map(toCollectionTask);
  }

  /**
   * 读取种子任务所属的完整品牌/业务/平台批次，避免灰度数量上限把批次从中间截断。
   */
  async findPendingBatchTasks(
    workerType: RpaWorkerType,
    seed: Pick<RpaTask, "businessTaskId" | "tenantKey" | "aiModelId">,
    options: RpaTaskQueryOptions = { limit: 1_000 }
  ): Promise<CollectionTask[]> {
    const businessType = businessTypeForWorker(workerType);
    const rows = await this.client.queryRows<RpaTaskRow>(
      pendingBatchQueryFor(
        workerType,
        this.options.retryScheduleEnabled === true,
        this.options.workerProvider !== undefined
      ),
      [
        businessType,
        requireId(seed.businessTaskId, "businessTaskId"),
        nonEmptyString(seed.tenantKey, "tenantKey"),
        requireId(seed.aiModelId, "aiModelId"),
        ...(this.options.workerProvider ? [this.options.workerProvider] : []),
        normalizeLimit(options.limit)
      ]
    );
    return rows.map((row) => toCollectionTask(mapRpaTaskRow(row, businessType)));
  }

  /**
   * 条件更新同时要求 status=0、task_status=0 且业务类型属于当前 Worker。只有
   * affectedRows=1 才表示本 Worker 成功领取；并发竞争失败返回 false。
   */
  async claimTask(workerType: RpaWorkerType, executionId: string): Promise<boolean> {
    const normalizedExecutionId = requireId(executionId, "executionId");
    const affectedRows = await this.client.executeUpdate(
      claimQueryFor(
        this.options.retryScheduleEnabled === true,
        this.options.workerProvider !== undefined
      ),
      [
      normalizedExecutionId,
      businessTypeForWorker(workerType),
      ...(this.options.workerProvider ? [this.options.workerProvider] : [])
      ]
    );
    const claimed = affectedRows === 1;
    await this.safeAudit({
      timestamp: new Date().toISOString(),
      event: "CLAIM_ATTEMPT",
      workerType,
      businessType: businessTypeForWorker(workerType),
      executionId: normalizedExecutionId,
      claimed
    });
    return claimed;
  }

  /** 查询一小批候选并逐条条件领取，返回首个赢得竞争的 CollectionTask。 */
  async claimNextTask(
    workerType: RpaWorkerType,
    options: RpaTaskQueryOptions = {}
  ): Promise<CollectionTask | undefined> {
    const candidates = await this.findPendingTasks(workerType, options);
    for (const task of candidates) {
      if (await this.claimTask(workerType, task.executionId)) {
        return toCollectionTask(task);
      }
    }
    return undefined;
  }

  /**
   * 指标只读聚合。调用方必须把失败视为指标不可用，不能据此改变任务流程。
   * 仅统计 execution 自身的双状态，不修改 dispatch 状态。
   */
  async countTaskStates(workerType: RpaWorkerType): Promise<RpaTaskStateCount[]> {
    const rows = await this.client.queryRows<RpaTaskStateCountRow>(
      this.options.workerProvider
        ? TASK_STATE_COUNT_SQL.replace(
          "GROUP BY e.ai_model_id",
          "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\nGROUP BY e.ai_model_id"
        )
        : TASK_STATE_COUNT_SQL,
      [
        businessTypeForWorker(workerType),
        ...(this.options.workerProvider ? [this.options.workerProvider] : [])
      ]
    );
    const counts = new Map<PlatformId, RpaTaskStateCount>();
    for (const row of rows) {
      const platformId = resolveRpaPlatform(
        databaseId(row.aiModelId, "aiModelId"),
        nonEmptyString(row.aiModelName, "aiModelName")
      );
      const current = counts.get(platformId) ?? {
        platformId,
        pending: 0,
        processing: 0,
        succeeded: 0,
        finalFailed: 0
      };
      current.pending += nonNegativeInteger(row.pending, "pending");
      current.processing += nonNegativeInteger(row.processing, "processing");
      current.succeeded += nonNegativeInteger(row.succeeded, "succeeded");
      current.finalFailed += nonNegativeInteger(row.finalFailed, "finalFailed");
      counts.set(platformId, current);
    }
    return [...counts.values()];
  }

  private async safeAudit(event: Parameters<RpaTaskAuditSink["write"]>[0]): Promise<void> {
    // 审计磁盘故障不能改变数据库领取结果，也不能诱发同一任务再次领取。
    await this.audit?.write(event).catch(() => undefined);
  }
}

const COMMON_SELECT = `
SELECT
  e.id AS executionId,
  e.task_id AS dispatchTaskId,
  d.business_type AS businessType,
  d.business_task_id AS businessTaskId,
  d.tenant_key AS tenantKey,
  %BRAND_COLUMN% AS brandId,
  e.keyword AS keyword,
  e.ai_model_id AS aiModelId,
  e.ai_model_name AS aiModelName,
  e.deep_thinking AS deepThinking,
  e.fail_num AS failCount,
  e.priority AS priority,
  e.create_time AS createdAt
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
  AND d.status = 'DISPATCHED'
%BUSINESS_JOIN%
WHERE e.status = 0
  AND e.task_status = 0
  AND e.deleted = 0
  AND d.business_type = ?
ORDER BY e.priority ASC, e.create_time ASC, e.id ASC
LIMIT ?`;

const DIAGNOSIS_PENDING_SQL = COMMON_SELECT
  .replace("%BRAND_COLUMN%", "business_task.profile_id")
  .replace(
    "%BUSINESS_JOIN%",
    `INNER JOIN diagnosis_task AS business_task
  ON business_task.id = d.business_task_id
  AND business_task.deleted = 0`
  );

const MONITOR_PENDING_SQL = COMMON_SELECT
  .replace("%BRAND_COLUMN%", "business_task.brand_id")
  .replace(
    "%BUSINESS_JOIN%",
    `INNER JOIN probe_article_task AS business_task
  ON business_task.id = d.business_task_id
  AND business_task.deleted = 0`
  );

function pendingBatchQueryFor(
  workerType: RpaWorkerType,
  retryScheduleEnabled = false,
  providerRoutingEnabled = false
): string {
  let sql = pendingQueryFor(workerType, false, false).replace(
    "ORDER BY e.priority ASC",
    `AND d.business_task_id = ?
  AND d.tenant_key = ?
  AND e.ai_model_id = ?
ORDER BY e.priority ASC`
  );
  if (providerRoutingEnabled) {
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\nORDER BY e.priority ASC"
    );
  }
  if (retryScheduleEnabled) {
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      "AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)\nORDER BY e.priority ASC"
    );
  }
  return sql;
}

/** 只更新 execution 表；dispatch 表出现在 JOIN 中仅用于身份和类型校验。 */
export const CLAIM_TASK_SQL = `
UPDATE rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
  AND d.status = 'DISPATCHED'
SET
  e.status = 1,
  e.task_status = 1,
  e.start_time = CURRENT_TIMESTAMP,
  e.modify_time = CURRENT_TIMESTAMP
WHERE e.id = ?
  AND e.status = 0
  AND e.task_status = 0
  AND e.deleted = 0
  AND d.business_type = ?`;

export const CLAIM_SCHEDULED_TASK_SQL = `${CLAIM_TASK_SQL}
  AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)`;

function claimQueryFor(retryScheduleEnabled: boolean, providerRoutingEnabled: boolean): string {
  let sql = CLAIM_TASK_SQL;
  if (retryScheduleEnabled) {
    sql += "\n  AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)";
  }
  if (providerRoutingEnabled) {
    sql += "\n  AND d.worker_provider = ? AND e.worker_provider = d.worker_provider";
  }
  return sql;
}

export const TASK_STATE_COUNT_SQL = `
SELECT
  e.ai_model_id AS aiModelId,
  e.ai_model_name AS aiModelName,
  SUM(CASE WHEN e.status = 0 AND e.task_status = 0 THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN e.status = 1 AND e.task_status = 1 THEN 1 ELSE 0 END) AS processing,
  SUM(CASE WHEN e.status = 2 AND e.task_status = 2 THEN 1 ELSE 0 END) AS succeeded,
  SUM(CASE WHEN e.status = 3 AND e.task_status = 3 THEN 1 ELSE 0 END) AS finalFailed
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
WHERE e.deleted = 0
  AND d.business_type = ?
GROUP BY e.ai_model_id, e.ai_model_name`;

export function mapRpaTaskRow(
  row: RpaTaskRow,
  expectedBusinessType?: RpaBusinessType
): RpaTask {
  const businessType = requireBusinessType(row.businessType);
  if (expectedBusinessType && businessType !== expectedBusinessType) {
    throw new Error(
      `RPA 查询返回了错误业务类型：期望 ${expectedBusinessType}，实际 ${businessType}`
    );
  }
  return {
    executionId: databaseId(row.executionId, "executionId"),
    dispatchTaskId: databaseId(row.dispatchTaskId, "dispatchTaskId"),
    businessType,
    businessTaskId: databaseId(row.businessTaskId, "businessTaskId"),
    tenantKey: nonEmptyString(row.tenantKey, "tenantKey"),
    brandId: databaseId(row.brandId, "brandId"),
    keyword: nonEmptyString(row.keyword, "keyword", false),
    aiModelId: databaseId(row.aiModelId, "aiModelId"),
    aiModelName: nonEmptyString(row.aiModelName, "aiModelName"),
    deepThinking: booleanFlag(row.deepThinking, "deepThinking"),
    failCount: nonNegativeInteger(row.failCount, "failCount"),
    priority: nonNegativeInteger(row.priority, "priority"),
    createdAt: databaseDate(row.createdAt, "createdAt")
  };
}

function pendingQueryFor(
  workerType: RpaWorkerType,
  retryScheduleEnabled = false,
  providerRoutingEnabled = false
): string {
  let sql = workerType === "diagnosis" ? DIAGNOSIS_PENDING_SQL : MONITOR_PENDING_SQL;
  if (providerRoutingEnabled) {
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\nORDER BY e.priority ASC"
    );
  }
  return retryScheduleEnabled
    ? sql.replace(
      "ORDER BY e.priority ASC",
      "AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)\nORDER BY e.priority ASC"
    )
    : sql;
}

function normalizeLimit(value = 100): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error("RPA 查询 limit 必须是 1 到 1000 的整数。");
  }
  return value;
}

function requireBusinessType(value: unknown): RpaBusinessType {
  if (value === "DIAGNOSIS" || value === "ARTICLE_PROBE") return value;
  throw new Error(`不支持的 RPA business_type：${String(value)}`);
}

function databaseId(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} 不是安全整数；MySQL bigint 必须配置为字符串返回。`);
    }
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  throw new Error(`${field} 不是有效数据库 ID。`);
}

function requireId(value: string, field: string): string {
  return databaseId(value, field);
}

function nonEmptyString(value: unknown, field: string, trim = true): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  return trim ? value.trim() : value;
}

function booleanFlag(value: unknown, field: string): boolean {
  if (value === 0 || value === "0" || value === false) return false;
  if (value === 1 || value === "1" || value === true) return true;
  throw new Error(`${field} 必须是 0 或 1。`);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} 必须是非负整数。`);
  }
  return parsed;
}

function databaseDate(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} 不是有效时间。`);
  return date.toISOString();
}
