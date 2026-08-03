/**
 * 长期 Worker 启动自检与错误分类。
 *
 * 本模块不写数据库、不写普通输出文件，也不会把页面正文打印到控制台。
 */
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { PlatformHealthStatus } from "./platformExecution.js";
import type { PlatformConfig, PlatformId } from "./types.js";

export const WORKER_ERROR_CODES = [
  "CDP_CONNECTION_FAILED",
  "PLATFORM_TAB_MISSING",
  "INPUT_UNAVAILABLE",
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "ANONYMOUS_QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "DOM_CHANGED",
  "BROWSER_DISCONNECTED",
  "PAGE_DISCONNECTED",
  "ANSWER_TIMEOUT",
  "EMPTY_ANSWER",
  "WEB_SEARCH_UNSUPPORTED",
  "WEB_SEARCH_UNVERIFIED",
  "DATABASE_ERROR",
  "FILESYSTEM_ERROR",
  "CONFIGURATION_ERROR",
  "OUTBOX_CORRUPTED",
  "PLATFORM_BLOCKED",
  "REFERENCE_UNKNOWN",
  "TECHNICAL_FAILURE"
] as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

export interface PageBlockerClassification {
  errorCode: Extract<
    WorkerErrorCode,
    | "LOGIN_REQUIRED"
    | "CAPTCHA_REQUIRED"
    | "ANONYMOUS_QUOTA_EXCEEDED"
    | "RATE_LIMITED"
  >;
  healthStatus: PlatformHealthStatus;
  reason: string;
}

export interface PlatformSelfCheckResult {
  platformId: PlatformId;
  ready: boolean;
  currentUrl?: string;
  errorCode?: WorkerErrorCode;
  healthStatus: PlatformHealthStatus;
  reason?: string;
  /** 只供后续 Worker 使用，不应序列化进日志。 */
  page?: Page;
}

export interface BrowserSelfCheckResult {
  connected: boolean;
  browser?: Browser;
  platforms: Record<PlatformId, PlatformSelfCheckResult | undefined>;
}

export interface BrowserSelfCheckOptions {
  cdpEndpoint: string;
  platforms: readonly PlatformConfig[];
  inputTimeoutMs?: number;
  onPlatformFailure?: (
    result: PlatformSelfCheckResult,
    page?: Page
  ) => void | Promise<void>;
}

/**
 * 纯函数：识别登录、验证码、匿名额度和限流提示。输入应优先来自对话框、横幅、
 * 登录页等页面信号，而不是无界的整页历史聊天正文。
 */
export function classifyPageBlockerText(text: string): PageBlockerClassification | undefined {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;

  if (
    /验证码|人机验证|安全验证|滑块验证|完成验证|captcha|verify\s+(?:that\s+)?you\s+are\s+human/i
      .test(normalized)
  ) {
    return {
      errorCode: "CAPTCHA_REQUIRED",
      healthStatus: "CAPTCHA_REQUIRED",
      reason: "页面要求完成验证码或人机验证"
    };
  }

  if (
    /游客|匿名|未登录|guest|anonymous/i.test(normalized) &&
    /额度|次数|上限|限制|quota|limit/i.test(normalized) &&
    /用完|耗尽|达到|不足|exhausted|reached|used\s+up/i.test(normalized)
  ) {
    return {
      errorCode: "ANONYMOUS_QUOTA_EXCEEDED",
      healthStatus: "RATE_LIMITED",
      reason: "匿名或游客额度已耗尽"
    };
  }

  if (
    /请求过于频繁|操作过于频繁|操作频繁|访问频繁|稍后再试|达到(?:今日|当前)?(?:使用)?上限|限流|rate\s*limit|too\s+many\s+requests|try\s+again\s+later/i
      .test(normalized)
  ) {
    return {
      errorCode: "RATE_LIMITED",
      healthStatus: "RATE_LIMITED",
      reason: "平台提示请求频繁或达到使用上限"
    };
  }

  if (
    /请(?:先)?登录|登录后(?:即可|继续|使用)|扫码登录|手机号登录|账号登录|立即登录|sign\s*in|log\s*in/i
      .test(normalized)
  ) {
    return {
      errorCode: "LOGIN_REQUIRED",
      healthStatus: "LOGIN_REQUIRED",
      reason: "页面要求重新登录"
    };
  }

  return undefined;
}

/** 纯函数：把稳定错误码映射为平台健康状态。 */
export function healthStatusForErrorCode(errorCode: WorkerErrorCode): PlatformHealthStatus {
  switch (errorCode) {
    case "LOGIN_REQUIRED":
      return "LOGIN_REQUIRED";
    case "CAPTCHA_REQUIRED":
      return "CAPTCHA_REQUIRED";
    case "ANONYMOUS_QUOTA_EXCEEDED":
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "DOM_CHANGED":
    case "WEB_SEARCH_UNSUPPORTED":
    case "WEB_SEARCH_UNVERIFIED":
    case "REFERENCE_UNKNOWN":
      return "DOM_CHANGED";
    case "CDP_CONNECTION_FAILED":
    case "PLATFORM_TAB_MISSING":
      return "DISABLED";
    case "DATABASE_ERROR":
    case "FILESYSTEM_ERROR":
      return "READY";
    default:
      return "COOLING_DOWN";
  }
}

