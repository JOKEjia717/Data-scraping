/**
 * 会话生命周期管理。
 *
 * ConversationManager 只决定何时轮换及会话归属；页面上的“新建对话”操作也封装
 * 在本模块。单题采集器 executeQuestion 不依赖本模块。
 */
import type { Locator, Page } from "playwright";
import type { BrandBatch } from "./scheduler.js";
import type { PlatformConfig, PlatformId } from "./types.js";

export type ConversationStatus = "active" | "damaged" | "ended";
export type ConversationEndReason =
  | "batch-completed"
  | "batch-failed"
  | "batch-started"
  | "identity-changed"
  | "damaged"
  | "max-duration"
  | "max-questions"
  | "reset";

export interface ConversationBatchContext {
  batchId: string;
  tenantId: string;
  brandId: string;
  businessTaskId: string;
  businessGroupId: string;
  platformId: PlatformId;
}

export interface ConversationState extends ConversationBatchContext {
  conversationGroupId: string;
  rotationSequence: number;
  status: ConversationStatus;
  startedAt: number;
  questionCount: number;
  lastQuestion?: string;
  endedAt?: number;
  endReason?: ConversationEndReason;
  errorMessage?: string;
}

/** 批次开始和身份变化是不可关闭的强制规则；数值上限可由调用方配置。 */
export interface ConversationPolicy {
  rotateOnBatchStart: true;
  rotateOnIdentityChange: true;
  maxDurationMs: number;
  maxQuestions: number;
  newConversationTimeoutMs: number;
}

export interface ConversationPageOperations {
  createNewConversation: (
    previousQuestion: string,
    timeoutMs: number
  ) => Promise<boolean>;
}

export interface ConversationManagerOptions {
  operations: ConversationPageOperations;
  policy?: Partial<ConversationPolicy>;
  now?: () => number;
}

const DEFAULT_POLICY: ConversationPolicy = {
  rotateOnBatchStart: true,
  rotateOnIdentityChange: true,
  maxDurationMs: Number.POSITIVE_INFINITY,
  maxQuestions: Number.POSITIVE_INFINITY,
  newConversationTimeoutMs: 15_000
};

export class ConversationManager {
  readonly policy: ConversationPolicy;
  private operations: ConversationPageOperations;
  private readonly now: () => number;
  private current?: ConversationState;
  private readonly states: ConversationState[] = [];
  private rotationSequence = 0;

  constructor(options: ConversationManagerOptions) {
    this.operations = options.operations;
    this.now = options.now ?? Date.now;
    this.policy = normalizePolicy(options.policy);
  }

  get currentState(): Readonly<ConversationState> | undefined {
    return this.current;
  }

  get history(): readonly Readonly<ConversationState>[] {
    return this.states;
  }

  /** CDP 重连后只替换页面操作句柄，不改变当前批次/对话归属。 */
  rebindOperations(operations: ConversationPageOperations): void {
    this.operations = operations;
  }

  /** 当前 BrandBatch 开始时强制创建一次新对话。 */
  async startBatch(
    context: ConversationBatchContext,
    previousQuestion = ""
  ): Promise<Readonly<ConversationState>> {
    validateContext(context);
    if (this.current) this.endCurrent("batch-started");
    return this.createAssignedConversation(context, previousQuestion);
  }

  /**
   * 每题执行前取得当前批次会话。身份变化、损坏或达到上限时强制轮换；正常情况下
   * 直接返回同一状态，因此不会按题新建对话。
   */
  async acquireForQuestion(
    context: ConversationBatchContext,
    previousQuestion = ""
  ): Promise<Readonly<ConversationState>> {
    validateContext(context);
    if (!this.current) return this.createAssignedConversation(context, previousQuestion);
    if (!sameConversationOwner(this.current, context)) {
      this.endCurrent("identity-changed");
      return this.createAssignedConversation(context, previousQuestion);
    }
    if (this.current.status === "damaged") {
      this.endCurrent("damaged");
      return this.createAssignedConversation(context, previousQuestion);
    }
    if (this.now() - this.current.startedAt >= this.policy.maxDurationMs) {
      this.endCurrent("max-duration");
      return this.createAssignedConversation(context, previousQuestion);
    }
    if (this.current.questionCount >= this.policy.maxQuestions) {
      this.endCurrent("max-questions");
      return this.createAssignedConversation(context, previousQuestion);
    }
    return this.current;
  }

