# 豆包 / DeepSeek / 千问 / 元宝参考来源爬虫

基于 TypeScript、Playwright 和 Chrome DevTools Protocol（CDP）的多平台参考来源采集工具。程序会依次向已登录的 AI 平台发送问题，等待回答完成，展开当前回答的引用列表，并导出结构化数据。

每条记录包含：问题、抓取平台、引用排名、文章来源、文章时间、标题、摘要、URL 和抓取时间。默认问题位于 `src/questions.ts`，也可以在运行时传入 TXT 或 JSON 问题文件。

## 核心流程

```text
问题库
  ↓
按平台串行提问（豆包 → DeepSeek → 千问 → 元宝）
  ↓
等待本题回答与引用列表稳定
  ↓
参考资料缺失时按平台检查或重新生成，仍为空则跳过本题
  ↓
解析、清洗并实时写入平台独立数据
  ↓
完成该平台全部问题后自动新建对话
  ↓
按平台分桶 → 平台内按问题分组 → 合并四个平台的同题数据
  ↓
写入根目录汇总 references.json / references.csv
```

单道题没有参考资料时，豆包会最多重新生成 3 次，其他平台按各自策略检查；引用入口仍缺失、列表仍未稳定或解析结果仍为空时，只跳过当前题并继续下一题，对应平台数组保留为空。登录失效、输入框不可用或无法确认回答已经结束等会造成题目错位的严重异常，仍会停止当前平台任务。

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

#### macOS

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-ai-crawler
```

#### Windows PowerShell

Chrome 安装在系统默认目录时执行：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-ai-crawler"
```

如果提示找不到 `chrome.exe`，Chrome 可能安装在当前用户目录，改用：

```powershell
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-ai-crawler"
```

保持这个 Chrome 窗口打开。另开一个 PowerShell 窗口，可以用下面的命令确认调试端口已经启动：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

看到浏览器版本和 `webSocketDebuggerUrl` 等信息即表示启动成功。

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

四个平台均采用“记录提问前基线 → 等待新回答结束 → 只展开本题引用 → 等待列表稳定 → 结构化解析”的流程。每个平台完成问题库中的全部问题后，程序会自动点击“新建对话”并等待空白输入界面，为下一轮运行准备干净会话。找不到新对话入口时仅输出提醒，不影响已经写入的数据，也不阻塞下一个平台。

### 豆包

- 优先以当前问题文本节点为锚点，只检查它之后的 `search_query_result_block`；提问前还会记录现存搜索块的元素身份。当长会话连问题气泡一起回收时，只接受提问后新挂载且含“参考 N 篇资料”的搜索块。块数量仅作为最后后备，因此 DOM 数量减少、复用数量或索引前移时也不会误读历史回答。
- 等待生成按钮消失和正文稳定；当前问题之后已经出现“参考 N 篇资料”且页面短暂稳定时可直接进入引用阶段，避免回答实际结束后仍等待到全局超时。
- 原始回答没有可用参考列表时，只点击最新回答操作区中确认具有“重新生成”语义的按钮；每次等待新回答完整结束后重新检查，最多重新生成 3 次。
- 豆包展开入口最长等待 30 秒，展开后最长等待 15 秒确认引用子节点数量和 URL 集合稳定。
- 只遍历命中引用容器的直接子节点，从卡片内提取标题、来源、摘要和 URL，并进行 URL 清洗与去重。
- 3 次重新生成后仍找不到当前引用容器或列表仍未稳定时跳过当前题，且不会回退读取历史引用。

输出目录：`results/doubao/`

### DeepSeek

- 提问前记录页面正文、高度和 `._223dd7b` 引用容器数量，用于识别新回答是否开始。
- 回答结束后，只点击页面最下方、文本严格符合“X个网页”的最新 `.f93f59e4` 按钮，不操作历史回答入口。
- 等待最后一个可见 `._223dd7b` 列表的引用数量和 URL 集合稳定，再逐个解析其直接子节点；同时兼容直接子节点为 `div` 或 `a` 的页面版本。
- 从单条引用卡片内提取来源、日期、标题、摘要和 URL。标题明显不完整时，默认访问文章页面并使用 `og:title`、`twitter:title` 或 `<title>` 补全，可用 `--resolve-titles=false` 关闭。
- 引用按钮缺失、列表未稳定或没有有效外部链接时最多检查 3 次，随后跳过当前题，不回退扫描整页。

