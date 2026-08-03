/** 数据库心跳、僵尸恢复和跨进程 advisory lease。 */
import {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";
import { getRpaDatabasePool } from "./rpaDatabase.js";
import {
  MysqlRpaSqlClient,
  type RpaSqlClient,
  type RpaSqlParameter
} from "./rpaTaskRepository.js";
import { businessTypeForWorker, type RpaWorkerType } from "./rpaTask.js";
import type { PlatformId } from "./types.js";

export interface StaleExecution {
  executionId: string;
  modifiedAt: string;
}

export interface ZombieRecoveryResult {
  candidates: readonly StaleExecution[];
  recoveredExecutionIds: readonly string[];
  skippedLockedExecutionIds: readonly string[];
}

export interface AdvisoryLeaseCoordinator {
  tryAcquire(lockName: string): Promise<boolean>;
  release(lockName: string): Promise<void>;
  close(): Promise<void>;
  isTrusted?(): boolean;
}

export interface MysqlAdvisoryLeaseOptions {
  onInvalidated?: (error?: unknown) => void;
  onTrusted?: () => void;
}

export class MysqlAdvisoryLeaseCoordinator implements AdvisoryLeaseCoordinator {
  private connection?: PoolConnection;
  private operationQueue = Promise.resolve();
  private readonly heldLocks = new Set<string>();
  private trusted = false;

  constructor(
    private readonly pool: Pool = getRpaDatabasePool(),
    private readonly options: MysqlAdvisoryLeaseOptions = {}
  ) {}

  isTrusted(): boolean {
    return this.trusted && this.connection !== undefined;
  }

  tryAcquire(lockName: string): Promise<boolean> {
    return this.serial(async () => {
      const name = validateLockName(lockName);
      const connection = await this.getConnection();
      if (this.heldLocks.has(name)) {
        try {
          const [verification] = await connection.query<RowDataPacket[]>(
            "SELECT IS_USED_LOCK(?) AS ownerId, CONNECTION_ID() AS connectionId",
            [name]
          );
          const row = verification[0];
          if (
            row?.ownerId !== null &&
            String(row?.ownerId) === String(row?.connectionId)
          ) {
            return true;
          }
          this.heldLocks.delete(name);
        } catch (error) {
          this.invalidateConnection(connection, error);
          throw error;
        }
      }
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [name]
      );
      const acquired = Number(rows[0]?.acquired) === 1;
      if (acquired) {
        this.heldLocks.add(name);
        this.markTrusted();
      }
      return acquired;
    });
  }

  release(lockName: string): Promise<void> {
    return this.serial(async () => {
      const name = validateLockName(lockName);
      if (!this.connection || !this.heldLocks.has(name)) return;
      const connection = this.connection;
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [name]);
        this.heldLocks.delete(name);
      } catch (error) {
        this.invalidateConnection(connection, error);
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (!this.connection) return;
      const connection = this.connection;
      this.connection = undefined;
      this.heldLocks.clear();
      this.trusted = false;
      await connection.query("SELECT RELEASE_ALL_LOCKS()").catch(() => undefined);
      connection.release();
    });
  }

  private async getConnection(): Promise<PoolConnection> {
    if (!this.connection) {
      const connection = await this.pool.getConnection();
      this.connection = connection;
      this.attachConnectionListeners(connection);
      this.markTrusted();
    }
    return this.connection;
  }

  private attachConnectionListeners(connection: PoolConnection): void {
    const invalidate = (error?: unknown) => this.invalidateConnection(connection, error);
    connection.on("error", invalidate);
    connection.on("end", invalidate);
    connection.on("close", invalidate);
  }

  private invalidateConnection(connection: PoolConnection, error?: unknown): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.heldLocks.clear();
    this.trusted = false;
    this.options.onInvalidated?.(error);
  }

  private markTrusted(): void {
    if (this.trusted) return;
    this.trusted = true;
    this.options.onTrusted?.();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class RpaWorkerStateRepository {
  constructor(private readonly client: RpaSqlClient = new MysqlRpaSqlClient()) {}

  async heartbeat(executionIds: readonly string[]): Promise<number> {
    const ids = normalizeIds(executionIds);
    if (ids.length === 0) return 0;
    return this.client.executeUpdate(
      `UPDATE rpa_task_execution
SET modify_time = CURRENT_TIMESTAMP
WHERE id IN (${ids.map(() => "?").join(", ")})
  AND status = 1
  AND task_status = 1
  AND deleted = 0`,
      ids
    );
  }

  /** 只允许调用方释放本进程刚领取但尚未执行的任务。 */
  async releaseClaims(executionIds: readonly string[]): Promise<number> {
    const ids = normalizeIds(executionIds);
    if (ids.length === 0) return 0;
    return this.client.executeUpdate(
      `UPDATE rpa_task_execution
SET
  status = 0,
  task_status = 0,
  start_time = NULL,
  modify_time = CURRENT_TIMESTAMP
WHERE id IN (${ids.map(() => "?").join(", ")})
  AND status = 1
  AND task_status = 1
  AND answer_id IS NULL
  AND deleted = 0`,
      ids
    );
  }

  async findStaleExecutions(
    workerType: RpaWorkerType,
    staleBefore: Date,
    limit = 100
  ): Promise<StaleExecution[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new Error("僵尸任务查询 limit 必须为 1 到 1000。");
    }
    const rows = await this.client.queryRows<{
      executionId: unknown;
      modifiedAt: unknown;
    }>(STALE_EXECUTIONS_SQL, [
      businessTypeForWorker(workerType),
      staleBefore,
      limit
    ]);
    return rows.map((row) => ({
      executionId: databaseId(row.executionId),
      modifiedAt: databaseDate(row.modifiedAt)
    }));
  }

  async recoverStaleExecutions(
    workerType: RpaWorkerType,
    staleBefore: Date,
    leases: AdvisoryLeaseCoordinator,
    options: { limit?: number; dryRun?: boolean } = {}
  ): Promise<ZombieRecoveryResult> {
    const candidates = await this.findStaleExecutions(
      workerType,
      staleBefore,
      options.limit
    );
    if (options.dryRun) {
      return { candidates, recoveredExecutionIds: [], skippedLockedExecutionIds: [] };
    }
    const recoveredExecutionIds: string[] = [];
    const skippedLockedExecutionIds: string[] = [];
    for (const candidate of candidates) {
      const lockName = executionLeaseName(candidate.executionId);
      if (!await leases.tryAcquire(lockName)) {
        skippedLockedExecutionIds.push(candidate.executionId);
        continue;
      }
      try {
        const affectedRows = await this.client.executeUpdate(RECOVER_STALE_EXECUTION_SQL, [
          candidate.executionId,
          staleBefore,
          businessTypeForWorker(workerType)
        ]);
        if (affectedRows === 1) recoveredExecutionIds.push(candidate.executionId);
      } finally {
        await leases.release(lockName);
      }
    }
    return { candidates, recoveredExecutionIds, skippedLockedExecutionIds };
  }
}

