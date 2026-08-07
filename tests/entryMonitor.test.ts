import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEntryMonitorCollectionContext,
  createEntryMonitorPageOwner,
  entryMonitorConversationKeyFor,
  entryMonitorOwnerMatchesExecution,
  getShanghaiDate,
  isEntryMonitorTaskEligibleToday,
  serializeEntryMonitorConversationKey,
  transitionEntryMonitorPageOwner
} from "../src/entryMonitor.js";
import { JsonEntryMonitorConversationRepository } from
  "../src/entryMonitorConversationRepository.js";
import {
  businessTypesForWorker,
  isBusinessTypeAllowedForWorker,
  toCollectionTask,
  type CollectionTask,
  type EntryMonitorRpaTask
} from "../src/rpaTask.js";

function entryTask(overrides: Partial<EntryMonitorRpaTask> = {}): EntryMonitorRpaTask {
  return {
    executionId: "90071992547409931",
    dispatchTaskId: "2080238709516197889",
    businessType: "ENTRY_MONITOR",
    businessTaskId: "3001",
    tenantKey: "tenant-a",
    tenantId: "tenant-a",
    projectId: "7001",
    intentEntryId: "8001",
    monitorDate: "2026-08-06",
    repetitionNo: 1,
    keyword: "相同词条",
    aiModelId: "1",
    aiModelName: "豆包",
    deepThinking: false,
    failCount: 0,
    priority: 0,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

test("上海自然日不受 UTC 日期边界影响，且只允许当日 ENTRY_MONITOR", () => {
  const beforeShanghaiMidnight = new Date("2026-08-05T15:59:59.999Z");
  const afterShanghaiMidnight = new Date("2026-08-05T16:00:00.000Z");
  assert.equal(getShanghaiDate(beforeShanghaiMidnight), "2026-08-05");
  assert.equal(getShanghaiDate(afterShanghaiMidnight), "2026-08-06");
  assert.equal(isEntryMonitorTaskEligibleToday(entryTask(), afterShanghaiMidnight), true);
  assert.equal(isEntryMonitorTaskEligibleToday(entryTask(), beforeShanghaiMidnight), false);
});

test("Worker 到业务类型保持 diagnosis 单类型、monitor 兼容新旧两类型", () => {
  assert.deepEqual(businessTypesForWorker("diagnosis"), ["DIAGNOSIS"]);
  assert.deepEqual(businessTypesForWorker("monitor"), ["ARTICLE_PROBE", "ENTRY_MONITOR"]);
  assert.equal(isBusinessTypeAllowedForWorker("diagnosis", "ENTRY_MONITOR"), false);
  assert.equal(isBusinessTypeAllowedForWorker("monitor", "DIAGNOSIS"), false);
  const collection = toCollectionTask(entryTask());
  assert.equal(collection.brandId, "7001");
  assert.equal(collection.businessGroupId, JSON.stringify([
    "tenant-a", "ENTRY_MONITOR", "7001", "doubao", "2026-08-06"
  ]));
});

test("项目、平台、自然日决定对话键，同项目多个词条复用且跨日隔离", () => {
  const first = entryMonitorConversationKeyFor({
    ...entryTask({ intentEntryId: "8001" }),
    platformId: "doubao"
  });
  const second = entryMonitorConversationKeyFor({
    ...entryTask({ intentEntryId: "8002", repetitionNo: 30 }),
    platformId: "doubao"
  });
  const nextDay = entryMonitorConversationKeyFor({
    ...entryTask({ monitorDate: "2026-08-07" }),
    platformId: "doubao"
  });
  assert.equal(
    serializeEntryMonitorConversationKey(first),
    serializeEntryMonitorConversationKey(second)
  );
  assert.notEqual(
    serializeEntryMonitorConversationKey(first),
    serializeEntryMonitorConversationKey(nextDay)
  );
});

test("相同 keyword 的恢复身份使用 executionId、词条 ID、次数和顺序状态机", () => {
  const key = serializeEntryMonitorConversationKey(entryMonitorConversationKeyFor({
    ...entryTask(),
    platformId: "doubao"
  }));
  const first = entryTask({ executionId: "101", repetitionNo: 1 });
  const second = entryTask({ executionId: "102", repetitionNo: 2 });
  const prepared = createEntryMonitorPageOwner(first, key, {
    userMessageCount: 4,
    assistantMessageCount: 4
  }, new Date("2026-08-06T01:00:00.000Z"));
  assert.equal(entryMonitorOwnerMatchesExecution(prepared, first, key), true);
  assert.equal(entryMonitorOwnerMatchesExecution(prepared, second, key), false);
  const submitting = transitionEntryMonitorPageOwner(prepared, "SUBMITTING");
  const submitted = transitionEntryMonitorPageOwner(submitting, "SUBMITTED");
  const ready = transitionEntryMonitorPageOwner(submitted, "ANSWER_READY");
  assert.equal(transitionEntryMonitorPageOwner(ready, "PERSISTED").submissionState, "PERSISTED");
  assert.throws(
    () => transitionEntryMonitorPageOwner(prepared, "ANSWER_READY"),
    /非法 ENTRY_MONITOR 提交状态迁移/
  );
});

test("ENTRY_MONITOR CollectionTask 上下文缺字段时严格拒绝", () => {
  const collection = {
    ...entryTask(),
    id: "90071992547409931",
    brandId: "7001",
    platformId: "doubao",
    businessGroupId: "group",
    question: "相同词条",
    mode: "business"
  } satisfies CollectionTask;
  assert.doesNotThrow(() => assertEntryMonitorCollectionContext(collection));
  assert.throws(
    () => assertEntryMonitorCollectionContext({ ...collection, projectId: undefined }),
    (error: unknown) => (error as { errorCode?: string }).errorCode ===
      "INVALID_EXECUTION_CONTEXT"
  );
});

test("单机灰度会话仓储支持 A→B→A 恢复、更新 URL 与跨日关闭", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entry-monitor-conversations-"));
  try {
    const repository = new JsonEntryMonitorConversationRepository(
      path.join(root, "conversations.json")
    );
    const keyA = entryMonitorConversationKeyFor({ ...entryTask(), platformId: "doubao" });
    const keyB = entryMonitorConversationKeyFor({
      ...entryTask({ projectId: "7002" }),
      platformId: "doubao"
    });
    const now = "2026-08-06T01:00:00.000Z";
    for (const [key, url] of [
      [keyA, "https://www.doubao.com/chat/a"],
      [keyB, "https://www.doubao.com/chat/b"]
    ] as const) {
      await repository.upsertActive({
        ...key,
        conversationKey: serializeEntryMonitorConversationKey(key),
        conversationUrl: url,
        status: "ACTIVE",
        createdAt: now,
        lastUsedAt: now
      });
    }
    assert.equal((await repository.find(keyA))?.conversationUrl, "https://www.doubao.com/chat/a");
    assert.equal((await repository.find(keyB))?.conversationUrl, "https://www.doubao.com/chat/b");
    await repository.updateUrl(keyA, "https://www.doubao.com/chat/a-restored");
    await repository.touch(keyA, new Date("2026-08-06T02:00:00.000Z"));
    assert.equal(
      (await repository.find(keyA))?.conversationUrl,
      "https://www.doubao.com/chat/a-restored"
    );
    assert.equal(await repository.closeExpired("2026-08-07"), 2);
    assert.equal((await repository.find(keyA))?.status, "EXPIRED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
