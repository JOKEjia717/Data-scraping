/**
 * 引用面板展开、稳定性检测与字段抽取模块。
 *
 * 结构化平台只读取“当前回答最新引用容器”的直接子节点，避免历史回答、正文链接
 * 和导航链接混入结果。文件中的字符串脚本在浏览器页面上下文执行，外层函数负责
 * Playwright 定位、等待与最终标准化。
 */
import type { Locator, Page } from "playwright";
import type { RawReferenceCandidate, ReferenceRecord, SearchResultCandidate } from "./types.js";
import {
  chooseTitle,
  cleanText,
  extractDate,
  platformFromReferenceTitle,
  platformFromUrl,
  unwrapUrl
} from "./text.js";

// 平台专属稳定选择器。class 变化时需同步更新 README 和测试夹具。
const DOUBAO_SEARCH_BLOCK_SELECTOR = '[data-plugin-identifier*="search_query_result_block"]';
const DOUBAO_REFERENCE_CONTAINER_SELECTOR =
  '[class~="relative"][class~="mt-[-8px]"][class~="flex-col"]';
const DEEPSEEK_REFERENCE_CONTAINER_SELECTOR = '[class~="_223dd7b"]';
const QIANWEN_REFERENCE_TRIGGER_SELECTOR = '[class~="link-title-igf0OC"]';
const QIANWEN_REFERENCE_LIST_SELECTOR = '[class~="list-XPxyL2"]';
const QIANWEN_ANSWER_ACTION_SELECTOR =
  '[class~="hover:bg-tag"][class~="flex"][class~="size-6"][class~="cursor-pointer"]' +
  '[class~="items-center"][class~="justify-center"][class~="rounded"]' +
  '[class~="transition-colors"][class~="duration-200"]';
const QIANWEN_REGENERATE_MENU_ITEM_SELECTOR =
  '[role="menuitem"][class~="relative"][class~="min-w-0"][class~="flex"][class~="h-9"]' +
  '[class~="cursor-pointer"][class~="select-none"][class~="items-center"][class~="gap-2"]' +
  '[class~="rounded-8"][class~="px-3"][class~="py-1.5"][class~="text-sm"]';
const YUANBAO_REFERENCE_TRIGGER_SELECTOR =
  ".ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b";
const YUANBAO_REFERENCE_LIST_SELECTOR = ".agent-dialogue-references__list";
const YUANBAO_OPEN_REFERENCE_LIST_SELECTOR =
  ".t-drawer--open .agent-dialogue-references__list";

/** 豆包列表的轻量快照，用于判断容器是否命中以及引用是否加载稳定。 */
interface DoubaoReferenceListSnapshot {
  found: boolean;
  visible: boolean;
  score: number;
  containerClass: string;
  directChildCount: number;
  linkedChildCount: number;
  expectedCount: number;
  urls: string[];
}

interface DoubaoReferenceExtraction extends DoubaoReferenceListSnapshot {
  items: SearchResultCandidate[];
}

// AI 平台自身或内部跳转域名不能作为外部参考文章输出。
const INTERNAL_HOST_PATTERNS = [
  /(^|\.)doubao\.com$/,
  /(^|\.)deepseek\.com$/,
  /(^|\.)qianwen\.com$/,
  /(^|\.)qwen\.ai$/,
  /^yuanbao\.tencent\.com$/,
  /^yuanbao\.qq\.com$/,
  /^hunyuan\.tencent\.com$/,
  /(^|\.)aliyun\.com$/,
  /(^|\.)volces\.com$/,
  /(^|\.)bytedance\.com$/
];

// 以下脚本在浏览器页面上下文执行，返回值必须保持可序列化。
const COUNT_HTTP_ANCHORS_SCRIPT = `
(() => {
  return Array.from(document.querySelectorAll("a[href]"))
    .filter((anchor) => anchor.href.startsWith("http://") || anchor.href.startsWith("https://"))
    .length;
})()
`;

/** 通用兼容路径：扫描页面链接并收集邻近文本，不用于四个平台的主流程。 */
const EXTRACT_REFERENCES_SCRIPT = `
(() => {
  const scoreAnchor = (anchor) => {
    const rect = anchor.getBoundingClientRect();
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const height = Number.isFinite(document.body.scrollHeight) ? document.body.scrollHeight : 0;
    const y = Math.max(top + window.scrollY, 0);
    return y || height;
  };

  const contextFor = (anchor) => {
    let node = anchor;
    let best = anchor.textContent || "";
    for (let i = 0; i < 7 && node && node.parentElement; i += 1) {
      node = node.parentElement;
      const text = node instanceof HTMLElement ? node.innerText : node.textContent || "";
      if (text.length >= 8 && text.length <= 1200) {
        best = text;
      }
    }
    return best;
  };

  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();

  const isOnlyMarksAndNumbers = (text) => {
    const marks = "[]()（）0123456789 .,\，。:：;；-_/";
    return text.split("").every((char) => marks.includes(char));
  };

  const looksLikeTitle = (line, anchorText) => {
    const value = clean(line);
    const linkText = clean(anchorText);
    return (
      value.length >= 8 &&
      value.length <= 140 &&
      value !== linkText &&
      !value.startsWith("http://") &&
      !value.startsWith("https://") &&
      !isOnlyMarksAndNumbers(value) &&
      !/^(打开|复制|分享|更多|参考|来源|引用|网页|搜索|查看|展开|收起|登录|注册|DeepSeek)$/i.test(value) &&
      !/(^|\\s)(http|www\\.)/i.test(value)
    );
  };

  const cardTitleFor = (anchor) => {
    let node = anchor;
    const anchorText = anchor.innerText || anchor.textContent || "";
    for (let i = 0; i < 7 && node; i += 1) {
      const text = node instanceof HTMLElement ? node.innerText : node.textContent || "";
      const lines = text
        .split(/[\\n\\r]+| {2,}/)
        .map(clean)
        .filter((line) => looksLikeTitle(line, anchorText));

      if (lines.length > 0 && text.length <= 700) {
        return lines
          .sort((a, b) => {
            const aScore = (/[\\u4e00-\\u9fa5]/.test(a) ? 100 : 0) + Math.min(a.length, 80);
            const bScore = (/[\\u4e00-\\u9fa5]/.test(b) ? 100 : 0) + Math.min(b.length, 80);
            return bScore - aScore;
          })[0];
      }
      node = node.parentElement;
    }
    return "";
  };

  return Array.from(document.querySelectorAll("a[href]"))
    .map((anchor, domIndex) => ({
      domIndex,
      score: scoreAnchor(anchor),
      anchor
    }))
    .map(({ anchor, domIndex }) => ({
      domIndex,
      score: scoreAnchor(anchor),
      href: anchor.href,
      anchorText: anchor.innerText || anchor.textContent || "",
      cardTitle: cardTitleFor(anchor),
      contextText: contextFor(anchor),
      titleAttr: anchor.getAttribute("title") || "",
      ariaLabel: anchor.getAttribute("aria-label") || ""
    }))
    .filter((item) => item.href.startsWith("http://") || item.href.startsWith("https://"))
    .sort((a, b) => a.score - b.score || a.domIndex - b.domIndex);
})()
`;

