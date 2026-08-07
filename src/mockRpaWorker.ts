/**
 * 不依赖项目数据库的 Mock RPA Worker。
 *
 * 任务可来自内存或本地 JSON；BrandBatchScheduler 负责分批，ConversationManager
 * 负责批次会话，MultiPlatformExecutionLayer 负责四个平台独立串行队列。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ConversationManager,
  type ConversationBatchContext
} from "./conversationManager.js";
import {
  MultiPlatformExecutionLayer,
  PLATFORM_IDS,
  type ExecutePlatformTaskContext,
  type PlatformExecutionConfig,
  type PlatformTaskOutcome
} from "./platformExecution.js";
import { BrandBatchScheduler, type BrandBatch } from "./scheduler.js";
import { classifyTechnicalError, type WorkerErrorCode } from "./browserDiagnostics.js";
import type { PlatformId, ReferenceRecord } from "./types.js";

export const MOCK_BUSINESS_TYPES = ["DIAGNOSIS", "ARTICLE_PROBE", "ENTRY_MONITOR"] as const;
export type MockBusinessType = (typeof MOCK_BUSINESS_TYPES)[number];

export interface MockRpaTask {
  executionId: string;
  businessType: MockBusinessType;
  businessTaskId: string;
  tenantKey: string;
  brandId: string;
  keyword: string;
  aiModelId: string;
  aiModelName: string;
  deepThinking: boolean;
  projectId?: string;
  intentEntryId?: string;
  monitorDate?: string;
  repetitionNo?: number;
}

export type MockExecutionStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface CollectionResult extends MockRpaTask {
  platform: PlatformId;
  conversationGroupId: string;
  questionIndex: number;
  submittedQuestion: string;
  requestedDeepThinking: boolean;
  actualDeepThinking: boolean | null;
  webSearchRequested: boolean;
  webSearchEnabled: boolean;
  webSearchVerified: boolean;
  status: "SUCCESS" | "FAILED";
  answer: string;
  references: ReferenceRecord[];
  referenceCount: number;
  retryCount: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorCode: WorkerErrorCode | null;
  errorMessage?: string;
}

export interface MockExecutionState {
  executionId: string;
  businessTaskId: string;
  brandId: string;
  platform: PlatformId;
  status: MockExecutionStatus;
  batchId?: string;
  conversationGroupId?: string;
  updatedAt: string;
  result?: CollectionResult;
}

export interface MockQuestionCollection {
  submittedQuestion: string;
  answer: string;
  references: ReferenceRecord[];
  referenceCount: number;
  retryCount: number;
  actualDeepThinking?: boolean | null;
  webSearchRequested: boolean;
  webSearchEnabled: boolean;
  webSearchVerified: boolean;
}

export interface MockQuestionExecutionContext {
  task: MockRpaTask;
  platformId: PlatformId;
  conversationGroupId: string;
  questionIndex: number;
}

export type MockQuestionExecutor = (
  context: MockQuestionExecutionContext
) => Promise<MockQuestionCollection>;

export interface MockTaskSource {
  load(): Promise<readonly MockRpaTask[]>;
}

export interface MockExecutionStateStoreOptions {
  outputDirectory?: string;
  stateFileName?: string;
  resultFileName?: string;
  now?: () => number;
}

export interface MockRpaWorkerOptions {
  taskSource: MockTaskSource;
  conversationManagers: Partial<Record<PlatformId, ConversationManager>>;
  executeQuestion: MockQuestionExecutor;
  stateStore?: MockExecutionStateStore;
  platforms?: readonly PlatformId[];
  platformConfig?: Partial<Record<PlatformId, Partial<PlatformExecutionConfig>>>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface MockRpaWorkerRunResult {
  collectionResults: readonly CollectionResult[];
  executionStates: readonly MockExecutionState[];
}

export class InMemoryMockTaskSource implements MockTaskSource {
  constructor(private readonly tasks: readonly MockRpaTask[]) {}

  async load(): Promise<readonly MockRpaTask[]> {
    return normalizeMockRpaTasks(this.tasks);
  }
}

export class JsonMockTaskSource implements MockTaskSource {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Mock 任务 JSON 路径不能为空。");
  }

  async load(): Promise<readonly MockRpaTask[]> {
    const content = await fs.readFile(this.filePath, "utf8");
    return normalizeMockRpaTasks(JSON.parse(content) as unknown);
  }
}

/** 内存为主、可选 JSON 快照的模拟状态存储，不连接 MySQL。 */
export class MockExecutionStateStore {
  private readonly states = new Map<string, MockExecutionState>();
  private readonly taskOrder: string[] = [];
  private readonly outputDirectory?: string;
  private readonly stateFileName: string;
  private readonly resultFileName: string;
  private readonly now: () => number;
  private pendingWrite = Promise.resolve();

