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
async function withTempPage(browser, fn) {
  const pg = await browser.newPage();
  pg.on('dialog', (d) => d.accept().catch(() => { }));
  try { return await fn(pg); } finally { try { await pg.close(); } catch { } }
}
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
  const stats = { seen: 0, fresh: 0, replied: 0, failed: 0, skippedOwn: 0, skippedCap: 0, todo: 0, greetTpl: 0 };
  try {
    const oj = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
    if (!oj.success) throw new Error('开窗失败: ' + JSON.stringify(oj));
    ws = oj.data.ws;
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
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
              await sleep(rand(500, 3000));
              let rr = await replyToComment(page, 'https://x.com' + it.href, statusId, tc.cleaned).catch((e) => ({ ok: false, note: e.message }));
              if (rr.ok) {
                st.seenNotifs[key] = { at: nowIso(), status: 'done' };
                st.perUser.counts[it.author.toLowerCase()] = uc + 1;
                st.userRepliesTotal = st.userRepliesTotal || {}; st.userRepliesTotal[it.author.toLowerCase()] = (st.userRepliesTotal[it.author.toLowerCase()] || 0) + 1;
                ledgerRecordReply(); recordReply({ targetHandle: it.author, statusId, text: tc.cleaned }); syncContactsReply({ targetHandle: it.author });
                stats.replied++; stats.greetTpl++;
                log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: 'done', note: '模板', text: tc.cleaned.slice(0, 60) });
                console.log(`✅[模板] 已回 @${it.author}: ${tc.cleaned}`);
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
        await sleep(rand(500, 3000));
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
          stats.replied++;
          log({ action: 'execute', type: 'reply', kind: 'inbox', id: `inbox-${statusId}`, target: it.author, status: 'done', text: qc.cleaned.slice(0, 60) });
          console.log(`✅ 已回 @${it.author}: ${qc.cleaned}`);
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
  console.log(`本轮：扫 ${stats.seen}，新 ${stats.fresh}，回 ${stats.replied}（模板 ${stats.greetTpl}），转人工 ${stats.todo}，败 ${stats.failed}，自家跳过 ${stats.skippedOwn}，日帽跳过 ${stats.skippedCap}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
