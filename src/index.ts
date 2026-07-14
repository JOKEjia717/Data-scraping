import { DEFAULT_QUESTIONS } from "./questions.js";
import { parseCli, readQuestionFile } from "./cli.js";
import { PLATFORMS } from "./platforms.js";
import { crawlPlatform } from "./crawler.js";
import { writeOutputs } from "./output.js";
import type { ReferenceRecord } from "./types.js";

async function main(): Promise<void> {
  const options = await parseCli(process.argv.slice(2));
  const questions = options.questionFile ? await readQuestionFile(options.questionFile) : DEFAULT_QUESTIONS;
  const allRecords: ReferenceRecord[] = [];

  for (const platformId of options.platforms) {
    const platformRecords = await crawlPlatform(
      PLATFORMS[platformId],
      { ...options, questions },
      async (partialRecords) => {
        const others = allRecords.filter((record) => record.crawlPlatform !== PLATFORMS[platformId].name);
        await writeOutputs(options.outDir, [...others, ...partialRecords]);
      }
    );

    allRecords.push(...platformRecords);
    await writeOutputs(options.outDir, allRecords);
  }

  console.log(`\n完成。结果已写入 ${options.outDir}/references.json 和 ${options.outDir}/references.csv`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
