/**
 * 浏览器编排模块：连接已登录的 Chrome 标签页，逐题发送、判断回答生命周期、
 * 展开本题引用并调用平台解析器。这里负责时序和失败保护，不负责具体卡片字段解析。
 */
import { chromium, type Locator, type Page } from "playwright";
import {
  clickLatestQianwenRegenerate,
  countDeepSeekReferenceContainers,
  countDoubaoSearchResultBlocks,
  countQianwenReferenceTriggers,
  countReferenceRevealButtons,
  extractLatestPlatformAnswer,
  extractReferences,
  hasCurrentDoubaoReferenceEntry,
  markDoubaoSearchResultBaseline,
  markYuanbaoReferenceTriggerBaseline,
  revealLatestDeepSeekReferenceList,
  revealLatestDoubaoReferenceList,
  revealLatestQianwenReferenceList,
  revealLatestYuanbaoReferenceList,
  revealReferencePanels,
  snapshotDocumentBottom,
  waitForDeepSeekReferenceListStable,
  waitForDoubaoReferenceListStable,
  waitForQianwenReferenceListStable,
  waitForYuanbaoReferenceListStable
} from "./extractReferences.js";
import { resolveRecordTitles } from "./resolveTitles.js";
import { ensureDeepThinkingState } from "./deepThinking.js";
import {
  activateWebSearch,
  assertVerifiedWebSearchForZeroReferences,
  enforceWebSearchPolicy,
  type WebSearchActivationResult
} from "./webSearch.js";
import {
  attachConsoleSecrets,
  privacyDebugLog,
  runWithConsolePrivacy
} from "./consolePrivacy.js";
import {
  createPageConversationManager,
  type ConversationBatchContext
} from "./conversationManager.js";
export { openNewConversation } from "./conversationManager.js";
import {
  buildSubmittedQuestion,
  getNoReferencesStatus,
  planBatchQuestions
} from "./execution.js";
import type {
  AnswerRecord,
  CollectionMode,
  CrawlBatch,
  DeepThinkingUnsupportedPolicy,
  PlatformConfig,
  ReferenceExtractionStatus,
  ReferenceRecord,
  WebSearchPolicy
} from "./types.js";

export interface CrawlPlatformOptions {
  mode: CollectionMode;
  cdpEndpoint: string;
  questions: string[];
  batches: CrawlBatch[];
  promptPrefix: string;
  retryOnNoReferences: boolean;
  regenerateOnNoReferences: boolean;
  resolveTitles: boolean;
  timeoutMs: number;
  /** 未配置时不读取或修改页面深度思考状态，保持 research 历史行为。 */
  deepThinking?: boolean;
  deepThinkingUnsupportedPolicy?: DeepThinkingUnsupportedPolicy;
  webSearchPolicy?: WebSearchPolicy;
  verbose?: boolean;
}

export interface CrawlPlatformResult {
  references: ReferenceRecord[];
  answers: AnswerRecord[];
}

export type CrawlQuestionStatus = "completed" | "no_references" | "skipped";

/** 单题完成事件用于数据库精确定位“问题 × 平台”任务，不依赖问题文本唯一。 */
export interface CrawlQuestionResult {
  questionIndex: number;
  question: string;
  status: CrawlQuestionStatus;
  attemptCount: number;
  answer?: AnswerRecord;
  references: ReferenceRecord[];
  referenceStatus: ReferenceExtractionStatus;
  errorMessage?: string;
  submittedQuestion?: string;
}

export type ExecuteQuestionStatus = "success" | "no_references" | "skipped";

/** 独立单题调用使用 success；批量层会将其映射为原有 completed 状态。 */
export interface ExecuteQuestionResult
  extends Omit<CrawlQuestionResult, "status" | "submittedQuestion"> {
  status: ExecuteQuestionStatus;
  submittedQuestion: string;
  requestedDeepThinking: boolean | null;
  actualDeepThinking: boolean | null;
  webSearchRequested: boolean;
  webSearchEnabled: boolean;
  webSearchVerified: boolean;
  webSearchFailureReason: string | null;
}

/** executeQuestion 的不可变单题输入；索引只用于把结果映射回上层任务。 */
export interface ExecuteQuestionTask {
  questionIndex: number;
  question: string;
}

/**
 * 单题执行所需的页面与策略。调用方负责提供已经存在且属于正确批次的对话；
 * 此运行时不包含对话创建、结果持久化或下一题调度能力。
 */
export interface ExecuteQuestionRuntime {
  page: Page;
  config: PlatformConfig;
  mode: CollectionMode;
  promptPrefix: string;
  retryOnNoReferences: boolean;
  regenerateOnNoReferences: boolean;
  resolveTitles: boolean;
  timeoutMs: number;
  /** undefined 表示保持页面现状；正式 business Worker 必须传入任务原值。 */
  deepThinking?: boolean;
  deepThinkingUnsupportedPolicy?: DeepThinkingUnsupportedPolicy;
  onDeepThinkingStateResolved?: (
    requested: boolean,
    actual: boolean | null
  ) => void;
  webSearchPolicy?: WebSearchPolicy;
  onWebSearchStateResolved?: (result: WebSearchActivationResult) => void;
  verbose?: boolean;
  /** 正式 Worker 用于区分可安全释放与发送后不确定；普通 CLI 可不提供。 */
  onSubmissionStateChange?: (
    state: "submitted" | "uncertain",
    submittedQuestion: string
  ) => void;
}

export interface CurrentQuestionAnswerInspection {
  status: "answered" | "uncertain";
  answerContent?: string;
  reason: string;
}

export interface RecoveredSubmittedQuestionResult {
  answerContent: string;
  references: ReferenceRecord[];
  referenceStatus: ReferenceExtractionStatus;
  reason: string;
}

/** 抓取生命周期钩子：文件快照与数据库写入可以独立订阅同一轮进度。 */
export interface CrawlPlatformHooks {
  onProgress?: (result: CrawlPlatformResult) => Promise<void>;
  onQuestionStart?: (questionIndex: number, question: string) => Promise<void>;
  onQuestionComplete?: (result: CrawlQuestionResult) => Promise<void>;
}

/** 提问前的页面快照，用于区分历史内容与本题新增回答。 */
interface TrackedAnswerBaseline {
  bodyText: string;
  documentBottom: number;
  referenceCount: number;
  referenceMarker?: string;
}

/** 千问回答正文进入重复循环时使用的可恢复错误；外层只跳过当前题。 */
class QianwenAnswerLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QianwenAnswerLoopError";
  }
}

const REFERENCE_CHECK_ATTEMPTS = 3;
const TECHNICAL_RETRY_ATTEMPTS = 3;
const DOUBAO_RESUBMISSION_ATTEMPTS = 3;
const REFERENCE_REVEAL_TIMEOUT_MS = 10_000;
const REFERENCE_STABLE_TIMEOUT_MS = 5_000;
const DOUBAO_REFERENCE_REVEAL_TIMEOUT_MS = 30_000;
const DOUBAO_REFERENCE_STABLE_TIMEOUT_MS = 15_000;
const DOUBAO_REFERENCE_READY_STABLE_MS = 4_000;
const REFERENCE_CHECK_INTERVAL_MS = 1_500;
// 保留原调试调用点，但统一由 AsyncLocalStorage 决定 research 输出或 business 抑制。
const console = { log: privacyDebugLog };

/**
 * 抓取单个平台的全部批次。research 保留原整轮会话和引用恢复策略；business
 * 严格按“租户 + 业务任务 + 品牌”隔离对话，批内问题连续执行。
 */
