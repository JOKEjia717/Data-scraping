import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { PLATFORMS } from "../src/platforms.js";
import type { PlatformId } from "../src/types.js";
import {
  WebSearchTechnicalError,
  activateWebSearch,
  assertVerifiedWebSearchForZeroReferences,
  confirmWebSearchFromAnswerEvidence,
  enforceWebSearchPolicy,
  webSearchPolicyForBusinessType
} from "../src/webSearch.js";

let browser: Browser | undefined;
const platformIds: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];

test("回答来源证据可回填已请求且受支持的联网状态", () => {
  assert.deepEqual(confirmWebSearchFromAnswerEvidence({
    requested: true,
    supported: true,
    enabled: false,
    verified: false,
    failureReason: "页面未显示开关"
  }), {
    requested: true,
    supported: true,
    enabled: true,
    verified: true,
    failureReason: null
  });

  const disabled = {
    requested: false,
    supported: true,
    enabled: false,
    verified: false,
    failureReason: null
  } as const;
  assert.equal(confirmWebSearchFromAnswerEvidence(disabled), disabled);
});

before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

async function fixture(initial: boolean): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <button id="web-search" aria-label="联网搜索" aria-pressed="${initial}">
      联网搜索
    </button>
    <script>
      const control = document.querySelector("#web-search");
      control.addEventListener("click", () => {
        const next = control.getAttribute("aria-pressed") !== "true";
        control.setAttribute("aria-pressed", String(next));
        document.body.dataset.clickCount = String(
          Number(document.body.dataset.clickCount || "0") + 1
        );
      });
    </script>
  `);
  return page;
}

async function clickCount(page: Page): Promise<number> {
  return Number(await page.locator("body").getAttribute("data-click-count") ?? "0");
}

test("四个平台联网已开启时可验证且不会重复点击", async () => {
  for (const platformId of platformIds) {
    const page = await fixture(true);
    try {
      const result = await activateWebSearch(page, PLATFORMS[platformId], "REQUIRED");
      assert.deepEqual(result, {
        requested: true,
        supported: true,
        enabled: true,
        verified: true,
        failureReason: null
      });
      assert.equal(await clickCount(page), 0);
    } finally {
      await page.close();
    }
  }
});

test("四个平台联网关闭时只点击一次并确认成功开启", async () => {
  for (const platformId of platformIds) {
    const page = await fixture(false);
    try {
      const result = await activateWebSearch(page, PLATFORMS[platformId], "REQUIRED");
      assert.equal(result.enabled, true);
      assert.equal(result.verified, true);
      assert.equal(await clickCount(page), 1);
    } finally {
      await page.close();
    }
  }
});

test("REQUIRED 无法开启时返回明确技术失败", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent("<main>联网入口缺失</main>");
    const result = await activateWebSearch(page, PLATFORMS.doubao, "REQUIRED");
    assert.equal(result.verified, false);
    assert.throws(
      () => enforceWebSearchPolicy("REQUIRED", result),
      (error: unknown) => error instanceof WebSearchTechnicalError &&
        error.errorCode === "WEB_SEARCH_UNVERIFIED"
    );
  } finally {
    await page.close();
  }
});

test("PREFERRED 开启失败时记录降级但允许继续采集回答", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent("<main>联网入口缺失</main>");
    const result = await activateWebSearch(page, PLATFORMS.deepseek, "PREFERRED");
    assert.equal(result.requested, true);
    assert.equal(result.enabled, false);
    assert.equal(result.verified, false);
    assert.match(result.failureReason ?? "", /找不到/);
    assert.doesNotThrow(() => enforceWebSearchPolicy("PREFERRED", result));
  } finally {
    await page.close();
  }
});

test("DISABLED 明确不操作页面开关", async () => {
  const page = await fixture(false);
  try {
    const result = await activateWebSearch(page, PLATFORMS.qianwen, "DISABLED");
    assert.equal(result.requested, false);
    assert.equal(result.enabled, false);
    assert.equal(result.verified, true);
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("ARTICLE_PROBE 强制 REQUIRED，未联网时不能生成普通零引用成功", () => {
  const policy = webSearchPolicyForBusinessType("ARTICLE_PROBE", "DISABLED");
  const unverified = {
    requested: true,
    supported: true,
    enabled: false,
    verified: false,
    failureReason: "未确认联网"
  } as const;

  assert.equal(policy, "REQUIRED");
  assert.throws(
    () => assertVerifiedWebSearchForZeroReferences(unverified),
    (error: unknown) => error instanceof WebSearchTechnicalError &&
      error.errorCode === "WEB_SEARCH_UNVERIFIED"
  );
});

test("平台明确不支持联网时输出稳定错误码", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    const result = await activateWebSearch(page, {
      ...PLATFORMS.yuanbao,
      webSearchSupported: false
    }, "REQUIRED");
    assert.equal(result.supported, false);
    assert.throws(
      () => enforceWebSearchPolicy("REQUIRED", result),
      (error: unknown) => error instanceof WebSearchTechnicalError &&
        error.errorCode === "WEB_SEARCH_UNSUPPORTED"
    );
  } finally {
    await page.close();
  }
});

test("复用 checkbox 与 data-state 的开关状态时能正确识别启用结果", async () => {
  assert.ok(browser);
  const checkboxPage = await browser.newPage();
  try {
    await checkboxPage.setContent(`<input type="checkbox" checked />`);
    const checkboxResult = await activateWebSearch(checkboxPage, {
      ...PLATFORMS.doubao,
      webSearchButtonSelectors: ["input[type='checkbox']"]
    }, "REQUIRED");
    assert.equal(checkboxResult.enabled, true);
    assert.equal(checkboxResult.verified, true);
  } finally {
    await checkboxPage.close();
  }

  const dataStatePage = await browser.newPage();
  try {
    await dataStatePage.setContent(`<button data-state="checked" />`);
    const dataStateResult = await activateWebSearch(dataStatePage, {
      ...PLATFORMS.deepseek,
      webSearchButtonSelectors: ["button[data-state]"]
    }, "REQUIRED");
    assert.equal(dataStateResult.enabled, true);
    assert.equal(dataStateResult.verified, true);
  } finally {
    await dataStatePage.close();
  }
});

test("DeepSeek 新版 DIV aria-pressed 可验证智能搜索已开启且不点击", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="smart-search" aria-pressed="true">
        <span>智能搜索</span>
      </div>
      <script>
        document.querySelector("#smart-search").addEventListener("click", () => {
          document.body.dataset.clickCount = "1";
        });
      </script>
    `);
    const result = await activateWebSearch(
      page,
      PLATFORMS.deepseek,
      "REQUIRED"
    );
    assert.deepEqual(result, {
      requested: true,
      supported: true,
      enabled: true,
      verified: true,
      failureReason: null
    });
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("千问深度研究入口不能被误当作普通联网搜索开关", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <span data-input-login-gate="deep-research:primary">
        <button id="research" aria-label="研究" aria-pressed="false">研究</button>
      </span>
      <script>document.querySelector("#research").addEventListener("click", () => {
        document.body.dataset.clickCount = "1";
      });</script>
    `);
    const result = await activateWebSearch(
      page,
      PLATFORMS.qianwen,
      "PREFERRED"
    );
    assert.equal(result.enabled, false);
    assert.equal(result.verified, false);
    assert.match(result.failureReason ?? "", /找不到/);
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("元宝通过工具菜单开启联网后使用输入栏标志验证", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="ybc-atomSelect-tools-wrapper">工具</div>
      <ul id="menu" style="display:none">
        <li id="web-search" class="t-dropdown__item">联网搜索</li>
      </ul>
      <div id="selected"></div>
      <script>
        document.querySelector(".ybc-atomSelect-tools-wrapper")
          .addEventListener("click", () => {
            document.querySelector("#menu").style.display = "block";
          });
        document.querySelector("#web-search").addEventListener("click", () => {
          document.querySelector("#menu").style.display = "none";
          document.querySelector("#selected").innerHTML =
            '<span class="application-blot-ai-atom">联网搜索</span>';
          document.body.dataset.clickCount = "1";
        });
      </script>
    `);
    const result = await activateWebSearch(
      page,
      PLATFORMS.yuanbao,
      "REQUIRED"
    );
    assert.equal(result.enabled, true);
    assert.equal(result.verified, true);
    assert.equal(await clickCount(page), 1);
  } finally {
    await page.close();
  }
});
