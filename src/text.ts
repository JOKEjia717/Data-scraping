/**
 * 引用文本与 URL 的纯函数清洗工具。所有平台共用这些规则，确保来源名称、
 * 日期、标题和跳转链接在写入前具有一致格式。
 */
const DATE_PATTERNS = [
  /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/,
  /(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月/,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/,
  /\d{1,2}\s*[-/.]\s*\d{1,2}/,
  /\d+\s*(?:秒|分钟|小时|天|周|个月|年)前/,
  /(?:刚刚|今天|昨日|昨天|前天)/
];

/** 常见来源域名到更友好的中文平台名映射；未命中时保留域名。 */
const HOST_PLATFORM_MAP: Array<[RegExp, string]> = [
  [/mp\.weixin\.qq\.com$/, "微信公众号"],
  [/(^|\.)zhihu\.com$/, "知乎"],
  [/(^|\.)dongchedi\.com$/, "懂车帝"],
  [/(^|\.)autohome\.com\.cn$/, "汽车之家"],
  [/(^|\.)pcauto\.com\.cn$/, "太平洋汽车"],
  [/(^|\.)xcar\.com\.cn$/, "爱卡汽车"],
  [/(^|\.)yiche\.com$/, "易车"],
  [/(^|\.)36kr\.com$/, "36氪"],
  [/(^|\.)huxiu\.com$/, "虎嗅"],
  [/(^|\.)ifeng\.com$/, "凤凰网"],
  [/(^|\.)sina\.com\.cn$/, "新浪"],
  [/(^|\.)sohu\.com$/, "搜狐"],
  [/(^|\.)qq\.com$/, "腾讯"],
  [/(^|\.)163\.com$/, "网易"],
  [/(^|\.)thepaper\.cn$/, "澎湃新闻"],
  [/(^|\.)ithome\.com$/, "IT之家"],
  [/(^|\.)mi\.com$/, "小米官网"],
  [/(^|\.)xiaomi\.com$/, "小米官网"]
];

/** 合并连续空白并移除首尾空白。 */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 按从具体日期到相对时间的优先级抽取第一个时间表达式。 */
export function extractDate(value: string): string {
  const text = cleanText(value);
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return cleanText(match[0]);
  }
  return "";
}

/** 根据文章 URL 推断文章来源名称。 */
export function platformFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const mapped = HOST_PLATFORM_MAP.find(([pattern]) => pattern.test(hostname));
    if (mapped) return mapped[1];
    return hostname;
  } catch {
    return "";
  }
}

/**
 * 最多解开三层常见跳转参数，兼容平台中转页，同时限制循环次数防止恶意链路。
 */
export function unwrapUrl(url: string): string {
  let current = url;
  for (let i = 0; i < 3; i += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }

    const candidate = ["url", "target", "u", "redirect", "redirect_url", "to"]
      .map((key) => parsed.searchParams.get(key))
      .find((value) => value?.startsWith("http"));

    if (!candidate) return current;
    current = decodeURIComponent(candidate);
  }
  return current;
}

/** 判断文本是否只是序号、操作按钮或其他不应作为文章标题的 UI 文案。 */
export function looksLikeUiText(text: string): boolean {
  const value = cleanText(text);
  return (
    value.length < 4 ||
    /^\[?\d+\]?$/.test(value) ||
    /^[-–—]?\s*\d+$/.test(value) ||
    /^[-–—]?\s*\d+\s*[-–—]\s*\d+$/.test(value) ||
    /^(打开|复制|分享|更多|参考|来源|引用|网页|搜索|查看|展开|收起|登录|注册)$/i.test(value)
  );
}

/** 判断候选标题是否实际只是来源平台名或域名。 */
export function looksLikePlatformOrHost(text: string, url: string): boolean {
  const value = cleanText(text).toLowerCase();
  const platform = platformFromUrl(url).toLowerCase();
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }

  return value === platform || value === host || host.includes(value) || value.includes(host);
}

/** 去除常见站点后缀和短分隔后缀，保留文章标题主体。 */
export function normalizeArticleTitle(value: string): string {
  return cleanText(value)
    .replace(/\s*[_|-]\s*(手机搜狐网|搜狐|易车|汽车之家|懂车帝|太平洋汽车|爱卡汽车|新浪财经|新浪|腾讯新闻|网易|凤凰网|36氪|雷峰网|中关村在线|百度百科)\s*$/i, "")
    .replace(/\s*[-_|]\s*.*?$/, (match) => (match.length <= 16 ? "" : match))
    .trim();
}

/**
 * 为页面直接展示的引用选择标题：优先链接/卡片属性，最后从邻近上下文取值。
 */
export function chooseDisplayedReferenceTitle(
  anchorText: string,
  titleAttr: string,
  ariaLabel: string,
  cardTitle: string,
  contextText: string,
  url: string
): string {
  const candidates = [anchorText, cardTitle, titleAttr, ariaLabel]
    .map(cleanText)
    .filter((item) => item.length >= 6 && item.length <= 180)
    .filter((item) => !looksLikeUiText(item))
    .filter((item) => !looksLikePlatformOrHost(item, url));

  if (candidates.length > 0) return candidates[0];

  const contextLine = contextText
    .split(/[\n\r]+| {2,}/)
    .map(cleanText)
    .find((line) => line.length >= 8 && line.length <= 180 && !looksLikeUiText(line) && !looksLikePlatformOrHost(line, url));

  return contextLine || platformFromUrl(url) || url;
}

/** 从标题的【来源】前缀、站点后缀或 URL 中推断文章来源。 */
export function platformFromReferenceTitle(title: string, url: string): string {
  const value = cleanText(title);
  const prefixMatch = value.match(/^(?:【([^】]{2,24})】|\[([^\]]{2,24})\])/);
  const prefix = cleanText(prefixMatch?.[1] || prefixMatch?.[2] || "");
  if (prefix && !/^\d+$/.test(prefix) && !/^(?:19|20)\d{2}(?:年)?$/.test(prefix)) return prefix;

  const suffix = value.match(/(?:-|_|—|｜|\|)\s*([^-_—｜|#]{2,16})$/)?.[1]?.trim();
  if (suffix && !/[，。！？,.!?]/.test(suffix)) return suffix;
  return platformFromUrl(url);
}

/** 通用候选标题选择器，用于没有稳定结构化卡片的平台兼容流程。 */
export function chooseTitle(
  anchorText: string,
  titleAttr: string,
  ariaLabel: string,
  cardTitle: string,
  contextText: string,
  url: string
): string {
  const directCandidates = [cardTitle, titleAttr, ariaLabel, anchorText]
    .map(cleanText)
    .filter((item) => item.length >= 4 && item.length <= 140 && !looksLikeUiText(item));

  const strongCandidate = directCandidates.find((item) => !looksLikePlatformOrHost(item, url));
  if (strongCandidate) return normalizeArticleTitle(strongCandidate);

  const contextLines = contextText
    .split(/[\n\r]+| {2,}/)
    .map(cleanText)
    .filter(Boolean)
    .filter((line) => line.length >= 6 && line.length <= 140)
    .filter((line) => !looksLikeUiText(line))
    .filter((line) => !looksLikePlatformOrHost(line, url))
    .filter((line) => !/^https?:\/\//i.test(line));

  const withoutDate = contextLines.map((line) => cleanText(line.replace(DATE_PATTERNS[0], "")));
  const usable = withoutDate.find((line) => line.length >= 6 && line.length <= 140);
  if (usable) return normalizeArticleTitle(usable);

  return platformFromUrl(url) || url;
}