/** DeepSeek：只解析最后一个可见 _223dd7b 容器的直接引用卡片。 */
const EXTRACT_DEEPSEEK_SEARCH_RESULTS_SCRIPT = `
(() => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const datePattern = /(?:19|20)\\d{2}[年\\/.-]\\d{1,2}[月\\/.-]\\d{1,2}日?|\\d+\\s*(?:天|小时|分钟)前|今天|昨天/;

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };

  const getAttr = (element, names) => {
    if (!element) return "";
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) return clean(value);
    }
    return "";
  };

  const containers = Array.from(document.querySelectorAll('[class~="_223dd7b"]')).filter(isVisible);
  const container = containers[containers.length - 1];
  if (!container) return [];

  // DeepSeek 的每条来源是 _223dd7b 的一个直接子节点。当前页面版本使用 div，
  // 也兼容截图中出现的直接 a 子节点，避免因小版本 DOM 调整漏抓。
  const cards = Array.from(container.children).filter((element) =>
    element.matches("a[href], [data-url], [data-href]") ||
    Boolean(element.querySelector("a[href], [data-url], [data-href]"))
  );
  const resultByUrl = new Map();

  for (const [domIndex, card] of cards.entries()) {
    const urlNode = card.matches("a[href], [data-url], [data-href]")
      ? card
      : card.querySelector("a[href], [data-url], [data-href]");
    const href = urlNode instanceof HTMLAnchorElement
      ? urlNode.href
      : getAttr(urlNode, ["href", "data-url", "data-href"]);
    if (!/^https?:\\/\\//i.test(href)) continue;

    const rawText = card instanceof HTMLElement ? card.innerText : card.textContent || "";
    const text = clean(rawText);
    const lines = rawText.split(/[\\n\\r]+/).map(clean).filter(Boolean);
    const dateLineIndex = lines.findIndex((line) => datePattern.test(line));
    const dateLine = dateLineIndex >= 0 ? lines[dateLineIndex] : "";
    const explicitTitleNode = card.querySelector(
      "[data-title], h1, h2, h3, h4, [class*='title'], [class*='Title']"
    );
    const explicitTitle = clean(
      getAttr(explicitTitleNode, ["data-title", "title"]) || explicitTitleNode?.textContent || ""
    );
    const attributeTitle = clean(getAttr(urlNode, ["data-title", "title", "aria-label"]));
    const lineAfterDate = dateLineIndex >= 0 ? clean(lines[dateLineIndex + 1] || "") : "";
    const usableLines = lines.filter((line) =>
      line.length >= 4 &&
      line.length <= 180 &&
      !datePattern.test(line) &&
      !/^https?:\\/\\//i.test(line) &&
      !/^\\[?\\d+\\]?$/.test(line) &&
      !/^(打开|复制|分享|更多|参考|来源|引用|网页|搜索|查看|展开|收起)$/i.test(line)
    );
    const title = [explicitTitle, attributeTitle, lineAfterDate, ...usableLines].find(Boolean) || "";
    if (!title) continue;

    const sourceNode = card.querySelector(
      "[data-source], [data-source-name], [class*='source'], [class*='Source'], [class*='site'], [class*='media']"
    );
    const sourceFromNode = clean(
      getAttr(sourceNode, ["data-source", "data-source-name"]) || sourceNode?.textContent || ""
    );
    const sourceFromDateLine = clean(dateLine.replace(datePattern, "").replace(/[|｜·\\s]+$/, ""));
    const sourceFromPreviousLine = dateLineIndex > 0 ? lines[dateLineIndex - 1] : "";
    const platform = [sourceFromNode, sourceFromDateLine, sourceFromPreviousLine]
      .map(clean)
      .find((value) => value && value !== title && value.length <= 80) || "";

    const summaryNode = card.querySelector(
      "[data-summary], p, [class*='summary'], [class*='Summary'], [class*='desc'], [class*='Desc']"
    );
    const explicitSummary = clean(
      getAttr(summaryNode, ["data-summary"]) || summaryNode?.textContent || ""
    );
    const titleLineIndex = lines.findIndex((line) => clean(line) === title);
    const summary = [explicitSummary, titleLineIndex >= 0 ? lines[titleLineIndex + 1] : ""]
      .map(clean)
      .find((value) => value && value !== title && !datePattern.test(value)) || "";
    const referenceNumber = Number.parseInt(
      getAttr(card, ["data-index", "data-idx", "data-rank"]) ||
      text.match(/^\\s*\\[?(\\d+)\\]?/)?.[1] ||
      "",
      10
    );
    const candidate = {
      score: domIndex,
      href,
      platform,
      articleTime: dateLine.match(datePattern)?.[0] || text.match(datePattern)?.[0] || "",
      title,
      summary,
      referenceNumber: Number.isFinite(referenceNumber) ? referenceNumber : domIndex + 1,
      contextText: text
    };

    if (!resultByUrl.has(href)) resultByUrl.set(href, candidate);
  }

  return Array.from(resultByUrl.values()).sort((a, b) =>
    (a.referenceNumber || Number.MAX_SAFE_INTEGER) - (b.referenceNumber || Number.MAX_SAFE_INTEGER) || a.score - b.score
  );
})()
`;

/** 千问：解析最后一个可见 list-XPxyL2 的直接子 div 和埋点数据属性。 */
const EXTRACT_QIANWEN_SEARCH_RESULTS_SCRIPT = `
(() => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const datePattern = /(?:19|20)\\d{2}年\\d{1,2}月\\d{1,2}日/;
  const domainPattern = /(?:[a-z0-9-]+\\.)+[a-z]{2,}/i;

  const scoreElement = (element) => {
    const rect = element.getBoundingClientRect();
    return Math.max((Number.isFinite(rect.top) ? rect.top : 0) + window.scrollY, 0);
  };

  const resultByKey = new Map();

  const parseJsonAttr = (element) => {
    for (const attr of ["data-exposure-extra", "data-click-extra"]) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      try {
        return JSON.parse(value);
      } catch {
        try {
          return JSON.parse(value.replace(/&quot;/g, '"'));
        } catch {
          // Ignore malformed telemetry attributes.
        }
      }
    }
    return null;
  };

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const lists = Array.from(document.querySelectorAll('[class~="list-XPxyL2"]')).filter(isVisible);
  const list = lists[lists.length - 1];
  if (!list) return [];
  const cards = Array.from(list.querySelectorAll(":scope > div"));

  for (const element of cards) {
    const telemetryNode = element.matches("[data-exposure-extra], [data-click-extra]")
      ? element
      : element.querySelector("[data-exposure-extra], [data-click-extra]");
    const data = parseJsonAttr(telemetryNode || element) || {};

    const rawText = element instanceof HTMLElement ? element.innerText : element.textContent || "";
    const text = clean(rawText);
    const link = element.querySelector("a[href], [data-url], [data-href]");
    const linkHref = link instanceof HTMLAnchorElement
      ? link.href
      : link?.getAttribute("data-url") || link?.getAttribute("data-href") || link?.getAttribute("href") || "";
    const titleNode = element.querySelector("h1,h2,h3,h4,[data-title],[class*='title'],[class*='Title']");
    const title = clean(
      data.title || data.name || titleNode?.getAttribute("data-title") || titleNode?.textContent || link?.textContent || ""
    ).replace(/^\\d+\\s*/, "");
    const href = clean(data.url || data.ref_url || data.href || linkHref);
    if (!title || !href || (!href.startsWith("http://") && !href.startsWith("https://"))) continue;

    const referenceNumber = Number.parseInt(String(data.refer_num || ""), 10);
    const lines = rawText.split(/[\\n\\r]+/).map(clean).filter(Boolean);
    const dateLine = lines.find((line) => datePattern.test(line)) || "";
    let host = "";
    try { host = new URL(href).hostname.replace(/^www\\./, ""); } catch {}
    const domain = lines.find((line) => domainPattern.test(line) && line.length <= 120)?.match(domainPattern)?.[0]
      || host
      || "";
    const metaLine = lines.find((line) => {
      const value = line.replace(domainPattern, "").trim();
      const normalizedLine = line.replace(/^\\d+\\s*/, "");
      return value.length >= 2 && value.length <= 40 && normalizedLine !== title && !datePattern.test(line) && !/^\\d+$/.test(line);
    }) || "";
    const sourceNode = element.querySelector(
      "[data-source], [data-source-name], [class*='source-name'], [class*='sourceName'], [class*='source_txt']"
    );
    const explicitSource = clean(
      sourceNode?.getAttribute("data-source") ||
      sourceNode?.getAttribute("data-source-name") ||
      sourceNode?.textContent ||
      ""
    );
    const platform = clean(
      (data.source || data.source_name || data.site || data.media || explicitSource || metaLine)
        .replace(domainPattern, "")
        .replace(/[|｜]/g, " ")
        .trim()
    );

    const summary = clean(
      dateLine.replace(datePattern, "").replace(/^[\\s—–|｜·:：-]+/, "") ||
      lines.find((line) => line !== title && line !== metaLine && !/^\\d+$/.test(line) && line.length > 30) ||
      ""
    );
    const candidate = {
      score: scoreElement(element),
      href,
      platform: platform || domain,
      articleTime: dateLine.match(datePattern)?.[0] || text.match(datePattern)?.[0] || "",
      title,
      summary,
      referenceNumber: Number.isFinite(referenceNumber) ? referenceNumber : undefined,
      contextText: text
    };
    const key = href + "::" + title;
    const existing = resultByKey.get(key);
    if (!existing || candidate.contextText.length < existing.contextText.length) {
      resultByKey.set(key, candidate);
    }
  }

  return Array.from(resultByKey.values()).sort((a, b) =>
    (a.referenceNumber || Number.MAX_SAFE_INTEGER) - (b.referenceNumber || Number.MAX_SAFE_INTEGER) || a.score - b.score
  );
})()
`;

