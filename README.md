# 豆包 / DeepSeek / 千问 / 元宝参考来源爬虫

这个 TypeScript 程序会在豆包、DeepSeek、千问和元宝页面逐个提问，并导出回答中“参考列表/来源/引用”里的文章信息：

- 问题
- 爬取平台：豆包、DeepSeek、千问或元宝
- 文章平台
- 文章时间
- 文章标题
- 文章摘要
- 文章 URL

默认问题在 `src/questions.ts`，当前是 8 个围绕字节跳动、抖音及短视频社交平台的问题。

## 安装

```bash
npm install
```

不需要安装 Playwright 自带 Chromium。本程序默认连接你已经打开好的浏览器页面，不会自己启动浏览器。

## 前期准备

请先用远程调试端口启动 Chrome，然后你自己打开要爬的平台、完成登录，并停留在可提问页面。

macOS 示例：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-ai-crawler
```

然后在这个 Chrome 里手动打开：

```text
https://www.doubao.com/chat/
https://chat.deepseek.com/
https://www.qianwen.com/
https://yuanbao.tencent.com/chat/
```

千问也兼容 `https://chat.qwen.ai/`，打开其中一个并登录即可。

如果你已经用普通方式打开了 Chrome，通常需要重新用上面的命令启动一个带调试端口的 Chrome。脚本只能连接带调试端口的浏览器。

## 运行

```bash
npm run crawl
```

默认会依次跑豆包、DeepSeek、千问、元宝四个平台。脚本只会连接已有页面、输入问题、抽取参考列表，不会打开新页面、不会登录、不会关闭浏览器或标签页。

结果会输出到：

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

四个平台的数据分别保存在对应子目录中；根目录的两个 `references` 文件保留全部平台的汇总数据。抓取过程中每完成一道题都会同步更新对应平台文件，意外中断时也能保留已经获取的数据。

## 常用参数

只跑豆包：

```bash
npm run crawl:doubao
```

只跑 DeepSeek：

```bash
npm run crawl:deepseek
```

只跑千问：

```bash
npm run crawl:qianwen
```

只跑元宝：

```bash
npm run crawl:yuanbao
```

指定输出目录：

```bash
npm run crawl -- --out=results-2026-07-07
```

指定 CDP 地址，默认是 `http://127.0.0.1:9222`：

```bash
npm run crawl -- --cdp=http://127.0.0.1:9222
```

默认会在页面参考列表标题不可靠时，请求文章 URL 并解析 `og:title` / `<title>` 来修正文章标题。关闭标题补全：

```bash
npm run crawl:deepseek -- --resolve-titles=false
```

使用自己的问题文件，支持一行一个问题的 `.txt`，也支持字符串数组 `.json`：

```bash
npm run crawl -- --questions=questions.txt
```

如果平台默认不触发联网参考，可以给问题加前缀：

```bash
npm run crawl -- --prompt-prefix="请联网搜索，并在回答中保留参考来源。问题："
```

## 注意

豆包和 DeepSeek 采用通用或平台定制的 DOM 抽取。千问只遍历 `.list-XPxyL2` 容器的直接子组件；元宝先定位当前可见的 `.agent-dialogue-references__list` 主列表，再逐条读取主列表下的全部 `li`。两者都会将卡片拆分为来源平台、时间、标题、摘要和 URL，不会回退扫描整页链接。若平台 UI 发生较大变化，可以在 `src/platforms.ts` 或 `src/extractReferences.ts` 中更新选择器。
