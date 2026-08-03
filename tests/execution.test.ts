import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubmittedQuestion,
  getCollectionModeDefaults,
  getNoReferencesStatus,
  normalizeBusinessBatches,
  planBatchQuestions
} from "../src/execution.js";

test("business 按租户、业务任务和品牌合并同一对话批次", () => {
  const batches = normalizeBusinessBatches([
    {
      tenantId: "tenant-a",
      businessTaskId: "task-1",
      brand: "品牌甲",
      questions: ["问题一"]
    },
    {
      tenantId: "tenant-a",
      businessTaskId: "task-1",
      brand: "品牌甲",
      questions: ["问题二"]
    }
  ]);

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].questions, ["问题一", "问题二"]);
});

test("相同品牌在不同任务或租户中保持独立批次", () => {
  const batches = normalizeBusinessBatches([
    {
      tenantId: "tenant-a",
      businessTaskId: "task-1",
      brand: "品牌甲",
      questions: ["问题一"]
    },
    {
      tenantId: "tenant-a",
      businessTaskId: "task-2",
      brand: "品牌甲",
      questions: ["问题二"]
    },
    {
      tenantId: "tenant-b",
      businessTaskId: "task-1",
      brand: "品牌甲",
      questions: ["问题三"]
    }
  ]);

  assert.equal(batches.length, 3);
  assert.equal(new Set(batches.map((batch) => batch.key)).size, 3);
});

test("每个品牌批次只在第一题前创建对话，批内问题连续执行", () => {
  const batches = normalizeBusinessBatches([
    {
      tenantId: "tenant-a",
      businessTaskId: "task-1",
      brand: "品牌甲",
      questions: ["问题一", "问题二"]
    },
    {
      tenantId: "tenant-a",
      businessTaskId: "task-2",
      brand: "品牌甲",
      questions: ["问题三"]
    }
  ]);
  const plan = planBatchQuestions(batches);

  assert.deepEqual(
    plan.map(({ question, startsNewConversation }) => ({
      question,
      startsNewConversation
    })),
    [
      { question: "问题一", startsNewConversation: true },
      { question: "问题二", startsNewConversation: false },
      { question: "问题三", startsNewConversation: true }
    ]
  );
});

test("research 与 business 使用明确且互斥的默认采集策略", () => {
  const originalQuestion = "  问题必须保留原有空格？  ";
  const research = getCollectionModeDefaults("research");
  const business = getCollectionModeDefaults("business");

  assert.equal(
    buildSubmittedQuestion("business", "这个前缀也不能发送：", originalQuestion),
    originalQuestion
  );
  assert.equal(business.promptPrefix, "");
  assert.equal(business.retryOnNoReferences, false);
  assert.equal(business.regenerateOnNoReferences, false);
  assert.equal(
    buildSubmittedQuestion("research", research.promptPrefix, "测试"),
    "请联网搜索后回答，并提供可点击的参考来源。问题：测试"
  );
  assert.equal(research.retryOnNoReferences, true);
  assert.equal(research.regenerateOnNoReferences, true);
  assert.equal(getNoReferencesStatus("business"), "success");
  assert.equal(getNoReferencesStatus("research"), "no_references");
});

test("business 拒绝缺少执行身份或空问题的批次", () => {
  assert.throws(
    () => normalizeBusinessBatches([{
      tenantId: "tenant-a",
      businessTaskId: "",
      brand: "品牌甲",
      questions: ["问题一"]
    }]),
    /businessTaskId/
  );
  assert.throws(() => normalizeBusinessBatches([]), /至少需要一个品牌批次/);
});
