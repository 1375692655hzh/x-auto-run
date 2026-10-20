// resident.js — fullwin 常驻运营进程（10-20 拍板）：08:00~23:00 一窗三页
//   页1 光速回复：5min 轮询通知页，新回复/提及 → mimo 生成 → 随机延迟 1-10min 发出（自家矩阵号不自动回，用户手动管）
//   页2 话题巡逻：只做 #蓝V互关，每 8-15min 一轮，每轮最多 4 条评论（无日帽，供给约束），先关注后回复
//   页3 互关帖：每 60-85min（1h±0~25min）一条，tag=用户六话题，素材取近 1h 话题帖参考
//   云端 Fullwin777 内容照常：09:35/12:35/19:35 拉取滴灌并入本进程发布（帖帽 35/天 与互关帖共享）
// LLM 锁定 mimo 通道（用户拍板）；熔断（风控toast 当日停）/PAUSE/滚动账本/审计全接入。
// 用法: node resident.js --account fullwin [--dry] [--watchdog]（看门狗模式：心跳超时则拉起常驻）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateReply } = require('./llm');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const WATCHDOG = argv.includes('--watchdog');
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'fullwin');
const ACCT = (CFG.accounts || []).find((a) => a.key === ACCOUNT);
const RC = Object.assign({
  startHour: 8, endHour: 23,
  replyPollMin: 5, replyDelayMin: [1, 10],
  patrolTopic: '蓝V互关', patrolGapMin: [8, 15], patrolPerRound: 4,
  postGapMin: [60, 85], postTags: ['#蓝V互关', '#蓝朋友', '#浇朋友', '#浇个朋友', '#交个朋友', '#交朋友'],
  cloudSlots: ['09:35', '12:35', '19:35'], cloudGapMin: [2, 8],
  llmChannel: 'mimo', postCapDay: 35, replyCapDay: 60, followCapDay: 100,
}, ((CFG.resident || {})[ACCOUNT] || {}));
const OWN = new Set((CFG.accounts || []).map((a) => a.handle.toLowerCase()));
const L = CFG.limits || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const nowIso = () => new Date().toISOString();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), task: 'resident', account: ACCOUNT, ...obj }) + '\n'); }

// ── 滚动账本（与 executor 同文件同格式，24h 滚动） ──
const LEDGER_FILE = path.join(STATE_DIR, `ledger-${ACCOUNT}.json`);
function loadLedger() {
  const cut = Date.now() - 24 * 3600000;
  let j = readJson(LEDGER_FILE, { actions: {}, meta: {} });
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  return j;
}
function ledgerRecord(type) { const j = loadLedger(); (j.actions[type] = j.actions[type] || []).push(Date.now()); writeJson(LEDGER_FILE, j); }
function usedToday(type) { const cut = new Date(); cut.setHours(0, 0, 0, 0); return (loadLedger().actions[type] || []).filter((ts) => ts > cut.getTime()).length; }

// ── 常驻状态（去重/心跳/游标） ──
const ST_FILE = path.join(STATE_DIR, `resident-${ACCOUNT}.json`);
function loadSt() { return readJson(ST_FILE, { heartbeatAt: null, seenNotifs: {}, seenPosts: {}, lastCloudSlot: {}, material: [], day: null }); }
function saveSt(s) { writeJson(ST_FILE, s); }