/** 元宝：解析已打开引用抽屉中主列表的直接子 li。 */
const EXTRACT_YUANBAO_REFERENCES_SCRIPT = `
(() => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const datePattern = /(?:19|20)\\d{2}[年\\/-]\\d{1,2}[月\\/-]\\d{1,2}日?|\\d+\\s*(?:天|小时|分钟)前|今天|昨天/;

  const scoreElement = (element) => {
    const rect = element.getBoundingClientRect();
    return Math.max((Number.isFinite(rect.top) ? rect.top : 0) + window.scrollY, 0);
  };

  const getAttr = (element, names) => {
    if (!element) return "";
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) return clean(value);
    }
    return "";
  };

  const resultByKey = new Map();
  const openList = document.querySelector(".t-drawer--open .agent-dialogue-references__list");
  const lists = Array.from(document.querySelectorAll(".agent-dialogue-references__list"))
    .filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  const list = openList || lists[lists.length - 1];
  if (!list) return [];

  const candidates = Array.from(list.querySelectorAll(":scope > li"));

  for (const [domIndex, element] of candidates.entries()) {
    const rawText = element instanceof HTMLElement ? element.innerText : element.textContent || "";
    const text = clean(rawText);
    const card = element.querySelector(".hyc-common-markdown__ref_card[data-url], [data-url]");
    const url =
      getAttr(card, ["data-url", "href"]) ||
      getAttr(element, ["dt-ext6", "dt-url", "data-url", "href"]);

    const title = clean(
      card?.querySelector("h1,h2,h3,h4,[class*='ref_card-title'],[class*='title']")?.textContent ||
      element.querySelector("h1,h2,h3,h4,[class*='ref_card-title']")?.textContent ||
      getAttr(card, ["data-title", "title"])
    );
    const summary = clean(
      card?.querySelector("p,[class*='ref_card-desc'],[class*='desc']")?.textContent ||
      element.querySelector("p,[class*='ref_card-desc']")?.textContent ||
      ""
    );
    const platform = clean(
      element.querySelector("[class*='source_txt'],[class*='source-text'],[class*='sourceText']")?.textContent ||
      getAttr(element, ["dt-ext3"])
    );

    if (!title || !url || (!url.startsWith("http://") && !url.startsWith("https://"))) continue;

    const date = text.match(datePattern)?.[0] || "";
    const referenceNumber = Number.parseInt(getAttr(card, ["data-idx"]), 10);
    const key = url + "::" + title;
    const candidate = {
      score: domIndex,
      href: url,
      platform,
      articleTime: date,
      title,
      summary,
      referenceNumber: Number.isFinite(referenceNumber) ? referenceNumber : domIndex + 1,
      contextText: text
    };

    const existing = resultByKey.get(key);
    if (!existing || candidate.contextText.length < existing.contextText.length) {
      resultByKey.set(key, candidate);
    }
  }

  return Array.from(resultByKey.values()).sort((a, b) =>
    (a.referenceNumber || Number.MAX_SAFE_INTEGER) - (b.referenceNumber || Number.MAX_SAFE_INTEGER) || a.score - b.score
  );
})()
`;

/**
 * 从提问前搜索块数量之后寻找豆包最新引用容器。currentQuestion 用于长会话
 * 删除旧 DOM、复用块数量时重新定位当前回答；includeItems 控制是否解析完整卡片。
 */
async function evaluateDoubaoReferenceList(
  page: Page,
  minBlockIndex: number,
  includeItems: boolean,
  currentQuestion = ""
): Promise<DoubaoReferenceExtraction> {
  const emptyResult: DoubaoReferenceExtraction = {
    found: false,
    visible: false,
    score: 0,
    containerClass: "",
    directChildCount: 0,
    linkedChildCount: 0,
    expectedCount: 0,
    urls: [],
    items: []
  };
  const allBlocks = await page.locator(DOUBAO_SEARCH_BLOCK_SELECTOR).all().catch(() => []);
  let firstBlockIndex = Math.max(minBlockIndex, 0);
  if (firstBlockIndex >= allBlocks.length && allBlocks.length > 0 && currentQuestion) {
    const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    const questionIndex = bodyText.lastIndexOf(currentQuestion);
    const currentAnswerText = questionIndex >= 0 ? bodyText.slice(questionIndex + currentQuestion.length) : "";
    const currentAnswerHasReferences = /搜索\s*\d+\s*个关键词，\s*参考\s*\d+\s*篇资料/.test(currentAnswerText);
    if (currentAnswerHasReferences) {
      // 豆包长会话会移除最早回答并复用列表长度；当前回答通常对应末尾的“结果块 + 空占位块”。
      firstBlockIndex = Math.max(allBlocks.length - 2, 0);
    }
  }
  const blocks = allBlocks.slice(firstBlockIndex);
  const candidates: Array<{
    block: Locator;
    blockIndex: number;
    container: Locator;
    containerIndex: number;
    directChildren: Locator[];
    linkedChildCount: number;
    structuralWeight: number;
    score: number;
  }> = [];

  for (const [relativeBlockIndex, block] of blocks.entries()) {
    const blockIndex = firstBlockIndex + relativeBlockIndex;
    const containers = await block.locator(DOUBAO_REFERENCE_CONTAINER_SELECTOR).all().catch(() => []);
    for (const [containerIndex, container] of containers.entries()) {
      const visible = await container.isVisible().catch(() => false);
      if (!visible) continue;

      const score = await container.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return Math.max((Number.isFinite(rect.top) ? rect.top : 0) + window.scrollY, 0);
      }).catch(() => 0);
      const directChildren = await container.locator(":scope > div").all().catch(() => []);
      if (directChildren.length === 0) continue;

      let linkedChildCount = 0;
      for (const child of directChildren) {
        if (await hasDoubaoUrlNode(child)) linkedChildCount += 1;
      }
      if (linkedChildCount === 0) continue;

      const containerClass = await container.getAttribute("class").catch(() => "") || "";
      const classTokens = new Set(containerClass.split(/\s+/).filter(Boolean));
      const structuralWeight = ["flex", "w-full", "min-w-0"]
        .filter((token) => classTokens.has(token)).length;
      candidates.push({
        block,
        blockIndex,
        container,
        containerIndex,
        directChildren,
        linkedChildCount,
        structuralWeight,
        score
      });
    }
  }

  candidates.sort((a, b) =>
    a.blockIndex - b.blockIndex ||
    a.structuralWeight - b.structuralWeight ||
    a.containerIndex - b.containerIndex
  );
  const selected = candidates[candidates.length - 1];
  if (!selected) return emptyResult;

  const blockText = cleanText(await selected.block.innerText().catch(() => ""));
  const expectedCount = Number.parseInt(blockText.match(/参考\s*(\d+)\s*篇资料/)?.[1] || "", 10);
  const cardData: SearchResultCandidate[] = [];

  for (const [domIndex, child] of selected.directChildren.entries()) {
    const urlEntry = await findDoubaoUrlNode(child);
    if (!urlEntry) continue;

    const childText = cleanText(await child.innerText().catch(() => ""));
    const titleNode = child.locator(
      "[data-title], h1, h2, h3, h4, [class*='title'], [class*='Title']"
    ).first();
    const titleNodeExists = await titleNode.count().catch(() => 0) > 0;
    const [linkText, titleAttr, ariaLabel, linkDataTitle, titleNodeText, titleNodeDataTitle] = await Promise.all([
      urlEntry.node.innerText().catch(() => ""),
      urlEntry.node.getAttribute("title").catch(() => null),
      urlEntry.node.getAttribute("aria-label").catch(() => null),
      urlEntry.node.getAttribute("data-title").catch(() => null),
      titleNodeExists ? titleNode.innerText().catch(() => "") : Promise.resolve(""),
      titleNodeExists ? titleNode.getAttribute("data-title").catch(() => null) : Promise.resolve(null)
    ]);
    const title = [linkText, titleAttr, ariaLabel, linkDataTitle, titleNodeText, titleNodeDataTitle, childText]
      .map((value) => cleanText(value || ""))
      .find(Boolean)
      ?.replace(/^(?:\[?\d+\]?\s*[.、):：-]\s*|第\s*\d+\s*条\s*)/, "") || "";

    const sourceNode = child.locator(
      "[data-source], [data-source-name], [class*='source'], [class*='Source']"
    ).first();
    const sourceNodeExists = await sourceNode.count().catch(() => 0) > 0;
    const sourceText = sourceNodeExists ? await sourceNode.innerText().catch(() => "") : "";
    const platformCandidate = cleanText(
      await urlEntry.node.getAttribute("data-source").catch(() => null) ||
      await child.getAttribute("data-source").catch(() => null) ||
      await child.getAttribute("data-source-name").catch(() => null) ||
      sourceText
    );

    const summaryNode = child.locator(
      "[data-summary], p, [class*='summary'], [class*='Summary'], [class*='desc'], [class*='Desc']"
    ).first();
    const summaryNodeExists = await summaryNode.count().catch(() => 0) > 0;
    const summaryCandidate = summaryNodeExists
      ? cleanText(
          await summaryNode.getAttribute("data-summary").catch(() => null) ||
          await summaryNode.innerText().catch(() => "")
        )
      : "";

    cardData.push({
      score: selected.score + domIndex / 1000,
      href: urlEntry.href,
      platform: platformCandidate.length <= 80 ? platformCandidate : "",
      articleTime: "",
      title,
      summary: summaryCandidate && summaryCandidate !== title ? summaryCandidate : "",
      referenceNumber: domIndex + 1,
      contextText: childText
    });
  }

  return {
    found: true,
    visible: true,
    score: selected.score,
    containerClass: await selected.container.getAttribute("class").catch(() => "") || "",
    directChildCount: selected.directChildren.length,
    linkedChildCount: cardData.length,
    expectedCount: Number.isFinite(expectedCount) ? expectedCount : 0,
    urls: cardData.map((item) => item.href),
    items: includeItems ? cardData : []
  };
}

