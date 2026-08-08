/**
 * geno-digital-api RPA 任务仓储。
 *
 * 当前阶段只查询待处理 execution 并通过条件 UPDATE 原子领取；不写回答、引用，
 * 也不修改 brand_rpa_dispatch_task 的状态。
 */
import {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";
import {
  acquireRpaPoolConnection,
  getRpaDatabasePool,
  readRpaDatabaseTimeoutConfig
} from "./rpaDatabase.js";
import type { RpaTaskAuditSink } from "./rpaTaskAudit.js";
import { getShanghaiDate, isMonitorDate } from "./entryMonitor.js";
import {
  businessTypeForWorker,
  businessTypesForWorker,
  isBusinessTypeAllowedForWorker,
  resolveRpaPlatform,
  toCollectionTask,
  type CollectionTask,
  type RpaBusinessType,
  type RpaTask,
  type RpaWorkerRole,
  type RpaWorkerType
} from "./rpaTask.js";
import type { PlatformId } from "./types.js";
import { isBusinessTypePaused } from "./workerControl.js";

export interface RpaTaskQueryOptions {
  limit?: number;
  brandCohorts?: readonly RpaBrandCohort[];
}

export interface RpaBatchSeed {
  businessTaskId: string;
  tenantKey: string;
  aiModelId: string;
  businessType?: RpaBusinessType;
  tenantId?: string;
  projectId?: string;
  monitorDate?: string;
}

export interface RpaBrandCohort {
  tenantKey: string;
  businessTaskId: string;
  brandId: string;
}

export interface RpaBrandWindowEntry extends RpaBrandCohort {
  priority: number;
  createdAt: string;
  totalTasks: number;
  platformCount: number;
  pending: number;
  processing: number;
  succeeded: number;
  finalFailed: number;
}

export interface RpaBrandWindowOptions {
  size: number;
  expectedPlatforms: readonly PlatformId[];
}

export interface RpaTaskRepositoryOptions {
  retryScheduleEnabled?: boolean;
  workerProvider?: string;
  entryMonitorEnabled?: boolean;
  entryMonitorGrayProjectIds?: readonly string[];
  contentStyleMonitorEnabled?: boolean;
  contentStyleMonitorGrayProjectIds?: readonly string[];
  articleProbeLegacyEnabled?: boolean;
  now?: () => Date;
}

export interface RpaTaskRepositoryRuntimeConfig {
  workerRole: RpaWorkerRole;
  workerType: RpaWorkerType;
  databaseRetryScheduleEnabled: boolean;
  providerRoutingEnabled: boolean;
  workerProvider: string;
  entryMonitorEnabled: boolean;
  entryMonitorGrayProjectIds: readonly string[];
  contentStyleMonitorEnabled: boolean;
  contentStyleMonitorGrayProjectIds: readonly string[];
  articleProbeLegacyEnabled: boolean;
}

/** Formal workers and read-only tooling must construct the queue repository identically. */
export function createRpaTaskRepositoryOptions(
  config: RpaTaskRepositoryRuntimeConfig
): RpaTaskRepositoryOptions {
  const entryMonitorEnabled = config.workerRole === "monitor" && config.entryMonitorEnabled;
  return {
    retryScheduleEnabled: config.databaseRetryScheduleEnabled,
    ...(config.providerRoutingEnabled
      ? { workerProvider: config.workerProvider }
      : {}),
    entryMonitorEnabled,
    entryMonitorGrayProjectIds: entryMonitorEnabled
      ? [...config.entryMonitorGrayProjectIds]
      : [],
    contentStyleMonitorEnabled: config.workerRole === "style" &&
      config.contentStyleMonitorEnabled,
    contentStyleMonitorGrayProjectIds: config.workerRole === "style" &&
      config.contentStyleMonitorEnabled
      ? [...config.contentStyleMonitorGrayProjectIds]
      : [],
    articleProbeLegacyEnabled: config.workerRole === "monitor" &&
      config.articleProbeLegacyEnabled
  };
}

export type RpaSqlParameter = string | number | boolean | null | Date | Buffer;

export interface RpaSqlClient {
  queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]>;
  executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number>;
}

export interface RpaTaskRow {
  executionId: unknown;
  dispatchTaskId: unknown;
  executionBusinessType: unknown;
  dispatchBusinessType: unknown;
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
  projectId?: unknown;
  intentEntryId?: unknown;
  monitorDate?: unknown;
  repetitionNo?: unknown;
}

export interface RpaTaskStateCount {
  platformId: PlatformId;
  pending: number;
  processing: number;
  succeeded: number;
  finalFailed: number;
}

export interface RpaBusinessTaskStateCount extends RpaTaskStateCount {
  businessType: RpaBusinessType;
}

export interface RpaBusinessTypeProtocolCounts {
  nullExecutionType: number;
  mismatch: number;
  unknown: number;
  orphan: number;
  legacyFallback: number;
  invalidContext: number;
  articleProbeLegacy: number;
}

