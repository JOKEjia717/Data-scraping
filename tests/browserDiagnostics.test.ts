import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  classifyPageBlockerText,
  classifyTechnicalError,
  findPlatformPage,
  healthStatusForErrorCode
} from "../src/browserDiagnostics.js";
import { PlatformExecutionError } from "../src/platformExecution.js";
import { PLATFORMS } from "../src/platforms.js";

test("页面阻断提示可区分验证码、登录、匿名额度和限流", () => {
  assert.equal(
    classifyPageBlockerText("请拖动滑块完成安全验证")?.errorCode,
    "CAPTCHA_REQUIRED"
  );
  assert.equal(
    classifyPageBlockerText("请先登录，登录后继续使用")?.errorCode,
    "LOGIN_REQUIRED"
  );
  assert.equal(
    classifyPageBlockerText("游客今日使用次数已达到上限，匿名额度已用完")?.errorCode,
    "ANONYMOUS_QUOTA_EXCEEDED"
  );
  assert.equal(
    classifyPageBlockerText("请求过于频繁，请稍后再试")?.errorCode,
    "RATE_LIMITED"
  );
  assert.equal(classifyPageBlockerText("欢迎回来，可以开始提问"), undefined);
});

test("技术错误分类稳定映射到执行层健康状态", () => {
  assert.equal(classifyTechnicalError(new Error("回答正文为空")), "EMPTY_ANSWER");
  assert.equal(classifyTechnicalError(new Error("等待回答超时")), "ANSWER_TIMEOUT");
  assert.equal(classifyTechnicalError(new Error("Target page has been closed")), "PAGE_DISCONNECTED");
  assert.equal(classifyTechnicalError(new Error("browser disconnected")), "BROWSER_DISCONNECTED");
  assert.equal(classifyTechnicalError(new Error("没有找到聊天输入框")), "INPUT_UNAVAILABLE");
  assert.equal(
    classifyTechnicalError(new PlatformExecutionError("人工处理", "CAPTCHA_REQUIRED")),
    "CAPTCHA_REQUIRED"
  );
  assert.equal(healthStatusForErrorCode("ANONYMOUS_QUOTA_EXCEEDED"), "RATE_LIMITED");
  assert.equal(healthStatusForErrorCode("DOM_CHANGED"), "DOM_CHANGED");
  assert.equal(healthStatusForErrorCode("WEB_SEARCH_UNSUPPORTED"), "DOM_CHANGED");
  assert.equal(healthStatusForErrorCode("WEB_SEARCH_UNVERIFIED"), "DOM_CHANGED");
  assert.equal(healthStatusForErrorCode("INPUT_UNAVAILABLE"), "COOLING_DOWN");
  assert.equal(healthStatusForErrorCode("ANSWER_TIMEOUT"), "COOLING_DOWN");
  assert.equal(healthStatusForErrorCode("DATABASE_ERROR"), "READY");
});

test("平台标签页按主域名和兼容域名识别", () => {
  const pages = [
    { url: () => "https://example.com/" },
    { url: () => "https://chat.qwen.ai/c/123" }
  ] as Page[];
  assert.equal(findPlatformPage(pages, PLATFORMS.qianwen), pages[1]);
  assert.equal(findPlatformPage(pages, PLATFORMS.doubao), undefined);
});
