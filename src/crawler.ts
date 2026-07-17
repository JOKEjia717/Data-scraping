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

interface TrackedAnswerBaseline {
  bodyText: string;
  documentBottom: number;
  referenceCount: number;
}

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
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    await waitForReadyToSend(page, config, options.timeoutMs);
    await activateWebSearch(page, config);
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
    if (config.id === "doubao") {
      const revealed = await revealLatestDoubaoReferenceList(
        page,
        config.referenceRevealSelectors,
        baselineDoubaoSearchBlockCount,
        submittedQuestion
      );
      if (!revealed) {
        throw new Error("[豆包] 当前回答结束后仍未找到最新的参考文献容器或展开入口，已停止，避免下一题数据错位。");
      }
      const stable = await waitForDoubaoReferenceListStable(
        page,
        baselineDoubaoSearchBlockCount,
        15_000,
        submittedQuestion
      );
      if (!stable) {
        throw new Error("[豆包] 当前回答的参考文献列表在 15 秒内没有加载稳定，已停止，避免漏抓或跨题抓取。");
      }
    } else if (config.id === "deepseek") {
      const expectedCount = await revealLatestDeepSeekReferenceList(page, 30_000);
      if (expectedCount === 0) {
        throw new Error("[DeepSeek] 没有找到当前回答末尾 class=f93f59e4 的‘X个网页’按钮，或点击后未打开 ._223dd7b 引用列表，已停止后续问题。");
      }
      const stable = await waitForDeepSeekReferenceListStable(page, 15_000, expectedCount);
      if (!stable) {
        throw new Error(`[DeepSeek] ._223dd7b 参考文献列表在 15 秒内没有加载稳定（按钮标注 ${expectedCount} 个网页），已停止，避免漏抓或跨题抓取。`);
      }
    } else if (config.id === "yuanbao") {
      const baselineTriggerCount = trackedBaseline?.referenceCount ?? 0;
      const revealed = await revealLatestYuanbaoReferenceList(
        page,
        baselineTriggerCount,
        30_000
      );
      if (!revealed) {
        throw new Error(
          "[元宝] 没有找到当前回答最新的 ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b 入口，" +
          "或点击后未加载 agent-dialogue-references__list，已停止后续问题。"
        );
      }
      const stable = await waitForYuanbaoReferenceListStable(page, 15_000);
      if (!stable) {
        throw new Error("[元宝] agent-dialogue-references__list 的直接子 li 在 15 秒内没有加载稳定，已停止以避免漏抓。");
      }
    } else if (config.id === "qianwen") {
      let baselineTriggerCount = trackedBaseline?.referenceCount ?? 0;
      let expectedCount = await revealLatestQianwenReferenceList(page, baselineTriggerCount, 30_000);
      if (expectedCount === 0) {
        console.log("[千问] 本题首次回答没有出现 link-title-igf0OC 参考入口，自动重新生成一次。");
        const regenerationBaseline = await snapshotTrackedAnswerBaseline(page, "qianwen");
        const clicked = await clickLatestQianwenRegenerate(page);
        if (!clicked) {
          throw new Error("[千问] 首次回答没有参考入口，且未找到最新回答的 reg_svg 重新生成按钮，已停止后续问题。");
        }

        await waitForAnswerComplete(page, config, options.timeoutMs, regenerationBaseline, "");
        await scrollToBottom(page);
        baselineTriggerCount = regenerationBaseline.referenceCount;
        expectedCount = await revealLatestQianwenReferenceList(page, baselineTriggerCount, 30_000);
      }
      if (expectedCount === 0) {
        throw new Error("[千问] 重新生成一次后仍没有 link-title-igf0OC 参考入口，或点击后未打开 list-XPxyL2，已停止后续问题。");
      }
      const stable = await waitForQianwenReferenceListStable(page, 15_000, expectedCount);
      if (!stable) {
        throw new Error(`[千问] list-XPxyL2 的直接子 div 在 15 秒内没有加载稳定（入口标注 ${expectedCount} 条），已停止以避免漏抓或跨题抓取。`);
      }
    } else {
      await revealReferencePanels(page, config.referenceRevealSelectors);
      await page.waitForTimeout(800);
    }

    const extractionBaseline = config.id === "doubao" ? baselineDoubaoSearchBlockCount : baselineBottom;
    const extractedRecords = await extractReferences(page, question, config.name, extractionBaseline);
    if (config.id === "yuanbao") await closeYuanbaoReferencePanel(page);
    const questionRecords = options.resolveTitles && config.id === "deepseek"
      ? await resolveRecordTitles(extractedRecords)
      : extractedRecords;
    console.log(`[${config.name}] 抽取到 ${questionRecords.length} 条参考链接`);
    if ((config.id === "doubao" || config.id === "deepseek" || config.id === "qianwen" || config.id === "yuanbao") && questionRecords.length === 0) {
      throw new Error(`[${config.name}] 本题没有抽取到引用数据，已停止后续问题，避免问题与数据错位。`);
    }
    if (questionRecords.length === 0 && baselineRevealButtonCount > 0) {
      console.log(`[${config.name}] 提醒：页面有参考入口，但本题没有抽取到外部链接，可能需要补充 ${config.name} 的引用面板选择器。`);
    }
    records.push(...questionRecords);
    await onProgress?.(records);
  }

  return records;
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => undefined);
  await page.waitForTimeout(500);
}

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

async function ensureReadyForInput(page: Page, config: PlatformConfig): Promise<void> {
  const inputBox = await findInput(page, config.inputSelectors, 8_000);
  if (inputBox) return;

  throw new Error(`没有在已打开的 ${config.name} 标签页找到聊天输入框，请确认页面已登录并停留在可提问界面。`);
}

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

function countTextOccurrences(text: string, value: string): number {
  if (!value) return 0;
  return text.split(value).length - 1;
}

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