/** 判断豆包引用直接子节点自身或后代是否携带 URL。 */
async function hasDoubaoUrlNode(child: Locator): Promise<boolean> {
  const ownValues = await Promise.all([
    child.getAttribute("href").catch(() => null),
    child.getAttribute("data-url").catch(() => null),
    child.getAttribute("data-href").catch(() => null)
  ]);
  if (ownValues.some((value) => Boolean(value))) return true;
  return await child.locator("a[href], [data-url], [data-href]").count().catch(() => 0) > 0;
}

/** 返回豆包子卡片内第一个有效 HTTP(S) URL 节点。 */
async function findDoubaoUrlNode(child: Locator): Promise<{ node: Locator; href: string } | null> {
  const nodes = [child, ...await child.locator("a[href], [data-url], [data-href]").all().catch(() => [])];
  for (const node of nodes) {
    const href = await node.evaluate((element) => {
      const values = [
        element instanceof HTMLAnchorElement ? element.href : "",
        element.getAttribute("href") || "",
        element.getAttribute("data-url") || "",
        element.getAttribute("data-href") || ""
      ];
      return values.find((value) => /^https?:\/\//i.test(value)) || "";
    }).catch(() => "");
    if (href) return { node, href };
  }
  return null;
}

/** 只展开基线之后、属于当前回答的豆包“参考 N 篇资料”入口。 */
export async function revealLatestDoubaoReferenceList(
  page: Page,
  selectors: string[],
  minBlockIndex: number,
  currentQuestion = ""
): Promise<boolean> {
  const revealStartedAt = Date.now();
  while (Date.now() - revealStartedAt < 30_000) {
    const existing = await evaluateDoubaoReferenceList(
      page,
      minBlockIndex,
      false,
      currentQuestion
    ).catch(() => null);
    if (existing?.found && existing.visible && existing.linkedChildCount > 0) return true;

    const allBlocks = await page.locator(DOUBAO_SEARCH_BLOCK_SELECTOR).all().catch(() => []);
    let firstBlockIndex = Math.max(minBlockIndex, 0);
    if (firstBlockIndex >= allBlocks.length && allBlocks.length > 0 && currentQuestion) {
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      const questionIndex = bodyText.lastIndexOf(currentQuestion);
      const currentAnswerText = questionIndex >= 0 ? bodyText.slice(questionIndex + currentQuestion.length) : "";
      if (/搜索\s*\d+\s*个关键词，\s*参考\s*\d+\s*篇资料/.test(currentAnswerText)) {
        firstBlockIndex = Math.max(allBlocks.length - 2, 0);
      }
    }
    const currentBlocks = allBlocks.slice(firstBlockIndex);
    const candidates: Array<{ locator: Locator; blockIndex: number; priority: number; area: number }> = [];

    for (const [blockIndex, block] of currentBlocks.entries()) {
      const scopedSelectors = [
        "[class~='cursor-pointer']:has-text('参考')",
        ...selectors
      ];
      for (const [priority, selector] of scopedSelectors.entries()) {
        const locators = await block.locator(selector).all().catch(() => []);
        for (const locator of locators.slice(-12)) {
          const text = cleanText(await locator.innerText().catch(() => ""));
          if (!/参考\s*\d+\s*篇资料/.test(text)) continue;
          const [visible, enabled, box] = await Promise.all([
            locator.isVisible().catch(() => false),
            locator.isEnabled().catch(() => false),
            locator.boundingBox().catch(() => null)
          ]);
          if (!visible || !enabled || !box || box.height > 140) continue;
          candidates.push({ locator, blockIndex, priority, area: box.width * box.height });
        }
      }
    }

    candidates.sort((a, b) =>
      b.blockIndex - a.blockIndex ||
      a.priority - b.priority ||
      a.area - b.area
    );
    const latest = candidates[0];
    if (!latest) {
      await page.waitForTimeout(250);
      continue;
    }

    await latest.locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    const clicked = await latest.locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await page.waitForTimeout(250);
      continue;
    }

    const openedStartedAt = Date.now();
    while (Date.now() - openedStartedAt < 15_000) {
      const snapshot = await evaluateDoubaoReferenceList(
        page,
        minBlockIndex,
        false,
        currentQuestion
      ).catch(() => null);
      if (snapshot?.found && snapshot.visible && snapshot.linkedChildCount > 0) return true;
      await page.waitForTimeout(250);
    }
    return false;
  }

  return false;
}

/** 等待豆包引用数量与 URL 集合连续稳定，避免懒加载期间提前解析。 */
export async function waitForDoubaoReferenceListStable(
  page: Page,
  minBlockIndex: number,
  timeoutMs: number,
  currentQuestion = ""
): Promise<boolean> {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await evaluateDoubaoReferenceList(
      page,
      minBlockIndex,
      false,
      currentQuestion
    ).catch(() => null);
    if (!snapshot?.found || !snapshot.visible || snapshot.linkedChildCount === 0) {
      lastSignature = "";
      stableSince = Date.now();
      await page.waitForTimeout(250);
      continue;
    }

    const signature = [
      snapshot.directChildCount,
      snapshot.linkedChildCount,
      ...snapshot.urls
    ].join("\n");
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    }

    const stableFor = Date.now() - stableSince;
    const reachedExpectedCount = snapshot.expectedCount > 0 && snapshot.linkedChildCount >= snapshot.expectedCount;
    if ((reachedExpectedCount && stableFor >= 1_000) || stableFor >= 2_500) return true;
    await page.waitForTimeout(250);
  }

  return false;
}

