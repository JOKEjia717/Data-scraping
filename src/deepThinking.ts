/** 四个平台共用的深度思考状态识别与幂等切换。 */
import type { Locator, Page } from "playwright";
import type {
  DeepThinkingUnsupportedPolicy,
  PlatformConfig
} from "./types.js";

export interface DeepThinkingResolution {
  requested: boolean;
  /** null 表示按配置允许降级，平台实际状态不可用。 */
  actual: boolean | null;
  changed: boolean;
  degraded: boolean;
}

export class DeepThinkingTechnicalError extends Error {
  readonly errorCode: "DOM_CHANGED" | "TECHNICAL_FAILURE";

  constructor(
    message: string,
    errorCode: "DOM_CHANGED" | "TECHNICAL_FAILURE"
  ) {
    super(message);
    this.name = "DeepThinkingTechnicalError";
    this.errorCode = errorCode;
  }
}

/**
 * 在发送问题前把页面设置到目标状态。只有读取到确定的 true/false 才会继续；
 * 已处于目标状态时不会点击，点击后也必须再次读到目标状态。
 */
export async function ensureDeepThinkingState(
  page: Page,
  config: PlatformConfig,
  requested: boolean,
  unsupportedPolicy: DeepThinkingUnsupportedPolicy
): Promise<DeepThinkingResolution> {
  if (!config.deepThinkingControl.supported) {
    if (unsupportedPolicy === "allow_degrade") {
      return { requested, actual: null, changed: false, degraded: true };
    }
    throw new DeepThinkingTechnicalError(
      `${config.name} 配置为不支持深度思考，且当前策略禁止降级。`,
      "TECHNICAL_FAILURE"
    );
  }

  const explicitDisabled = await findExplicitDisabledState(page, config);
  if (explicitDisabled && !requested) {
    return {
      requested,
      actual: false,
      changed: false,
      degraded: false
    };
  }

  const control = await findDeepThinkingControl(page, config);
  if (!control) {
    throw new DeepThinkingTechnicalError(
      `${config.name} 找不到可识别的深度思考开关，无法确认目标状态。`,
      "DOM_CHANGED"
    );
  }
  const current = await readDeepThinkingState(
    control,
    config.deepThinkingControl.enabledClassNameFragment
  );
  if (current === null) {
    throw new DeepThinkingTechnicalError(
      `${config.name} 深度思考开关存在，但无法识别当前启用状态。`,
      "DOM_CHANGED"
    );
  }
  if (current === requested) {
    return { requested, actual: current, changed: false, degraded: false };
  }

  await control.click({ timeout: 2_000 }).catch((error) => {
    throw new DeepThinkingTechnicalError(
      `${config.name} 深度思考开关点击失败：${shortError(error)}`,
      "DOM_CHANGED"
    );
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const actual = await readDeepThinkingState(
      control,
      config.deepThinkingControl.enabledClassNameFragment
    );
    if (actual === requested) {
      return { requested, actual, changed: true, degraded: false };
    }
    if (!requested && await findExplicitDisabledState(page, config)) {
      return {
        requested,
        actual: false,
        changed: true,
        degraded: false
      };
    }
    await page.waitForTimeout(50);
  }
  throw new DeepThinkingTechnicalError(
    `${config.name} 深度思考开关点击后未能确认目标状态 ${String(requested)}。`,
    "DOM_CHANGED"
  );
}

/**
 * 读取平台明确展示的关闭态。它只在配置的语义入口可见且文案足够短时成立，
 * 避免宽泛的 :has-text 选择器命中整页祖先节点。
 */
async function findExplicitDisabledState(
  page: Page,
  config: PlatformConfig
): Promise<boolean> {
  for (const selector of config.deepThinkingControl.disabledStateSelectors ?? []) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice().reverse()) {
      if (!await locator.isVisible().catch(() => false)) continue;
      const text = (await locator.innerText({ timeout: 500 }).catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 0 && text.length <= 20) return true;
    }
  }
  return false;
}

async function findDeepThinkingControl(
  page: Page,
  config: PlatformConfig
): Promise<Locator | undefined> {
  for (const selector of config.deepThinkingControl.selectors) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice().reverse()) {
      const [visible, enabled] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false)
      ]);
      if (!visible || !enabled) continue;
      const text = (await locator.innerText({ timeout: 500 }).catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      // 防止宽泛 :has-text 选择器命中包含整页内容的祖先节点。
      if (text.length > 40) continue;
      return locator;
    }
  }
  return undefined;
}

/** 只接受明确状态，不依据颜色、完整 className 或按钮文案猜测。 */
async function readDeepThinkingState(
  locator: Locator,
  enabledClassNameFragment?: string
): Promise<boolean | null> {
  return locator.evaluate((node, classFragment) => {
    if (node instanceof HTMLInputElement && node.type === "checkbox") {
      return node.checked;
    }
    const booleanAttributes = ["aria-pressed", "aria-checked", "data-checked"];
    for (const attribute of booleanAttributes) {
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
    if (classFragment) {
      return String(node.getAttribute("class") ?? "").includes(classFragment);
    }
    return null;
  }, enabledClassNameFragment).catch(() => null);
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}
