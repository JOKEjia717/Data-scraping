/**
 * 命令行入口：读取运行参数和问题库，并发执行所选平台，并在每题结束后
 * 通过集中写入队列刷新平台文件与跨平台汇总，避免并发覆盖和数据丢失。
 */
import { DEFAULT_QUESTIONS } from "./questions.js";
import { parseCli, readBusinessBatchFile, readQuestionFile } from "./cli.js";
import { createResearchBatch, flattenBatchQuestions } from "./execution.js";
import { PLATFORMS } from "./platforms.js";
import { crawlPlatform } from "./crawler.js";
import { createOutputCoordinator } from "./output.js";
import { closeDatabasePool } from "./database.js";
import {
  createDatabaseRunCoordinator,
  type DatabaseRunFailure
} from "./databasePersistence.js";
import { safeErrorSummary } from "./consolePrivacy.js";
import { isResearchStopRequested } from "./workerControl.js";

async function main(): Promise<void> {
  // 运营台暂停：研究爬取被关闭时，启动即优雅跳过，不占用浏览器资源。
  if (isResearchStopRequested()) {
    console.log("[研究爬取] 运营台已暂停（rpa-runtime/research/stop.request 存在），跳过本次执行。");
    return;
  }
  const options = await parseCli(process.argv.slice(2));
  if (options.mode === "business" && !options.questionFile) {
    throw new Error("business 模式必须通过 --questions 指定品牌批次 JSON 文件。");
  }
  const batches = options.mode === "business"
    ? await readBusinessBatchFile(options.questionFile!)
    : [createResearchBatch(
        options.questionFile
          ? await readQuestionFile(options.questionFile)
          : DEFAULT_QUESTIONS
      )];
  const questions = flattenBatchQuestions(batches);
  const outputCoordinator = createOutputCoordinator(
    options.outDir,
    options.platforms,
    questions
  );
  const databaseCoordinator = options.databaseEnabled
    ? await createDatabaseRunCoordinator({
        questions,
        platforms: options.platforms.map((platformId) => PLATFORMS[platformId]),
        batchName: options.batchName
      })
    : undefined;

  if (databaseCoordinator) {
    console.log(
      `数据库运行已创建：batch_id=${databaseCoordinator.batchId}, ` +
      `run_id=${databaseCoordinator.runId}`
    );
  } else {
    console.log("数据库入库已通过 --database=false 关闭，仅写入 JSON/CSV 文件。");
  }

  console.log(
    `将并发运行 ${options.platforms.length} 个平台：` +
    options.platforms.map((platformId) => PLATFORMS[platformId].name).join("、")
  );

  const platformTasks = options.platforms.map(async (platformId) => {
    try {
      const platformResult = await crawlPlatform(
        PLATFORMS[platformId],
        { ...options, questions, batches },
        {
          async onProgress(partialResult) {
            // 平台抓取互不等待；只有短暂的写盘阶段进入统一队列。
            await outputCoordinator.update(platformId, partialResult);
          },
          async onQuestionStart(questionIndex) {
            await databaseCoordinator?.startQuestion(platformId, questionIndex);
          },
          async onQuestionComplete(questionResult) {
            await databaseCoordinator?.saveQuestion(platformId, questionResult);
          }
        }
      );

      // 问题库为空时不会触发 onProgress；正常任务也在结束时再确认一次最终快照。
      await outputCoordinator.update(platformId, platformResult);
      await databaseCoordinator?.completePlatform(platformId);
      return platformResult;
    } catch (error) {
      if (databaseCoordinator) {
        await databaseCoordinator.failPlatform(platformId, error).catch((databaseError) => {
          console.error(
            `[${PLATFORMS[platformId].name}] 标记数据库失败状态时发生异常：`,
            safeErrorSummary(databaseError)
          );
        });
      }
      throw error;
    }
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
  const databaseFailures: DatabaseRunFailure[] = failures.map(
    ({ platformId, result }) => ({ platformId, error: result.reason })
  );
  await databaseCoordinator?.finalize(databaseFailures);

  if (failures.length > 0) {
    const failureSummary = failures
      .map(({ platformId, result }) =>
        `${PLATFORMS[platformId].name}: ${safeErrorSummary(result.reason)}`
      )
      .join("\n");
    throw new Error(
      `${failures.length} 个平台运行失败，其余平台数据已正常保存：\n${failureSummary}`
    );
  }

  console.log(
    `\n完成。${options.platforms.length} 个平台已并发采集；` +
    `平台数据位于 ${options.outDir}/<平台>/，汇总数据位于 ` +
    `${options.outDir}/references.json 和 ${options.outDir}/references.csv` +
    (databaseCoordinator
      ? `；数据库 run_id=${databaseCoordinator.runId} 已完成入库。`
      : "。")
  );
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(safeErrorSummary(error));
    await closeDatabasePool().catch((closeError) => {
      console.error("关闭数据库连接池失败：", safeErrorSummary(closeError));
    });
    process.exit(1);
  });
