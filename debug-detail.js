// 调试：看 Owen 帖子详情页的按钮结构（主帖在哪个容器里、share 按钮的 testid）
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const id = '8eb4ae1e9a6e407e8ebe87f333889811';
  const j = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto('https://x.com/Owenwin888/status/2110012522514505850', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('article', { timeout: 30000 });
  await sleep(5000);
  const info = await page.evaluate(() => {
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const first = arts[0];
    const btns = first ? [...first.querySelectorAll('button')].map((b) => ({
      testid: b.getAttribute('data-testid'),
      aria: (b.getAttribute('aria-label') || '').slice(0, 30),
    })).filter((b) => b.testid || b.aria) : [];
    // 也看看第一篇文章之前的主帖区域
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    const tweetLayer = primary ? [...primary.querySelectorAll('div[data-testid="cellInnerDiv"]')].slice(0, 3).map((c) => ({
      hasArticle: !!c.querySelector('article'),
      shareBtn: !!c.querySelector('[data-testid="share"], button[aria-label*="分享"], button[aria-label*="Share"]'),
    })) : [];
    return { articles: arts.length, firstArticleButtons: btns, firstCells: tweetLayer };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.close();
  await browser.disconnect();
  await fetch('http://127.0.0.1:54345/browser/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
