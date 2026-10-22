// inbox-reply.js — 被动回复模块 v2（10-21 用户拍板"跟进"，移植 fullwin 光速回复 v3 全套方法论，保持轮询形式）：
// 别人在我们帖下的评论 → 提及页轮询 → 分场景处理 → 回复对方那条评论。
// v2 相比 v1（10-21 上午版）吸收的 fullwin 成果：
//   ①分场景双阈值（招呼≤12字素 / 轻内容≤20字素，codex 裁决版 B）②实质提问→人工待办（human-todo-<账号>.json，进飞书报告）
//   ③quality casual 档（放行无标点短句/社区招呼词）④招呼模板库 0-LLM（interaction.js）+bio 惰性抓取≤2/轮+身份标签
//   ⑤history 接 taskstate 真实缓冲（防复读）⑥关系分级累计制（userRepliesTotal 跨日不清：≥5 老熟人/≥2 眼熟/陌生）
//   ⑦字素级长度口径（emoji 不算 2）⑧超长硬拒→保留原意重生成一次→仍超跳过留痕
// 用法: node inbox-reply.js --account wcixot [--dry]
// 调度: Xops被动回复-才女 每 15 分钟（10-21 P1 提速拍板；脚本内守 07:00-22:00）。
// 刹车: PAUSE / 风控当日锁 / 健康快照；账本与 executor 共用（reply 帽 60）；只回复不关注；矩阵号不回。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { generateReply } = require('./llm');
const quality = require('./quality');
const { pickGreet, cachedLabel, storeBio } = require('./interaction');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', null);
const DRY = argv.includes('--dry');
if (!ACCOUNT) { console.error('用法: node inbox-reply.js --account <key> [--dry]'); process.exit(1); }
const ACCT = CFG.accounts.find((a) => a.key === ACCOUNT);
if (!ACCT) { console.error('config.accounts 无此账号: ' + ACCOUNT); process.exit(1); }
const IR = Object.assign({ greetHardLen: 12, lightHardLen: 20, perUserDay: 3, perRun: 10, hours: [7, 22] }, (CFG.inboxReply || {})[ACCOUNT] || {});
const OWN = new Set(CFG.accounts.map((a) => a.handle.toLowerCase())); // 自家矩阵号不自动回
const visLen = (s) => [...String(s)].length; // 字素级长度（emoji 不算 2，10-21 codex 口径）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (line) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'inboxReply', account: ACCOUNT, ...line }) + '\n'); };
const nowIso = () => new Date().toISOString();

// ── 状态：seenNotifs 去重（五出口标记，不在生成前标）+ 单用户日帽 + 关系累计制 ──
const ST_FILE = path.join(STATE_DIR, `inbox-${ACCOUNT}.json`);
function loadSt() { try { return { seenNotifs: {}, perUser: { date: today(), counts: {} }, userRepliesTotal: {}, ...JSON.parse(fs.readFileSync(ST_FILE, 'utf8')) }; } catch { return { seenNotifs: {}, perUser: { date: today(), counts: {} }, userRepliesTotal: {} }; } }
function saveSt(st) { const ks = Object.keys(st.seenNotifs); if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete st.seenNotifs[k]; fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(ST_FILE, JSON.stringify(st, null, 2)); }
function histAll() { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `taskstate-${ACCOUNT}.json`), 'utf8')).replyHistory || []; } catch { return []; } }

