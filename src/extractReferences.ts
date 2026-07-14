import type { Page } from "playwright";
import type { RawReferenceCandidate, ReferenceRecord, SearchResultCandidate } from "./types.js";
import {
  chooseDisplayedReferenceTitle,
  chooseTitle,
  cleanText,
  extractDate,
  platformFromReferenceTitle,
  platformFromUrl,
  unwrapUrl
} from "./text.js";

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

const COUNT_HTTP_ANCHORS_SCRIPT = `
(() => {
  return Array.from(document.querySelectorAll("a[href]"))
    .filter((anchor) => anchor.href.startsWith("http://") || anchor.href.startsWith("https://"))
    .length;
})()
`;

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

const EXTRACT_DEEPSEEK_SEARCH_RESULTS_SCRIPT = `
(() => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const datePattern = /(?:19|20)\\d{2}[\\/-]\\d{1,2}[\\/-]\\d{1,2}/;

  const scoreElement = (element) => {
    const rect = element.getBoundingClientRect();
    return Math.max((Number.isFinite(rect.top) ? rect.top : 0) + window.scrollY, 0);
  };

  const titleLineFrom = (text, metaLine) => {
    const lines = text
      .split(/[\\n\\r]+/)
      .map(clean)
      .filter(Boolean)
      .filter((line) => line !== metaLine)
      .filter((line) => !/^\\d+$/.test(line))
      .filter((line) => !datePattern.test(line) || line.length > 18)
      .filter((line) => line.length >= 8 && line.length <= 160);

    return lines[0] || "";
  };

  const resultByKey = new Map();

  for (const element of Array.from(document.querySelectorAll("div, li, article, section"))) {
    const text = clean(element instanceof HTMLElement ? element.innerText : element.textContent || "");
    if (!datePattern.test(text) || text.length < 20 || text.length > 900) continue;

    const links = Array.from(element.querySelectorAll("a[href]"))
      .map((anchor) => ({
        href: anchor.href,
        text: clean(anchor.innerText || anchor.textContent || "")
      }))
      .filter((item) => item.href.startsWith("http://") || item.href.startsWith("https://"));
    if (links.length === 0) continue;

    const metaLine = text
      .split(/[\\n\\r]+/)
      .map(clean)
      .find((line) => datePattern.test(line)) || "";

    const date = metaLine.match(datePattern)?.[0] || text.match(datePattern)?.[0] || "";
    const platform = clean(metaLine.split("|")[0] || links[0].text || "");
    const title = titleLineFrom(text, metaLine);
    if (!title) continue;

    const key = links[0].href + "::" + title;
    const candidate = {
      score: scoreElement(element),
      href: links[0].href,
      platform,
      articleTime: date,
      title,
      contextText: text
    };

    const existing = resultByKey.get(key);
    if (!existing || candidate.contextText.length < existing.contextText.length) {
      resultByKey.set(key, candidate);
    }
  }

  return Array.from(resultByKey.values()).sort((a, b) => a.score - b.score);
})()
`;

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

  const list = document.querySelector('[class~="list-XPxyL2"]');
  if (!list) return [];
  const cards = Array.from(list.children).filter((element) =>
    element.matches('[data-exposure-extra], [data-click-extra]')
  );

  for (const element of cards) {
    const data = parseJsonAttr(element);
    if (!data) continue;

    const rawText = element instanceof HTMLElement ? element.innerText : element.textContent || "";
    const text = clean(rawText);
    const title = clean(data.title || data.name || "");
    const href = clean(data.url || data.ref_url || data.href || "");
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
    const platform = clean(
      (data.source || data.source_name || data.site || data.media || metaLine)
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
  const lists = Array.from(document.querySelectorAll(".agent-dialogue-references__list"))
    .filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  const list = lists[lists.length - 1];
  if (!list) return [];

  const candidates = Array.from(list.querySelectorAll("li"));

  for (const [domIndex, element] of candidates.entries()) {
    const rawText = element instanceof HTMLElement ? element.innerText : element.textContent || "";
    const text = clean(rawText);
    const card = element.querySelector("[data-url]");
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

const RESET_SOURCE_PANEL_SCROLL_SCRIPT = `
(() => {
  const qianwenList = document.querySelector('[class~="list-XPxyL2"]');
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
  const qianwenList = document.querySelector('[class~="list-XPxyL2"]');
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

export async function revealLatestReferencePanel(
  page: Page,
  selectors: string[],
  expectedPanelSelector?: string
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 12_000) {
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

export async function countHttpAnchors(page: Page): Promise<number> {
  return page.evaluate(COUNT_HTTP_ANCHORS_SCRIPT);
}

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

export async function snapshotDocumentBottom(page: Page): Promise<number> {
  return page.evaluate<number>("document.body.scrollHeight").catch(() => 0);
}

export async function countReferenceRevealButtons(page: Page, selectors: string[]): Promise<number> {
  return page.locator(selectors.join(", ")).count().catch(() => 0);
}

export async function extractReferences(
  page: Page,
  question: string,
  crawlPlatform: string,
  minScore = 0
): Promise<ReferenceRecord[]> {
  const preferDisplayedTitle = crawlPlatform === "豆包";
  if (crawlPlatform === "DeepSeek") {
    const structured = await extractStructuredSearchResults(
      page,
      question,
      crawlPlatform,
      minScore,
      EXTRACT_DEEPSEEK_SEARCH_RESULTS_SCRIPT
    );
    if (structured.length > 0) return structured;
    console.log("[DeepSeek] 结构化来源卡片未抽取到结果，回退通用链接抽取。");
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
    const title = preferDisplayedTitle
      ? chooseDisplayedReferenceTitle(item.anchorText, item.titleAttr, item.ariaLabel, item.cardTitle, context, normalized)
      : chooseTitle(item.anchorText, item.titleAttr, item.ariaLabel, item.cardTitle, context, normalized);

    records.push({
      question,
      crawlPlatform,
      articlePlatform: preferDisplayedTitle ? platformFromReferenceTitle(title, normalized) : platformFromUrl(normalized),
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

async function extractYuanbaoReferenceList(
  page: Page,
  question: string,
  crawlPlatform: string
): Promise<ReferenceRecord[]> {
  const list = page.locator(".agent-dialogue-references__list:visible").last();
  const listReady = await list.waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!listReady) {
    console.log("[元宝] 没有找到可见的 agent-dialogue-references__list 主列表。");
    return [];
  }

  const items = list.locator("li");
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

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm"].forEach((key) => {
      parsed.searchParams.delete(key);
    });
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isInternalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return INTERNAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return true;
  }
}
