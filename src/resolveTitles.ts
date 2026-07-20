/**
 * DeepSeek 标题补全模块。只对疑似缺失/错误的标题请求原文章页面，
 * 从社交分享元数据或 HTML title 中恢复更可靠的标题。
 */
import type { ReferenceRecord } from "./types.js";
import { cleanText, looksLikePlatformOrHost, normalizeArticleTitle } from "./text.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 以 4 个并发为一批补全标题，避免同时请求过多来源站点。 */
export async function resolveRecordTitles(records: ReferenceRecord[]): Promise<ReferenceRecord[]> {
  const resolved: ReferenceRecord[] = [];
  const concurrency = 4;

  for (let i = 0; i < records.length; i += concurrency) {
    const chunk = records.slice(i, i + concurrency);
    const chunkResolved = await Promise.all(chunk.map(resolveRecordTitle));
    resolved.push(...chunkResolved);
  }

  return resolved;
}

/** 单条记录补全失败时保留原数据，不让外站错误中断整个抓取任务。 */
async function resolveRecordTitle(record: ReferenceRecord): Promise<ReferenceRecord> {
  if (!shouldResolveTitle(record)) return record;

  const title = await fetchArticleTitle(record.url).catch(() => "");
  if (!title || title.length < 4 || looksLikePlatformOrHost(title, record.url)) return record;

  return {
    ...record,
    title
  };
}

/** 仅处理过短、纯编号、平台名或域名形式的可疑标题。 */
function shouldResolveTitle(record: ReferenceRecord): boolean {
  const title = cleanText(record.title);
  return (
    title.length < 8 ||
    looksLikePlatformOrHost(title, record.url) ||
    /^[-–—]?\s*\d+/.test(title) ||
    /^\d+(\.\d+)?$/.test(title)
  );
}

/** 请求文章 HTML；限制 10 秒且拒绝非 HTML 响应。 */
async function fetchArticleTitle(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6"
    }
  });

  if (!response.ok) return "";
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return "";

  const buffer = await response.arrayBuffer();
  const head = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, 4096));
  const charset = detectCharset(contentType, head);
  const html = decodeBuffer(buffer, charset);
  return extractHtmlTitle(html);
}

/** 优先使用响应头字符集，其次读取 meta 声明，最后回退 UTF-8。 */
function detectCharset(contentType: string, htmlHead: string): string {
  const headerCharset = contentType.match(/charset=([^;\s]+)/i)?.[1];
  if (headerCharset) return headerCharset.trim().toLowerCase();

  const metaCharset =
    htmlHead.match(/<meta[^>]+charset=["']?\s*([^"'\s/>]+)/i)?.[1] ||
    htmlHead.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;>]+)/i)?.[1];

  return (metaCharset || "utf-8").trim().toLowerCase();
}

/** 按检测到的字符集解码，运行时不支持该字符集时安全回退 UTF-8。 */
function decodeBuffer(buffer: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

/** 按可靠性顺序选择元数据标题，并执行 HTML 实体与站点后缀清洗。 */
function extractHtmlTitle(html: string): string {
  // og:title 通常最接近文章标题；twitter:title 与 <title> 作为后备。
  const candidates = [
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1],
    html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  ];

  const title = candidates
    .map((candidate) => decodeHtmlEntities(stripTags(candidate || "")))
    .map(normalizeArticleTitle)
    .find((candidate) => candidate.length >= 4);

  return title || "";
}

/** 移除标题候选中意外夹带的 HTML 标签。 */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

/** 解码标题中常见命名实体和十进制/十六进制数字实体。 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}
