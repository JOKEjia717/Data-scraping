/**
 * RPA 仓储验证 CLI。默认只查询；必须显式 --claim=true 才执行 status/task_status 领取。
 */
import { pathToFileURL } from "node:url";
import { closeRpaDatabasePool } from "./rpaDatabase.js";
import { JsonlRpaTaskAuditLogger } from "./rpaTaskAudit.js";
import {
  createRpaTaskRepositoryOptions,
  RpaTaskRepository,
  type RpaTaskRepositoryOptions
} from "./rpaTaskRepository.js";
import { parseRpaWorkerConfig } from "./rpaWorkerConfig.js";
import {
  rpaConsoleError,
  rpaConsoleInfo
} from "./consolePrivacy.js";
import type { RpaWorkerType } from "./rpaTask.js";

interface CheckOptions {
  workerType: RpaWorkerType;
  limit: number;
  claim: boolean;
  logDirectory: string;
}

export async function checkRpaTasks(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCheckOptions(argv);
  const audit = new JsonlRpaTaskAuditLogger({ logDirectory: options.logDirectory });
  const repository = new RpaTaskRepository(
    undefined,
    audit,
    resolveCheckRpaTaskRepositoryOptions(options.workerType, argv)
  );
  try {
    if (options.claim) {
      const task = await repository.claimNextTask(options.workerType, {
        limit: options.limit
      });
      if (task) {
        rpaConsoleInfo({
          workerId: `${options.workerType}-task-check`,
          event: "TASK_CLAIMED",
          businessType: task.businessType,
          executionId: task.executionId,
          ...(task.businessType === "ENTRY_MONITOR" ||
              task.businessType === "CONTENT_STYLE_MONITOR"
            ? { projectId: task.projectId }
            : { brandId: task.brandId }),
          platformId: task.platformId,
          batchProgress: "claimed=1"
        });
      } else {
        rpaConsoleInfo({
          workerId: `${options.workerType}-task-check`,
          event: "NO_CLAIMABLE_TASK",
          batchProgress: "claimed=0"
        });
      }
      return;
    }
    const tasks = await repository.findPendingCollectionTasks(options.workerType, {
      limit: options.limit
    });
    rpaConsoleInfo({
      workerId: `${options.workerType}-task-check`,
      event: "PENDING_TASKS",
      batchProgress: `tasks=${tasks.length},readOnly=true`
    });
    for (const task of tasks) {
      rpaConsoleInfo({
        workerId: `${options.workerType}-task-check`,
        event: "PENDING_TASK",
        businessType: task.businessType,
        executionId: task.executionId,
        ...(task.businessType === "ENTRY_MONITOR" ||
            task.businessType === "CONTENT_STYLE_MONITOR"
          ? { projectId: task.projectId }
          : { brandId: task.brandId }),
        platformId: task.platformId
      });
    }
  } finally {
    await audit.flush();
    await closeRpaDatabasePool();
  }
}

export function resolveCheckRpaTaskRepositoryOptions(
  workerType: RpaWorkerType,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): RpaTaskRepositoryOptions {
  return createRpaTaskRepositoryOptions(
    parseRpaWorkerConfig(workerType, argv, environment, cwd)
  );
}

export function parseCheckOptions(argv: readonly string[]): CheckOptions {
  const args = new Map<string, string>();
  for (const item of argv) {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }
  const worker = args.get("worker") ?? "diagnosis";
  if (worker !== "diagnosis" && worker !== "monitor") {
    throw new Error("--worker 只能是 diagnosis 或 monitor。 ");
  }
  const limit = Number(args.get("limit") ?? 10);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("--limit 必须是 1 到 1000 的整数。");
  }
  return {
    workerType: worker,
    limit,
    claim: args.get("claim") === "true",
    logDirectory: args.get("log-dir") ?? "rpa-task-logs"
  };
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  checkRpaTasks().catch((error) => {
    rpaConsoleError({
      workerId: "rpa-task-check",
      event: "TASK_CHECK_FAILED",
      errorCode: "DATABASE_ERROR",
      error
    });
    process.exitCode = 1;
  });
}
