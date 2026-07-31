/**
 * 汇总清洗回归测试：分别验证平台分桶、平台内问题分组和跨平台同题合并。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  answersToCsv,
  groupPlatformRecordsByQuestion,
  groupRecordsByPlatform,
  groupRecordsByQuestion,
  writePlatformOutputs
} from "../src/output.js";
import type { AnswerRecord, ReferenceRecord } from "../src/types.js";

test("汇总记录按问题和平台分组，并移除平台记录中重复的问题字段", () => {
  const questions = ["问题一", "问题二"];
  const records: ReferenceRecord[] = [
    {
      question: "问题一",
      crawlPlatform: "豆包",
      rank: 1,
      articlePlatform: "示例来源",
      articleTime: "2026-07-17",
      title: "示例标题",
      summary: "示例摘要",
      url: "https://example.com/article",
      extractedAt: "2026-07-17T00:00:00.000Z"
    },
    {
      question: "问题一",
      crawlPlatform: "DeepSeek",
      rank: 1,
      articlePlatform: "另一来源",
      articleTime: "",
      title: "另一标题",
      summary: "",
      url: "https://example.org/article",
      extractedAt: "2026-07-17T00:00:01.000Z"
    }
  ];

  const recordsByPlatform = groupRecordsByPlatform(records);
  assert.deepEqual(recordsByPlatform.豆包, [records[0]]);
  assert.deepEqual(recordsByPlatform.DeepSeek, [records[1]]);
  assert.deepEqual(recordsByPlatform.千问, []);
  assert.deepEqual(recordsByPlatform.元宝, []);

  const questionsByPlatform = groupPlatformRecordsByQuestion(recordsByPlatform);
  assert.equal(questionsByPlatform.豆包.get("问题一")?.length, 1);
  assert.equal(questionsByPlatform.DeepSeek.get("问题一")?.length, 1);
  assert.equal("question" in questionsByPlatform.豆包.get("问题一")![0], false);

  const grouped = groupRecordsByQuestion(records, questions);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].question, "问题一");
  assert.equal(grouped[0].platforms.豆包.length, 1);
  assert.equal(grouped[0].platforms.DeepSeek.length, 1);
  assert.deepEqual(grouped[0].platforms.千问, []);
  assert.deepEqual(grouped[0].platforms.元宝, []);
  assert.equal("question" in grouped[0].platforms.豆包[0], false);
  assert.equal(grouped[0].platforms.豆包[0].crawlPlatform, "豆包");
  assert.deepEqual(grouped[1], {
    question: "问题二",
    platforms: {
      豆包: [],
      DeepSeek: [],
      千问: [],
      元宝: []
    }
  });
});

test("最终回答 CSV 保留固定字段并正确转义多行正文", () => {
  const answers: AnswerRecord[] = [{
    question: "问题一",
    crawlPlatform: "豆包",
    answer: "第一段，包含逗号\n第二段包含\"引号\"",
    generationNumber: 3,
    referenceCount: 15,
    extractedAt: "2026-07-30T10:00:00.000Z"
  }];

  const csv = answersToCsv(answers);
  assert.equal(
    csv.split("\n")[0],
    "question,crawlPlatform,answer,generationNumber,referenceCount,extractedAt"
  );
  assert.ok(csv.includes('"第一段，包含逗号\n第二段包含""引号"""'));
  assert.ok(csv.includes(",3,15,2026-07-30T10:00:00.000Z"));
});

test("非豆包平台也会写出独立的最终回答 JSON 和 CSV", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-output-"));
  const answers: AnswerRecord[] = [{
    question: "问题一",
    crawlPlatform: "DeepSeek",
    answer: "DeepSeek 最终回答",
    generationNumber: 1,
    referenceCount: 2,
    extractedAt: "2026-07-31T00:00:00.000Z"
  }];

  try {
    await writePlatformOutputs(outDir, "deepseek", [], answers);
    const json = JSON.parse(
      await fs.readFile(path.join(outDir, "deepseek", "answers.json"), "utf8")
    ) as AnswerRecord[];
    const csv = await fs.readFile(
      path.join(outDir, "deepseek", "answers.csv"),
      "utf8"
    );

    assert.deepEqual(json, answers);
    assert.ok(csv.includes("DeepSeek 最终回答"));
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
