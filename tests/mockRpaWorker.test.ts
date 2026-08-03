import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationManager } from "../src/conversationManager.js";
import { parseMockRpaCli } from "../src/mockRpaCli.js";
import {
  InMemoryMockTaskSource,
  JsonMockTaskSource,
  MockExecutionStateStore,
  MockRpaWorker,
  createMockBusinessGroupId,
  normalizeMockRpaTasks,
  resolveMockPlatformId,
  type MockRpaTask
} from "../src/mockRpaWorker.js";
import type { PlatformId } from "../src/types.js";

function mockTask(
  executionId: string,
  brandId: string,
  businessTaskId: string,
  keyword: string,
  platformId: PlatformId = "doubao"
): MockRpaTask {
  return {
    executionId,
    businessType: "DIAGNOSIS",
    businessTaskId,
    tenantKey: "tenant-1",
    brandId,
    keyword,
    aiModelId: platformId,
    aiModelName: platformId,
    deepThinking: false
  };
}

function conversationManager(onCreate?: () => void): ConversationManager {
  return new ConversationManager({
    operations: {
      async createNewConversation() {
        onCreate?.();
        return true;
      }
    }
  });
}

test("同平台按 A 第一批、B、A 第二次业务任务顺序执行并每批只开一次对话", async () => {
  const tasks = [
    mockTask("A1", "A", "task-A-1", "A 第一题"),
    mockTask("A2", "A", "task-A-1", "A 第二题"),
    mockTask("B1", "B", "task-B-1", "B 第一题"),
    mockTask("A3", "A", "task-A-2", "A 第二次任务第一题"),
    mockTask("A4", "A", "task-A-2", "A 第二次任务第二题")
  ];
  const executionOrder: string[] = [];
  const conversationIds: string[] = [];
  let conversationCreateCount = 0;
  const manager = conversationManager(() => conversationCreateCount++);
  const worker = new MockRpaWorker({
    taskSource: new InMemoryMockTaskSource(tasks),
    platforms: ["doubao"],
    conversationManagers: { doubao: manager },
    async executeQuestion(context) {
      executionOrder.push(context.task.executionId);
      conversationIds.push(context.conversationGroupId);
      return {
        submittedQuestion: context.task.keyword,
        answer: `回答：${context.task.keyword}`,
        references: [],
        referenceCount: 0,
        retryCount: 0,
        webSearchRequested: true,
        webSearchEnabled: true,
        webSearchVerified: true
      };
    }
  });

  const result = await worker.run();

  assert.deepEqual(executionOrder, ["A1", "A2", "B1", "A3", "A4"]);
  assert.equal(conversationCreateCount, 3);
  assert.equal(conversationIds[0], conversationIds[1]);
  assert.notEqual(conversationIds[1], conversationIds[2]);
  assert.notEqual(conversationIds[2], conversationIds[3]);
  assert.equal(conversationIds[3], conversationIds[4]);
  assert.ok(result.executionStates.every(({ status }) => status === "SUCCESS"));
  assert.ok(result.collectionResults.every(({ referenceCount }) => referenceCount === 0));
  assert.ok(result.collectionResults.every(({ status }) => status === "SUCCESS"));
  assert.deepEqual(
    result.collectionResults.map(({ submittedQuestion }) => submittedQuestion),
    tasks.map(({ keyword }) => keyword)
  );
  assert.equal(manager.history.length, 3);
});

test("四个平台使用独立队列和独立 ConversationManager", async () => {
  const platformIds: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];
  const createCounts = new Map<PlatformId, number>();
  const managers = Object.fromEntries(platformIds.map((platformId) => [
    platformId,
    conversationManager(() => {
      createCounts.set(platformId, (createCounts.get(platformId) ?? 0) + 1);
    })
  ]));
  const worker = new MockRpaWorker({
    taskSource: new InMemoryMockTaskSource(
      platformIds.map((platformId) =>
        mockTask(`${platformId}-1`, platformId, `task-${platformId}`, `${platformId} 问题`, platformId)
      )
    ),
    conversationManagers: managers,
    executeQuestion: async (context) => ({
      submittedQuestion: context.task.keyword,
      answer: "有回答但没有引用",
      references: [],
      referenceCount: 0,
      retryCount: 0,
      actualDeepThinking: context.task.deepThinking,
      webSearchRequested: true,
      webSearchEnabled: true,
      webSearchVerified: true
    })
  });

  const result = await worker.run();
  assert.equal(result.collectionResults.length, 4);
  for (const platformId of platformIds) assert.equal(createCounts.get(platformId), 1);
});