/** 等待 DeepSeek 最后一个可见引用容器达到预期数量或持续稳定。 */
export async function waitForDeepSeekReferenceListStable(
  page: Page,
  timeoutMs: number,
  expectedCount = 0
): Promise<boolean> {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const signature = await page.evaluate<string>(`
(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const containers = Array.from(document.querySelectorAll('[class~="_223dd7b"]')).filter(isVisible);
  const container = containers[containers.length - 1];
  if (!container) return "";
  const urls = Array.from(container.querySelectorAll("a[href], [data-url], [data-href]"))
    .map((element) => element instanceof HTMLAnchorElement
      ? element.href
      : element.getAttribute("data-url") || element.getAttribute("data-href") || element.getAttribute("href") || ""
    )
    .filter((value) => /^https?:\\/\\//i.test(value));
  if (urls.length === 0) return "";
  return [container.children.length, urls.length, ...urls].join("\\n");
})()
`).catch(() => "");

    if (!signature) {
      lastSignature = "";
      stableSince = Date.now();
      await page.waitForTimeout(250);
      continue;
    }
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else {
      const linkedCount = Number.parseInt(signature.split("\n")[1] || "", 10);
      const stableFor = Date.now() - stableSince;
      if ((expectedCount > 0 && linkedCount >= expectedCount && stableFor >= 1_000) || stableFor >= 2_500) {
        return true;
      }
    }
    await page.waitForTimeout(250);
  }

  return false;
}

/** 千问当前可见引用列表的数量和 URL 快照。 */
interface QianwenReferenceListSnapshot {
  found: boolean;
  directChildCount: number;
  linkedChildCount: number;
  urls: string[];
}

/** 只统计千问最后一个可见列表的直接子 div。 */
async function snapshotQianwenReferenceList(page: Page): Promise<QianwenReferenceListSnapshot> {
  const lists = page.locator(`${QIANWEN_REFERENCE_LIST_SELECTOR}:visible`);
  const count = await lists.count().catch(() => 0);
  if (count === 0) return { found: false, directChildCount: 0, linkedChildCount: 0, urls: [] };

  const list = lists.last();
  const data = await list.locator(":scope > div").evaluateAll((elements) => {
    const urls: string[] = [];
    for (const element of elements) {
      const telemetryNode = element.matches("[data-exposure-extra], [data-click-extra]")
        ? element
        : element.querySelector("[data-exposure-extra], [data-click-extra]");
      let telemetryUrl = "";
      for (const attr of ["data-exposure-extra", "data-click-extra"]) {
        const value = telemetryNode?.getAttribute(attr);
        if (!value) continue;
        try {
          const parsed = JSON.parse(value) as { url?: string; ref_url?: string; href?: string };
          telemetryUrl = parsed.url || parsed.ref_url || parsed.href || "";
        } catch {
          // Attribute parsing falls back to link/data attributes below.
        }
        if (telemetryUrl) break;
      }
      const link = element.querySelector("a[href], [data-url], [data-href]");
      const linkUrl = link instanceof HTMLAnchorElement
        ? link.href
        : link?.getAttribute("data-url") || link?.getAttribute("data-href") || link?.getAttribute("href") || "";
      const url = telemetryUrl || linkUrl;
      if (/^https?:\/\//i.test(url)) urls.push(url);
    }
    return { directChildCount: elements.length, urls };
  }).catch(() => ({ directChildCount: 0, urls: [] as string[] }));

  return {
    found: data.directChildCount > 0,
    directChildCount: data.directChildCount,
    linkedChildCount: data.urls.length,
    urls: data.urls
  };
}

/** 统计千问参考入口总数，供提问前后差值识别本题入口。 */
export async function countQianwenReferenceTriggers(page: Page): Promise<number> {
  return page.locator(QIANWEN_REFERENCE_TRIGGER_SELECTOR).count().catch(() => 0);
}

/**
 * 在千问最新回答操作区打开重新生成菜单，再点击文字严格匹配的菜单项。
 * 图标、外层按钮和菜单项三重约束用于避免误点点赞或分享等相邻控件。
 */
export async function clickLatestQianwenRegenerate(page: Page): Promise<boolean> {
  const actions = await page.locator(QIANWEN_ANSWER_ACTION_SELECTOR).all().catch(() => []);
  for (const action of actions.slice().reverse()) {
    const isRegenerate = await action.evaluate((element) =>
      Boolean(element.querySelector('clipPath[id^="reg_svg__"], clippath[id^="reg_svg__"]'))
    ).catch(() => false);
    if (!isRegenerate) continue;

    const [visible, enabled] = await Promise.all([
      action.isVisible().catch(() => false),
      action.isEnabled().catch(() => false)
    ]);
    if (!visible || !enabled) continue;

    const wrapper = action.locator("..");
    const wrapperClass = await wrapper.getAttribute("class").catch(() => "") || "";
    const wrapperTokens = new Set(wrapperClass.split(/\s+/).filter(Boolean));
    const menuTrigger = ["flex", "items-center", "rounded"].every((token) => wrapperTokens.has(token))
      ? wrapper
      : action;
    await menuTrigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    const menuOpened = await menuTrigger.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!menuOpened) return false;

    const regenerateItem = page.locator(QIANWEN_REGENERATE_MENU_ITEM_SELECTOR)
      .filter({ hasText: /^重新生成$/ })
      .last();
    const itemVisible = await regenerateItem.waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!itemVisible) return false;

    return regenerateItem.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }
  return false;
}

/** 点击基线之后最新的千问参考入口，返回入口标注的预期引用数。 */
export async function revealLatestQianwenReferenceList(
  page: Page,
  baselineTriggerCount: number,
  timeoutMs = 30_000
): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const triggers = await page.locator(QIANWEN_REFERENCE_TRIGGER_SELECTOR).all().catch(() => []);
    const freshTriggers = triggers.slice(Math.min(baselineTriggerCount, triggers.length));

    for (const trigger of freshTriggers.slice().reverse()) {
      const [visible, enabled, text] = await Promise.all([
        trigger.isVisible().catch(() => false),
        trigger.isEnabled().catch(() => false),
        trigger.innerText().catch(() => "")
      ]);
      if (!visible || !enabled) continue;

      await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      const clicked = await trigger.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (!clicked) continue;

      const listReady = await page.locator(`${QIANWEN_REFERENCE_LIST_SELECTOR}:visible`)
        .last()
        .locator(":scope > div")
        .first()
        .waitFor({ state: "attached", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!listReady) continue;

      const expectedCount = Number.parseInt(text.match(/(\d+)/)?.[1] || "", 10);
      if (Number.isFinite(expectedCount) && expectedCount > 0) return expectedCount;
      const snapshot = await snapshotQianwenReferenceList(page);
      return Math.max(snapshot.linkedChildCount, 1);
    }

    await page.waitForTimeout(250);
  }

  return 0;
}

