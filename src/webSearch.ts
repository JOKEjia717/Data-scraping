/** 联网搜索开关的结构化探测、幂等启用和业务策略校验。 */
import type { Locator, Page } from "playwright";
import type { RpaBusinessType } from "./rpaTask.js";
import type { PlatformConfig, WebSearchPolicy } from "./types.js";

export interface WebSearchActivationResult {
  requested: boolean;
  supported: boolean;
  enabled: boolean;
  verified: boolean;
  failureReason: string | null;
}

export class WebSearchTechnicalError extends Error {
  readonly errorCode: "WEB_SEARCH_UNSUPPORTED" | "WEB_SEARCH_UNVERIFIED";

  constructor(
    message: string,
    errorCode: "WEB_SEARCH_UNSUPPORTED" | "WEB_SEARCH_UNVERIFIED"
  ) {
    super(message);
    this.name = "WebSearchTechnicalError";
    this.errorCode = errorCode;
  }
}

/** ARTICLE_PROBE 固定强制联网；DIAGNOSIS 才接受部署配置。 */
export function webSearchPolicyForBusinessType(
  businessType: RpaBusinessType,
  diagnosisPolicy: WebSearchPolicy
): WebSearchPolicy {
  return businessType === "ARTICLE_PROBE" ? "REQUIRED" : diagnosisPolicy;
}

/**
 * 尝试把联网开关设置为启用并返回事实结果。函数本身不按策略抛错，调用方可先
 * 记录结果，再使用 enforceWebSearchPolicy 决定失败或降级。
 */
export async function activateWebSearch(
  page: Page,
  config: PlatformConfig,
  policy: WebSearchPolicy
): Promise<WebSearchActivationResult> {
  const requested = policy !== "DISABLED";
  if (!config.webSearchSupported) {
    return {
      requested,
      supported: false,
      enabled: false,
      verified: false,
      failureReason: requested ? `${config.name} 配置为不支持联网搜索。` : null
    };
  }

  const located = await findWebSearchControl(page, config);
  // DISABLED 明确不点击；若页面恰好暴露状态，则只读记录真实状态。
  if (!requested) {
    return {
      requested: false,
      supported: true,
      enabled: located?.state === true,
      verified: located?.state !== null && located?.state !== undefined,
      failureReason: null
    };
  }
  if (!located) {
    return failedResult(requested, true, `${config.name} 找不到联网搜索开关。`);
  }
  if (located.state === true) {
    return successfulResult(requested);
  }

  const clickFailure = await located.locator.click({ timeout: 1_500 })
    .then(() => undefined)
    .catch((error) => shortError(error));
  if (clickFailure) {
    return failedResult(
      requested,
      true,
      `${config.name} 联网搜索开关点击失败：${clickFailure}`
    );
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readToggleState(located.locator);
    if (state === true) return successfulResult(requested);
    await page.waitForTimeout(50);
  }
  return failedResult(
    requested,
    true,
    `${config.name} 联网搜索开关点击后无法确认已启用。`
  );
}

/** REQUIRED 必须确认 enabled；不支持平台使用稳定错误码。 */
export function enforceWebSearchPolicy(
  policy: WebSearchPolicy,
  result: WebSearchActivationResult
): void {
  if (policy !== "REQUIRED") return;
  if (!result.supported) {
    throw new WebSearchTechnicalError(
      result.failureReason ?? "平台不支持联网搜索。",
      "WEB_SEARCH_UNSUPPORTED"
    );
  }
  if (!result.enabled || !result.verified) {
    throw new WebSearchTechnicalError(
      result.failureReason ?? "联网搜索状态无法确认。",
      "WEB_SEARCH_UNVERIFIED"
    );
  }
}

/** business 联网未确认时，零引用不能被解释为普通成功。 */
export function assertVerifiedWebSearchForZeroReferences(
  result: WebSearchActivationResult
): void {
  if (!result.requested || (result.enabled && result.verified)) return;
  const errorCode = result.supported
    ? "WEB_SEARCH_UNVERIFIED"
    : "WEB_SEARCH_UNSUPPORTED";
  throw new WebSearchTechnicalError(
    `联网搜索未确认，零引用结果不能解释为正常未曝光：${result.failureReason ?? "状态未知"}`,
    errorCode
  );
}

interface LocatedWebSearchControl {
  locator: Locator;
  state: boolean | null;
}

async function findWebSearchControl(
  page: Page,
  config: PlatformConfig
): Promise<LocatedWebSearchControl | undefined> {
  let disabled: LocatedWebSearchControl | undefined;
  let unknown: LocatedWebSearchControl | undefined;
  for (const selector of config.webSearchButtonSelectors) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice(0, 4)) {
      const [visible, enabled] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false)
      ]);
      if (!visible || !enabled) continue;
      const text = (await locator.innerText({ timeout: 500 }).catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 40) continue;
      const candidate = { locator, state: await readToggleState(locator) };
      if (candidate.state === true) return candidate;
      if (candidate.state === false) disabled ??= candidate;
      else unknown ??= candidate;
    }
  }
  return disabled ?? unknown;
}

async function readToggleState(locator: Locator): Promise<boolean | null> {
  return locator.evaluate((node) => {
    if (node instanceof HTMLInputElement && node.type === "checkbox") {
      return node.checked;
    }
    for (const attribute of ["aria-pressed", "aria-checked", "data-checked"]) {
      const value = node.getAttribute(attribute)?.trim().toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
    }
    const state = node.getAttribute("data-state")?.trim().toLowerCase();
    if (["checked", "on", "active", "enabled", "selected"].includes(state ?? "")) {
      return true;
    }
    if (["unchecked", "off", "inactive", "disabled", "unselected"].includes(state ?? "")) {
      return false;
    }
    return null;
  }).catch(() => null);
}

function successfulResult(requested: boolean): WebSearchActivationResult {
  return {
    requested,
    supported: true,
    enabled: true,
    verified: true,
    failureReason: null
  };
}

function failedResult(
  requested: boolean,
  supported: boolean,
  failureReason: string
): WebSearchActivationResult {
  return { requested, supported, enabled: false, verified: false, failureReason };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}
