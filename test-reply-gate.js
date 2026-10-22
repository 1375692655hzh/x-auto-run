// test-reply-gate.js — 10-22 回复绑定闸的本地 fixture 测试（不碰任何真实账号/窗口）
// 从 resident.js 源码切出真实函数 eval 后跑：probeReplyComposer / typeReply / submitReply
// fixture 用本地 http 服务模拟 X 的三种 DOM 形态（回复弹窗/独立发帖弹窗/home 主框/permalink 内联框）
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const SRC = fs.readFileSync(path.join(__dirname, 'resident.js'), 'utf8');
function slice(startMark, endMark) {
  const a = SRC.indexOf(startMark), b = SRC.indexOf(endMark);
  if (a < 0 || b < 0 || b <= a) throw new Error('切片失败: ' + startMark);
  return SRC.slice(a, b);
}
const probeSrc = slice('function probeReplyComposer', 'async function typeReply');
const typeSrc = slice('async function typeReply', 'async function submitReply');
const submitSrc = slice('async function submitReply', 'async function gotoFeed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEL = { replyBox: '[data-testid="tweetTextarea_0"]' };
const { probeReplyComposer, typeReply, submitReply } = new Function('SEL', 'sleep',
  probeSrc + '\n' + typeSrc + '\n' + submitSrc + '\nreturn { probeReplyComposer, typeReply, submitReply };')(SEL, sleep);

// ── fixtures ──
const BOX = '<div data-testid="tweetTextarea_0" contenteditable="true" style="width:400px;height:40px"></div>';
const ARTICLE_FULLWIN = '<article data-testid="tweet"><div data-testid="User-Name"><a href="/Fullwin777">Fullwin</a></div><div data-testid="tweetText">谢了，常来往</div></article>';
const ARTICLE_OTHER = '<article data-testid="tweet"><div data-testid="User-Name"><a href="/SomeoneElse">别人</a></div></article>';
const SCRIPT_REC = `<script>
  window.__clicks = []; window.__pastes = [];
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-testid]'); if (b) window.__clicks.push(b.getAttribute('data-testid')); }, true);
  document.addEventListener('paste', (e) => { const b = e.target.closest('[data-testid]'); if (b) window.__pastes.push(b.getAttribute('data-testid') + ':' + (b.closest('[role="dialog"]') ? 'dialog' : 'page')); }, true);
  function sendOk() { setTimeout(() => { const t = document.createElement('div'); t.setAttribute('data-testid', 'toast'); t.textContent = '已发送'; document.body.appendChild(t); const d = document.querySelector('[role="dialog"]'); if (d) d.remove(); }, 200); }
</script>`;
const pages = {
  // 回复弹窗（permalink 点 reply 后的真实形态：弹窗有父帖 article + 弹窗内输入框，页面上还躺着内联框）
  '/case/reply-dialog': `<html><body>${BOX}<div role="dialog">${ARTICLE_FULLWIN}${BOX}<button data-testid="tweetButton" onclick="sendOk()">回覆</button></div>${SCRIPT_REC}</body></html>`,
  // 独立发帖弹窗（无父帖 article）
  '/case/compose-dialog': `<html><body><div role="dialog">${BOX}<button data-testid="tweetButton" onclick="sendOk()">發佈</button></div>${SCRIPT_REC}</body></html>`,
  // 回复弹窗但父帖是别人（绑定错目标）
  '/case/wrong-author': `<html><body>${BOX}<div role="dialog">${ARTICLE_OTHER}${BOX}<button data-testid="tweetButton" onclick="sendOk()">回覆</button></div>${SCRIPT_REC}</body></html>`,
  // /home 主发帖框（bug 通道现场）
  '/home': `<html><body>${BOX}<button data-testid="tweetButtonInline" onclick="sendOk()">發佈</button>${SCRIPT_REC}</body></html>`,
  // permalink 内联回复框（无弹窗，绑定目标帖）
  '/Fullwin777/status/2112939965827154150': `<html><body>${ARTICLE_FULLWIN}${BOX}<button data-testid="tweetButtonInline" onclick="sendOk()">回覆</button>${SCRIPT_REC}</body></html>`,
};

const server = http.createServer((req, res) => {
  const html = pages[req.url.split('?')[0]];
  res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html || 'nf');
});

