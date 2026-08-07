const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
vc.on('jsdomError', e => console.error('[jsdomErr]', e.message));
vc.on('error', e => console.error('[err]', e));

(async () => {
  // 加载首页（运行总览）
  const dom = await JSDOM.fromURL('http://127.0.0.1:8787/?v=test-' + Date.now(), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  });
  setTimeout(async () => {
    // 切换到 DIAGNOSIS 板块
    const w = dom.window;
    const btns = w.document.querySelectorAll('.nav-item');
    let diagBtn;
    btns.forEach(b => { if (b.textContent.includes('品牌诊断')) diagBtn = b; });
    if (diagBtn) {
      diagBtn.click();
    }
    // 等切到 DIAGNOSIS 完成 + loadSection 异步
    setTimeout(() => {
      const html = w.document.querySelector('#app').innerHTML;
      console.log('html length after switch:', html.length);
      const hits = ['.brand-card', '.bc-monogram', '.bc-num', '.bc-industry', '.bc-product',
                    '.bc-platforms', '.bc-pf-section', '.bc-task', '.bc-collapse'].map(s => ({
        s, count: (html.match(new RegExp(s.replace('.', '\.'), 'g')) || []).length
      }));
      console.log('selector hits:', JSON.stringify(hits, null, 2));
      console.log('errs:', (w.__err || []).length);
      const m = html.match(/<article[^>]*class="brand-card"[^>]*>[\s\S]{0,2200}/);
      if (m) {
        console.log('--- first brand-card snippet ---');
        console.log(m[0].slice(0, 2200).replace(/></g, '>\n<'));
      } else {
        // 看是什么
        const tm = html.match(/<div class="brand-card"[\s\S]{0,200}/);
        const main = html.match(/<!-- 品牌诊断[\s\S]{0,3000}/) || html.match(/<div class="content">[\s\S]{0,3000}/);
        if (main) console.log('--- main snippet ---', main[0].slice(0, 2000));
      }
      process.exit(0);
    }, 2000);
  }, 1500);
})();