export interface HeartbeatOptions {
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export class ExecutionHeartbeat {
  private timer?: NodeJS.Timeout;
  private pending = Promise.resolve();
  private stopped = false;
  private readonly activeExecutionIds: Set<string>;

  constructor(
    private readonly repository: RpaWorkerStateRepository,
    executionIds: readonly string[],
    private readonly options: HeartbeatOptions
  ) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1_000) {
      throw new Error("心跳间隔必须至少为 1000ms。");
    }
    this.activeExecutionIds = new Set(normalizeIds(executionIds));
  }

  /** 在任务状态释放或完成前调用；后续心跳快照不再包含该 execution。 */
  remove(executionId: string): boolean {
    return this.activeExecutionIds.delete(databaseId(executionId));
  }

  has(executionId: string): boolean {
    return this.activeExecutionIds.has(databaseId(executionId));
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) throw new Error("心跳不能重复启动。");
    await this.tick();
    this.timer = setInterval(() => {
      this.pending = this.pending.then(() => this.tick()).catch((error) => {
        this.options.onError?.(error);
      });
    }, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  private async tick(): Promise<void> {
    await this.repository.heartbeat([...this.activeExecutionIds]);
  }
}

export interface WaitForLeaseOptions {
  waitMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForAdvisoryLease(
  leases: AdvisoryLeaseCoordinator,
  lockName: string,
  options: WaitForLeaseOptions
): Promise<boolean> {
  validateDuration(options.waitMs, "waitMs");
  validateDuration(options.pollMs, "pollMs");
  if (options.pollMs === 0) throw new Error("pollMs 必须大于 0。");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + options.waitMs;
  do {
    if (await leases.tryAcquire(lockName)) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(options.pollMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return false;
}

export function executionLeaseName(executionId: string): string {
  return validateLockName(`geno-rpa-exec:${databaseId(executionId)}`);
}

export function platformLeaseName(platformId: PlatformId): string {
  return validateLockName(`geno-rpa-platform:${platformId}`);
}

export const STALE_EXECUTIONS_SQL = `
SELECT
  e.id AS executionId,
  e.modify_time AS modifiedAt
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
WHERE e.status = 1
  AND e.task_status = 1
  AND e.answer_id IS NULL
  AND e.deleted = 0
  AND d.business_type = ?
  AND e.modify_time < ?
ORDER BY e.modify_time ASC, e.id ASC
LIMIT ?`;

export const RECOVER_STALE_EXECUTION_SQL = `
UPDATE rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.deleted = 0
SET
  e.status = 0,
  e.task_status = 0,
  e.start_time = NULL,
  e.modify_time = CURRENT_TIMESTAMP
WHERE e.id = ?
  AND e.status = 1
  AND e.task_status = 1
  AND e.answer_id IS NULL
  AND e.deleted = 0
  AND e.modify_time < ?
  AND d.business_type = ?`;

function normalizeIds(values: readonly string[]): string[] {
  const ids = [...new Set(values.map(databaseId))];
  if (ids.length > 1_000) throw new Error("单次 execution ID 数量不能超过 1000。");
  return ids;
}

function validateLockName(value: string): string {
  if (!value || value.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(value)) {
    throw new Error("MySQL advisory lock 名称无效。");
  }
  return value;
}

function databaseId(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  throw new Error("executionId 不是有效数据库 ID。");
}

function databaseDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("modify_time 不是有效时间。");
  return date.toISOString();
}

function validateDuration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 必须为非负数。`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
