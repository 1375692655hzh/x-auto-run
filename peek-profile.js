// 只读：查看指定 X 账号主页概况（用 WCixot 窗口）
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_ID = '9271f8e085944b0a8a6685aa19e8b2f7';
const HANDLE = (process.argv[2] || 'TrumpDailyPosts').replace(/^@/, '');

(async () => {
  const open = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PROFILE_ID }),
  }).then((r) => r.json());
  if (!open.success) throw new Error('打开窗口失败');
  const browser = await puppeteer.connect({ browserWSEndpoint: open.data.ws, defaultViewport: null });
  try {
    const page = await browser.newPage();
    await page.goto('https://x.com/' + HANDLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 45000 });
    await sleep(3000);
    const data = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const header = document.querySelector('[data-testid="UserName"]');
      const bio = document.querySelector('[data-testid="UserDescription"]');
      const notFound = document.querySelector('[data-testid="emptyState"]');
      const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 8).map((art) => {
        const time = art.querySelector('time');
        const text = art.querySelector('[data-testid="tweetText"]');
        const like = art.querySelector('button[data-testid="like"], button[data-testid="unlike"]');
        return {
          time: time ? time.getAttribute('datetime') : null,
          text: text ? clean(text.textContent).slice(0, 90) : null,
          likeLabel: like ? clean(like.getAttribute('aria-label') || '').slice(0, 40) : null,
        };
      });
      return { url: location.href, header: clean(header && header.textContent), bio: clean(bio && bio.textContent).slice(0, 120), notFound: !!notFound, tweets };
    });
    console.log(JSON.stringify(data, null, 2));
    await page.close();
  } finally {
    await browser.disconnect();
    await fetch('http://127.0.0.1:54345/browser/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: PROFILE_ID }),
    });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
