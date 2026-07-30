/**
 * 平台 DOM 回归测试。使用无头 Chrome 构造最小页面，验证解析器只读取当前回答
 * 的结构化引用容器，并覆盖入口点击、列表稳定、去重和失败保护。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { openNewConversation } from "../src/crawler.js";
import {
  clickLatestDoubaoRegenerate,
  clickLatestQianwenRegenerate,
  countDoubaoSearchResultBlocks,
  countQianwenReferenceTriggers,
  countYuanbaoReferenceTriggers,
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

// 所有用例复用同一个浏览器进程，每个用例创建独立页面避免 DOM 状态互相污染。
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
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

test("豆包只点击最新回答中带重新生成语义的操作按钮", async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  const actionClass = [
    "flex", "shrink-0", "items-center", "justify-center", "font-[400]",
    "whitespace-nowrap", "select-none", "text-[14px]", "leading-[22px]",
    "gap-[4px]", "rounded-dbx-sm", "p-[4px]", "transition-colors",
    "duration-150", "ease-out", "bg-transparent", "relative", "h-fit",
    "cursor-pointer", "text-dbx-text-secondary"
  ].join(" ");

  await page.setContent(`
    <section id="old-answer">
      <button id="old-regenerate" class="${actionClass}" aria-label="重新生成">
        <svg data-dbx-name="refresh"></svg>
      </button>
    </section>
    <section id="current-answer">
      <button id="copy" class="${actionClass}" aria-label="复制"><svg data-dbx-name="copy"></svg></button>
      <button id="current-regenerate" class="${actionClass}">
        <svg data-dbx-name="refresh"></svg>
      </button>
      <button id="more" class="${actionClass}" aria-label="更多"><svg data-dbx-name="more"></svg></button>
    </section>
    <script>
      for (const button of document.querySelectorAll("button")) {
        button.addEventListener("click", () => document.body.dataset.clicked = button.id);
      }
    </script>
  `);

  assert.equal(await clickLatestDoubaoRegenerate(page), true);
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "current-regenerate");
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
        <div id="old-yuanbao-source" class="ToolbarSearchGuid_searchGuidTool__M81L2 Toolbar_icon__xGP8b">源</div>
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
  assert.equal(await revealLatestYuanbaoReferenceList(page, 1, 5_000), true);
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