export async function crawlPlatform(
  config: PlatformConfig,
  options: CrawlPlatformOptions,
  hooks: CrawlPlatformHooks = {}
): Promise<CrawlPlatformResult> {
  return runWithConsolePrivacy({
    mode: options.mode,
    verbose: options.mode === "research" && (options.verbose ?? true)
  }, async () => {
  const browser = await chromium.connectOverCDP(options.cdpEndpoint, { noDefaults: true });
  const page = findExistingPage(browser.contexts().flatMap((context) => context.pages()), config);
  if (!page) {
    throw new Error(
      `没有找到已打开的 ${config.name} 标签页。请先在已开启远程调试端口的浏览器里打开 ${config.url}`
    );
  }
  await ensureReadyForInput(page, config);
  const conversationManager = createPageConversationManager(page, config);
  const records: ReferenceRecord[] = [];
  const answers: AnswerRecord[] = [];
  const executionQuestions = planBatchQuestions(options.batches);

  for (const [index, executionQuestion] of executionQuestions.entries()) {
    const {
      batch,
      batchIndex,
      batchQuestionIndex,
      question,
      startsNewConversation
    } = executionQuestion;
    const conversationContext: ConversationBatchContext = {
      batchId: batch.key,
      tenantId: batch.tenantId,
      brandId: batch.brand,
      businessTaskId: batch.businessTaskId,
      businessGroupId: batch.businessTaskId,
      platformId: config.id
    };
    if (options.mode === "business" && startsNewConversation) {
      const previousQuestion = executionQuestions[index - 1]?.question ?? "";
      console.log(
        `\n[${config.name}] 开始品牌批次 ${batchIndex + 1}/${options.batches.length}：` +
        `tenant=${batch.tenantId}, task=${batch.businessTaskId}, brand=${batch.brand}`
      );
      await retryTechnicalFailure(
        options.mode,
        `${config.name} 创建品牌批次独立新对话`,
        () => conversationManager.startBatch(conversationContext, previousQuestion)
      );
    }
    if (options.mode === "business") {
      await retryTechnicalFailure(
        options.mode,
        `${config.name} 获取品牌批次会话`,
        () => conversationManager.acquireForQuestion(
          conversationContext,
          executionQuestions[index - 1]?.question ?? ""
        )
      );
    }
    console.log(`\n[${config.name}] ${index + 1}/${executionQuestions.length} ${question}`);
    await hooks.onQuestionStart?.(index, question);
    let executionResult: ExecuteQuestionResult;
    try {
      executionResult = await executeQuestion(
        { questionIndex: index, question },
        {
          page,
          config,
          mode: options.mode,
          promptPrefix: options.promptPrefix,
          retryOnNoReferences: options.retryOnNoReferences,
          regenerateOnNoReferences: options.regenerateOnNoReferences,
          resolveTitles: options.resolveTitles,
          timeoutMs: options.timeoutMs,
          deepThinking: options.deepThinking,
          deepThinkingUnsupportedPolicy: options.deepThinkingUnsupportedPolicy,
          webSearchPolicy: options.webSearchPolicy
        }
      );
    } catch (error) {
      if (options.mode === "business" && conversationManager.currentState) {
        conversationManager.markDamaged(error);
      }
      throw error;
    }
    if (options.mode === "business") conversationManager.recordQuestion(question);
    const questionResult: CrawlQuestionResult = {
      ...executionResult,
      status: executionResult.status === "success"
        ? "completed"
        : executionResult.status
    };

    records.push(...questionResult.references);
    if (questionResult.answer) answers.push(questionResult.answer);
    // 单题函数只返回数据；批量层负责累计快照并通知文件/数据库订阅者。
    await hooks.onProgress?.({ references: records, answers });
    await hooks.onQuestionComplete?.(questionResult);
    if (
      options.mode === "business" &&
      batchQuestionIndex === batch.questions.length - 1
    ) {
      conversationManager.finishBatch(batch.key);
    }
  }

  if (executionQuestions.length > 0) {
    const opened = await conversationManager.resetToBlank(
      executionQuestions[executionQuestions.length - 1].question
    );
    console.log(
      opened
        ? `[${config.name}] 本轮问题已完成，已自动创建新对话。`
        : `[${config.name}] 本轮问题已完成，但没有找到可用的新对话入口；数据已正常保存。`
    );
  }

  return { references: records, answers };
  });
}

/**
 * 在调用方提供的当前页面和当前对话中完成一道题。该函数不创建对话、不调度
 * 下一题，也不调用输出或数据库钩子；所有平台专属基线与恢复策略保持在本模块内。
 */
