import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationManager,
  conversationContextFromBrandBatch,
  createConversationGroupId,
  type ConversationBatchContext
} from "../src/conversationManager.js";
import { BrandBatchScheduler } from "../src/scheduler.js";

function context(
  batchId: string,
  brandId: string,
  businessTaskId: string,
  tenantId = "tenant-1"
): ConversationBatchContext {
  return {
    batchId,
    tenantId,
    brandId,
    businessTaskId,
    businessGroupId: businessTaskId,
    platformId: "doubao"
  };
}

function createManager(policy = {}) {
  const creations: string[] = [];
  let now = 1_000;
  const manager = new ConversationManager({
    policy,
    now: () => now,
    operations: {
      async createNewConversation(previousQuestion) {
        creations.push(previousQuestion);
        return true;
      }
    }
  });
  return { manager, creations, setNow: (value: number) => { now = value; } };
}

test("品牌 A、品牌 B、品牌 A 第二次任务各自创建且绝不复用会话", async () => {
  const { manager, creations } = createManager();
  const aFirst = context("batch-a-1", "A", "task-1");
  const b = context("batch-b-1", "B", "task-1");
  const aSecond = context("batch-a-2", "A", "task-2");

  const stateA1 = await manager.startBatch(aFirst);
  await manager.acquireForQuestion(aFirst);
  manager.recordQuestion("A1");
  await manager.acquireForQuestion(aFirst, "A1");
  manager.recordQuestion("A2");
  assert.equal(creations.length, 1, "同批次两题必须复用一次创建的会话");
  manager.finishBatch(aFirst.batchId);

  const stateB = await manager.startBatch(b, "A2");
  manager.recordQuestion("B1");
  manager.finishBatch(b.batchId);
  const stateA2 = await manager.startBatch(aSecond, "B1");

  assert.equal(creations.length, 3);
  assert.notEqual(stateA1.conversationGroupId, stateB.conversationGroupId);
  assert.notEqual(stateA1.conversationGroupId, stateA2.conversationGroupId);
  assert.equal(stateA1.endReason, "batch-completed");
});

test("品牌完成后立即准备空白对话，下一品牌直接认领且不会重复创建", async () => {
  const { manager, creations } = createManager();
  const brandA = context("batch-a", "A", "task-a");
  const brandB = context("batch-b", "B", "task-b");

  await manager.startBatch(brandA);
  manager.recordQuestion("A 最后一题");
  manager.finishBatch(brandA.batchId);
  assert.equal(await manager.resetToBlank("A 最后一题"), true);
  assert.equal(creations.length, 2, "品牌 A 完成后必须立即创建空白对话");

  const stateB = await manager.startBatch(brandB, "A 最后一题");
  assert.equal(creations.length, 2, "品牌 B 应认领已准备的空白对话，不能重复点击");
  assert.equal(stateB.brandId, "B");
});

test("已验证的同批次页面可在重启后接管且不会新建对话", async () => {
  const { manager, creations } = createManager();
  const interrupted = context("batch-a-retry", "A", "task-a");

  const resumed = manager.resumeVerifiedBatch(interrupted);
  assert.equal(creations.length, 0, "恢复已有回答时绝不能点击新建对话");
  assert.equal(resumed.brandId, "A");

  manager.recordQuestion("已恢复的第一题");
  const next = await manager.acquireForQuestion(interrupted, "已恢复的第一题");
  assert.equal(next.conversationGroupId, resumed.conversationGroupId);
  assert.equal(creations.length, 0, "同批次第二题必须继续复用已恢复页面");
});

test("品牌、业务任务或租户变化时 acquireForQuestion 强制轮换", async () => {
  const { manager, creations } = createManager();
  const a = context("batch-a", "A", "task-1", "tenant-1");
  await manager.startBatch(a);

  await manager.acquireForQuestion({ ...a, brandId: "B" });
  await manager.acquireForQuestion({ ...a, batchId: "batch-a-2", businessTaskId: "task-2" });
  await manager.acquireForQuestion({ ...a, batchId: "batch-a-3", tenantId: "tenant-2" });

  assert.equal(creations.length, 4);
  assert.ok(manager.history.slice(0, -1).every((state) => state.endReason === "identity-changed"));
});

test("损坏、最大问题数和最大时长会轮换，但不会配置为每题新建", async () => {
  const { manager, creations, setNow } = createManager({
    maxQuestions: 2,
    maxDurationMs: 100
  });
  const a = context("batch-a", "A", "task-1");
  await manager.startBatch(a);
  manager.recordQuestion("A1");
  await manager.acquireForQuestion(a, "A1");
  manager.recordQuestion("A2");
  await manager.acquireForQuestion(a, "A2");
  assert.equal(manager.history[0].endReason, "max-questions");

  manager.markDamaged(new Error("DOM 错位"));
  await manager.acquireForQuestion(a, "A2");
  assert.equal(manager.history[1].endReason, "damaged");

  setNow(1_200);
  await manager.acquireForQuestion(a, "A2");
  assert.equal(manager.history[2].endReason, "max-duration");
  assert.equal(creations.length, 4);

  assert.throws(
    () => createManager({ maxQuestions: 1 }),
    /禁止配置成每题新建对话/
  );
});

test("conversationGroupId 包含完整归属和轮换序号", () => {
  const a = context("batch-a", "A", "task-1");
  const first = createConversationGroupId(a, 1);
  const rotated = createConversationGroupId(a, 2);
  const otherTenant = createConversationGroupId({ ...a, tenantId: "tenant-2" }, 1);

  assert.notEqual(first, rotated);
  assert.notEqual(first, otherTenant);
  assert.deepEqual(JSON.parse(first), [
    "tenant-1", "task-1", "A", "task-1", "doubao", "batch-a", 1
  ]);
});

test("BrandBatchScheduler 批次可转换为 ConversationManager 上下文", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue({
    id: "A1",
    brandId: "A",
    businessGroupId: "group-1",
    platformId: "doubao",
    question: "问题一"
  });
  const batch = scheduler.getNextBatch("doubao");
  assert.ok(batch);

  assert.deepEqual(
    conversationContextFromBrandBatch(batch, { tenantId: "tenant-1" }),
    {
      batchId: batch.id,
      tenantId: "tenant-1",
      brandId: "A",
      businessTaskId: "group-1",
      businessGroupId: "group-1",
      platformId: "doubao"
    }
  );
});

test("CDP 重连只替换页面操作句柄，不改变当前批次对话归属", async () => {
  let originalCalls = 0;
  let reboundCalls = 0;
  const manager = new ConversationManager({
    operations: {
      async createNewConversation() {
        originalCalls += 1;
        return true;
      }
    }
  });
  const context = {
    batchId: "batch-a",
    tenantId: "tenant-a",
    brandId: "brand-a",
    businessTaskId: "task-a",
    businessGroupId: "group-a",
    platformId: "doubao" as const
  };
  const before = await manager.startBatch(context);
  manager.rebindOperations({
    async createNewConversation() {
      reboundCalls += 1;
      return true;
    }
  });
  const after = await manager.acquireForQuestion(context);

  assert.equal(after.conversationGroupId, before.conversationGroupId);
  assert.equal(originalCalls, 1);
  assert.equal(reboundCalls, 0);
});