  constructor(options: MockExecutionStateStoreOptions = {}) {
    this.outputDirectory = options.outputDirectory
      ? path.resolve(options.outputDirectory)
      : undefined;
    this.stateFileName = validateJsonFileName(
      options.stateFileName ?? "execution-state.json",
      "stateFileName"
    );
    this.resultFileName = validateJsonFileName(
      options.resultFileName ?? "collection-results.json",
      "resultFileName"
    );
    this.now = options.now ?? Date.now;
  }

  async initialize(tasks: readonly MockRpaTask[]): Promise<void> {
    await this.mutate(async () => {
      this.states.clear();
      this.taskOrder.length = 0;
      for (const task of tasks) {
        this.taskOrder.push(task.executionId);
        this.states.set(task.executionId, {
          executionId: task.executionId,
          businessTaskId: task.businessTaskId,
          brandId: task.brandId,
          platform: resolveMockPlatformId(task),
          status: "PENDING",
          updatedAt: this.timestamp()
        });
      }
    });
  }

  async markRunning(
    executionId: string,
    batchId: string,
    conversationGroupId: string
  ): Promise<void> {
    await this.mutate(async () => {
      const state = this.requireState(executionId);
      state.status = "RUNNING";
      state.batchId = batchId;
      state.conversationGroupId = conversationGroupId;
      state.updatedAt = this.timestamp();
    });
  }

  async complete(result: CollectionResult): Promise<void> {
    await this.mutate(async () => {
      const state = this.requireState(result.executionId);
      state.status = result.status;
      state.conversationGroupId = result.conversationGroupId;
      state.result = result;
      state.updatedAt = this.timestamp();
    });
  }

  getStates(): MockExecutionState[] {
    return this.taskOrder.map((executionId) => structuredClone(this.requireState(executionId)));
  }

