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

test("数据库入库默认开启，也可以为纯文件调试显式关闭", async () => {
  const defaultOptions = await parseCli([]);
  const fileOnlyOptions = await parseCli([
    "--database=false",
    "--batch-name=  调试批次  "
  ]);

  assert.equal(defaultOptions.databaseEnabled, true);
  assert.equal(fileOnlyOptions.databaseEnabled, false);
  assert.equal(fileOnlyOptions.batchName, "调试批次");
});

test("执行模式默认保持 research，并支持显式 business", async () => {
  const research = await parseCli([]);
  const business = await parseCli(["--mode=business"]);

  assert.equal(research.mode, "research");
  assert.equal(research.retryOnNoReferences, true);
  assert.equal(research.regenerateOnNoReferences, true);
  assert.equal(research.deepThinking, undefined);
  assert.equal(business.mode, "business");
  assert.equal(business.promptPrefix, "");
  assert.equal(business.retryOnNoReferences, false);
  assert.equal(business.regenerateOnNoReferences, false);
  await assert.rejects(() => parseCli(["--mode=unknown"]), /未知执行模式/);
});

test("research 默认保留详细日志且可显式关闭，business 始终关闭详细日志", async () => {
  const research = await parseCli([]);
  const quietResearch = await parseCli(["--verbose=false"]);
  const business = await parseCli(["--mode=business", "--verbose=true"]);

  assert.equal(research.verbose, true);
  assert.equal(quietResearch.verbose, false);
  assert.equal(business.verbose, false);
});

test("research 只有显式配置时才设置深度思考，并校验不支持策略", async () => {
  const defaults = await parseCli([]);
  const configured = await parseCli([
    "--deep-thinking=false",
    "--deep-thinking-unsupported-policy=allow_degrade"
  ]);

  assert.equal(defaults.deepThinking, undefined);
  assert.equal(defaults.deepThinkingUnsupportedPolicy, "fail");
  assert.equal(configured.deepThinking, false);
  assert.equal(configured.deepThinkingUnsupportedPolicy, "allow_degrade");
  await assert.rejects(
    () => parseCli(["--deep-thinking=maybe"]),
    /只能是 true 或 false/
  );
});

test("联网策略仅在显式配置时覆盖 research 宽松历史行为", async () => {
  const defaults = await parseCli([]);
  const required = await parseCli(["--web-search-policy=required"]);
  const disabled = await parseCli(["--web-search-policy=DISABLED"]);

  assert.equal(defaults.webSearchPolicy, undefined);
  assert.equal(required.webSearchPolicy, "REQUIRED");
  assert.equal(disabled.webSearchPolicy, "DISABLED");
  await assert.rejects(
    () => parseCli(["--web-search-policy=unknown"]),
    /REQUIRED、PREFERRED 或 DISABLED/
  );
});
