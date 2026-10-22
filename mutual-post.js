// mutual-post.js — 互关帖（2026-10-21 凌晨用户拍板）：butcher/才女 每天 07:00/13:00/19:00 各 1 条，一天就这三次。
// 分钟随机（脚本内掷：butcher 槽起点+0~15min、才女 +20~35min，错开同刻指纹；"7点多少后面可以自己定"用户原话授权）。
// 文案前一天 22:45 预制（--prefab，schtasks Xops互关帖预制），根据前一天的文案换一批说法（防 X 同文重复墙"你已经发过了"）；
// 话题六标签程序附加（不交给 LLM——系统提示禁标签+质量门剥#，fullwin 10-20 已踩过，标签只能代码拼接）。
// 用法:
//   node mutual-post.js --prefab [--account butcher]     # 预制明天三条/号（22:45 调度；首跑/补跑可手动）
//   node mutual-post.js --slot am|mid|pm [--account X]   # 发今日该槽那条；不带 --account 则两号轮发（butcher 先、才女后）
//   node mutual-post.js --slot am --account butcher --dry  # 干跑：全逻辑走完但不开浏览器不实发
// 兜底（交付必达）: 发时预制缺失/日期不对 → 现场生成 1 条再发；LLM 全挂 → 日期种子从内置兜底池取 1 条。绝不为缺料跳票。
// 刹车（与 executor 同语义）: state/PAUSE；风控 toast 当日锁 ledger.meta.abortedToday；最新健康快照 suspended/敏感>0。
// 账本（与 executor 共用滚动 24h）: state/ledger-<account>.json 的 post 时间戳；发前查 60 秒帖间隔（不足顺延≤90s）。
// 07:00 槽在执行窗 9-22 之外=本任务自带时段授权（10-21 拍板），不走 executor 的 activeHours。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PREFAB = argv.includes('--prefab');
const SLOT = argOf('slot', null); // am|mid|pm
const DRY = argv.includes('--dry');
const MP = Object.assign({ accounts: ['butcher', 'wcixot'], slots: { am: 0, mid: 1, pm: 2 }, tags: ['#蓝V互关', '#蓝朋友', '#浇朋友', '#浇个朋友', '#交个朋友', '#交朋友'], jitterMin: { butcher: [0, 15], wcixot: [20, 35] } }, CFG.mutualPost || {});
const ACCOUNTS = argOf('account', null) ? [argOf('account')] : MP.accounts;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = (off = 0) => { const d = new Date(Date.now() + off * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (account, line) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'mutualPost', account, ...line }) + '\n'); };

// ── 预制台账（state/mutual-posts-<account>.json） ──
const stateFile = (acc) => path.join(STATE_DIR, `mutual-posts-${acc}.json`);
function loadState(acc) { try { return { date: null, texts: [], history: [], ...JSON.parse(fs.readFileSync(stateFile(acc), 'utf8')) }; } catch { return { date: null, texts: [], history: [] }; } }
function saveState(acc, st) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile(acc), JSON.stringify(st, null, 2)); }

// ── 内置兜底池（LLM 全挂时的最后防线；按日期种子取，天天不同） ──
const FALLBACK = [
  '今天盘面就聊到这，做美股的朋友欢迎互相关注，常来常往一起交流。',
  '复盘写完，还是那句：纪律比观点重要。做交易的朋友互关一波，主页常来。',
  '每天盯盘十几个小时，有同路的欢迎互关，盘前盘后都能聊。',
  '这周节奏基本踏准了，方法都在日常里。做美股的朋友互关起来，多交流。',
  '交易这行，活下来比赚快钱重要。认同的朋友互相关注，主页常开。',
  '盘面看法每天都在更新，欢迎互关，有想法随时来聊。',
];
const seedPick = (acc, date) => { const s = `${date}|${acc}`; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return FALLBACK[h % FALLBACK.length]; };

