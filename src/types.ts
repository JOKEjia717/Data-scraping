/**
 * 项目共享数据模型。这里区分页面抽取阶段的候选数据、清洗后的扁平记录，
 * 以及最终按“问题 → 平台”组织的汇总记录。
 */

/** 命令行与目录使用的稳定平台标识。 */
export type PlatformId = "doubao" | "deepseek" | "qianwen" | "yuanbao";

/** research 保留原爬虫行为；business 原样提问且只允许技术错误重试。 */
export type CollectionMode = "research" | "business";

/** 引用数组为空只有 CONFIRMED_EMPTY 才具有明确业务语义。 */
export type ReferenceExtractionStatus =
  | "EXTRACTED"
  | "CONFIRMED_EMPTY"
  | "UNKNOWN";

/** business 单题发送前的联网搜索执行条件。 */
export type WebSearchPolicy = "REQUIRED" | "PREFERRED" | "DISABLED";

/** 平台不提供深度思考能力时的显式处理策略。 */
export type DeepThinkingUnsupportedPolicy = "allow_degrade" | "fail";

/** 页面上的深度思考控件；supported=false 必须配合显式降级策略使用。 */
export interface DeepThinkingControlConfig {
  supported: boolean;
  selectors: string[];
  /** 控件 class 包含该语义片段时为开启，不包含时为明确关闭。 */
  enabledClassNameFragment?: string;
  /** 页面明确展示“已关闭”模式时使用；仅用于读状态，不会被点击。 */
  disabledStateSelectors?: string[];
  /**
   * 请求关闭时若页面没有可识别控件，是否允许按状态未知降级继续。
   * 仅适用于“关闭”目标；请求开启时仍必须找到并确认控件。
   */
  allowMissingControlWhenDisabled?: boolean;
}

/** business 模式的输入批次；三项身份共同决定对话隔离边界。 */
export interface BusinessBatchInput {
  tenantId: string;
  businessTaskId: string;
  brand: string;
  questions: string[];
}

/** 经过校验、同身份批次合并后的稳定执行单元。 */
export interface CrawlBatch extends BusinessBatchInput {
  key: string;
}

/** 解析完成后的命令行选项。 */
export interface CliOptions {
  mode: CollectionMode;
  cdpEndpoint: string;
  outDir: string;
  platforms: PlatformId[];
  questionFile?: string;
  promptPrefix: string;
  retryOnNoReferences: boolean;
  regenerateOnNoReferences: boolean;
  resolveTitles: boolean;
  timeoutMs: number;
  /** 每题发送前需要确认的深度思考状态；CLI 默认关闭。 */
  deepThinking: boolean;
  deepThinkingUnsupportedPolicy: DeepThinkingUnsupportedPolicy;
  /** 未配置时 research 继续使用历史的宽松尝试行为。 */
  webSearchPolicy?: WebSearchPolicy;
  verbose: boolean;
  databaseEnabled: boolean;
  batchName?: string;
}

/** 单个平台的地址、兼容域名和页面交互选择器。 */
export interface PlatformConfig {
  id: PlatformId;
  name: string;
  url: string;
  hostnames?: string[];
  inputSelectors: string[];
  sendButtonSelectors: string[];
  newConversationButtonSelectors: string[];
  webSearchButtonSelectors: string[];
  /** 联网入口收纳在工具菜单时，先点击这些触发器再定位具体入口。 */
  webSearchMenuTriggerSelectors?: string[];
  /** 页面出现任一可见节点时，表示联网搜索已经明确启用。 */
  webSearchEnabledIndicatorSelectors?: string[];
  /** false 表示平台配置明确声明不提供联网搜索能力。 */
  webSearchSupported: boolean;
  deepThinkingControl: DeepThinkingControlConfig;
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
  /** 实际发送到平台的完整文本；兼容直接调用旧抽取器产生的历史记录。 */
  submittedQuestion?: string;
  crawlPlatform: string;
  rank: number;
  articlePlatform: string;
  articleTime: string;
  title: string;
  summary: string;
  url: string;
  extractedAt: string;
}

/** 单题最终回答记录；generationNumber 从 1 开始，1 表示原始回答。 */
export interface AnswerRecord {
  question: string;
  /** 实际发送到平台的完整文本。 */
  submittedQuestion?: string;
  crawlPlatform: string;
  answer: string;
  generationNumber: number;
  referenceCount: number;
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
