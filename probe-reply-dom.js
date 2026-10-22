// 一次性只读探针：抓 X 回复弹窗/内联框/home 主发帖框的真实 DOM 结构判据（不输入、不发送）
// 用 owen 窗（无自动化在跑）。目标帖用一条公开帖 permalink。
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = '2d4d7ab00f01455a95a0497af72ce1e3'; // owen
const TARGET = 'https://x.com/Fullwin777/status/2112939965827154150';
const SID = '2112939965827154150';

const snap = () => `
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].map((b) => {
    const r = b.getBoundingClientRect();
    const inDlg = !!(b.closest('[role="dialog"]'));
    return { inDlg, y: Math.round(r.y), w: Math.round(r.width) };
  });
  const btnInfo = (root) => [...root.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')].map((b) => b.getAttribute('data-testid') + (b.disabled || b.getAttribute('aria-disabled') === 'true' ? '(dis)' : ''));
  return {
    url: location.pathname,
    dialog: !!dlg,
    dlgArticle: dlg ? !!dlg.querySelector('article') : null,
    dlgStatusLinks: dlg ? [...dlg.querySelectorAll('a[href*="/status/"]')].map((a) => (a.getAttribute('href') || '').slice(0, 60)).slice(0, 5) : null,
    dlgHasTargetLink: dlg ? !!dlg.querySelector('a[href*="/status/${SID}"]') : null,
    dlgTextSample: dlg ? (dlg.textContent || '').replace(/\\s+/g, ' ').slice(0, 120) : null,
    boxes,
    dlgButtons: dlg ? btnInfo(dlg) : null,
    pageButtons: btnInfo(document),
  };
})()`;

(async () => {
  const j = await fetch('http://127.0.0.1:54345/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: WIN }) }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败 ' + JSON.stringify(j).slice(0, 120));
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null, protocolTimeout: 90000 });
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.setViewport({ width: 1440, height: 900 });
  try {
    // A. permalink 未点击状态
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    await sleep(5000);
    console.log('A permalink静止:', JSON.stringify(await page.evaluate(snap()), null, 1));

    // B. 点目标帖的回复按钮（只开弹窗，不输入）
    let art = null;
    for (const a of await page.$$('article[data-testid="tweet"]')) {
      if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), SID).catch(() => false)) { art = a; break; }
    }
    if (!art) { console.log('B 找不到目标帖 article'); }
    else {
      const btn = await art.$('[data-testid="reply"]');
      await btn.click();
      await sleep(4000);
      console.log('B 点reply后:', JSON.stringify(await page.evaluate(snap()), null, 1));
      // 关弹窗（Escape），不输入不发送
      await page.keyboard.press('Escape');
      await sleep(1500);
      console.log('B2 Escape后 dialog:', await page.evaluate(() => !!document.querySelector('[role="dialog"]')));
    }

    // C. /home 主发帖框（负例结构）
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 }).catch(() => {});
    await sleep(4000);
    console.log('C home:', JSON.stringify(await page.evaluate(snap()), null, 1));

    // D. home 时间线里点某帖回复（弹窗形态对照）
    const art2 = (await page.$$('article[data-testid="tweet"]'))[0];
    if (art2) {
      const btn2 = await art2.$('[data-testid="reply"]');
      if (btn2) {
        await btn2.click();
        await sleep(4000);
        console.log('D home点reply后:', JSON.stringify(await page.evaluate(snap()), null, 1));
        await page.keyboard.press('Escape');
      }
    }
  } finally {
    try { await page.close(); } catch {}
    try { await browser.disconnect(); } catch {}
    await fetch('http://127.0.0.1:54345/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: WIN }) }).catch(() => {});
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
