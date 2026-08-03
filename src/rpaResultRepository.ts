/**
 * geno-digital-api RPA 结果仓储。
 *
 * 成功结果使用一条数据库事务写入回答、引用并完成 execution；最终技术失败只通过
 * 条件 UPDATE 结束 execution。这里绝不修改 brand_rpa_dispatch_task。
 */
import {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";
import { getRpaDatabasePool } from "./rpaDatabase.js";
import type { RpaTask } from "./rpaTask.js";
import type { RpaSqlParameter } from "./rpaTaskRepository.js";
import type { CollectionResult } from "./mockRpaWorker.js";
import type { ReferenceRecord } from "./types.js";
import type { WorkerErrorCode } from "./browserDiagnostics.js";

export interface RpaCollectionResult {
  executionId: string;
  dispatchTaskId: string;
  keyword: string;
  answerContent: string;
  responseDurationSeconds: number;
  collectedAt: string | Date;
  references: readonly ReferenceRecord[];
  answerShareUrl?: string | null;
  /** 只用于本地 Outbox/审计，RPA 结果表当前没有对应列。 */
  webSearchRequested?: boolean;
  webSearchEnabled?: boolean;
  webSearchVerified?: boolean;
}

export interface FinalTechnicalFailure {
  executionId: string;
  final: true;
  errorCode: WorkerErrorCode;
}

export interface RetryExecutionInput {
  executionId: string;
  /** 领取任务时从 rpa_task_execution.fail_num 读取的值。 */
  failCount: number;
  maxAttempts: number;
  errorCode: WorkerErrorCode;
  /** 配套 migration 开启时使用；未提供则保持旧 SQL 兼容。 */
  nextRetryAt?: Date;
}

export type RetryExecutionOutcome =
  | { status: "released_for_retry"; failCount: number }
  | { status: "final_failed"; failCount: number }
  | { status: "not_updated"; failCount: number };

export type RpaResultSaveOutcome =
  | { status: "saved"; answerId: string; referenceCount: number }
  | { status: "already_completed"; answerId: string; referenceCount: 0 };

export interface RpaResultTransaction {
  queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]>;
  insertAndGetId(sql: string, parameters: readonly RpaSqlParameter[]): Promise<string>;
  executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface RpaResultDatabase {
  beginTransaction(): Promise<RpaResultTransaction>;
  executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number>;
}

export class MysqlRpaResultDatabase implements RpaResultDatabase {
  constructor(private readonly pool: Pool = getRpaDatabasePool()) {}

  async beginTransaction(): Promise<RpaResultTransaction> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      return new MysqlRpaResultTransaction(connection);
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  async executeUpdate(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, [...parameters]);
    return result.affectedRows;
  }
}

class MysqlRpaResultTransaction implements RpaResultTransaction {
  constructor(private readonly connection: PoolConnection) {}

  async queryRows<T>(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<T[]> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(sql, [...parameters]);
    return rows as unknown as T[];
  }

  async insertAndGetId(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<string> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, [...parameters]);
    if (result.affectedRows !== 1) {
      throw new Error(`RPA 回答插入行数异常：${result.affectedRows}`);
    }
    // ResultSetHeader.insertId 是 number；从连接读取字符串，避免 bigint 精度损失。
    const [rows] = await this.connection.query<RowDataPacket[]>(
      "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId"
    );
    return databaseId(rows[0]?.insertedId, "answerId");
  }

  async executeUpdate(
    sql: string,
    parameters: readonly RpaSqlParameter[]
  ): Promise<number> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, [...parameters]);
    return result.affectedRows;
  }

  commit(): Promise<void> {
    return this.connection.commit();
  }

  rollback(): Promise<void> {
    return this.connection.rollback();
  }

  release(): void {
    this.connection.release();
  }
}

interface ExecutionWriteRow {
  executionId: unknown;
  dispatchTaskId: unknown;
  keyword: unknown;
  status: unknown;
  taskStatus: unknown;
  answerId: unknown;
}

interface ExistingAnswerRow {
  answerId: unknown;
}

export class RpaResultRepository {
  constructor(
    private readonly database: RpaResultDatabase = new MysqlRpaResultDatabase()
  ) {}

