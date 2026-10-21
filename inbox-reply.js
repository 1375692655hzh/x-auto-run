// inbox-reply.js — 被动回复模块（2026-10-21 用户拍板"开工"，补 butcher/才女 最后一个零代码缺口）：
// 别人在我们帖下的评论 → 提及页轮询 → LLM 生成 → 回复对方那条评论。
// 用法: node inbox-reply.js --account butcher [--dry]
// 调度: schtasks Xops被动回复-butcher/才女 每 30 分钟（脚本内守 07:00-22:00——07 点是互关帖早槽的评论高峰接续，本任务自带时段授权不走 executor 9-22 窗闸）。
// 规则: 自家矩阵号不回；同状态不重复回（seenNotifs）；单用户 ≤3 条/天（与 fullwin 同规）；每轮 ≤10 条；
//       只回复不关注（回关归条件回关机制）；不声称"已关注"（防虚假表述）；unknown 不重试（评论重复比漏回更糟，留核验）。
// 刹车: PAUSE / ledger.meta.abortedToday 风控当日锁 / 最新健康快照 suspended·敏感>0。
// 账本: 与 executor 共用 ledger-<account>.json 滚动 24h（reply 帽 60）；回复记录回写 taskstate+contacts（planner 去重与关系池不失真）。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { generateReply } = require('./llm');
const quality = require('./quality');

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
const OWN = new Set(CFG.accounts.map((a) => a.handle.toLowerCase())); // 自家矩阵号不自动回（用户手动管）
const HOURS = [7, 22]; // 本任务授权时段（10-21 拍板：接续互关帖 07:00 早槽评论高峰）
const PER_USER_DAY = 3, PER_RUN = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (line) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'inboxReply', account: ACCOUNT, ...line }) + '\n'); };
const nowIso = () => new Date().toISOString();

// ── 状态（seenNotifs 去重 + 单用户日帽） ──
const ST_FILE = path.join(STATE_DIR, `inbox-${ACCOUNT}.json`);
function loadSt() { try { return { seenNotifs: {}, perUser: { date: today(), counts: {} }, ...JSON.parse(fs.readFileSync(ST_FILE, 'utf8')) }; } catch { return { seenNotifs: {}, perUser: { date: today(), counts: {} } }; } }
function saveSt(st) { const ks = Object.keys(st.seenNotifs); if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete st.seenNotifs[k]; fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(ST_FILE, JSON.stringify(st, null, 2)); }

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
  return null; // 无快照=unknown≠异常，照常
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

// ── 台账回写（与 executor 同口径：planner 去重 + 关系池不失真） ──
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

