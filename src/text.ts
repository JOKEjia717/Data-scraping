const DATE_PATTERNS = [
  /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/,
  /(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月/,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/,
  /\d{1,2}\s*[-/.]\s*\d{1,2}/,
  /\d+\s*(?:秒|分钟|小时|天|周|个月|年)前/,
  /(?:刚刚|今天|昨日|昨天|前天)/
];

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

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractDate(value: string): string {
  const text = cleanText(value);
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return cleanText(match[0]);
  }
  return "";
}

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

export function normalizeArticleTitle(value: string): string {
  return cleanText(value)
    .replace(/\s*[_|-]\s*(手机搜狐网|搜狐|易车|汽车之家|懂车帝|太平洋汽车|爱卡汽车|新浪财经|新浪|腾讯新闻|网易|凤凰网|36氪|雷峰网|中关村在线|百度百科)\s*$/i, "")
    .replace(/\s*[-_|]\s*.*?$/, (match) => (match.length <= 16 ? "" : match))
    .trim();
}

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

export function platformFromReferenceTitle(title: string, url: string): string {
  const value = cleanText(title);
  const prefixMatch = value.match(/^(?:【([^】]{2,24})】|\[([^\]]{2,24})\])/);
  const prefix = cleanText(prefixMatch?.[1] || prefixMatch?.[2] || "");
  if (prefix && !/^\d+$/.test(prefix) && !/^(?:19|20)\d{2}(?:年)?$/.test(prefix)) return prefix;

  const suffix = value.match(/(?:-|_|—|｜|\|)\s*([^-_—｜|#]{2,16})$/)?.[1]?.trim();
  if (suffix && !/[，。！？,.!?]/.test(suffix)) return suffix;
  return platformFromUrl(url);
}

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
