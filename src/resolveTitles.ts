import type { ReferenceRecord } from "./types.js";
import { cleanText, looksLikePlatformOrHost, normalizeArticleTitle } from "./text.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

async function resolveRecordTitle(record: ReferenceRecord): Promise<ReferenceRecord> {
  if (!shouldResolveTitle(record)) return record;

  const title = await fetchArticleTitle(record.url).catch(() => "");
  if (!title || title.length < 4 || looksLikePlatformOrHost(title, record.url)) return record;

  return {
    ...record,
    title
  };
}

function shouldResolveTitle(record: ReferenceRecord): boolean {
  const title = cleanText(record.title);
  return (
    title.length < 8 ||
    looksLikePlatformOrHost(title, record.url) ||
    /^[-–—]?\s*\d+/.test(title) ||
    /^\d+(\.\d+)?$/.test(title)
  );
}

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

function detectCharset(contentType: string, htmlHead: string): string {
  const headerCharset = contentType.match(/charset=([^;\s]+)/i)?.[1];
  if (headerCharset) return headerCharset.trim().toLowerCase();

  const metaCharset =
    htmlHead.match(/<meta[^>]+charset=["']?\s*([^"'\s/>]+)/i)?.[1] ||
    htmlHead.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;>]+)/i)?.[1];

  return (metaCharset || "utf-8").trim().toLowerCase();
}

function decodeBuffer(buffer: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function extractHtmlTitle(html: string): string {
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

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

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
