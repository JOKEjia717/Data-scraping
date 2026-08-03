/**
 * 输出与汇总清洗模块。
 *
 * 平台子目录继续保存扁平记录；根目录 JSON 严格执行三阶段清洗：先按平台
 * 分桶，再在平台内按问题分组，最后将四个平台的同题数据合并为一个节点。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnswerRecord,
  CrawlPlatformName,
  GroupedQuestionReferences,
  GroupedReferenceRecord,
  PlatformId,
  ReferenceRecord
} from "./types.js";

const CRAWL_PLATFORM_NAMES: CrawlPlatformName[] = ["豆包", "DeepSeek", "千问", "元宝"];

type PlatformRecordGroups = Record<CrawlPlatformName, ReferenceRecord[]>;
type PlatformQuestionGroups = Record<
  CrawlPlatformName,
  Map<string, GroupedReferenceRecord[]>
>;

/** 并发抓取过程中，一个平台已经完成并可安全落盘的数据快照。 */
export interface PlatformOutputSnapshot {
  references: ReferenceRecord[];
  answers: AnswerRecord[];
}

/**
 * 创建集中输出协调器。抓取任务可以并发更新各自快照，但所有文件写入会进入
 * 同一条 Promise 队列；每次写根目录汇总前，先写完当前全部平台子目录。
 */
export function createOutputCoordinator(
  outDir: string,
  platformIds: readonly PlatformId[],
  questions: readonly string[]
): {
  update: (platformId: PlatformId, snapshot: PlatformOutputSnapshot) => Promise<void>;
  flush: () => Promise<void>;
} {
  const orderedPlatformIds = [...new Set(platformIds)];
  const snapshots = new Map<PlatformId, PlatformOutputSnapshot>();
  let writeQueue = Promise.resolve();

  const writeCurrentSnapshots = async (): Promise<void> => {
    // 在本次队列任务开始时冻结视图，保证平台文件与根目录汇总使用同一批数据。
    const currentSnapshots = orderedPlatformIds
      .map((platformId) => {
        const snapshot = snapshots.get(platformId);
        return snapshot ? { platformId, snapshot } : null;
      })
      .filter((item): item is {
        platformId: PlatformId;
        snapshot: PlatformOutputSnapshot;
      } => item !== null);

    for (const { platformId, snapshot } of currentSnapshots) {
      await writePlatformOutputs(
        outDir,
        platformId,
        snapshot.references,
        snapshot.answers
      );
    }

    const allReferences = currentSnapshots.flatMap(
      ({ snapshot }) => snapshot.references
    );
    await writeOutputs(outDir, allReferences, questions);
  };

  return {
    update(platformId, snapshot) {
      // crawlPlatform 内部会继续复用并追加原数组，因此必须保存独立快照。
      snapshots.set(platformId, {
        references: snapshot.references.map((record) => ({ ...record })),
        answers: snapshot.answers.map((answer) => ({ ...answer }))
      });

      const pendingWrite = writeQueue.then(writeCurrentSnapshots);
      // 单次写入失败要返回给对应平台，但不能永久阻塞其他平台后续写入。
      writeQueue = pendingWrite.catch(() => undefined);
      return pendingWrite;
    },
    flush() {
      return writeQueue;
    }
  };
}

/** 写入按问题分组的汇总 JSON，以及仍保持扁平结构的汇总 CSV。 */
export async function writeOutputs(
  outDir: string,
  records: ReferenceRecord[],
  questions: readonly string[] = []
): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "references.json");
  const csvPath = path.join(outDir, "references.csv");

  const groupedRecords = groupRecordsByQuestion(records, questions);
  await writeFileAtomic(jsonPath, `${JSON.stringify(groupedRecords, null, 2)}\n`);
  await writeFileAtomic(csvPath, toCsv(records));
}

/** 写入单个平台的原始扁平 JSON/CSV，不套用跨平台问题分组。 */
export async function writePlatformOutputs(
  outDir: string,
  platformId: PlatformId,
  records: ReferenceRecord[],
  answers: AnswerRecord[] = []
): Promise<void> {
  const platformDir = path.join(outDir, platformId);
  await writeFlatOutputs(platformDir, records);
  await writeAnswerOutputs(platformDir, answers);
}

/**
 * 执行完整汇总管线。questions 中的顺序优先；数据里出现的额外问题会追加在末尾。
 * 即使某个平台没有该问题的记录，最终结构仍保留该平台并返回空数组。
 */