test("只接受 DIAGNOSIS 和 ARTICLE_PROBE，并保留 keyword 原文", () => {
  assert.throws(
    () => normalizeMockRpaTasks([{
      ...mockTask("invalid", "A", "task-A", "问题"),
      businessType: "OTHER"
    }]),
    /只能是 DIAGNOSIS 或 ARTICLE_PROBE/
  );
  const keyword = "  原样发送，保留两侧空格  ";
  const [task] = normalizeMockRpaTasks([{
    ...mockTask("valid", "A", "task-A", keyword),
    businessType: "ARTICLE_PROBE",
    deepThinking: true
  }]);
  assert.equal(task?.keyword, keyword);
  assert.equal(task?.deepThinking, true);
  assert.equal(
    resolveMockPlatformId({ aiModelId: "model-1003", aiModelName: "通义千问" }),
    "qianwen"
  );
  assert.equal(
    createMockBusinessGroupId(task!),
    JSON.stringify(["tenant-1", "ARTICLE_PROBE", "task-A"])
  );
});

test("本地 JSON 任务源和状态存储写出统一 CollectionResult", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mock-rpa-worker-"));
  try {
    const taskFile = path.join(root, "tasks.json");
    const outputDirectory = path.join(root, "output");
    await fs.writeFile(
      taskFile,
      JSON.stringify({ tasks: [mockTask("A1", "A", "task-A", "原始 keyword")] }),
      "utf8"
    );
    const worker = new MockRpaWorker({
      taskSource: new JsonMockTaskSource(taskFile),
      platforms: ["doubao"],
      conversationManagers: { doubao: conversationManager() },
      stateStore: new MockExecutionStateStore({ outputDirectory }),
      executeQuestion: async (context) => ({
        submittedQuestion: context.task.keyword,
        answer: "模拟回答",
        references: [],
        referenceCount: 0,
        retryCount: 1,
        actualDeepThinking: context.task.deepThinking,
        webSearchRequested: true,
        webSearchEnabled: true,
        webSearchVerified: true
      })
    });
    await worker.run();

    const results = JSON.parse(
      await fs.readFile(path.join(outputDirectory, "collection-results.json"), "utf8")
    ) as Array<Record<string, unknown>>;
    const state = JSON.parse(
      await fs.readFile(path.join(outputDirectory, "execution-state.json"), "utf8")
    ) as { executions: Array<Record<string, unknown>> };
    assert.equal(results[0]?.executionId, "A1");
    assert.equal(results[0]?.businessType, "DIAGNOSIS");
    assert.equal(results[0]?.submittedQuestion, "原始 keyword");
    assert.equal(results[0]?.status, "SUCCESS");
    assert.equal(results[0]?.referenceCount, 0);
    assert.equal(results[0]?.retryCount, 1);
    assert.equal(results[0]?.requestedDeepThinking, false);
    assert.equal(results[0]?.actualDeepThinking, false);
    assert.equal(results[0]?.webSearchRequested, true);
    assert.equal(results[0]?.webSearchEnabled, true);
    assert.equal(results[0]?.webSearchVerified, true);
    assert.equal(state.executions[0]?.status, "SUCCESS");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Mock RPA CLI 支持配置任务、输出和等待间隔", () => {
  const options = parseMockRpaCli([
    "--tasks=custom-tasks.json",
    "--out=custom-output",
    "--cdp=http://127.0.0.1:9333",
    "--timeout-ms=10000",
    "--task-interval-ms=25",
    "--batch-interval-ms=50"
  ]);
  assert.deepEqual(options, {
    taskFile: "custom-tasks.json",
    outputDirectory: "custom-output",
    cdpEndpoint: "http://127.0.0.1:9333",
    timeoutMs: 10_000,
    taskIntervalMs: 25,
    batchIntervalMs: 50,
    deepThinkingUnsupportedPolicy: "fail",
    diagnosisWebSearchPolicy: "PREFERRED"
  });
});