/** 等待千问卡片达到入口标注数量，或在数量未知时持续稳定。 */
export async function waitForQianwenReferenceListStable(
  page: Page,
  timeoutMs: number,
  expectedCount = 0
): Promise<boolean> {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await snapshotQianwenReferenceList(page);
    if (!snapshot.found || snapshot.linkedChildCount === 0) {
      lastSignature = "";
      stableSince = Date.now();
      await page.waitForTimeout(250);
      continue;
    }

    const signature = [snapshot.directChildCount, snapshot.linkedChildCount, ...snapshot.urls].join("\n");
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else {
      const stableFor = Date.now() - stableSince;
      const reachedExpectedCount = expectedCount > 0 && snapshot.linkedChildCount >= expectedCount;
      if ((reachedExpectedCount && stableFor >= 1_000) || stableFor >= 2_500) return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/** 点击页面位置最靠后的 DeepSeek“X个网页”按钮，并返回 X。 */
export async function revealLatestDeepSeekReferenceList(
  page: Page,
  timeoutMs = 30_000
): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const buttons = await page.locator('[class~="f93f59e4"]').all().catch(() => []);
    const candidates: Array<{ locator: Locator; expectedCount: number; y: number; domIndex: number }> = [];

    for (const [domIndex, locator] of buttons.entries()) {
      const text = cleanText(await locator.innerText().catch(() => ""));
      const expectedCount = Number.parseInt(text.match(/^(\d+)\s*个网页$/)?.[1] || "", 10);
      if (!Number.isFinite(expectedCount) || expectedCount <= 0) continue;

      const [visible, box] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.boundingBox().catch(() => null)
      ]);
      if (!visible || !box) continue;
      candidates.push({ locator, expectedCount, y: box.y + box.height, domIndex });
    }

    candidates.sort((a, b) => b.y - a.y || b.domIndex - a.domIndex);
    const latest = candidates[0];
    if (!latest) {
      await page.waitForTimeout(250);
      continue;
    }

    await latest.locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    const clicked = await latest.locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await page.waitForTimeout(250);
      continue;
    }

    console.log(`[DeepSeek] 已点击最新回答的 ${latest.expectedCount}个网页（class=f93f59e4），等待引用列表打开`);
    await page.waitForTimeout(750);
    const remainingMs = Math.max(timeoutMs - (Date.now() - startedAt), 250);
    const panelReady = await page
      .locator(`${DEEPSEEK_REFERENCE_CONTAINER_SELECTOR}:visible`)
      .last()
      .locator("a[href], [data-url], [data-href]")
      .first()
      .waitFor({ state: "attached", timeout: Math.min(5_000, remainingMs) })
      .then(() => true)
      .catch(() => false);
    if (panelReady) return latest.expectedCount;
  }

  return 0;
}

// 通用/旧版引用面板可能使用虚拟滚动，先复位再分段扫描才能收集完整列表。
const RESET_SOURCE_PANEL_SCROLL_SCRIPT = `
(() => {
  const visibleQianwenLists = Array.from(document.querySelectorAll('[class~="list-XPxyL2"]')).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  const qianwenList = visibleQianwenLists[visibleQianwenLists.length - 1];
  if (qianwenList) {
    qianwenList.scrollTop = 0;
    return;
  }
  const cards = Array.from(document.querySelectorAll(
    '.agent-dialogue-references__list > .agent-dialogue-references__item'
  ));
  const panels = Array.from(new Set(cards.flatMap((card) => {
    let node = card.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 80) return [node];
      node = node.parentElement;
    }
    return [];
  })));

  for (const panel of panels) {
    panel.scrollTop = 0;
  }
})()
`;

const SCROLL_SOURCE_PANEL_SCRIPT = `
(() => {
  const visibleQianwenLists = Array.from(document.querySelectorAll('[class~="list-XPxyL2"]')).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  const qianwenList = visibleQianwenLists[visibleQianwenLists.length - 1];
  if (qianwenList) {
    const before = qianwenList.scrollTop;
    qianwenList.scrollTop = Math.min(
      qianwenList.scrollTop + Math.max(qianwenList.clientHeight * 0.85, 260),
      qianwenList.scrollHeight
    );
    return qianwenList.scrollTop > before + 2;
  }
  const cards = Array.from(document.querySelectorAll(
    '.agent-dialogue-references__list > .agent-dialogue-references__item'
  ));
  const panels = Array.from(new Set(cards.flatMap((card) => {
    let node = card.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 80) return [node];
      node = node.parentElement;
    }
    return [];
  })))
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

  const panel = panels[0];
  if (!panel) return false;

  const before = panel.scrollTop;
  panel.scrollTop = Math.min(panel.scrollTop + Math.max(panel.clientHeight * 0.85, 260), panel.scrollHeight);
  return panel.scrollTop > before + 2;
})()
`;

/** 兼容性入口：依次点击页面上可见的小型引用按钮。 */
export async function revealReferencePanels(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const locators = await page.locator(selector).all().catch(() => []);
    const candidates = locators.slice(-12);
    const measured = await Promise.all(
      candidates.map(async (locator, index) => ({
        locator,
        index,
        box: await locator.boundingBox().catch(() => null)
      }))
    );

    measured.sort((a, b) => {
      const areaA = a.box ? a.box.width * a.box.height : Number.MAX_SAFE_INTEGER;
      const areaB = b.box ? b.box.width * b.box.height : Number.MAX_SAFE_INTEGER;
      return areaA - areaB || b.index - a.index;
    });

    for (const { locator, box } of measured) {
      if (box && (box.width > 420 || box.height > 140)) continue;
      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;
      await locator.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(300).catch(() => undefined);
    }
  }
}

/** 统计元宝参考入口总数，供提问前基线与本轮新增入口切片使用。 */
export async function countYuanbaoReferenceTriggers(page: Page): Promise<number> {
  return page.locator(YUANBAO_REFERENCE_TRIGGER_SELECTOR).count().catch(() => 0);
}

