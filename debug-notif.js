// 一次性排查：看通知页真实 DOM 结构
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const j = await fetch(CFG.bitbrowser + '/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: CFG.insights.profileId }),
  }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败');
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  try {
    await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    await page.waitForSelector('article', { timeout: 30000 }).catch(() => {});
    await sleep(2000);
    const info = await page.evaluate(() => {
      const testids = {};
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const t = el.getAttribute('data-testid');
        testids[t] = (testids[t] || 0) + 1;
      });
      const cell = document.querySelector('[data-testid="cellInner"]');
      const firstArticle = document.querySelector('article');
      return {
        url: location.href,
        title: document.title,
        testidCounts: Object.entries(testids).sort((a, b) => b[1] - a[1]).slice(0, 30),
        cellInnerSample: cell ? cell.innerText.replace(/\s+/g, ' ').slice(0, 200) : null,
        firstArticleSample: firstArticle ? firstArticle.innerText.replace(/\s+/g, ' ').slice(0, 200) : null,
        timeCount: document.querySelectorAll('time').length,
        tabList: [...document.querySelectorAll('[role="tab"]')].map((t) => t.innerText.trim()),
      };
    });
    console.log(JSON.stringify(info, null, 2));
    await page.screenshot({ path: path.join(__dirname, 'debug-notif.png'), fullPage: false });
    console.log('截图: debug-notif.png');
  } finally {
    await browser.disconnect();
    await fetch(CFG.bitbrowser + '/browser/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: CFG.insights.profileId }),
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