// ── LLM 预制生成（10-21 P0-③ 升级：分时段语气 + 当日话题素材参考——fullwin topic-posts 方法论，三槽形式不变） ──
function loadMaterial(acc) {
  try { const m = JSON.parse(require('fs').readFileSync(path.join(STATE_DIR, `mutual-material-${acc}.json`), 'utf8')); return (m.posts || []).slice(-6); } catch { return []; }
}
async function genTexts(acc, date, count) {
  const acct = CFG.accounts.find((a) => a.key === acc);
  const persona = (CFG.personas || {})[acc] || `X 账号 @${(acct || {}).handle || acc} 的运营者本人，聊美股交易日常。`;
  const st = loadState(acc);
  const avoid = st.history.slice(0, 6);
  const material = loadMaterial(acc);
  const user = [
    `写 ${count} 条今天要发的互关招揽帖（日期 ${date}）。要求：`,
    `①每条 60~120 字，第一人称，像日常随手发；`,
    `②${count >= 3 ? '三条分别对应三个发布时段，各带时段语气：第 1 条=早盘档（盘前/开盘氛围，今天要盯什么）；第 2 条=午间档（午后歇盘/闲聊感）；第 3 条=晚间档（收盘复盘感）' : '贴合发布时段的语气（早盘/午间/复盘）'}；`,
    `③内容落在你的领域日常，结尾自然带出"求互相关注/欢迎来主页串门/一起交流"之意；`,
    `④不要话题标签（标签由程序附加）、不要链接、不要@任何人、不喊单不吹收益不编数字；`,
    material.length ? `⑤下面是今天互关话题里别人正在聊的片段（只学话题风向，严禁照抄句子）：\n${material.map((x) => `- ${x.text}`).join('\n')}` : `⑤无话题素材，自由发挥。`,
    avoid.length ? `⑥必须与前一天的文案明显不同（换结构换措辞换切入点）。前一天的文案：\n${avoid.map((t, i) => `${i + 1}) ${t}`).join('\n')}` : `⑥无历史文案，自由发挥。`,
    `只输出 ${count} 条，每条一行，行首用 1) 2) 3) 编号。`,
  ].join('\n');
  const r = await chat({ messages: [{ role: 'system', content: `你是 X(Twitter) 账号的运营者本人。人设：${persona}` }, { role: 'user', content: user }], maxTokens: 700 });
  const lines = String(r.text || '').split(/\r?\n/).map((s) => s.replace(/^\s*\d+[\)）\.、]?\s*/, '').trim()).filter((s) => s.length >= 20);
  const out = [];
  for (const t of lines) {
    if (out.length >= count) break;
    const qc = quality.check(t, { history: st.history });
    if (qc.ok && !out.some((x) => x.slice(0, 12) === qc.cleaned.slice(0, 12))) out.push(qc.cleaned);
  }
  return out;
}
// 凑满 count 条：生成失败重试一轮，仍缺用兜底池补（交付必达）
async function ensureTexts(acc, date, count) {
  let out = [];
  for (let round = 0; round < 2 && out.length < count; round++) {
    try { out = out.concat(await genTexts(acc, date, count - out.length)); } catch (e) { console.log(`  LLM 第${round + 1}轮失败(${acc}): ${String(e.message).slice(0, 80)}`); }
  }
  out = out.slice(0, count);
  let fi = 0;
  while (out.length < count) { const fb = seedPick(acc, date + '#' + (fi++)); if (!out.includes(fb)) out.push(fb); }
  return out;
}

// ── 刹车门（与 executor 同语义） ──
function gate(acc) {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) return 'PAUSE 急停生效';
  try {
    const led = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `ledger-${acc}.json`), 'utf8'));
    if ((led.meta || {}).abortedToday === today()) return `风控当日锁(${(led.meta || {}).abortReason || ''})`;
  } catch { }
  for (const d of [today(), today(-1)]) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'health-snapshots', `${d}.json`), 'utf8'));
      const e = snap.accounts && snap.accounts[acc];
      if (e && ((e.verdict === 'suspended') || (e.profile && e.profile.state === 'suspended'))) return `健康门：suspended（快照 ${d}）`;
      if (e && e.statuses && (e.statuses.sensitiveCount || 0) > 0) return `健康门：敏感标记>0（快照 ${d}）`;
      if (e) return null; // 有当日/昨日快照且干净
    } catch { }
  }
  return null; // 无快照=unknown≠异常，照常
}

// ── 滚动账本（与 executor 共用文件与口径） ──
function loadLedger(acc) {
  let j = { actions: {}, meta: {} };
  try { j = { actions: {}, meta: {}, ...JSON.parse(fs.readFileSync(path.join(STATE_DIR, `ledger-${acc}.json`), 'utf8')) }; } catch { }
  const cut = Date.now() - 24 * 3600 * 1000;
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  return j;
}
const postCap = () => (((CFG.executor || {}).rollingCaps || {}).post) || 20;

