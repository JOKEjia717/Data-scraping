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
  countYuanbaoReferenceTriggers,
  extractReferences,
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
import type { PlatformConfig, ReferenceRecord } from "./types.js";

export interface CrawlPlatformOptions {
  cdpEndpoint: string;
  questions: string[];
  promptPrefix: string;
  resolveTitles: boolean;
  timeoutMs: number;
}

/** 提问前的页面快照，用于区分历史内容与本题新增回答。 */
interface TrackedAnswerBaseline {
  bodyText: string;
  documentBottom: number;
  referenceCount: number;
}

const REFERENCE_CHECK_ATTEMPTS = 3;
const REFERENCE_REVEAL_TIMEOUT_MS = 10_000;
const REFERENCE_STABLE_TIMEOUT_MS = 5_000;
const REFERENCE_CHECK_INTERVAL_MS = 1_500;

/**
 * 抓取单个平台的全部问题。单题引用缺失会在三次检查后跳过，登录失效、
 * 输入框不可用或回答生命周期无法确认等平台级错误仍会停止当前任务。
 */
export async function crawlPlatform(
  config: PlatformConfig,
  options: CrawlPlatformOptions,
  onProgress?: (records: ReferenceRecord[]) => Promise<void>
): Promise<ReferenceRecord[]> {
  const browser = await chromium.connectOverCDP(options.cdpEndpoint);
  const page = findExistingPage(browser.contexts().flatMap((context) => context.pages()), config);
  if (!page) {
    throw new Error(
      `没有找到已打开的 ${config.name} 标签页。请先在已开启远程调试端口的浏览器里打开 ${config.url}`
    );
  }
  await ensureReadyForInput(page, config);
  const records: ReferenceRecord[] = [];

  for (const [index, question] of options.questions.entries()) {
    console.log(`\n[${config.name}] ${index + 1}/${options.questions.length} ${question}`);
    // 元宝引用抽屉会遮挡页面并污染下一题基线，因此提问前后都主动关闭。
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    await waitForReadyToSend(page, config, options.timeoutMs);
    await activateWebSearch(page, config);

    // 所有基线必须在发送问题前采集，之后只接受相对基线新增的回答和引用入口。
    const baselineBottom = await snapshotDocumentBottom(page);
    const baselineDoubaoSearchBlockCount = config.id === "doubao"
      ? await countDoubaoSearchResultBlocks(page)
      : 0;
    const baselineRevealButtonCount = await countReferenceRevealButtons(page, config.referenceRevealSelectors);
    const submittedQuestion = `${options.promptPrefix}${question}`;
    const trackedBaseline = config.id === "doubao" || config.id === "deepseek" || config.id === "qianwen" || config.id === "yuanbao"
      ? await snapshotTrackedAnswerBaseline(page, config.id)
      : undefined;
    await submitQuestion(page, config, submittedQuestion);
    await waitForAnswerComplete(page, config, options.timeoutMs, trackedBaseline, submittedQuestion);
    await scrollToBottom(page);

    // 引用入口缺失或列表未稳定只影响当前题；三次检查失败后保留空结果并继续。
    const referenceReady = await prepareCurrentReferenceList(
      page,
      config,
      options.timeoutMs,
      trackedBaseline,
      baselineDoubaoSearchBlockCount,
      submittedQuestion
    );
    if (!referenceReady) {
      if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
      console.log(
        `[${config.name}] 跳过本题：检查 ${REFERENCE_CHECK_ATTEMPTS} 次后仍没有可用参考资料。`
      );
      if (baselineRevealButtonCount > 0) {
        console.log(`[${config.name}] 页面存在历史参考入口，但没有确认到属于本题的有效引用列表。`);
      }
      await onProgress?.(records);
      continue;
    }

    const extractionBaseline = config.id === "doubao" ? baselineDoubaoSearchBlockCount : baselineBottom;
    const extractedRecords = await extractReferencesWithRetries(
      page,
      question,
      config.name,
      extractionBaseline
    );
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    const questionRecords = options.resolveTitles && config.id === "deepseek"
      ? await resolveRecordTitles(extractedRecords)
      : extractedRecords;
    console.log(`[${config.name}] 抽取到 ${questionRecords.length} 条参考链接`);
    if (questionRecords.length === 0) {
      console.log(
        `[${config.name}] 跳过本题：引用面板已打开，但连续 ${REFERENCE_CHECK_ATTEMPTS} 次没有解析到有效外部链接。`
      );
      await onProgress?.(records);
      continue;
    }
    records.push(...questionRecords);
    // 每完成一道题就通知入口层写盘，而不是等待整个平台全部结束。
    await onProgress?.(records);
  }

  if (options.questions.length > 0) {
    const opened = await openNewConversation(
      page,
      config,
      options.questions[options.questions.length - 1]
    );
    console.log(
      opened
        ? `[${config.name}] 本轮问题已完成，已自动创建新对话。`
        : `[${config.name}] 本轮问题已完成，但没有找到可用的新对话入口；数据已正常保存。`
    );
  }

  return records;
}

