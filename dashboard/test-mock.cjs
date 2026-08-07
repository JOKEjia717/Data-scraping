// 用模拟数据真渲染 Vue App，验证 brand-card 新结构（clean version）
const fs = require('fs');
const NM = 'C:/Users/xu/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM, VirtualConsole } = require(NM + '/jsdom');
const vm = require(NM + '/vue');

const APP_JS = fs.readFileSync('C:/Users/xu/Desktop/data/Data-scraping/dashboard/app.js', 'utf8');

function buildMockTasks() {
  const brands = [
    { name: "阿里巴巴", product: "阿里云对象存储OSS",       industry: "信息科技", pfs: { yuanbao: 14, deepseek: 10, doubao: 5, qianwen: 3 } },
    { name: "海底捞",   product: "牛油火锅底料",           industry: "餐饮",     pfs: { yuanbao: 12, doubao: 10, deepseek: 8, qianwen: 2 } },
    { name: "惠普",     product: "惠普战66六代锐龙版",     industry: "电子设备", pfs: { yuanbao: 13, qianwen: 9, deepseek: 5, doubao: 5 } },
    { name: "罗技",     product: "罗技G304X无线游戏鼠标",  industry: "外设",     pfs: { yuanbao: 8, qianwen: 5, doubao: 3, deepseek: 3 } },
    { name: "反复复复", product: "复发性皮炎预防方案",     industry: "医疗",     pfs: { doubao: 2, deepseek: 1, qianwen: 1, yuanbao: 1 } },
  ];
  const DOMAINS = { "信息科技": "云存储服务", "餐饮": "火锅底料市场", "电子设备": "轻薄笔记本", "外设": "无线游戏鼠标", "医疗": "复发性皮炎" };
  const KW_TEMPLATES = [
    n => `${n}在{领域}中有哪些值得推荐的品牌？`,
    n => `${n}在{领域}中的代表产品和竞争优势有哪些？`,
    n => `${n}在{领域}中的市场表现如何？`,
    n => `${n}在{领域}中的直接竞品有哪些？`,
  ];
  let id = 1000;
  const tasks = [];
  for (const b of brands) {
    for (const [pf, n] of Object.entries(b.pfs)) {
      for (let i = 0; i < n; i++) {
        const tpl = KW_TEMPLATES[(id) % KW_TEMPLATES.length];
        const kw = tpl(b.name).replace('{领域}', DOMAINS[b.industry]);
        tasks.push({
          executionId: id++,
          keyword: kw,
          brandName: b.name,
          brandProduct: b.product,
          brandIndustry: b.industry,
          platform: pf,
          modifyTime: '2026-08-07 13:00:00',
          createdAt: '2026-08-07 12:55:00',
          status: 2,
          referenceCount: 8 + (id % 10),
        });
      }
    }
  }
  return tasks;
}

const vc = new VirtualConsole();
vc.on('jsdomError', e => console.error('[jsdomErr]', e.message.slice(0, 200)));
vc.on('error', e => console.error('[err]', String(e).slice(0, 200)));

(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  const d = w.document;

  for (const k of ['window','document','HTMLElement','SVGElement','Node','Element','Comment','Text']) {
    try { Object.defineProperty(global, k, { value: w[k], writable: true, configurable: true }); } catch {}
  }

  // 关键：用 vm.createApp 而非 eval createApp(App)（后者需要 template compiler）
  // 但 app.js 是 UMD 风格：const { createApp } = Vue; 我们让 vm 重名
  const script = APP_JS
    .replace('/* global Vue */', '')
    .replace(/const \{ createApp \} = Vue;/, 'const { createApp } = vm;')
    .replace(/async poll\(\) \{[\s\S]*?finally \{[\s\S]*?\}/, 'async poll(){}')
    .replace(/\.component\("sparkline", Sparkline\)\s*\.mount\(\"\#app\"\);/, '.component("sparkline", Sparkline).mount(document.querySelector("#app"));')
    + '\n;window.__vueApp=app;';

  try {
    const fn = new w.Function('var vm = arguments[0];' + script);
    fn(w, vm);
  } catch (e) {
    console.error('app.js exec ERR:', e.message.slice(0, 300));
    process.exit(1);
  }

  // 拿到 app 后注入数据
  setTimeout(() => {
    if (!w.__vueApp) {
      console.error('no __vueApp set');
      process.exit(1);
    }
    const tasks = buildMockTasks();
    const proxy = w.__vueApp._instance.proxy;
    if (!proxy) {
      console.error('no proxy');
      process.exit(1);
    }
    proxy.activeNav = 'DIAGNOSIS';
    proxy.sectionTasks = { DIAGNOSIS: { 1:[], 0:[], 2: tasks, 3:[] } };
    proxy.selectedTab = 2;

    setTimeout(() => {
      const html = d.querySelector('#app').innerHTML;
      console.log('html length after data set:', html.length);
      const errs = w.__err || [];
      console.log('errs:', errs.length);

      const hits = ['.brand-card', '.bc-monogram', '.bc-num', '.bc-industry', '.bc-product',
                    '.bc-platforms', '.bc-pf-section', '.bc-task', '.bc-collapse', '.bc-head',
                    '.bc-tail', '.bc-brand-name', '.bc-pf-name'].map(s => ({
        s, count: (html.match(new RegExp(s.replace('.', '\\.'), 'g')) || []).length
      }));
      console.log('selector hits:', JSON.stringify(hits, null, 2));

      const articles = html.match(/<article[^>]*class="brand-card"[\s\S]*?<\/article>/g) || [];
      console.log('brand-card <article> count:', articles.length);
      if (articles.length > 0) {
        console.log('=== first brand-card (cleaned, first 1500 chars) ===');
        console.log(articles[0].slice(0, 1500).replace(/></g, '>\n<'));
        console.log('=== 2nd brand-card (head only) ===');
        const head2 = articles[1].match(/<header class="bc-head">[\s\S]*?<\/header>/);
        console.log(head2 ? head2[0].replace(/></g, '>\n<') : 'no head');
      } else {
        const tabSect = html.match(/<div class="tab-bar"[\s\S]{0,300}/);
        console.log('tab-bar snippet:', tabSect ? tabSect[0].slice(0, 300) : 'NOT FOUND');
      }
      process.exit(0);
    }, 700);
  }, 500);
})();