// ── 账号锁（与 executor 同文件协议） ──
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function lockWait(acc) {
  const f = path.join(STATE_DIR, `lock-${acc}.json`);
  const staleCut = Date.now() - (((CFG.executor || {}).lockStaleMinutes || 30) * 60000);
  for (let a = 1; a <= 16; a++) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
    if (!(j && j.pid && j.at > staleCut && pidAlive(j.pid))) { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), account: acc, task: 'mutualPost' })); return f; }
    if (a === 16) throw new Error('账号锁等待超时（另一进程在跑）');
    console.log(`[锁等待] ${acc} 被 pid ${j.pid} 占用，75 秒后重试(${a}/16)`);
    await sleep(75000);
  }
}
const unlock = (f) => { try { fs.unlinkSync(f); } catch { } };

// ── 发布原语（与 executor.postTweet 同流程：compose 页→合成粘贴→提交→只认"已发送"气泡） ──
const SEL = { replyBox: '[data-testid="tweetTextarea_0"]', toast: '[data-testid="toast"]' };
async function postTweet(page, text) {
  await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(SEL.replyBox, { timeout: 20000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  const typed = await page.evaluate((sel, t) => {
    const all = document.querySelectorAll(sel);
    const el = document.querySelector('[role="dialog"] ' + sel) || all[all.length - 1];
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
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
  const readSt = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="tweetTextarea_0"]');
    return { dlg: !!document.querySelector('[role="dialog"]'), toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(), boxLen: box && box.textContent ? box.textContent.length : 0 };
  }).catch(() => null);
  const okToast = (t) => /已发送|发过了|送信|already|posted|sent/i.test(t || '');
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await readSt();
    if (!st) continue;
    if (okToast(st.toast)) {
      return /发过|already/i.test(st.toast || '') ? { ok: true, note: '已存在（重复，非本次新发）' } : { ok: true, note: '新发' };
    }
    if (hasDialog && !st.dlg) return { ok: false, unknown: true, note: '弹窗关闭未见气泡' };
    if (!hasDialog && st.boxLen === 0) return { ok: false, unknown: true, note: '输入框已清空未见气泡' };
  }
  return { ok: false, note: '超时未见成功气泡' };
}

