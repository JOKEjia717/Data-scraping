import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseRpaWorkerConfig } from "../src/rpaWorkerConfig.js";

test("重试调度 migration 向后兼容且提供完整回滚", async () => {
  const up = await readFile(
    path.resolve("migrations/20260803_rpa_retry_schedule.up.sql"),
    "utf8"
  );
  const down = await readFile(
    path.resolve("migrations/20260803_rpa_retry_schedule.down.sql"),
    "utf8"
  );
  assert.match(up, /next_retry_at datetime NULL/);
  assert.match(up, /last_error_code varchar\(64\) NULL/);
  assert.match(up, /idx_rpa_execution_retry_schedule/);
  assert.match(down, /DROP INDEX idx_rpa_execution_retry_schedule/);
  assert.match(down, /DROP COLUMN next_retry_at/);
  // 未执行 migration 时安全默认关闭，不会查询不存在的列。
  assert.equal(
    parseRpaWorkerConfig("diagnosis", [], {}, "/workspace").databaseRetryScheduleEnabled,
    false
  );
});

test("provider migration 默认 LEGACY，切换脚本显式迁移待处理任务并支持回退", async () => {
  const up = await readFile(
    path.resolve("migrations/20260803_rpa_worker_provider.up.sql"),
    "utf8"
  );
  const down = await readFile(
    path.resolve("migrations/20260803_rpa_worker_provider.down.sql"),
    "utf8"
  );
  const cutover = await readFile(
    path.resolve("migrations/20260803_rpa_worker_cutover_to_new.sql"),
    "utf8"
  );
  const rollback = await readFile(
    path.resolve("migrations/20260803_rpa_worker_cutover_to_legacy.sql"),
    "utf8"
  );
  assert.equal((up.match(/DEFAULT 'LEGACY'/g) ?? []).length, 2);
  assert.equal((cutover.match(/SET DEFAULT 'NEW_RPA'/g) ?? []).length, 2);
  assert.match(cutover, /status = 0 AND task_status = 0 AND answer_id IS NULL/);
  assert.equal((rollback.match(/SET DEFAULT 'LEGACY'/g) ?? []).length, 2);
  assert.match(up, /ALTER TABLE brand_rpa_dispatch_task/);
  assert.match(up, /ALTER TABLE rpa_task_execution/);
  assert.equal((down.match(/DROP COLUMN worker_provider/g) ?? []).length, 2);
  assert.equal(
    parseRpaWorkerConfig("monitor", [], {}, "/workspace").providerRoutingEnabled,
    false
  );
});

test("business_type 第一阶段迁移可重复执行、只回填空值且不提前改为 NOT NULL", async () => {
  const up = await readFile(
    path.resolve("migrations/20260808_rpa_execution_business_type.up.sql"),
    "utf8"
  );
  const down = await readFile(
    path.resolve("migrations/20260808_rpa_execution_business_type.down.sql"),
    "utf8"
  );
  assert.match(up, /information_schema\.COLUMNS/);
  assert.match(up, /information_schema\.STATISTICS/);
  assert.match(up, /WHERE e\.business_type IS NULL/);
  assert.doesNotMatch(up, /MODIFY COLUMN business_type varchar\(64\) NOT NULL/);
  assert.match(up, /e\.business_type <> d\.business_type/);
  assert.match(up, /LEFT JOIN brand_rpa_dispatch_task/);
  assert.match(up, /idx_rpa_execution_business_queue/);
  assert.match(down, /DROP INDEX idx_rpa_execution_business_queue/);
  assert.match(down, /DROP COLUMN business_type/);
});
