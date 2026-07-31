/**
 * 命令行入口：读取运行参数和问题库，并发执行所选平台，并在每题结束后
 * 通过集中写入队列刷新平台文件与跨平台汇总，避免并发覆盖和数据丢失。
 */
import { DEFAULT_QUESTIONS } from "./questions.js";
import { parseCli, readQuestionFile } from "./cli.js";
import { PLATFORMS } from "./platforms.js";
import { crawlPlatform } from "./crawler.js";
import { createOutputCoordinator } from "./output.js";

async function main(): Promise<void> {
  const options = await parseCli(process.argv.slice(2));
  const questions = options.questionFile ? await readQuestionFile(options.questionFile) : DEFAULT_QUESTIONS;
  const outputCoordinator = createOutputCoordinator(
    options.outDir,
    options.platforms,
    questions
  );

  console.log(
    `将并发运行 ${options.platforms.length} 个平台：` +
    options.platforms.map((platformId) => PLATFORMS[platformId].name).join("、")
  );

  const platformTasks = options.platforms.map(async (platformId) => {
    const platformResult = await crawlPlatform(
      PLATFORMS[platformId],
      { ...options, questions },
      async (partialResult) => {
        // 平台抓取互不等待；只有短暂的写盘阶段进入统一队列。
        await outputCoordinator.update(platformId, partialResult);
      }
    );

    // 问题库为空时不会触发 onProgress；正常任务也在结束时再确认一次最终快照。
    await outputCoordinator.update(platformId, platformResult);
    return platformResult;
  });

  // 某个平台失败后继续等待其他平台完成，已成功的平台仍会持续保存数据。
  const settledResults = await Promise.allSettled(platformTasks);
  await outputCoordinator.flush();
  const failures = settledResults
    .map((result, index) => ({ result, platformId: options.platforms[index] }))
    .filter((item): item is {
      result: PromiseRejectedResult;
      platformId: (typeof options.platforms)[number];
    } => item.result.status === "rejected");

  if (failures.length > 0) {
    const failureSummary = failures
      .map(({ platformId, result }) => {
        const reason = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        return `${PLATFORMS[platformId].name}: ${reason}`;
      })
      .join("\n");
    throw new Error(
      `${failures.length} 个平台运行失败，其余平台数据已正常保存：\n${failureSummary}`
    );
  }

  console.log(
    `\n完成。${options.platforms.length} 个平台已并发采集；` +
    `平台数据位于 ${options.outDir}/<平台>/，汇总数据位于 ` +
    `${options.outDir}/references.json 和 ${options.outDir}/references.csv`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
