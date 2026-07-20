/**
 * 命令行入口：读取运行参数和问题库，按顺序执行所选平台，并在每题结束后
 * 同步刷新平台独立文件与跨平台汇总文件，尽量保留任务中断前的有效数据。
 */
import { DEFAULT_QUESTIONS } from "./questions.js";
import { parseCli, readQuestionFile } from "./cli.js";
import { PLATFORMS } from "./platforms.js";
import { crawlPlatform } from "./crawler.js";
import { writeOutputs, writePlatformOutputs } from "./output.js";
import type { ReferenceRecord } from "./types.js";

async function main(): Promise<void> {
  const options = await parseCli(process.argv.slice(2));
  const questions = options.questionFile ? await readQuestionFile(options.questionFile) : DEFAULT_QUESTIONS;
  const allRecords: ReferenceRecord[] = [];

  // 平台串行运行，避免四个动态页面同时生成回答而争抢浏览器和网络资源。
  for (const platformId of options.platforms) {
    const platformRecords = await crawlPlatform(
      PLATFORMS[platformId],
      { ...options, questions },
      async (partialRecords) => {
        // onProgress 在每道题完成后触发；此时立即落盘，异常退出时也能保留进度。
        await writePlatformOutputs(options.outDir, platformId, partialRecords);
        await writeOutputs(options.outDir, [...allRecords, ...partialRecords], questions);
      }
    );

    allRecords.push(...platformRecords);
    await writePlatformOutputs(options.outDir, platformId, platformRecords);
    await writeOutputs(options.outDir, allRecords, questions);
  }

  console.log(`\n完成。各平台数据已分别写入 ${options.outDir}/<平台>/，汇总数据位于 ${options.outDir}/references.json 和 ${options.outDir}/references.csv`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
