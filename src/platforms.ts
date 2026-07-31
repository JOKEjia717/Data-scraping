/**
 * 四个平台的页面入口与交互选择器。
 *
 * 每组选项按“越具体越靠前、通用兜底越靠后”排列。平台改版时应优先补充
 * 稳定的 aria-label、title 或平台专属 class，避免扩大到会命中导航栏的选择器。
 */
import type { PlatformConfig, PlatformId } from "./types.js";

/** 各平台均优先使用语义属性定位新对话入口，文本选择器只作为页面改版兜底。 */
const COMMON_NEW_CONVERSATION_SELECTORS = [
  "button[aria-label*='新对话']",
  "button[aria-label*='新建对话']",
  "button[title*='新对话']",
  "button[title*='新建对话']",
  "[role='button'][aria-label*='新对话']",
  "[role='button'][aria-label*='新建对话']",
  "button:has-text('新对话')",
  "button:has-text('新建对话')",
  "[role='button']:has-text('新对话')",
  "[role='button']:has-text('新建对话')"
];

/** 平台 ID 到页面配置的唯一映射，crawler.ts 不直接硬编码输入框和按钮。 */
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
    newConversationButtonSelectors: [
      "[data-testid*='new-chat']",
      "[class*='new-chat']",
      ...COMMON_NEW_CONVERSATION_SELECTORS
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('搜索')",
      "[role='button']:has-text('联网搜索')",
      "[aria-label*='联网搜索']",
      "[title*='联网搜索']"
    ],
    referenceRevealSelectors: [
      "text=/参考\\s*\\d+\\s*篇资料/",
      "[role='button']:has-text('篇资料')",
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
    newConversationButtonSelectors: [
      "[data-testid*='new-chat']",
      "[class*='new-chat']",
      "button:has-text('开启新对话')",
      "[role='button']:has-text('开启新对话')",
      ...COMMON_NEW_CONVERSATION_SELECTORS
    ],
    webSearchButtonSelectors: [
      "button:has-text('联网搜索')",
      "button:has-text('Search')",
      "[role='button']:has-text('联网搜索')",
      "[aria-label*='联网搜索']",
      "[aria-label*='Search']"
    ],
    referenceRevealSelectors: [
      "[class~='f93f59e4']",
      "text=/^\\d+\\s*个网页$/",
      "text=/搜索\\s*\\d+\\s*(?:个网页|条结果|篇资料)/",
      "text=/已搜索\\s*\\d+/",
      "button:has-text('搜索结果')",
      "button:has-text('参考')",
      "button:has-text('来源')",
      "button:has-text('引用')",
      "button:has-text('Sources')",
      "[role='button']:has-text('搜索结果')",
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
      // 保留 Apple/macOS 页面原有的语义定位，同时兼容 Windows 当前的
      // 黑色圆形发送按钮。class 使用 token 匹配，不依赖完整 class 或排列顺序。
      "button[class~='bg-black-button'][class~='rounded-full'][class~='cursor-pointer'][class~='size-8']",
      "[role='button'][class~='bg-black-button'][class~='rounded-full'][class~='cursor-pointer'][class~='size-8']",
      "button[aria-label*='发送']",
      "button[title*='发送']",
      "button:has-text('发送')",
      "button[aria-label*='Send']",
      "button[title*='Send']",
      "button:has-text('Send')",
      "[role='button'][aria-label*='发送']",
      "[role='button'][title*='发送']"
    ],
    newConversationButtonSelectors: [
      "[data-testid*='new-chat']",
      "[class*='new-chat']",
      "[class*='new-conversation']",
      ...COMMON_NEW_CONVERSATION_SELECTORS
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
      "[class~='link-title-igf0OC']",
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
    newConversationButtonSelectors: [
      "[data-testid*='new-chat']",
      "[class*='new-chat']",
      "[class*='create-chat']",
      ...COMMON_NEW_CONVERSATION_SELECTORS
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
      ".ToolbarSearchGuid_searchGuidTool__M81L2.Toolbar_icon__xGP8b",
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