// ── 单号发一槽 ──
async function postSlot(acc, slot) {
  const g = gate(acc);
  if (g) { console.log(`[${acc}] 刹车：${g}`); log(acc, { action: 'skip', slot, note: g }); return; }
  const idx = MP.slots[slot];
  const st = loadState(acc);
  let text = st.date === today() ? st.texts[idx] : null;
  if (!text) { console.log(`[${acc}] 今日预制缺失（${st.date || '无'}≠${today()}），现场生成兜底`); text = (await ensureTexts(acc, today(), 1))[0]; }
  text = String(text).replace(/^\s*\d{4}-\d{2}-\d{2}\s*(早盘|午间|晚间|盘前|复盘|深夜)?\s*[:：,，、-]?\s*/, ''); // 10-22：LLM 偶把日期/时段标签写进正文开头（"2026-10-22 午间："），发前剥掉
  const final = `${text}\n${MP.tags.join(' ')}`;
  const wl = quality.weightedLen(final);
  if (wl > 280) { console.log(`[${acc}] 成稿超长(${wl}>280)，按 280 截标签`); }
  const finalText = wl > 280 ? text : final; // 标签永不单独超限（正文~120+标签~40）；极端情况弃标签保正文
  console.log(`[${acc}] ${slot} 槽待发（${quality.weightedLen(finalText)} 字重）：${finalText.slice(0, 50)}…`);
  log(acc, { action: 'slot', slot, text: finalText.slice(0, 60), dry: DRY || undefined });
  if (DRY) { console.log('[DRY] 不开浏览器不实发'); return; }

  const led = loadLedger(acc);
  const usedPost = (led.actions.post || []).length;
  if (usedPost >= postCap()) { console.log(`[${acc}] 滚动帖帽已满(${usedPost}/${postCap()})，本槽跳过`); log(acc, { action: 'skip', slot, note: '滚动帖帽满' }); return; }
  const lastPost = Math.max(0, ...((led.actions.post || []).filter(Number.isFinite)));
  const gapLeft = 60000 - (Date.now() - lastPost);
  if (lastPost > 0 && gapLeft > 0) await sleep(Math.min(gapLeft, 90000)); // 帖间隔 ≥60s 同 executor 规

  const acct = CFG.accounts.find((a) => a.key === acc);
  const lockF = await lockWait(acc);
  let browser = null, ws = null;
  try {
    const oj = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: acct.profileId }) }).then((r) => r.json());
    if (!oj.success) throw new Error('开窗失败: ' + JSON.stringify(oj));
    ws = oj.data.ws;
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 90000 });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开（10-20 全天 CDP 超时真凶）
    await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
    let r = await postTweet(page, finalText).catch((e) => ({ ok: false, note: e.message }));
    // 瞬态重试 1 次（与 executor 同思路；发布是短动作，1 次足够）
    if (!r.ok && !r.unknown && /Protocol error|timed out|TimeoutError|net::|ERR_/i.test(r.note || '')) { await sleep(8000); r = await postTweet(page, finalText).catch((e) => ({ ok: false, note: e.message + '（重试后仍败）' })); }
    // 风控 toast 检查（成功气泡与风控气泡互斥，提交后再读一次）
    const toast = await page.evaluate((sel) => { const t = document.querySelector(sel); return t ? (t.textContent || '').trim().slice(0, 80) : null; }, SEL.toast).catch(() => null);
    if (toast && /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block/i.test(toast)) {
      const led2 = loadLedger(acc); led2.meta = led2.meta || {}; led2.meta.abortedToday = today(); led2.meta.abortReason = '风控toast(互关帖): ' + toast;
      fs.writeFileSync(path.join(STATE_DIR, `ledger-${acc}.json`), JSON.stringify(led2, null, 2));
      log(acc, { action: 'abort', slot, note: '风控toast: ' + toast });
      console.log(`[${acc}] ⚠ 风控 toast，当日锁：${toast}`);
      r = { ok: false, note: '风控toast: ' + toast };
    }
    if (r.ok) {
      const led2 = loadLedger(acc); led2.actions = led2.actions || {}; (led2.actions.post = led2.actions.post || []).push(Date.now());
      fs.writeFileSync(path.join(STATE_DIR, `ledger-${acc}.json`), JSON.stringify(led2, null, 2));
      log(acc, { action: 'post', type: 'post', kind: 'mutualPost', slot, status: 'done', note: r.note, text: finalText.slice(0, 60) });
      console.log(`[${acc}] ${slot} 槽 ✅ 已发（${r.note}）`);
    } else {
      log(acc, { action: 'post', type: 'post', kind: 'mutualPost', slot, status: r.unknown ? 'unknown' : 'failed', note: r.note });
      console.log(`[${acc}] ${slot} 槽 ❌ ${r.unknown ? '结果不明' : '失败'}：${r.note}`);
    }
  } finally {
    if (browser) { try { const ps = await browser.pages(); for (let i = 1; i < ps.length; i++) { try { await ps[i].close(); } catch { } } } catch { } await browser.disconnect(); }
    if (ws) await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: acct.profileId }) }).catch(() => { });
    unlock(lockF);
  }
}

(async () => {
  if (PREFAB) {
    const date = argOf('date', today(1)); // 预制=明天的三条（--date 可指定，如首跑补当天）
    for (const acc of ACCOUNTS) {
      const st = loadState(acc);
      if (st.date === date && st.texts.length >= 3) { console.log(`[${acc}] ${date} 预制已存在，跳过`); continue; }
      const texts = await ensureTexts(acc, date, 3);
      // 历史推进：把"今天发过的三条"压进 history（供下次避重），cap 30
      const used = st.date === today() ? st.texts : [];
      saveState(acc, { date, texts, history: [...used, ...(st.history || [])].slice(0, 30) });
      log(acc, { action: 'prefab', date, texts: texts.map((t) => t.slice(0, 30)) });
      console.log(`[${acc}] ${date} 预制完成：\n${texts.map((t, i) => `  ${i + 1}) ${t}`).join('\n')}`);
    }
    return;
  }
  if (!SLOT || MP.slots[SLOT] == null) { console.error('用法: --prefab 或 --slot am|mid|pm [--account X] [--dry]'); process.exit(1); }
  const t0 = Date.now();
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const acc = ACCOUNTS[i];
    const j = MP.jitterMin[acc] || [0, 15]; // 抖动按账号键（10-21 拍板"按账号运行"：每号独立任务独立进程，抖动跟随账号不跟随循环序）
    const waitMin = rand(j[0], j[1]);
    const sleepMs = Math.max(0, waitMin * 60000 - (Date.now() - t0));
    if (!DRY && sleepMs > 0) { console.log(`[${acc}] 槽内随机延迟 ${(sleepMs / 60000).toFixed(1)} 分钟`); await sleep(sleepMs); }
    await postSlot(acc, SLOT);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