输出目录：`results/deepseek/`

### 千问

- 提问前记录 `.link-title-igf0OC` 参考入口数量，只允许点击本题回答新增的最后一个入口。
- 如果首次回答结束后没有新参考入口，会通过 `reg_svg` 图标找到最新回答的重新生成控件，先点击其外层 `.flex.items-center.rounded` 打开菜单，再点击 `role="menuitem"`、文字严格为“重新生成”的长 class 菜单项。点击后 15 秒内检查生成是否启动；自动重新生成严格限制为一次。
- 点击入口后等待最后一个可见 `.list-XPxyL2`。列表达到入口标注的引用数并稳定，或其直接子节点与 URL 集合持续稳定后，才开始解析。
- 只遍历列表的直接子 `div`，优先从 `data-exposure-extra`、`data-click-extra` 读取标题、URL 和引用顺序，同时兼容卡片内的链接及数据属性。
- 重新生成后仍无入口、列表未稳定或解析为空时继续完成最多 3 次检查，随后跳过当前题。

输出目录：`results/qianwen/`

### 元宝

- 每道题开始前先关闭上一题的引用抽屉，再记录 `.ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b` 入口数量，用于区分历史入口和本题新增入口。
- 回答完成后只点击本轮新增的最新入口，并等待已打开抽屉中的 `.agent-dialogue-references__list` 出现。
- 持续检查列表直接子 `li` 的数量、标题和 URL；这些内容稳定后才进行提取，避免抽屉仍在加载时漏抓。
- 每个 `li` 作为一条引用解析，优先读取 `.hyc-common-markdown__ref_card[data-url]` 及卡片标题、来源、时间和摘要，随后清洗 URL、去重并保持页面顺序。
- 抓取结束后自动关闭引用抽屉；入口缺失、列表未稳定或结果为空时最多检查 3 次，随后跳过当前题，不读取历史抽屉内容。

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

平台子目录中的 JSON、CSV 均保持原有的扁平记录格式。生成汇总数据时，程序先把记录放入豆包、DeepSeek、千问、元宝各自的数据组，再在每个平台内按问题分组，最后合并四个平台中的相同问题。根目录的 `results/references.json` 因此按“问题 → 平台 → 引用记录”组织，平台内部不再重复保存 `question` 字段；四个平台键始终存在，没有结果时为 `[]`。根目录的 `results/references.csv` 继续使用便于表格处理的扁平格式。

### 清洗规则

1. 原始引用先按 `crawlPlatform` 放入四个平台数据组，平台独立文件保持原字段不变。
2. 每个平台内部再按 `question` 建立索引。
3. 按问题库顺序合并四个平台的同题数组；未采集到数据的平台保留空数组。
4. 平台内部记录移除已经由父节点表达的 `question`，其余字段和顺序保持不变。
5. URL 会解开常见中转参数、删除营销跟踪参数和锚点，再按规范化 URL 去重。
6. 平台自身链接、无效 URL、重复引用和引用容器之外的页面链接不会进入结果。

### 字段说明

| 字段 | 含义 |
| --- | --- |
| `question` | 本条引用对应的问题；汇总 JSON 中只出现在问题父节点 |
| `crawlPlatform` | 获取回答的平台：豆包、DeepSeek、千问或元宝 |
| `rank` | 该平台在当前问题下的引用顺序，从 1 开始 |
| `articlePlatform` | 引用文章所属媒体或站点，无法识别时使用域名 |
| `articleTime` | 卡片中抽取到的发布日期或相对时间，缺失时为空字符串 |
| `title` | 清洗后的文章标题 |
| `summary` | 引用卡片摘要，页面未提供时为空字符串 |
| `url` | 解跳转、去跟踪参数后的文章地址 |
| `extractedAt` | 抓取时间，使用 ISO 8601 UTC 字符串 |