// ── 刹车门（与 executor/mutual-post 同语义） ──
function gate() {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) return 'PAUSE 急停生效';
  try { const led = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`), 'utf8')); if ((led.meta || {}).abortedToday === today()) return `风控当日锁(${(led.meta || {}).abortReason || ''})`; } catch { }
  for (const d of [today(), new Date(Date.now() - 86400000).toISOString().slice(0, 10)]) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'health-snapshots', `${d}.json`), 'utf8'));
      const e = snap.accounts && snap.accounts[ACCOUNT];
      if (e && ((e.verdict === 'suspended') || (e.profile && e.profile.state === 'suspended'))) return `健康门：suspended（快照 ${d}）`;
      if (e && e.statuses && (e.statuses.sensitiveCount || 0) > 0) return `健康门：敏感标记>0（快照 ${d}）`;
      if (e) return null;
    } catch { }
  }
  return null;
}

// ── 滚动账本（reply 帽 60 与 executor 共用） ──
function loadLedger() {
  let j = { actions: {}, meta: {} };
  try { j = { actions: {}, meta: {}, ...JSON.parse(fs.readFileSync(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`), 'utf8')) }; } catch { }
  const cut = Date.now() - 24 * 3600 * 1000;
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  return j;
}
const replyCap = () => (((CFG.executor || {}).rollingCaps || {}).reply) || 60;
function ledgerRecordReply() { const led = loadLedger(); (led.actions.reply = led.actions.reply || []).push(Date.now()); fs.writeFileSync(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`), JSON.stringify(led, null, 2)); }
function recordReply(entry) {
  try {
    const p = path.join(STATE_DIR, `taskstate-${ACCOUNT}.json`);
    let ts = null; try { ts = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
    ts = ts || { repliedAuthors: {}, repliedPosts: {}, replyHistory: [], tagIndex: 0 };
    ts.repliedAuthors[entry.targetHandle] = today(); ts.repliedPosts[entry.statusId] = today();
    ts.replyHistory.push(entry.text); if (ts.replyHistory.length > 50) ts.replyHistory = ts.replyHistory.slice(-50);
    fs.writeFileSync(p, JSON.stringify(ts, null, 2));
  } catch { }
}
function syncContactsReply(entry) {
  try {
    const p = path.join(STATE_DIR, `contacts-${ACCOUNT}.json`);
    if (!fs.existsSync(p)) return;
    const led = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = (entry.targetHandle || '').toLowerCase(); if (!h) return;
    const e = (led.people[h] = led.people[h] || { handle: h, name: null, firstSeen: nowIso(), updatedAt: null, sources: [], relation: { weFollow: null, theyFollow: null, mutual: false }, activity: { theirEvents: [], theirLastAt: null, ourReplies: 0, ourLastReplyAt: null }, eligibility: { blocked: null, gone: false }, score: 0, stage: 'contacted' });
    e.activity.ourReplies += 1; e.activity.ourLastReplyAt = today();
    if (!e.sources.includes('inbox')) e.sources.push('inbox');
    e.updatedAt = nowIso();
    fs.writeFileSync(p, JSON.stringify(led, null, 2));
  } catch { }
}
// 当场回关的关系落档（10-21 拍板"才女的路"）：weFollow 落档后天然防重复
function syncContactsFollow(entry) {
  try {
    const p = path.join(STATE_DIR, `contacts-${ACCOUNT}.json`);
    if (!fs.existsSync(p)) return;
    const led = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = (entry.targetHandle || '').toLowerCase(); if (!h) return;
    const e = (led.people[h] = led.people[h] || { handle: h, name: null, firstSeen: nowIso(), updatedAt: null, sources: [], relation: { weFollow: null, theyFollow: null, mutual: false }, activity: { theirEvents: [], theirLastAt: null, ourReplies: 0, ourLastReplyAt: null }, eligibility: { blocked: null, gone: false }, score: 0, stage: 'contacted' });
    e.relation.weFollow = { since: today(), via: 'inbox-followback' };
    if (!e.sources.includes('inbox')) e.sources.push('inbox');
    e.updatedAt = nowIso();
    fs.writeFileSync(p, JSON.stringify(led, null, 2));
  } catch { }
}
// ── 当场回关（10-21 用户拍板，取代台账式 7 天双条件）：回复成功→开对方主页→"关注了你"徽标在且我们未关注→回关。
// 不查任何档案/扫描，页面按钮态即真值；关注帽与全部关注动作共用滚动 100/天；失败不硬磕（对方下次评论自然再遇）
async function followBackIfFollowing(page, author) {
  try {
    await page.goto('https://x.com/' + author, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500 + Math.random() * 2000);
    const badge = await page.$('[data-testid="userFollowIndicator"]').catch(() => null);
    if (!badge) return { skip: '对方未关注我们，只回话' };
    if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) return { skip: '已关注过' };
    const btn = (await page.$$('button[data-testid$="-follow"]'))[0];
    if (!btn) return { skip: '关注按钮未找到' };
    const led = loadLedger();
    const cap = (((CFG.executor || {}).rollingCaps || {}).follow) || 100;
    if (((led.actions.follow || []).length) >= cap) return { skip: '滚动关注帽满(' + cap + ')' };
    try { const bb = await btn.boundingBox(); if (bb) await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.5, { steps: 5 }); } catch { }
    await btn.click();
    await sleep(1500 + Math.random() * 1000);
    if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) {
      (led.actions.follow = led.actions.follow || []).push(Date.now());
      fs.writeFileSync(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`), JSON.stringify(led, null, 2));
      return { ok: true };
    }
    return { fail: '点击后未生效' };
  } catch (e) { return { fail: String(e.message).slice(0, 60) }; }
}

