var vm = arguments[0];
/* =====================================================================
 * AI 爬取运营台 — Vue 前端（buildless，依赖本地 vendor/vue.global.prod.js）
 * 结构：左侧导航（总览 / 品牌诊断 / 数据监测 / 风格监测 / 研究爬取）
 *       板块视图 = 三栏看板（正在运行 / 待运行 / 已运行）
 * 后端 API 契约不变，本文件仅重写视图层与交互层。
 * ===================================================================== */

const { createApp } = vm;

/* ----------------------------- 常量 ----------------------------- */
const PLATFORM_NAMES = { doubao: "豆包", deepseek: "DeepSeek", qianwen: "千问", yuanbao: "元宝" };
const PLATFORM_COLORS = { doubao: "#0F6E56", deepseek: "#185FA5", qianwen: "#BA7517", yuanbao: "#A32D2D" };
const PLATFORM_ORDER = ["doubao", "deepseek", "qianwen", "yuanbao"];
const TASK_LINE_COLORS = ["#0F6E56", "#185FA5", "#BA7517", "#A32D2D", "#534AB7", "#0E8A6E", "#C2410C", "#7F77DD"];

const STATUS_BADGE = {
  0: ["b-gray", "待处理"],
  1: ["b-blue", "运行中"],
  2: ["b-green", "成功"],
  3: ["b-red", "失败"]
};
const HEALTH_BADGE = {
  READY: ["b-green", "就绪"], RUNNING: ["b-blue", "运行"],
  COOLING_DOWN: ["b-amber", "冷却"], RATE_LIMITED: ["b-amber", "限流"],
  CAPTCHA_REQUIRED: ["b-red", "需验证码"], LOGIN_REQUIRED: ["b-red", "需登录"],
  DOM_CHANGED: ["b-red", "DOM变更"], DISABLED: ["b-gray", "禁用"]
};

/* 三大板块：与数据库 business_type 映射。CONTENT_STYLE_MONITOR 为库内实际类型名（原 STYLE_MONITOR 已改名）。 */
const SECTIONS = [
  { key: "DIAGNOSIS", name: "品牌诊断", icon: "diagnosis" },
  { key: "ENTRY_MONITOR", name: "数据监测", icon: "monitor" },
  { key: "CONTENT_STYLE_MONITOR", name: "风格监测", icon: "style" }
];

const ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.7"/></svg>',
  diagnosis: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.7"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 12h4l2.5 6 4-13L16 12h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  style: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.3 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.9-4-6.7-9-6.7Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  research: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 3h6M10 3v6l-4.5 8a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9V3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.5 15h9" stroke="currentColor" stroke-width="1.6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 1 0-.6 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M20 5v6h-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 7v6M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none"><path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
};

/* 品牌归并映射：子产品/系列 → 母品牌（模块级常量，extractBrand 直接引用） */
const BRAND_PARENTS = {
  "阿里云": "阿里巴巴", "阿里云对象存储OSS": "阿里巴巴",
  "蔚来ET5": "蔚来",
  "惠普战66六代锐龙版": "惠普", "惠普战66": "惠普",
  "瑞幸冰美式": "瑞幸", "瑞幸咖啡": "瑞幸",
  "维达超韧抽纸": "维达", "维达超韧": "维达",
  "Mac": "苹果",
  "牛油火锅": "海底捞",
  "潘帕斯蓝生酪茉莉拿铁": "瑞幸",
};

/* ----------------------------- 工具函数 ----------------------------- */
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = n => String(n).padStart(2, "0");
  return d.getMonth() + 1 + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function fmtDur(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec + "秒";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + "分" + s + "秒";
}
function trunc(str, n) {
  str = String(str == null ? "" : str);
  return str.length > n ? str.slice(0, n) + "…" : str;
}
function businessLabel(bt) {
  if (bt === "DIAGNOSIS") return "品牌诊断";
  if (bt === "ENTRY_MONITOR") return "数据监测";
  if (bt === "CONTENT_STYLE_MONITOR" || bt === "STYLE_MONITOR") return "风格监测";
  return bt || "";
}

/* ----------------------------- 小组件 ----------------------------- */
const StatusBadge = {
  props: { s: { type: [Number, String], required: true } },
  computed: {
    info() { return STATUS_BADGE[this.s] || ["b-gray", String(this.s)]; }
  },
  template: '<span class="badge" :class="info[0]">{{ info[1] }}</span>'
};

const HealthBadge = {
  props: { h: { type: String, default: "" } },
  computed: {
    info() { return HEALTH_BADGE[this.h] || ["b-gray", this.h || "未知"]; }
  },
  template: '<span class="badge" :class="info[0]">{{ info[1] }}</span>'
};

/* 实时趋势 sparkline（手写 SVG，无外部图表库） */
const Sparkline = {
  props: {
    series: { type: Array, default: () => [] },
    width: { type: Number, default: 320 },
    height: { type: Number, default: 96 }
  },
  computed: {
    view() {
      const W = this.width, H = this.height, pad = 6;
      const innerW = W - pad * 2, innerH = H - pad * 2;
      const all = this.series.flatMap(s => s.points);
      const max = Math.max(1, ...all);
      const len = Math.max(1, ...this.series.map(s => s.points.length));
      const paths = this.series.map(s => {
        if (!s.points.length) return { d: "", area: "" };
        const offset = len - s.points.length;
        const step = len > 1 ? innerW / (len - 1) : 0;
        const pts = s.points.map((v, i) => {
          const x = pad + (offset + i) * step;
          const y = pad + innerH - (v / max) * innerH;
          return [x, y];
        });
        const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
        const area = d + " L " + (pad + innerW).toFixed(1) + " " + (pad + innerH).toFixed(1) +
                     " L " + pad + " " + (pad + innerH).toFixed(1) + " Z";
        return { d, area };
      });
      return { W, H, paths };
    }
  },
  template:
    '<svg :viewBox="\'0 0 \' + view.W + \' \' + view.H" :width="view.W" :height="view.H" ' +
    'preserveAspectRatio="none" class="spark">' +
    '<g v-for="(s, si) in series" :key="si">' +
    '<path :d="view.paths[si].area" :fill="s.color" fill-opacity="0.10" stroke="none"/>' +
    '<path :d="view.paths[si].d" fill="none" :stroke="s.color" stroke-width="1.6" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>' +
    "</g></svg>"
};

