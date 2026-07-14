export type PlatformId = "doubao" | "deepseek" | "qianwen" | "yuanbao";

export interface CliOptions {
  cdpEndpoint: string;
  outDir: string;
  platforms: PlatformId[];
  questionFile?: string;
  promptPrefix: string;
  resolveTitles: boolean;
  timeoutMs: number;
}

export interface PlatformConfig {
  id: PlatformId;
  name: string;
  url: string;
  hostnames?: string[];
  inputSelectors: string[];
  sendButtonSelectors: string[];
  webSearchButtonSelectors: string[];
  referenceRevealSelectors: string[];
}

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

export interface ReferenceRecord {
  question: string;
  crawlPlatform: string;
  rank: number;
  articlePlatform: string;
  articleTime: string;
  title: string;
  summary: string;
  url: string;
  extractedAt: string;
}
