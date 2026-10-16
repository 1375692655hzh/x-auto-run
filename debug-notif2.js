// 一次性排查：dump 通知条目原文
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const j = await fetch(CFG.bitbrowser + '/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: CFG.insights.profileId }),
  }).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  try {
    await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-testid="notification"]', { timeout: 45000 });
    await sleep(4000);
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll('[data-testid="notification"]')].slice(0, 14).map((el) => {
        const time = el.querySelector('time');
        return {
          at: time ? time.getAttribute('datetime') : null,
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150),
        };
      });
    });
    for (const r of rows) console.log((r.at || 'no-time') + ' | ' + r.text);
  } finally {
    await browser.disconnect();
    await fetch(CFG.bitbrowser + '/browser/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: CFG.insights.profileId }),
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