let passed = 0, failed = 0;
function expect(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox'] });
  const SID = '2112939965827154150';
  try {
    const page = await browser.newPage();
    const rec = () => page.evaluate(() => ({ clicks: window.__clicks || [], pastes: window.__pastes || [] }));

    // 1. 回复弹窗 → dialog 绑定通过
    await page.goto(base + '/case/reply-dialog');
    let g = await page.evaluate(probeReplyComposer, SID, 'fullwin777');
    expect('回复弹窗 → ok:dialog', g.ok && g.mode === 'dialog', JSON.stringify(g));

    // 2. typeReply dialog 模式 → 文字进弹窗框不进页面框
    await page.evaluate(() => { window.__pastes = []; });
    await typeReply(page, '测试一下', g.mode);
    let r = await rec();
    expect('typeReply(dialog) 只进弹窗框', r.pastes.length === 1 && r.pastes[0].endsWith(':dialog'), JSON.stringify(r.pastes));

    // 3. submitReply 带 sid → 点的是弹窗 tweetButton，返回 true
    await page.evaluate(() => { window.__clicks = []; });
    const sr = await submitReply(page, SID, 'fullwin777');
    r = await rec();
    expect('submitReply(绑定弹窗) → true 且点 tweetButton', sr === true && r.clicks.includes('tweetButton') && !r.clicks.includes('tweetButtonInline'), 'sr=' + sr + ' clicks=' + JSON.stringify(r.clicks));

    // 4. 独立发帖弹窗 → 闸拒（无父帖卡片）
    await page.goto(base + '/case/compose-dialog');
    g = await page.evaluate(probeReplyComposer, SID, 'fullwin777');
    expect('独立发帖弹窗 → 拒(dialog无父帖卡片)', !g.ok && /无父帖卡片/.test(g.note), JSON.stringify(g));

    // 5. 独立发帖弹窗 submitReply(带 sid) → unbound 且不点击
    await page.evaluate(() => { window.__clicks = []; });
    const sr2 = await submitReply(page, SID, 'fullwin777');
    r = await rec();
    expect('submitReply(独立弹窗+sid) → unbound 且零点击', typeof sr2 === 'string' && sr2.indexOf('unbound:') === 0 && r.clicks.length === 0, 'sr=' + sr2 + ' clicks=' + JSON.stringify(r.clicks));

    // 6. 独立发帖弹窗 submitReply(不带 sid=发帖流程) → 放行（postOnPage 路径不受影响）
    const sr3 = await submitReply(page);
    expect('submitReply(独立弹窗无 sid=发帖) → true', sr3 === true, 'sr=' + sr3);

    // 7. /home 主框 → 闸拒（bug 通道焊死）
    await page.goto(base + '/home');
    g = await page.evaluate(probeReplyComposer, SID, 'fullwin777');
    expect('/home 主框 → 拒(无绑定composer)', !g.ok && /无绑定composer/.test(g.note), JSON.stringify(g));
    await page.evaluate(() => { window.__clicks = []; });
    const sr4 = await submitReply(page, SID, 'fullwin777');
    r = await rec();
    expect('/home submitReply(带 sid) → unbound 且零点击（事故场景焊死）', typeof sr4 === 'string' && sr4.indexOf('unbound:') === 0 && r.clicks.length === 0, 'sr=' + sr4);

    // 8. permalink 内联框 sid 匹配 → ok:inline
    await page.goto(base + '/Fullwin777/status/' + SID);
    g = await page.evaluate(probeReplyComposer, SID, 'fullwin777');
    expect('permalink 内联框 sid匹配 → ok:inline', g.ok && g.mode === 'inline', JSON.stringify(g));

    // 9. typeReply inline 模式 → 进页面框
    await page.evaluate(() => { window.__pastes = []; });
    await typeReply(page, '测试一下', g.mode);
    r = await rec();
    expect('typeReply(inline) 进页面框', r.pastes.length === 1 && r.pastes[0].endsWith(':page'), JSON.stringify(r.pastes));

    // 10. permalink sid 不匹配 → 拒
    g = await page.evaluate(probeReplyComposer, '9999999999999999999', 'fullwin777');
    expect('permalink sid不匹配 → 拒', !g.ok, JSON.stringify(g));

    // 11. 弹窗父帖作者不符 → 拒
    await page.goto(base + '/case/wrong-author');
    g = await page.evaluate(probeReplyComposer, SID, 'fullwin777');
    expect('弹窗父帖作者非目标 → 拒', !g.ok && /父帖作者非/.test(g.note), JSON.stringify(g));

    // 12. handle 为空（/i/web/status 路径）→ 弹窗只看 article，放行
    await page.goto(base + '/case/reply-dialog');
    g = await page.evaluate(probeReplyComposer, SID, null);
    expect('handle空 → 弹窗仅验 article 放行', g.ok && g.mode === 'dialog', JSON.stringify(g));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n结果: ${passed} 过 / ${failed} 挂`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); server.close(); process.exit(1); });