  /**
   * 事务顺序：锁定并校验 execution → 插入回答 → 插入引用 → 回填 answer_id →
   * 将双状态置 2 → COMMIT。任一步失败都会 ROLLBACK。
   */
  async saveSuccess(input: RpaCollectionResult): Promise<RpaResultSaveOutcome> {
    const result = normalizeRpaCollectionResult(input);
    const transaction = await this.database.beginTransaction();
    let committed = false;
    try {
      const execution = await this.lockExecution(transaction, result.executionId);
      const existingAnswerId = await this.findExistingAnswerId(
        transaction,
        result.executionId
      );
      const idempotent = idempotentOutcome(execution, existingAnswerId);
      if (idempotent) {
        await transaction.commit();
        committed = true;
        return idempotent;
      }
      assertExecutionCanComplete(execution, result, existingAnswerId);

      const answerId = await transaction.insertAndGetId(INSERT_ANSWER_SQL, [
        result.executionId,
        result.dispatchTaskId,
        result.keyword,
        result.collectedAt,
        result.responseDurationSeconds,
        1,
        null,
        result.answerContent,
        result.answerShareUrl,
        "",
        "[]"
      ]);

      if (result.references.length > 0) {
        const referenceInsert = buildReferenceInsert(
          result.executionId,
          answerId,
          result.references
        );
        const insertedReferences = await transaction.executeUpdate(
          referenceInsert.sql,
          referenceInsert.parameters
        );
        if (insertedReferences !== result.references.length) {
          throw new Error(
            `RPA 引用插入行数异常：期望 ${result.references.length}，实际 ${insertedReferences}`
          );
        }
      }

      const linked = await transaction.executeUpdate(LINK_ANSWER_SQL, [
        answerId,
        result.executionId
      ]);
      if (linked !== 1) {
        throw new Error("RPA execution 回填 answer_id 失败，任务状态可能已变化。");
      }

      const completed = await transaction.executeUpdate(COMPLETE_EXECUTION_SQL, [
        result.collectedAt,
        result.collectedAt,
        result.executionId,
        answerId
      ]);
      if (completed !== 1) {
        throw new Error("RPA execution 完成状态更新失败，事务已取消。");
      }

      await transaction.commit();
      committed = true;
      return {
        status: "saved",
        answerId,
        referenceCount: result.references.length
      };
    } catch (error) {
      if (!committed) await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      transaction.release();
    }
  }

  /**
   * 仅供所有技术重试耗尽后调用。错误正文继续保存在结构化日志，不写入结果表。
   * 条件更新确保已完成、已失败或已写回答的 execution 不会被覆盖。
   */
  async markFinalTechnicalFailure(failure: FinalTechnicalFailure): Promise<boolean> {
    const executionId = requireId(failure.executionId, "executionId");
    if (failure.final !== true || !failure.errorCode) {
      throw new Error("只有带错误码的最终技术失败才允许更新 RPA execution。");
    }
    const affectedRows = await this.database.executeUpdate(FAIL_EXECUTION_SQL, [executionId]);
    return affectedRows === 1;
  }

  /**
   * 使用领取时的 failCount 做乐观条件更新。首个 Worker 更新双状态后，其他并发
   * Worker 会得到 affectedRows=0；已有 answer_id 的 execution 永远不会被释放。
   */
  async retryExecution(input: RetryExecutionInput): Promise<RetryExecutionOutcome> {
    const executionId = requireId(input.executionId, "executionId");
    const failCount = nonNegativeAttempt(input.failCount, "failCount");
    const maxAttempts = positiveAttempt(input.maxAttempts, "maxAttempts");
    if (!input.errorCode) throw new Error("retryExecution 必须提供技术错误码。");
    const nextFailCount = failCount + 1;
    const final = nextFailCount >= maxAttempts;
    const scheduled = input.nextRetryAt !== undefined;
    const sql = final
      ? scheduled ? FAIL_EXECUTION_AFTER_ATTEMPT_SCHEDULED_SQL : FAIL_EXECUTION_AFTER_ATTEMPT_SQL
      : scheduled ? RETRY_EXECUTION_SCHEDULED_SQL : RETRY_EXECUTION_SQL;
    const parameters: RpaSqlParameter[] = scheduled
      ? [
        final ? null : input.nextRetryAt!,
        input.errorCode,
        executionId,
        failCount,
        maxAttempts
      ]
      : [executionId, failCount, maxAttempts];
    const affectedRows = await this.database.executeUpdate(sql, parameters);
    if (affectedRows !== 1) {
      return { status: "not_updated", failCount };
    }
    return final
      ? { status: "final_failed", failCount: nextFailCount }
      : { status: "released_for_retry", failCount: nextFailCount };
  }