// ── 账号锁（同文件协议） ──
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function lockWait() {
  const f = path.join(STATE_DIR, `lock-${ACCOUNT}.json`);
  const staleCut = Date.now() - (((CFG.executor || {}).lockStaleMinutes || 30) * 60000);
  for (let a = 1; a <= 16; a++) {
    let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
    if (!(j && j.pid && j.at > staleCut && pidAlive(j.pid))) { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), account: ACCOUNT, task: 'inboxReply' })); return f; }
    if (a === 16) throw new Error('账号锁等待超时');
    console.log(`[锁等待] ${ACCOUNT} 被 pid ${j.pid} 占用，75 秒后重试(${a}/16)`);
    await sleep(75000);
  }
}
const unlock = (f) => { try { fs.unlinkSync(f); } catch { } };

// ── 回复对方那条评论（executor.replyToPost 同流程）+ 临时页 bio 抓取 ──
const SEL = { article: 'article[data-testid="tweet"]', reply: '[data-testid="reply"]', replyBox: '[data-testid="tweetTextarea_0"]', toast: '[data-testid="toast"]' };
// 回复上下文绑定探针（10-22"回复变独立帖"事故修复，与 resident.js 同款）：
//   弹窗必含父帖 article（独立发帖弹窗没有——10-22 只读探针实测）；无弹窗仅接受目标帖 permalink 内联框
//   /home 主发帖框(tweetTextarea_0+tweetButtonInline 常驻)=独立帖通道，硬性拒发
function probeReplyComposer(sid, handle) {
  const boxSel = '[data-testid="tweetTextarea_0"]';
  const dlg = document.querySelector('[role="dialog"]');
  if (dlg && dlg.querySelector(boxSel)) {
    const art = dlg.querySelector('article');
    if (!art) return { ok: false, note: 'dialog无父帖卡片(独立发帖弹窗)' };
    if (handle) {
      const hit = [...art.querySelectorAll('a[href^="/"]')].some((a) => ((a.getAttribute('href') || '').split('/')[1] || '').toLowerCase() === handle);
      if (!hit) return { ok: false, note: 'dialog父帖作者非@' + handle };
    }
    return { ok: true, mode: 'dialog' };
  }
  const m = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  if (m && sid && m[1] === String(sid) && document.querySelector(boxSel)) return { ok: true, mode: 'inline' };
  return { ok: false, note: '无绑定composer(' + location.pathname + ')' };
}
// 误发独立帖旁证登记（10-22）：回复成功即登记，verify-reply.js 定时消费，双端点确认才告警进人工待办，不自动处置
function queueVerify(entry) {
  const f = path.join(STATE_DIR, `pending-verify-${ACCOUNT}.json`);
  let list = []; try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
  list.push({ at: nowIso(), text: String(entry.text || '').slice(0, 80), statusId: entry.statusId || null, target: entry.target || null, source: entry.source || null, checks: 0 });
  fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(list.slice(-50), null, 2));
}
async function withTempPage(browser, fn) {
  const pg = await browser.newPage();
  pg.on('dialog', (d) => d.accept().catch(() => { }));
  try { return await fn(pg); } finally { try { await pg.close(); } catch { } }
}
async function replyToComment(page, postUrl, statusId, text) {
  // 10-22 入口守卫：statusId 非法=硬性拒发
  if (!statusId || !/^\d+$/.test(String(statusId))) return { ok: false, note: 'statusId非法:' + String(statusId) };
  try { await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForSelector(SEL.article, { timeout: 45000 }); }
  catch { return { ok: false, note: '页面加载失败' }; }
  // 10-22 落地校验：被 X 软重定向到 /home 时后续检查全部形同虚设（主发帖框常驻）→独立帖通道；视为失败
  if (!(page.url() || '').includes('/status/' + statusId)) return { ok: false, note: '落地被重定向:' + (page.url() || '').slice(0, 60) };
  await sleep(2000 + Math.random() * 2500);
  let art = null;
  for (const a of await page.$$(SEL.article)) {
    if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), statusId).catch(() => false)) { art = a; break; }
  }
  if (!art) return { ok: false, note: '按 statusId 未找到目标帖' };
  const btn = await art.$(SEL.reply);
  if (!btn) return { ok: false, note: '回复按钮未找到' };
  const targetHandle = (((postUrl || '').match(/\/([^/]+)\/status\//) || [])[1] || '').toLowerCase() || null;
  try { const bb = await btn.boundingBox(); if (bb) await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.5, { steps: 5 }); } catch { }
  await btn.click();
  // 等"绑定回复上下文"出现（10-22：原只等任意输入框——/home 主发帖框恒存在，检查形同虚设）
  let gate = null;
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    gate = await page.evaluate(probeReplyComposer, String(statusId), targetHandle).catch(() => null);
    if (gate && gate.ok) break;
  }
  if (!gate || !gate.ok) return { ok: false, note: 'composer无回复绑定:' + ((gate && gate.note) || '探针异常') };
  const typed = await page.evaluate((sel, t, m) => {
    // 严格按闸给的作用域取框（10-22：旧兜底 all[last] 会把文字粘进 /home 主发帖框）
    const el = m === 'dialog' ? document.querySelector('[role="dialog"] ' + sel) : document.querySelector(sel);
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, SEL.replyBox, text, gate.mode).catch(() => false);
  if (!typed) return { ok: false, note: '输入失败' };
  await sleep(800);
  // 提交前绑定核验（10-22：宁可漏回，不可错发独立帖）
  const g2 = await page.evaluate(probeReplyComposer, String(statusId), targetHandle).catch(() => null);
  if (!g2 || !g2.ok) return { ok: false, note: '提交前绑定丢失:' + ((g2 && g2.note) || '探针异常') };
  const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false);
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    let b = null;
    if (dlg) { const btns = [...dlg.querySelectorAll('[data-testid="tweetButton"]')]; b = btns[btns.length - 1]; }
    else b = document.querySelector('[data-testid="tweetButtonInline"]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click(); return true;
  }).catch(() => false);
  if (!clicked) return { ok: false, note: '提交按钮不可点' };
  const okToast = (t) => /已发送|发过了|送信|already|posted|sent/i.test(t || '');
  let lastToast = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await page.evaluate(() => { const box = document.querySelector('[data-testid="tweetTextarea_0"]'); return { dlg: !!document.querySelector('[role="dialog"]'), toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(), boxLen: box && box.textContent ? box.textContent.length : 0 }; }).catch(() => null);
    if (!st) continue;
    lastToast = st.toast;
    if (okToast(st.toast)) return { ok: true };
    if (hasDialog && !st.dlg) return { ok: false, unknown: true, note: '弹窗关闭未见气泡' };
    if (!hasDialog && st.boxLen === 0) return { ok: false, unknown: true, note: '输入框已清空未见气泡' };
  }
  return { ok: false, note: '超时未见成功气泡' + (lastToast ? '（末气泡:' + lastToast.slice(0, 20) + '）' : '') };
}

