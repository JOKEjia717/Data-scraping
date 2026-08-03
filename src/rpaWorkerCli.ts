import { pathToFileURL } from "node:url";
import { closeRpaDatabasePool } from "./rpaDatabase.js";
import { parseRpaWorkerConfig } from "./rpaWorkerConfig.js";
import { RpaWorkerService } from "./rpaWorkerService.js";
import type { RpaWorkerType } from "./rpaTask.js";
import type { PlatformId } from "./types.js";
import {
  rpaConsoleError,
  rpaConsoleInfo
} from "./consolePrivacy.js";

export async function runRpaWorkerCli(argv = process.argv.slice(2)): Promise<void> {
  const { workerType, remainingArgs } = readWorkerType(argv);
  const config = parseRpaWorkerConfig(workerType, remainingArgs);
  const service = new RpaWorkerService(config);
  const requestStop = (signal: NodeJS.Signals): void => {
    service.requestStop(signal);
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    rpaConsoleInfo({
      workerId: config.workerId,
      event: "WORKER_START",
      batchProgress:
        `dryRun=${config.dryRun},runOnce=${config.runOnce},maxTasks=${config.maxTasks},maxAttempts=${config.maxAttempts}`
    });
    for (const platformId of config.platforms) {
      rpaConsoleInfo({ workerId: config.workerId, event: "PLATFORM_ENABLED", platformId });
    }
    const summary = await service.run();
    rpaConsoleInfo({
      workerId: config.workerId,
      event: "WORKER_SUMMARY",
      batchProgress:
        `batches=${summary.lastRun?.selectedBatchCount ?? 0},selected=${summary.lastRun?.selectedTaskCount ?? 0},completed=${summary.lastRun?.completedTaskCount ?? 0},failed=${summary.lastRun?.failedTaskCount ?? 0},cycles=${summary.cycleCount}`
    });
    for (const [platformId, errorCode] of Object.entries(
      summary.lastRun?.pausedPlatforms ?? {}
    )) {
      rpaConsoleInfo({
        workerId: config.workerId,
        event: "PLATFORM_PAUSED",
        platformId: platformId as PlatformId,
        errorCode
      });
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    await closeRpaDatabasePool();
  }
}

export function readWorkerType(argv: readonly string[]): {
  workerType: RpaWorkerType;
  remainingArgs: string[];
} {
  const workerArgument = argv.find((item) => item.startsWith("--worker="));
  const worker = workerArgument?.slice("--worker=".length);
  if (worker !== "diagnosis" && worker !== "monitor") {
    throw new Error("必须通过 --worker=diagnosis 或 --worker=monitor 指定 Worker。");
  }
  return {
    workerType: worker,
    remainingArgs: argv.filter((item) => item !== workerArgument)
  };
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runRpaWorkerCli().catch(async (error) => {
    rpaConsoleError({
      workerId: "rpa-worker-cli",
      event: "WORKER_FATAL",
      errorCode: "TECHNICAL_FAILURE",
      error
    });
    await closeRpaDatabasePool().catch(() => undefined);
    process.exitCode = 1;
  });
}