  /** executeQuestion 成功返回后记录一次；它本身不会触发新建对话。 */
  recordQuestion(question: string): Readonly<ConversationState> {
    if (!this.current || this.current.status !== "active") {
      throw new Error("当前没有可记录问题的活动会话。");
    }
    this.current.questionCount += 1;
    this.current.lastQuestion = question;
    return this.current;
  }

  /** 页面错位、DOM 异常或会话损坏后标记；下一次取会话时强制轮换。 */
  markDamaged(error: unknown): Readonly<ConversationState> {
    if (!this.current) throw new Error("当前没有可标记损坏的活动会话。");
    this.current.status = "damaged";
    this.current.errorMessage = formatError(error);
    return this.current;
  }

  /** 批次结束后解除归属；该会话永远不会再分配给后续批次。 */
  finishBatch(
    batchId: string,
    outcome: "completed" | "failed" = "completed"
  ): Readonly<ConversationState> {
    if (!this.current || this.current.batchId !== batchId) {
      throw new Error(`当前活动会话不属于批次：${batchId}`);
    }
    return this.endCurrent(outcome === "completed" ? "batch-completed" : "batch-failed");
  }

  /** 兼容原 crawlPlatform：任务结束后切到未分配的空白会话。 */
  async resetToBlank(previousQuestion = ""): Promise<boolean> {
    if (this.current) this.endCurrent("reset");
    return this.operations.createNewConversation(
      previousQuestion,
      this.policy.newConversationTimeoutMs
    );
  }

  private async createAssignedConversation(
    context: ConversationBatchContext,
    previousQuestion: string
  ): Promise<Readonly<ConversationState>> {
    const opened = await this.operations.createNewConversation(
      previousQuestion,
      this.policy.newConversationTimeoutMs
    );
    if (!opened) {
      throw new Error(`无法为品牌批次创建独立新对话：${context.batchId}`);
    }

    const rotationSequence = ++this.rotationSequence;
    const state: ConversationState = {
      ...context,
      conversationGroupId: createConversationGroupId(context, rotationSequence),
      rotationSequence,
      status: "active",
      startedAt: this.now(),
      questionCount: 0
    };
    this.current = state;
    this.states.push(state);
    return state;
  }

  private endCurrent(reason: ConversationEndReason): ConversationState {
    if (!this.current) throw new Error("当前没有可结束的会话。");
    const ended = this.current;
    ended.status = "ended";
    ended.endedAt = this.now();
    ended.endReason = reason;
    this.current = undefined;
    return ended;
  }
}

/**
 * conversationGroupId = tenant + businessTask + brand + businessGroup + platform +
 * batch + rotationSequence。JSON 数组编码避免字符串分隔符碰撞。
 */
export function createConversationGroupId(
  context: ConversationBatchContext,
  rotationSequence: number
): string {
  return JSON.stringify([
    context.tenantId,
    context.businessTaskId,
    context.brandId,
    context.businessGroupId,
    context.platformId,
    context.batchId,
    rotationSequence
  ]);
}

/** 将 BrandBatch 转成会话上下文；业务任务默认使用 scheduler 的 businessGroupId。 */
export function conversationContextFromBrandBatch(
  batch: BrandBatch,
  identity: { tenantId: string; businessTaskId?: string }
): ConversationBatchContext {
  return {
    batchId: batch.id,
    tenantId: identity.tenantId,
    brandId: batch.brandId,
    businessTaskId: identity.businessTaskId ?? batch.businessGroupId,
    businessGroupId: batch.businessGroupId,
    platformId: batch.platformId
  };
}

/** 为现有 Playwright 页面创建 ConversationManager 适配器。 */
export function createPageConversationManager(
  page: Page,
  config: PlatformConfig,
  policy?: Partial<ConversationPolicy>
): ConversationManager {
  return new ConversationManager({
    policy,
    operations: conversationPageOperations(page, config)
  });
}

export function conversationPageOperations(
  page: Page,
  config: PlatformConfig
): ConversationPageOperations {
  return {
    createNewConversation: (previousQuestion, timeoutMs) =>
      openNewConversation(page, config, previousQuestion, timeoutMs)
  };
}

/**
 * 平台新建对话页面操作。只在确认会话已切换且输入框恢复后返回 true。
 */
