/**
 * 数据库入库回归测试。使用内存中的 mysql2 连接替身，只校验事务和参数化 SQL，
 * 不连接或修改真实数据库。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { createDatabaseRunCoordinator } from "../src/databasePersistence.js";
import type { PlatformConfig } from "../src/types.js";

interface ExecutedStatement {
  sql: string;
  parameters: unknown[];
}

class FakeConnection {
  readonly statements: ExecutedStatement[] = [];
  private insertId = 100;

  async beginTransaction(): Promise<void> {
    this.statements.push({ sql: "BEGIN", parameters: [] });
  }

  async commit(): Promise<void> {
    this.statements.push({ sql: "COMMIT", parameters: [] });
  }

  async rollback(): Promise<void> {
    this.statements.push({ sql: "ROLLBACK", parameters: [] });
  }

  release(): void {
    this.statements.push({ sql: "RELEASE", parameters: [] });
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<unknown> {
    this.statements.push({ sql, parameters });
    if (sql.includes("SELECT id FROM platforms")) {
      return [[{ id: "9" }], []];
    }
    if (/^\s*INSERT INTO/.test(sql)) {
      this.insertId += 1;
      return [{ insertId: this.insertId, affectedRows: 1 }, []];
    }
    return [{ affectedRows: 1 }, []];
  }
}

function createFakePool(connection: FakeConnection): Pool {
  return {
    getConnection: async () => connection,
    execute: (sql: string, parameters?: unknown[]) =>
      connection.execute(sql, parameters)
  } as unknown as Pool;
}

const doubao: PlatformConfig = {
  id: "doubao",
  name: "豆包",
  url: "https://www.doubao.com/chat/",
  inputSelectors: [],
  sendButtonSelectors: [],
  newConversationButtonSelectors: [],
  webSearchButtonSelectors: [],
  webSearchSupported: false,
  deepThinkingControl: { supported: false, selectors: [] },
  referenceRevealSelectors: []
};

test("每题最终答案和引用在同一事务内写入，并以 task_id 覆盖旧答案", async () => {
  const connection = new FakeConnection();
  const coordinator = await createDatabaseRunCoordinator(
    {
      questions: ["问题一"],
      platforms: [doubao],
      batchName: "单元测试批次"
    },
    createFakePool(connection)
  );

  await coordinator.startQuestion("doubao", 0);
  await coordinator.saveQuestion("doubao", {
    questionIndex: 0,
    question: "问题一",
    status: "completed",
    referenceStatus: "EXTRACTED",
    attemptCount: 3,
    answer: {
      question: "问题一",
      crawlPlatform: "豆包",
      answer: "最终第三版回答",
      generationNumber: 3,
      referenceCount: 1,
      extractedAt: "2026-07-31T08:00:00.000Z"
    },
    references: [{
      question: "问题一",
      crawlPlatform: "豆包",
      rank: 1,
      articlePlatform: "示例来源",
      articleTime: "2026-07-31",
      title: "示例标题",
      summary: "示例摘要",
      url: "https://example.com/article",
      extractedAt: "2026-07-31T08:00:01.000Z"
    }]
  });
  await coordinator.completePlatform("doubao");
  await coordinator.finalize([]);

  const answerStatement = connection.statements.find(
    ({ sql }) => sql.includes("INSERT INTO answers")
  );
  assert.ok(answerStatement);
  assert.equal(answerStatement.parameters[1], "最终第三版回答");
  assert.equal(answerStatement.parameters[2], 3);
  assert.ok(answerStatement.sql.includes("ON DUPLICATE KEY UPDATE"));

  const deleteReferences = connection.statements.find(
    ({ sql }) => sql.includes("DELETE FROM `references`")
  );
  const insertReferences = connection.statements.find(
    ({ sql }) => sql.includes("INSERT INTO `references`")
  );
  assert.ok(deleteReferences);
  assert.ok(insertReferences);
  assert.ok(insertReferences.sql.includes("`rank`"));
  assert.ok(
    connection.statements.some(
      ({ sql, parameters }) =>
        sql.includes("UPDATE crawl_runs") && parameters[0] === "completed"
    )
  );
});

test("相同问题文本按序号创建独立任务，避免问题内容重复时串数据", async () => {
  const connection = new FakeConnection();
  const coordinator = await createDatabaseRunCoordinator(
    {
      questions: ["重复问题", "重复问题"],
      platforms: [doubao]
    },
    createFakePool(connection)
  );

  await coordinator.startQuestion("doubao", 0);
  await coordinator.startQuestion("doubao", 1);

  const taskInserts = connection.statements.filter(
    ({ sql }) => sql.includes("INSERT INTO question_platform_tasks")
  );
  const runningUpdates = connection.statements.filter(
    ({ sql }) =>
      sql.includes("UPDATE question_platform_tasks") &&
      sql.includes("status = 'running'")
  );
  assert.equal(taskInserts.length, 2);
  assert.equal(runningUpdates.length, 2);
  assert.notEqual(
    runningUpdates[0].parameters.at(-1),
    runningUpdates[1].parameters.at(-1)
  );
});
