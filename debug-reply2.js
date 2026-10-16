// 调试2：用合成 paste 事件输入中文（不发送）
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const id = '8eb4ae1e9a6e407e8ebe87f333889811';
  const url = 'https://x.com/Owenwin888/status/2109575626248302719';
  const j = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
  await sleep(4000);
  const arts = await page.$$('article[data-testid="tweet"]');
  const btn = await arts[0].$('[data-testid="reply"]');
  await btn.click();
  await sleep(2500); // 等弹窗动画稳定
  const r = await page.evaluate((text) => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!el) return { err: 'no box' };
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return new Promise((resolve) => setTimeout(() => {
      const b = document.querySelector('[role="dialog"] [data-testid="tweetButton"]');
      resolve({ content: el.textContent, len: el.textContent.length, btnDisabled: b ? (b.disabled || b.getAttribute('aria-disabled') === 'true') : 'no btn' });
    }, 800));
  }, '这条产业链拆得够细，HBM 量价这块我最近也在盯，逻辑认同');
  console.log('paste结果:', JSON.stringify(r, null, 2));
  await page.screenshot({ path: 'debug-reply2.png' });
  await page.keyboard.press('Escape');
  await sleep(800);
  await page.close();
  await browser.disconnect();
  await fetch('http://127.0.0.1:54345/browser/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