export async function executeQuestion(
  task: ExecuteQuestionTask,
  runtime: ExecuteQuestionRuntime
): Promise<ExecuteQuestionResult> {
  return runWithConsolePrivacy({
    mode: runtime.mode,
    verbose: runtime.mode === "research" && (runtime.verbose ?? true)
  }, async () => {
  try {
  const { questionIndex, question } = task;
  const {
    page,
    config,
    mode,
    promptPrefix,
    retryOnNoReferences,
    regenerateOnNoReferences,
    resolveTitles,
    timeoutMs,
    deepThinking,
    deepThinkingUnsupportedPolicy = "fail",
    webSearchPolicy = "PREFERRED"
  } = runtime;

  const requestedDeepThinking = deepThinking ?? null;
  let actualDeepThinking: boolean | null = null;

  // 元宝引用抽屉会遮挡页面并污染本题基线，因此单题开始和提取结束时主动关闭。
  if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
  await retryTechnicalFailure(
    mode,
    `${config.name} 等待输入框恢复`,
    () => waitForReadyToSend(page, config, timeoutMs)
  );
  if (deepThinking !== undefined) {
    let resolution;
    try {
      resolution = await ensureDeepThinkingState(
        page,
        config,
        deepThinking,
        deepThinkingUnsupportedPolicy
      );
    } catch (error) {
      runtime.onDeepThinkingStateResolved?.(deepThinking, null);
      throw error;
    }
    actualDeepThinking = resolution.actual;
    runtime.onDeepThinkingStateResolved?.(deepThinking, actualDeepThinking);
    console.log(
      `[${config.name}] 深度思考：requested=${deepThinking}, ` +
      `actual=${actualDeepThinking === null ? "unsupported" : actualDeepThinking}` +
      (resolution.changed ? "（已切换）" : resolution.degraded ? "（已按配置降级）" : "（无需切换）")
    );
  }
  const webSearch = await activateWebSearch(page, config, webSearchPolicy);
  runtime.onWebSearchStateResolved?.(webSearch);
  console.log(
    `[${config.name}] 联网搜索：policy=${webSearchPolicy}, requested=${webSearch.requested}, ` +
    `supported=${webSearch.supported}, enabled=${webSearch.enabled}, verified=${webSearch.verified}` +
    (webSearch.failureReason ? `（${webSearch.failureReason}）` : "")
  );
  enforceWebSearchPolicy(webSearchPolicy, webSearch);
  const webSearchResultFields = {
    webSearchRequested: webSearch.requested,
    webSearchEnabled: webSearch.enabled,
    webSearchVerified: webSearch.verified,
    webSearchFailureReason: webSearch.failureReason
  };

  // 所有基线必须在发送问题前采集，之后只接受相对基线新增的回答和引用入口。
  const baselineBottom = await snapshotDocumentBottom(page);
  const baselineDoubaoSearchBlockCount = config.id === "doubao"
    ? await countDoubaoSearchResultBlocks(page)
    : 0;
  const baselineRevealButtonCount = await countReferenceRevealButtons(
    page,
    config.referenceRevealSelectors
  );
  const submittedQuestion = buildSubmittedQuestion(mode, promptPrefix, question);
  const trackedBaseline = await snapshotTrackedAnswerBaseline(page, config.id);
  // 豆包长会话会同时回收问题气泡和历史搜索块，因此在真正发送前保存现存
  // 搜索块的元素身份；后续可识别数量减少或索引前移后的本题新入口。
  if (config.id === "doubao") await markDoubaoSearchResultBaseline(page);
  console.log(`[${config.name}] 实际发送问题：${JSON.stringify(submittedQuestion)}`);
  try {
    await submitQuestion(page, config, submittedQuestion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/没有在.+页面找到聊天输入框|input.*not found/i.test(message)) {
      runtime.onSubmissionStateChange?.("uncertain", submittedQuestion);
    }
    throw error;
  }
  runtime.onSubmissionStateChange?.("submitted", submittedQuestion);

  try {
    await retryTechnicalFailure(
      mode,
      `${config.name} 等待回答完成`,
      () => waitForAnswerComplete(
        page,
        config,
        timeoutMs,
        trackedBaseline,
        submittedQuestion
      )
    );
  } catch (error) {
    if (
      mode === "research" &&
      config.id === "qianwen" &&
      error instanceof QianwenAnswerLoopError
    ) {
      console.log(`[千问] 跳过本题：${error.message}`);
      return {
        questionIndex,
        question,
        status: "skipped",
        attemptCount: 1,
        references: [],
        referenceStatus: "UNKNOWN",
        errorMessage: error.message,
        submittedQuestion,
        requestedDeepThinking,
        actualDeepThinking,
        ...webSearchResultFields
      };
    }
    throw error;
  }
  await scrollToBottom(page);

  let finalAnswer = "";
  let finalGeneration = 1;
  let finalAnswerExtractedAt = new Date().toISOString();
  const captureAnswer = async (generationNumber: number): Promise<void> => {
    const answer = await captureLatestPlatformAnswerWithRetries(
      page,
      config.id,
      config.name
    );
    if (!answer) {
      console.log(
        `[${config.name}] 第 ${generationNumber} 版回答正文未能解析，暂时保留上一版缓存。`
      );
      return;
    }
    finalAnswer = answer;
    finalGeneration = generationNumber;
    finalAnswerExtractedAt = new Date().toISOString();
    console.log(
      `[${config.name}] 已缓存第 ${generationNumber} 版回答正文（${answer.length} 字符）。`
    );
  };
  await captureAnswer(1);
  if (mode === "business" && !finalAnswer) {
    throw new Error(
      `[${config.name}] 当前问题已有回答生命周期信号，但回答正文为空，按技术失败停止该批次。`
    );
  }

  // business 不会因为引用缺失而重新提问或重新生成；research 保留原恢复流程。
  const referenceReady = await prepareCurrentReferenceList(
    page,
    config,
    timeoutMs,
    trackedBaseline,
    baselineDoubaoSearchBlockCount,
    baselineRevealButtonCount,
    submittedQuestion,
    captureAnswer,
    retryOnNoReferences,
    regenerateOnNoReferences
  );
  const createAnswerRecord = (referenceCount: number): AnswerRecord => {
    const answerRecord: AnswerRecord = {
      question,
      submittedQuestion,
      crawlPlatform: config.name,
      answer: finalAnswer,
      generationNumber: finalGeneration,
      referenceCount,
      extractedAt: finalAnswerExtractedAt
    };
    console.log(
      `[${config.name}] 已保存最终第 ${finalGeneration} 版回答` +
      `（正文=${finalAnswer.length} 字符，参考=${referenceCount} 条）。`
    );
    return answerRecord;
  };

  if (!referenceReady) {
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    if (mode === "business") {
      assertVerifiedWebSearchForZeroReferences(webSearch);
    }
    console.log(mode === "business"
      ? `[${config.name}] 当前回答没有引用，按正常成功结果保存，不重试或重新生成。`
      : config.id === "doubao"
        ? `[豆包] 跳过本题：原始回答及 ${DOUBAO_RESUBMISSION_ATTEMPTS} 次重新提问后仍没有可用参考资料。`
        : `[${config.name}] 跳过本题：检查 ${REFERENCE_CHECK_ATTEMPTS} 次后仍没有可用参考资料。`
    );
    if (baselineRevealButtonCount > 0) {
      console.log(`[${config.name}] 页面存在历史参考入口，但没有确认到属于本题的有效引用列表。`);
    }
    return {
      questionIndex,
      question,
      status: getNoReferencesStatus(mode),
      attemptCount: finalGeneration,
      answer: createAnswerRecord(0),
      references: [],
      referenceStatus: "CONFIRMED_EMPTY",
      submittedQuestion,
      requestedDeepThinking,
      actualDeepThinking,
      ...webSearchResultFields,
      ...(mode === "research"
        ? { errorMessage: "多次检查后仍没有找到属于当前问题的有效参考资料。" }
        : {})
    };
  }

  const extractionBaseline = config.id === "doubao"
    ? baselineDoubaoSearchBlockCount
    : baselineBottom;
  const extractedRecords = await extractReferencesWithRetries(
    page,
    question,
    config.name,
    extractionBaseline
  );
  if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
  const resolvedQuestionRecords = resolveTitles && config.id === "deepseek"
    ? await resolveRecordTitles(extractedRecords)
    : extractedRecords;
  const questionRecords = resolvedQuestionRecords.map((record) => ({
    ...record,
    submittedQuestion
  }));
  console.log(`[${config.name}] 抽取到 ${questionRecords.length} 条参考链接`);
  if (questionRecords.length === 0) {
    if (mode === "business") {
      throw new Error(
        `[${config.name}] 引用面板已确认存在，但连续 ${REFERENCE_CHECK_ATTEMPTS} 次无法解析有效引用，按 DOM 技术失败停止该批次。`
      );
    }
    console.log(
      `[${config.name}] 跳过本题：引用面板已打开，但连续 ${REFERENCE_CHECK_ATTEMPTS} 次没有解析到有效外部链接。`
    );
    return {
      questionIndex,
      question,
      status: "no_references",
      attemptCount: finalGeneration,
      answer: createAnswerRecord(0),
      references: [],
      referenceStatus: "UNKNOWN",
      errorMessage: "引用面板已打开，但没有解析到有效外部链接。",
      submittedQuestion,
      requestedDeepThinking,
      actualDeepThinking,
      ...webSearchResultFields
    };
  }

  return {
    questionIndex,
    question,
    status: "success",
    attemptCount: finalGeneration,
    answer: createAnswerRecord(questionRecords.length),
    references: questionRecords,
    referenceStatus: "EXTRACTED",
    submittedQuestion,
    requestedDeepThinking,
    actualDeepThinking,
    ...webSearchResultFields
  };
  } catch (error) {
    // 正式 Worker 的后续错误摘要即使包含原问题，也能自动完整移除。
    throw attachConsoleSecrets(error, [task.question]);
  }
  });
}

/**
 * 发送后异常的只读恢复检查。它只观察当前页面，不点击发送、不新建会话，也不
 * 重新生成；只有问题锚点、最新回答正文和非生成状态同时成立才确认成功。
 */
