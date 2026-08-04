/**
 * 平台 DOM 回归测试。使用无头 Chrome 构造最小页面，验证解析器只读取当前回答
 * 的结构化引用容器，并覆盖入口点击、列表稳定、去重和失败保护。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import {
  captureLatestPlatformAnswerWithRetries,
  closeQianwenReferencePanel,
  detectQianwenAnswerLoop,
  executeQuestion,
  inspectCurrentQuestionAnswer,
  isAnswerGeneratingControlText,
  submitQuestion,
  waitForYuanbaoCurrentAnswerComplete
} from "../src/crawler.js";
import { openNewConversation } from "../src/conversationManager.js";
import {
  clickLatestQianwenRegenerate,
  countDoubaoSearchResultBlocks,
  countQianwenReferenceTriggers,
  countYuanbaoReferenceTriggers,
  extractLatestDoubaoAnswer,
  extractLatestPlatformAnswer,
  extractReferences,
  hasCurrentDoubaoReferenceEntry,
  markDoubaoSearchResultBaseline,
  revealLatestDeepSeekReferenceList,
  revealLatestDoubaoReferenceList,
  revealLatestQianwenReferenceList,
  revealLatestYuanbaoReferenceList,
  waitForDoubaoReferenceListStable,
  waitForQianwenReferenceListStable,
  waitForYuanbaoReferenceListStable,
  waitForDeepSeekReferenceListStable
} from "../src/extractReferences.js";
import { PLATFORMS } from "../src/platforms.js";

let browser: Browser | undefined;

test("千问回答重复循环检测能识别崩坏正文且不误判正常长回答", () => {
  const repeatedLines = [
    "关于钛7的座椅配置，材料未提及座椅加热通风按摩等功能。",
    "关于钛7的车身结构，材料未提及高强度笼式车身。",
    "关于钛7的屏幕尺寸，材料未提及具体屏幕尺寸。",
    "关于钛7的底盘悬架，材料未提及具体悬架类型。",
    "关于钛7的纯电续航，材料未提及具体数值。",
    "关于钛7的亏电油耗，材料未提及具体数值。"
  ];
  const brokenAnswer = Array.from({ length: 5 }, () => repeatedLines).flat().join("\n");
  const brokenResult = detectQianwenAnswerLoop(brokenAnswer);
  assert.equal(brokenResult.detected, true);
  assert.equal(brokenResult.maxRepeatCount, 5);

  const normalAnswer = Array.from(
    { length: 30 },
    (_, index) => `这是正常回答的第${index + 1}项，每一项都包含不同且有意义的产品信息。`
  ).join("\n");
  assert.equal(detectQianwenAnswerLoop(normalAnswer).detected, false);
});

test("千问深度研究的终止任务提示必须视为仍在生成", () => {
  assert.equal(isAnswerGeneratingControlText("终止任务"), true);
  assert.equal(isAnswerGeneratingControlText("终止研究"), true);
  assert.equal(isAnswerGeneratingControlText("停止生成"), true);
  assert.equal(isAnswerGeneratingControlText("回答已完成"), false);
});

// 所有用例复用同一个浏览器进程，每个用例创建独立页面避免 DOM 状态互相污染。
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

test("千问 Apple 语义发送按钮与 Windows class 发送按钮都可定位", async () => {
  assert.ok(browser);
  const page = await browser.newPage();

  await page.setContent(`
    <button id="qianwen-apple-send" aria-label="发送"></button>
    <button
      id="qianwen-windows-send"
      class="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-0 p-0 text-16 leading-none outline-none transition-[background-color,color,opacity] duration-200 [&amp;_span[data-role=&quot;icon&quot;]]:size-4 [&amp;_svg]:size-4 cursor-pointer bg-black-button text-[--ty-line-circle]"
    >
      <svg aria-hidden="true"></svg>
    </button>
  `);

  const matchesSelector = async (elementId: string) => {
    const matches = await Promise.all(
      PLATFORMS.qianwen.sendButtonSelectors.map(async (selector) =>
        page.locator(`${selector}#${elementId}`).count().catch(() => 0)
      )
    );
    return matches.some((count) => count === 1);
  };

  assert.equal(await matchesSelector("qianwen-apple-send"), true);
  assert.equal(await matchesSelector("qianwen-windows-send"), true);
  await page.close();
});

test("并行新建对话时输入框持续动画也能直接填充并发送", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      @keyframes moving-input { from { transform: translateX(0); } to { transform: translateX(20px); } }
      textarea { animation: moving-input 300ms linear infinite alternate; }
    </style>
    <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    <button aria-label="发送" type="button">发送</button>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        document.body.dataset.submitted = document.querySelector("textarea").value;
      });
    </script>
  `);

  await submitQuestion(page, PLATFORMS.deepseek, "四平台并行输入稳定性测试");

  assert.equal(
    await page.locator("body").getAttribute("data-submitted"),
    "四平台并行输入稳定性测试"
  );
  await page.close();
});

test("豆包只抽取最新搜索结果块的直接引用子节点", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const redirectTarget = "https://news.example.org/report?utm_campaign=doubao";
  const redirectUrl = `https://www.doubao.com/link?url=${encodeURIComponent(redirectTarget)}`;

  await page.setContent(`
    <main>
      <a href="https://navigation.example.net/">页面导航链接</a>

      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
        <div class="relative mt-[-8px] flex w-full min-w-0 flex-col">
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="https://old.example.com/article">旧回答引用</a>
          </div>
        </div>
      </div>

      <a href="https://body.example.net/article">当前回答正文链接</a>
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
        <div>搜索 3 个关键词，参考 4 篇资料</div>
        <div class="min-w-0 relative flex-col w-full mt-[-8px] flex">
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="https://example.com/a?utm_source=doubao&amp;keep=1">1. 【硅基经济】 精准标题</a>
            <span class="source-name">硅基经济</span>
            <time>2026-07-17</time>
            <p class="desc">第一篇摘要</p>
          </div>
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="${redirectUrl}">2. [海外媒体] 第二篇标题</a>
          </div>
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="https://example.com/a?keep=1&amp;utm_medium=chat">重复链接</a>
          </div>
          <div class="flex pt-[8px] max-w-[100%]">
            <a href="https://www.doubao.com/chat/internal">豆包内部链接</a>
          </div>
        </div>
      </div>
    </main>
  `);

  const records = await extractReferences(page, "测试问题", "豆包");

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.rank), [1, 2]);
  assert.equal(records[0].title, "【硅基经济】 精准标题");
  assert.equal(records[0].articlePlatform, "硅基经济");
  assert.equal(records[0].articleTime, "2026-07-17");
  assert.equal(records[0].summary, "第一篇摘要");
  assert.equal(records[0].url, "https://example.com/a?keep=1");
  assert.equal(records[1].title, "[海外媒体] 第二篇标题");
  assert.equal(records[1].articlePlatform, "海外媒体");
  assert.equal(records[1].url, "https://news.example.org/report");
  assert.ok(records.every((record) => !record.url.includes("old.example.com")));
  assert.ok(records.every((record) => !record.url.includes("body.example.net")));

  await page.close();
});

test("千问只点击新增的 link-title 入口并解析可见 list 的直接子 div", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <button class="link-title-igf0OC" id="old-trigger">3篇来源</button>
      <div class="list-XPxyL2" id="old-list" style="display:none">
        <div data-exposure-extra='{"refer_num":"1","url":"https://old.example.com/a","title":"历史引用"}'></div>
      </div>

      <section id="current-answer">
        <button class="link-title-igf0OC" id="new-trigger">2篇来源</button>
      </section>
      <div class="list-XPxyL2" id="new-list" style="display:none">
        <div data-exposure-extra='{"refer_num":"1","url":"https://news.example.com/a?utm_source=qianwen","title":"第一篇标题"}'>
          <span>示例新闻网 news.example.com</span>
          <p>2026年07月17日 - 第一篇摘要</p>
        </div>
        <div>
          <a href="https://report.example.org/b?utm_medium=qianwen">第二篇标题</a>
          <span class="source-name">报告网 report.example.org</span>
          <p>2026年07月16日 - 第二篇摘要</p>
        </div>
      </div>
    </main>
    <script>
      document.querySelector("#old-trigger").addEventListener("click", () => {
        document.querySelector("#old-list").style.display = "block";
      });
      document.querySelector("#new-trigger").addEventListener("click", () => {
        document.querySelector("#new-list").style.display = "block";
      });
    </script>
  `);

  assert.equal(await countQianwenReferenceTriggers(page), 2);
  const expectedCount = await revealLatestQianwenReferenceList(page, 1, 3_000);
  assert.equal(expectedCount, 2);
  assert.equal(await page.locator("#old-list").isVisible(), false);
  assert.equal(await page.locator("#new-list").isVisible(), true);
  assert.equal(await waitForQianwenReferenceListStable(page, 4_000, expectedCount), true);

  const records = await extractReferences(page, "当前问题", "千问");
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.rank), [1, 2]);
  assert.equal(records[0].title, "第一篇标题");
  assert.equal(records[0].articlePlatform, "示例新闻网");
  assert.equal(records[0].articleTime, "2026年07月17日");
  assert.equal(records[0].summary, "第一篇摘要");
  assert.equal(records[0].url, "https://news.example.com/a");
  assert.equal(records[1].title, "第二篇标题");
  assert.equal(records[1].articlePlatform, "报告网");
  assert.equal(records[1].url, "https://report.example.org/b");
  assert.ok(records.every((record) => !record.url.includes("old.example.com")));

  await page.close();
});

test("千问重新生成先打开外层容器再点击菜单中的重新生成项", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const actionClass = "hover:bg-tag flex size-6 cursor-pointer items-center justify-center rounded transition-colors duration-200";
  await page.setContent(`
    <div id="actions">
      <div id="like" class="${actionClass}"><svg><defs><clipPath id="good_svg__a"></clipPath></defs></svg></div>
      <div id="share" class="${actionClass}"><svg><defs><clipPath id="share_svg__a"></clipPath></defs></svg></div>
      <div id="regenerate-wrapper" class="flex items-center rounded">
        <div id="regenerate-icon" class="${actionClass}"><svg><defs><clipPath id="reg_svg__a"></clipPath></defs></svg></div>
      </div>
      <div id="more" class="${actionClass}"><svg><defs><clipPath id="more_svg__a"></clipPath></defs></svg></div>
    </div>
    <div
      id="regenerate-menu-item"
      role="menuitem"
      style="display:none"
      class="relative min-w-0 flex h-9 cursor-pointer select-none items-center gap-2 rounded-8 px-3 py-1.5 text-sm outline-none transition-colors text-primary"
    >重新生成</div>
    <script>
      document.querySelector("#like").addEventListener("click", () => document.body.dataset.clicked = "like");
      document.querySelector("#share").addEventListener("click", () => document.body.dataset.clicked = "share");
      document.querySelector("#more").addEventListener("click", () => document.body.dataset.clicked = "more");
      document.querySelector("#regenerate-wrapper").addEventListener("click", () => {
        document.body.dataset.menuOpened = "true";
        document.querySelector("#regenerate-menu-item").style.display = "flex";
      });
      document.querySelector("#regenerate-menu-item").addEventListener("click", () => {
        document.body.dataset.clicked = "regenerate-menu-item";
      });
    </script>
  `);

  assert.equal(await clickLatestQianwenRegenerate(page), true);
  assert.equal(await page.locator("body").getAttribute("data-menu-opened"), "true");
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "regenerate-menu-item");

  await page.close();
});

test("豆包引用容器缺失时不回退扫描整页链接", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <a href="https://unrelated.example.com/article">不应被抓取的整页链接</a>
    </main>
  `);

  const records = await extractReferences(page, "测试问题", "豆包");
  assert.deepEqual(records, []);

  await page.close();
});

test("豆包长会话复用搜索块数量时仍能定位当前问题的引用", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "字节跳动有哪些产品？";
  await page.setContent(`
    <main>
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
        <div class="relative mt-[-8px] flex w-full min-w-0 flex-col">
          <div><a href="https://old-one.example.com/">旧引用一</a></div>
        </div>
      </div>
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1"></div>

      <div>${question}</div>
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
        <div>搜索 2 个关键词，参考 1 篇资料</div>
        <div class="relative mt-[-8px] flex w-full min-w-0 flex-col">
          <div><a href="https://current.example.com/products">1. 当前问题引用</a></div>
        </div>
      </div>
      <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1"></div>
    </main>
  `);

  const currentBlockCount = await page.locator(
    "[data-plugin-identifier*='search_query_result_block']"
  ).count();
  const records = await extractReferences(page, question, "豆包", currentBlockCount);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "当前问题引用");
  assert.equal(records[0].url, "https://current.example.com/products");
  await page.close();
});

test("豆包旧块回收导致当前块索引前移时按问题锚点展开并抽取", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "适合多孩家庭使用的新能源SUV该怎么挑选";
  const searchBlock = "block_type:10025 | search_query_result_block.search_type:1";

  await page.setContent(`
    <main>
      <div data-plugin-identifier="${searchBlock}"></div>
      <div data-plugin-identifier="${searchBlock}"></div>
      <div data-plugin-identifier="${searchBlock}"></div>
      <div data-plugin-identifier="${searchBlock}"></div>
      <div data-plugin-identifier="${searchBlock}">
        <div id="old-entry" class="cursor-pointer">搜索 3 个关键词，参考 1 篇资料</div>
      </div>

      <div class="question">${question}</div>
      <div id="current-block" data-plugin-identifier="${searchBlock}">
        <div id="current-entry" class="relative cursor-pointer">
          搜索 3 个关键词，参考 2 篇资料
        </div>
      </div>
      <div data-plugin-identifier="${searchBlock}"></div>
    </main>
    <script>
      document.querySelector("#old-entry").addEventListener("click", () => {
        document.body.dataset.oldClicked = "true";
      });
      document.querySelector("#current-entry").addEventListener("click", () => {
        document.body.dataset.currentClicked = "true";
        const list = document.createElement("div");
        list.className = "relative mt-[-8px] flex w-full min-w-0 flex-col";
        list.innerHTML = [
          '<div><a href="https://current.example.com/one">1. 当前引用一</a></div>',
          '<div><a href="https://current.example.com/two">2. 当前引用二</a></div>'
        ].join("");
        document.querySelector("#current-block").append(list);
      });
    </script>
  `);

  // 提问前共有 6 个块；旧块回收后当前块前移到了索引 5，但总数仍为 7。
  // 旧逻辑从索引 6 开始只会看到空占位块。
  const baselineBlockCount = 6;
  assert.equal(
    await hasCurrentDoubaoReferenceEntry(page, question, baselineBlockCount),
    true
  );
  assert.equal(
    await revealLatestDoubaoReferenceList(page, [], baselineBlockCount, question, 3_000),
    true
  );
  assert.equal(await page.locator("body").getAttribute("data-current-clicked"), "true");
  assert.equal(await page.locator("body").getAttribute("data-old-clicked"), null);
  assert.equal(
    await waitForDoubaoReferenceListStable(page, baselineBlockCount, 4_000, question),
    true
  );

  const records = await extractReferences(page, question, "豆包", baselineBlockCount);
  assert.deepEqual(
    records.map((record) => [record.title, record.url]),
    [
      ["当前引用一", "https://current.example.com/one"],
      ["当前引用二", "https://current.example.com/two"]
    ]
  );
  await page.close();
});

test("豆包问题气泡被回收时通过提问前元素身份识别当前引用", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "30到40万价位新能源家庭SUV选购指南";
  const searchBlock = "block_type:10025 | search_query_result_block.search_type:1";

  await page.setContent(`
    <main id="conversation">
      <div id="old-a" data-plugin-identifier="${searchBlock}"></div>
      <div id="old-b" data-plugin-identifier="${searchBlock}"></div>
      <div id="old-reference" data-plugin-identifier="${searchBlock}">
        <div id="old-entry" class="cursor-pointer">搜索 3 个关键词，参考 1 篇资料</div>
      </div>
      <div id="old-placeholder" data-plugin-identifier="${searchBlock}"></div>
    </main>
    <script>
      document.querySelector("#old-entry").addEventListener("click", () => {
        document.body.dataset.oldClicked = "true";
      });
    </script>
  `);
  await markDoubaoSearchResultBaseline(page);

  // 豆包回收两个旧块和当前问题气泡，再挂载本题的新回答；搜索块总数由 4
  // 下降到 3，页面中完全不存在当前问题文本。
  await page.evaluate(({ searchBlock }) => {
    document.querySelector("#old-a")?.remove();
    document.querySelector("#old-b")?.remove();
    const current = document.createElement("div");
    current.id = "current-reference";
    current.setAttribute("data-plugin-identifier", searchBlock);
    current.innerHTML = `
      <div id="current-entry" class="relative cursor-pointer">
        搜索 3 个关键词，参考 1 篇资料
      </div>
    `;
    document.querySelector("#conversation")?.append(current);
    document.querySelector("#current-entry")?.addEventListener("click", () => {
      document.body.dataset.currentClicked = "true";
      const list = document.createElement("div");
      list.className = "relative mt-[-8px] flex w-full min-w-0 flex-col";
      list.innerHTML = '<div><a href="https://current.example.com/suv">1. 当前SUV引用</a></div>';
      current.append(list);
    });
  }, { searchBlock });

  assert.equal((await page.locator("body").innerText()).includes(question), false);
  assert.equal(await countDoubaoSearchResultBlocks(page), 3);
  assert.equal(await hasCurrentDoubaoReferenceEntry(page, question, 4), true);
  assert.equal(
    await revealLatestDoubaoReferenceList(page, [], 4, question, 3_000),
    true
  );
  assert.equal(await page.locator("body").getAttribute("data-current-clicked"), "true");
  assert.equal(await page.locator("body").getAttribute("data-old-clicked"), null);

  const records = await extractReferences(page, question, "豆包", 4);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "当前SUV引用");
  assert.equal(records[0].url, "https://current.example.com/suv");
  await page.close();
});

test("豆包首题导航到新会话丢失页面基线后按正文问题锚点识别引用", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "测试当前问题";
  const searchBlock = "block_type:10025 | search_query_result_block.search_type:1";

  // 用拆分文本模拟富文本问题气泡：TreeWalker 没有完整问题文本节点；同时不调用
  // markDoubaoSearchResultBaseline，模拟首题导航后新 document 丢失 WeakSet。
  await page.setContent(`
    <main>
      <div class="question"><span>测试当前</span><span>问题</span></div>
      <div data-plugin-identifier="${searchBlock}">
        <div class="cursor-pointer">搜索 4 个关键词，参考 22 篇资料</div>
      </div>
    </main>
  `);

  assert.equal(await countDoubaoSearchResultBlocks(page), 1);
  assert.equal(await hasCurrentDoubaoReferenceEntry(page, question, 1), true);
  await page.close();
});

test("豆包只提取最后一次生成的正文块并排除搜索、视频和操作按钮", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main id="conversation">
      <div data-container-type="block-v2" id="historical-answer">
        <div data-plugin-identifier="block_type:10000">历史回答正文</div>
      </div>
    </main>
  `);
  await markDoubaoSearchResultBaseline(page);

  await page.locator("#conversation").evaluate((conversation) => {
    conversation.insertAdjacentHTML("beforeend", `
      <div data-container-type="block-v2" id="original-answer">
        <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
          搜索 3 个关键词，参考 2 篇资料
        </div>
        <div data-plugin-identifier="block_type:10000">
          <h2>原始回答标题</h2>
          <p>原始回答正文。</p>
          <button>复制</button>
        </div>
        <div data-plugin-identifier="block_type:10050">相关视频，不应保存</div>
      </div>
    `);
  });
  assert.equal(
    await extractLatestDoubaoAnswer(page),
    "原始回答标题\n\n原始回答正文。"
  );

  // 模拟重新提问后挂载新版本；旧版本仍在 DOM 中，但最终只读取最后一个新容器。
  await page.locator("#conversation").evaluate((conversation) => {
    conversation.insertAdjacentHTML("beforeend", `
      <div data-container-type="block-v2" id="regenerated-answer">
        <div data-plugin-identifier="block_type:10025 | search_query_result_block.search_type:1">
          搜索 3 个关键词，参考 1 篇资料
        </div>
        <div data-plugin-identifier="block_type:10000">
          <h2>最后一次答案</h2>
          <p>这是重新提问后的最终正文。</p>
          <div role="button">重新生成</div>
        </div>
        <div data-plugin-identifier="block_type:10050">最终相关视频</div>
      </div>
    `);
  });

  const finalAnswer = await extractLatestDoubaoAnswer(page);
  assert.equal(finalAnswer, "最后一次答案\n\n这是重新提问后的最终正文。");
  assert.equal(finalAnswer.includes("参考"), false);
  assert.equal(finalAnswer.includes("视频"), false);
  await page.close();
});

test("DeepSeek、千问和元宝只提取最后一版回答正文并清理非正文组件", async () => {
  assert.ok(browser);
  const page = await browser.newPage();

  await page.setContent(`
    <main>
      <section id="deepseek">
        <div class="ds-markdown ds-assistant-message-main-content">DeepSeek 历史回答</div>
        <div class="ds-markdown ds-assistant-message-main-content">
          <h2>DeepSeek 最终回答</h2>
          <p>正文内容<a href="https://example.com/source">-<span>2</span></a>。</p>
          <button>复制</button>
        </div>
      </section>

      <section id="qianwen">
        <div class="message-select-wrapper-answer-rqWekn">
          <div class="qk-markdown">千问历史回答</div>
        </div>
        <div class="message-select-wrapper-answer-rqWekn">
          <div class="qk-markdown">
            <h2>千问最终回答</h2>
            <div class="qk-md-paragraph">
              正文内容<span class="options-item-Yv7oFR">3</span>。
            </div>
            <div class="qk-md-paragraph qk-md-has-multi-modal">
              视频推荐不应保存
            </div>
          </div>
          <div class="reference-wrap-iEjeb3">7篇来源</div>
        </div>
      </section>

      <section id="yuanbao">
        <div data-conv-speaker="ai">
          <div class="agent-chat__speech-card__text">元宝历史回答</div>
        </div>
        <div data-conv-speaker="ai">
          <div class="agent-chat__speech-card__text">
            <div class="hyc-common-markdown">
              <h2>元宝最终回答</h2>
              <div class="ybc-p">正文内容。</div>
              <div class="hyc-common-markdown__replace">
                图片卡片标题不应重复保存
              </div>
            </div>
            <div role="button">重新生成</div>
          </div>
        </div>
      </section>
    </main>
  `);

  assert.equal(
    await extractLatestPlatformAnswer(page, "deepseek"),
    "DeepSeek 最终回答\n\n正文内容。"
  );
  assert.equal(
    await extractLatestPlatformAnswer(page, "qianwen"),
    "千问最终回答\n正文内容。"
  );
  assert.equal(
    await extractLatestPlatformAnswer(page, "yuanbao"),
    "元宝最终回答\n正文内容。"
  );
  await page.close();
});

test("千问新版 complete 回答节点延迟挂载时只等待恢复而不重新提问", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main id="chat">
      <div class="user-question">测试问题</div>
    </main>
    <script>
      setTimeout(() => {
        document.querySelector("#chat").insertAdjacentHTML("beforeend", ` + "`" + `
          <div class="chat-answers-card-wrap">
            <div class="answer-common-card undefined">
              <div class="qk-markdown qk-markdown-react qk-markdown-complete">
                <div class="qk-md-paragraph">这是延迟挂载的千问完整回答。</div>
              </div>
            </div>
          </div>
        ` + "`" + `);
      }, 1500);
    </script>
  `);

  // 在回答节点出现前就开始检查，覆盖“题目快照先读取、回答随后挂载”的真实竞态。
  const inspection = await inspectCurrentQuestionAnswer(
    page,
    PLATFORMS.qianwen,
    "测试问题",
    "business"
  );
  assert.equal(inspection.status, "answered", inspection.reason);
  assert.equal(inspection.answerContent, "这是延迟挂载的千问完整回答。");
  assert.equal(
    await page.locator(".user-question").count(),
    1,
    "只读恢复不能重新插入或发送问题"
  );
  await page.close();
});

test("千问右侧问题导航重复文本不能覆盖真实问题气泡锚点", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "千问第三题测试";
  await page.setContent(`
    <main>
      <div class="message-card-wrap question">
        <div class="question-text-card">${question}</div>
      </div>
      <div class="chat-answers-card-wrap">
        <div class="answer-common-card">
          <div class="qk-markdown qk-markdown-complete">这是第三题的完整回答正文。</div>
        </div>
      </div>
    </main>
    <aside class="rn-right-navigator">
      <span class="rn-right-navigator-item-name">${question}</span>
    </aside>
  `);

  const inspection = await inspectCurrentQuestionAnswer(
    page,
    PLATFORMS.qianwen,
    question,
    "business"
  );
  assert.equal(inspection.status, "answered", inspection.reason);
  assert.equal(inspection.answerContent, "这是第三题的完整回答正文。");
  await page.close();
});

test("千问每题结束后关闭参考来源侧栏且不触碰发送按钮", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <button id="send">发送</button>
      <aside id="reference-panel">
        <div class="deep-think-source-tyxrYL">
          <div class="header-imUI9F">
            <div>参考来源 (2)</div>
            <div id="close-reference"><svg><path></path></svg></div>
          </div>
          <div class="list-XPxyL2"><div>引用一</div><div>引用二</div></div>
        </div>
      </aside>
    </main>
    <script>
      document.querySelector("#close-reference").addEventListener("click", () => {
        document.querySelector("#reference-panel").style.display = "none";
      });
      document.querySelector("#send").addEventListener("click", () => {
        document.body.dataset.sent = "true";
      });
    </script>
  `);

  await closeQianwenReferencePanel(page);

  assert.equal(await page.locator(".list-XPxyL2:visible").count(), 0);
  assert.equal(await page.locator("body").getAttribute("data-sent"), null);
  await page.close();
});

test("DeepSeek 只抽取最新可见 _223dd7b 容器的直接引用子节点", async () => {
  assert.ok(browser);
  const page = await browser.newPage();

  await page.setContent(`
    <main>
      <a href="https://navigation.example.net/">页面导航链接</a>
      <div class="_223dd7b" style="display:none">
        <div><a href="https://hidden.example.com/old">隐藏的历史引用</a></div>
      </div>
      <div class="_223dd7b">
        <div><a href="https://old-visible.example.com/article">仍在 DOM 中的旧回答引用</a></div>
      </div>
      <div class="_223dd7b">
        <div>
          <a href="https://example.com/ai?utm_source=deepseek&amp;keep=1">
            <span class="reference-source">钛媒体</span>
            <time>2026/05/22</time>
            <h3 class="reference-title">全球社交的旧王与新王</h3>
            <p class="reference-desc">字节跳动和 Meta 的竞争格局分析。</p>
          </a>
        </div>
        <a href="https://news.example.org/report?utm_campaign=deepseek">
          <span class="reference-source">新浪财经</span>
          <time>2026/07/16</time>
          <span class="reference-title">205亿砸向可灵！AI视频竞争升级</span>
        </a>
      </div>
      <a href="https://body.example.net/article">回答正文普通链接</a>
    </main>
  `);

  const records = await extractReferences(page, "测试问题", "DeepSeek");

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.rank), [1, 2]);
  assert.equal(records[0].articlePlatform, "钛媒体");
  assert.equal(records[0].articleTime, "2026/05/22");
  assert.equal(records[0].title, "全球社交的旧王与新王");
  assert.equal(records[0].summary, "字节跳动和 Meta 的竞争格局分析。");
  assert.equal(records[0].url, "https://example.com/ai?keep=1");
  assert.equal(records[1].articlePlatform, "新浪财经");
  assert.equal(records[1].title, "205亿砸向可灵！AI视频竞争升级");
  assert.equal(records[1].url, "https://news.example.org/report");
  assert.ok(records.every((record) => !record.url.includes("navigation.example.net")));
  assert.ok(records.every((record) => !record.url.includes("body.example.net")));
  assert.ok(records.every((record) => !record.url.includes("hidden.example.com")));
  assert.ok(records.every((record) => !record.url.includes("old-visible.example.com")));

  await page.close();
});

test("DeepSeek 缺少 _223dd7b 容器时不回退扫描整页链接", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <a href="https://unrelated.example.com/article">不应抓取的整页链接</a>
    </main>
  `);

  const records = await extractReferences(page, "测试问题", "DeepSeek");
  assert.deepEqual(records, []);
  await page.close();
});

test("DeepSeek 必须点击最新 f93f59e4 的 X个网页按钮后再打开引用列表", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div>历史回答</div>
        <div id="old-web-pages" class="f93f59e4">1个网页</div>
      </section>
      <section>
        <div>当前回答</div>
        <div id="current-web-pages" class="f93f59e4">2个网页</div>
      </section>
    </main>
  `);
  await page.evaluate(() => {
    document.querySelector("#old-web-pages")?.addEventListener("click", () => {
      document.body.setAttribute("data-clicked", "old");
    });
    document.querySelector("#current-web-pages")?.addEventListener("click", () => {
      document.body.setAttribute("data-clicked", "current");
      const container = document.createElement("div");
      container.className = "_223dd7b";
      container.innerHTML = `
        <div><a href="https://current.example.com/one"><span class="reference-title">当前引用一</span></a></div>
        <div><a href="https://current.example.com/two"><span class="reference-title">当前引用二</span></a></div>
      `;
      document.body.append(container);
    });
  });

  assert.equal(await page.locator("._223dd7b").count(), 0);
  const expectedCount = await revealLatestDeepSeekReferenceList(page, 5_000);

  assert.equal(expectedCount, 2);
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "current");
  assert.equal(await page.locator("._223dd7b").count(), 1);
  assert.equal(await waitForDeepSeekReferenceListStable(page, 5_000, expectedCount), true);

  const records = await extractReferences(page, "测试问题", "DeepSeek");
  assert.deepEqual(records.map((record) => record.title), ["当前引用一", "当前引用二"]);
  await page.close();
});

test("元宝点击最新 ToolbarSearchGuid 入口并只解析主列表的直接子 li", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div>历史回答</div>
        <div
          id="old-yuanbao-source"
          class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b"
          data-codex-yuanbao-baseline="test-marker"
        >源</div>
      </section>
      <section>
        <div>当前回答</div>
        <div id="current-yuanbao-source" class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b">源</div>
      </section>
      <a href="https://outside.example.com/ignore">列表外链接</a>
    </main>
    <script>
      document.querySelector("#old-yuanbao-source").addEventListener("click", () => {
        document.body.setAttribute("data-clicked", "old");
      });
      document.querySelector("#current-yuanbao-source").addEventListener("click", () => {
        document.body.setAttribute("data-clicked", "current");
        const list = document.createElement("ul");
        list.className = "agent-dialogue-references__list";
        list.innerHTML =
          '<li class="agent-dialogue-references__item" dt-ext3="车家号" dt-ext6="https://news.example.com/a">' +
            '<div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://news.example.com/a">' +
              '<div class="hyc-common-markdown__ref_card-foot__source_txt">车家号</div>' +
              '<h4 class="hyc-common-markdown__ref_card-title">第一篇标题</h4>' +
              '<p class="hyc-common-markdown__ref_card-desc">第一篇摘要</p>' +
            '</div>' +
          '</li>' +
          '<li class="agent-dialogue-references__item" dt-ext3="懂车帝" dt-ext6="https://news.example.com/b">' +
            '<div class="hyc-common-markdown__ref_card" data-idx="2" data-url="https://news.example.com/b">' +
              '<div class="hyc-common-markdown__ref_card-foot__source_txt">懂车帝</div>' +
              '<h4 class="hyc-common-markdown__ref_card-title">第二篇标题</h4>' +
              '<p class="hyc-common-markdown__ref_card-desc">第二篇摘要</p>' +
            '</div>' +
          '</li>';
        document.body.append(list);
      });
    </script>
  `);

  assert.equal(await countYuanbaoReferenceTriggers(page), 2);
  assert.equal(
    await revealLatestYuanbaoReferenceList(page, "test-marker", "当前回答", 5_000),
    true
  );
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "current");
  assert.equal(await waitForYuanbaoReferenceListStable(page, 5_000), true);

  const records = await extractReferences(page, "测试问题", "元宝");
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.articlePlatform), ["车家号", "懂车帝"]);
  assert.deepEqual(records.map((record) => record.title), ["第一篇标题", "第二篇标题"]);
  assert.deepEqual(records.map((record) => record.summary), ["第一篇摘要", "第二篇摘要"]);
  assert.deepEqual(records.map((record) => record.url), [
    "https://news.example.com/a",
    "https://news.example.com/b"
  ]);
  assert.ok(records.every((record) => !record.url.includes("outside.example.com")));
  await page.close();
});

test("元宝长会话复用已标记入口时按当前问题 DOM 锚点点击", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div>当前问题</div>
        <div>当前回答正文</div>
        <div
          id="recycled-yuanbao-source"
          class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b"
          data-codex-yuanbao-baseline="recycled-marker"
        >源</div>
      </section>
    </main>
    <script>
      document.querySelector("#recycled-yuanbao-source").addEventListener("click", () => {
        document.body.dataset.clicked = "recycled-current";
        const list = document.createElement("ul");
        list.className = "agent-dialogue-references__list";
        list.innerHTML =
          '<li><div data-url="https://news.example.com/recycled">' +
            '<h4>复用入口引用</h4>' +
          '</div></li>';
        document.body.append(list);
      });
    </script>
  `);

  assert.equal(
    await revealLatestYuanbaoReferenceList(
      page,
      "recycled-marker",
      "当前问题",
      5_000
    ),
    true
  );
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "recycled-current");
  await page.close();
});

test("元宝入口不可见时通过 DOM 点击回退打开无 open class 的抽屉", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div>当前隐藏入口问题</div>
        <div
          id="hidden-yuanbao-source"
          class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b"
          style="display:none"
        >源</div>
      </section>
    </main>
    <script>
      document.querySelector("#hidden-yuanbao-source").addEventListener("click", () => {
        document.body.dataset.clicked = "hidden-dom-fallback";
        const drawer = document.createElement("div");
        drawer.className = "t-drawer";
        drawer.innerHTML =
          '<ul class="agent-dialogue-references__list">' +
            '<li><div data-url="https://news.example.com/hidden">' +
              '<h4>隐藏入口引用</h4>' +
            '</div></li>' +
          '</ul>';
        document.body.append(drawer);
      });
    </script>
  `);

  assert.equal(
    await revealLatestYuanbaoReferenceList(
      page,
      "hidden-marker",
      "当前隐藏入口问题",
      8_000
    ),
    true
  );
  assert.equal(
    await page.locator("body").getAttribute("data-clicked"),
    "hidden-dom-fallback"
  );
  assert.equal(await waitForYuanbaoReferenceListStable(page, 5_000), true);
  await page.close();
});

test("元宝回答完成后延迟挂载参考入口时继续等待并打开", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section id="late-answer">
        <div>延迟入口问题</div>
        <div>回答正文先完成</div>
      </section>
    </main>
    <script>
      setTimeout(() => {
        const trigger = document.createElement("div");
        trigger.id = "late-yuanbao-source";
        trigger.className =
          "ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b";
        trigger.textContent = "源";
        trigger.addEventListener("click", () => {
          document.body.dataset.clicked = "late-current";
          const list = document.createElement("ul");
          list.className = "agent-dialogue-references__list";
          list.innerHTML =
            '<li><div data-url="https://news.example.com/late">' +
              '<h4>延迟入口引用</h4>' +
            '</div></li>';
          document.body.append(list);
        });
        document.querySelector("#late-answer").append(trigger);
      }, 500);
    </script>
  `);

  assert.equal(
    await revealLatestYuanbaoReferenceList(
      page,
      "late-marker",
      "延迟入口问题",
      8_000
    ),
    true
  );
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "late-current");
  await page.close();
});

test("元宝来源入口提前出现时仍等待当前正文停止增长", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const question = "元宝流式回答测试问题";
  await page.setContent(`
    <main>
      <section>
        <div>${question}</div>
        <div data-conv-speaker="ai">
          <div id="yuanbao-streaming-answer" class="agent-chat__speech-card__text"></div>
          <div class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b">源</div>
        </div>
      </section>
    </main>
    <script>
      setTimeout(() => {
        document.querySelector("#yuanbao-streaming-answer").textContent =
          "回答开头。";
      }, 100);
      setTimeout(() => {
        document.querySelector("#yuanbao-streaming-answer").textContent +=
          "第一部分仍在生成。";
      }, 350);
      setTimeout(() => {
        document.querySelector("#yuanbao-streaming-answer").textContent +=
          "这是最终完整答案。";
      }, 700);
    </script>
  `);

  const startedAt = Date.now();
  await waitForYuanbaoCurrentAnswerComplete(
    page,
    question,
    4_000,
    250,
    0
  );
  const elapsed = Date.now() - startedAt;
  const finalText = await page.locator("#yuanbao-streaming-answer").innerText();

  assert.equal(
    finalText,
    "回答开头。第一部分仍在生成。这是最终完整答案。"
  );
  assert.ok(elapsed >= 900, `不应在最终正文出现前结束等待，实际等待 ${elapsed}ms`);
  await page.close();
});

test("一轮问题结束后点击新建对话并等待空白输入界面", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const previousQuestion = "抖音有哪些竞品？";

  await page.setContent(`
    <aside>
      <button aria-label="新建对话" id="new-chat">新建对话</button>
    </aside>
    <main id="conversation">
      <div>${previousQuestion}</div>
      <div>上一轮回答内容</div>
    </main>
    <textarea aria-label="聊天输入框"></textarea>
    <script>
      document.querySelector("#new-chat").addEventListener("click", () => {
        document.body.dataset.newConversation = "true";
        document.querySelector("#conversation").innerHTML = "<div>开始新的对话</div>";
      });
    </script>
  `);

  const opened = await openNewConversation(
    page,
    PLATFORMS.doubao,
    previousQuestion,
    3_000
  );

  assert.equal(opened, true);
  assert.equal(await page.locator("body").getAttribute("data-new-conversation"), "true");
  assert.equal(await page.getByText(previousQuestion).count(), 0);
  assert.equal(await page.locator("textarea").isEnabled(), true);
  await page.close();
});

test("豆包品牌完成后点击新版 sidebar_nav_item 新对话入口", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const previousQuestion = "古装宫廷剧主要参与品牌";

  await page.setContent(`
    <aside>
      <div
        class="group/sidebar_nav_item cursor-pointer flex items-center px-8 rounded-dbx-lg h-36 nav-link-IKier0"
        style="width:254px;height:36px"
      >
        <svg width="24" height="24"></svg>
        <div>新对话</div>
      </div>
    </aside>
    <main id="conversation">
      <div data-container-type="block-v2">
        <div>${previousQuestion}</div>
        <div data-plugin-identifier="block_type:10000">上一品牌回答</div>
      </div>
    </main>
    <textarea aria-label="聊天输入框"></textarea>
    <script>
      document.querySelector("[class*='sidebar_nav_item']").addEventListener("click", () => {
        document.body.dataset.doubaoNewConversation = "true";
        document.querySelector("#conversation").innerHTML = "";
      });
    </script>
  `);

  const opened = await openNewConversation(
    page,
    PLATFORMS.doubao,
    previousQuestion,
    3_000
  );

  assert.equal(opened, true);
  assert.equal(
    await page.locator("body").getAttribute("data-doubao-new-conversation"),
    "true"
  );
  assert.equal(await page.getByText(previousQuestion).count(), 0);
  assert.equal(await page.locator("textarea").isEnabled(), true);
  await page.close();
});

test("DeepSeek 品牌完成后点击新版开启新对话 DIV", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const previousQuestion = "古装宫廷剧品牌盘点";

  await page.setContent(`
    <aside>
      <div class="_5a8ac7a" tabindex="0" style="width:236px;height:40px">
        <div class="ds-icon_1c42ad7"></div>
        <span>开启新对话</span>
      </div>
    </aside>
    <main id="conversation">
      <div class="ds-message">${previousQuestion}</div>
      <div class="ds-markdown ds-assistant-message-main-content">上一品牌回答</div>
    </main>
    <textarea aria-label="给 DeepSeek 发送消息"></textarea>
    <script>
      document.querySelector("._5a8ac7a").addEventListener("click", () => {
        document.body.dataset.deepseekNewConversation = "true";
        document.querySelector("#conversation").innerHTML = "";
      });
    </script>
  `);

  const opened = await openNewConversation(
    page,
    PLATFORMS.deepseek,
    previousQuestion,
    3_000
  );

  assert.equal(opened, true);
  assert.equal(
    await page.locator("body").getAttribute("data-deepseek-new-conversation"),
    "true"
  );
  assert.equal(await page.getByText(previousQuestion).count(), 0);
  assert.equal(await page.locator("textarea").isEnabled(), true);
  await page.close();
});

test("元宝品牌完成后点击 data-desc=new-chat 的新版入口", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const previousQuestion = "古装宫廷剧参与品牌分析";

  await page.setContent(`
    <aside>
      <div
        class="yb-common-nav__trigger"
        data-desc="new-chat"
        style="width:28px;height:28px"
      >
        <span class="yb-icon iconfont-yb icon-yb_icon_newchat_20"></span>
      </div>
    </aside>
    <main id="conversation">
      <div data-conv-speaker="user">${previousQuestion}</div>
      <div data-conv-speaker="ai">
        <div class="agent-chat__speech-card__text">上一品牌回答</div>
      </div>
    </main>
    <textarea aria-label="发送消息"></textarea>
    <script>
      document.querySelector("[data-desc='new-chat']").addEventListener("click", () => {
        document.body.dataset.yuanbaoNewConversation = "true";
        document.querySelector("#conversation").innerHTML = "";
      });
    </script>
  `);

  const opened = await openNewConversation(
    page,
    PLATFORMS.yuanbao,
    previousQuestion,
    3_000
  );

  assert.equal(opened, true);
  assert.equal(
    await page.locator("body").getAttribute("data-yuanbao-new-conversation"),
    "true"
  );
  assert.equal(await page.getByText(previousQuestion).count(), 0);
  assert.equal(await page.locator("textarea").isEnabled(), true);
  await page.close();
});

test("已经处于空白聊天页时即使带有上一题也不会重复点击新建对话", async () => {
  assert.ok(browser);
  const page = await browser.newPage();

  await page.setContent(`
    <aside><button aria-label="新建对话" id="new-chat">新建对话</button></aside>
    <main><div>开始新的对话</div></main>
    <textarea aria-label="聊天输入框"></textarea>
    <script>
      document.querySelector("#new-chat").addEventListener("click", () => {
        document.body.dataset.newConversationClicked = "true";
      });
    </script>
  `);

  const ready = await openNewConversation(page, PLATFORMS.doubao, "上一品牌最后一题", 1_000);

  assert.equal(ready, true);
  assert.equal(
    await page.locator("body").getAttribute("data-new-conversation-clicked"),
    null
  );
  await page.close();
});

test("executeQuestion 页面未就绪时不会越权创建新对话", async () => {
  assert.ok(browser);
  const page = await browser.newPage();

  await page.setContent(`
    <button id="new-chat" aria-label="新建对话">新建对话</button>
    <script>
      document.querySelector("#new-chat").addEventListener("click", () => {
        document.body.dataset.newConversationClicked = "true";
      });
    </script>
  `);

  await assert.rejects(
    () => executeQuestion(
      { questionIndex: 0, question: "单题边界测试" },
      {
        page,
        config: PLATFORMS.doubao,
        mode: "research",
        promptPrefix: "",
        retryOnNoReferences: true,
        regenerateOnNoReferences: true,
        resolveTitles: false,
        timeoutMs: 1
      }
    ),
    /长时间没有恢复到可提问状态/
  );
  assert.equal(
    await page.locator("body").getAttribute("data-new-conversation-clicked"),
    null
  );
  await page.close();
});
