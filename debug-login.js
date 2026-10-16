// 调试：看 butcher 窗口实际登录的是谁
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const id = process.argv[2] || '8eb4ae1e9a6e407e8ebe87f333889811';
  const j = await fetch('http://127.0.0.1:54345/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败');
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  const info = await page.evaluate(() => {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const loginBtn = document.querySelector('[data-testid="loginButton"]');
    const cookies = document.cookie;
    return {
      url: location.href,
      profileHref: a ? a.getAttribute('href') : null,
      hasLoginButton: !!loginBtn,
      hasAuthToken: /auth_token=/.test(cookies),
      title: document.title,
    };
  }).catch((e) => ({ err: e.message }));
  console.log(JSON.stringify(info, null, 2));
  await page.close();
  await browser.disconnect();
  await fetch('http://127.0.0.1:54345/browser/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