/**
 * 最多检查三次当前题的引用入口和列表稳定性。千问第一次没有入口时仍允许
 * 自动重新生成一次，但重新生成也计入这三次检查流程，不会无限重试。
 */
async function prepareCurrentReferenceList(
  page: Page,
  config: PlatformConfig,
  answerTimeoutMs: number,
  trackedBaseline: TrackedAnswerBaseline | undefined,
  baselineDoubaoSearchBlockCount: number,
  submittedQuestion: string
): Promise<boolean> {
  let referenceTriggerBaseline = trackedBaseline?.referenceCount ?? 0;
  let qianwenRegenerated = false;

  for (let attempt = 1; attempt <= REFERENCE_CHECK_ATTEMPTS; attempt += 1) {
    const ready = await checkCurrentReferenceListOnce(
      page,
      config,
      referenceTriggerBaseline,
      baselineDoubaoSearchBlockCount,
      submittedQuestion
    ).catch((error) => {
      console.log(`[${config.name}] 第 ${attempt} 次参考资料检查异常：${formatError(error)}`);
      return false;
    });
    if (ready) return true;

    if (config.id === "qianwen" && !qianwenRegenerated) {
      qianwenRegenerated = true;
      console.log("[千问] 首次检查没有参考入口，自动重新生成一次后继续检查。");
      const regenerationBaseline = await snapshotTrackedAnswerBaseline(page, "qianwen");
      const clicked = await clickLatestQianwenRegenerate(page);
      if (clicked) {
        const started = await waitForQianwenRegenerationStart(page, regenerationBaseline, 15_000);
        if (started) {
          await waitForAnswerComplete(page, config, answerTimeoutMs, regenerationBaseline, "");
          await scrollToBottom(page);
          referenceTriggerBaseline = regenerationBaseline.referenceCount;
        } else {
          console.log("[千问] 已点击重新生成，但 15 秒内未检测到生成启动。");
        }
      } else {
        console.log("[千问] 未能打开重新生成菜单或点击重新生成项。");
      }
    }

    console.log(`[${config.name}] 第 ${attempt}/${REFERENCE_CHECK_ATTEMPTS} 次未找到可用参考资料。`);
    if (attempt < REFERENCE_CHECK_ATTEMPTS) {
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
  baselineDoubaoSearchBlockCount: number,
  submittedQuestion: string
): Promise<boolean> {
  if (config.id === "doubao") {
    const revealed = await revealLatestDoubaoReferenceList(
      page,
      config.referenceRevealSelectors,
      baselineDoubaoSearchBlockCount,
      submittedQuestion,
      REFERENCE_REVEAL_TIMEOUT_MS
    );
    return revealed && await waitForDoubaoReferenceListStable(
      page,
      baselineDoubaoSearchBlockCount,
      REFERENCE_STABLE_TIMEOUT_MS,
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
      referenceTriggerBaseline,
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
  for (let attempt = 1; attempt <= REFERENCE_CHECK_ATTEMPTS; attempt += 1) {
    const records = await extractReferences(page, question, platformName, extractionBaseline)
      .catch((error) => {
        console.log(`[${platformName}] 第 ${attempt} 次解析参考资料异常：${formatError(error)}`);
        return [];
      });
    if (records.length > 0) return records;

    console.log(`[${platformName}] 第 ${attempt}/${REFERENCE_CHECK_ATTEMPTS} 次解析结果为空。`);
    if (attempt < REFERENCE_CHECK_ATTEMPTS) {
      await page.waitForTimeout(REFERENCE_CHECK_INTERVAL_MS);
    }
  }
  return [];
}

/** 将未知异常转换为适合终端日志的一行文本。 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一个平台完成整轮问题后创建空白会话。
 *
 * 仅在点击后确认“会话地址变化、旧问题数量减少或旧问题消失”之一成立，
 * 并且页面重新出现可用输入框时才返回成功，避免把侧栏普通容器误判为新对话。
 */
export async function openNewConversation(
  page: Page,
  config: PlatformConfig,
  previousQuestion = "",
  timeoutMs = 15_000
): Promise<boolean> {
  const beforeUrl = page.url();
  const beforeBody = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const beforeQuestionCount = countTextOccurrences(beforeBody, previousQuestion);
  const startedAt = Date.now();

  for (const selector of config.newConversationButtonSelectors) {
    if (Date.now() - startedAt >= timeoutMs) break;
    const locators = await page.locator(selector).all().catch(() => []);

    for (const locator of locators.slice().reverse()) {
      if (Date.now() - startedAt >= timeoutMs) break;
      const [visible, enabled, box] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false),
        locator.boundingBox().catch(() => null)
      ]);
      // 新对话入口通常是按钮或较小的侧栏控件，过滤覆盖整页的大容器。
      if (!visible || !enabled || !box || box.width > 500 || box.height > 180) continue;

      const clicked = await locator.click({ timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return false;
      const ready = await waitForNewConversationReady(
        page,
        config,
        beforeUrl,
        beforeQuestionCount,
        previousQuestion,
        Math.min(remainingMs, 6_000)
      );
      if (ready) return true;
    }
  }

  return false;
}

/** 等待新会话完成切换，并确认空白会话的输入框已经可用。 */
async function waitForNewConversationReady(
  page: Page,
  config: PlatformConfig,
  beforeUrl: string,
  beforeQuestionCount: number,
  previousQuestion: string,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [bodyText, inputBox] = await Promise.all([
      page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
      findInput(page, config.inputSelectors, 500)
    ]);
    const currentQuestionCount = countTextOccurrences(bodyText, previousQuestion);
    const conversationChanged =
      page.url() !== beforeUrl ||
      (beforeQuestionCount > 0 && currentQuestionCount < beforeQuestionCount) ||
      (Boolean(previousQuestion) && !bodyText.includes(previousQuestion));

    if (inputBox && conversationChanged && !await isAnswerGenerating(page)) return true;
    await page.waitForTimeout(300);
  }

  return false;
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

/** 尝试打开平台联网搜索能力；已处于 pressed/checked 状态时不重复点击。 */
async function activateWebSearch(page: Page, config: PlatformConfig): Promise<void> {
  for (const selector of config.webSearchButtonSelectors) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice(0, 4)) {
      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;

      const pressed = await locator.getAttribute("aria-pressed").catch(() => null);
      const checked = await locator.getAttribute("aria-checked").catch(() => null);
      if (pressed === "true" || checked === "true") return;

      await locator.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      return;
    }
  }
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
  for (const selector of selectors) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice(-4)) {
      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;
      await locator.click({ timeout: 1000 }).catch(() => undefined);
      return true;
    }
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
  submittedQuestion = ""
): Promise<void> {
  if (config.id === "doubao" || config.id === "deepseek" || config.id === "qianwen" || config.id === "yuanbao") {
    if (!trackedBaseline) throw new Error(`[${config.name}] 缺少回答前页面快照，无法安全判断本题是否完成。`);
    await waitForTrackedAnswerComplete(
      page,
      timeoutMs,
      trackedBaseline,
      submittedQuestion,
      config.id,
      config.name
    );
    await waitForReadyToSend(page, config, 30_000);
    return;
  }

  await waitForAnswerStable(page, timeoutMs, 5_000, 8_000);
}