interface RpaTaskStateCountRow {
  businessType?: unknown;
  aiModelId: unknown;
  aiModelName: unknown;
  pending: unknown;
  processing: unknown;
  succeeded: unknown;
  finalFailed: unknown;
}

export class MysqlRpaSqlClient implements RpaSqlClient {
  constructor(
    private readonly pool: Pool = getRpaDatabasePool(),
    private readonly queryTimeoutMs = readRpaDatabaseTimeoutConfig().queryTimeoutMs,
    private readonly acquireTimeoutMs = readRpaDatabaseTimeoutConfig().acquireTimeoutMs
  ) {}

  async queryRows<T>(sql: string, parameters: readonly RpaSqlParameter[]): Promise<T[]> {
    // 部分生产 MySQL/代理不支持 LIMIT ? 的 prepared statement，会返回
    // ER_WRONG_ARGUMENTS。query 仍由 mysql2 对参数进行转义，但不走服务端预编译；
    // 写入和原子领取继续使用 execute。
    return this.withConnection(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>({
        sql,
        values: [...parameters],
        timeout: this.queryTimeoutMs
      });
      return rows as unknown as T[];
    });
  }

  async executeUpdate(sql: string, parameters: readonly RpaSqlParameter[]): Promise<number> {
    return this.withConnection(async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>({
        sql,
        values: [...parameters],
        timeout: this.queryTimeoutMs
      });
      return result.affectedRows;
    });
  }

  private async withConnection<T>(
    operation: (connection: PoolConnection) => Promise<T>
  ): Promise<T> {
    const connection = await acquireRpaPoolConnection(this.pool, this.acquireTimeoutMs);
    let healthy = true;
    try {
      return await operation(connection);
    } catch (error) {
      healthy = false;
      connection.destroy();
      throw error;
    } finally {
      if (healthy) connection.release();
    }
  }
}

interface RpaBrandWindowRow {
  tenantKey: unknown;
  businessTaskId: unknown;
  brandId: unknown;
  priority: unknown;
  createdAt: unknown;
  totalTasks: unknown;
  platformCount: unknown;
  pending: unknown;
  processing: unknown;
  succeeded: unknown;
  finalFailed: unknown;
}

export class RpaTaskRepository {
  constructor(
    private readonly client: RpaSqlClient = new MysqlRpaSqlClient(),
    private readonly audit?: RpaTaskAuditSink,
    private readonly options: RpaTaskRepositoryOptions = {}
  ) {}

  /** Each protocol type is queried independently; feature flags decide monitor eligibility. */
  async findPendingTasks(
    workerType: RpaWorkerRole,
    options: RpaTaskQueryOptions = {}
  ): Promise<RpaTask[]> {
    const limit = normalizeLimit(options.limit);
    const businessType = businessTypeForWorker(workerType);
    const brandCohorts = normalizeBrandCohorts(options.brandCohorts);
    if (options.brandCohorts && brandCohorts.length === 0) return [];
    const tasks: RpaTask[] = [];
    const queryLegacyProbe = workerType === "diagnosis" ||
      (workerType === "monitor" && this.options.articleProbeLegacyEnabled !== false);
    if (queryLegacyProbe) {
      const rows = await this.client.queryRows<RpaTaskRow>(
        pendingQueryFor(
          workerType,
          this.options.retryScheduleEnabled === true,
          this.options.workerProvider !== undefined,
          brandCohorts.length
        ),
        [
          businessType,
          ...(this.options.workerProvider ? [this.options.workerProvider] : []),
          ...brandCohorts.flatMap((cohort) => [cohort.businessTaskId, cohort.tenantKey]),
          limit
        ]
      );
      for (const row of rows) {
        const task = await this.mapCandidate(row, workerType, businessType);
        if (task) tasks.push(task);
      }
      await this.safeAudit({
        timestamp: new Date().toISOString(),
        event: "PENDING_QUERY",
        workerType,
        businessType,
        candidateCount: rows.length
      });
    }

    if (workerType !== "diagnosis") {
      const contextualTypes: Array<{
        businessType: "ENTRY_MONITOR" | "CONTENT_STYLE_MONITOR";
        enabled: boolean;
        projectIds: readonly string[] | undefined;
      }> = [
        {
          businessType: "ENTRY_MONITOR",
          enabled: workerType === "monitor" && this.options.entryMonitorEnabled === true,
          projectIds: this.options.entryMonitorGrayProjectIds
        },
        {
          businessType: "CONTENT_STYLE_MONITOR",
          enabled: workerType === "style" && this.options.contentStyleMonitorEnabled === true,
          projectIds: this.options.contentStyleMonitorGrayProjectIds
        }
      ];
      for (const contextual of contextualTypes) {
        if (!contextual.enabled) continue;
        const projectIds = normalizeProjectIds(contextual.projectIds);
        const rows = await this.client.queryRows<RpaTaskRow>(
          contextualMonitorPendingQueryFor(
            this.options.retryScheduleEnabled === true,
            this.options.workerProvider !== undefined,
            projectIds.length
          ),
          [
            contextual.businessType,
            ...(this.options.workerProvider ? [this.options.workerProvider] : []),
            getShanghaiDate((this.options.now ?? (() => new Date()))()),
            ...projectIds,
            limit
          ]
        );
        let candidateCount = 0;
        for (const row of rows) {
          const task = await this.mapCandidate(row, workerType, contextual.businessType);
          if (task) {
            tasks.push(task);
            candidateCount += 1;
          }
        }
        await this.safeAudit({
          timestamp: new Date().toISOString(),
          event: "PENDING_QUERY",
          workerType,
          businessType: contextual.businessType,
          candidateCount
        });
      }
    }
    return tasks.sort(compareTasks).slice(0, limit);
  }