汇总 JSON 示例：

```json
[
  {
    "question": "互联网行业内有哪些大品牌？",
    "platforms": {
      "豆包": [
        {
          "crawlPlatform": "豆包",
          "rank": 1,
          "articlePlatform": "文章来源",
          "articleTime": "文章时间",
          "title": "文章标题",
          "summary": "文章摘要",
          "url": "文章地址",
          "extractedAt": "抓取时间"
        }
      ],
      "DeepSeek": [],
      "千问": [],
      "元宝": []
    }
  }
]
```

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

### Windows PowerShell 禁止执行 npm.ps1

如果运行 `npm install` 时出现“在此系统上禁止运行脚本”，可为当前用户允许本地脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

确认后关闭并重新打开 PowerShell，再运行 `npm install`。如果电脑受公司或学校的组策略限制，无法修改执行策略，可在当前窗口让 `npm` 直接调用同目录下的 `npm.cmd`：

```powershell
Set-Alias npm npm.cmd
npm install
```

`npm.ps1` 和 `npm.cmd` 都是 npm 的 Windows 启动入口，不影响项目功能。

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

单题参考资料缺失不会中断整个平台：程序检查 3 次后会记录“跳过本题”并继续。如果任务真正中断，通常是登录失效、输入框不可用或等待回答完成超时。检查终端最后一条平台日志，修复登录、网络或页面结构问题后重新运行对应平台即可。

## 开发与验证

修改代码后先运行类型检查和完整测试：

```bash
npm run check
npm test
```

测试使用本机 Chrome 的无头模式构造平台 DOM 夹具，覆盖以下关键边界：

- 只抽取当前回答的直接引用子节点；
- 不把历史回答、正文或导航链接当作引用；
- 正确点击豆包最新回答的重新生成按钮、千问重新生成菜单、DeepSeek 最新“X个网页”和元宝最新来源入口；
- 一轮问题完成后正确点击“新建对话”并确认空白输入界面；
- URL 解跳转、跟踪参数清理、内部域名过滤与去重；
- 汇总数据按“平台 → 平台内问题 → 跨平台同题”三阶段清洗。

### 页面改版维护

平台 DOM class 可能随版本变化。页面上已有引用但程序报告入口或容器缺失时，按以下顺序排查：

1. 在 Chrome 开发者工具中确认最新回答的入口、列表和单条卡片结构。
2. 在 `src/platforms.ts` 中更新输入框、发送、新建对话、联网搜索或通用引用入口选择器。
3. 在 `src/extractReferences.ts` 中更新平台专属容器常量和浏览器上下文解析脚本。
4. 在 `tests/doubao-extraction.test.ts` 中增加对应 DOM 夹具，确保仍只读取最新容器的直接子节点。
5. 运行 `npm run check && npm test`，确认全部检查通过后再实际抓取。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 组织多平台任务并写入平台数据与汇总数据 |
| `src/cli.ts` | 解析命令行参数和外部问题文件 |
| `src/crawler.ts` | 连接页面、发送问题、等待回答和执行失败保护 |
| `src/extractReferences.ts` | 展开并解析各平台引用列表 |
| `src/platforms.ts` | 平台地址与页面选择器配置 |
| `src/questions.ts` | 默认问题列表 |
| `src/resolveTitles.ts` | DeepSeek 外部文章标题补全 |
| `src/text.ts` | 标题、来源、日期和 URL 的公共清洗规则 |
| `src/output.ts` | 平台分桶、问题分组以及 JSON、CSV 输出 |
| `src/types.ts` | CLI、平台配置、候选记录与输出记录类型 |
| `tests/doubao-extraction.test.ts` | 四个平台引用入口与结构化抽取回归测试 |
| `tests/output.test.ts` | 三阶段汇总分组测试 |