(async () => {
  const hour = new Date().getHours();
  if (hour < IR.hours[0] || hour >= IR.hours[1]) { console.log(`非授权时段(${IR.hours[0]}-${IR.hours[1]})，退出`); process.exit(0); }
  const g = gate();
  if (g) { console.log('刹车：' + g); log({ action: 'skip', note: g }); process.exit(0); }
  const led0 = loadLedger();
  if ((led0.actions.reply || []).length >= replyCap()) { console.log(`滚动回复帽已满(${replyCap()})，本轮跳过`); log({ action: 'skip', note: '滚动回复帽满' }); process.exit(0); }
  const st = loadSt();
  if (st.perUser.date !== today()) st.perUser = { date: today(), counts: {} };

  const lockF = DRY ? null : await lockWait();
  let browser = null, ws = null;
  const stats = { seen: 0, fresh: 0, replied: 0, failed: 0, skippedOwn: 0, skippedCap: 0, todo: 0, greetTpl: 0, followBack: 0, fbSkip: 0, fbFail: 0 };
  try {
    const oj = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
    if (!oj.success) throw new Error('开窗失败: ' + JSON.stringify(oj));
    ws = oj.data.ws;
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 90000 });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框（10-20 真凶）
    await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
    await page.goto('https://x.com/notifications/mentions', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let got = await page.waitForSelector(SEL.article, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!got) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { }); got = await page.waitForSelector(SEL.article, { timeout: 15000 }).then(() => true).catch(() => false); }
    if (!got) { console.log('提及页无条目（或加载失败），本轮收工'); log({ action: 'poll', note: '无条目' }); }
    else {
      await sleep(2500);
      for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy({ top: 700 + Math.floor(Math.random() * 300), behavior: 'smooth' })).catch(() => { }); await sleep(1200); }
      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 25).map((n) => {
          const link = n.querySelector('a[href*="/status/"]');
          const nameEl = n.querySelector('[data-testid="User-Name"] a[href^="/"]');
          const textEl = n.querySelector('[data-testid="tweetText"]');
          return { href: link ? link.getAttribute('href') : null, author: nameEl ? (nameEl.getAttribute('href') || '').replace('/', '').split('/')[0] : null, txt: (textEl ? (textEl.textContent || '') : '').replace(/\s+/g, ' ').trim().slice(0, 200) };
        });
      }).catch(() => []);
      stats.seen = items.length;
      let bioFetches = 0; // bio 惰性抓取每轮 ≤2（fullwin 10-21 补修②：防队列饥饿）
      const hist = histAll();
      for (const it of items) {
        if (!it.href || !it.author) continue;
        const isReplyMention = /回复|回覆|reply|返信|提到|mention|提及|メンション/i.test(it.txt)
          || !it.href.toLowerCase().includes('/' + ACCT.handle.toLowerCase() + '/');
        if (!isReplyMention) continue;
        if (OWN.has(it.author.toLowerCase())) { stats.skippedOwn++; continue; }
        const key = it.href + '|' + it.author.toLowerCase();
        const prev = st.seenNotifs[key];
        if (prev && !(prev.status === 'genFail' && !prev.retried)) continue; // genFail 一次重试；其余终态
        if (prev) prev.retried = true;
        if (stats.replied >= IR.perRun) break;
        stats.fresh++;
        const statusId = (it.href.match(/status\/(\d+)/) || [])[1];
        if (!statusId) { st.seenNotifs[key] = { at: nowIso(), status: 'badlink' }; continue; }
        if (!it.txt || it.txt.length < 2) { st.seenNotifs[key] = { at: nowIso(), status: 'empty' }; continue; }
        const uc = st.perUser.counts[it.author.toLowerCase()] || 0;
        if (uc >= IR.perUserDay) { st.seenNotifs[key] = { at: nowIso(), status: 'userCap' }; stats.skippedCap++; log({ action: 'skip', target: it.author, note: '单用户日帽' }); continue; }

        // ── 分场景分类器（10-21 fullwin v3 移植，regex 含 codex 边界修正照抄） ──
        const txt0 = (it.txt || '').replace(/^(@\w+\s*)+/, '').trim();
        const hasQWord = /怎么|为什么|什么|哪|如何|能不能|是不是|讲讲|说说|分析|解释|止损|仓位|建议|看法|怎么看|什么渠道|怎么开/.test(txt0);
        const hasQ = /[？?]/.test(txt0);
        const isGreet = /来了|来咯|欢迎|大佬好|膜拜|互关|回关|关注你|关注了|已关注|回访|支持一波|报到|串门|顶|前排|围观|做大做强|兄弟|学习|不错|可以|强|牛|厉害|早上好|早安|晚安|好呀/.test(txt0) && visLen(txt0) <= 24 && !(hasQWord && (hasQ || visLen(txt0) > 10));
        const isQuestion = (hasQWord && (hasQ || visLen(txt0) >= 6)) || /讲讲|说说|分析|解释/.test(txt0);
        if (isQuestion) {
          // 实质提问→人工待办（human-todo-<账号>.json，与 fullwin 常驻同构，进飞书"待你人工回复"段）
          const todoFile = path.join(STATE_DIR, `human-todo-${ACCOUNT}.json`);
          let todo = { pending: [] };
          try { todo = JSON.parse(fs.readFileSync(todoFile, 'utf8')); if (!Array.isArray(todo.pending)) todo.pending = []; } catch { }
          todo.pending.push({ at: nowIso(), author: it.author, text: txt0.slice(0, 120), postUrl: 'https://x.com' + it.href, statusId, status: 'pending' });
          fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(todoFile, JSON.stringify(todo, null, 2));
          st.seenNotifs[key] = { at: nowIso(), status: 'humanTodo' }; saveSt(st);
          stats.todo++; log({ action: 'humanTodo', target: it.author, note: '实质提问转人工: ' + txt0.slice(0, 30) });
          console.log(`📋 转人工待办 @${it.author}: ${txt0.slice(0, 30)}`);
          continue;
        }
        const scene = isGreet ? 'greet' : 'light';
        // bio 惰性抓取（缓存 7 天 interaction.js 管；本轮 ≤2）
        let greetLabel = cachedLabel(ACCOUNT, it.author) || null;
        if (!greetLabel && bioFetches < 2 && !DRY) {
          bioFetches++;
          try {
            greetLabel = await withTempPage(browser, async (pg) => {
              await pg.goto('https://x.com/' + it.author, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
              await sleep(1500);
              return pg.evaluate(() => { const el = document.querySelector('[data-testid="UserDescription"]'); return el ? el.textContent.trim().slice(0, 160) : ''; }).catch(() => '');
            });
            greetLabel = greetLabel ? storeBio(ACCOUNT, it.author, greetLabel) : null;
          } catch { greetLabel = null; }
        }
        // 招呼场景：模板库 0-LLM 真光速（quality casual 档 + 硬门校验）
        if (scene === 'greet') {
          const recentSet = new Set(hist.slice(-24));
          const tmpl = pickGreet(greetLabel, recentSet);
          if (tmpl) {
            const tc = quality.check(tmpl, { casual: true, history: hist });
            if (tc.ok && visLen(tc.cleaned) <= IR.greetHardLen) {
              if (DRY) { console.log(`[DRY] 模板回复 @${it.author}: ${tc.cleaned}`); st.seenNotifs[key] = { at: nowIso(), status: 'dry' }; continue; }
              // 场景化延迟（10-21 P1-③，fullwin 批3 移植）：greet 快回/light 想一下再回；inline 发送架构取短版防积压
              await sleep(scene === 'greet' ? rand(10000, 45000) : rand(60000, 180000));
              let rr = await replyToComment(page, 'https://x.com' + it.href, statusId, tc.cleaned).catch((e) => ({ ok: false, note: e.message }));
              if (rr.ok) {
                st.seenNotifs[key] = { at: nowIso(), status: 'done' };
                st.perUser.counts[it.author.toLowerCase()] = uc + 1;
                st.userRepliesTotal = st.userRepliesTotal || {}; st.userRepliesTotal[it.author.toLowerCase()] = (st.userRepliesTotal[it.author.toLowerCase()] || 0) + 1;
                ledgerRecordReply(); recordReply({ targetHandle: it.author, statusId, text: tc.cleaned }); syncContactsReply({ targetHandle: it.author });
                queueVerify({ text: tc.cleaned, statusId, target: it.author, source: 'inboxReply-模板' });
                stats.replied++; stats.greetTpl++;
                log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: 'done', note: '模板', text: tc.cleaned.slice(0, 60) });
                console.log(`✅[模板] 已回 @${it.author}: ${tc.cleaned}`);
                // 当场回关（10-21 拍板"才女的路"）：回复成功→开主页→"关注了你"徽标在且未关注→回关
                await sleep(rand(2000, 5000));
                const fb = await followBackIfFollowing(page, it.author);
                if (fb.ok) { syncContactsFollow({ targetHandle: it.author }); stats.followBack++; log({ action: 'followBack', target: it.author, status: 'done', note: '回复+对方已关注→当场回关' }); console.log(`🤝 已回关 @${it.author}`); }
                else if (fb.skip) { stats.fbSkip++; log({ action: 'followBack', target: it.author, status: 'skip', note: fb.skip }); }
                else { stats.fbFail++; log({ action: 'followBack', target: it.author, status: 'failed', note: fb.fail }); }
                saveSt(st); await sleep(rand(15000, 35000));
                continue;
              }
              console.log(`❌[模板] 发送失败 @${it.author}: ${rr.note}，落 LLM 路径`);
              log({ action: 'tplSendFail', target: it.author, note: rr.note });
            }
          }
          // 模板耗尽/未过门/发送失败 → 落 LLM 兜底（走下方生成路径）
        }
        // ── LLM 生成（轻内容主路径；关系分级 brief + few-shot 节奏锚 + 超长重生成） ──
        const hardCap = scene === 'greet' ? IR.greetHardLen : IR.lightHardLen;
        const totalN = ((st.userRepliesTotal || {})[it.author.toLowerCase()] || 0);
        const rel = totalN >= 5 ? '老熟人（可镜像反捧、开轻玩笑、称兄道弟）' : totalN >= 2 || uc >= 1 ? '眼熟（可加社区黑话和 emoji）' : '陌生人（客气短句，不玩梗不称兄道弟）';
        const target = scene === 'greet'
          ? `4-${IR.greetHardLen - 2} 个字，像手机上顺手回的一句${greetLabel ? '（对方是' + greetLabel + '，可带上称呼）' : ''}；对方是${rel}`
          : `8-${IR.lightHardLen - 4} 个字，一句话点到对方说的具体内容；对方是${rel}`;
        const brief = `这是一条对方发在我们帖子下的评论，作为楼主回应对方；回复 ${target}。风格参考（只学节奏不复用内容）：真人回复像随手打的——'哈哈，互相学习' '来了兄弟' '确实，这波我认'——口语、短促、不书面、不总结。`;
        const tryGen = async (extra) => {
          const r = await generateReply({ post: it.txt, author: it.author, persona: (CFG.personas || {})[ACCOUNT], brief: brief + (extra || ''), history: hist.slice(-8), maxLen: hardCap }).catch((e) => { console.log('LLM 失败: ' + String(e.message).slice(0, 80)); return null; });
          if (!r || !r.text) return null;
          const qc = quality.check(r.text, { history: hist, casual: true });
          return qc.ok ? qc : { ok: false, reason: qc.reason, cleaned: qc.cleaned };
        };
        let qc = await tryGen();
        if (qc && qc.ok && visLen(qc.cleaned) > hardCap) {
          log({ action: 'replyLen', target: it.author, note: `${scene}超长${visLen(qc.cleaned)}字素重生成` });
          qc = await tryGen(`上一版超长了，保留原意压缩到 ${hardCap} 字以内，压不了就别说。`);
        }
        if (qc && qc.ok && visLen(qc.cleaned) > hardCap) { log({ action: 'replyLen', target: it.author, note: `${scene}仍超长跳过(${visLen(qc.cleaned)}字素)` }); st.seenNotifs[key] = { at: nowIso(), status: 'tooLong' }; saveSt(st); continue; }
        if (!qc || !qc.ok) {
          if (DRY) { console.log(`[DRY] 生成未过门(@${it.author})，跳过`); continue; } // DRY 不写台账不标记
          log({ action: 'genFail', target: it.author, note: qc ? qc.reason : 'LLM失败' });
          st.seenNotifs[key] = { at: nowIso(), status: 'genFail' }; saveSt(st); continue;
        }
        if (DRY) { console.log(`[DRY] 应回复 @${it.author}（${scene}）: ${qc.cleaned}`); st.seenNotifs[key] = { at: nowIso(), status: 'dry' }; continue; }
        // 场景化延迟（同上：greet 快回 / light 想一下再回）
        await sleep(scene === 'greet' ? rand(10000, 45000) : rand(60000, 180000));
        let rr = await replyToComment(page, 'https://x.com' + it.href, statusId, qc.cleaned).catch((e) => ({ ok: false, note: e.message }));
        if (!rr.ok && !rr.unknown && /Protocol error|timed out|TimeoutError|net::|ERR_/i.test(rr.note || '')) { await sleep(8000); rr = await replyToComment(page, 'https://x.com' + it.href, statusId, qc.cleaned).catch((e) => ({ ok: false, note: e.message + '（重试后仍败）' })); }
        const toast = await page.evaluate((sel) => { const t = document.querySelector(sel); return t ? (t.textContent || '').trim().slice(0, 80) : null; }, SEL.toast).catch(() => null);
        if (toast && /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block/i.test(toast)) {
          const led = loadLedger(); led.meta = led.meta || {}; led.meta.abortedToday = today(); led.meta.abortReason = '风控toast(被动回复): ' + toast;
          fs.writeFileSync(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`), JSON.stringify(led, null, 2));
          st.seenNotifs[key] = { at: nowIso(), status: 'abortToast' }; saveSt(st);
          log({ action: 'abort', note: '风控toast: ' + toast });
          console.log('⚠ 风控 toast，当日锁：' + toast);
          break;
        }
        if (rr.ok) {
          st.seenNotifs[key] = { at: nowIso(), status: 'done' };
          st.perUser.counts[it.author.toLowerCase()] = uc + 1;
          st.userRepliesTotal = st.userRepliesTotal || {}; st.userRepliesTotal[it.author.toLowerCase()] = (st.userRepliesTotal[it.author.toLowerCase()] || 0) + 1;
          ledgerRecordReply(); recordReply({ targetHandle: it.author, statusId, text: qc.cleaned }); syncContactsReply({ targetHandle: it.author });
          queueVerify({ text: qc.cleaned, statusId, target: it.author, source: 'inboxReply-LLM' });
          stats.replied++;
          log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: 'done', text: qc.cleaned.slice(0, 60) });
          console.log(`✅ 已回 @${it.author}: ${qc.cleaned}`);
          // 当场回关（10-21 拍板"才女的路"，同模板路径）
          await sleep(rand(2000, 5000));
          const fb = await followBackIfFollowing(page, it.author);
          if (fb.ok) { syncContactsFollow({ targetHandle: it.author }); stats.followBack++; log({ action: 'followBack', target: it.author, status: 'done', note: '回复+对方已关注→当场回关' }); console.log(`🤝 已回关 @${it.author}`); }
          else if (fb.skip) { stats.fbSkip++; log({ action: 'followBack', target: it.author, status: 'skip', note: fb.skip }); }
          else { stats.fbFail++; log({ action: 'followBack', target: it.author, status: 'failed', note: fb.fail }); }
        } else {
          st.seenNotifs[key] = { at: nowIso(), status: rr.unknown ? 'unknown' : 'failed', note: (rr.note || '').slice(0, 80) }; // unknown/failed 不重试（评论重复比漏回糟）
          stats.failed++;
          log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: rr.unknown ? 'unknown' : 'failed', note: rr.note });
          console.log(`${rr.unknown ? '⏳ 结果不明' : '❌ 失败'} @${it.author}: ${rr.note}`);
        }
        saveSt(st);
        await sleep(rand(20000, 50000));
      }
    }
  } finally {
    if (browser) { try { const ps = await browser.pages(); for (let i = 1; i < ps.length; i++) { try { await ps[i].close(); } catch { } } } catch { } await browser.disconnect(); }
    if (ws) await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { });
    if (lockF) unlock(lockF);
    saveSt(st);
  }
  log({ action: 'pollEnd', ...stats });
  console.log(`本轮：扫 ${stats.seen}，新 ${stats.fresh}，回 ${stats.replied}（模板 ${stats.greetTpl}），回关 ${stats.followBack}（跳过 ${stats.fbSkip} 败 ${stats.fbFail}），转人工 ${stats.todo}，败 ${stats.failed}，自家跳过 ${stats.skippedOwn}，日帽跳过 ${stats.skippedCap}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
