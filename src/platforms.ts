import type { PlatformConfig, PlatformId } from "./types.js";

export const PLATFORMS: Record<PlatformId, PlatformConfig> = {
  doubao: {
    id: "doubao",
    name: "豆包",
    url: "https://www.doubao.com/chat/",
    inputSelectors: [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']"
    ],
    sendButtonSelectors: [
      "button[aria-label*='发送']",
      "button[title*='发送']",
      "button:has-text('发送')",
      "[role='button'][aria-label*='发送']"
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('搜索')",
      "[role='button']:has-text('联网搜索')",
      "[aria-label*='联网搜索']",
      "[title*='联网搜索']"
    ],
    referenceRevealSelectors: [
      "button:has-text('参考')",
      "button:has-text('参考来源')",
      "button:has-text('来源')",
      "button:has-text('引用')",
      "[role='button']:has-text('参考')",
      "[role='button']:has-text('来源')"
    ]
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    inputSelectors: [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']"
    ],
    sendButtonSelectors: [
      "button[aria-label*='发送']",
      "button[title*='发送']",
      "button:has-text('发送')",
      "button[aria-label*='Send']",
      "button[title*='Send']"
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('Search')",
      "[role='button']:has-text('联网搜索')",
      "[aria-label*='联网搜索']",
      "[aria-label*='Search']"
    ],
    referenceRevealSelectors: [
      "button:has-text('参考')",
      "button:has-text('来源')",
      "button:has-text('引用')",
      "button:has-text('Sources')",
      "[role='button']:has-text('参考')",
      "[role='button']:has-text('Sources')"
    ]
  },
  qianwen: {
    id: "qianwen",
    name: "千问",
    url: "https://www.qianwen.com/",
    hostnames: [
      "www.qianwen.com",
      "qianwen.com",
      "chat.qwen.ai",
      "qwen.ai",
      "tongyi.aliyun.com"
    ],
    inputSelectors: [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
      "input[type='text']"
    ],
    sendButtonSelectors: [
      "button[aria-label*='发送']",
      "button[title*='发送']",
      "button:has-text('发送')",
      "button[aria-label*='Send']",
      "button[title*='Send']",
      "button:has-text('Send')",
      "[role='button'][aria-label*='发送']",
      "[role='button'][title*='发送']"
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('搜索')",
      "button:has-text('全网搜索')",
      "button:has-text('联网')",
      "button:has-text('Web')",
      "button:has-text('Search')",
      "[role='button']:has-text('联网搜索')",
      "[role='button']:has-text('搜索')",
      "[aria-label*='联网搜索']",
      "[aria-label*='搜索']",
      "[aria-label*='Search']",
      "[title*='联网搜索']",
      "[title*='搜索']"
    ],
    referenceRevealSelectors: [
      "text=/参考来源\\s*\\(\\d+\\)/",
      "text=参考来源",
      "button:has-text('参考')",
      "button:has-text('参考来源')",
      "button:has-text('来源')",
      "button:has-text('引用')",
      "button:has-text('搜索结果')",
      "button:has-text('资料来源')",
      "button:has-text('Sources')",
      "[class*='source']:has-text('参考来源')",
      "[role='button']:has-text('参考')",
      "[role='button']:has-text('参考来源')",
      "[role='button']:has-text('来源')",
      "[role='button']:has-text('引用')",
      "[role='button']:has-text('搜索结果')",
      "[role='button']:has-text('Sources')",
      "span:has-text('参考来源')"
    ]
  },
  yuanbao: {
    id: "yuanbao",
    name: "元宝",
    url: "https://yuanbao.tencent.com/chat/",
    hostnames: [
      "yuanbao.tencent.com",
      "yuanbao.qq.com",
      "hunyuan.tencent.com"
    ],
    inputSelectors: [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
      "input[type='text']"
    ],
    sendButtonSelectors: [
      "button[aria-label*='发送']",
      "button[title*='发送']",
      "button:has-text('发送')",
      "button[aria-label*='Send']",
      "button[title*='Send']",
      "[role='button'][aria-label*='发送']",
      "[role='button'][title*='发送']"
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('搜索')",
      "button:has-text('深度搜索')",
      "button:has-text('全网搜索')",
      "button:has-text('联网')",
      "[role='button']:has-text('联网搜索')",
      "[role='button']:has-text('搜索')",
      "[aria-label*='联网搜索']",
      "[aria-label*='搜索']",
      "[title*='联网搜索']",
      "[title*='搜索']"
    ],
    referenceRevealSelectors: [
      "text=\"源\"",
      "span:text-is('源')",
      "div:text-is('源')",
      "text=/引用来源\\s*\\(\\d+\\)/",
      "text=引用来源",
      "button:has-text('源')",
      "button:has-text('引用来源')",
      "button:has-text('引用')",
      "button:has-text('来源')",
      "[role='button']:has-text('源')",
      "[role='button']:has-text('引用来源')",
      "[role='button']:has-text('引用')",
      "[role='button']:has-text('来源')",
      "[class*='references']:has-text('引用来源')",
      "span:has-text('引用来源')"
    ]
  }
};
