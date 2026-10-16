// 诊断 fullwin 回复流程：每步状态埋点（成功即发出）
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const j = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '60a37618910b4cceaa633a1b9e1089cf' }),
  }).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const TEXT = '从 AI 工具到硬件跟踪全都覆盖，难怪说全栈，服气';
  try {
    await page.goto('https://x.com/Owenwin888/status/2109575626248302719', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    await sleep(4000);
    const arts = await page.$$('article[data-testid="tweet"]');
    const btn = await arts[0].$('[data-testid="reply"]');
    console.log('1. reply按钮:', !!btn);
    await btn.click();
    await sleep(3000);
    let st = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].map((b) => {
        const r = b.getBoundingClientRect();
        return { y: Math.round(r.y), visible: r.width > 0, len: (b.textContent || '').length };
      });
      return {
        dialog: !!document.querySelector('[role="dialog"]'),
        boxes,
        dlgBtn: (() => { const b = [...(document.querySelector('[role="dialog"]') || document).querySelectorAll('[data-testid="tweetButton"]')]; return b.map((x) => x.disabled || x.getAttribute('aria-disabled') === 'true'); })(),
        inlineBtn: (() => { const b = document.querySelector('[data-testid="tweetButtonInline"]'); return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true') : null; })(),
      };
    });
    console.log('2. 点reply后:', JSON.stringify(st));

    // 粘贴（弹窗优先，否则最后一个框）
    const typed = await page.evaluate((t) => {
      const all = document.querySelectorAll('[data-testid="tweetTextarea_0"]');
      const el = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') || all[all.length - 1];
      if (!el) return 'no box';
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    }, TEXT);
    await sleep(1500);
    st = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].map((b) => ({ y: Math.round(b.getBoundingClientRect().y), len: (b.textContent || '').length }));
      return {
        boxes,
        dlgBtn: (() => { const b = [...(document.querySelector('[role="dialog"]') || document).querySelectorAll('[data-testid="tweetButton"]')]; return b.map((x) => x.disabled || x.getAttribute('aria-disabled') === 'true'); })(),
        inlineBtn: (() => { const b = document.querySelector('[data-testid="tweetButtonInline"]'); return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true') : null; })(),
      };
    });
    console.log('3. 粘贴后:', typed, JSON.stringify(st));

    // 提交（新逻辑）
    const hasDialog = st.dlgBtn !== undefined && JSON.stringify(st).includes('dlgBtn');
    const clicked = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      let b = null;
      if (dlg) { const btns = [...dlg.querySelectorAll('[data-testid="tweetButton"]')]; b = btns[btns.length - 1]; }
      else b = document.querySelector('[data-testid="tweetButtonInline"]');
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return { found: !!b, enabled: false };
      b.click();
      return { found: true, enabled: true, clicked: true };
    });
    console.log('4. 提交按钮:', JSON.stringify(clicked));
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const s = await page.evaluate(() => ({
        dlg: !!document.querySelector('[role="dialog"]'),
        toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim().slice(0, 30),
        boxLen: (document.querySelector('[data-testid="tweetTextarea_0"]') || { textContent: '' }).textContent.length,
      }));
      if (i % 3 === 0 || s.toast) console.log(`   ${i}:`, JSON.stringify(s));
      if (s.toast) break;
    }
  } finally {
    await page.close();
    await browser.disconnect();
    await fetch('http://127.0.0.1:54345/browser/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '60a37618910b4cceaa633a1b9e1089cf' }),
    });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