export async function inspectCurrentQuestionAnswer(
  page: Page,
  config: PlatformConfig,
  submittedQuestion: string,
  mode: CollectionMode = "research"
): Promise<CurrentQuestionAnswerInspection> {
  return runWithConsolePrivacy({ mode, verbose: mode === "research" }, async () => {
  if (page.isClosed()) {
    return { status: "uncertain", reason: "平台页面已关闭，无法确认发送后的回答" };
  }
  const [bodyText, busy, answerContent] = await Promise.all([
    page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
    isAnswerGenerating(page).catch(() => true),
    captureLatestPlatformAnswerWithRetries(page, config.id, config.name).catch(() => "")
  ]);
  const body = normalizeInspectionText(bodyText);
  const question = normalizeInspectionText(submittedQuestion);
  const answer = normalizeInspectionText(answerContent);
  const questionIndex = question ? body.lastIndexOf(question) : -1;
  if (questionIndex < 0) {
    return { status: "uncertain", reason: "当前页面未确认到本题问题锚点" };
  }
  if (busy) {
    return { status: "uncertain", reason: "当前页面仍显示回答生成中" };
  }
  if (!answer) {
    return { status: "uncertain", reason: "当前页面未解析到本题回答正文" };
  }
  const answerProbe = answer.slice(0, Math.min(80, answer.length));
  if (!body.slice(questionIndex + question.length).includes(answerProbe)) {
    return { status: "uncertain", reason: "最新回答正文无法与本题问题锚点对应" };
  }
  return {
    status: "answered",
    answerContent,
    reason: "当前页面已确认本题问题锚点和完整回答正文"
  };
  });
}

/**
 * CDP/标签页恢复后的只读结果恢复。该函数绝不发送、重新生成或新建对话；它先
 * 用问题锚点确认当前回答，再按现有平台 DOM 规则判断并抽取引用。
 */
export async function recoverSubmittedQuestionResult(
  page: Page,
  config: PlatformConfig,
  submittedQuestion: string,
  webSearch: WebSearchActivationResult
): Promise<RecoveredSubmittedQuestionResult> {
  return runWithConsolePrivacy({ mode: "business", verbose: false }, async () => {
    const inspection = await inspectCurrentQuestionAnswer(
      page,
      config,
      submittedQuestion,
      "business"
    );
    if (inspection.status !== "answered" || !inspection.answerContent?.trim()) {
      throw Object.assign(new Error(inspection.reason), { errorCode: "REFERENCE_UNKNOWN" });
    }

    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    const doubaoBlockCount = config.id === "doubao"
      ? await countDoubaoSearchResultBlocks(page)
      : 0;
    const referenceReady = await prepareCurrentReferenceList(
      page,
      config,
      15_000,
      undefined,
      Math.max(0, doubaoBlockCount - 1),
      0,
      submittedQuestion,
      undefined,
      false,
      false
    );
    if (!referenceReady) {
      assertVerifiedWebSearchForZeroReferences(webSearch);
      return {
        answerContent: inspection.answerContent,
        references: [],
        referenceStatus: "CONFIRMED_EMPTY",
        reason: "重连后确认原问题回答完整且当前回答不存在引用入口"
      };
    }

    const references = await extractReferencesWithRetries(
      page,
      submittedQuestion,
      config.name,
      config.id === "doubao" ? Math.max(0, doubaoBlockCount - 1) : 0
    );
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    if (references.length === 0) {
      throw Object.assign(new Error("重连后引用入口存在但引用无法解析"), {
        errorCode: "REFERENCE_UNKNOWN"
      });
    }
    return {
      answerContent: inspection.answerContent,
      references: references.map((reference) => ({ ...reference, submittedQuestion })),
      referenceStatus: "EXTRACTED",
      reason: "重连后确认并恢复原问题回答和引用"
    };
  });
}

/**
 * 豆包使用专属三次重新提问流程；其他平台最多检查三次当前题的引用入口和
 * 列表稳定性。千问第一次没有入口时允许重新生成一次，但仍计入三次检查。
 */
async function prepareCurrentReferenceList(
  page: Page,
  config: PlatformConfig,
  answerTimeoutMs: number,
  trackedBaseline: TrackedAnswerBaseline | undefined,
  baselineDoubaoSearchBlockCount: number,
  baselineRevealButtonCount: number,
  submittedQuestion: string,
  onGenerationComplete?: (generationNumber: number) => Promise<void>,
  retryOnNoReferences = true,
  regenerateOnNoReferences = true
): Promise<boolean> {
  if (!retryOnNoReferences && !regenerateOnNoReferences) {
    return retryTechnicalFailure(
      "business",
      `${config.name} 检查当前回答引用结构`,
      async () => {
        const ready = await checkCurrentReferenceListOnce(
          page,
          config,
          trackedBaseline?.referenceCount ?? 0,
          trackedBaseline?.referenceMarker ?? "",
          baselineDoubaoSearchBlockCount,
          submittedQuestion
        );
        if (ready) return true;

        const [currentRevealButtonCount, currentDoubaoHasReferences] = await Promise.all([
          countReferenceRevealButtons(page, config.referenceRevealSelectors),
          config.id === "doubao"
            ? hasCurrentDoubaoReferenceEntry(
                page,
                submittedQuestion,
                baselineDoubaoSearchBlockCount
              )
            : Promise.resolve(false)
        ]);
        if (
          currentRevealButtonCount > baselineRevealButtonCount ||
          currentDoubaoHasReferences
        ) {
          throw new Error("已发现当前回答的引用入口，但引用列表未能打开或稳定，可能是 DOM 改版");
        }
        return false;
      }
    );
  }

  if (config.id === "doubao" && retryOnNoReferences) {
    return prepareDoubaoReferenceList(
      page,
      config,
      answerTimeoutMs,
      baselineDoubaoSearchBlockCount,
      submittedQuestion,
      onGenerationComplete
    );
  }

  let referenceTriggerBaseline = trackedBaseline?.referenceCount ?? 0;
  const referenceTriggerMarker = trackedBaseline?.referenceMarker ?? "";
  let qianwenRegenerated = false;

  const referenceCheckAttempts = retryOnNoReferences ? REFERENCE_CHECK_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= referenceCheckAttempts; attempt += 1) {
    const ready = await checkCurrentReferenceListOnce(
      page,
      config,
      referenceTriggerBaseline,
      referenceTriggerMarker,
      baselineDoubaoSearchBlockCount,
      submittedQuestion
    ).catch((error) => {
      console.log(`[${config.name}] 第 ${attempt} 次参考资料检查异常：${formatError(error)}`);
      return false;
    });
    if (ready) return true;

    if (config.id === "qianwen" && regenerateOnNoReferences && !qianwenRegenerated) {
      qianwenRegenerated = true;
      console.log("[千问] 首次检查没有参考入口，自动重新生成一次后继续检查。");
      const regenerationBaseline = await snapshotTrackedAnswerBaseline(page, "qianwen");
      const clicked = await clickLatestQianwenRegenerate(page);
      if (clicked) {
        const started = await waitForQianwenRegenerationStart(page, regenerationBaseline, 15_000);
        if (started) {
          try {
            await waitForAnswerComplete(
              page,
              config,
              answerTimeoutMs,
              regenerationBaseline,
              submittedQuestion,
              true
            );
          } catch (error) {
            if (error instanceof QianwenAnswerLoopError) {
              console.log(`[千问] 重新生成的回答再次异常，跳过本题：${error.message}`);
              return false;
            }
            throw error;
          }
          await scrollToBottom(page);
          await onGenerationComplete?.(2);
          referenceTriggerBaseline = regenerationBaseline.referenceCount;
        } else {
          console.log("[千问] 已点击重新生成，但 15 秒内未检测到生成启动。");
        }
      } else {
        console.log("[千问] 未能打开重新生成菜单或点击重新生成项。");
      }
    }

    console.log(`[${config.name}] 第 ${attempt}/${referenceCheckAttempts} 次未找到可用参考资料。`);
    if (attempt < referenceCheckAttempts) {
      await page.waitForTimeout(REFERENCE_CHECK_INTERVAL_MS);
      await scrollToBottom(page);
    }
  }

  return false;
}