/** 采集正文、高度和平台专属引用结构数量，形成回答前基线。 */
async function snapshotTrackedAnswerBaseline(
  page: Page,
  platformId: "doubao" | "deepseek" | "qianwen" | "yuanbao"
): Promise<TrackedAnswerBaseline> {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const referenceLabel = platformId === "qianwen" ? "参考来源" : "引用来源";
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
          ? await countYuanbaoReferenceTriggers(page)
        : bodyText.split(referenceLabel).length - 1
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
  platformId: "doubao" | "deepseek" | "qianwen" | "yuanbao",
  platformName: string
): Promise<void> {
  const startedAt = Date.now();
  let lastSnapshot = baseline.bodyText;
  let stableSince = Date.now();
  let sawGenerating = false;
  let meaningfulChanges = 0;
  let sawAnswerStart = false;
  const referenceLabel = platformId === "qianwen" ? "参考来源" : "引用来源";
  const stableWindowMs = platformId === "yuanbao"
    ? 15_000
    : platformId === "doubao" || platformId === "deepseek" || platformId === "qianwen"
      ? 12_000
      : 10_000;
  const minWaitMs = platformId === "yuanbao" ? 20_000 : 15_000;
  let nextProgressLogAt = 30_000;
  const baselineQuestionOccurrences = countTextOccurrences(baseline.bodyText, submittedQuestion);

  await page.waitForTimeout(1_000);
  while (Date.now() - startedAt < timeoutMs) {
    const [snapshot, busy, documentBottom, structuredReferenceCount] = await Promise.all([
      page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
      isAnswerGenerating(page),
      snapshotDocumentBottom(page),
      platformId === "doubao"
        ? countDoubaoSearchResultBlocks(page)
        : platformId === "deepseek"
          ? countDeepSeekReferenceContainers(page)
          : platformId === "qianwen"
            ? countQianwenReferenceTriggers(page)
          : platformId === "yuanbao"
            ? countYuanbaoReferenceTriggers(page)
            : Promise.resolve(0)
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
        : platformId === "yuanbao"
          ? structuredReferenceCount
          : snapshot.split(referenceLabel).length - 1;
    const textGrowth = snapshot.length - baseline.bodyText.length - submittedQuestion.length;
    const bottomGrowth = documentBottom - baseline.documentBottom;
    const questionOccurrences = countTextOccurrences(snapshot, submittedQuestion);
    const sawSubmittedQuestion = Boolean(submittedQuestion) && questionOccurrences > baselineQuestionOccurrences;
    sawAnswerStart ||=
      sawGenerating ||
      sawSubmittedQuestion ||
      referenceCount > baseline.referenceCount ||
      (platformId === "yuanbao" && meaningfulChanges >= 3) ||
      ((platformId === "doubao" || platformId === "deepseek") && meaningfulChanges >= 3 && Math.abs(textGrowth) >= 60) ||
      (meaningfulChanges >= 3 && textGrowth >= 60) ||
      (bottomGrowth >= 250 && textGrowth >= 60);

    const elapsed = Date.now() - startedAt;
    const stableFor = Date.now() - stableSince;
    // 元宝出现新增引用入口即可确认回答阶段完成；其他平台继续等待正文稳定窗口。
    if (platformId === "yuanbao" && referenceCount > baseline.referenceCount && !busy) return;
    if (sawAnswerStart && !busy && stableFor >= stableWindowMs && elapsed >= minWaitMs) return;

    if ((platformId === "doubao" || platformId === "deepseek" || platformId === "qianwen") && elapsed >= nextProgressLogAt) {
      console.log(
        `[${platformName}] 回答仍在处理中，已等待 ${Math.round(elapsed / 1000)} 秒` +
        `（生成状态=${busy ? "生成中" : "阶段性稳定"}` +
        `，当前问题=${sawSubmittedQuestion ? "已出现" : "未出现"}` +
        `，引用结构变化=${referenceCount - baseline.referenceCount}）`
      );
      nextProgressLogAt += 30_000;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`[${platformName}] 等待本题回答完整结束超时，已停止后续问题以避免题目与来源数据错位。可增大 --timeout-ms 后重试。`);
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
