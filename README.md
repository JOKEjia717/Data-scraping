# 豆包 / DeepSeek / 千问 / 元宝参考来源爬虫

基于 TypeScript、Playwright 和 Chrome DevTools Protocol（CDP）的多平台参考来源采集工具。程序会依次向已登录的 AI 平台发送问题，等待回答完成，展开当前回答的引用列表，并导出结构化数据。

每条记录包含：问题、抓取平台、引用排名、文章来源、文章时间、标题、摘要、URL 和抓取时间。默认问题位于 `src/questions.ts`，也可以在运行时传入 TXT 或 JSON 问题文件。

## 运行环境

- Node.js 18 或更高版本
- npm
- Google Chrome
- 已登录豆包、DeepSeek、千问和元宝账号

程序连接本机已经打开的 Chrome，不会自动启动浏览器、登录账号或关闭标签页，也不需要安装 Playwright 自带的 Chromium。

## 快速开始

### 1. 安装依赖

在项目根目录执行：

```bash
npm install
```

### 2. 启动调试模式 Chrome

先退出普通 Chrome，再在终端 A 中执行：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-ai-crawler
```

### 3. 打开平台并登录

在该 Chrome 中打开需要采集的平台，登录后停留在聊天页面：

| 平台 | 页面地址 |
| --- | --- |
| 豆包 | `https://www.doubao.com/chat/` |
| DeepSeek | `https://chat.deepseek.com/` |
| 千问 | `https://www.qianwen.com/` 或 `https://chat.qwen.ai/` |
| 元宝 | `https://yuanbao.tencent.com/chat/` |

只采集某个平台时，只需打开对应页面。

### 4. 运行

在终端 B 中执行：

```bash
npm run crawl
```

默认按豆包、DeepSeek、千问、元宝的顺序运行。需要中止时按 `Ctrl+C`；程序每完成一道题都会写入一次结果，已经完成的数据不会因中止而丢失。

## 平台模块

四个平台均采用“记录提问前基线 → 等待新回答结束 → 只展开本题引用 → 等待列表稳定 → 结构化解析”的流程。独立的 DOM 定位与失败保护可以避免把历史回答、正文链接、导航链接或下一道题的引用混入当前结果。

### 豆包

- 提问前记录 `search_query_result_block` 数量，用于定位当前回答新增的搜索结果；长会话发生 DOM 复用时，会结合当前问题在页面中的位置寻找最新回答块。
- 等待生成按钮消失且正文连续稳定 12 秒，再在当前回答块中点击“参考 N 篇资料”。
- 只遍历命中引用容器的直接子节点，从卡片内提取标题、来源、摘要和 URL，并进行 URL 清洗与去重。
- 找不到当前引用容器、列表未稳定或结果为空时立即停止，避免跨题抓取。

输出目录：`results/doubao/`

### DeepSeek

- 提问前记录页面正文、高度和 `._223dd7b` 引用容器数量，用于识别新回答是否开始。
- 回答结束后，只点击页面最下方、文本严格符合“X个网页”的最新 `.f93f59e4` 按钮，不操作历史回答入口。
- 等待最后一个可见 `._223dd7b` 列表的引用数量和 URL 集合稳定，再逐个解析其直接子节点；同时兼容直接子节点为 `div` 或 `a` 的页面版本。
- 从单条引用卡片内提取来源、日期、标题、摘要和 URL。标题明显不完整时，默认访问文章页面并使用 `og:title`、`twitter:title` 或 `<title>` 补全，可用 `--resolve-titles=false` 关闭。
- 引用按钮缺失、列表未稳定或没有有效外部链接时立即停止，不回退扫描整页。

输出目录：`results/deepseek/`

### 千问

- 提问前记录 `.link-title-igf0OC` 参考入口数量，只允许点击本题回答新增的最后一个入口。
- 如果首次回答结束后没有新参考入口，会在最新回答的操作区识别带 `reg_svg` 图标的“重新生成”按钮并自动重试一次；不会误点点赞、点踩或分享按钮。
- 点击入口后等待最后一个可见 `.list-XPxyL2`。列表达到入口标注的引用数并稳定，或其直接子节点与 URL 集合持续稳定后，才开始解析。
- 只遍历列表的直接子 `div`，优先从 `data-exposure-extra`、`data-click-extra` 读取标题、URL 和引用顺序，同时兼容卡片内的链接及数据属性。
- 重新生成后仍无入口、列表未稳定或解析为空时停止后续问题，防止问题与引用错位。