/**
 * 豆包原始回答没有引用时，最多重新发送同一问题三次。每次发送前覆盖页面内
 * 的元素身份基线，回答完整结束后只检查新回答；三次仍为空时交给外层跳过。
 */
async function prepareDoubaoReferenceList(
  page: Page,
  config: PlatformConfig,
  answerTimeoutMs: number,
  baselineDoubaoSearchBlockCount: number,
  submittedQuestion: string,
  onGenerationComplete?: (generationNumber: number) => Promise<void>
): Promise<boolean> {
  const originalReady = await checkCurrentReferenceListOnce(
    page,
    config,
    0,
    "",
    baselineDoubaoSearchBlockCount,
    submittedQuestion
  ).catch((error) => {
    console.log(`[豆包] 原始回答参考资料检查异常：${formatError(error)}`);
    return false;
  });
  if (originalReady) return true;

  console.log("[豆包] 原始回答没有可用参考资料，开始自动重新发送同一问题。");
  let completedGenerationNumber = 1;
  for (let attempt = 1; attempt <= DOUBAO_RESUBMISSION_ATTEMPTS; attempt += 1) {
    await waitForReadyToSend(page, config, answerTimeoutMs);
    await activateWebSearch(page, config, "PREFERRED");
    const resubmissionBaseline = await snapshotTrackedAnswerBaseline(page, "doubao");
    // 每次重新提问都覆盖 WeakSet 基线，确保只认本次新挂载的回答和搜索块。
    await markDoubaoSearchResultBaseline(page);
    console.log(`[豆包] 正在执行第 ${attempt}/${DOUBAO_RESUBMISSION_ATTEMPTS} 次重新提问。`);
    await submitQuestion(page, config, submittedQuestion);

    await waitForAnswerComplete(
      page,
      config,
      answerTimeoutMs,
      resubmissionBaseline,
      submittedQuestion,
      false
    );
    await scrollToBottom(page);
    completedGenerationNumber += 1;
    await onGenerationComplete?.(completedGenerationNumber);
    const ready = await checkCurrentReferenceListOnce(
      page,
      config,
      0,
      "",
      resubmissionBaseline.referenceCount,
      submittedQuestion
    ).catch((error) => {
      console.log(`[豆包] 第 ${attempt} 次重新提问后的参考资料检查异常：${formatError(error)}`);
      return false;
    });
    if (ready) {
      console.log(`[豆包] 第 ${attempt} 次重新提问后已找到可用参考资料。`);
      return true;
    }

    console.log(`[豆包] 第 ${attempt}/${DOUBAO_RESUBMISSION_ATTEMPTS} 次重新提问后仍没有可用参考资料。`);
    if (attempt < DOUBAO_RESUBMISSION_ATTEMPTS) {
      await page.waitForTimeout(REFERENCE_CHECK_INTERVAL_MS);
      await scrollToBottom(page);
    }
  }

  return false;
}

/** 执行一次平台专属的“展开最新引用 + 等待列表稳定”。 */
async function checkCurrentReferenceListOnce(
  page: Page,
  config: PlatformConfig,
  referenceTriggerBaseline: number,
  referenceTriggerMarker: string,
  baselineDoubaoSearchBlockCount: number,
  submittedQuestion: string
): Promise<boolean> {
  if (config.id === "doubao") {
    const revealed = await revealLatestDoubaoReferenceList(
      page,
      config.referenceRevealSelectors,
      baselineDoubaoSearchBlockCount,
      submittedQuestion,
      DOUBAO_REFERENCE_REVEAL_TIMEOUT_MS
    );
    return revealed && await waitForDoubaoReferenceListStable(
      page,
      baselineDoubaoSearchBlockCount,
      DOUBAO_REFERENCE_STABLE_TIMEOUT_MS,
      submittedQuestion
    );
  }

  if (config.id === "deepseek") {
    const expectedCount = await revealLatestDeepSeekReferenceList(page, REFERENCE_REVEAL_TIMEOUT_MS);
    return expectedCount > 0 && await waitForDeepSeekReferenceListStable(
      page,
      REFERENCE_STABLE_TIMEOUT_MS,
      expectedCount
    );
  }

  if (config.id === "qianwen") {
    const expectedCount = await revealLatestQianwenReferenceList(
      page,
      referenceTriggerBaseline,
      REFERENCE_REVEAL_TIMEOUT_MS
    );
    return expectedCount > 0 && await waitForQianwenReferenceListStable(
      page,
      REFERENCE_STABLE_TIMEOUT_MS,
      expectedCount
    );
  }

  if (config.id === "yuanbao") {
    const revealed = await revealLatestYuanbaoReferenceList(
      page,
      referenceTriggerMarker,
      submittedQuestion,
      REFERENCE_REVEAL_TIMEOUT_MS
    );
    return revealed && await waitForYuanbaoReferenceListStable(
      page,
      REFERENCE_STABLE_TIMEOUT_MS
    );
  }

  await revealReferencePanels(page, config.referenceRevealSelectors);
  await page.waitForTimeout(800);
  return true;
}

/** 引用面板已经就绪但解析为空时，原地再解析两次，不重新发送问题。 */
async function extractReferencesWithRetries(
  page: Page,
  question: string,
  platformName: string,
  extractionBaseline: number
): Promise<ReferenceRecord[]> {
  const attempts = REFERENCE_CHECK_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const records = await extractReferences(page, question, platformName, extractionBaseline)
      .catch((error) => {
        console.log(`[${platformName}] 第 ${attempt} 次解析参考资料异常：${formatError(error)}`);
        return [];
      });
    if (records.length > 0) return records;

    console.log(`[${platformName}] 第 ${attempt}/${attempts} 次解析结果为空。`);
    if (attempt < attempts) {
      await page.waitForTimeout(REFERENCE_CHECK_INTERVAL_MS);
    }
  }
  return [];
}

/**
 * business 只重试抛出异常的技术步骤，不会重发问题或重新生成回答。返回 false、
 * 空引用等业务结果会直接返回给调用方，不会触发这里的重试。
 */
async function retryTechnicalFailure<T>(
  mode: CollectionMode,
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  const attempts = mode === "business" ? TECHNICAL_RETRY_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.log(
        `[技术重试] ${label} 第 ${attempt}/${attempts} 次失败：${formatError(error)}`
      );
    }
  }

  throw lastError;
}

/** 回答刚结束时短暂重试正文节点，避免最后一批 Markdown/block 节点尚未挂载。 */
async function captureLatestPlatformAnswerWithRetries(
  page: Page,
  platformId: PlatformConfig["id"],
  platformName: string
): Promise<string> {
  for (let attempt = 1; attempt <= REFERENCE_CHECK_ATTEMPTS; attempt += 1) {
    const answer = await extractLatestPlatformAnswer(page, platformId).catch((error) => {
      console.log(`[${platformName}] 第 ${attempt} 次解析回答正文异常：${formatError(error)}`);
      return "";
    });
    if (answer) return answer;
    if (attempt < REFERENCE_CHECK_ATTEMPTS) await page.waitForTimeout(500);
  }
  return "";
}

