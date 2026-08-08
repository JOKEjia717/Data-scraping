/** 灰度前静态门禁；不连接数据库、Chrome 或任何 AI 平台。 */
import { pathToFileURL } from "node:url";
import { parseRpaWorkerConfig } from "./rpaWorkerConfig.js";
import type { RpaWorkerRole } from "./rpaTask.js";
import { safeErrorSummary } from "./consolePrivacy.js";

export interface GrayValidationResult {
  workerType: RpaWorkerRole;
  safe: boolean;
  checks: string[];
}

export function validateGrayConfiguration(
  workerType: RpaWorkerRole,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): GrayValidationResult {
  const config = parseRpaWorkerConfig(workerType, argv, environment, cwd);
  const failures: string[] = [];
  if (config.deploymentEnvironment !== "staging") failures.push("必须使用 staging 环境");
  if (!config.dryRun) failures.push("静态验证必须保持 dry-run=true");
  if (config.maxTasks > 4) failures.push("灰度 maxTasks 不能超过 4");
  if (config.platforms.length > 1) failures.push("首轮灰度只能启用一个平台");
  const hasEntryProjectScope = config.workerRole === "monitor" &&
    config.entryMonitorEnabled &&
    config.entryMonitorScope === "GRAY" &&
    config.entryMonitorGrayProjectIds.length > 0;
  const hasStyleProjectScope = config.workerRole === "style" &&
    config.contentStyleMonitorEnabled &&
    config.contentStyleMonitorScope === "GRAY" &&
    config.contentStyleMonitorGrayProjectIds.length > 0;
  if (
    config.grayBrandIds.length === 0 &&
    config.grayBusinessTaskIds.length === 0 &&
    !hasEntryProjectScope &&
    !hasStyleProjectScope
  ) {
    failures.push("必须配置品牌或业务任务白名单");
  }
  if (!config.providerRoutingEnabled || config.workerProvider !== "NEW_RPA") {
    failures.push("必须启用 NEW_RPA provider 路由隔离");
  }
  return {
    workerType,
    safe: failures.length === 0,
    checks: failures.length === 0 ? [
      "staging", "dry-run", "任务数受限", "单平台", "白名单", "provider 隔离"
    ] : failures
  };
}

function parseCli(argv: readonly string[]): { workerType: RpaWorkerRole; workerArgs: string[] } {
  const workerArg = argv.find((item) => item.startsWith("--worker="));
  const value = workerArg?.split("=")[1];
  if (value !== "diagnosis" && value !== "monitor" && value !== "style") {
    throw new Error("--worker 只能是 diagnosis、monitor 或 style。");
  }
  return { workerType: value, workerArgs: argv.filter((item) => item !== workerArg) };
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const { workerType, workerArgs } = parseCli(process.argv.slice(2));
    const result = validateGrayConfiguration(workerType, workerArgs);
    console.log(JSON.stringify(result));
    if (!result.safe) process.exitCode = 1;
  } catch (error) {
    console.error(safeErrorSummary(error));
    process.exitCode = 1;
  }
}