// ── 浏览器原语（自 executor 移植：选择器/输入/提交/toast/关注——常驻进程独立持有窗口，不与 executor 共用会话） ──
const SEL = { article: 'article[data-testid="tweet"]', reply: '[data-testid="reply"]', replyBox: '[data-testid="tweetTextarea_0"]', like: '[data-testid="like"]', unlike: '[data-testid="unlike"]', toast: '[data-testid="toast"]' };
const RISK_TOAST = /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block|エラー|もう一度|制限|できません/i;
async function readToast(page) { return page.evaluate((sel) => { const t = document.querySelector(sel); return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null; }, SEL.toast).catch(() => null); }
async function riskToast(page) { const t = await readToast(page); return (t && RISK_TOAST.test(t)) ? t : null; }
async function humanClick(page, handle) {
  try { const bb = await handle.boundingBox(); if (bb) { await page.mouse.move(bb.x + bb.width * (0.3 + Math.random() * 0.4), bb.y + bb.height * (0.3 + Math.random() * 0.4), { steps: 6 + Math.floor(Math.random() * 8) }); await sleep(rand(600, 1400)); } } catch { }
  await handle.click();
}
async function verifyLogin(page, handle) {
  try {
    await page.waitForSelector('a[data-testid="AppTabBar_Profile_Link"]', { timeout: 15000 });
    const href = await page.evaluate(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); return a ? a.getAttribute('href') : null; }).catch(() => null);
    if (href && href.toLowerCase() === '/' + handle.toLowerCase()) return true;
  } catch { }
  return false;
}
async function typeReply(page, text) {
  return page.evaluate((sel, t) => {
    const all = document.querySelectorAll(sel);
    const el = document.querySelector('[role="dialog"] ' + sel) || all[all.length - 1];
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, SEL.replyBox, text).catch(() => false);
}
async function submitReply(page) {
  const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false);
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    let b = null;
    if (dlg) { const btns = [...dlg.querySelectorAll('[data-testid="tweetButton"]')]; b = btns[btns.length - 1]; }
    else b = document.querySelector('[data-testid="tweetButtonInline"]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click(); return true;
  }).catch(() => false);
  if (!clicked) return false;
  const readSt = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="tweetTextarea_0"]');
    return { dlg: !!document.querySelector('[role="dialog"]'), toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(), boxLen: box && box.textContent ? box.textContent.length : 0 };
  }).catch(() => null);
  const okToast = (t) => /已发送|发过了|送信|already|posted|sent/i.test(t || '');
  const waitToast = async (ms) => { for (let j = 0; j < Math.ceil(ms / 500); j++) { await sleep(500); const s2 = await readSt(); if (s2 && okToast(s2.toast)) return true; } return false; };
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await readSt();
    if (!st) continue;
    if (okToast(st.toast)) return true;
    if (hasDialog && !st.dlg) return (await waitToast(4000)) || 'unknown';
    if (!hasDialog && st.boxLen === 0) return (await waitToast(4000)) || 'unknown';
  }
  return false;
}
async function gotoFeed(page, url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForSelector(SEL.article, { timeout: 45000 }); return true; }
    catch { }
    if (await page.$(SEL.article).catch(() => null)) return true;
    if (i < tries - 1) await sleep(3000);
  }
  return !!(await page.$(SEL.article).catch(() => null));
}
async function findArticleByStatus(page, statusId) {
  for (const a of await page.$$(SEL.article)) {
    if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), statusId).catch(() => false)) return a;
  }
  return null;
}
async function replyOnPage(page, statusId, postUrl, text) {
  if (!(await gotoFeed(page, postUrl))) return { ok: false, note: '页面加载失败' };
  await sleep(rand(3000, 6000));
  const art = await findArticleByStatus(page, statusId);
  if (!art) return { ok: false, note: '未找到目标帖' };
  const btn = await art.$(SEL.reply);
  if (!btn) return { ok: false, note: '回复按钮未找到' };
  await humanClick(page, btn);
  await page.waitForSelector(SEL.replyBox, { timeout: 10000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  if (!(await typeReply(page, text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page);
  return { ok: r === true, unknown: r === 'unknown', raw: r };
}
async function postOnPage(page, text) {
  try { await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch { return { ok: false, note: '发布页加载失败' }; }
  await page.waitForSelector(SEL.replyBox, { timeout: 20000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  if (!(await typeReply(page, text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page);
  if (r !== true) return { ok: r === true, unknown: r === 'unknown' };
  const toast = await readToast(page);
  return { ok: true, note: /发过|already/i.test(toast || '') ? '已存在(重复)' : '新发' };
}
async function followOnPage(page, handle2) {
  if (!(await gotoFeed(page, 'https://x.com/' + handle2))) return { ok: false, note: '主页加载失败' };
  await sleep(rand(2000, 4000));
  const btn = (await page.$$('button[data-testid$="-follow"]'))[0];
  if (!btn) return { ok: false, note: '关注按钮未找到(可能已关注)' };
  await humanClick(page, btn);
  await sleep(1500);
  if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) return { ok: true };
  return { ok: false, unknown: true, note: '关注未确认' };
}
async function collectPosts(page, limit = 30) {
  return page.evaluate((limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, limit).map((art) => {
      const link = art.querySelector('a[href*="/status"]');
      const time = art.querySelector('time');
      const text = art.querySelector('[data-testid="tweetText"]');
      const nameEl = art.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const locked = /subscribe to unlock|订阅解锁|ロック解除/i.test(art.textContent || '');
      return {
        id: (link && (link.getAttribute('href') || '').match(/status\/(\d+)/) || [])[1] || null,
        link: link ? link.getAttribute('href') : null,
        time: time ? time.getAttribute('datetime') : null,
        author: nameEl ? (nameEl.getAttribute('href') || '').replace('/', '').split('/')[0] : null,
        text: text ? clean(text.textContent).slice(0, 280) : '',
        locked,
      };
    }).filter((p) => p.id && p.author);
  }, limit).catch(() => []);
}

// ── 动作隔离与瞬态重试（10-20：巡逻 8/8 轮协议挂起的修复） ──
async function withTempPage(bro, fn) { // bro=浏览器实例由调用方传入（模块级定义拿不到主流程的 browser——14:14 实战踩坑）
  const pg = await bro.newPage();
  await pg.setViewport({ width: 1400 + randi(0, 80), height: 900 });
  try { return await fn(pg); } finally { try { await pg.close(); } catch { } }
}
async function retryTransient(fn) {
  let r = await fn().catch((e) => ({ ok: false, note: 'EXC:' + String(e.message).slice(0, 60) }));
  if (!r.ok && /Protocol error|timed out|TimeoutError|net::|ERR_/i.test(r.note || '')) {
    LOG('瞬态错误，5s 后重试一次: ' + String(r.note).slice(0, 40));
    await sleep(5000);
    r = await fn().catch((e) => ({ ok: false, note: 'EXC重试:' + String(e.message).slice(0, 60) }));
  }
  return r;
}

// ── 看门狗模式 ──
if (WATCHDOG) {
  (async () => {
    const st = loadSt();
    const fresh = st.heartbeatAt && Date.now() - Date.parse(st.heartbeatAt) < 20 * 60000;
    const hour = new Date().getHours();
    if (fresh || hour < RC.startHour || hour >= RC.endHour) { LOG(`看门狗：${fresh ? '常驻心跳正常' : '不在时段'}，不动`); process.exit(0); }
    LOG('看门狗：心跳超时，拉起常驻进程');
    const { spawn } = require('child_process');
    const child = require('child_process').spawn('cmd', ['/c', path.join(ROOT, `定时-常驻-${ACCOUNT}.bat`)], { detached: true, stdio: 'ignore', cwd: ROOT }); // 拉 bat 才有日志重定向（10-20 修复：直 spawn node 导致常驻无日志）
    child.unref();
    audit({ action: 'watchdogRelaunch' });
  })();
  return;
}

// ══ 主流程 ══
(async () => {
  if (!ACCT) { console.error('config.accounts 无此账号'); process.exit(1); }
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效，退出'); process.exit(0); }
  const led = loadLedger();
  if (led.meta.abortedToday === today()) { console.error(`今日已熔断(${led.meta.abortReason || ''})，不启动`); process.exit(1); }
  const hour = new Date().getHours();
  if (hour < RC.startHour || hour >= RC.endHour) { console.error(`不在常驻时段 ${RC.startHour}:00-${RC.endHour}:00`); process.exit(0); }

  LOG(`常驻启动：@${ACCT.handle}，三页面（回复/巡逻/发布），LLM=${RC.llmChannel}，帖帽${RC.postCapDay} 回复帽${RC.replyCapDay}`);
  const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
  if (!j.success) { console.error('开窗失败:', JSON.stringify(j).slice(0, 100)); process.exit(1); }
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null, protocolTimeout: 90000 });
  try { const ps0 = await browser.pages(); for (let i = 1; i < ps0.length; i++) { try { await ps0[i].close(); } catch { } } } catch { } // 清理上次异常退出留下的孤儿页
  const pageReply = await browser.newPage(); await pageReply.setViewport({ width: 1400 + randi(0, 120), height: 900 });
  const pageTopic = await browser.newPage(); await pageTopic.setViewport({ width: 1400 + randi(0, 120), height: 900 });
  const pagePost = await browser.newPage(); await pagePost.setViewport({ width: 1400 + randi(0, 120), height: 900 });
  await pageReply.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
  if (!(await verifyLogin(pageReply, ACCT.handle))) { console.error('登录态校验失败'); await cleanup(); process.exit(1); }

  const st = loadSt();
  if (st.day !== today()) { st.seenNotifs = {}; st.seenPosts = {}; st.lastCloudSlot = {}; st.day = today(); }
  let aborted = false;
  const sendQueue = []; // {kind, statusId, postUrl, author, text, sendAt}
  let nextReplyPoll = Date.now() + 60 * 1000;
  let nextPatrol = Date.now() + rand(60, 180) * 1000;
  let nextPost = Date.now() + rand(3, 10) * 60000; // 启动后先热身，不立即发
  const endAt = new Date(); endAt.setHours(RC.endHour, 0, 0, 0);

  async function checkAbort(page, where) {
    const t = await riskToast(page);
    if (t) {
      aborted = true;
      const lg = loadLedger(); lg.meta.abortedToday = today(); lg.meta.abortReason = '风控toast(' + where + '): ' + t; writeJson(LEDGER_FILE, lg);
      audit({ action: 'abort', note: where + ': ' + t });
      LOG('⚠ 风控 toast，当日熔断退出: ' + t);
    }
    return aborted;
  }
  async function cleanup() {
    try { const ps = await browser.pages(); for (let i = 3; i < ps.length; i++) { try { await ps[i].close(); } catch { } } } catch { }
    try { await browser.disconnect(); } catch { }
    await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { });
  }

  // ── 页1：光速回复轮询（通知页） ──
  async function pollNotifications() {
    try {
      await pageReply.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pageReply.waitForSelector('[data-testid="notification"]', { timeout: 20000 }).catch(() => { });
      await sleep(2500);
      const items = await pageReply.evaluate(() => {
        return [...document.querySelectorAll('[data-testid="notification"]')].slice(0, 25).map((n) => {
          const link = n.querySelector('a[href*="/status/"]');
          const nameEl = n.querySelector('a[href^="/"]:not([href*="/status/"])');
          const txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
          return { href: link ? link.getAttribute('href') : null, author: nameEl ? (nameEl.getAttribute('href') || '').replace('/', '').split('/')[0] : null, txt: txt.slice(0, 200) };
        });
      }).catch(() => []);
      let queued = 0;
      for (const it of items) {
        if (!it.href || !it.author) continue;
        const isReplyMention = /回复|回覆|reply|提到|mention|提及/i.test(it.txt);
        if (!isReplyMention) continue;
        if (OWN.has(it.author.toLowerCase())) continue; // 自家矩阵号不自动回（用户手动管，防互吹自动化）
        const key = it.href + '|' + it.author.toLowerCase();
        if (st.seenNotifs[key]) continue;
        st.seenNotifs[key] = nowIso();
        if (DRY) { LOG(`[DRY] 应回复 @${it.author} 的通知 ${it.href}`); continue; }
        const postUrl = 'https://x.com' + it.href;
        const statusId = (it.href.match(/status\/(\d+)/) || [])[1];
        const r = await generateReply({ post: it.txt, author: it.author, persona: (CFG.personas || {})[ACCOUNT], brief: '这是一条对方发给我们（回复或提及）的消息，作为帖子主人礼貌、具体地回应对方。', history: [], channel: RC.llmChannel }).catch(() => null);
        const qc = r && r.text ? quality.check(r.text, {}) : null;
        if (qc && qc.ok) {
          sendQueue.push({ kind: 'replyInbox', statusId, postUrl, author: it.author, text: qc.cleaned, sendAt: Date.now() + rand(RC.replyDelayMin[0], RC.replyDelayMin[1]) * 60000 });
          queued++;
        } else audit({ action: 'replyGen', note: `@${it.author} 生成未过门(${qc ? qc.reason : 'LLM失败'})` });
      }
      if (queued) LOG(`页1：${queued} 条新回复入延迟队列（1-10min 随机发出）`);
    } catch (e) { LOG('页1 轮询异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 页2：话题巡逻（#蓝V互关 新帖评论） ──
  async function patrol() {
    try {
      await pageTopic.goto(`https://x.com/search?q=${encodeURIComponent('#' + RC.patrolTopic)}&f=live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pageTopic.waitForSelector(SEL.article, { timeout: 30000 }).catch(() => { });
      await sleep(3000);
      for (let i = 0; i < 3; i++) { await pageTopic.evaluate(() => window.scrollBy({ top: 600 + Math.floor(Math.random() * 400), behavior: 'smooth' })).catch(() => { }); await sleep(rand(800, 1500)); }
      const posts = await collectPosts(pageTopic, 25);
      const fresh = posts.filter((p) => !st.seenPosts[p.id] && !OWN.has((p.author || '').toLowerCase()) && !p.locked);
      for (const p of posts) st.seenPosts[p.id] = nowIso();
      st.material = posts.map((p) => ({ id: p.id, author: p.author, text: p.text, time: p.time })).slice(0, 12); // 页3 素材（近 1h 参考用）
      // 同作者每轮只取一条（10-20 拍板方案二）：先按作者去重再取每轮上限，活跃作者（顶帖党）一轮最多吃一条
      const seenAuth = new Set();
      const take = fresh.filter((p) => { const a = (p.author || '').toLowerCase(); if (seenAuth.has(a)) return false; seenAuth.add(a); return true; }).slice(0, RC.patrolPerRound);
      LOG(`页2：#${RC.patrolTopic} 本轮新帖 ${fresh.length} 条，取 ${take.length} 条评论`);
      for (const p of take) {
        if (aborted || usedToday('reply') >= RC.replyCapDay) break;
        const r = await generateReply({ post: p.text, author: p.author, persona: (CFG.personas || {})[ACCOUNT], brief: '这是互关话题帖；真诚回应他帖子的具体内容，自然表达希望互相关注、常来往（不要声称已关注）。', history: [], channel: RC.llmChannel }).catch(() => null);
        const qc = r && r.text ? quality.check(r.text, {}) : null;
        if (!(qc && qc.ok)) { audit({ action: 'patrolGen', target: p.author, note: `生成未过门(${qc ? qc.reason : 'LLM失败'})，跳过` }); continue; }
        if (DRY) { LOG(`[DRY] 应评论 @${p.author}: ${qc.cleaned.slice(0, 30)}…`); continue; }
        // 动作隔离（10-20 用户建议）：每个动作独立临时页+用完即关，与搜索页状态彻底解耦；瞬态错误重试一次
        const postUrl = 'https://x.com' + (p.link || ('/i/web/status/' + p.id));
        let rr = await withTempPage(browser, (pg) => retryTransient(() => replyOnPage(pg, p.id, postUrl, qc.cleaned)));
        if (rr.ok || rr.unknown) { ledgerRecord('reply'); audit({ action: 'patrolReply', target: p.author, statusId: p.id, status: rr.ok ? 'done' : 'unknown', text: qc.cleaned.slice(0, 40) }); }
        else audit({ action: 'patrolReply', target: p.author, statusId: p.id, status: 'failed', note: rr.note });
        if (rr.ok && usedToday('follow') < RC.followCapDay) {
          const fo = await withTempPage(browser, (pg) => retryTransient(() => followOnPage(pg, p.author)));
          if (fo.ok) { ledgerRecord('follow'); audit({ action: 'follow', target: p.author, note: '巡逻回复后关注' }); }
          else audit({ action: 'follow', target: p.author, status: 'failed', note: fo.note });
        }
        const g = RC.patrolPostGapSec || [25, 60]; await sleep(rand(g[0], g[1]) * 1000); // 帖间隔（10-20 拍板提速：60-180→25-60s）
      }
    } catch (e) { LOG('页2 巡逻异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 页3：互关帖（1h±0~25min 一条，素材=巡逻近帖） ──
  async function postHourly() {
    try {
      if (usedToday('post') >= RC.postCapDay) { LOG('页3：帖帽已满，跳过'); return; }
      const mat = (st.material || []).slice(0, 6).map((m) => `- @${m.author}: ${String(m.text || '').slice(0, 60)}`).join('\n');
      const r = await generateReply({
        post: mat || '（暂无话题素材）',
        persona: (CFG.personas || {})[ACCOUNT],
        brief: `写一条互关帖正文：一两句话表明认真做交易/看盘的人求互相关注、必回访；可参考但不得照抄话题里别人帖子的说法；正文结尾用句号，不要写任何 # 标签（系统会自动附加固定标签组）。40~100 字。`,
        history: [], channel: RC.llmChannel,
      }).catch(() => null);
      const qc = r && r.text ? quality.check(r.text, {}) : null;
      if (!(qc && qc.ok)) { audit({ action: 'hourlyGen', note: `生成未过门(${qc ? qc.reason : 'LLM失败'})` }); return; }
      if (DRY) { LOG(`[DRY] 应发互关帖: ${qc.cleaned.slice(0, 40)}… + 标签组`); return; }
      // 标签强制程序化附加（10-20 事故：LLM 系统提示禁标签+质量门剥标签双重绞杀致互关帖裸发）——确定性拼接，不依赖 LLM/质量门
      const tagless = (qc.cleaned || '').trim().replace(/[＃#][^\s＃#，。！？、]+/g, '').trim();
      const postText = tagless + '\n\n' + RC.postTags.join(' ');
      const rr = await postOnPage(pagePost, postText);
      if (rr.ok || rr.unknown) { ledgerRecord('post'); audit({ action: 'hourlyPost', status: rr.ok ? 'done' : 'unknown', text: qc.cleaned.slice(0, 50), note: rr.note }); LOG('页3：互关帖已发'); }
      else audit({ action: 'hourlyPost', status: 'failed', note: rr.note });
      await checkAbort(pagePost, '互关帖');
    } catch (e) { LOG('页3 发帖异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 云端内容（照常：槽点拉取滴灌，并入发布队列） ──
  async function cloudSlot(slot) {
    try {
      spawnSync(process.execPath, [path.join(ROOT, 'content-pull.js'), '--account=' + ACCOUNT], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(ROOT, 'x-daily-cert.pem') } });
      let delayMin = 1;
      for (const f of fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : []) {
        if (!f.startsWith(`pull-${ACCOUNT}-`) || !f.endsWith('.json')) continue;
        const items = readJson(path.join(INBOX, f), []);
        for (const it of items) {
          if (usedToday('post') + sendQueue.filter((q) => q.kind === 'cloud').length >= RC.postCapDay) break;
          sendQueue.push({ kind: 'cloud', text: it.text, sendAt: Date.now() + delayMin * 60000 });
          delayMin += rand(RC.cloudGapMin[0], RC.cloudGapMin[1]);
        }
        try { fs.renameSync(path.join(INBOX, f), path.join(INBOX, f + '.done-' + Date.now())); } catch { }
      }
      audit({ action: 'cloudSlot', slot, queued: sendQueue.filter((q) => q.kind === 'cloud').length });
    } catch (e) { audit({ action: 'cloudSlot', slot, note: String(e.message).slice(0, 60) }); }
  }

  // ── 主循环 ──
  LOG(`主循环开始，${RC.endHour}:00 自灭；干跑=${DRY}`);
  while (!aborted && Date.now() < endAt.getTime()) {
    st.heartbeatAt = nowIso(); saveSt(st);
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    try {
      if (Date.now() >= nextReplyPoll) { await pollNotifications(); nextReplyPoll = Date.now() + RC.replyPollMin * 60000; if (aborted) break; }
      if (Date.now() >= nextPatrol) { await patrol(); nextPatrol = Date.now() + rand(RC.patrolGapMin[0], RC.patrolGapMin[1]) * 60000; if (aborted) break; }
      if (Date.now() >= nextPost) { await postHourly(); nextPost = Date.now() + rand(RC.postGapMin[0], RC.postGapMin[1]) * 60000; if (aborted) break; }
      for (const slot of RC.cloudSlots) {
        if (!DRY && hm >= slot && !st.lastCloudSlot[slot]) { st.lastCloudSlot[slot] = nowIso(); saveSt(st); await cloudSlot(slot); if (aborted) break; }
      }
      // 延迟发送队列（DRY 不执行任何真实发送）
      for (let i = sendQueue.length - 1; i >= 0 && !DRY; i--) {
        const q = sendQueue[i];
        if (q.sendAt > Date.now()) continue;
        sendQueue.splice(i, 1);
        if (q.kind === 'replyInbox') {
          const rr = await replyOnPage(pageReply, q.statusId, q.postUrl, q.text);
          if (rr.ok || rr.unknown) { ledgerRecord('reply'); audit({ action: 'inboxReply', target: q.author, status: rr.ok ? 'done' : 'unknown', text: q.text.slice(0, 40) }); }
          else audit({ action: 'inboxReply', target: q.author, status: 'failed', note: rr.note });
          if (await checkAbort(pageReply, '光速回复')) break;
        } else if (q.kind === 'cloud') {
          if (usedToday('post') >= RC.postCapDay) { audit({ action: 'cloudPost', status: 'skipped', note: '帖帽满' }); continue; }
          const rr = await postOnPage(pagePost, q.text);
          if (rr.ok || rr.unknown) { ledgerRecord('post'); audit({ action: 'cloudPost', status: rr.ok ? 'done' : 'unknown', text: q.text.slice(0, 40), note: rr.note }); }
          else audit({ action: 'cloudPost', status: 'failed', note: rr.note });
          if (await checkAbort(pagePost, '云帖')) break;
        }
      }
      if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { LOG('PAUSE 出现，退出'); break; }
    } catch (e) { LOG('主循环异常(继续): ' + String(e.message).slice(0, 80)); audit({ action: 'loopError', note: String(e.message).slice(0, 80) }); }
    await sleep(20 * 1000);
  }
  st.heartbeatAt = null; saveSt(st);
  LOG('常驻结束，清场退出');
  await cleanup();
  audit({ action: 'residentEnd', note: aborted ? '熔断' : '到点/PAUSE' });
  process.exit(0);
})().catch(async (e) => { console.error('FATAL:', e.message || e); try { const st = loadSt(); st.heartbeatAt = null; saveSt(st); } catch { } audit({ action: 'residentFatal', note: String(e.message || e).slice(0, 120) }); process.exit(1); });