  private async lockExecution(
    transaction: RpaResultTransaction,
    executionId: string
  ): Promise<NormalizedExecutionWriteRow> {
    const rows = await transaction.queryRows<ExecutionWriteRow>(LOCK_EXECUTION_SQL, [
      executionId
    ]);
    if (rows.length !== 1) throw new Error(`RPA execution 不存在：${executionId}`);
    return normalizeExecutionRow(rows[0]!);
  }

  private async findExistingAnswerId(
    transaction: RpaResultTransaction,
    executionId: string
  ): Promise<string | undefined> {
    const rows = await transaction.queryRows<ExistingAnswerRow>(FIND_ANSWER_SQL, [
      executionId
    ]);
    return rows[0] ? databaseId(rows[0].answerId, "existingAnswerId") : undefined;
  }
}

/** 将当前统一 CollectionResult 与领取到的 RpaTask 转成数据库写入模型。 */
export function toRpaCollectionResult(
  task: Pick<RpaTask, "executionId" | "dispatchTaskId" | "keyword">,
  result: Pick<
    CollectionResult,
    "executionId" | "status" | "answer" | "durationMs" | "completedAt" | "references" |
    "webSearchRequested" | "webSearchEnabled" | "webSearchVerified"
  >
): RpaCollectionResult {
  if (task.executionId !== result.executionId) {
    throw new Error("CollectionResult 与 RpaTask 的 executionId 不一致。");
  }
  if (result.status !== "SUCCESS") {
    throw new Error("只有成功的 CollectionResult 可以转换为 RPA 回答。");
  }
  return normalizeRpaCollectionResult({
    executionId: task.executionId,
    dispatchTaskId: task.dispatchTaskId,
    keyword: task.keyword,
    answerContent: result.answer,
    responseDurationSeconds: Math.ceil(result.durationMs / 1_000),
    collectedAt: result.completedAt,
    references: result.references,
    answerShareUrl: null,
    webSearchRequested: result.webSearchRequested,
    webSearchEnabled: result.webSearchEnabled,
    webSearchVerified: result.webSearchVerified
  });
}

export const LOCK_EXECUTION_SQL = `
SELECT
  id AS executionId,
  task_id AS dispatchTaskId,
  keyword,
  status,
  task_status AS taskStatus,
  answer_id AS answerId
FROM rpa_task_execution
WHERE id = ?
  AND deleted = 0
FOR UPDATE`;

export const FIND_ANSWER_SQL = `
SELECT id AS answerId
FROM rpa_answer
WHERE execution_id = ?
  AND deleted = 0
ORDER BY id ASC
LIMIT 1`;