export async function openNewConversation(
  page: Page,
  config: PlatformConfig,
  previousQuestion = "",
  timeoutMs = 15_000
): Promise<boolean> {
  if (!previousQuestion && await isKnownConversationBlank(page, config)) return true;

  const beforeUrl = page.url();
  const beforeBody = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const beforeQuestionCount = countTextOccurrences(beforeBody, previousQuestion);
  const startedAt = Date.now();

  for (const selector of config.newConversationButtonSelectors) {
    if (Date.now() - startedAt >= timeoutMs) break;
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators.slice().reverse()) {
      if (Date.now() - startedAt >= timeoutMs) break;
      const [visible, enabled, box] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false),
        locator.boundingBox().catch(() => null)
      ]);
      if (!visible || !enabled || !box || box.width > 500 || box.height > 180) continue;

      const clicked = await locator.click({ timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return false;
      const ready = await waitForNewConversationReady(
        page,
        config,
        beforeUrl,
        beforeBody,
        beforeQuestionCount,
        previousQuestion,
        Math.min(remainingMs, 6_000)
      );
      if (ready) return true;
    }
  }
  return false;
}

function normalizePolicy(policy: Partial<ConversationPolicy> = {}): ConversationPolicy {
  const runtimePolicy = policy as {
    rotateOnBatchStart?: boolean;
    rotateOnIdentityChange?: boolean;
  };
  if (
    runtimePolicy.rotateOnBatchStart === false ||
    runtimePolicy.rotateOnIdentityChange === false
  ) {
    throw new Error("批次开始和会话身份变化必须强制轮换，不能关闭。");
  }
  const normalized = { ...DEFAULT_POLICY, ...policy };
  if (normalized.maxQuestions !== Number.POSITIVE_INFINITY && normalized.maxQuestions < 2) {
    throw new Error("maxQuestions 必须至少为 2，禁止配置成每题新建对话。");
  }
  if (normalized.maxDurationMs <= 0) throw new Error("maxDurationMs 必须大于 0。");
  if (normalized.newConversationTimeoutMs <= 0) {
    throw new Error("newConversationTimeoutMs 必须大于 0。");
  }
  return normalized;
}

function sameConversationOwner(
  state: ConversationState,
  context: ConversationBatchContext
): boolean {
  return state.batchId === context.batchId &&
    state.tenantId === context.tenantId &&
    state.brandId === context.brandId &&
    state.businessTaskId === context.businessTaskId &&
    state.businessGroupId === context.businessGroupId &&
    state.platformId === context.platformId;
}

function validateContext(context: ConversationBatchContext): void {
  for (const [field, value] of Object.entries(context)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`会话批次字段不能为空：${field}`);
    }
  }
}

async function isKnownConversationBlank(page: Page, config: PlatformConfig): Promise<boolean> {
  const messageSelectors: Record<PlatformConfig["id"], string> = {
    doubao: "[data-container-type='block-v2'], [data-testid*='message']",
    deepseek: ".ds-message, .ds-markdown.ds-assistant-message-main-content",
    qianwen: ".qk-markdown, [data-message-id]",
    yuanbao: "[data-conv-speaker], .agent-chat__speech-card__text"
  };
  const [messageCount, inputBox, busy] = await Promise.all([
    page.locator(messageSelectors[config.id]).count().catch(() => -1),
    findInput(page, config.inputSelectors, 1_000),
    isAnswerGenerating(page)
  ]);
  return messageCount === 0 && Boolean(inputBox) && !busy;
}

async function waitForNewConversationReady(
  page: Page,
  config: PlatformConfig,
  beforeUrl: string,
  beforeBody: string,
  beforeQuestionCount: number,
  previousQuestion: string,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const [bodyText, inputBox] = await Promise.all([
      page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
      findInput(page, config.inputSelectors, 500)
    ]);
    const currentQuestionCount = countTextOccurrences(bodyText, previousQuestion);
    const conversationChanged =
      page.url() !== beforeUrl ||
      (beforeQuestionCount > 0 && currentQuestionCount < beforeQuestionCount) ||
      (Boolean(previousQuestion) && !bodyText.includes(previousQuestion)) ||
      bodyText.replace(/\s+/g, " ").trim() !== beforeBody.replace(/\s+/g, " ").trim();
    if (inputBox && conversationChanged && !await isAnswerGenerating(page)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function findInput(
  page: Page,
  selectors: string[],
  timeoutMs: number
): Promise<Locator | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
    await page.waitForTimeout(500);
  }
  return null;
}

async function isAnswerGenerating(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`
(() => Array.from(document.querySelectorAll("button, [role='button']")).some((element) => {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") return false;
  const text = [element.textContent || "", element.getAttribute("aria-label") || "", element.getAttribute("title") || ""].join(" ");
  return /停止生成|停止回答|暂停生成|中止生成|Stop generating|Stop responding/i.test(text);
}))()
`).catch(() => false);
}

function countTextOccurrences(text: string, value: string): number {
  return value ? text.split(value).length - 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
