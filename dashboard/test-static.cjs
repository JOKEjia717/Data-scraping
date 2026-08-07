// 静态 HTML 渲染：直接把模板中的 brand-card 替换出 5 条静态记录，挂上 CSS
const fs = require('fs');
const NM = 'C:/Users/xu/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM } = require(NM + '/jsdom');

const HTML = fs.readFileSync('C:/Users/xu/Desktop/data/Data-scraping/dashboard/index.html', 'utf8');

const dom = new JSDOM(HTML.replace('?v=20260807n', '?v=render-test'), {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});

setTimeout(() => {
  const w = dom.window;
  const d = w.document;

  // 注入 5 个 brand-card 静态 HTML 到 .grouped-list 内
  const tasks = [
    { brand: "阿里巴巴", product: "阿里云对象存储OSS", ind: "信息科技", pfCount: [{ pf: "doubao", c: 5, label: "豆包" }, { pf: "deepseek", c: 10, label: "DeepSeek" }, { pf: "yuanbao", c: 14, label: "元宝" }, { pf: "qianwen", c: 3, label: "千问" }], total: 32 },
    { brand: "海底捞",   product: "牛油火锅底料",       ind: "餐饮",     pfCount: [{ pf: "doubao", c: 10, label: "豆包" }, { pf: "deepseek", c: 8, label: "DeepSeek" }, { pf: "yuanbao", c: 12, label: "元宝" }, { pf: "qianwen", c: 2, label: "千问" }], total: 32 },
    { brand: "惠普",     product: "惠普战66六代锐龙版",  ind: "电子设备", pfCount: [{ pf: "doubao", c: 5, label: "豆包" }, { pf: "deepseek", c: 5, label: "DeepSeek" }, { pf: "yuanbao", c: 13, label: "元宝" }, { pf: "qianwen", c: 9, label: "千问" }], total: 32 },
    { brand: "罗技",     product: "罗技G304X无线游戏鼠标", ind: "外设",    pfCount: [{ pf: "doubao", c: 3, label: "豆包" }, { pf: "deepseek", c: 3, label: "DeepSeek" }, { pf: "yuanbao", c: 8, label: "元宝" }, { pf: "qianwen", c: 5, label: "千问" }], total: 19 },
    { brand: "反复复复", product: "复发性皮炎预防方案",  ind: "医疗",     pfCount: [{ pf: "doubao", c: 2, label: "豆包" }, { pf: "deepseek", c: 1, label: "DeepSeek" }, { pf: "yuanbao", c: 1, label: "元宝" }, { pf: "qianwen", c: 1, label: "千问" }], total: 5 },
  ];

  // 模拟 monogram 颜色（按品牌名 hash 计算简化版）
  const colors = ["oklch(0.55 0.13 252)", "oklch(0.50 0.12 152)", "oklch(0.46 0.04 262)", "oklch(0.55 0.13 340)", "oklch(0.55 0.13 195)"];

  function monogram(b) { return b.trim().slice(0, 1); }
  const cardsHtml = tasks.map((g, i) => {
    const open = i === 0 ? ' open' : '';
    const pfs = g.pfCount.map(c =>
      `<span class="bc-pf">
         <span class="bc-pf-dot" style="background:${c.pf==='doubao'?'#0F6E56':c.pf==='deepseek'?'#185FA5':c.pf==='qianwen'?'#BA7517':'#A32D2D'}"></span>
         <span class="bc-pf-name">${c.label}</span>
         <span class="bc-pf-count">${c.c}</span>
       </span>`).join('');
    return `
<article class="brand-card">
  <header class="bc-head" role="button" aria-expanded="${i===0}">
    <div class="bc-monogram" style="background:${colors[i % colors.length]}">${monogram(g.brand)}</div>
    <div class="bc-mid">
      <div class="bc-brand-row">
        <span class="bc-brand-name">${g.brand}</span>
        <span class="bc-industry">${g.ind}</span>
      </div>
      <div class="bc-product">主产品：${g.product}</div>
      <div class="bc-platforms">${pfs}</div>
    </div>
    <div class="bc-tail">
      <div class="bc-num">${g.total}</div>
      <div class="bc-num-label">个问题</div>
      <span class="bc-arrow${open}">▾</span>
    </div>
  </header>
  <div class="bc-collapse${open}">
    <div class="bc-collapse-inner">
      <div class="bc-body">
        <p style="padding:14px;color:var(--text-tertiary);font-size:13px">
          这是展开后的任务列表预览区（已运行 ${g.total} 条）。展开/折叠有高度过渡动画。
        </p>
      </div>
    </div>
  </div>
</article>`;
  }).join('\n');

  // 把 .grouped-list 注入 demo 卡片 - 切到 DIAGNOSIS section 并把卡片注入到 body
  const groupedEl = d.createElement('div');
  groupedEl.className = 'grouped-list';
  groupedEl.innerHTML = cardsHtml;
  d.body.appendChild(groupedEl);

  // 同时把 topbar / 侧栏 demo 头部以简化方式渲染
  d.body.insertAdjacentHTML('afterbegin', `
<div class="app-shell">
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-logo">AI</span>
      <div class="brand-text"><strong>爬取运营台</strong><span>AI Reference Crawler</span></div>
    </div>
    <nav class="nav">
      <button class="nav-item">运行总览 <span class="nav-badge">13</span></button>
      <button class="nav-item active">品牌诊断 <span class="nav-badge">13</span></button>
      <button class="nav-item">数据监测</button>
      <button class="nav-item">风格监测</button>
      <button class="nav-item">研究爬取</button>
    </nav>
    <div class="sidebar-foot"><span class="conn"><span class="dot ok"></span>已连接</span></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div class="topbar-title"><h1>品牌诊断</h1></div>
      <div class="topbar-actions">
        <span class="updated">更新于 8/7 14:00</span>
      </div>
    </header>
    <div class="content">
      <div class="tab-bar">
        <button class="tab-pill running"><span class="pdot"></span>正在运行 <span class="tab-cnt">13</span></button>
        <button class="tab-pill pending"><span class="pdot"></span>待运行 <span class="tab-cnt">0</span></button>
        <button class="tab-pill done active"><span class="pdot"></span>已运行 <span class="tab-cnt">915</span></button>
        <button class="tab-pill failed"><span class="pdot"></span>失败 <span class="tab-cnt">1</span></button>
      </div>
      <div id="grouped-host"></div>
    </div>
  </div>
</div>
  `);
  d.getElementById('grouped-host').appendChild(groupedEl);

  setTimeout(() => {
    // 截图：jsdom 不渲染布局，但返回 DOM 检查 + 计算样式
    const cards = d.querySelectorAll('.brand-card');
    console.log('brand-card count:', cards.length);
    const mono = d.querySelector('.bc-monogram');
    if (mono) {
      const styles = w.getComputedStyle(mono);
      console.log('.bc-monogram computed:',
        'border-radius=', styles.getPropertyValue('border-radius'),
        'font-family=', styles.getPropertyValue('font-family').slice(0, 50),
        'font-size=', styles.getPropertyValue('font-size'));
    }
    const num = d.querySelector('.bc-num');
    if (num) {
      const styles = w.getComputedStyle(num);
      console.log('.bc-num computed:',
        'font-size=', styles.getPropertyValue('font-size'),
        'font-weight=', styles.getPropertyValue('font-weight'),
        'font-family=', styles.getPropertyValue('font-family').slice(0, 50));
    }
    const industry = d.querySelector('.bc-industry');
    if (industry) {
      const styles = w.getComputedStyle(industry);
      console.log('.bc-industry computed: bg=', styles.getPropertyValue('background-color'),
        'color=', styles.getPropertyValue('color'),
        'border-radius=', styles.getPropertyValue('border-radius'));
    }
    const pf = d.querySelector('.bc-pf-name');
    if (pf) {
      const styles = w.getComputedStyle(pf);
      console.log('.bc-pf-name computed: font-weight=', styles.getPropertyValue('font-weight'),
        'font-family=', styles.getPropertyValue('font-family').slice(0, 50));
    }
    const arrow = d.querySelector('.bc-arrow.open');
    if (arrow) {
      const styles = w.getComputedStyle(arrow);
      console.log('.bc-arrow.open transform:', styles.getPropertyValue('transform'));
    }
    // 输出第一张卡片 outerHTML 前 800 字
    if (cards.length) {
      console.log('--- first card outerHTML (first 1400) ---');
      console.log(cards[0].outerHTML.slice(0, 1400));
      console.log('--- card heights (computed padding/margins) ---');
      cards.forEach((c, i) => {
        const h = c.querySelector('.bc-head');
        const styles = w.getComputedStyle(h);
        console.log(`[${i}] ${c.querySelector('.bc-brand-name').textContent} → bc-head padding=${styles.getPropertyValue('padding')} grid-tc=${styles.getPropertyValue('grid-template-columns')}`);
      });
    }
    process.exit(0);
  }, 500);
}, 100);
