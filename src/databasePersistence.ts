/**
 * 抓取结果数据库持久化。
 *
 * 每次程序运行创建一个问题批次和一次 crawl_run，并预先建立全部
 * “问题 × 平台”任务。单题完成时在一个事务内更新任务状态、最终答案和引用，
 * 因此四个平台并发写入时彼此隔离，也不会出现最后完成的平台覆盖其他平台。
 */
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import type {
  CrawlQuestionResult
} from "./crawler.js";
import { getDatabasePool } from "./database.js";
import type { PlatformConfig, PlatformId } from "./types.js";

type DatabaseId = string;

interface PlatformIdRow extends RowDataPacket {
  id: DatabaseId;
}

export interface CreateDatabaseRunOptions {
  questions: readonly string[];
  platforms: readonly PlatformConfig[];
  batchName?: string;
}

export interface DatabaseRunFailure {
  platformId: PlatformId;
  error: unknown;
}

/** 当前运行在数据库中的稳定 ID 映射。 */
interface DatabaseRunState {
  batchId: DatabaseId;
  runId: DatabaseId;
  questionIds: DatabaseId[];
  platformIds: Map<PlatformId, DatabaseId>;
  taskIds: Map<string, DatabaseId>;
}

/**
 * 管理一次抓取运行。实例在初始化事务成功后才会返回，避免留下半套批次数据。
 */
export class DatabaseRunCoordinator {
  private finalized = false;

  private constructor(
    private readonly pool: Pool,
    private readonly state: DatabaseRunState,
    private readonly platformCount: number
  ) {}

  static async create(
    options: CreateDatabaseRunOptions,
    pool: Pool = getDatabasePool()
  ): Promise<DatabaseRunCoordinator> {
    const state = await initializeDatabaseRun(pool, options);
    return new DatabaseRunCoordinator(pool, state, options.platforms.length);
  }

  get runId(): DatabaseId {
    return this.state.runId;
  }

  get batchId(): DatabaseId {
    return this.state.batchId;
  }

  /** 在真正操作页面前把对应任务标记为运行中。 */
  async startQuestion(platformId: PlatformId, questionIndex: number): Promise<void> {
    const taskId = this.requireTaskId(platformId, questionIndex);
    await this.pool.execute(
      `UPDATE question_platform_tasks
       SET status = 'running',
           attempt_count = GREATEST(attempt_count, 1),
           error_message = NULL,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
           completed_at = NULL
       WHERE id = ?`,
      [taskId]
    );
  }

  /**
   * 持久化单题最终状态。answers 的 task_id 唯一约束配合 upsert，保证同一任务
   * 多次生成时只保留最后一次回答；引用先清空再写入最终版本。
   */
  async saveQuestion(
    platformId: PlatformId,
    result: CrawlQuestionResult
  ): Promise<void> {
    const taskId = this.requireTaskId(platformId, result.questionIndex);
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE question_platform_tasks
         SET status = ?,
             attempt_count = ?,
             error_message = ?,
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
             completed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [
          result.status,
          clampAttemptCount(result.attemptCount),
          result.errorMessage ?? null,
          taskId
        ]
      );

      if (result.answer) {
        await connection.execute(
          `INSERT INTO answers (
             task_id, content, content_format, generation_number,
             reference_count, extracted_at
           )
           VALUES (?, ?, 'text', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             content = VALUES(content),
             content_format = VALUES(content_format),
             generation_number = VALUES(generation_number),
             reference_count = VALUES(reference_count),
             extracted_at = VALUES(extracted_at)`,
          [
            taskId,
            result.answer.answer,
            result.answer.generationNumber,
            result.answer.referenceCount,
            requireValidDate(result.answer.extractedAt, "答案抓取时间")
          ]
        );
      }