export const INSERT_ANSWER_SQL = `
INSERT INTO rpa_answer (
  execution_id,
  task_id,
  keyword,
  collection_time,
  response_duration,
  execution_status,
  fail_detail,
  answer_content,
  answer_share_url,
  thinking_process,
  recommend_questions
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const LINK_ANSWER_SQL = `
UPDATE rpa_task_execution
SET
  answer_id = ?,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND answer_id IS NULL
  AND status = 1
  AND task_status = 1
  AND deleted = 0`;

export const COMPLETE_EXECUTION_SQL = `
UPDATE rpa_task_execution
SET
  status = 2,
  task_status = 2,
  task_end_time = ?,
  end_time = ?,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND answer_id = ?
  AND status = 1
  AND task_status = 1
  AND deleted = 0`;

export const FAIL_EXECUTION_SQL = `
UPDATE rpa_task_execution
SET
  status = 3,
  task_status = 3,
  task_end_time = CURRENT_TIMESTAMP,
  end_time = CURRENT_TIMESTAMP,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND deleted = 0`;

/** 未到上限：递增 fail_num，并恢复为可领取；只修改 execution 表。 */
export const RETRY_EXECUTION_SQL = `
UPDATE rpa_task_execution
SET
  fail_num = fail_num + 1,
  status = 0,
  task_status = 0,
  start_time = NULL,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND fail_num = ?
  AND fail_num + 1 < ?
  AND deleted = 0`;

/** 到达上限：同一条条件 UPDATE 递增 fail_num 并写最终失败双状态。 */
export const FAIL_EXECUTION_AFTER_ATTEMPT_SQL = `
UPDATE rpa_task_execution
SET
  fail_num = fail_num + 1,
  status = 3,
  task_status = 3,
  task_end_time = CURRENT_TIMESTAMP,
  end_time = CURRENT_TIMESTAMP,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND fail_num = ?
  AND fail_num + 1 >= ?
  AND deleted = 0`;

/** migration 开启后：释放任务时写入数据库可见的下一次调度时间与错误元数据。 */
export const RETRY_EXECUTION_SCHEDULED_SQL = `
UPDATE rpa_task_execution
SET
  fail_num = fail_num + 1,
  status = 0,
  task_status = 0,
  start_time = NULL,
  next_retry_at = ?,
  last_error_code = ?,
  last_error_at = CURRENT_TIMESTAMP,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND fail_num = ?
  AND fail_num + 1 < ?
  AND deleted = 0`;

export const FAIL_EXECUTION_AFTER_ATTEMPT_SCHEDULED_SQL = `
UPDATE rpa_task_execution
SET
  fail_num = fail_num + 1,
  status = 3,
  task_status = 3,
  task_end_time = CURRENT_TIMESTAMP,
  end_time = CURRENT_TIMESTAMP,
  next_retry_at = ?,
  last_error_code = ?,
  last_error_at = CURRENT_TIMESTAMP,
  modify_time = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND fail_num = ?
  AND fail_num + 1 >= ?
  AND deleted = 0`;

interface NormalizedRpaCollectionResult extends Omit<RpaCollectionResult, "collectedAt"> {
  collectedAt: Date;
  answerShareUrl: string | null;
}

interface NormalizedExecutionWriteRow {
  executionId: string;
  dispatchTaskId: string;
  keyword: string;
  status: number;
  taskStatus: number;
  answerId?: string;
}

function normalizeRpaCollectionResult(
  input: RpaCollectionResult
): NormalizedRpaCollectionResult {
  const executionId = requireId(input.executionId, "executionId");
  const dispatchTaskId = requireId(input.dispatchTaskId, "dispatchTaskId");
  const keyword = requireBoundedText(input.keyword, "keyword", 1_000, true);
  const answerContent = requireBoundedText(
    input.answerContent,
    "answerContent",
    Number.MAX_SAFE_INTEGER,
    true
  );
  if (
    !Number.isSafeInteger(input.responseDurationSeconds) ||
    input.responseDurationSeconds < 0 ||
    input.responseDurationSeconds > 2_147_483_647
  ) {
    throw new Error("responseDurationSeconds 必须是非负 int 整数。");
  }
  const collectedAt = input.collectedAt instanceof Date
    ? new Date(input.collectedAt.getTime())
    : new Date(input.collectedAt);
  if (!Number.isFinite(collectedAt.getTime())) throw new Error("collectedAt 不是有效时间。");
  const answerShareUrl = input.answerShareUrl == null
    ? null
    : requireBoundedText(input.answerShareUrl, "answerShareUrl", 2_000, false);
  return {
    executionId,
    dispatchTaskId,
    keyword,
    answerContent,
    responseDurationSeconds: input.responseDurationSeconds,
    collectedAt,
    references: [...input.references],
    answerShareUrl,
    ...(typeof input.webSearchRequested === "boolean"
      ? { webSearchRequested: input.webSearchRequested }
      : {}),
    ...(typeof input.webSearchEnabled === "boolean"
      ? { webSearchEnabled: input.webSearchEnabled }
      : {}),
    ...(typeof input.webSearchVerified === "boolean"
      ? { webSearchVerified: input.webSearchVerified }
      : {})
  };
}

function normalizeExecutionRow(row: ExecutionWriteRow): NormalizedExecutionWriteRow {
  return {
    executionId: databaseId(row.executionId, "executionId"),
    dispatchTaskId: databaseId(row.dispatchTaskId, "dispatchTaskId"),
    keyword: requireBoundedText(row.keyword, "execution.keyword", 1_000, true),
    status: databaseState(row.status, "status"),
    taskStatus: databaseState(row.taskStatus, "taskStatus"),
    ...(row.answerId == null
      ? {}
      : { answerId: databaseId(row.answerId, "execution.answerId") })
  };
}

function idempotentOutcome(
  execution: NormalizedExecutionWriteRow,
  existingAnswerId: string | undefined
): RpaResultSaveOutcome | undefined {
  if (
    execution.status === 2 &&
    execution.taskStatus === 2 &&
    execution.answerId &&
    existingAnswerId === execution.answerId
  ) {
    return {
      status: "already_completed",
      answerId: execution.answerId,
      referenceCount: 0
    };
  }
  return undefined;
}

function assertExecutionCanComplete(
  execution: NormalizedExecutionWriteRow,
  result: NormalizedRpaCollectionResult,
  existingAnswerId: string | undefined
): void {
  if (execution.executionId !== result.executionId) {
    throw new Error("锁定的 execution 与 CollectionResult 不一致。");
  }
  if (execution.dispatchTaskId !== result.dispatchTaskId) {
    throw new Error("CollectionResult 的 dispatchTaskId 与 execution.task_id 不一致。");
  }
  if (execution.keyword !== result.keyword) {
    throw new Error("CollectionResult 的 keyword 与 execution 原问题不一致。");
  }
  if (existingAnswerId || execution.answerId) {
    throw new Error("executionId 已存在回答或 answer_id，拒绝重复插入。");
  }
  if (execution.status !== 1 || execution.taskStatus !== 1) {
    throw new Error(
      `execution 不是已领取状态：status=${execution.status}, taskStatus=${execution.taskStatus}`
    );
  }
}

function buildReferenceInsert(
  executionId: string,
  answerId: string,
  references: readonly ReferenceRecord[]
): { sql: string; parameters: RpaSqlParameter[] } {
  const parameters: RpaSqlParameter[] = [];
  const placeholders = references.map((reference, index) => {
    const platform = optionalBoundedText(
      reference.articlePlatform,
      `references[${index}].articlePlatform`,
      300
    );
    const content = String(reference.title || reference.summary || "");
    const url = optionalBoundedText(reference.url, `references[${index}].url`, 1_000);
    parameters.push(executionId, answerId, platform, index + 1, content, url);
    return "(?, ?, ?, ?, ?, ?)";
  });
  return {
    sql: `INSERT INTO rpa_answer_reference (\n` +
      `  execution_id, answer_id, reference_platform, reference_sort, ` +
      `reference_content, reference_url\n) VALUES ${placeholders.join(", ")}`,
    parameters
  };
}

function databaseId(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  throw new Error(`${field} 不是有效数据库 ID。`);
}

function requireId(value: string, field: string): string {
  return databaseId(value, field);
}

function nonNegativeAttempt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负整数。`);
  }
  return value;
}

function positiveAttempt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`${field} 必须是 1 到 100 的整数。`);
  }
  return value;
}

function databaseState(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    throw new Error(`${field} 不是有效 RPA 状态。`);
  }
  return parsed;
}

function requireBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  requireNonBlank: boolean
): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
  if (requireNonBlank && !value.trim()) throw new Error(`${field} 不能为空。`);
  if (value.length > maxLength) throw new Error(`${field} 超过数据库字段长度 ${maxLength}。`);
  return value;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  maxLength: number
): string | null {
  if (value == null || value === "") return null;
  return requireBoundedText(value, field, maxLength, false);
}
