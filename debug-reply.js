// 调试回复流程：点回复按钮，看弹窗/输入框/按钮状态，测试中文输入（不发送）
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
  console.log('reply按钮:', !!btn);
  await btn.click();
  await sleep(3000);
  const s1 = await page.evaluate(() => ({
    dialog: !!document.querySelector('[role="dialog"]'),
    box: !!document.querySelector('[data-testid="tweetTextarea_0"]'),
    tweetButtons: [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')].map((b) => ({
      tid: b.getAttribute('data-testid'), disabled: b.disabled, ariaDis: b.getAttribute('aria-disabled'),
    })),
  }));
  console.log('点击后:', JSON.stringify(s1, null, 2));

  // 测试 execCommand 输入中文
  const typed = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!el) return 'no box';
    el.focus();
    const ok = document.execCommand('insertText', false, '测试输入123');
    await new Promise((r) => setTimeout(r, 500));
    return { execOk: ok, content: el.textContent.slice(0, 40) };
  });
  console.log('输入测试:', JSON.stringify(typed));
  await sleep(1000);
  const s2 = await page.evaluate(() => ({
    tweetButtons: [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')].map((b) => ({
      tid: b.getAttribute('data-testid'), disabled: b.disabled, ariaDis: b.getAttribute('aria-disabled'),
    })),
  }));
  console.log('输入后按钮:', JSON.stringify(s2, null, 2));
  await page.screenshot({ path: 'debug-reply.png' });
  await page.keyboard.press('Escape');
  await sleep(1000);
  await page.close();
  await browser.disconnect();
  await fetch('http://127.0.0.1:54345/browser/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