/* ----------------------------- 根组件 ----------------------------- */
const App = {
  data() {
    return {
      overview: null,
      sectionsData: null,           // /api/rpa/sections
      researchAnswers: null,
      researchFiles: null,
      refsResearch: null,
      refsRpa: null,
      activeNav: "overview",         // overview | DIAGNOSIS | ENTRY_MONITOR | STYLE_MONITOR | research
      intervalMs: 120000,            // 默认 2 分钟刷新
      connected: true,
      lastUpdated: "",
      nowTs: Date.now(),
      sidebarOpen: false,           // 移动端抽屉开合
      firstLoad: true,              // 首屏加载骨架屏
      selectedTab: 1,               // 板块看板当前选中的 Tab：1=运行中 0=待运行 2=已运行 3=失败
      notifOpen: false,              // 通知面板开合
      refsSearch: "",
      refsPlat: "",
      sectionTasks: {},              // { businessType: { 1:[], 0:[], 2:[] } }
      trendByTask: {},               // executionId -> [elapsedSeconds...]
      doneOpen: {},                  // executionId -> true
      doneDetail: {},               // executionId -> { answer, refCount, refs }
      brandCollapse: { __default__: true }  // 默认第一个品牌展开（isBrandOpen 中按 brank 未交互判定）
    };
  },

  computed: {
    navItems() {
      return [
        { key: "overview", name: "运行总览", icon: "overview" },
        ...SECTIONS,
        { key: "research", name: "研究爬取", icon: "research" }
      ];
    },
    isSection() { return SECTIONS.some(s => s.key === this.activeNav); },
    currentTitle() {
      if (this.activeNav === "overview") return "运行总览";
      if (this.activeNav === "research") return "研究爬取";
      const s = SECTIONS.find(x => x.key === this.activeNav);
      return s ? s.name : "运营台";
    },
    sec() {
      return (this.sectionsData && this.sectionsData.sections && this.sectionsData.sections[this.activeNav]) || null;
    },
    runningList() { return this.colTasks(1); },
    pendingList() { return this.colTasks(0); },
    doneList() { return this.colTasks(2); },

    alerts() {
      const ov = this.overview;
      if (!ov) return [];
      const items = [];
      const metrics = ov.metrics || {};
      const seen = {};
      for (const wt of ["diagnosis", "monitor"]) {
        const m = metrics[wt];
        if (!m || !m.platforms) continue;
        for (const p of m.platforms) {
          const h = p.healthStatus;
          if (h && h !== "READY" && h !== "RUNNING") {
            const key = p.platform + h;
            if (!seen[key]) {
              seen[key] = true;
              const cls = (h === "CAPTCHA_REQUIRED" || h === "LOGIN_REQUIRED" || h === "DOM_CHANGED") ? "red" : "amber";
              items.push({ cls, text: (PLATFORM_NAMES[p.platform] || p.platform) + " 平台状态异常：" + h + "（" + wt + "）" });
            }
          }
        }
        if (m.outboxPending > 0) {
          items.push({ cls: "amber", text: "Outbox 待回放结果堆积 " + m.outboxPending + " 条（" + wt + "），数据库可能断线" });
        }
      }
      const rpa = ov.rpa;
      if (rpa && rpa.enabled && rpa.totals) {
        const t = rpa.totals;
        if (t.processing > 0) items.push({ cls: "info", text: "RPA 当前有 " + t.processing + " 个任务正在执行" });
        if (t.finalFailed > 0) items.push({ cls: "red", text: "RPA 有 " + t.finalFailed + " 个最终失败任务需排查" });
      }
      return items;
    },
    /* 通知角标数字 */
    notifCount() {
      return this.alerts.length;
    },
    /* 按严重程度分组的告警 */
    notifBySeverity() {
      const red = [], amber = [], info = [];
      for (const a of this.alerts) {
        if (a.cls === "red") red.push(a);
        else if (a.cls === "amber") amber.push(a);
        else info.push(a);
      }
      return { red, amber, info };
    },

    kpis() {
      const rpa = this.overview && this.overview.rpa;
      if (!rpa || !rpa.enabled || !rpa.totals) return [];
      const t = rpa.totals;
      return [
        { label: "运行中", num: t.processing, color: "var(--info-text)" },
        { label: "待处理", num: t.pending, color: "var(--warning-text)" },
        { label: "累计成功", num: t.succeeded, color: "var(--accent-text)" },
        { label: "最终失败", num: t.finalFailed, color: "var(--danger-text)" }
      ];
    },
    rpaByPlatform() { return (this.overview && this.overview.rpa && this.overview.rpa.byPlatform) || {}; },
    /* 总览用：按板块→平台两级分组。数据源 rpaByPlatform[pf].business[sectionKey] */
    rpaBySection() {
      const bp = this.rpaByPlatform;
      const out = {};
      for (const sec of SECTIONS) {
        const platforms = {};
        for (const pf of PLATFORM_ORDER) {
          const entry = bp[pf];
          if (!entry) continue;
          const biz = entry.business && entry.business[sec.key];
          platforms[pf] = biz || { pending: 0, processing: 0, succeeded: 0, finalFailed: 0 };
        }
        out[sec.key] = { name: sec.name, icon: sec.icon, platforms };
      }
      return out;
    },
    platformHealth() {
      const map = {};
      const metrics = (this.overview && this.overview.metrics) || {};
      for (const wt of ["diagnosis", "monitor"]) {
        const m = metrics[wt];
        if (!m || !m.platforms) continue;
        for (const p of m.platforms) map[p.platform] = p.healthStatus;
      }
      return map;
    },
    researchEnabled() {
      const r = this.overview && this.overview.research;
      return !!(r && r.enabled && !r.unavailable);
    },
    researchStates() { return (this.overview && this.overview.research && this.overview.research.states) || {}; },
    researchByPlatform() { return (this.overview && this.overview.research && this.overview.research.byPlatform) || {}; },
    recentRuns() { return (this.overview && this.overview.research && this.overview.research.runs) || []; },

    trendSeries() {
      return this.runningList.map((t, i) => ({
        label: t.keyword || ("#" + t.executionId),
        color: TASK_LINE_COLORS[i % TASK_LINE_COLORS.length],
        points: (this.trendByTask[t.executionId] || []).slice()
      }));
    },

    /* 研究区：合并 answers（DB 或文件） */
    combinedAnswers() {
      const out = [];
      const res = this.researchAnswers;
      const useDb = res && res.enabled && res.rows && res.rows.length;
      if (useDb) {
        for (const a of res.rows) out.push({ source: "research", id: a.taskId, kw: a.question, refCount: a.referenceCount, time: a.extractedAt, content: a.content, pf: a.platformName || a.platformCode });
      } else {
        const rf = this.researchFiles;
        if (rf && rf.available && rf.answers) {
          for (const a of rf.answers) out.push({ source: "research", id: a.question + "::" + a.platformCode, kw: a.question, refCount: a.referenceCount, time: a.extractedAt, content: a.answer, pf: a.platformName || a.platformCode });
        }
      }
      out.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
      return out;
    },
    mergedRefs() {
      const out = [];
      const db = (this.refsResearch && this.refsResearch.enabled && this.refsResearch.rows) || [];
      const file = (this.researchFiles && this.researchFiles.available && this.researchFiles.references) || [];
      const rpa = (this.refsRpa && this.refsRpa.rows) || [];
      for (const r of db) out.push(Object.assign({}, r, { src: "研究" }));
      for (const r of file) out.push(Object.assign({}, r, { src: "研究" }));
      for (const r of rpa) out.push(Object.assign({}, r, { src: "RPA", title: r.title, articlePlatform: r.articlePlatform, url: r.url, rank: r.rank }));
      return out;
    },
    filteredRefs() {
      let f = this.mergedRefs;
      const q = this.refsSearch.trim().toLowerCase();
      const pf = this.refsPlat;
      if (pf) f = f.filter(r => (r.platformCode || "") === pf);
      if (q) f = f.filter(r =>
        (r.title || "").toLowerCase().includes(q) ||
        (r.articlePlatform || "").toLowerCase().includes(q) ||
        (r.url || "").toLowerCase().includes(q) ||
        (r.question || "").toLowerCase().includes(q) ||
        (r.keyword || "").toLowerCase().includes(q)
      );
      return f;
    },
    /* 当前 Tab 对应的任务列表（computed：模板 v-for 需要值，不能是 method 函数引用） */
    tabTasks() {
      return this.colTasks(this.selectedTab);
    },
    /* 按 品牌 → 平台 分组（computed：同上） */
    groupedByPlatform() {
      const groups = {};  // { 品牌: { 平台: [task, ...] } }
      for (const t of (this.tabTasks || [])) {
        if (!t || !t.executionId) continue;
        const pf = t.platform || "unknown";
        const rawBrand =
          (t.brandName && String(t.brandName).trim()) ||
          this.extractBrand(t.keyword) ||
          "其他";
        const brand = BRAND_PARENTS[rawBrand] || rawBrand;
        if (!groups[brand]) groups[brand] = {};
        if (!groups[brand][pf]) groups[brand][pf] = [];
        groups[brand][pf].push(t);
      }
      // 品牌按任务数降序 + 名称升序
      const brandOrder = Object.entries(groups)
        .sort((a, b) => {
          const ca = Object.values(a[1]).flat().length;
          const cb = Object.values(b[1]).flat().length;
          if (cb !== ca) return cb - ca;
          return a[0].localeCompare(b[0], "zh");
        });
      const ordered = {};
      for (const [brand, platforms] of brandOrder) {
        const inner = {};
        for (const pf of PLATFORM_ORDER) {
          if (platforms[pf]) inner[pf] = platforms[pf];
        }
        for (const pf in platforms) { if (!inner[pf]) inner[pf] = platforms[pf]; }
        ordered[brand] = inner;
      }
      return ordered;
    },
    /* 品牌组列表（附加工行业/产品/平台计数的展示元数据） */
    brandGroupList() {
      const groups = this.groupedByPlatform;
      const out = [];
      for (const [brand, platforms] of Object.entries(groups)) {
        const allTasks = Object.values(platforms).flat();
        const sample = allTasks.find(t => t && t.brandIndustry) || allTasks[0];
        const platformChips = [];
        for (const pf of PLATFORM_ORDER) {
          if (platforms[pf] && platforms[pf].length) platformChips.push({ pf, count: platforms[pf].length });
        }
        out.push({
          brand,
          platforms,
          total: allTasks.length,
          industry: (sample && sample.brandIndustry) || "",
          product: (sample && sample.brandProduct) || "",
          platformChips
        });
      }
      return out;
    },
    /* Tab 配置（computed：模板 v-for 需要数组值） */
    tabConfig() {
      return [
        { key: 1, label: "正在运行", cls: "running", icon: "●" },
        { key: 0, label: "待运行", cls: "pending", icon: "●" },
        { key: 2, label: "已运行", cls: "done", icon: "●" },
        { key: 3, label: "失败", cls: "failed", icon: "●" }
      ];
    }
  },

  watch: {
    intervalMs() { this.startTimer(); },
    activeNav() { this.poll(); }
  },

  methods: {
    iconFor(cls) {
      if (cls === "red") return ICONS.alert;
      if (cls === "amber") return ICONS.warn;
      if (cls === "info") return ICONS.info;
      return ICONS.ok;
    },
    navBadge(item) {
      if (item.key === "overview") {
        const s = this.sectionsData && this.sectionsData.sections;
        if (!s) return "";
        let total = 0;
        for (const k in s) total += (s[k].processing || 0);
        return total > 0 ? String(total) : "";
      }
      const sec = this.sectionsData && this.sectionsData.sections && this.sectionsData.sections[item.key];
      if (sec && sec.processing > 0) return String(sec.processing);
      return "";
    },
    colTasks(status) {
      const st = this.sectionTasks[this.activeNav];
      return (st && st[status]) || [];
    },

    async getJSON(url) {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    },

    async poll(){}
    },

    async loadSection(bt) {
      const [running, pending, done, failed] = await Promise.all([
        this.getJSON("/api/rpa/tasks?businessType=" + encodeURIComponent(bt) + "&state=1&limit=50"),
        this.getJSON("/api/rpa/tasks?businessType=" + encodeURIComponent(bt) + "&state=0&limit=100"),
        this.getJSON("/api/rpa/tasks?businessType=" + encodeURIComponent(bt) + "&state=2&limit=120"),
        this.getJSON("/api/rpa/tasks?businessType=" + encodeURIComponent(bt) + "&state=3&limit=50").catch(() => ({ rows: [] }))
      ]);
      this.sectionTasks[bt] = {
        1: running.rows || [],
        0: pending.rows || [],
        2: done.rows || [],
        3: failed.rows || []
      };
      this.cleanTrend();
    },

    async loadResearch() {
      const [ra, rr, rp, rf] = await Promise.all([
        this.getJSON("/api/research/answers?limit=60").catch(() => ({ enabled: false, rows: [] })),
        this.getJSON("/api/research/references?limit=1000").catch(() => ({ enabled: false, rows: [] })),
        this.getJSON("/api/rpa/references?limit=1000"),
        this.getJSON("/api/research/files")
      ]);
      this.researchAnswers = ra;
      this.refsResearch = rr;
      this.refsRpa = rp;
      this.researchFiles = rf;
    },

    setNav(key) { this.activeNav = key; this.sidebarOpen = false; },
    toggleSidebar() { this.sidebarOpen = !this.sidebarOpen; },
    closeSidebar() { this.sidebarOpen = false; },
    toggleNotif() { this.notifOpen = !this.notifOpen; },
    closeNotif() { this.notifOpen = false; },

    startTimer() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    },

    /* 每 3s 跳动：推进耗时显示 + 给所有已加载板块中的运行中任务追加趋势采样点 */
    startTick() {
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => {
        this.nowTs = Date.now();
        for (const bt in this.sectionTasks) {
          for (const t of (this.sectionTasks[bt][1] || [])) {
            const arr = this.trendByTask[t.executionId] || (this.trendByTask[t.executionId] = []);
            arr.push(Math.round(this.elapsedSec(t)));
            if (arr.length > 40) arr.shift();
          }
        }
      }, 3000);
    },

    cleanTrend() {
      const ids = new Set();
      for (const bt in this.sectionTasks) {
        for (const t of (this.sectionTasks[bt][1] || [])) ids.add(t.executionId);
      }
      for (const k of Object.keys(this.trendByTask)) {
        if (!ids.has(k)) delete this.trendByTask[k];
      }
    },

    elapsedSec(t) {
      const base = t.startTime ? new Date(t.startTime) : new Date(t.modifyTime || t.createdAt || Date.now());
      return Math.max(0, (this.nowTs - base.getTime()) / 1000);
    },
    elapsed(t) { return this.elapsedSec(t); },

    taskClass(t) {
      if (!t || (t.status | 0) !== 1) return "";
      if (this.isStale(t)) return "stale";
      return "running";
    },
    isStale(t) {
      if (!t || (t.status | 0) !== 1 || !t.modifyTime) return false;
      return (this.nowTs - new Date(t.modifyTime).getTime()) > 5 * 60000;
    },

    /* 品牌头部展示元数据：hash 选色、首字母 monogram、未交互态默认首项展开、关键词去前缀 */
    brandColor(brand) {
      let h = 0;
      const s = String(brand || "");
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      // 偏向工业风冷调色 + 微软 Four Color：azure 蓝 / info 青 / done 绿 / wait 琥珀 / fail 红 / ink 深 / 二档色（玫瑰/紫）
      const palette = [
        "oklch(0.54 0.13 252)",  // azure 蓝
        "oklch(0.52 0.12 285)",  // 紫
        "oklch(0.50 0.12 152)",  // done 绿
        "oklch(0.58 0.13 36)",   // 砖红
        "oklch(0.46 0.04 262)",  // ink 深
        "oklch(0.54 0.10 195)",  // 青
        "oklch(0.55 0.13 340)",  // 玫红
        "oklch(0.55 0.13 72)"    // 琥珀
      ];
      return palette[Math.abs(h) % palette.length];
    },
    brandChar(brand) {
      const s = String(brand || "?");
      return s.trim().slice(0, 1) || "?";
    },
    isBrandOpen(brand) {
      if (Object.prototype.hasOwnProperty.call(this.brandCollapse, brand)) return !!this.brandCollapse[brand];
      // 用户尚未与任何品牌交互时，默认展开第一个品牌（避免页面显得太空）
      const brands = Object.keys(this.groupedByPlatform);
      return brands.length > 0 && brands[0] === brand && Object.keys(this.brandCollapse).length <= 1;
    },
    kwTail(keyword, brand) {
      // 去掉关键词开头的品牌名（"阿里巴巴在云存储领域中…" → "在云存储领域中…"），让卡片首屏信息更密度
      if (!keyword) return "";
      const k = String(keyword);
      const b = String(brand || "").trim();
      if (b && k.startsWith(b)) {
        const rest = k.slice(b.length).replace(/^[，,：:。\s]+/, "");
        return rest || k;
      }
      return k;
    },
    toggleBrand(brand) {
      this.brandCollapse[brand] = !this.isBrandOpen(brand);
      // 用户开始与品牌组交互后，删除占位 __default__，让 isBrandOpen 走明确分支
      if ("__default__" in this.brandCollapse) delete this.brandCollapse.__default__;
    },

    async toggleDone(t) {
      const key = t.executionId;
      if (this.doneOpen[key]) { delete this.doneOpen[key]; return; }
      this.doneOpen[key] = true;
      if (this.doneDetail[key]) return;
      try {
        const [a, r] = await Promise.all([
          this.getJSON("/api/rpa/answers?executionId=" + encodeURIComponent(key)),
          this.getJSON("/api/rpa/references?executionId=" + encodeURIComponent(key))
        ]);
        const ans = a.rows && a.rows[0];
        this.doneDetail[key] = {
          answer: ans ? ans.content : null,
          refCount: ans ? ans.referenceCount : 0,
          refs: r.rows || []
        };
      } catch (e) {
        this.doneDetail[key] = { answer: null, refCount: 0, refs: [], err: e.message };
      }
    },

    toggleTheme() {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("dashboard-theme", next); } catch (e) {}
    },

    refTitle(r) { return r.title || r.summary || "(无标题)"; },
    /* 从关键词提取品牌名 + 归并子产品到母品牌（引用模块级 BRAND_PARENTS） */
    extractBrand(kw) {
      if (!kw) return "其他";
      let m = kw.match(/^([^，,（(]{2,20})在/);
      let raw = m ? m[1].trim() : null;
      if (!raw) {
        m = kw.match(/中[，,]\s*([^，,（)的的有]{2,20})/);
        if (m) {
          const b = m[1].trim().split(/[的有]/)[0].trim();
          if (b.length >= 2 && !/哪些|什么|如何|怎么|值得|推荐|哪个/.test(b)) raw = b;
        }
      }
      if (!raw) return "其他";
      // 精确归并
      const parent = BRAND_PARENTS[raw];
      if (parent) return parent;
      // 模糊归并：子品牌包含已知母品牌词根
      for (const [, p] of Object.entries(BRAND_PARENTS)) {
        if (raw !== p && raw.includes(p) && raw.length > p.length) return p;
      }
      return raw;
    }
  },

  mounted() {
    this.poll();
    this.startTimer();
    this.startTick();
  },

  beforeUnmount() {
    if (this.timer) clearInterval(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  },

  template: [
    '<div class="app-shell">',
    '  <!-- 侧边导航 -->',
    '  <aside class="sidebar" :class="{ open: sidebarOpen }">',
    '    <div class="brand">',
    '      <span class="brand-logo">AI</span>',
    '      <div class="brand-text"><strong>爬取运营台</strong><span>AI Reference Crawler</span></div>',
    '    </div>',
    '    <nav class="nav" aria-label="主导航">',
    '      <button v-for="item in navItems" :key="item.key" :class="[\'nav-item\', { active: activeNav === item.key }]" @click="setNav(item.key)" :title="item.name">',
    '        <span class="nav-ico" v-html="ICONS[item.icon]"></span>',
    '        <span class="nav-label">{{ item.name }}</span>',
    '        <span class="nav-badge" v-if="navBadge(item)">{{ navBadge(item) }}</span>',
    '      </button>',
    '    </nav>',
    '    <div class="sidebar-foot">',
    '      <span class="conn"><span class="dot" :class="connected ? \'ok\' : \'bad\'"></span>{{ connected ? "已连接" : "断开" }}</span>',
    '      <button class="icon-btn" @click="toggleTheme" title="切换深浅色" aria-label="切换主题">',
    '        <svg class="icon-moon" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    '        <svg class="icon-sun" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.5v2.5M12 19v2.5M4.5 12H2M22 12h-2.5M5.2 5.2 6.9 6.9M17.1 17.1l1.7 1.7M18.8 5.2 17.1 6.9M6.9 17.1 5.2 18.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    '      </button>',
    '    </div>',
    '  </aside>',

    '  <!-- 主区 -->',
    '  <div class="main">',
    '    <header class="topbar">',
    '      <button class="hamburger" @click="toggleSidebar" :aria-expanded="sidebarOpen" aria-label="打开导航菜单" v-html="ICONS.menu"></button>',
    '      <div class="topbar-title">',
    '        <h1>{{ currentTitle }}</h1>',
    '      </div>',
    '      <div class="topbar-actions">',
    '        <!-- 通知铃铛 -->',
    '        <div class="notif-wrap" v-if="!firstLoad">',
    '          <button class="notif-bell" @click="toggleNotif" :aria-expanded="notifOpen" aria-label="通知中心" title="通知中心">',
    '            <span class="bell-ico" v-html="ICONS.bell"></span>',
    '            <span v-if="notifCount" class="notif-badge">{{ notifCount > 99 ? "99+" : notifCount }}</span>',
    '          </button>',
    '          <!-- 通知下拉面板 -->',
    '          <div class="notif-panel" v-if="notifOpen" @click.stop>',
    '            <div class="notif-head"><strong>通知中心</strong><span class="notif-total">{{ notifCount }} 条通知</span></div>',
    '            <div class="notif-body">',
    '              <template v-if="notifBySeverity.red.length">',
    '                <div class="notif-group-label red">异常 {{ notifBySeverity.red.length }}</div>',
    '                <div v-for="(a, i) in notifBySeverity.red" :key="\'r\'+i" class="notif-item red"><span class="alert-ico" v-html="iconFor(a.cls)"></span>{{ a.text }}</div>',
    '              </template>',
    '              <template v-if="notifBySeverity.amber.length">',
    '                <div class="notif-group-label amber">警告 {{ notifBySeverity.amber.length }}</div>',
    '                <div v-for="(a, i) in notifBySeverity.amber" :key="\'a\'+i" class="notif-item amber"><span class="alert-ico" v-html="iconFor(a.cls)"></span>{{ a.text }}</div>',
    '              </template>',
    '              <template v-if="notifBySeverity.info.length">',
    '                <div class="notif-group-label info">信息 {{ notifBySeverity.info.length }}</div>',
    '                <div v-for="(a, i) in notifBySeverity.info" :key="\'i\'+i" class="notif-item info"><span class="alert-ico" v-html="iconFor(a.cls)"></span>{{ a.text }}</div>',
    '              </template>',
    '              <div v-if="!alerts.length" class="notif-empty">暂无通知</div>',
    '            </div>',
    '          </div>',
    '        </div>',
    '        <span class="updated">{{ lastUpdated }}</span>',
    '        <select v-model.number="intervalMs" title="刷新间隔" aria-label="刷新间隔">',
    '          <option value="15000">15 秒</option>',
    '          <option value="30000">30 秒</option>',
    '          <option value="60000">1 分钟</option>',
    '          <option value="120000" selected>2 分钟</option>',
    '          <option value="300000">5 分钟</option>',
    '        </select>',
    '        <button class="btn" @click="poll" title="立即刷新">刷新</button>',
    '      </div>',
    '    </header>',

    '    <div class="content">',
    '      <!-- 首屏加载骨架屏 -->',
    '      <div v-if="firstLoad" class="loading-state">',
    '        <div class="skeleton sk-kpi"></div>',
    '        <div class="sk-grid">',
    '          <div class="skeleton sk-card" v-for="n in 6" :key="n"></div>',
    '        </div>',
    '      </div>',
    '      <!-- 断连错误态 -->',
    '      <div v-else-if="!connected" class="alert red"><span class="alert-ico" v-html="ICONS.alert"></span><span>无法连接后端服务，请确认 dashboard 服务是否在运行（默认 http://127.0.0.1:8787）。</span></div>',

    '      <!-- 总览 -->',
    '      <section v-if="activeNav === \'overview\'">',
    '        <div class="kpi-grid" v-if="kpis.length">',
    '          <div class="kpi" v-for="k in kpis" :key="k.label">',
    '            <div class="label">{{ k.label }}</div>',
    '            <div class="num" :style="{ color: k.color }">{{ k.num }}</div>',
    '          </div>',
    '        </div>',
    '        <template v-if="overview && overview.rpa && overview.rpa.enabled">',
    '          <div v-for="(sec, secKey) in rpaBySection" :key="secKey" class="section-group">',
    '            <div class="section-title"><span class="st-ico" v-html="ICONS[sec.icon]"></span>{{ sec.name }}<span class="st-sub">RPA 任务状态（按平台）</span></div>',
    '            <div class="grid">',
    '              <div class="card" v-for="pf in PLATFORM_ORDER" :key="pf">',
    '                <h3><span class="pf-dot" :style="{ background: PLATFORM_COLORS[pf] }"></span>{{ PLATFORM_NAMES[pf] }}<health-badge v-if="platformHealth[pf]" :h="platformHealth[pf]"></health-badge></h3>',
    '                <div class="stat-row"><span class="k">待处理</span><span class="v">{{ (sec.platforms[pf] || {}).pending || 0 }}</span></div>',
    '                <div class="stat-row"><span class="k">运行中</span><span class="v">{{ (sec.platforms[pf] || {}).processing || 0 }}</span></div>',
    '                <div class="stat-row"><span class="k">成功</span><span class="v" style="color:var(--success-text)">{{ (sec.platforms[pf] || {}).succeeded || 0 }}</span></div>',
    '                <div class="stat-row"><span class="k">最终失败</span><span class="v" style="color:var(--danger-text)">{{ (sec.platforms[pf] || {}).finalFailed || 0 }}</span></div>',
    '              </div>',
    '            </div>',
    '          </div>',
    '        </template>',
    '        <div v-else class="empty">未配置 RPA 数据库</div>',
    '        <template v-if="researchEnabled">',
    '          <div class="section-title">研究爬取状态</div>',
    '          <div class="grid">',
    '            <div class="card" v-for="pf in PLATFORM_ORDER" :key="pf">',
    '              <h3><span class="pf-dot" :style="{ background: PLATFORM_COLORS[pf] }"></span>{{ PLATFORM_NAMES[pf] }}</h3>',
    '              <div class="stat-row" v-for="st in [[\'待处理\', researchByPlatform[pf] && researchByPlatform[pf].pending], [\'运行中\', researchByPlatform[pf] && researchByPlatform[pf].running], [\'完成\', researchByPlatform[pf] && researchByPlatform[pf].completed], [\'失败\', researchByPlatform[pf] && researchByPlatform[pf].failed], [\'跳过\', researchByPlatform[pf] && researchByPlatform[pf].skipped]]" :key="st[0]">',
    '                <span class="k">{{ st[0] }}</span><span class="v">{{ st[1] || 0 }}</span>',
    '              </div>',
    '            </div>',
    '          </div>',
    '        </template>',
    '        <div v-else-if="overview && overview.research && overview.research.unavailable" class="empty">研究表未入库（{{ overview.research.reason }}），已改为从 results/ 文件读取结果</div>',
    '        <div v-else class="empty">未配置主数据库</div>',
    '      </section>',

    '      <!-- 板块看板 -->',
    '      <section v-else-if="isSection">',
    '        <!-- 可点击分栏 Tab -->',
    '        <div class="tab-bar">',
    '          <button v-for="tab in tabConfig" :key="tab.key"',
    '            :class="[\'tab-pill\', tab.cls, { active: selectedTab === tab.key }]"',
    '            @click="selectedTab = tab.key">',
    '            <span class="pdot"></span>{{ tab.label }}',
    '            <span class="tab-cnt">{{ tab.key === 1 ? (sec ? sec.processing : runningList.length) : tab.key === 0 ? (sec ? sec.pending : pendingList.length) : tab.key === 2 ? (sec ? sec.succeeded : doneList.length) : (sec ? sec.finalFailed : 0) }}</span>',
    '          </button>',
    '        </div>',

    '        <!-- 正在运行：保留趋势图 + 运行中任务列表 -->',
    '        <div v-if="selectedTab === 1" class="tab-content">',
    '          <div class="trend-wrap" v-if="runningList.length">',
    '            <div class="trend-cap">实时耗时趋势</div>',
    '            <sparkline :series="trendSeries" :width="320" :height="96"></sparkline>',
    '            <div class="legend">',
    '              <div class="legend-item" v-for="(s, si) in trendSeries" :key="si">',
    '                <span class="lg-dot" :style="{ background: s.color }"></span>',
    '                <span class="lg-label" :title="s.label">{{ trunc(s.label, 18) }}</span>',
    '                <span class="lg-val">{{ fmtDur(s.points[s.points.length - 1] || 0) }}</span>',
    '              </div>',
    '            </div>',
    '          </div>',
    '          <div v-if="!runningList.length" class="col-empty">无运行中的任务</div>',
    '        </div>',

    '        <!-- 按 品牌→平台→问题 分组展示（新版：品牌卡片头部 + 平滑展开）-->',
    '        <div class="grouped-list" v-if="brandGroupList.length">',
    '          <article v-for="g in brandGroupList" :key="g.brand" class="brand-card">',
    '            <header class="bc-head" @click="toggleBrand(g.brand)" role="button" :aria-expanded="isBrandOpen(g.brand)">',
    '              <div class="bc-monogram" :style="{ background: brandColor(g.brand) }" aria-hidden="true">{{ brandChar(g.brand) }}</div>',
    '              <div class="bc-mid">',
    '                <div class="bc-brand-row">',
    '                  <span class="bc-brand-name">{{ g.brand }}</span>',
    '                  <span v-if="g.industry" class="bc-industry">{{ g.industry }}</span>',
    '                </div>',
    '                <div v-if="g.product" class="bc-product" :title="g.product">主产品：{{ g.product }}</div>',
    '                <div class="bc-platforms">',
    '                  <span v-for="c in g.platformChips" :key="c.pf" class="bc-pf">',
    '                    <span class="bc-pf-dot" :style="{ background: PLATFORM_COLORS[c.pf] }"></span>',
    '                    <span class="bc-pf-name">{{ PLATFORM_NAMES[c.pf] }}</span>',
    '                    <span class="bc-pf-count">{{ c.count }}</span>',
    '                  </span>',
    '                </div>',
    '              </div>',
    '              <div class="bc-tail">',
    '                <div class="bc-num">{{ g.total }}</div>',
    '                <div class="bc-num-label">个问题</div>',
    '                <span class="bc-arrow" :class="{ open: isBrandOpen(g.brand) }" aria-hidden="true">▾</span>',
    '              </div>',
    '            </header>',
    '            <div class="bc-collapse" :class="{ open: isBrandOpen(g.brand) }">',
    '              <div class="bc-collapse-inner">',
    '                <div class="bc-body">',
    '                  <section v-for="(tasks, pf) in g.platforms" :key="pf" class="bc-pf-section">',
    '                    <div class="bc-pf-section-head">',
    '                      <span class="pf-dot" :style="{ background: PLATFORM_COLORS[pf] || \'#888\' }"></span>',
    '                      <span class="bc-pf-section-name">{{ PLATFORM_NAMES[pf] || pf }}</span>',
    '                      <span class="bc-pf-section-count">{{ tasks.length }} 条</span>',
    '                    </div>',
    '                    <div class="bc-tasks">',
    '                      <!-- 已运行：可展开查看详情 -->',
    '                      <template v-if="selectedTab === 2">',
    '                        <div v-for="t in tasks.filter(x=>x)" :key="t.executionId"',
    '                          class="bc-task done" :class="{ open: doneOpen[t.executionId] }" @click="toggleDone(t)">',
    '                          <div class="bc-task-top">',
    '                            <span class="bc-task-kw" :title="t.keyword">{{ kwTail(t.keyword, g.brand) || t.keyword }}</span>',
    '                            <span class="badge b-green">{{ doneDetail[t.executionId] ? (doneDetail[t.executionId].refCount || 0) + \' 引用\' : \'—\' }}</span>',
    '                          </div>',
    '                          <div class="bc-task-meta">',
    '                            <span>ID {{ t.executionId }}</span>',
    '                            <span>完成 {{ fmtTime(t.modifyTime) }}</span>',
    '                          </div>',
    '                          <div class="tc-body" v-if="doneOpen[t.executionId]">',
    '                            <div v-if="!doneDetail[t.executionId]" class="empty">加载中…</div>',
    '                            <template v-else>',
    '                              <div class="answer-text" v-if="doneDetail[t.executionId].answer">{{ doneDetail[t.executionId].answer }}</div>',
    '                              <div v-else class="empty">该任务无回答内容</div>',
    '                              <div class="refs" v-if="doneDetail[t.executionId].refs && doneDetail[t.executionId].refs.length">',
    '                                <div class="ref" v-for="(r, ri) in doneDetail[t.executionId].refs" :key="ri">',
    '                                  <div class="rt">{{ r.rank != null ? \'[\' + r.rank + \'] \' : \'\' }}{{ refTitle(r) }}</div>',
    '                                  <div class="rm"><span>{{ r.articlePlatform || \'\' }}</span><a v-if="r.url" :href="r.url" target="_blank" rel="noopener" @click.stop>{{ r.url }}</a></div>',
    '                                </div>',
    '                              </div>',
    '                              <div v-else class="empty">无引用来源</div>',
    '                            </template>',
    '                          </div>',
    '                        </div>',
    '                      </template>',
    '                      <!-- 运行中 / 待运行 / 失败：普通卡片 -->',
    '                      <template v-else>',
    '                        <div v-for="t in tasks.filter(x=>x)" :key="t.executionId" class="bc-task"',
    '                          :class="[selectedTab === 1 ? taskClass(t) : selectedTab === 0 ? \'pending\' : \'failed\']">',
    '                          <div class="bc-task-top">',
    '                            <span class="bc-task-kw" :title="t.keyword">{{ kwTail(t.keyword, g.brand) || t.keyword }}</span>',
    '                            <span v-if="selectedTab === 1 && isStale(t)" class="badge b-red">卡住</span>',
    '                          </div>',
    '                          <div class="bc-task-meta">',
    '                            <span>ID {{ t.executionId }}</span>',
    '                            <span v-if="selectedTab === 1" class="live">耗时 {{ fmtDur(elapsed(t)) }}</span>',
    '                            <span v-if="selectedTab === 0">创建 {{ fmtTime(t.createdAt) }}</span>',
    '                            <span v-if="selectedTab === 2">完成 {{ fmtTime(t.modifyTime) }}</span>',
    '                            <span v-if="t.failCount">失败 {{ t.failCount }} 次</span>',
    '                          </div>',
    '                        </div>',
    '                      </template>',
    '                    </div>',
    '                  </section>',
    '                </div>',
    '              </div>',
    '            </div>',
    '          </article>',
    '        </div>',
    '        <div v-else class="col-empty">该分类下暂无任务</div>',
    '      </section>',

    '      <!-- 研究爬取 -->',
    '      <section v-else-if="activeNav === \'research\'">',
    '        <div class="section-title">研究回答（展开看引用）</div>',
    '        <div v-if="combinedAnswers.length">',
    '          <div class="ans" v-for="a in combinedAnswers" :key="a.id">',
    '            <div class="head">',
    '              <span class="q" :title="a.kw">{{ a.kw }}</span>',
    '              <span class="badge b-blue">研究</span>',
    '              <span v-if="a.pf" class="badge b-gray">{{ a.pf }}</span>',
    '              <span class="badge b-green">{{ a.refCount || 0 }} 引用</span>',
    '              <span style="color:var(--text-tertiary);font-size:12px">{{ fmtTime(a.time) }}</span>',
    '            </div>',
    '            <div class="body"><div class="answer-text">{{ a.content }}</div></div>',
    '          </div>',
    '        </div>',
    '        <div v-else class="empty">暂无研究回答</div>',
    '        <div class="section-title">引用来源检索</div>',
    '        <div class="toolbar">',
    '          <input type="search" v-model="refsSearch" placeholder="搜索标题 / 来源 / URL…" aria-label="搜索引用" />',
    '          <select v-model="refsPlat" aria-label="按平台筛选">',
    '            <option value="">全部平台</option>',
    '            <option v-for="p in PLATFORM_ORDER" :key="p" :value="p">{{ PLATFORM_NAMES[p] }}</option>',
    '          </select>',
    '          <span class="updated">共 {{ filteredRefs.length }} 条</span>',
    '        </div>',
    '        <div class="refs">',
    '          <div class="ref" v-for="(r, ri) in filteredRefs.slice(0, 500)" :key="ri">',
    '            <div class="rt">{{ r.rank != null ? \'[\' + r.rank + \'] \' : \'\' }}{{ refTitle(r) }}<span class="badge" :class="r.src === \'RPA\' ? \'b-purple\' : \'b-blue\'">{{ r.src }}</span></div>',
    '            <div class="rm"><span>{{ r.articlePlatform || \'\' }}</span><a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{ r.url }}</a></div>',
    '            <div class="rm" v-if="r.question || r.keyword" style="color:var(--text-tertiary)">{{ trunc(r.question || r.keyword, 80) }}</div>',
    '          </div>',
    '          <div v-if="!filteredRefs.length" class="empty">无匹配引用</div>',
    '        </div>',
    '      </section>',
    '    </div>',
    '  </div>',
    '  <div class="scrim" :class="{ show: sidebarOpen }" @click="closeSidebar" aria-hidden="true"></div>',
    '</div>'
  ].join("\n")
};