  getResults(): CollectionResult[] {
    return this.taskOrder.flatMap((executionId) => {
      const result = this.requireState(executionId).result;
      return result ? [structuredClone(result)] : [];
    });
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  private async mutate(operation: () => void | Promise<void>): Promise<void> {
    const next = this.pendingWrite.then(async () => {
      await operation();
      await this.persist();
    });
    this.pendingWrite = next.catch(() => undefined);
    await next;
  }

  private async persist(): Promise<void> {
    if (!this.outputDirectory) return;
    await fs.mkdir(this.outputDirectory, { recursive: true });
    const states = {
      updatedAt: this.timestamp(),
      executions: this.getStates()
    };
    await Promise.all([
      writeJsonAtomically(
        path.join(this.outputDirectory, this.stateFileName),
        states
      ),
      writeJsonAtomically(
        path.join(this.outputDirectory, this.resultFileName),
        this.getResults()
      )
    ]);
  }

  private requireState(executionId: string): MockExecutionState {
    const state = this.states.get(executionId);
    if (!state) throw new Error(`模拟执行状态不存在：${executionId}`);
    return state;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

export class MockRpaWorker {
  private readonly scheduler = new BrandBatchScheduler();
  private readonly stateStore: MockExecutionStateStore;
  private readonly layer: MultiPlatformExecutionLayer;
  private readonly conversationManagers: Partial<Record<PlatformId, ConversationManager>>;
  private readonly executeQuestion: MockQuestionExecutor;
  private readonly now: () => number;
  private readonly taskSource: MockTaskSource;
  private readonly tasksByExecutionId = new Map<string, MockRpaTask>();
  private readonly conversationByPlatform = new Map<PlatformId, string>();

  constructor(options: MockRpaWorkerOptions) {
    this.stateStore = options.stateStore ?? new MockExecutionStateStore();
    this.conversationManagers = options.conversationManagers;
    this.executeQuestion = options.executeQuestion;
    this.now = options.now ?? Date.now;
    this.taskSource = options.taskSource;
    this.layer = new MultiPlatformExecutionLayer({
      scheduler: this.scheduler,
      platforms: options.platforms ?? PLATFORM_IDS,
      config: options.platformConfig,
      now: this.now,
      sleep: options.sleep,
      executeTask: (context) => this.executeScheduledQuestion(context),
      hooks: {
        onBatchStart: (batch) => this.startBatchConversation(batch),
        onBatchComplete: (batch) => this.finishBatchConversation(batch, "completed"),
        onBatchFailed: async (batch, error) => {
          await this.failUnfinishedBatchTasks(batch, error);
          await this.finishBatchConversation(batch, "failed");
        }
      }
    });
  }

  async run(): Promise<MockRpaWorkerRunResult> {
    const tasks = normalizeMockRpaTasks(await this.taskSource.load());
    this.validateWorkerDependencies(tasks);
    await this.stateStore.initialize(tasks);
    for (const task of tasks) {
      this.tasksByExecutionId.set(task.executionId, task);
      this.layer.enqueue({
        id: task.executionId,
        brandId: task.brandId,
        businessGroupId: createMockBusinessGroupId(task),
        platformId: resolveMockPlatformId(task),
        // business 模式严格原样使用 keyword，不能拼接提示词。
        question: task.keyword
      });
    }

    while (true) {
      const tickResults = await this.layer.tick();
      const progressed = Object.values(tickResults).some(
        (result) => result?.kind === "completed" || result?.kind === "failed"
      );
      if (!progressed) break;
    }
    await this.stateStore.flush();
    return {
      collectionResults: this.stateStore.getResults(),
      executionStates: this.stateStore.getStates()
    };
  }

  private async startBatchConversation(batch: BrandBatch): Promise<void> {
    const firstTask = this.requireMockTask(batch.tasks[0]?.id);
    const manager = this.requireConversationManager(batch.platformId);
    const context: ConversationBatchContext = {
      batchId: batch.id,
      tenantId: firstTask.tenantKey,
      brandId: firstTask.brandId,
      businessTaskId: firstTask.businessTaskId,
      businessGroupId: batch.businessGroupId,
      platformId: batch.platformId
    };
    const state = await manager.startBatch(context);
    this.conversationByPlatform.set(batch.platformId, state.conversationGroupId);
  }

  private async finishBatchConversation(
    batch: BrandBatch,
    outcome: "completed" | "failed"
  ): Promise<void> {
    const manager = this.requireConversationManager(batch.platformId);
    if (manager.currentState?.batchId === batch.id) {
      if (outcome === "failed" && manager.currentState.status === "active") {
        manager.markDamaged(batch.errorMessage ?? "品牌批次技术失败");
      }
      manager.finishBatch(batch.id, outcome);
      const lastTask = this.requireMockTask(batch.tasks[batch.tasks.length - 1]?.id);
      const opened = await manager.resetToBlank(lastTask.keyword);
      if (!opened) {
        throw new Error(`批次 ${batch.id} 完成后无法创建新对话。`);
      }
    }
    this.conversationByPlatform.delete(batch.platformId);
  }

  private async executeScheduledQuestion(
    context: ExecutePlatformTaskContext
  ): Promise<PlatformTaskOutcome> {
    const task = this.requireMockTask(context.task.id);
    const manager = this.requireConversationManager(context.platformId);
    const conversationGroupId = this.conversationByPlatform.get(context.platformId);
    if (!conversationGroupId || manager.currentState?.batchId !== context.batch.id) {
      throw new Error(`批次 ${context.batch.id} 没有可用的活动对话。`);
    }

    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();
    await this.stateStore.markRunning(
      task.executionId,
      context.batch.id,
      conversationGroupId
    );

    try {
      const collection = await this.executeQuestion({
        task,
        platformId: context.platformId,
        conversationGroupId,
        questionIndex: context.taskIndex + 1
      });
      if (collection.submittedQuestion !== task.keyword) {
        throw new Error(
          `business 模式实际发送问题与 keyword 不一致：${task.executionId}`
        );
      }
      manager.recordQuestion(task.keyword);
      const completedAtMs = this.now();
      const result: CollectionResult = {
        ...task,
        platform: context.platformId,
        conversationGroupId,
        questionIndex: context.taskIndex + 1,
        submittedQuestion: collection.submittedQuestion,
        requestedDeepThinking: task.deepThinking,
        actualDeepThinking: collection.actualDeepThinking ?? null,
        webSearchRequested: collection.webSearchRequested,
        webSearchEnabled: collection.webSearchEnabled,
        webSearchVerified: collection.webSearchVerified,
        status: "SUCCESS",
        answer: collection.answer,
        references: collection.references,
        referenceCount: collection.referenceCount,
        retryCount: collection.retryCount,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        errorCode: null
      };
      await this.stateStore.complete(result);
      return {
        status: collection.referenceCount === 0 ? "zero_references" : "success",
        referenceCount: collection.referenceCount,
        retryCount: collection.retryCount,
        conversationGroupId,
        submittedQuestion: collection.submittedQuestion
      };
    } catch (error) {
      const completedAtMs = this.now();
      await this.stateStore.complete(createFailedCollectionResult({
        task,
        platformId: context.platformId,
        conversationGroupId,
        questionIndex: context.taskIndex + 1,
        startedAt,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        error
      }));
      throw error;
    }
  }

  private async failUnfinishedBatchTasks(batch: BrandBatch, error: unknown): Promise<void> {
    for (const [questionIndex, batchTask] of batch.tasks.entries()) {
      const task = this.requireMockTask(batchTask.id);
      const state = this.stateStore.getStates().find(
        ({ executionId }) => executionId === task.executionId
      );
      if (!state || state.status === "SUCCESS" || state.status === "FAILED") continue;
      const completedAtMs = this.now();
      await this.stateStore.complete(createFailedCollectionResult({
        task,
        platformId: batch.platformId,
        conversationGroupId: this.conversationByPlatform.get(batch.platformId) ?? "unavailable",
        questionIndex: questionIndex + 1,
        startedAt: state.updatedAt,
        completedAtMs,
        durationMs: 0,
        error
      }));
    }
  }

  private validateWorkerDependencies(tasks: readonly MockRpaTask[]): void {
    const configuredPlatforms = new Set(PLATFORM_IDS.filter(
      (platformId) => {
        try {
          this.layer.getPlatformHealth(platformId);
          return true;
        } catch {
          return false;
        }
      }
    ));
    for (const task of tasks) {
      const platformId = resolveMockPlatformId(task);
      if (!configuredPlatforms.has(platformId)) {
        throw new Error(`Mock Worker 未配置平台队列：${platformId}`);
      }
      this.requireConversationManager(platformId);
    }
  }

  private requireMockTask(executionId: string | undefined): MockRpaTask {
    const task = executionId ? this.tasksByExecutionId.get(executionId) : undefined;
    if (!task) throw new Error(`找不到模拟任务：${executionId ?? "undefined"}`);
    return task;
  }

  private requireConversationManager(platformId: PlatformId): ConversationManager {
    const manager = this.conversationManagers[platformId];
    if (!manager) throw new Error(`Mock Worker 缺少 ${platformId} ConversationManager。`);
    return manager;
  }
}

/** tenant + 业务类型 + 业务任务共同形成调度业务组，避免跨租户误合批。 */
export function createMockBusinessGroupId(task: Pick<
  MockRpaTask,
  "tenantKey" | "businessType" | "businessTaskId" | "projectId" | "monitorDate"
>): string {
  if (task.businessType === "ENTRY_MONITOR") {
    return JSON.stringify([
      task.tenantKey,
      task.businessType,
      task.projectId,
      task.monitorDate
    ]);
  }
  return JSON.stringify([task.tenantKey, task.businessType, task.businessTaskId]);
}

export function normalizeMockRpaTasks(input: unknown): MockRpaTask[] {
  const rawTasks = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.tasks)
      ? input.tasks
      : undefined;
  if (!rawTasks || rawTasks.length === 0) {
    throw new Error("Mock RPA 任务必须是非空数组，或包含非空 tasks 数组的对象。");
  }

  const executionIds = new Set<string>();
  return rawTasks.map((rawTask, index) => {
    if (!isRecord(rawTask)) throw new Error(`第 ${index + 1} 个 Mock 任务必须是对象。`);
    const executionId = requireString(rawTask.executionId, index, "executionId");
    if (executionIds.has(executionId)) {
      throw new Error(`Mock executionId 不能重复：${executionId}`);
    }
    executionIds.add(executionId);
    const businessType = rawTask.businessType;
    if (
      typeof businessType !== "string" ||
      !(MOCK_BUSINESS_TYPES as readonly string[]).includes(businessType)
    ) {
      throw new Error(
        `第 ${index + 1} 个 Mock 任务 businessType 只能是 DIAGNOSIS 或 ARTICLE_PROBE，或 ENTRY_MONITOR。`
      );
    }
    const aiModelId = requireString(rawTask.aiModelId, index, "aiModelId");
    if (typeof rawTask.deepThinking !== "boolean") {
      throw new Error(`第 ${index + 1} 个 Mock 任务 deepThinking 必须是 boolean。`);
    }
    const normalizedTask: MockRpaTask = {
      executionId,
      businessType: businessType as MockBusinessType,
      businessTaskId: requireString(rawTask.businessTaskId, index, "businessTaskId"),
      tenantKey: requireString(rawTask.tenantKey, index, "tenantKey"),
      brandId: requireString(rawTask.brandId, index, "brandId"),
      // 只 trim 校验，实际 business 提问保留 keyword 原字符串。
      keyword: requireString(rawTask.keyword, index, "keyword", false),
      aiModelId,
      aiModelName: requireString(rawTask.aiModelName, index, "aiModelName"),
      deepThinking: rawTask.deepThinking
    };
    if (businessType === "ENTRY_MONITOR") {
      const repetitionNo = Number(rawTask.repetitionNo);
      if (!Number.isSafeInteger(repetitionNo) || repetitionNo <= 0) {
        throw new Error(`第 ${index + 1} 个 Mock 任务 repetitionNo 必须是正整数。`);
      }
      const monitorDate = requireString(rawTask.monitorDate, index, "monitorDate");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(monitorDate)) {
        throw new Error(`第 ${index + 1} 个 Mock 任务 monitorDate 必须是 YYYY-MM-DD。`);
      }
      normalizedTask.projectId = requireString(rawTask.projectId, index, "projectId");
      normalizedTask.intentEntryId = requireString(
        rawTask.intentEntryId,
        index,
        "intentEntryId"
      );
      normalizedTask.monitorDate = monitorDate;
      normalizedTask.repetitionNo = repetitionNo;
    }
    resolveMockPlatformId(normalizedTask);
    return normalizedTask;
  });
}

/** aiModelId 可直接使用平台 ID，也可通过项目侧模型名称映射到四个平台。 */
export function resolveMockPlatformId(
  task: Pick<MockRpaTask, "aiModelId" | "aiModelName">
): PlatformId {
  const normalizedId = task.aiModelId.trim().toLowerCase();
  if ((PLATFORM_IDS as readonly string[]).includes(normalizedId)) {
    return normalizedId as PlatformId;
  }
  const normalizedName = task.aiModelName.replace(/\s+/g, "").toLowerCase();
  const aliases: Array<[RegExp, PlatformId]> = [
    [/豆包|doubao/, "doubao"],
    [/deepseek|深度求索/, "deepseek"],
    [/千问|通义千问|qianwen|qwen/, "qianwen"],
    [/元宝|腾讯元宝|yuanbao/, "yuanbao"]
  ];
  const matched = aliases.find(([pattern]) => pattern.test(normalizedName));
  if (matched) return matched[1];
  throw new Error(
    `无法把 aiModelId=${task.aiModelId}、aiModelName=${task.aiModelName} 映射到支持的平台。`
  );
}

interface FailedResultInput {
  task: MockRpaTask;
  platformId: PlatformId;
  conversationGroupId: string;
  questionIndex: number;
  startedAt: string;
  completedAtMs: number;
  durationMs: number;
  error: unknown;
}

function createFailedCollectionResult(input: FailedResultInput): CollectionResult {
  return {
    ...input.task,
    platform: input.platformId,
    conversationGroupId: input.conversationGroupId,
    questionIndex: input.questionIndex,
    submittedQuestion: input.task.keyword,
    requestedDeepThinking: input.task.deepThinking,
    actualDeepThinking: null,
    webSearchRequested: true,
    webSearchEnabled: false,
    webSearchVerified: false,
    status: "FAILED",
    answer: "",
    references: [],
    referenceCount: 0,
    retryCount: readRetryCount(input.error),
    startedAt: input.startedAt,
    completedAt: new Date(input.completedAtMs).toISOString(),
    durationMs: input.durationMs,
    errorCode: classifyTechnicalError(input.error),
    errorMessage: boundedError(input.error)
  };
}

function readRetryCount(error: unknown): number {
  if (!error || typeof error !== "object" || !("retryCount" in error)) return 0;
  const value = (error as { retryCount?: unknown }).retryCount;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function requireString(
  value: unknown,
  taskIndex: number,
  field: string,
  trim = true
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`第 ${taskIndex + 1} 个 Mock 任务缺少非空 ${field}。`);
  }
  return trim ? value.trim() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateJsonFileName(value: string, field: string): string {
  if (!/^[\w.-]+\.json$/i.test(value)) {
    throw new Error(`${field} 必须是安全的 .json 文件名。`);
  }
  return value;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}