输出目录：`results/qianwen/`

### 元宝

- 每道题开始前先关闭上一题的引用抽屉，再记录 `.ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b` 入口数量，用于区分历史入口和本题新增入口。
- 回答完成后只点击本轮新增的最新入口，并等待已打开抽屉中的 `.agent-dialogue-references__list` 出现。
- 持续检查列表直接子 `li` 的数量、标题和 URL；这些内容稳定后才进行提取，避免抽屉仍在加载时漏抓。
- 每个 `li` 作为一条引用解析，优先读取 `.hyc-common-markdown__ref_card[data-url]` 及卡片标题、来源、时间和摘要，随后清洗 URL、去重并保持页面顺序。
- 抓取结束后自动关闭引用抽屉；入口缺失、列表未稳定或结果为空时停止，不读取历史抽屉内容。

输出目录：`results/yuanbao/`

## 输出文件

```text
results/
├── doubao/references.json
├── doubao/references.csv
├── deepseek/references.json
├── deepseek/references.csv
├── qianwen/references.json
├── qianwen/references.csv
├── yuanbao/references.json
├── yuanbao/references.csv
├── references.json
└── references.csv
```

平台子目录保存各自数据，`results/references.json` 和 `results/references.csv` 保存本次运行的汇总数据。

## 运行命令

只运行一个平台：

```bash
npm run crawl:doubao
npm run crawl:deepseek
npm run crawl:qianwen
npm run crawl:yuanbao
```

常用参数：

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `--questions` | 使用 TXT（一行一题）或字符串数组 JSON 问题文件 | `--questions=questions.txt` |
| `--out` | 修改输出目录 | `--out=results-2026-07-17` |
| `--cdp` | 修改 CDP 地址，默认 `http://127.0.0.1:9222` | `--cdp=http://127.0.0.1:9333` |
| `--timeout-ms` | 修改单题最长等待时间，默认 300000（5 分钟） | `--timeout-ms=600000` |
| `--prompt-prefix` | 在每个问题前添加提示词；默认不添加 | `--prompt-prefix="请联网搜索并保留参考来源。问题："` |
| `--resolve-titles=false` | 关闭 DeepSeek 文章标题补全 | `npm run crawl:deepseek -- --resolve-titles=false` |

参数需要放在 npm 脚本后的 `--` 之后，例如：

```bash
npm run crawl:qianwen -- --questions=questions.json --timeout-ms=600000
```

## 常见问题

### 找不到平台标签页或输入框

确认平台是在带 `--remote-debugging-port=9222` 的 Chrome 中打开，页面已经登录并停留在聊天界面。

### 回答完成后找不到引用入口

先确认该问题确实触发了联网搜索并生成了参考来源。必要时使用 `--prompt-prefix` 明确要求联网；如果页面上已有引用但程序无法识别，通常是平台更新了 DOM class，需要同步调整 `src/platforms.ts` 或 `src/extractReferences.ts`。

### 等待回答超时

默认单题上限为 5 分钟。长回答可改为 10 分钟：

```bash
npm run crawl -- --timeout-ms=600000
```

### 输出中断

各平台遇到无法安全定位当前引用的情况会主动停止，这是为了避免产生问题与来源错位的数据。检查终端最后一条平台日志，修复登录、联网搜索或页面结构问题后重新运行对应平台即可。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 组织多平台任务并写入平台数据与汇总数据 |
| `src/crawler.ts` | 连接页面、发送问题、等待回答和执行失败保护 |
| `src/extractReferences.ts` | 展开并解析各平台引用列表 |
| `src/platforms.ts` | 平台地址与页面选择器配置 |
| `src/questions.ts` | 默认问题列表 |
| `src/resolveTitles.ts` | DeepSeek 外部文章标题补全 |
| `src/output.ts` | JSON、CSV 输出 |
