// 清理 fullwin 重复回复：每帖保留一条，删除多余
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'fullwin777';

const PLAN = [
  {
    post: 'https://x.com/Owenwin888/status/2109575626248302719',
    keep: '看完收获很大，想问下这波存储涨价你判断能持续到明年 Q1 吗？',
    deletes: [
      '从 AI 工具到硬件跟踪全都覆盖，难怪说全栈，服气',
      '每天看你的碎碎念已成习惯，这篇尤其干',
    ],
  },
  {
    post: 'https://x.com/Owenwin888/status/2110290432886489392',
    keep: '这个观点有意思，等展开',
    deletes: [
      '学到了，蹲一个后续',
      '支持，常来串门 👋',
    ],
  },
];

(async () => {
  const j = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '60a37618910b4cceaa633a1b9e1089cf' }),
  }).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const results = [];
  try {
    for (const plan of PLAN) {
      // 滚动加载回复
      await page.goto(plan.post, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
      for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await sleep(1500); }
      for (const target of plan.deletes) {
        // 找到我的这条回复的 article
        const found = await page.evaluate((me, txt) => {
          const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
          for (const a of arts) {
            const nameEl = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
            const textEl = a.querySelector('[data-testid="tweetText"]');
            if (!nameEl || !textEl) continue;
            const who = (nameEl.getAttribute('href') || '').replace('/', '').toLowerCase();
            const t = (textEl.textContent || '').replace(/\s+/g, '');
            if (who === me && t.includes(txt.replace(/\s+/g, '').slice(0, 12))) {
              // 点开它的更多菜单
              const caret = a.querySelector('[data-testid="caret"]');
              if (!caret) return 'no caret';
              caret.click();
              return 'menu opening';
            }
          }
          return 'not found';
        }, ME, target).catch((e) => 'err ' + e.message);
        await sleep(2000);
        if (found !== 'menu opening') { results.push({ target: target.slice(0, 15), note: found }); continue; }
        // 菜单里点 删除/削除/Delete
        const del = await page.evaluate(() => {
          const items = [...document.querySelectorAll('[role="menuitem"]')];
          const el = items.find((n) => /删除|削除|delete/i.test(n.textContent || ''));
          if (el) { el.click(); return 'clicked'; }
          return 'no item: ' + items.map((n) => (n.textContent || '').trim()).join('|').slice(0, 80);
        }).catch((e) => 'err ' + e.message);
        await sleep(1800);
        if (del !== 'clicked') { results.push({ target: target.slice(0, 15), note: del }); await page.keyboard.press('Escape'); continue; }
        // 确认弹窗
        const confirmed = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (b) { b.click(); return true; }
          return false;
        }).catch(() => false);
        await sleep(2200);
        results.push({ target: target.slice(0, 15), deleted: confirmed });
      }
    }
  } finally {
    console.log(JSON.stringify(results, null, 2));
    await page.close();
    await browser.disconnect();
    await fetch('http://127.0.0.1:54345/browser/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '60a37618910b4cceaa633a1b9e1089cf' }),
    });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