  async findPendingCollectionTasks(
    workerType: RpaWorkerRole,
    options: RpaTaskQueryOptions = {}
  ): Promise<CollectionTask[]> {
    return (await this.findPendingTasks(workerType, options)).map(toCollectionTask);
  }

  /**
   * Returns the first N globally incomplete brand cohorts. Completion requires
   * every existing execution to be successful and all expected AI platforms
   * to be present, so a missing/final-failed platform keeps the barrier closed.
   */
  async findBrandWindow(
    workerType: RpaWorkerRole,
    options: RpaBrandWindowOptions
  ): Promise<RpaBrandWindowEntry[]> {
    const size = normalizeWindowSize(options.size);
    const expectedPlatforms = normalizeExpectedPlatforms(options.expectedPlatforms);
    if (size === 0) return [];
    const rows = await this.client.queryRows<RpaBrandWindowRow>(
      brandWindowQueryFor(
        workerType,
        this.options.workerProvider !== undefined,
        expectedPlatforms
      ),
      [
        businessTypeForWorker(workerType),
        ...(this.options.workerProvider ? [this.options.workerProvider] : []),
        expectedPlatforms.length,
        size
      ]
    );
    return rows.map((row) => ({
      tenantKey: nonEmptyString(row.tenantKey, "tenantKey"),
      businessTaskId: databaseId(row.businessTaskId, "businessTaskId"),
      brandId: databaseId(row.brandId, "brandId"),
      priority: nonNegativeInteger(row.priority, "priority"),
      createdAt: databaseDate(row.createdAt, "createdAt"),
      totalTasks: nonNegativeInteger(row.totalTasks, "totalTasks"),
      platformCount: nonNegativeInteger(row.platformCount, "platformCount"),
      pending: nonNegativeInteger(row.pending, "pending"),
      processing: nonNegativeInteger(row.processing, "processing"),
      succeeded: nonNegativeInteger(row.succeeded, "succeeded"),
      finalFailed: nonNegativeInteger(row.finalFailed, "finalFailed")
    }));
  }

