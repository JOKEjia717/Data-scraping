import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { rpaConsoleError, rpaConsoleInfo } from "./consolePrivacy.js";
import { parseRpaWorkerConfig } from "./rpaWorkerConfig.js";
import { readWorkerType } from "./rpaWorkerCli.js";
import {
  platformWorkerLaunchSpecs,
  RpaWorkerFleet
} from "./rpaWorkerFleet.js";

export async function runRpaWorkerFleetCli(argv = process.argv.slice(2)): Promise<void> {
  const { workerType, remainingArgs } = readWorkerType(argv);
  const config = parseRpaWorkerConfig(workerType, remainingArgs);
  if (!config.dryRun) await assertLegacyOutboxEmpty(config.outboxDirectory);
  const specs = platformWorkerLaunchSpecs(workerType, config, remainingArgs);
  const fleet = new RpaWorkerFleet(workerType, config, specs);
  const requestStop = (signal: NodeJS.Signals): void => fleet.requestStop(signal);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    rpaConsoleInfo({
      workerId: config.workerId,
      event: "PLATFORM_FLEET_START",
      batchProgress: `platforms=${specs.map(({ platformId }) => platformId).join(",")}`
    });
    await fleet.run();
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}

export async function assertLegacyOutboxEmpty(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const pending = entries.filter((entry) =>
    entry.isFile() && /^execution-[A-Za-z0-9_-]+\.json$/.test(entry.name)
  );
  if (pending.length > 0) {
    throw new Error(
      `旧版共享 Outbox 仍有 ${pending.length} 个待回放结果；请先用 single Worker 安全回放，再启动四平台独立模式。`
    );
  }
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runRpaWorkerFleetCli().catch((error) => {
    rpaConsoleError({
      workerId: "rpa-worker-fleet",
      event: "FLEET_FATAL",
      errorCode: "TECHNICAL_FAILURE",
      error
    });
    process.exitCode = 1;
  });
}