      // 当前表通过 task_id + URL 哈希去重；先删除可移除旧一版中已消失的引用。
      await connection.execute("DELETE FROM `references` WHERE task_id = ?", [taskId]);
      if (result.references.length > 0) {
        await insertReferences(connection, taskId, result.references);
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 平台正常结束时兜底关闭未收到完成事件的任务。正常情况下影响行数应为 0；
   * 若页面逻辑主动跳过但没有结果事件，则数据库仍不会永久停留在 pending。
   */
  async completePlatform(platformId: PlatformId): Promise<void> {
    const databasePlatformId = this.requirePlatformId(platformId);
    await this.pool.execute(
      `UPDATE question_platform_tasks
       SET status = 'skipped',
           error_message = '平台结束时未收到该问题的完成事件。',
           completed_at = CURRENT_TIMESTAMP(3)
       WHERE run_id = ?
         AND platform_id = ?
         AND status IN ('pending', 'running')`,
      [this.state.runId, databasePlatformId]
    );
  }

  /** 平台异常时把当前及尚未执行的任务统一标记为 failed。 */
  async failPlatform(platformId: PlatformId, error: unknown): Promise<void> {
    const databasePlatformId = this.requirePlatformId(platformId);
    await this.pool.execute(
      `UPDATE question_platform_tasks
       SET status = 'failed',
           error_message = ?,
           completed_at = CURRENT_TIMESTAMP(3)
       WHERE run_id = ?
         AND platform_id = ?
         AND status IN ('pending', 'running')`,
      [formatDatabaseError(error), this.state.runId, databasePlatformId]
    );
  }

  /** 汇总平台结果并结束 crawl_run 与 question_batch。 */
  async finalize(failures: readonly DatabaseRunFailure[]): Promise<void> {
    if (this.finalized) return;
    const status = failures.length === 0
      ? "completed"
      : failures.length >= this.platformCount
        ? "failed"
        : "partial_failed";
    const errorMessage = failures.length === 0
      ? null
      : failures
        .map(({ platformId, error }) => `${platformId}: ${formatDatabaseError(error)}`)
        .join("\n");
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE crawl_runs
         SET status = ?,
             completed_at = CURRENT_TIMESTAMP(3),
             error_message = ?
         WHERE id = ?`,
        [status, errorMessage, this.state.runId]
      );
      await connection.execute(
        "UPDATE question_batches SET status = ? WHERE id = ?",
        [status, this.state.batchId]
      );
      await connection.commit();
      this.finalized = true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private requireTaskId(platformId: PlatformId, questionIndex: number): DatabaseId {
    const taskId = this.state.taskIds.get(taskKey(platformId, questionIndex));
    if (!taskId) {
      throw new Error(
        `数据库任务不存在：platform=${platformId}, questionIndex=${questionIndex}`
      );
    }
    return taskId;
  }

  private requirePlatformId(platformId: PlatformId): DatabaseId {
    const databasePlatformId = this.state.platformIds.get(platformId);
    if (!databasePlatformId) {
      throw new Error(`数据库平台不存在：${platformId}`);
    }
    return databasePlatformId;
  }
}

/** 对外工厂，便于入口层按 CLI 开关延迟启用数据库。 */
export async function createDatabaseRunCoordinator(
  options: CreateDatabaseRunOptions,
  pool: Pool = getDatabasePool()
): Promise<DatabaseRunCoordinator> {
  return DatabaseRunCoordinator.create(options, pool);
}

async function initializeDatabaseRun(
  pool: Pool,
  options: CreateDatabaseRunOptions
): Promise<DatabaseRunState> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [batchResult] = await connection.execute<ResultSetHeader>(
      "INSERT INTO question_batches (name, status) VALUES (?, 'running')",
      [normalizeBatchName(options.batchName)]
    );
    const batchId = requireInsertId(batchResult, "question_batches");
    const questionIds: DatabaseId[] = [];

    for (const [index, question] of options.questions.entries()) {
      const [questionResult] = await connection.execute<ResultSetHeader>(
        `INSERT INTO questions (batch_id, content, sort_order, enabled)
         VALUES (?, ?, ?, 1)`,
        [batchId, question, index + 1]
      );
      questionIds.push(requireInsertId(questionResult, "questions"));
    }

    const [runResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO crawl_runs (batch_id, status, started_at)
       VALUES (?, 'running', CURRENT_TIMESTAMP(3))`,
      [batchId]
    );
    const runId = requireInsertId(runResult, "crawl_runs");
    const platformIds = new Map<PlatformId, DatabaseId>();

    for (const platform of options.platforms) {
      await connection.execute(
        `INSERT INTO platforms (code, name, enabled)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE name = ?, enabled = 1`,
        [platform.id, platform.name, platform.name]
      );
      const [platformRows] = await connection.execute<PlatformIdRow[]>(
        "SELECT id FROM platforms WHERE code = ? LIMIT 1",
        [platform.id]
      );
      const databasePlatformId = platformRows[0]?.id;
      if (!databasePlatformId) {
        throw new Error(`写入平台后未能读取 ID：${platform.id}`);
      }
      platformIds.set(platform.id, String(databasePlatformId));
    }

    const taskIds = new Map<string, DatabaseId>();
    for (const [questionIndex, questionId] of questionIds.entries()) {
      for (const platform of options.platforms) {
        const databasePlatformId = platformIds.get(platform.id)!;
        const [taskResult] = await connection.execute<ResultSetHeader>(
          `INSERT INTO question_platform_tasks (
             run_id, question_id, platform_id, status
           )
           VALUES (?, ?, ?, 'pending')`,
          [runId, questionId, databasePlatformId]
        );
        taskIds.set(
          taskKey(platform.id, questionIndex),
          requireInsertId(taskResult, "question_platform_tasks")
        );
      }
    }

    await connection.commit();
    return { batchId, runId, questionIds, platformIds, taskIds };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function insertReferences(
  connection: PoolConnection,
  taskId: DatabaseId,
  references: CrawlQuestionResult["references"]
): Promise<void> {
  const placeholders = references.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const parameters = references.flatMap((reference) => [
    taskId,
    reference.rank,
    reference.articlePlatform,
    reference.articleTime,
    reference.title,
    reference.summary,
    reference.url,
    requireValidDate(reference.extractedAt, "参考资料抓取时间")
  ]);

  await connection.execute(
    `INSERT INTO \`references\` (
       task_id, \`rank\`, article_platform, article_time,
       title, summary, url, extracted_at
     )
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       \`rank\` = VALUES(\`rank\`),
       article_platform = VALUES(article_platform),
       article_time = VALUES(article_time),
       title = VALUES(title),
       summary = VALUES(summary),
       extracted_at = VALUES(extracted_at)`,
    parameters
  );
}

function taskKey(platformId: PlatformId, questionIndex: number): string {
  return `${platformId}:${questionIndex}`;
}

function requireInsertId(result: ResultSetHeader, table: string): DatabaseId {
  if (!result.insertId) {
    throw new Error(`${table} 写入成功但没有返回 insertId。`);
  }
  return String(result.insertId);
}

function normalizeBatchName(batchName?: string): string {
  const value = batchName?.trim() || `自动抓取批次 ${new Date().toISOString()}`;
  if (value.length > 255) {
    throw new Error("数据库批次名称不能超过 255 个字符。");
  }
  return value;
}

function clampAttemptCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(255, Math.max(1, Math.trunc(value)));
}

function requireValidDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}格式无效：${value}`);
  }
  return date;
}

function formatDatabaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 10_000);
}