  /**
   * 读取种子任务所属的完整品牌/业务/平台批次，避免灰度数量上限把批次从中间截断。
   */
  async findPendingBatchTasks(
    workerType: RpaWorkerRole,
    seed: RpaBatchSeed,
    options: RpaTaskQueryOptions = { limit: 1_000 }
  ): Promise<CollectionTask[]> {
    const businessType = seed.businessType ?? businessTypeForWorker(workerType);
    if (!isBusinessTypeAllowedForWorker(workerType, businessType)) {
      throw new Error("worker business type mismatch");
    }
    if (businessType === "ENTRY_MONITOR" || businessType === "CONTENT_STYLE_MONITOR") {
      const rows = await this.client.queryRows<RpaTaskRow>(
        contextualMonitorBatchQueryFor(
          this.options.retryScheduleEnabled === true,
          this.options.workerProvider !== undefined
        ),
        [
          businessType,
          requireId(nonEmptyString(seed.projectId, "projectId"), "projectId"),
          nonEmptyString(seed.tenantId, "tenantId"),
          requireId(seed.aiModelId, "aiModelId"),
          requireMonitorDate(seed.monitorDate),
          ...(this.options.workerProvider ? [this.options.workerProvider] : []),
          normalizeLimit(options.limit)
        ]
      );
      return rows.map((row) => toCollectionTask(mapRpaTaskRow(row, businessType)));
    }
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
  async claimTask(workerType: RpaWorkerRole, executionId: string): Promise<boolean>;
  async claimTask(
    workerType: RpaWorkerRole,
    businessType: RpaBusinessType,
    executionId: string
  ): Promise<boolean>;
  async claimTask(
    workerType: RpaWorkerRole,
    businessTypeOrExecutionId: RpaBusinessType | string,
    maybeExecutionId?: string
  ): Promise<boolean> {
    const businessType = maybeExecutionId === undefined
      ? businessTypeForWorker(workerType)
      : requireBusinessType(businessTypeOrExecutionId);
    if (!isBusinessTypeAllowedForWorker(workerType, businessType)) {
      throw new Error("worker business type mismatch");
    }
    const executionId = maybeExecutionId ?? businessTypeOrExecutionId;
    const normalizedExecutionId = requireId(executionId, "executionId");
    const affectedRows = await this.client.executeUpdate(
      claimQueryFor(
        this.options.retryScheduleEnabled === true,
        this.options.workerProvider !== undefined
      ),
      [
      normalizedExecutionId,
      businessType,
      ...(this.options.workerProvider ? [this.options.workerProvider] : [])
      ]
    );
    const claimed = affectedRows === 1;
    await this.safeAudit({
      timestamp: new Date().toISOString(),
      event: "CLAIM_ATTEMPT",
      workerType,
      businessType,
      executionId: normalizedExecutionId,
      claimed
    });
    return claimed;
  }

  /** 查询一小批候选并逐条条件领取，返回首个赢得竞争的 CollectionTask。 */
  async claimNextTask(
    workerType: RpaWorkerRole,
    options: RpaTaskQueryOptions = {}
  ): Promise<CollectionTask | undefined> {
    const candidates = await this.findPendingTasks(workerType, options);
    for (const task of candidates) {
      // 运营台暂停：该业务类型的控制文件存在时，跳过认领但保留进程常驻。
      if (isBusinessTypePaused(workerType, task.businessType)) {
        await this.safeAudit({
          timestamp: new Date().toISOString(),
          event: "CLAIM_SKIPPED_PAUSED",
          workerType,
          businessType: task.businessType
        });
        continue;
      }
      if (await this.claimTask(workerType, task.businessType, task.executionId)) {
        return toCollectionTask(task);
      }
    }
    return undefined;
  }

  /**
   * 指标只读聚合。调用方必须把失败视为指标不可用，不能据此改变任务流程。
   * 仅统计 execution 自身的双状态，不修改 dispatch 状态。
   */
  async countTaskStates(workerType: RpaWorkerRole): Promise<RpaTaskStateCount[]> {
    const businessTypes = this.enabledBusinessTypes(workerType);
    if (businessTypes.length === 0) return [];
    const baseSql = TASK_STATE_COUNT_SQL.replace(
      "e.business_type = ?",
      sqlBusinessTypePredicate("e.business_type", businessTypes.length)
    );
    const rows = await this.client.queryRows<RpaTaskStateCountRow>(
      this.options.workerProvider
        ? baseSql.replace(
          "GROUP BY e.ai_model_id",
          "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\nGROUP BY e.ai_model_id"
        )
        : baseSql,
      [
        ...businessTypes,
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

  async countTaskStatesByBusinessType(
    workerType: RpaWorkerRole
  ): Promise<RpaBusinessTaskStateCount[]> {
    const businessTypes = this.enabledBusinessTypes(workerType);
    if (businessTypes.length === 0) return [];
    let sql = BUSINESS_TYPE_TASK_STATE_COUNT_SQL.replace(
      "%BUSINESS_FILTER%",
      sqlBusinessTypePredicate("e.business_type", businessTypes.length)
    );
    if (this.options.workerProvider) {
      sql = sql.replace(
        "GROUP BY e.business_type",
        "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\nGROUP BY e.business_type"
      );
    }
    const rows = await this.client.queryRows<RpaTaskStateCountRow>(sql, [
      ...businessTypes,
      ...(this.options.workerProvider ? [this.options.workerProvider] : [])
    ]);
    return rows.map((row) => ({
      businessType: requireBusinessType(row.businessType),
      platformId: resolveRpaPlatform(
        databaseId(row.aiModelId, "aiModelId"),
        nonEmptyString(row.aiModelName, "aiModelName")
      ),
      pending: nonNegativeInteger(row.pending, "pending"),
      processing: nonNegativeInteger(row.processing, "processing"),
      succeeded: nonNegativeInteger(row.succeeded, "succeeded"),
      finalFailed: nonNegativeInteger(row.finalFailed, "finalFailed")
    }));
  }

  async countBusinessTypeProtocolAnomalies(): Promise<RpaBusinessTypeProtocolCounts> {
    const [row] = await this.client.queryRows<Record<string, unknown>>(
      BUSINESS_TYPE_PROTOCOL_COUNT_SQL,
      []
    );
    return {
      nullExecutionType: nonNegativeInteger(row?.nullExecutionType ?? 0, "nullExecutionType"),
      mismatch: nonNegativeInteger(row?.mismatch ?? 0, "mismatch"),
      unknown: nonNegativeInteger(row?.unknown ?? 0, "unknown"),
      orphan: nonNegativeInteger(row?.orphan ?? 0, "orphan"),
      legacyFallback: nonNegativeInteger(row?.legacyFallback ?? 0, "legacyFallback"),
      invalidContext: nonNegativeInteger(row?.invalidContext ?? 0, "invalidContext"),
      articleProbeLegacy: nonNegativeInteger(row?.articleProbeLegacy ?? 0, "articleProbeLegacy")
    };
  }

  private async safeAudit(event: Parameters<RpaTaskAuditSink["write"]>[0]): Promise<void> {
    // 审计磁盘故障不能改变数据库领取结果，也不能诱发同一任务再次领取。
    await this.audit?.write(event).catch(() => undefined);
  }

  private enabledBusinessTypes(workerType: RpaWorkerRole): RpaBusinessType[] {
    if (workerType === "diagnosis") return ["DIAGNOSIS"];
    if (workerType === "style") {
      return this.options.contentStyleMonitorEnabled === true
        ? ["CONTENT_STYLE_MONITOR"]
        : [];
    }
    const types: RpaBusinessType[] = [];
    if (this.options.articleProbeLegacyEnabled !== false) types.push("ARTICLE_PROBE");
    if (this.options.entryMonitorEnabled === true) types.push("ENTRY_MONITOR");
    return types;
  }

  private async mapCandidate(
    row: RpaTaskRow,
    workerType: RpaWorkerRole,
    expectedBusinessType: RpaBusinessType
  ): Promise<RpaTask | undefined> {
    try {
      const task = mapRpaTaskRow(row, expectedBusinessType);
      if (isBlankBusinessType(row.executionBusinessType)) {
        await this.safeAudit({
          timestamp: new Date().toISOString(),
          event: "LEGACY_BUSINESS_TYPE_FALLBACK",
          workerType,
          businessType: task.businessType,
          dispatchBusinessType: task.businessType,
          ...(optionalDatabaseId(row.executionId) ?
            { executionId: optionalDatabaseId(row.executionId) } : {})
        });
      }
      return task;
    } catch (error) {
      const errorCode = (error as { errorCode?: unknown })?.errorCode;
      if (errorCode !== "INVALID_EXECUTION_CONTEXT" &&
          errorCode !== "BUSINESS_TYPE_MISMATCH") throw error;
      await this.safeAudit({
        timestamp: new Date().toISOString(),
        event: errorCode,
        workerType,
        businessType: expectedBusinessType,
        ...(optionalDatabaseId(row.executionId) ?
          { executionId: optionalDatabaseId(row.executionId) } : {})
      });
      return undefined;
    }
  }
}

const COMMON_SELECT = `
SELECT
  e.id AS executionId,
  e.task_id AS dispatchTaskId,
  e.business_type AS executionBusinessType,
  d.business_type AS dispatchBusinessType,
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
  AND e.business_type = ?
  AND d.business_type = e.business_type
  -- 同一业务任务/租户/平台仍有 processing 时，不允许跳过中断题领取后续题。
  -- stale recovery 将中断题恢复为 pending 后，完整剩余批次才会重新进入候选集。
  AND NOT EXISTS (
    SELECT 1
    FROM rpa_task_execution AS active_e
    INNER JOIN brand_rpa_dispatch_task AS active_d
      ON active_d.id = active_e.task_id
      AND active_d.deleted = 0
    WHERE active_e.status = 1
      AND active_e.task_status = 1
      AND active_e.answer_id IS NULL
      AND active_e.deleted = 0
      AND active_e.business_type = active_d.business_type
      AND active_d.business_type = d.business_type
      AND active_d.business_task_id = d.business_task_id
      AND active_d.tenant_key = d.tenant_key
      AND active_e.ai_model_id = e.ai_model_id
  )
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

/** ENTRY_MONITOR 只以 execution 为候选队列，并只关联 dispatch 与通用上下文。 */
const CONTEXTUAL_MONITOR_PENDING_SQL = `
SELECT
  e.id AS executionId,
  e.task_id AS dispatchTaskId,
  e.business_type AS executionBusinessType,
  d.business_type AS dispatchBusinessType,
  d.business_task_id AS businessTaskId,
  d.tenant_key AS tenantKey,
  e.keyword AS keyword,
  e.ai_model_id AS aiModelId,
  e.ai_model_name AS aiModelName,
  e.deep_thinking AS deepThinking,
  e.fail_num AS failCount,
  e.priority AS priority,
  e.create_time AS createdAt,
  ctx.project_id AS projectId,
  ctx.intent_entry_id AS intentEntryId,
  ctx.monitor_date AS monitorDate,
  ctx.repetition_no AS repetitionNo
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
  AND d.status = 'DISPATCHED'
INNER JOIN rpa_task_execution_context AS ctx
  ON ctx.execution_id = e.id
  AND ctx.deleted = 0
  AND ctx.business_type = e.business_type
  AND ctx.business_task_id = d.business_task_id
  AND ctx.ai_model_id = e.ai_model_id
WHERE e.status = 0
  AND e.task_status = 0
  AND e.deleted = 0
  AND e.business_type = ?
  AND d.business_type = e.business_type
  AND ctx.monitor_date = ?
  AND NOT EXISTS (
    SELECT 1
    FROM rpa_task_execution AS active_e
    INNER JOIN brand_rpa_dispatch_task AS active_d
      ON active_d.id = active_e.task_id
      AND active_d.deleted = 0
    INNER JOIN rpa_task_execution_context AS active_ctx
      ON active_ctx.execution_id = active_e.id
      AND active_ctx.deleted = 0
      AND active_ctx.business_type = active_e.business_type
      AND active_ctx.business_task_id = active_d.business_task_id
      AND active_ctx.ai_model_id = active_e.ai_model_id
    WHERE active_e.status = 1
      AND active_e.task_status = 1
      AND active_e.answer_id IS NULL
      AND active_e.deleted = 0
      AND active_e.business_type = active_d.business_type
      AND active_d.business_type = d.business_type
      AND active_d.tenant_key = d.tenant_key
      AND active_ctx.project_id = ctx.project_id
      AND active_ctx.monitor_date = ctx.monitor_date
      AND active_e.ai_model_id = e.ai_model_id
  )
ORDER BY e.priority ASC, e.create_time ASC, e.id ASC
LIMIT ?`;

function contextualMonitorPendingQueryFor(
  retryScheduleEnabled: boolean,
  providerRoutingEnabled: boolean,
  projectCount: number
): string {
  let sql = CONTEXTUAL_MONITOR_PENDING_SQL;
  if (providerRoutingEnabled) {
    sql = sql.replace(
      "AND ctx.monitor_date = ?",
      "AND d.worker_provider = ? AND e.worker_provider = d.worker_provider\n  AND ctx.monitor_date = ?"
    );
  }
  if (retryScheduleEnabled) {
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      "AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)\nORDER BY e.priority ASC"
    );
  }
  if (projectCount > 0) {
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      `AND ctx.project_id IN (${Array.from({ length: projectCount }, () => "?").join(", ")})\nORDER BY e.priority ASC`
    );
  }
  return sql;
}

function contextualMonitorBatchQueryFor(
  retryScheduleEnabled: boolean,
  providerRoutingEnabled: boolean
): string {
  let sql = contextualMonitorPendingQueryFor(false, false, 0).replace(
    "AND ctx.monitor_date = ?",
    `AND ctx.project_id = ?
  AND d.tenant_key = ?
  AND e.ai_model_id = ?
  AND ctx.monitor_date = ?`
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

function pendingBatchQueryFor(
  workerType: RpaWorkerRole,
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
  AND e.business_type = ?
  AND d.business_type = e.business_type`;

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
  AND e.business_type = ?
  AND d.business_type = e.business_type
GROUP BY e.ai_model_id, e.ai_model_name`;

export const BUSINESS_TYPE_TASK_STATE_COUNT_SQL = `
SELECT
  e.business_type AS businessType,
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
  AND %BUSINESS_FILTER%
  AND d.business_type = e.business_type
GROUP BY e.business_type, e.ai_model_id, e.ai_model_name`;

export const BUSINESS_TYPE_PROTOCOL_COUNT_SQL = `
SELECT
  SUM(e.business_type IS NULL OR TRIM(e.business_type) = '') AS nullExecutionType,
  SUM(d.id IS NOT NULL AND e.business_type IS NOT NULL AND TRIM(e.business_type) <> ''
      AND e.business_type <> d.business_type) AS mismatch,
  SUM(e.business_type IS NOT NULL AND TRIM(e.business_type) <> ''
      AND e.business_type NOT IN ('DIAGNOSIS','CONTENT_STYLE_MONITOR','ENTRY_MONITOR','ARTICLE_PROBE')) AS unknown,
  SUM(d.id IS NULL) AS orphan,
  SUM(d.id IS NOT NULL AND (e.business_type IS NULL OR TRIM(e.business_type) = '')
      AND d.business_type IN ('DIAGNOSIS','CONTENT_STYLE_MONITOR','ENTRY_MONITOR','ARTICLE_PROBE')) AS legacyFallback,
  SUM(e.business_type IN ('ENTRY_MONITOR','CONTENT_STYLE_MONITOR') AND ctx.execution_id IS NULL) AS invalidContext,
  SUM(e.business_type = 'ARTICLE_PROBE'
      OR ((e.business_type IS NULL OR TRIM(e.business_type) = '') AND d.business_type = 'ARTICLE_PROBE')) AS articleProbeLegacy
FROM rpa_task_execution AS e
LEFT JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
 AND d.deleted = 0
LEFT JOIN rpa_task_execution_context AS ctx
  ON ctx.execution_id = e.id
 AND ctx.deleted = 0
 AND ctx.business_type = e.business_type
 AND ctx.business_task_id = d.business_task_id
 AND ctx.ai_model_id = e.ai_model_id
WHERE e.deleted = 0`;

export function mapRpaTaskRow(
  row: RpaTaskRow,
  expectedBusinessType?: RpaBusinessType
): RpaTask {
  const businessType = resolveExecutionBusinessType(
    row.executionBusinessType,
    row.dispatchBusinessType
  );
  if (expectedBusinessType && businessType !== expectedBusinessType) {
    throw new Error(
      `RPA 查询返回了错误业务类型：期望 ${expectedBusinessType}，实际 ${businessType}`
    );
  }
  const common = {
    executionId: databaseId(row.executionId, "executionId"),
    dispatchTaskId: databaseId(row.dispatchTaskId, "dispatchTaskId"),
    businessTaskId: databaseId(row.businessTaskId, "businessTaskId"),
    tenantKey: nonEmptyString(row.tenantKey, "tenantKey"),
    keyword: nonEmptyString(row.keyword, "keyword", false),
    aiModelId: databaseId(row.aiModelId, "aiModelId"),
    aiModelName: nonEmptyString(row.aiModelName, "aiModelName"),
    deepThinking: booleanFlag(row.deepThinking, "deepThinking"),
    failCount: nonNegativeInteger(row.failCount, "failCount"),
    priority: nonNegativeInteger(row.priority, "priority"),
    createdAt: databaseDate(row.createdAt, "createdAt")
  };
  if (businessType === "ENTRY_MONITOR" || businessType === "CONTENT_STYLE_MONITOR") {
    try {
      const tenantId = common.tenantKey;
      return {
        ...common,
        businessType,
        tenantId,
        projectId: databaseId(row.projectId, "projectId"),
        intentEntryId: databaseId(row.intentEntryId, "intentEntryId"),
        monitorDate: monitorDate(row.monitorDate),
        repetitionNo: positiveInteger(row.repetitionNo, "repetitionNo")
      };
    } catch (error) {
      throw Object.assign(
        new Error(`${businessType} execution context 无效：${formatError(error)}`),
        { errorCode: "INVALID_EXECUTION_CONTEXT" as const }
      );
    }
  }
  return {
    ...common,
    businessType,
    brandId: databaseId(row.brandId, "brandId")
  };
}

function pendingQueryFor(
  workerType: RpaWorkerRole,
  retryScheduleEnabled = false,
  providerRoutingEnabled = false,
  brandCohortCount = 0
): string {
  let sql = workerType === "diagnosis" ? DIAGNOSIS_PENDING_SQL : MONITOR_PENDING_SQL;
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
  if (brandCohortCount > 0) {
    const predicates = Array.from(
      { length: brandCohortCount },
      () => "(d.business_task_id = ? AND d.tenant_key = ?)"
    ).join(" OR ");
    sql = sql.replace(
      "ORDER BY e.priority ASC",
      `AND (${predicates})\nORDER BY e.priority ASC`
    );
  }
  return sql;
}

const BRAND_WINDOW_SELECT = `
WITH brand_cohorts AS (
SELECT
  d.tenant_key AS tenantKey,
  d.business_task_id AS businessTaskId,
  %BRAND_COLUMN% AS brandId,
  MIN(e.priority) AS priority,
  MIN(e.create_time) AS createdAt,
  MIN(e.id) AS sortId,
  COUNT(*) AS totalTasks,
  COUNT(DISTINCT e.ai_model_id) AS platformCount,
  SUM(CASE WHEN e.status = 0 AND e.task_status = 0 THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN e.status = 1 AND e.task_status = 1 THEN 1 ELSE 0 END) AS processing,
  SUM(CASE WHEN e.status = 2 AND e.task_status = 2 THEN 1 ELSE 0 END) AS succeeded,
  SUM(CASE WHEN e.status = 3 AND e.task_status = 3 THEN 1 ELSE 0 END) AS finalFailed
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
  AND d.status = 'DISPATCHED'
%BUSINESS_JOIN%
WHERE e.deleted = 0
  AND e.business_type = ?
  AND d.business_type = e.business_type
%PROVIDER_FILTER%
GROUP BY d.tenant_key, d.business_task_id, %BRAND_COLUMN%
),
oldest_incomplete AS (
SELECT priority, createdAt, sortId
FROM brand_cohorts
WHERE succeeded < totalTasks OR platformCount < ?
ORDER BY priority ASC, createdAt ASC, sortId ASC
LIMIT 1
)
SELECT
  cohort.tenantKey,
  cohort.businessTaskId,
  cohort.brandId,
  cohort.priority,
  cohort.createdAt,
  cohort.totalTasks,
  cohort.platformCount,
  cohort.pending,
  cohort.processing,
  cohort.succeeded,
  cohort.finalFailed
FROM brand_cohorts AS cohort
INNER JOIN oldest_incomplete AS anchor
  ON cohort.priority > anchor.priority
  OR (cohort.priority = anchor.priority AND cohort.createdAt > anchor.createdAt)
  OR (
    cohort.priority = anchor.priority
    AND cohort.createdAt = anchor.createdAt
    AND cohort.sortId >= anchor.sortId
  )
ORDER BY cohort.priority ASC, cohort.createdAt ASC, cohort.sortId ASC
LIMIT ?`;

function brandWindowQueryFor(
  workerType: RpaWorkerRole,
  providerRoutingEnabled: boolean,
  expectedPlatforms: readonly PlatformId[]
): string {
  const diagnosis = workerType === "diagnosis";
  const expectedAiModelIds = expectedPlatforms.map(aiModelIdForPlatform);
  return BRAND_WINDOW_SELECT
    .replace(
      "COUNT(DISTINCT e.ai_model_id) AS platformCount",
      `COUNT(DISTINCT CASE WHEN e.ai_model_id IN (${expectedAiModelIds
        .map((id) => `'${id}'`)
        .join(", ")}) THEN e.ai_model_id END) AS platformCount`
    )
    .replaceAll(
      "%BRAND_COLUMN%",
      diagnosis ? "business_task.profile_id" : "business_task.brand_id"
    )
    .replace(
      "%BUSINESS_JOIN%",
      diagnosis
        ? `INNER JOIN diagnosis_task AS business_task
  ON business_task.id = d.business_task_id
  AND business_task.deleted = 0`
        : `INNER JOIN probe_article_task AS business_task
  ON business_task.id = d.business_task_id
  AND business_task.deleted = 0`
    )
    .replace(
      "%PROVIDER_FILTER%",
      providerRoutingEnabled
        ? "  AND d.worker_provider = ? AND e.worker_provider = d.worker_provider"
        : ""
    );
}

function normalizeLimit(value = 100): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error("RPA 查询 limit 必须是 1 到 1000 的整数。");
  }
  return value;
}

function normalizeWindowSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    throw new Error("brand window size must be an integer from 0 to 10");
  }
  return value;
}

function normalizeExpectedPlatforms(
  platforms: readonly PlatformId[]
): PlatformId[] {
  const normalized = [...new Set(platforms)];
  if (normalized.length === 0) {
    throw new Error("brand barrier platforms cannot be empty");
  }
  return normalized;
}

function aiModelIdForPlatform(platform: PlatformId): string {
  return ({ doubao: "1", deepseek: "2", yuanbao: "3", qianwen: "4" })[platform];
}

function normalizeBrandCohorts(
  cohorts: readonly RpaBrandCohort[] | undefined
): RpaBrandCohort[] {
  if (!cohorts) return [];
  const normalized = new Map<string, RpaBrandCohort>();
  for (const cohort of cohorts) {
    const item = {
      tenantKey: nonEmptyString(cohort.tenantKey, "tenantKey"),
      businessTaskId: requireId(cohort.businessTaskId, "businessTaskId"),
      brandId: requireId(cohort.brandId, "brandId")
    };
    normalized.set(`${item.tenantKey}\u0000${item.businessTaskId}`, item);
  }
  if (normalized.size > 10) throw new Error("brand cohort filter cannot exceed 10 entries");
  return [...normalized.values()];
}

function requireBusinessType(value: unknown): RpaBusinessType {
  if (
    value === "DIAGNOSIS" ||
    value === "CONTENT_STYLE_MONITOR" ||
    value === "ARTICLE_PROBE" ||
    value === "ENTRY_MONITOR"
  ) return value;
  throw new Error(`不支持的 RPA business_type：${String(value)}`);
}

export function resolveExecutionBusinessType(
  executionType: unknown,
  dispatchType: unknown
): RpaBusinessType {
  const normalizedDispatch = requireBusinessType(dispatchType);
  if (isBlankBusinessType(executionType)) return normalizedDispatch;
  const normalizedExecution = requireBusinessType(executionType);
  if (normalizedExecution !== normalizedDispatch) {
    throw Object.assign(
      new Error(
        `execution 与 dispatch 的 business_type 不一致：` +
        `${normalizedExecution} != ${normalizedDispatch}`
      ),
      { errorCode: "BUSINESS_TYPE_MISMATCH" as const }
    );
  }
  return normalizedExecution;
}

function isBlankBusinessType(value: unknown): boolean {
  return value == null || String(value).trim() === "";
}

function sqlBusinessTypePredicate(column: string, count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("business type predicate requires at least one type");
  }
  return count === 1
    ? `${column} = ?`
    : `${column} IN (${Array.from({ length: count }, () => "?").join(", ")})`;
}

function normalizeProjectIds(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => requireId(value, "projectId")))];
}

function compareTasks(a: RpaTask, b: RpaTask): number {
  return a.priority - b.priority ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    compareDatabaseIds(a.executionId, b.executionId);
}

function compareDatabaseIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
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

function optionalDatabaseId(value: unknown): string | undefined {
  try {
    return databaseId(value, "executionId");
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) throw new Error(`${field} 必须是正整数。`);
  return parsed;
}

function monitorDate(value: unknown): string {
  const normalized = value instanceof Date
    ? `${value.getFullYear().toString().padStart(4, "0")}-${(value.getMonth() + 1)
      .toString().padStart(2, "0")}-${value.getDate().toString().padStart(2, "0")}`
    : String(value ?? "").trim().slice(0, 10);
  if (!isMonitorDate(normalized)) throw new Error("monitorDate 必须是有效的 YYYY-MM-DD。");
  return normalized;
}

function requireMonitorDate(value: unknown): string {
  return monitorDate(value);
}

function databaseDate(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} 不是有效时间。`);
  return date.toISOString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