/** 纯函数：将运行时异常归一为可聚合、可测试的错误码。 */
export function classifyTechnicalError(error: unknown): WorkerErrorCode {
  const explicitCode = readExplicitErrorCode(error);
  if (explicitCode) return explicitCode;

  const explicitHealthStatus = readExplicitHealthStatus(error);
  if (explicitHealthStatus) {
    const healthErrorCodes: Partial<Record<PlatformHealthStatus, WorkerErrorCode>> = {
      LOGIN_REQUIRED: "LOGIN_REQUIRED",
      CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
      RATE_LIMITED: "RATE_LIMITED",
      DOM_CHANGED: "DOM_CHANGED",
      COOLING_DOWN: "TECHNICAL_FAILURE"
    };
    const mapped = healthErrorCodes[explicitHealthStatus];
    if (mapped) return mapped;
  }

  const message = error instanceof Error ? error.message : String(error);
  const blocker = classifyPageBlockerText(message);
  if (blocker) return blocker.errorCode;
  if (/connectOverCDP|ECONNREFUSED|websocket.*(?:connect|closed)/i.test(message)) {
    return "CDP_CONNECTION_FAILED";
  }
  if (/browser.*disconnected|browser has been closed|浏览器.*断开/i.test(message)) {
    return "BROWSER_DISCONNECTED";
  }
  if (/target page.*closed|page.*(?:closed|crashed)|页面断开/i.test(message)) {
    return "PAGE_DISCONNECTED";
  }
  if (/输入框|input.*(?:missing|unavailable|not found)|textbox.*not found/i.test(message)) {
    return "INPUT_UNAVAILABLE";
  }
  if (/回答正文为空|正文为空|empty answer|answer body.*empty/i.test(message)) {
    return "EMPTY_ANSWER";
  }
  if (/DOM|selector|locator|解析有效引用|引用结构/i.test(message)) {
    return "DOM_CHANGED";
  }
  if (/timeout|timed out|超时|长时间没有/i.test(message)) return "ANSWER_TIMEOUT";
  return "TECHNICAL_FAILURE";
}

/**
 * 连接一次 CDP，并逐个平台检查标签页、阻断提示和输入框。单个平台失败不会终止
 * 其他平台的检查；连接成功后 Browser 交还调用方继续用于 Worker。
 */
export async function runBrowserSelfCheck(
  options: BrowserSelfCheckOptions
): Promise<BrowserSelfCheckResult> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(options.cdpEndpoint, {
      // 附加到用户已登录的 Chrome 时不覆盖下载、焦点和媒体状态；同时兼容
      // Chrome 151 不支持 Browser.setDownloadBehavior 上下文参数的环境。
      noDefaults: true
    });
  } catch (error) {
    const platforms = emptyPlatformResults();
    for (const config of options.platforms) {
      const result: PlatformSelfCheckResult = {
        platformId: config.id,
        ready: false,
        errorCode: "CDP_CONNECTION_FAILED",
        healthStatus: "DISABLED",
        reason: boundedErrorMessage(error)
      };
      platforms[config.id] = result;
      await notifyPlatformFailure(options, result);
    }
    return { connected: false, platforms };
  }

  const pages = browser.contexts().flatMap((context) => context.pages());
  const platforms = emptyPlatformResults();
  for (const config of options.platforms) {
    const page = findPlatformPage(pages, config);
    if (!page) {
      const result: PlatformSelfCheckResult = {
        platformId: config.id,
        ready: false,
        errorCode: "PLATFORM_TAB_MISSING",
        healthStatus: "DISABLED",
        reason: `没有找到已打开的 ${config.name} 标签页`
      };
      platforms[config.id] = result;
      await notifyPlatformFailure(options, result);
      continue;
    }

    const result = await inspectPlatformPage(page, config, options.inputTimeoutMs ?? 8_000)
      .catch((error): PlatformSelfCheckResult => {
        const errorCode = classifyTechnicalError(error);
        return failedSelfCheck(
          config.id,
          errorCode,
          safePageUrl(page),
          boundedErrorMessage(error)
        );
      });
    platforms[config.id] = result;
    if (!result.ready) await notifyPlatformFailure(options, result, page);
  }

  return { connected: true, browser, platforms };
}

