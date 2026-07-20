/**
 * 项目共享数据模型。这里区分页面抽取阶段的候选数据、清洗后的扁平记录，
 * 以及最终按“问题 → 平台”组织的汇总记录。
 */

/** 命令行与目录使用的稳定平台标识。 */
export type PlatformId = "doubao" | "deepseek" | "qianwen" | "yuanbao";

/** 解析完成后的命令行选项。 */
export interface CliOptions {
  cdpEndpoint: string;
  outDir: string;
  platforms: PlatformId[];
  questionFile?: string;
  promptPrefix: string;
  resolveTitles: boolean;
  timeoutMs: number;
}

/** 单个平台的地址、兼容域名和页面交互选择器。 */
export interface PlatformConfig {
  id: PlatformId;
  name: string;
  url: string;
  hostnames?: string[];
  inputSelectors: string[];
  sendButtonSelectors: string[];
  webSearchButtonSelectors: string[];
  referenceRevealSelectors: string[];
}

/** 通用整页链接扫描产生的原始 DOM 候选；仅用于兼容性兜底流程。 */
export interface RawReferenceCandidate {
  domIndex: number;
  score: number;
  href: string;
  anchorText: string;
  cardTitle: string;
  contextText: string;
  titleAttr: string;
  ariaLabel: string;
}

/** 平台结构化解析脚本返回的中间候选，尚未完成 URL 清洗和内部链接过滤。 */
export interface SearchResultCandidate {
  score: number;
  href: string;
  platform: string;
  articleTime: string;
  title: string;
  summary?: string;
  referenceNumber?: number;
  contextText: string;
}

/** 平台独立 JSON/CSV 与汇总 CSV 使用的标准扁平记录。 */
export interface ReferenceRecord {
  question: string;
  crawlPlatform: string;
  rank: number;
  articlePlatform: string;
  articleTime: string;
  title: string;
  summary: string;
  url: string;
  extractedAt: string;
}

/** 汇总 JSON 中固定展示的平台名称。 */
export type CrawlPlatformName = "豆包" | "DeepSeek" | "千问" | "元宝";

/** 平台已处于某个问题节点下，因此移除重复的 question 字段。 */
export type GroupedReferenceRecord = Omit<ReferenceRecord, "question">;

/** 根目录 references.json 的单个问题节点。 */
export interface GroupedQuestionReferences {
  question: string;
  platforms: Record<CrawlPlatformName, GroupedReferenceRecord[]>;
}