export function groupRecordsByQuestion(
  records: ReferenceRecord[],
  questions: readonly string[] = []
): GroupedQuestionReferences[] {
  // 阶段一：保持原记录结构，放进对应平台的数据组。
  const recordsByPlatform = groupRecordsByPlatform(records);
  // 阶段二：在每个平台内部按 question 建立索引，并移除子记录的重复 question。
  const questionsByPlatform = groupPlatformRecordsByQuestion(recordsByPlatform);
  const orderedQuestions = new Set(questions);

  for (const platformName of CRAWL_PLATFORM_NAMES) {
    for (const question of questionsByPlatform[platformName].keys()) {
      orderedQuestions.add(question);
    }
  }

  // 阶段三：遍历问题，把四个平台中相同问题的数组合并到同一个问题节点。
  return [...orderedQuestions].map((question) => ({
    question,
    platforms: {
      豆包: questionsByPlatform.豆包.get(question) ?? [],
      DeepSeek: questionsByPlatform.DeepSeek.get(question) ?? [],
      千问: questionsByPlatform.千问.get(question) ?? [],
      元宝: questionsByPlatform.元宝.get(question) ?? []
    }
  }));
}

/** 第一阶段清洗：按 crawlPlatform 分桶，记录字段保持原样。 */
export function groupRecordsByPlatform(records: ReferenceRecord[]): PlatformRecordGroups {
  const groups = createEmptyPlatformRecordGroups();

  for (const record of records) {
    const platformName = requirePlatformName(record.crawlPlatform);
    groups[platformName].push(record);
  }

  return groups;
}

/** 第二阶段清洗：每个平台内按问题分组，为最终跨平台合并建立索引。 */
export function groupPlatformRecordsByQuestion(
  recordsByPlatform: PlatformRecordGroups
): PlatformQuestionGroups {
  const groups = createEmptyPlatformQuestionGroups();

  for (const platformName of CRAWL_PLATFORM_NAMES) {
    for (const record of recordsByPlatform[platformName]) {
      const { question, ...groupedRecord } = record;
      const questionRecords = groups[platformName].get(question) ?? [];
      questionRecords.push(groupedRecord);
      groups[platformName].set(question, questionRecords);
    }
  }

  return groups;
}

/** 单平台文件使用的扁平写入器。 */
async function writeFlatOutputs(outDir: string, records: ReferenceRecord[]): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await writeFileAtomic(
    path.join(outDir, "references.json"),
    `${JSON.stringify(records, null, 2)}\n`
  );
  await writeFileAtomic(path.join(outDir, "references.csv"), toCsv(records));
}

/** 各平台最终回答使用独立文件，避免在每条参考文献记录中重复存储长正文。 */
async function writeAnswerOutputs(outDir: string, answers: AnswerRecord[]): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await writeFileAtomic(
    path.join(outDir, "answers.json"),
    `${JSON.stringify(answers, null, 2)}\n`
  );
  await writeFileAtomic(path.join(outDir, "answers.csv"), answersToCsv(answers));
}

/** 创建包含四个平台键的空扁平分桶，保证后续访问不需要判空。 */
function createEmptyPlatformRecordGroups(): PlatformRecordGroups {
  return {
    豆包: [],
    DeepSeek: [],
    千问: [],
    元宝: []
  };
}

/** 创建四个平台各自的问题索引。Map 保留问题首次出现顺序。 */
function createEmptyPlatformQuestionGroups(): PlatformQuestionGroups {
  return {
    豆包: new Map(),
    DeepSeek: new Map(),
    千问: new Map(),
    元宝: new Map()
  };
}

/** 将运行时字符串收窄为固定平台名称，并尽早暴露异常数据。 */
function requirePlatformName(value: string): CrawlPlatformName {
  const platformName = value as CrawlPlatformName;
  if (!CRAWL_PLATFORM_NAMES.includes(platformName)) {
    throw new Error(`未知抓取平台：${value}`);
  }
  return platformName;
}

/** 将标准扁平记录序列化为固定列顺序的 CSV。 */
function toCsv(records: ReferenceRecord[]): string {
  const headers: Array<keyof ReferenceRecord> = [
    "question",
    "submittedQuestion",
    "crawlPlatform",
    "rank",
    "articlePlatform",
    "articleTime",
    "title",
    "summary",
    "url",
    "extractedAt"
  ];

  const rows = records.map((record) => headers.map((header) => escapeCsv(String(record[header] ?? ""))).join(","));
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

/** 将最终回答序列化为固定列顺序的 CSV，正文中的换行由 RFC 4180 引号保护。 */
export function answersToCsv(answers: AnswerRecord[]): string {
  const headers: Array<keyof AnswerRecord> = [
    "question",
    "submittedQuestion",
    "crawlPlatform",
    "answer",
    "generationNumber",
    "referenceCount",
    "extractedAt"
  ];

  const rows = answers.map((record) =>
    headers.map((header) => escapeCsv(String(record[header] ?? ""))).join(",")
  );
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

/** 按 RFC 4180 的常用规则转义逗号、双引号和换行。 */
function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

let atomicWriteSequence = 0;

/**
 * 先在目标目录写入临时文件，再通过 rename 一次替换正式文件。程序被中断时，
 * 读取方只会看到旧的完整文件或新的完整文件，不会读到半段 JSON/CSV。
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.${atomicWriteSequence += 1}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