const app = createApp(App);
// 将模块级静态映射注入全局属性，使模板内可直接访问（Options API 模板无法访问组件作用域外的 const）
app.config.globalProperties.ICONS = ICONS;
app.config.globalProperties.PLATFORM_NAMES = PLATFORM_NAMES;
app.config.globalProperties.PLATFORM_COLORS = PLATFORM_COLORS;
app.config.globalProperties.PLATFORM_ORDER = PLATFORM_ORDER;
// 模板中直接调用的模块级辅助函数也必须注入全局属性（Options API 模板无法访问组件作用域外的 const/function）
app.config.globalProperties.fmtTime = fmtTime;
app.config.globalProperties.fmtDur = fmtDur;
app.config.globalProperties.trunc = trunc;
app.config.globalProperties.extractBrand = function(kw) {
  if (!kw) return "其他";
  let m = kw.match(/^([^，,（(]{2,20})在/);
  let raw = m ? m[1].trim() : null;
  if (!raw) { m = kw.match(/中[，,]\s*([^，,（)的的有]{2,20})/); if (m) { const b = m[1].trim().split(/[的有]/)[0].trim(); if (b.length >= 2 && !/哪些|什么|如何|怎么|值得|推荐|哪个/.test(b)) raw = b; } }
  if (!raw) return "其他";
  const parent = BRAND_PARENTS[raw];
  if (parent) return parent;
  for (const [, p] of Object.entries(BRAND_PARENTS)) { if (raw !== p && raw.includes(p) && raw.length > p.length) return p; }
  return raw;
};
app.component("status-badge", StatusBadge)
  .component("health-badge", HealthBadge)
  .component("sparkline", Sparkline).mount(document.querySelector("#app"));

;window.__vueApp=app;