/** 点击本轮新增的最新元宝入口，并确认打开抽屉中已挂载首条 li。 */
export async function revealLatestYuanbaoReferenceList(
  page: Page,
  baselineTriggerCount: number,
  timeoutMs = 30_000
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const triggers = await page.locator(YUANBAO_REFERENCE_TRIGGER_SELECTOR).all().catch(() => []);
    const newTriggers = triggers.slice(Math.max(baselineTriggerCount, 0));
    for (const [offset, trigger] of Array.from(newTriggers.entries()).reverse()) {
      const [visible, enabled] = await Promise.all([
        trigger.isVisible().catch(() => false),
        trigger.isEnabled().catch(() => false)
      ]);
      if (!visible || !enabled) continue;

      await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      const clicked = await trigger.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (!clicked) continue;

      const triggerIndex = baselineTriggerCount + offset;
      console.log(
        `[元宝] 已点击本轮新增参考入口 ${triggerIndex + 1}/${triggers.length}` +
        `（class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b"）`
      );

      const drawerItem = page
        .locator(YUANBAO_OPEN_REFERENCE_LIST_SELECTOR)
        .last()
        .locator(":scope > li")
        .first();
      let opened = await drawerItem.waitFor({ state: "attached", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      // 测试夹具或页面旧版本可能没有 t-drawer--open，保留可见列表兼容路径。
      const hasDrawerShell = await page.locator(".t-drawer").count().catch(() => 0) > 0;
      if (!opened && !hasDrawerShell) {
        opened = await page
          .locator(`${YUANBAO_REFERENCE_LIST_SELECTOR}:visible`)
          .last()
          .locator(":scope > li")
          .first()
          .waitFor({ state: "attached", timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
      }
      if (opened) return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/** 等待元宝直接子 li 的数量、URL 和标题签名连续稳定。 */
export async function waitForYuanbaoReferenceListStable(
  page: Page,
  timeoutMs = 15_000
): Promise<boolean> {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const openLists = page.locator(YUANBAO_OPEN_REFERENCE_LIST_SELECTOR);
    const openListCount = await openLists.count().catch(() => 0);
    const hasDrawerShell = await page.locator(".t-drawer").count().catch(() => 0) > 0;
    const list = openListCount > 0
      ? openLists.last()
      : hasDrawerShell
        ? page.locator(".__yuanbao_reference_list_not_open__")
        : page.locator(`${YUANBAO_REFERENCE_LIST_SELECTOR}:visible`).last();
    const items = list.locator(":scope > li");
    const count = await items.count().catch(() => 0);
    if (count === 0) {
      lastSignature = "";
      stableSince = Date.now();
      await page.waitForTimeout(250);
      continue;
    }

    const signatures: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const card = item.locator(".hyc-common-markdown__ref_card[data-url], [data-url]").first();
      const [url, title] = await Promise.all([
        card.getAttribute("data-url").catch(() => null),
        item.locator(".hyc-common-markdown__ref_card-title, h4").first().innerText().catch(() => "")
      ]);
      signatures.push(`${index}:${url || ""}:${cleanText(title)}`);
    }

    const signature = `${count}\n${signatures.join("\n")}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1_000) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/** 通用入口：点击页面最靠后的引用按钮，并可等待指定面板出现。 */
export async function revealLatestReferencePanel(
  page: Page,
  selectors: string[],
  expectedPanelSelector?: string,
  timeoutMs = 12_000
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const candidates: Array<{ locator: import("playwright").Locator; y: number; area: number }> = [];

    for (const selector of selectors) {
      const locators = await page.locator(selector).all().catch(() => []);
      for (const locator of locators.slice(-12)) {
        const [visible, enabled, box] = await Promise.all([
          locator.isVisible().catch(() => false),
          locator.isEnabled().catch(() => false),
          locator.boundingBox().catch(() => null)
        ]);
        if (!visible || !enabled || !box || box.width > 420 || box.height > 140) continue;
        candidates.push({ locator, y: box.y + box.height, area: box.width * box.height });
      }
    }

    candidates.sort((a, b) => b.y - a.y || a.area - b.area);
    for (const candidate of candidates.slice(0, 8)) {
      const clicked = await candidate.locator.click({ timeout: 800 }).then(() => true).catch(() => false);
      if (!clicked) continue;

      if (!expectedPanelSelector) {
        await page.waitForTimeout(500).catch(() => undefined);
        return true;
      }

      const panelOpened = await page.locator(expectedPanelSelector).last()
        .waitFor({ state: "visible", timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      if (panelOpened) return true;
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }

  return false;
}

/** 通用入口：只点击基线数量之后新增的引用按钮。 */
export async function revealNewReferencePanels(page: Page, selectors: string[], baselineCount: number): Promise<void> {
  const locators = await page.locator(selectors.join(", ")).all().catch(() => []);
  for (const [index, locator] of locators.entries()) {
    if (index < baselineCount) continue;
    const visible = await locator.isVisible().catch(() => false);
    const enabled = await locator.isEnabled().catch(() => false);
    if (!visible || !enabled) continue;
    await locator.click({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(300).catch(() => undefined);
  }
}

/** 统计整页 HTTP(S) 链接数，仅供兼容流程观测页面变化。 */
export async function countHttpAnchors(page: Page): Promise<number> {
  return page.evaluate(COUNT_HTTP_ANCHORS_SCRIPT);
}

/** 获取当前页面外部链接集合，用于比较引用面板展开前后的变化。 */
export async function snapshotReferenceUrls(page: Page): Promise<Set<string>> {
  const urls = await page.evaluate<string[]>(`
    (() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => href.startsWith("http://") || href.startsWith("https://"));
    })()
  `);

  return new Set(
    urls
      .map((url) => normalizeUrl(unwrapUrl(url)))
      .filter((url) => !isInternalUrl(url))
  );
}

/** 返回文档高度，作为通用抽取判断新内容位置的提问前基线。 */
export async function snapshotDocumentBottom(page: Page): Promise<number> {
  return page.evaluate<number>("document.body.scrollHeight").catch(() => 0);
}

/** 按平台配置的选择器统计潜在引用入口。 */
export async function countReferenceRevealButtons(page: Page, selectors: string[]): Promise<number> {
  return page.locator(selectors.join(", ")).count().catch(() => 0);
}

/** 统计豆包结构化搜索结果块数量。 */
export async function countDoubaoSearchResultBlocks(page: Page): Promise<number> {
  return page.locator(DOUBAO_SEARCH_BLOCK_SELECTOR).count().catch(() => 0);
}

/** 统计 DeepSeek 已挂载的引用容器数量。 */
export async function countDeepSeekReferenceContainers(page: Page): Promise<number> {
  return page.locator(DEEPSEEK_REFERENCE_CONTAINER_SELECTOR).count().catch(() => 0);
}

/**
 * 平台抽取总入口。四个已适配平台走严格结构化解析；只有未知平台才使用
 * 基于页面位置的通用链接候选流程。
 */
export async function extractReferences(
  page: Page,
  question: string,
  crawlPlatform: string,
  minScore = 0
): Promise<ReferenceRecord[]> {
  if (crawlPlatform === "豆包") {
    return extractDoubaoReferenceList(page, question, crawlPlatform, minScore);
  }
  if (crawlPlatform === "DeepSeek") {
    return extractDeepSeekReferenceList(page, question, crawlPlatform);
  }
  if (crawlPlatform === "千问") {
    const structured = await extractStructuredSearchResults(
      page,
      question,
      crawlPlatform,
      0,
      EXTRACT_QIANWEN_SEARCH_RESULTS_SCRIPT,
      true
    );
    if (structured.length > 0) return structured;
    console.log("[千问] 未在 list-XPxyL2 容器的直接子组件中找到来源数据，不执行整页链接回退抽取。");
    return [];
  }
  if (crawlPlatform === "元宝") {
    const structured = await extractYuanbaoReferenceList(page, question, crawlPlatform);
    if (structured.length > 0) return structured;
    console.log("[元宝] agent-dialogue-references__list 中没有解析出有效的 li 数据。");
    return [];
  }

  const raw = await page.evaluate<RawReferenceCandidate[]>(EXTRACT_REFERENCES_SCRIPT);

  const seen = new Set<string>();
  const records: Omit<ReferenceRecord, "rank">[] = [];

  for (const item of raw) {
    const url = unwrapUrl(item.href);
    if (isInternalUrl(url)) continue;
    const normalized = normalizeUrl(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const context = cleanText(item.contextText);
    const title = chooseTitle(item.anchorText, item.titleAttr, item.ariaLabel, item.cardTitle, context, normalized);

    records.push({
      question,
      crawlPlatform,
      articlePlatform: platformFromUrl(normalized),
      articleTime: extractDate(context),
      title,
      summary: "",
      url: normalized,
      extractedAt: new Date().toISOString()
    });
  }

  const shouldFilterByPosition = minScore > 0 && crawlPlatform !== "千问" && crawlPlatform !== "元宝";
  const freshRecords = shouldFilterByPosition
    ? records.filter((record) => {
        const rawItem = raw.find((item) => normalizeUrl(unwrapUrl(item.href)) === record.url);
        return rawItem ? rawItem.score >= minScore - 300 : true;
      })
    : records;

  // 如果页面重排导致位置判断失效，取页面末尾最新的一组外部链接兜底。
  const selected = freshRecords.length > 0 ? freshRecords : records.slice(-20);
  return selected.map((record, index) => ({
    ...record,
    rank: index + 1
  }));
}

/** 从 DeepSeek 最新可见容器提取并记录诊断信息，不扫描容器外链接。 */
async function extractDeepSeekReferenceList(
  page: Page,
  question: string,
  crawlPlatform: string
): Promise<ReferenceRecord[]> {
  const visibleContainers = page.locator(`${DEEPSEEK_REFERENCE_CONTAINER_SELECTOR}:visible`);
  const containerCount = await visibleContainers.count().catch(() => 0);
  if (containerCount === 0) {
    console.log("[DeepSeek] 没有找到可见的 ._223dd7b 参考文献容器，不执行整页链接回退抽取。");
    return [];
  }

  const container = visibleContainers.last();
  const [containerClass, directChildCount, linkCount] = await Promise.all([
    container.getAttribute("class").catch(() => ""),
    container.locator(":scope > *").count().catch(() => 0),
    container.locator("a[href], [data-url], [data-href]").count().catch(() => 0)
  ]);
  console.log(
    `[DeepSeek] 命中最新可见引用容器 class=${JSON.stringify(containerClass || "")}` +
    `，直接子节点=${directChildCount}，候选链接=${linkCount}`
  );

  const records = await extractStructuredSearchResults(
    page,
    question,
    crawlPlatform,
    0,
    EXTRACT_DEEPSEEK_SEARCH_RESULTS_SCRIPT
  );
  for (const record of records) {
    console.log(
      `[DeepSeek][解析] ${record.rank}/${records.length}` +
      ` | 来源=${record.articlePlatform}` +
      ` | 时间=${record.articleTime}` +
      ` | 标题=${record.title}` +
      ` | URL=${record.url}`
    );
  }
  return records;
}

/** 将豆包当前引用容器转换为标准记录，并按规范化 URL 去重。 */
async function extractDoubaoReferenceList(
  page: Page,
  question: string,
  crawlPlatform: string,
  minBlockIndex: number
): Promise<ReferenceRecord[]> {
  const extraction = await evaluateDoubaoReferenceList(page, minBlockIndex, true, question);
  if (!extraction.found) {
    console.log("[豆包] 当前回答中没有找到符合结构的参考文献容器。");
    return [];
  }

  console.log(
    `[豆包] 命中引用容器 class=${JSON.stringify(extraction.containerClass)}` +
    `，直接子节点=${extraction.directChildCount}` +
    `，含链接子节点=${extraction.linkedChildCount}` +
    (extraction.expectedCount > 0 ? `，页面标注参考数=${extraction.expectedCount}` : "")
  );

  const seen = new Set<string>();
  const records = extraction.items.flatMap((item) => {
    const url = normalizeUrl(unwrapUrl(item.href));
    const title = cleanDoubaoReferenceTitle(item.title);
    if (!title || isInternalUrl(url) || seen.has(url)) return [];
    seen.add(url);

    return [{
      question,
      crawlPlatform,
      rank: seen.size,
      articlePlatform: cleanText(item.platform) || platformFromReferenceTitle(title, url),
      articleTime: item.articleTime || extractDate(item.contextText),
      title,
      summary: cleanText(item.summary || ""),
      url,
      extractedAt: new Date().toISOString()
    } satisfies ReferenceRecord];
  });

  console.log(`[豆包] 当前引用容器解析出 ${records.length} 条有效参考文献`);
  for (const record of records) {
    console.log(
      `[豆包][解析] ${record.rank}/${records.length}` +
      ` | 来源=${record.articlePlatform}` +
      ` | 标题=${record.title}` +
      ` | URL=${record.url}`
    );
  }
  return records;
}

/** 清除豆包卡片标题前的列表序号。 */
function cleanDoubaoReferenceTitle(value: string): string {
  return cleanText(value)
    .replace(/^(?:\[?\d+\]?\s*[.、):：-]\s*|第\s*\d+\s*条\s*)/, "")
    .trim();
}

/** 只从元宝已打开抽屉的主列表直接子 li 生成标准记录。 */
async function extractYuanbaoReferenceList(
  page: Page,
  question: string,
  crawlPlatform: string
): Promise<ReferenceRecord[]> {
  const openLists = page.locator(YUANBAO_OPEN_REFERENCE_LIST_SELECTOR);
  const openListCount = await openLists.count().catch(() => 0);
  const hasDrawerShell = await page.locator(".t-drawer").count().catch(() => 0) > 0;
  const list = openListCount > 0
    ? openLists.last()
    : hasDrawerShell
      ? page.locator(".__yuanbao_reference_list_not_open__")
      : page.locator(`${YUANBAO_REFERENCE_LIST_SELECTOR}:visible`).last();
  const listReady = await list.waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!listReady) {
    console.log("[元宝] 没有找到可见的 agent-dialogue-references__list 主列表。");
    return [];
  }

  const items = list.locator(":scope > li");
  const [listClass, directChildCount, liCount] = await Promise.all([
    list.getAttribute("class").catch(() => ""),
    list.locator(":scope > *").count().catch(() => 0),
    items.count().catch(() => 0)
  ]);
  console.log(
    `[元宝] 主列表 class=${JSON.stringify(listClass || "")}` +
    `，直接子节点=${directChildCount}，li=${liCount}`
  );

  const itemReady = await items.first().waitFor({ state: "attached", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!itemReady) {
    console.log("[元宝] 已找到主列表，但主列表下面没有 li。");
    return [];
  }

  const raw = await page.evaluate<SearchResultCandidate[]>(EXTRACT_YUANBAO_REFERENCES_SCRIPT);

  console.log(`[元宝] agent-dialogue-references__list 下读取到 ${raw.length} 个 li`);

  const seen = new Set<string>();
  const records = raw
    .sort((a, b) => (a.referenceNumber || 0) - (b.referenceNumber || 0) || a.score - b.score)
    .flatMap((item) => {
      const url = normalizeUrl(unwrapUrl(item.href));
      if (!item.title || isInternalUrl(url) || seen.has(url)) return [];
      seen.add(url);
      return [{
        question,
        crawlPlatform,
        rank: seen.size,
        articlePlatform: item.platform || platformFromUrl(url),
        articleTime: item.articleTime,
        title: cleanText(item.title),
        summary: cleanText(item.summary || ""),
        url,
        extractedAt: new Date().toISOString()
      }];
    });

  for (const record of records) {
    console.log(
      `[元宝][解析] ${record.rank}/${records.length}` +
      ` | 来源=${record.articlePlatform}` +
      ` | 标题=${record.title}` +
      ` | URL=${record.url}`
    );
  }
  return records;
}

/**
 * 将浏览器脚本返回的平台候选统一清洗为 ReferenceRecord：解跳转、去跟踪参数、
 * 过滤内部域名、按 URL 去重，并补齐来源和日期。
 */
async function extractStructuredSearchResults(
  page: Page,
  question: string,
  crawlPlatform: string,
  minScore: number,
  script: string,
  scanScrollablePanel = false
): Promise<ReferenceRecord[]> {
  const raw = scanScrollablePanel
    ? await collectScrollableStructuredResults(page, script)
    : await page.evaluate<SearchResultCandidate[]>(script);
  const seen = new Set<string>();
  const filtered = (minScore > 0 ? raw.filter((item) => item.score >= minScore - 300) : raw)
    .filter((item) => {
      const normalized = normalizeUrl(unwrapUrl(item.href));
      if (isInternalUrl(normalized) || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

  return filtered.map((item, index) => {
    const url = normalizeUrl(unwrapUrl(item.href));
    return {
      question,
      crawlPlatform,
      rank: index + 1,
      articlePlatform: item.platform || platformFromUrl(url),
      articleTime: item.articleTime || extractDate(item.contextText),
      title: cleanText(item.title),
      summary: cleanText(item.summary || ""),
      url,
      extractedAt: new Date().toISOString()
    };
  });
}

/** 分段滚动虚拟列表并合并每一屏候选，最多扫描 12 屏。 */
async function collectScrollableStructuredResults(page: Page, script: string): Promise<SearchResultCandidate[]> {
  const collected = new Map<string, SearchResultCandidate>();
  await page.evaluate(RESET_SOURCE_PANEL_SCROLL_SCRIPT).catch(() => undefined);
  await page.waitForTimeout(250).catch(() => undefined);

  for (let i = 0; i < 12; i += 1) {
    const batch = await page.evaluate<SearchResultCandidate[]>(script);
    for (const item of batch) {
      const key = `${item.href}::${item.title}`;
      const existing = collected.get(key);
      if (!existing || item.contextText.length < existing.contextText.length) {
        collected.set(key, item);
      }
    }

    const moved = await page.evaluate<boolean>(SCROLL_SOURCE_PANEL_SCRIPT).catch(() => false);
    if (!moved) break;
    await page.waitForTimeout(350).catch(() => undefined);
  }

  return Array.from(collected.values()).sort((a, b) =>
    (a.referenceNumber || Number.MAX_SAFE_INTEGER) - (b.referenceNumber || Number.MAX_SAFE_INTEGER) ||
    a.score - b.score
  );
}

/** 移除常见营销跟踪参数和 hash，形成稳定的去重键。 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm", "urlSource", "url_source"]
      .forEach((key) => {
        parsed.searchParams.delete(key);
      });
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 过滤 AI 平台自身链接；无法解析的 URL 也按无效内部链接处理。 */
function isInternalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return INTERNAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return true;
  }
}
