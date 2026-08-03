import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  DeepThinkingTechnicalError,
  ensureDeepThinkingState
} from "../src/deepThinking.js";
import { PLATFORMS } from "../src/platforms.js";
import type { PlatformConfig, PlatformId } from "../src/types.js";

let browser: Browser | undefined;

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
    <button id="deep-thinking" aria-label="深度思考" aria-pressed="${initial}">
      深度思考
    </button>
    <script>
      const control = document.querySelector("#deep-thinking");
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

const platformIds: PlatformId[] = ["doubao", "deepseek", "qianwen", "yuanbao"];

for (const platformId of platformIds) {
  const config = PLATFORMS[platformId];

  test(`${config.name} 深度思考从关闭幂等切换到开启`, async () => {
    const page = await fixture(false);
    try {
      const result = await ensureDeepThinkingState(page, config, true, "fail");
      assert.deepEqual(result, {
        requested: true,
        actual: true,
        changed: true,
        degraded: false
      });
      assert.equal(await clickCount(page), 1);
    } finally {
      await page.close();
    }
  });

  test(`${config.name} 深度思考从开启幂等切换到关闭`, async () => {
    const page = await fixture(true);
    try {
      const result = await ensureDeepThinkingState(page, config, false, "fail");
      assert.equal(result.actual, false);
      assert.equal(result.changed, true);
      assert.equal(await clickCount(page), 1);
    } finally {
      await page.close();
    }
  });

  test(`${config.name} 已处于目标深度思考状态时不重复点击`, async () => {
    const page = await fixture(true);
    try {
      const result = await ensureDeepThinkingState(page, config, true, "fail");
      assert.equal(result.actual, true);
      assert.equal(result.changed, false);
      assert.equal(await clickCount(page), 0);
    } finally {
      await page.close();
    }
  });

  test(`${config.name} 找不到深度思考开关时返回 DOM 技术错误`, async () => {
    assert.ok(browser);
    const page = await browser.newPage();
    try {
      await page.setContent("<main>没有深度思考控件</main>");
      await assert.rejects(
        () => ensureDeepThinkingState(page, config, true, "fail"),
        (error: unknown) => error instanceof DeepThinkingTechnicalError &&
          error.errorCode === "DOM_CHANGED" && /找不到/.test(error.message)
      );
    } finally {
      await page.close();
    }
  });

  test(`${config.name} 不支持深度思考时按配置降级或失败`, async () => {
    assert.ok(browser);
    const page = await browser.newPage();
    const unsupported: PlatformConfig = {
      ...config,
      deepThinkingControl: { supported: false, selectors: [] }
    };
    try {
      const degraded = await ensureDeepThinkingState(
        page,
        unsupported,
        true,
        "allow_degrade"
      );
      assert.deepEqual(degraded, {
        requested: true,
        actual: null,
        changed: false,
        degraded: true
      });
      await assert.rejects(
        () => ensureDeepThinkingState(page, unsupported, true, "fail"),
        (error: unknown) => error instanceof DeepThinkingTechnicalError &&
          error.errorCode === "TECHNICAL_FAILURE" && /禁止降级/.test(error.message)
      );
    } finally {
      await page.close();
    }
  });
}

test("豆包新版明确显示快速模式时确认深度思考已关闭且不点击", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="mode" type="button">
        <span>快速</span><span>新</span>
      </button>
      <script>
        document.querySelector("#mode").addEventListener("click", () => {
          document.body.dataset.clickCount = "1";
        });
      </script>
    `);
    const result = await ensureDeepThinkingState(
      page,
      PLATFORMS.doubao,
      false,
      "fail"
    );
    assert.deepEqual(result, {
      requested: false,
      actual: false,
      changed: false,
      degraded: false
    });
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("豆包快速模式不能被误判为已开启深度思考", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent("<button type='button'>快速</button>");
    await assert.rejects(
      () => ensureDeepThinkingState(page, PLATFORMS.doubao, true, "fail"),
      (error: unknown) => error instanceof DeepThinkingTechnicalError &&
        error.errorCode === "DOM_CHANGED"
    );
  } finally {
    await page.close();
  }
});

test("DeepSeek 新版明确显示快速模式时确认深度思考已关闭且不点击", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="quick-mode" type="button">快速模式</button>
      <button id="deep-thinking" type="button">深度思考</button>
      <script>
        for (const control of document.querySelectorAll("button")) {
          control.addEventListener("click", () => {
            document.body.dataset.clickCount = String(
              Number(document.body.dataset.clickCount || "0") + 1
            );
          });
        }
      </script>
    `);
    const result = await ensureDeepThinkingState(
      page,
      PLATFORMS.deepseek,
      false,
      "fail"
    );
    assert.deepEqual(result, {
      requested: false,
      actual: false,
      changed: false,
      degraded: false
    });
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("DeepSeek 快速模式不能被误判为已开启深度思考", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent("<button type='button'>快速模式</button>");
    await assert.rejects(
      () => ensureDeepThinkingState(page, PLATFORMS.deepseek, true, "fail"),
      (error: unknown) => error instanceof DeepThinkingTechnicalError &&
        error.errorCode === "DOM_CHANGED"
    );
  } finally {
    await page.close();
  }
});

test("DeepSeek 新版 DIV aria-pressed 控件可直接确认关闭态", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="deep-thinking" aria-pressed="false">
        <span>深度思考</span>
      </div>
      <script>
        document.querySelector("#deep-thinking").addEventListener("click", () => {
          document.body.dataset.clickCount = "1";
        });
      </script>
    `);
    const result = await ensureDeepThinkingState(
      page,
      PLATFORMS.deepseek,
      false,
      "fail"
    );
    assert.equal(result.actual, false);
    assert.equal(result.changed, false);
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});

test("千问新版思考按钮可直接确认深度思考关闭且不点击", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <span data-input-login-gate="deep-think:primary">
        <button id="thinking" aria-label="思考" aria-pressed="false">思考</button>
      </span>
      <script>
        document.querySelector("#thinking").addEventListener("click", () => {
          document.body.dataset.clickCount = "1";
        });
      </script>
    `);
    const result = await ensureDeepThinkingState(
      page,
      PLATFORMS.qianwen,
      false,
      "fail"
    );
    assert.equal(result.actual, false);
    assert.equal(result.changed, false);
    assert.equal(await clickCount(page), 0);
  } finally {
    await page.close();
  }
});