// ── 回复对方那条评论（executor.replyToPost 同流程，按其 statusId 定位再回） ──
const SEL = { article: 'article[data-testid="tweet"]', reply: '[data-testid="reply"]', replyBox: '[data-testid="tweetTextarea_0"]', toast: '[data-testid="toast"]' };
async function replyToComment(page, postUrl, statusId, text) {
  try { await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForSelector(SEL.article, { timeout: 45000 }); }
  catch { return { ok: false, note: '页面加载失败' }; }
  await sleep(2000 + Math.random() * 2500);
  let art = null;
  for (const a of await page.$$(SEL.article)) {
    if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), statusId).catch(() => false)) { art = a; break; }
  }
  if (!art) return { ok: false, note: '按 statusId 未找到目标帖' };
  const btn = await art.$(SEL.reply);
  if (!btn) return { ok: false, note: '回复按钮未找到' };
  try { const bb = await btn.boundingBox(); if (bb) await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.5, { steps: 5 }); } catch { }
  await btn.click();
  await page.waitForSelector(SEL.replyBox, { timeout: 10000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  const typed = await page.evaluate((sel, t) => {
    const all = document.querySelectorAll(sel);
    const el = document.querySelector('[role="dialog"] ' + sel) || all[all.length - 1];
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, SEL.replyBox, text).catch(() => false);
  if (!typed) return { ok: false, note: '输入失败' };
  await sleep(800);
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
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await page.evaluate(() => { const box = document.querySelector('[data-testid="tweetTextarea_0"]'); return { dlg: !!document.querySelector('[role="dialog"]'), toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(), boxLen: box && box.textContent ? box.textContent.length : 0 }; }).catch(() => null);
    if (!st) continue;
    if (okToast(st.toast)) return { ok: true };
    if (hasDialog && !st.dlg) return { ok: false, unknown: true, note: '弹窗关闭未见气泡' };
    if (!hasDialog && st.boxLen === 0) return { ok: false, unknown: true, note: '输入框已清空未见气泡' };
  }
  return { ok: false, note: '超时未见成功气泡' };
}

(async () => {
  const hour = new Date().getHours();
  if (hour < HOURS[0] || hour >= HOURS[1]) { console.log(`非授权时段(${HOURS[0]}-${HOURS[1]})，退出`); process.exit(0); }
  const g = gate();
  if (g) { console.log('刹车：' + g); log({ action: 'skip', note: g }); process.exit(0); }
  const led0 = loadLedger();
  if ((led0.actions.reply || []).length >= replyCap()) { console.log(`滚动回复帽已满(${replyCap()})，本轮跳过`); log({ action: 'skip', note: '滚动回复帽满' }); process.exit(0); }
  const st = loadSt();
  if (st.perUser.date !== today()) st.perUser = { date: today(), counts: {} };

  const lockF = DRY ? null : await lockWait();
  let browser = null, ws = null;
  const stats = { seen: 0, fresh: 0, replied: 0, failed: 0, skippedOwn: 0, skippedCap: 0 };
  try {
    const oj = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
    if (!oj.success) throw new Error('开窗失败: ' + JSON.stringify(oj));
    ws = oj.data.ws;
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开（10-20 全天 CDP 超时真凶）
    await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
    // 提及页（回复/提及类专用页；"全部"页被关注/点赞洪流淹没——fullwin 光速回复实证路径）
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
      for (const it of items) {
        if (!it.href || !it.author) continue;
        // 分类=关键词正则 ∪ 结构判定（语言无关：回复/提及的链接指向【别人】的帖；赞/关注指向我们的帖或无帖链接）
        const isReplyMention = /回复|回覆|reply|返信|提到|mention|提及|メンション/i.test(it.txt)
          || !it.href.toLowerCase().includes('/' + ACCT.handle.toLowerCase() + '/');
        if (!isReplyMention) continue;
        if (OWN.has(it.author.toLowerCase())) { stats.skippedOwn++; continue; }
        const key = it.href + '|' + it.author.toLowerCase();
        const prev = st.seenNotifs[key];
        if (prev && !(prev.status === 'genFail' && !prev.retried)) continue; // genFail 给一次重试机会（10-21 交付必达：质量门淘汰不丢量；其余终态不重试——评论重复比漏回糟）
        if (prev) prev.retried = true;
        if (stats.replied >= PER_RUN) break;
        stats.fresh++;
        const statusId = (it.href.match(/status\/(\d+)/) || [])[1];
        if (!statusId) { st.seenNotifs[key] = { at: nowIso(), status: 'badlink' }; continue; }
        if (!it.txt || it.txt.length < 2) { st.seenNotifs[key] = { at: nowIso(), status: 'empty' }; continue; } // 纯图/无字评论没有可回应的文本（10-21 拍板带媒体帖规则同延：看不懂的不回）
        const uc = st.perUser.counts[it.author.toLowerCase()] || 0;
        if (uc >= PER_USER_DAY) { st.seenNotifs[key] = { at: nowIso(), status: 'userCap' }; stats.skippedCap++; log({ action: 'skip', target: it.author, note: '单用户日帽' }); continue; }
        // LLM 生成（人设 + 入站语境 brief；40 字内随手回）
        const brief = '对方在我们发的帖子下评论（互关帖或盘面帖）。作为楼主真诚、具体地回应一句；对方求互关/串门的自然欢迎常来往；不要声称已关注对方（回关由别的机制做）；不要话题标签不要@任何人；控制在 40 字以内，像随手回的真人，结尾要有标点。';
        // 交付必达（10-21）：截断门在 ≤40 字随手回场景误杀率高（完整短句只是没句号）——
        // ①补句号重验（仅当文本不像真截断：不以连接符/半个英文词结尾）②再失败换语气重生成一轮 ③仍败记 genFail 下轮再试一次
        const tryGen = async () => {
          const r = await generateReply({ post: it.txt, author: it.author, persona: (CFG.personas || {})[ACCOUNT], brief, history: [], maxLen: 40 }).catch((e) => { console.log('LLM 失败: ' + String(e.message).slice(0, 80)); return null; });
          if (!r || !r.text) return null;
          const qc = quality.check(r.text, {});
          if (!qc.ok && /疑似截断/.test(qc.reason || '')) {
            const t = qc.cleaned.trim();
            if (!/[，,、；;：:…—\-~～(（]$/.test(t) && !/[a-zA-Z]$/.test(t)) { // 完整短句只是缺句号 → 补句号重验
              const qc2 = quality.check(t + '。', {});
              if (qc2.ok) return qc2;
            }
          }
          return qc.ok ? qc : null;
        };
        let qc = await tryGen();
        if (!qc) qc = await tryGen();
        if (!qc) {
          if (DRY) { console.log(`[DRY] 两轮生成未过门(@${it.author})，跳过`); continue; } // DRY 不写台账不标记
          log({ action: 'genFail', target: it.author, note: '两轮生成未过门' });
          st.seenNotifs[key] = { at: nowIso(), status: 'genFail' }; saveSt(st); continue;
        }
        if (DRY) { console.log(`[DRY] 应回复 @${it.author}（${statusId.slice(-6)}）: ${qc.cleaned}`); continue; } // DRY 不写 seenNotifs（10-21 实战：干跑标记曾把 22 条积压标成"已读"险致永不回）
        await sleep(rand(500, 3000)); // 0.5-3s 小延迟（轮询本身已有 0-30min 自然延迟）
        let rr = await replyToComment(page, 'https://x.com' + it.href, statusId, qc.cleaned).catch((e) => ({ ok: false, note: e.message }));
        // 瞬态重试 1 次（与 executor 同思路）
        if (!rr.ok && !rr.unknown && /Protocol error|timed out|TimeoutError|net::|ERR_/i.test(rr.note || '')) { await sleep(8000); rr = await replyToComment(page, 'https://x.com' + it.href, statusId, qc.cleaned).catch((e) => ({ ok: false, note: e.message + '（重试后仍败）' })); }
        // 风控 toast 刹车（唯一整轮刹车）
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
          ledgerRecordReply(); recordReply({ targetHandle: it.author, statusId, text: qc.cleaned }); syncContactsReply({ targetHandle: it.author });
          stats.replied++;
          log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: 'done', text: qc.cleaned.slice(0, 60) });
          console.log(`✅ 已回 @${it.author}: ${qc.cleaned}`);
        } else {
          st.seenNotifs[key] = { at: nowIso(), status: rr.unknown ? 'unknown' : 'failed', note: (rr.note || '').slice(0, 80) }; // unknown/failed 均不重试（评论重复比漏回更糟，留人工/核验）
          stats.failed++;
          log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: rr.unknown ? 'unknown' : 'failed', note: rr.note });
          console.log(`${rr.unknown ? '⏳ 结果不明' : '❌ 失败'} @${it.author}: ${rr.note}`);
        }
        saveSt(st);
        await sleep(rand(20000, 50000)); // 同轮多条之间拉开 20-50s
      }
    }
  } finally {
    if (browser) { try { const ps = await browser.pages(); for (let i = 1; i < ps.length; i++) { try { await ps[i].close(); } catch { } } } catch { } await browser.disconnect(); }
    if (ws) await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { });
    if (lockF) unlock(lockF);
    saveSt(st);
  }
  log({ action: 'pollEnd', ...stats });
  console.log(`本轮：扫 ${stats.seen} 条，新 ${stats.fresh}，回 ${stats.replied}，败 ${stats.failed}，自家跳过 ${stats.skippedOwn}，日帽跳过 ${stats.skippedCap}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