export async function inspectPlatformPage(
  page: Page,
  config: PlatformConfig,
  inputTimeoutMs = 8_000
): Promise<PlatformSelfCheckResult> {
  const currentUrl = safePageUrl(page);
  if (page.isClosed()) {
    return failedSelfCheck(config.id, "PAGE_DISCONNECTED", currentUrl, "平台标签页已关闭");
  }

  const signalText = await collectPageBlockerSignals(page);
  const blocker = classifyPageBlockerText(signalText);
  if (blocker) {
    return {
      platformId: config.id,
      ready: false,
      currentUrl,
      ...blocker
    };
  }

  const input = await findAvailableInput(page, config.inputSelectors, inputTimeoutMs);
  if (input) {
    return {
      platformId: config.id,
      ready: true,
      currentUrl,
      healthStatus: "READY",
      page
    };
  }

  // 登录页可能没有 dialog/banner；仅在输入框缺失时读取受限的正文作为二次判断。
  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const bodyBlocker = classifyPageBlockerText(bodyText.slice(0, 8_000));
  if (bodyBlocker) {
    return {
      platformId: config.id,
      ready: false,
      currentUrl,
      ...bodyBlocker
    };
  }

  return failedSelfCheck(
    config.id,
    "INPUT_UNAVAILABLE",
    currentUrl,
    `没有找到可见且可用的 ${config.name} 输入框`
  );
}

export function findPlatformPage(pages: readonly Page[], config: PlatformConfig): Page | undefined {
  const targetHosts = (config.hostnames ?? [new URL(config.url).hostname])
    .map((host) => host.replace(/^www\./, ""));
  return pages.find((page) => {
    try {
      const pageHost = new URL(page.url()).hostname.replace(/^www\./, "");
      return targetHosts.some(
        (targetHost) => pageHost === targetHost || pageHost.endsWith(`.${targetHost}`)
      );
    } catch {
      return false;
    }
  });
}

async function collectPageBlockerSignals(page: Page): Promise<string> {
  const selector = [
    "[role='dialog']",
    "[role='alert']",
    "[aria-modal='true']",
    "[class*='captcha']",
    "[class*='verify']",
    "[class*='login']",
    "[class*='limit']",
    "[class*='quota']"
  ].join(",");
  const candidates = await page.locator(selector).all().catch(() => []);
  const texts: string[] = [];
  for (const candidate of candidates.slice(0, 30)) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = await candidate.innerText({ timeout: 500 }).catch(() => "");
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(0, 8_000);
}

async function findAvailableInput(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number
): Promise<Locator | undefined> {
  const startedAt = Date.now();
  do {
    for (const selector of selectors) {
      const locators = await page.locator(selector).all().catch(() => []);
      for (const locator of locators.slice().reverse()) {
        const [visible, enabled] = await Promise.all([
          locator.isVisible().catch(() => false),
          locator.isEnabled().catch(() => false)
        ]);
        if (visible && enabled) return locator;
      }
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await page.waitForTimeout(Math.min(250, timeoutMs));
  } while (Date.now() - startedAt < timeoutMs);
  return undefined;
}

function failedSelfCheck(
  platformId: PlatformId,
  errorCode: WorkerErrorCode,
  currentUrl: string,
  reason: string
): PlatformSelfCheckResult {
  return {
    platformId,
    ready: false,
    currentUrl,
    errorCode,
    healthStatus: healthStatusForErrorCode(errorCode),
    reason
  };
}

function emptyPlatformResults(): Record<PlatformId, PlatformSelfCheckResult | undefined> {
  return {
    doubao: undefined,
    deepseek: undefined,
    qianwen: undefined,
    yuanbao: undefined
  };
}

function readExplicitErrorCode(error: unknown): WorkerErrorCode | undefined {
  if (!error || typeof error !== "object" || !("errorCode" in error)) return undefined;
  const errorCode = (error as { errorCode?: unknown }).errorCode;
  return typeof errorCode === "string" &&
    (WORKER_ERROR_CODES as readonly string[]).includes(errorCode)
    ? errorCode as WorkerErrorCode
    : undefined;
}

function readExplicitHealthStatus(error: unknown): PlatformHealthStatus | undefined {
  if (!error || typeof error !== "object" || !("healthStatus" in error)) return undefined;
  const status = (error as { healthStatus?: unknown }).healthStatus;
  const statuses: readonly PlatformHealthStatus[] = [
    "READY",
    "RUNNING",
    "COOLING_DOWN",
    "RATE_LIMITED",
    "CAPTCHA_REQUIRED",
    "LOGIN_REQUIRED",
    "DOM_CHANGED",
    "DISABLED"
  ];
  return typeof status === "string" && (statuses as readonly string[]).includes(status)
    ? status as PlatformHealthStatus
    : undefined;
}

function safePageUrl(page: Page): string {
  try {
    const value = page.url().slice(0, 2_000);
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|key|secret|password|passwd|session|cookie|auth/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function notifyPlatformFailure(
  options: BrowserSelfCheckOptions,
  result: PlatformSelfCheckResult,
  page?: Page
): Promise<void> {
  try {
    await options.onPlatformFailure?.(result, page);
  } catch {
    // 证据或告警回调失败不能阻断其他平台的启动自检。
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 16_000);
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return normalizeText(message).slice(0, 500);
}
