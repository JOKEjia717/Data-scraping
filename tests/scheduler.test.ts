import assert from "node:assert/strict";
import test from "node:test";
import {
  BrandBatchScheduler,
  type EnqueueBrandTaskInput
} from "../src/scheduler.js";

function task(
  id: string,
  brandId: string,
  overrides: Partial<EnqueueBrandTaskInput> = {}
): EnqueueBrandTaskInput {
  return {
    id,
    brandId,
    businessGroupId: "group-1",
    platformId: "doubao",
    question: `${id} 的问题`,
    priority: 0,
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides
  };
}

test("A1/A2/A3、B1/B2、A4/A5 到达后先完整执行 A1-A5 再执行 B", () => {
  const scheduler = new BrandBatchScheduler();

  for (const id of ["A1", "A2", "A3"]) scheduler.enqueue(task(id, "A"));
  for (const id of ["B1", "B2"]) scheduler.enqueue(task(id, "B"));
  for (const id of ["A4", "A5"]) scheduler.enqueue(task(id, "A"));

  const batchA = scheduler.getNextBatch("doubao");
  assert.ok(batchA);
  assert.equal(batchA.brandId, "A");
  assert.deepEqual(batchA.tasks.map(({ id }) => id), ["A1", "A2", "A3", "A4", "A5"]);
  assert.equal(scheduler.getNextBatch("doubao"), undefined, "A 未完成时不能切换到 B");

  scheduler.completeBatch(batchA.id);
  const batchB = scheduler.getNextBatch("doubao");
  assert.ok(batchB);
  assert.equal(batchB.brandId, "B");
  assert.deepEqual(batchB.tasks.map(({ id }) => id), ["B1", "B2"]);
});

test("运行中到达的同组任务继续追加到当前 BrandBatch", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("A1", "A"));
  const running = scheduler.getNextBatch("doubao");
  assert.ok(running);

  scheduler.enqueue(task("B1", "B"));
  scheduler.enqueue(task("A2", "A"));

  assert.deepEqual(running.tasks.map(({ id }) => id), ["A1", "A2"]);
  assert.equal(scheduler.getNextBatch("doubao"), undefined);
  scheduler.completeBatch(running.id);
  assert.equal(scheduler.getNextBatch("doubao")?.brandId, "B");
});

test("同品牌不同 businessGroupId 或 platformId 会形成独立批次", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("A-g1", "A"));
  scheduler.enqueue(task("A-g2", "A", { businessGroupId: "group-2" }));
  scheduler.enqueue(task("A-qianwen", "A", { platformId: "qianwen" }));

  const doubaoFirst = scheduler.getNextBatch("doubao");
  const qianwen = scheduler.getNextBatch("qianwen");
  assert.ok(doubaoFirst);
  assert.ok(qianwen);
  assert.equal(qianwen.tasks[0].id, "A-qianwen");

  scheduler.completeBatch(doubaoFirst.id);
  const doubaoSecond = scheduler.getNextBatch("doubao");
  assert.ok(doubaoSecond);
  assert.notEqual(doubaoFirst.businessGroupId, doubaoSecond.businessGroupId);
});

test("基础策略按高优先级、早创建时间、早入队选择批次", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("low", "low", { priority: 1, createdAt: 100 }));
  scheduler.enqueue(task("high-late", "high-late", { priority: 5, createdAt: 300 }));
  scheduler.enqueue(task("high-early", "high-early", { priority: 5, createdAt: 200 }));

  const first = scheduler.getNextBatch("doubao");
  assert.equal(first?.brandId, "high-early");
  scheduler.completeBatch(first!.id);
  assert.equal(scheduler.getNextBatch("doubao")?.brandId, "high-late");
});

test("优先级和创建时间相同时保持首次入队顺序", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("first", "first", { priority: 3, createdAt: 100 }));
  scheduler.enqueue(task("second", "second", { priority: 3, createdAt: 100 }));

  assert.equal(scheduler.getNextBatch("doubao")?.brandId, "first");
});

test("失败批次释放平台锁，不同平台可以同时各取一个批次", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("D1", "D"));
  scheduler.enqueue(task("Q1", "Q", { platformId: "qianwen" }));

  const doubao = scheduler.getNextBatch("doubao");
  const qianwen = scheduler.getNextBatch("qianwen");
  assert.ok(doubao);
  assert.ok(qianwen);

  const failed = scheduler.failBatch(doubao.id, new Error("页面断开"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorMessage, "页面断开");
  scheduler.enqueue(task("D2", "D2"));
  assert.equal(scheduler.getNextBatch("doubao")?.tasks[0].id, "D2");
  assert.equal(scheduler.getNextBatch("qianwen"), undefined);
});

test("重复任务 ID 会被拒绝，批次状态转换会严格要求运行态", () => {
  const scheduler = new BrandBatchScheduler();
  scheduler.enqueue(task("dup", "same"));
  assert.throws(() => scheduler.enqueue(task("dup", "same")), /不能重复添加/);
  const batch = scheduler.getNextBatch("doubao");
  assert.ok(batch);
  assert.throws(() => scheduler.completeBatch("missing"), /品牌批次不存在/);
  scheduler.completeBatch(batch.id);
  assert.throws(() => scheduler.completeBatch(batch.id), /不能标记为 completed/);
});
