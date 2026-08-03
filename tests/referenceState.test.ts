import assert from "node:assert/strict";
import test from "node:test";
import { assertPersistableReferenceResult } from "../src/referenceState.js";
import type { ReferenceRecord } from "../src/types.js";

const reference: ReferenceRecord = {
  question: "问题",
  crawlPlatform: "豆包",
  rank: 1,
  articlePlatform: "站点",
  articleTime: "",
  title: "标题",
  summary: "",
  url: "https://example.com",
  extractedAt: "2026-08-03T00:00:00.000Z"
};

test("只有 EXTRACTED+非空或 CONFIRMED_EMPTY+空数组允许成功持久化", () => {
  assert.doesNotThrow(() => assertPersistableReferenceResult("EXTRACTED", [reference], "DIAGNOSIS"));
  assert.doesNotThrow(() => assertPersistableReferenceResult("CONFIRMED_EMPTY", [], "DIAGNOSIS"));
  assert.throws(() => assertPersistableReferenceResult("UNKNOWN", [], "DIAGNOSIS"), /不能持久化/);
  assert.throws(() => assertPersistableReferenceResult("EXTRACTED", [], "DIAGNOSIS"), /不能持久化/);
});

test("ARTICLE_PROBE 的 UNKNOWN 不能解释为未曝光或普通零引用", () => {
  assert.throws(
    () => assertPersistableReferenceResult("UNKNOWN", [], "ARTICLE_PROBE"),
    (error: unknown) =>
      (error as { errorCode?: string }).errorCode === "REFERENCE_UNKNOWN"
  );
});
