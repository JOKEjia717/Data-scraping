/**
 * CLI 默认配置回归测试，避免全局联网提示词在后续合并中被意外清空。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCli } from "../src/cli.js";

test("默认给所有平台的问题添加联网搜索和可点击参考来源提示词", async () => {
  const options = await parseCli([]);

  assert.equal(
    options.promptPrefix,
    "请联网搜索后回答，并提供可点击的参考来源。问题："
  );
});

test("命令行可以覆盖默认提问前缀", async () => {
  const options = await parseCli(["--prompt-prefix=自定义提示："]);

  assert.equal(options.promptPrefix, "自定义提示：");
});

test("并发运行时会去除重复平台，避免两个任务操作同一标签页", async () => {
  const options = await parseCli([
    "--platforms=doubao,deepseek,doubao,qianwen,deepseek"
  ]);

  assert.deepEqual(options.platforms, ["doubao", "deepseek", "qianwen"]);
});
