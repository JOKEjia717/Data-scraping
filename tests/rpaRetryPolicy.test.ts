import assert from "node:assert/strict";
import test from "node:test";
import {
  routeRpaFailure,
  taskRetryBackoffMs,
  taskRetryDelayMs
} from "../src/rpaRetryPolicy.js";

test("输入框、回答超时和浏览器断开进入有限任务重试", () => {
  assert.equal(routeRpaFailure("INPUT_NOT_FOUND"), "retry_task");
  assert.equal(routeRpaFailure("INPUT_UNAVAILABLE"), "retry_task");
  assert.equal(routeRpaFailure("ANSWER_TIMEOUT"), "retry_task");
  assert.equal(routeRpaFailure("BROWSER_DISCONNECTED"), "retry_task");
  assert.equal(routeRpaFailure("PAGE_DISCONNECTED"), "retry_task");
});

test("验证码、登录、限流和 DOM 改版只暂停平台", () => {
  assert.equal(routeRpaFailure("CAPTCHA_REQUIRED"), "pause_platform");
  assert.equal(routeRpaFailure("LOGIN_REQUIRED"), "pause_platform");
  assert.equal(routeRpaFailure("RATE_LIMITED"), "pause_platform");
  assert.equal(routeRpaFailure("DOM_CHANGED"), "pause_platform");
  assert.equal(routeRpaFailure("WEB_SEARCH_UNSUPPORTED"), "pause_platform");
  assert.equal(routeRpaFailure("WEB_SEARCH_UNVERIFIED"), "pause_platform");
});

test("数据库错误只进入 Result Outbox，零引用永远成功", () => {
  assert.equal(routeRpaFailure("DATABASE_ERROR"), "result_outbox");
  assert.equal(routeRpaFailure("ZERO_REFERENCES"), "success");
});

test("任务失败按已有 failCount 指数退避且有上限", () => {
  assert.equal(taskRetryBackoffMs(30_000, 0), 30_000);
  assert.equal(taskRetryBackoffMs(30_000, 1), 60_000);
  assert.equal(taskRetryBackoffMs(30_000, 2), 120_000);
  assert.equal(taskRetryBackoffMs(300_000, 10), 3_600_000);
});

test("可调度重试增加有界随机抖动且不需要占用平台睡眠", () => {
  assert.equal(taskRetryDelayMs(30_000, 1, 5_000, () => 0), 60_000);
  assert.equal(taskRetryDelayMs(30_000, 1, 5_000, () => 1), 65_000);
  assert.throws(() => taskRetryDelayMs(1, 0, -1), /retryJitterMs/);
});