/** 将未知异常转换为适合终端日志的一行文本。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeInspectionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 将视口移到最新回答区域，避免引用入口因懒加载而尚未挂载。 */
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => undefined);
  await page.waitForTimeout(500);
}

/** 关闭元宝已打开的引用抽屉；按钮失败时再尝试 Escape。 */
async function closeYuanbaoReferencePanel(page: Page): Promise<void> {
  const openDrawer = page.locator(".t-drawer--open").last();
  if (await openDrawer.count().catch(() => 0) === 0) return;

  const closeButton = openDrawer.locator(
    ".t-drawer__close-btn, " +
    "[class*='drawer'][class*='close']:visible, " +
    "button[aria-label*='关闭']:visible"
  ).last();
  await closeButton.click({ timeout: 2_000 }).catch(() => undefined);

  const closed = await openDrawer.waitFor({ state: "hidden", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (closed) return;

  await page.keyboard.press("Escape").catch(() => undefined);
  const closedByEscape = await openDrawer.waitFor({ state: "hidden", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!closedByEscape) {
    console.log("[元宝] 提醒：引用面板未能自动关闭，下一题将使用页面变化次数判断回答开始。");
  }
}

/** 在当前 CDP 浏览器的所有标签页中按主域名/兼容域名寻找目标平台。 */
function findExistingPage(pages: Page[], config: PlatformConfig): Page | null {
  const targetHosts = (config.hostnames || [new URL(config.url).hostname])
    .map((host) => host.replace(/^www\./, ""));
  return pages.find((page) => {
    try {
      const pageHost = new URL(page.url()).hostname.replace(/^www\./, "");
      return targetHosts.some((targetHost) => pageHost === targetHost || pageHost.endsWith(`.${targetHost}`));
    } catch {
      return false;
    }
  }) ?? null;
}

/** 启动前快速确认页面已登录且存在可用输入框。 */
async function ensureReadyForInput(page: Page, config: PlatformConfig): Promise<void> {
  const inputBox = await findInput(page, config.inputSelectors, 8_000);
  if (inputBox) return;

  throw new Error(`没有在已打开的 ${config.name} 标签页找到聊天输入框，请确认页面已登录并停留在可提问界面。`);
}

/** 兼容 textarea/input 与 contenteditable，并优先点击发送按钮、回退 Enter。 */
async function submitQuestion(page: Page, config: PlatformConfig, question: string): Promise<void> {
  const inputBox = await findInput(page, config.inputSelectors, 30_000);
  if (!inputBox) throw new Error(`没有在 ${config.name} 页面找到聊天输入框。`);

  await inputBox.click({ timeout: 5_000 });
  const tagName = await inputBox.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tagName === "textarea" || tagName === "input") {
    await inputBox.fill(question);
  } else {
    const filled = await inputBox.fill(question).then(() => true).catch(() => false);
    if (!filled) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.insertText(question);
    }
  }

  if (await clickSendButton(page, config.sendButtonSelectors)) return;
  await page.keyboard.press("Enter");
}

/** 从后向前寻找最新且可点击的发送控件。 */
async function clickSendButton(page: Page, selectors: string[]): Promise<boolean> {
  // React 更新输入状态后，Windows 页面上的发送按钮可能延迟数百毫秒才启用。
  // 在退回 Enter 之前短暂轮询，避免把 Enter 当成富文本输入框里的换行。
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locators = await page.locator(selector).all().catch(() => []);
      for (const locator of locators.slice(-4).reverse()) {
        const visible = await locator.isVisible().catch(() => false);
        const enabled = await locator.isEnabled().catch(() => false);
        if (!visible || !enabled) continue;
        const clicked = await locator.click({ timeout: 1000 })
          .then(() => true)
          .catch(() => false);
        if (clicked) return true;
      }
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/** 轮询多个输入框选择器，返回页面中最后一个可见且启用的输入控件。 */
async function findInput(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const locators = await page.locator(selector).all().catch(() => []);
      for (const locator of locators.slice().reverse()) {
        const visible = await locator.isVisible().catch(() => false);
        const enabled = await locator.isEnabled().catch(() => false);
        if (visible && enabled) return locator;
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/** 同时满足“有输入框”和“未生成回答”才允许发送下一题。 */
async function waitForReadyToSend(page: Page, config: PlatformConfig, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const inputBox = await findInput(page, config.inputSelectors, 1_500);
    const busy = config.id === "doubao" || config.id === "deepseek" || config.id === "qianwen" || config.id === "yuanbao"
      ? await isAnswerGenerating(page)
      : false;
    if (inputBox && !busy) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`${config.name} 长时间没有恢复到可提问状态，请确认上一条回答已经结束。`);
}

/** 为已支持的平台使用结构化基线判断；保留通用正文稳定等待作为兼容路径。 */
async function waitForAnswerComplete(
  page: Page,
  config: PlatformConfig,
  timeoutMs: number,
  trackedBaseline?: TrackedAnswerBaseline,
  submittedQuestion = "",
  answerStartAlreadyConfirmed = false
): Promise<void> {
  if (config.id === "yuanbao") {
    await waitForYuanbaoCurrentAnswerComplete(
      page,
      submittedQuestion,
      timeoutMs
    );
    await waitForReadyToSend(page, config, 30_000);
    return;
  }

  if (config.id === "doubao" || config.id === "deepseek" || config.id === "qianwen") {
    if (!trackedBaseline) throw new Error(`[${config.name}] 缺少回答前页面快照，无法安全判断本题是否完成。`);
    await waitForTrackedAnswerComplete(
      page,
      timeoutMs,
      trackedBaseline,
      submittedQuestion,
      config.id,
      config.name,
      answerStartAlreadyConfirmed
    );
    await waitForReadyToSend(page, config, 30_000);
    return;
  }

  await waitForAnswerStable(page, timeoutMs, 5_000, 8_000);
}

interface YuanbaoCurrentAnswerSnapshot {
  questionFound: boolean;
  answerFound: boolean;
  text: string;
}

/**
 * 只读取当前问题之后最后一个元宝 AI 正文节点。来源入口和回答操作栏会在流式
 * 输出期间提前挂载，不能用于判断完成；问题锚点可避免读到上一题的稳定正文。
 */
async function snapshotCurrentYuanbaoAnswer(
  page: Page,
  submittedQuestion: string
): Promise<YuanbaoCurrentAnswerSnapshot> {
  const question = JSON.stringify(submittedQuestion.replace(/\s+/g, " ").trim());
  return page.evaluate<YuanbaoCurrentAnswerSnapshot>(`
(() => {
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const isRendered = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
  };
  const expectedQuestion = ${question};
  const questionCandidates = expectedQuestion
    ? Array.from(document.querySelectorAll("body *"))
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => isRendered(element))
        .filter(({ element }) => clean(element.textContent) === expectedQuestion)
        .sort((a, b) => {
          const aRect = a.element.getBoundingClientRect();
          const bRect = b.element.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height) ||
            b.index - a.index;
        })
    : [];
  const questionElement = questionCandidates[0]?.element || null;
  if (!questionElement) {
    return { questionFound: false, answerFound: false, text: "" };
  }

  const answers = Array.from(document.querySelectorAll(
    "[data-conv-speaker='ai'] .agent-chat__speech-card__text"
  )).filter((element) =>
    isRendered(element) &&
    Boolean(questionElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
  );
  const answer = answers[answers.length - 1];
  if (!(answer instanceof HTMLElement)) {
    return { questionFound: true, answerFound: false, text: "" };
  }

  return {
    questionFound: true,
    answerFound: true,
    text: clean(answer.innerText || answer.textContent || "")
  };
})()
`).catch(() => ({
    questionFound: false,
    answerFound: false,
    text: ""
  }));
}

/**
 * 等待元宝当前题正文连续稳定。即使“源”入口已经出现，只要正文仍在增长就继续
 * 等待；这防止引用准备完成后过早缓存半句回答并提交下一题。
 */
export async function waitForYuanbaoCurrentAnswerComplete(
  page: Page,
  submittedQuestion: string,
  timeoutMs: number,
  stableWindowMs = 15_000,
  minWaitMs = 20_000
): Promise<void> {
  const startedAt = Date.now();
  let lastAnswerText = "";
  let answerStableSince = Date.now();
  let sawCurrentAnswer = false;
  let nextProgressLogAt = 30_000;
  let lastSnapshot: YuanbaoCurrentAnswerSnapshot = {
    questionFound: false,
    answerFound: false,
    text: ""
  };

  await page.waitForTimeout(500);
  while (Date.now() - startedAt < timeoutMs) {
    const [snapshot, busy] = await Promise.all([
      snapshotCurrentYuanbaoAnswer(page, submittedQuestion),
      isAnswerGenerating(page)
    ]);
    lastSnapshot = snapshot;

    if (snapshot.answerFound && snapshot.text) {
      sawCurrentAnswer = true;
      if (snapshot.text !== lastAnswerText) {
        lastAnswerText = snapshot.text;
        answerStableSince = Date.now();
      }
    } else if (sawCurrentAnswer) {
      // 当前回答节点短暂重挂载时重新计算稳定窗口，避免把旧文本当作最终结果。
      answerStableSince = Date.now();
    }

    const elapsed = Date.now() - startedAt;
    const stableFor = Date.now() - answerStableSince;
    if (
      sawCurrentAnswer &&
      snapshot.answerFound &&
      snapshot.text.length > 0 &&
      !busy &&
      elapsed >= minWaitMs &&
      stableFor >= stableWindowMs
    ) {
      console.log(
        `[元宝] 当前回答正文已连续稳定 ${Math.round(stableFor / 1000)} 秒` +
        `（${snapshot.text.length} 字符），确认本题回答完成。`
      );
      return;
    }

    if (elapsed >= nextProgressLogAt) {
      console.log(
        "[元宝] 当前回答仍在生成或等待稳定：" +
        `问题锚点=${snapshot.questionFound ? "已找到" : "未找到"}` +
        `，正文节点=${snapshot.answerFound ? "已找到" : "未找到"}` +
        `，正文字符=${snapshot.text.length}` +
        `，连续稳定=${Math.round(stableFor / 1000)}秒` +
        `，生成状态=${busy ? "生成中" : "未检测到停止按钮"}`
      );
      nextProgressLogAt += 30_000;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    "[元宝] 等待本题回答完整结束超时，已停止后续问题以避免题目与来源数据错位。" +
    `最后状态：问题锚点=${lastSnapshot.questionFound ? "已找到" : "未找到"}` +
    `，正文节点=${lastSnapshot.answerFound ? "已找到" : "未找到"}` +
    `，正文字符=${lastSnapshot.text.length}。可增大 --timeout-ms 后重试。`
  );
}

/** 采集正文、高度和平台专属引用结构数量，形成回答前基线。 */
async function snapshotTrackedAnswerBaseline(
  page: Page,
  platformId: "doubao" | "deepseek" | "qianwen" | "yuanbao"
): Promise<TrackedAnswerBaseline> {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const referenceLabel = platformId === "qianwen" ? "参考来源" : "引用来源";
  const yuanbaoBaseline = platformId === "yuanbao"
    ? await markYuanbaoReferenceTriggerBaseline(page)
    : undefined;
  return {
    bodyText,
    documentBottom: await snapshotDocumentBottom(page),
    referenceCount: platformId === "doubao"
      ? await countDoubaoSearchResultBlocks(page)
      : platformId === "deepseek"
        ? await countDeepSeekReferenceContainers(page)
        : platformId === "qianwen"
          ? await countQianwenReferenceTriggers(page)
        : platformId === "yuanbao"
          ? yuanbaoBaseline?.count ?? 0
        : bodyText.split(referenceLabel).length - 1,
    referenceMarker: yuanbaoBaseline?.marker
  };
}

/**
 * 千问点击“重新生成”后快速确认动作真正生效，避免点击失败后继续等待完整超时。
 */
async function waitForQianwenRegenerationStart(
  page: Page,
  baseline: TrackedAnswerBaseline,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  let lastSnapshot = baseline.bodyText;
  let meaningfulChanges = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const [snapshot, busy, referenceCount] = await Promise.all([
      page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
      isAnswerGenerating(page),
      countQianwenReferenceTriggers(page)
    ]);

    if (busy || referenceCount > baseline.referenceCount) return true;
    if (snapshot && snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      meaningfulChanges += 1;
      if (meaningfulChanges >= 2 && Math.abs(snapshot.length - baseline.bodyText.length) >= 30) return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/**
 * 综合停止按钮、正文变化、页面高度、问题回显和引用结构变化判断回答生命周期。
 * 单一信号容易受平台流式渲染影响，因此必须先确认回答开始，再等待稳定窗口。
 */
async function waitForTrackedAnswerComplete(
  page: Page,
  timeoutMs: number,
  baseline: TrackedAnswerBaseline,
  submittedQuestion: string,
  platformId: "doubao" | "deepseek" | "qianwen",
  platformName: string,
  answerStartAlreadyConfirmed = false
): Promise<void> {
  const startedAt = Date.now();
  let lastSnapshot = baseline.bodyText;
  let stableSince = Date.now();
  let sawGenerating = false;
  let meaningfulChanges = 0;
  let sawAnswerStart = answerStartAlreadyConfirmed;
  let doubaoReferenceReadySince = 0;
  const referenceLabel = platformId === "qianwen" ? "参考来源" : "引用来源";
  const stableWindowMs = 12_000;
  const minWaitMs = 15_000;
  let nextProgressLogAt = 30_000;
  const baselineQuestionOccurrences = countTextOccurrences(baseline.bodyText, submittedQuestion);

  await page.waitForTimeout(1_000);
  while (Date.now() - startedAt < timeoutMs) {
    const [snapshot, busy, documentBottom, structuredReferenceCount, currentDoubaoHasReferences] = await Promise.all([
      page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
      isAnswerGenerating(page),
      snapshotDocumentBottom(page),
      platformId === "doubao"
        ? countDoubaoSearchResultBlocks(page)
        : platformId === "deepseek"
          ? countDeepSeekReferenceContainers(page)
          : platformId === "qianwen"
            ? countQianwenReferenceTriggers(page)
          : Promise.resolve(0),
      platformId === "doubao" && submittedQuestion
        ? hasCurrentDoubaoReferenceEntry(page, submittedQuestion, baseline.referenceCount)
        : Promise.resolve(false)
    ]);

    if (busy) sawGenerating = true;
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      stableSince = Date.now();
      meaningfulChanges += 1;
    }

    const referenceCount = platformId === "doubao"
      ? structuredReferenceCount
      : platformId === "deepseek"
        ? structuredReferenceCount
        : platformId === "qianwen"
          ? structuredReferenceCount
        : snapshot.split(referenceLabel).length - 1;
    const textGrowth = snapshot.length - baseline.bodyText.length - submittedQuestion.length;
    const bottomGrowth = documentBottom - baseline.documentBottom;
    const questionOccurrences = countTextOccurrences(snapshot, submittedQuestion);
    const sawSubmittedQuestion = Boolean(submittedQuestion) && questionOccurrences > baselineQuestionOccurrences;
    sawAnswerStart ||=
      sawGenerating ||
      sawSubmittedQuestion ||
      currentDoubaoHasReferences ||
      referenceCount > baseline.referenceCount ||
      ((platformId === "doubao" || platformId === "deepseek") && meaningfulChanges >= 3 && Math.abs(textGrowth) >= 60) ||
      (meaningfulChanges >= 3 && textGrowth >= 60) ||
      (bottomGrowth >= 250 && textGrowth >= 60);

    if (platformId === "qianwen" && sawAnswerStart) {
      const currentAnswerText = extractCurrentQianwenAnswerText(
        snapshot,
        baseline.bodyText,
        submittedQuestion
      );
      const loop = detectQianwenAnswerLoop(currentAnswerText);
      if (loop.detected) {
        const stopped = await stopQianwenGeneration(page);
        throw new QianwenAnswerLoopError(
          `检测到回答内容重复循环（同一句最多重复 ${loop.maxRepeatCount} 次，` +
          `重复行 ${loop.duplicateLineCount} 条）` +
          `${stopped ? "，已停止当前生成" : "，当前页面未显示停止按钮"}。`
        );
      }
    }

    const elapsed = Date.now() - startedAt;
    const stableFor = Date.now() - stableSince;
    if (platformId === "doubao" && currentDoubaoHasReferences && !busy) {
      if (doubaoReferenceReadySince === 0) doubaoReferenceReadySince = Date.now();
    } else {
      doubaoReferenceReadySince = 0;
    }
    const doubaoReferenceReadyFor = doubaoReferenceReadySince > 0
      ? Date.now() - doubaoReferenceReadySince
      : 0;
    // 豆包的搜索入口属于当前回答且正文已短暂稳定时即可放行。这个信号不依赖
    // 搜索块总数递增，可兼容长会话回收旧 DOM、复用搜索块数量的情况。
    if (
      platformId === "doubao" &&
      sawAnswerStart &&
      currentDoubaoHasReferences &&
      !busy &&
      stableFor >= DOUBAO_REFERENCE_READY_STABLE_MS &&
      doubaoReferenceReadyFor >= DOUBAO_REFERENCE_READY_STABLE_MS &&
      elapsed >= minWaitMs
    ) return;
    if (sawAnswerStart && !busy && stableFor >= stableWindowMs && elapsed >= minWaitMs) return;

    if ((platformId === "doubao" || platformId === "deepseek" || platformId === "qianwen") && elapsed >= nextProgressLogAt) {
      console.log(
        `[${platformName}] 回答仍在处理中，已等待 ${Math.round(elapsed / 1000)} 秒` +
        `（生成状态=${busy ? "生成中" : "阶段性稳定"}` +
        `，当前问题=${sawSubmittedQuestion ? "已出现" : "未出现"}` +
        (platformId === "doubao"
          ? `，当前引用入口=${currentDoubaoHasReferences ? "已出现" : "未出现"}`
          : "") +
        `，引用结构变化=${referenceCount - baseline.referenceCount}）`
      );
      nextProgressLogAt += 30_000;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`[${platformName}] 等待本题回答完整结束超时，已停止后续问题以避免题目与来源数据错位。可增大 --timeout-ms 后重试。`);
}

export interface QianwenAnswerLoopDetection {
  detected: boolean;
  maxRepeatCount: number;
  duplicateLineCount: number;
  repeatedLine: string;
}

/**
 * 识别千问异常回答中的“同一批长句不断重复”现象。
 * 只统计长度足以代表正文语义的行，并同时要求高频单行和整体重复量，
 * 避免把正常列表中的短标签或偶发重复误判为崩坏。
 */
export function detectQianwenAnswerLoop(answerText: string): QianwenAnswerLoopDetection {
  const lines = answerText
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 12 && line.length <= 500)
    .filter((line) => !/^(复制|分享|点赞|点踩|重新生成|参考来源|更多)$/.test(line));

  if (lines.length < 20) {
    return { detected: false, maxRepeatCount: 0, duplicateLineCount: 0, repeatedLine: "" };
  }

  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const maxRepeatCount = repeated[0]?.[1] ?? 0;
  const duplicateLineCount = repeated.reduce((total, [, count]) => total + count - 1, 0);
  const repeatedLine = repeated[0]?.[0] ?? "";
  const uniqueRatio = counts.size / lines.length;
  const detected =
    (maxRepeatCount >= 5 && duplicateLineCount >= 12) ||
    (maxRepeatCount >= 4 && duplicateLineCount >= 20 && uniqueRatio <= 0.7);

  return { detected, maxRepeatCount, duplicateLineCount, repeatedLine };
}

/** 从整页正文中切出本题回答，避免历史会话里的重复句干扰判断。 */
function extractCurrentQianwenAnswerText(
  snapshot: string,
  baselineBodyText: string,
  submittedQuestion: string
): string {
  if (submittedQuestion) {
    const questionIndex = snapshot.lastIndexOf(submittedQuestion);
    if (questionIndex >= 0) return snapshot.slice(questionIndex + submittedQuestion.length);
  }

  let commonPrefixLength = 0;
  const maxPrefixLength = Math.min(snapshot.length, baselineBodyText.length);
  while (
    commonPrefixLength < maxPrefixLength &&
    snapshot.charCodeAt(commonPrefixLength) === baselineBodyText.charCodeAt(commonPrefixLength)
  ) {
    commonPrefixLength += 1;
  }
  return snapshot.slice(commonPrefixLength);
}

/** 尝试停止千问当前异常生成；若生成已自行结束，同样视为恢复成功。 */
async function stopQianwenGeneration(page: Page): Promise<boolean> {
  if (!await isAnswerGenerating(page)) return true;

  const controls = await page.locator("button, [role='button']").all().catch(() => []);
  for (const control of controls.slice().reverse()) {
    const [visible, text] = await Promise.all([
      control.isVisible().catch(() => false),
      control.evaluate((element) => [
        element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || ""
      ].join(" ")).catch(() => "")
    ]);
    if (!visible || !/停止生成|停止回答|暂停生成|中止生成|Stop generating|Stop responding/i.test(text)) {
      continue;
    }
    const clicked = await control.click({ timeout: 2_000 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await page.waitForTimeout(500);
    return !await isAnswerGenerating(page);
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(500);
  return !await isAnswerGenerating(page);
}

/** 统计问题文本在页面中的出现次数，用于识别本轮问题是否已经回显。 */
function countTextOccurrences(text: string, value: string): number {
  if (!value) return 0;
  return text.split(value).length - 1;
}

/** 从可见按钮文案中识别平台是否仍在生成回答。 */
async function isAnswerGenerating(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`
(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  return Array.from(document.querySelectorAll("button, [role='button']"))
    .filter(isVisible)
    .some((element) => {
      const text = [
        element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || ""
      ].join(" ");
      return /停止生成|停止回答|暂停生成|中止生成|Stop generating|Stop responding/i.test(text);
    });
})()
`).catch(() => false);
}

/** 没有平台专属信号时，以整页正文连续不变作为回答完成的通用兜底。 */
async function waitForAnswerStable(page: Page, timeoutMs: number, stableWindowMs: number, minWaitMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastSnapshot = "";
  let stableSince = Date.now();

  await page.waitForTimeout(2_000);
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      stableSince = Date.now();
    }

    if (Date.now() - stableSince >= stableWindowMs && Date.now() - startedAt >= minWaitMs) return;
    await page.waitForTimeout(1_000);
  }
}
