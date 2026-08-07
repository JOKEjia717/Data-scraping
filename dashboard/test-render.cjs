// 直接以 URL 加载页面，让 jsdom 接管脚本执行
const fs = require('fs');
const NM = 'C:/Users/xu/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM, ResourceLoader, VirtualConsole } = require(NM + '/jsdom');

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('[jsdomErr]', e.message));
  vc.on('error', e => console.error('[err]', e));
  vc.on('warn', e => console.warn('[warn]', e));
  vc.on('log', (...a) => console.log('[log]', ...a));

  const dom = await JSDOM.fromURL('http://127.0.0.1:8787/?v=test-bust=' + Date.now(), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  // 等 Vue 渲染 + fetch 完成
  setTimeout(() => {
    const html = dom.window.document.querySelector('#app').innerHTML;
    const errs = dom.window.__err || [];
    console.log('errs:', errs.length);
    if (errs.length) console.log(JSON.stringify(errs.slice(0, 3), null, 2));
    console.log('html length:', html.length);
    const hits = ['.brand-card', '.bc-monogram', '.bc-num', '.bc-industry', '.bc-product',
                  '.bc-platforms', '.bc-pf-section', '.bc-task', '.bc-collapse'].map(s => ({
      s, count: (html.match(new RegExp(s.replace('.', '\\.'), 'g')) || []).length
    }));
    console.log('selector hits:', JSON.stringify(hits, null, 2));
    const m = html.match(/<article[^>]*class="brand-card"[^>]*>[\s\S]{0,1800}/);
    if (m) {
      console.log('--- first brand-card snippet ---');
      console.log(m[0].slice(0, 1800).replace(/></g, '>\n<'));
    } else {
      console.log('NO <article class="brand-card"> in DOM');
      // 输出 tab-bar 旁边是什么
      const tm = html.match(/<div class="tab-bar"[\s\S]{0,3000}/);
      if (tm) console.log('--- tab-bar context ---', tm[0].slice(0, 1500));
    }
    process.exit(0);
  }, 4000);
})();
