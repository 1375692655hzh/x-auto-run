// executor.js — 队列执行器（P2）：消费短时动作队列，exactly-once，滚动24h账本，账号锁
// 规范依据: ./执行计划-综合版.md P2 / ./规范与约束.md §12
// 用法:
//   node executor.js --account butcher --queue queue/2026-10-16-am-butcher.json [--window am] [--dry] [--max-actions N]
// 队列条目: { id, account, type: reply|follow|like, postUrl?, statusId?, targetHandle?, text?,
//             followFirst?, window?: am|mid|pm, ttlMin?, status, result?, createdAt }
//   status: planned → intent → done|unknown|failed ；intent 卡死(崩溃) → 复跑时转 unknown → 30min 后匿名核验，未发翻回重跑（≤2 次）
// exactly-once 三件套:
//   ①发送前先落盘 intent（崩溃后可辨"可能已发出"）
//   ②unknown = 结果不明：先占额度记待核，30min 后 FxTwitter 匿名核验（verify-unknown.js）——已发记 done，未发翻回 planned 补跑节重发
//   ③账号级文件锁：定时与手动互斥；残留锁超时(30min)自动接管
// 交付必达（2026-10-20 用户拍板）：连败熔断已拆（单点失败只记日志不殃及队列）；瞬态错误 3 次退避重试+收尾翻回；
//   唯一整窗刹车=风控 toast（X 官方真实信号）与 state/PAUSE。
// 滚动账本: state/ledger-<account>.json 动作时间戳数组，跨进程持久化，替代自然日重置；
//   过渡期与 boost.js 同日计数合并对账（切换完成后移除合并逻辑）。
// 测试钩子（仅测试用）: EXECUTOR_SIMULATE=1 全状态机不开浏览器；EXECUTOR_CRASH_AFTER_INTENT=1 写完 intent 即 exit(70)。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const L = CFG.limits;
const X = Object.assign({
  rollingCaps: { reply: 8, follow: 18, like: 15, unfollow: 5 },
  queueTtlMinutes: 180,
  actionGapGaussMs: [90000, 30000],
  followFirstGapGaussMs: [90000, 30000],
  sessionMaxMinutes: 15,
  lockStaleMinutes: 30,
}, CFG.executor || {});

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ACCOUNT = argOf('account', 'butcher');
const QUEUE_FILE = argOf('queue', null);
const WINDOW = argOf('window', null);
const MAX_ACTIONS = parseInt(argOf('max-actions', '99'), 10);
const DRY = argv.includes('--dry');
const ENTRY_ID = argOf('entry', null); // 定时发布（10-18）：--entry <id> 只执行该条目（round 到点逐条拉起用）
const SIMULATE = process.env.EXECUTOR_SIMULATE === '1';
const CRASH_HOOK = process.env.EXECUTOR_CRASH_AFTER_INTENT === '1';

const ACCT = CFG.accounts.find((a) => a.key === ACCOUNT);
if (!ACCT) { console.error('config.accounts 无此账号: ' + ACCOUNT); process.exit(1); }
if (!QUEUE_FILE) { console.error('必须指定 --queue <文件>'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
function gauss(mean, sd) {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  return Math.max(mean * 0.2, mean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sd);
}
const gsleep = (pair) => sleep(gauss(pair[0], pair[1]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (line) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'executor', account: ACCOUNT, simulated: SIMULATE || undefined, ...line }) + '\n');
};

// ── 滚动 24h 账本（含 boost 同日合并口径） ────────────────
// SIMULATE 模式写独立测试账本，杜绝污染真实额度数据（2026-10-16 修复：模拟关注曾计入真实账本）
const LEDGER_FILE = path.join(STATE_DIR, `ledger-${ACCOUNT}${SIMULATE ? '.test' : ''}.json`);
function loadLedger() {
  let j = { actions: {}, meta: {} };
  try { j = { actions: {}, meta: {}, ...JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const cut = Date.now() - 24 * 3600 * 1000;
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  return j;
}
function saveLedger(led) {
  led.meta = led.meta || {};
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(led, null, 2));
}
function boostTodayUsed() {
  try { const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, ACCOUNT + '.json'), 'utf8')); return (st.daily || {})[today()] || {}; } catch { return {}; }
}
function usedNow(type) {
  const led = LEDGER; // 运行期常驻
  const d = boostTodayUsed();
  const fromBoost = type === 'reply' ? (d.owenReplies || 0) + (d.communityReplies || 0)
    : type === 'like' ? (d.likes || 0)
    : type === 'follow' ? (d.follows || 0)
    : type === 'unfollow' ? (d.unfollows || 0) : 0;
  return ((led.actions[type] || []).length) + fromBoost;
}
function capLeftRolling(type) {
  const cap = X.rollingCaps[type];
  if (!Number.isFinite(cap) || cap <= 0) return 0; // fail-closed
  return cap - usedNow(type);
}
function ledgerRecord(type) {
  (LEDGER.actions[type] = LEDGER.actions[type] || []).push(Date.now());
  saveLedger(LEDGER);
}

// ── 账号锁 ───────────────────────────────────────────────
const LOCK_FILE = path.join(STATE_DIR, `lock-${ACCOUNT}.json`);
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  const staleCut = Date.now() - X.lockStaleMinutes * 60000;
  if (fs.existsSync(LOCK_FILE)) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { }
    if (j && j.pid && j.at > staleCut && pidAlive(j.pid)) throw new Error(`账号 ${ACCOUNT} 已有运行中的进程(pid ${j.pid})，本次退出（防并发）`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now(), account: ACCOUNT }));
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch { } }

// ── 队列文件 ─────────────────────────────────────────────
function loadQueue() {
  const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); // 读失败直接抛=终止
  const arr = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(arr)) throw new Error('队列文件不是数组: ' + QUEUE_FILE);
  const ids = new Set();
  for (const e of arr) {
    for (const f of ['id', 'type']) if (!e[f]) throw new Error(`队列条目缺 ${f}: ` + JSON.stringify(e).slice(0, 80));
    if (ids.has(e.id)) throw new Error('队列 id 重复: ' + e.id);
    ids.add(e.id);
    if (!['reply', 'follow', 'like', 'unfollow', 'post'].includes(e.type)) throw new Error('未知 type: ' + e.type);
    if (e.type === 'reply' && !(e.postUrl && e.statusId && e.text)) throw new Error('reply 条目缺 postUrl/statusId/text: ' + e.id);
    if (e.type === 'post' && !e.text) throw new Error('post 条目缺 text: ' + e.id);
    if ((e.type === 'follow' || e.type === 'unfollow') && !e.targetHandle) throw new Error(e.type + ' 条目缺 targetHandle: ' + e.id);
    if (e.type === 'like' && !(e.postUrl && e.statusId)) throw new Error('like 条目缺 postUrl/statusId: ' + e.id);
  }
  return arr.map((e) => ({ status: 'planned', createdAt: new Date().toISOString(), ...e }));
}
function saveQueue(arr) { fs.mkdirSync(QUEUE_DIR, { recursive: true }); fs.writeFileSync(QUEUE_FILE, JSON.stringify(arr, null, 2)); }

// ── 浏览器原语（复制自 boost.js 已验证实现；boost.js 保持不动） ──
const SEL = {
  article: 'article[data-testid="tweet"]', reply: '[data-testid="reply"]', replyBox: '[data-testid="tweetTextarea_0"]',
  like: '[data-testid="like"]', unlike: '[data-testid="unlike"]', toast: '[data-testid="toast"]',
};
const RISK_TOAST = /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block|エラー|もう一度|制限|できません/i;
async function openWindow(profileId) {
  const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }) }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j));
  return j.data.ws;
}
async function humanScroll(page, totalPx) {
  const segs = 5 + Math.floor(Math.random() * 8);
  for (let i = 0; i < segs; i++) {
    await page.evaluate((p) => window.scrollBy({ top: p, behavior: 'smooth' }), (totalPx / segs) * (0.7 + Math.random() * 0.6));
    await sleep(100 + Math.random() * 300);
  }
}
async function humanClick(page, handle) {
  try {
    const bb = await handle.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + bb.width * (0.3 + Math.random() * 0.4), bb.y + bb.height * (0.3 + Math.random() * 0.4), { steps: 6 + Math.floor(Math.random() * 8) });
      await sleep(rand(...CFG.pacing.hoverMs));
    }
  } catch { }
  await handle.click();
}
async function verifyLogin(page, handle) {
  try {
    await page.waitForSelector('a[data-testid="AppTabBar_Profile_Link"]', { timeout: 15000 });
    const href = await page.evaluate(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); return a ? a.getAttribute('href') : null; }).catch(() => null);
    if (href && href.toLowerCase() === '/' + handle.toLowerCase()) return true;
  } catch { }
  try {
    const client = await page.createCDPSession();
    const { cookies } = await client.send('Network.getCookies', { urls: ['https://x.com'] });
    const twid = (cookies.find((c) => c.name === 'twid') || {}).value || '';
    const m = decodeURIComponent(twid).match(/u=(\d+)/);
    if (!m) return false;
    await page.goto('https://x.com/intent/user?user_id=' + m[1], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    return decodeURIComponent(page.url()).toLowerCase().includes('screen_name=' + handle.toLowerCase());
  } catch { return false; }
}
async function readToast(page) {
  return page.evaluate((sel) => { const t = document.querySelector(sel); return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null; }, SEL.toast).catch(() => null);
}
async function riskToast(page) { const t = await readToast(page); return (t && RISK_TOAST.test(t)) ? t : null; }
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
    catch { if (i < tries - 1) await sleep(3000); }
  }
  return false;
}
async function findArticleByStatus(page, statusId) {
  for (const a of await page.$$(SEL.article)) {
    if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), statusId).catch(() => false)) return a;
  }
  return null;
}
// 按 statusId 定位目标帖再回复（不取 arts[0]——审计指出的坑）
async function replyToPost(page, entry) {
  if (!(await gotoFeed(page, entry.postUrl))) return { ok: false, note: '页面加载失败' };
  await gsleep(CFG.pacing.readDwellGaussMs);
  const art = await findArticleByStatus(page, entry.statusId);
  if (!art) return { ok: false, note: '按 statusId 未找到目标帖' };
  const btn = await art.$(SEL.reply);
  if (!btn) return { ok: false, note: '回复按钮未找到' };
  await humanClick(page, btn);
  await page.waitForSelector(SEL.replyBox, { timeout: 10000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  if (!(await typeReply(page, entry.text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page); // true | 'unknown' | false
  return { ok: r === true, unknown: r === 'unknown', raw: r };
}
async function followUser(page, handle2) {
  if (!(await gotoFeed(page, 'https://x.com/' + handle2))) return { ok: false, note: '主页加载失败' };
  await gsleep(CFG.pacing.readDwellGaussMs);
  const btn = (await page.$$('button[data-testid$="-follow"]'))[0];
  if (!btn) return { ok: false, note: '关注按钮未找到(可能已关注)' };
  await humanClick(page, btn);
  await sleep(1500);
  if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) return { ok: true };
  if ((await page.$$('button[data-testid$="-follow"]')).length) return { ok: false, note: '点击后未生效' };
  return { ok: false, unknown: true, note: '结果未确认' };
}
// 维护前置序列（10-20 拍板，按源码权重表设计）：帖页停留 20-45s（停留=11x 最强被动信号）+
// 40% 概率跳目标主页停 15-30s（主页访问=4x）再回来——两者对外不可见，不占任何可见动作帽
async function maintainDwell(page, entry) {
  const t0 = Date.now();
  try {
    const dwell1 = 20000 + Math.floor(Math.random() * 25000);
    await page.evaluate(() => window.scrollBy({ top: 200 + Math.floor(Math.random() * 300), behavior: 'smooth' })).catch(() => { });
    await sleep(dwell1 * 0.5);
    await page.evaluate(() => window.scrollBy({ top: -150, behavior: 'smooth' })).catch(() => { });
    await sleep(dwell1 * 0.5);
    let visitedProfile = false;
    if (Math.random() < 0.4 && entry.targetHandle) {
      visitedProfile = true;
      await page.evaluate((h) => { location.href = 'https://x.com/' + h; }, entry.targetHandle).catch(() => { });
      await sleep(1500 + Math.floor(Math.random() * 3000));
      await page.evaluate(() => window.scrollBy({ top: 300 + Math.floor(Math.random() * 400), behavior: 'smooth' })).catch(() => { });
      await sleep(15000 + Math.floor(Math.random() * 15000));
      await gotoFeed(page, entry.postUrl);
      await sleep(1500);
    }
    log({ action: 'maintainDwell', kind: 'maintain', target: entry.targetHandle, statusId: entry.statusId, ms: Date.now() - t0, profile: visitedProfile }); // 留痕：停留耗时计入审计（防会话死线归因盲区）
  } catch { }
}

async function likePost(page, entry) {
  if (!(await gotoFeed(page, entry.postUrl))) return { ok: false, note: '页面加载失败' };
  const art = await findArticleByStatus(page, entry.statusId);
  if (!art) return { ok: false, note: '按 statusId 未找到目标帖' };
  if (await art.$(SEL.unlike)) return { ok: true, note: '已赞过' };
  if (entry.kind === 'maintain') await maintainDwell(page, entry); // 点赞前停留/顺访主页（不可见高权重信号）
  const btn = await art.$(SEL.like);
  if (!btn) return { ok: false, note: '点赞按钮未找到' };
  await humanClick(page, btn);
  await sleep(1200);
  return (await art.$(SEL.unlike).catch(() => null)) ? { ok: true } : { ok: false, unknown: true, note: '结果未确认' };
}
// 取关（能力建于 2026-10-16，默认额度 0=停用）：取关前现场复查互关徽标，互关一律保留（白名单永不取关）
async function unfollowUser(page, handle2) {
  if (!(await gotoFeed(page, 'https://x.com/' + handle2))) return { ok: false, note: '主页加载失败' };
  await sleep(1500);
  const mutual = await page.$('[data-testid="userFollowIndicator"]').catch(() => null);
  if (mutual) return { ok: true, note: '互关保留（现场复查发现互关徽标，跳过取关）', skippedMutual: true };
  const unbtn = (await page.$$('button[data-testid$="-unfollow"]'))[0];
  if (!unbtn) return { ok: false, note: '取关按钮未找到（可能本就未关注）' };
  await gsleep(CFG.pacing.hoverMs ? [9000, 3000] : [9000, 3000]); // 取关节奏比关注更慢
  await humanClick(page, unbtn);
  await sleep(1200);
  const confirm = await page.$('[data-testid="confirmationSheetConfirm"]');
  if (confirm) { await humanClick(page, confirm); await sleep(1500); }
  const fb = await page.$('button[data-testid$="-follow"]').catch(() => null);
  return fb ? { ok: true } : { ok: false, unknown: true, note: '取关未确认' };
}

// ── 关系台账回写（动作完成后保持图谱同步） ────────────────
function syncContacts(entry, kind) {
  if (SIMULATE) return; // 模拟模式不污染真实关系数据
  try {
    const p = path.join(STATE_DIR, `contacts-${ACCOUNT}.json`);
    if (!fs.existsSync(p)) return;
    const led = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = (entry.targetHandle || '').toLowerCase();
    if (!h) return;
    const e = (led.people[h] = led.people[h] || { handle: h, name: null, firstSeen: new Date().toISOString(), updatedAt: null, sources: [], relation: { weFollow: null, theyFollow: null, mutual: false }, activity: { theirEvents: [], theirLastAt: null, ourReplies: 0, ourLastReplyAt: null }, eligibility: { blocked: null, gone: false }, score: 0, stage: 'contacted' });
    if (kind === 'reply') { e.activity.ourReplies += 1; e.activity.ourLastReplyAt = today(); }
    if (kind === 'follow') e.relation.weFollow = { since: today(), via: 'queue' };
    if (!e.sources.includes('queue')) e.sources.push('queue');
    e.updatedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(led, null, 2));
  } catch { /* 图谱同步失败不阻断执行，只影响打分时效 */ }
}

// ── 任务台账回写（planner 的去重依据：作者/帖冷却 + 已发文案历史） ──
function recordReply(entry) {
  try {
    const p = path.join(STATE_DIR, `taskstate-${ACCOUNT}.json`);
    let ts = null;
    try { ts = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
    ts = ts || { repliedAuthors: {}, repliedPosts: {}, replyHistory: [], tagIndex: 0 };
    ts.repliedAuthors = ts.repliedAuthors || {}; ts.repliedPosts = ts.repliedPosts || {}; ts.replyHistory = ts.replyHistory || [];
    ts.repliedAuthors[entry.targetHandle] = today();
    ts.repliedPosts[entry.statusId] = today();
    ts.replyHistory.push(entry.text);
    if (ts.replyHistory.length > 50) ts.replyHistory = ts.replyHistory.slice(-50);
    fs.writeFileSync(p, JSON.stringify(ts, null, 2));
  } catch { /* 台账回写失败不阻断执行 */ }
}

// ── 主流程 ───────────────────────────────────────────────
const LEDGER = loadLedger();
let sessionAborted = false;
let PRE_EXISTING_PAGES = null; // 会话进入前既有页签（10-21：清理时避开别人工位）

// 发布独立原创帖（2026-10-16 补全；compose 页与回复共用输入/提交/成功气泡机制）
async function postTweet(page, text) {
  try { await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch { return { ok: false, note: '发布页加载失败' }; }
  await page.waitForSelector(SEL.replyBox, { timeout: 20000 }).catch(() => { });
  await sleep(2500); // 等弹窗动画稳定
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  if (!(await typeReply(page, text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page); // compose 是弹窗形态，成功气泡判定与回复一致
  if (r !== true) return { ok: r === true, unknown: r === 'unknown', raw: r };
  // C3 语义分叉（三方方案）：读 toast 区分"新发"vs"已存在"（发过了/already=重复，非新发成功）
  const toast = await page.evaluate(() => ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim()).catch(() => '');
  return /发过|already/i.test(toast || '') ? { ok: true, note: '已存在（重复，非本次新发）' } : { ok: true, note: '新发' }; // 10-18 修复：引用帖变体由 postQuote 处理，此处删残留 quoteUrl 引用
}

// 引用帖（10-18 云端 quote 标记）：进原帖 → 转推按钮 → 菜单"引用" → 带卡片弹窗输入提交
// compose/post/<id> 直链实测 404、intent?url= 只会把链接当正文（10-18 诊断），UI 路径是唯一正路
async function postQuote(page, text, quoteUrl) {
  const m = /status\/(\d+)/.exec(String(quoteUrl));
  if (!m) return { ok: false, note: 'quote_url 无 statusId，跳过不发' };
  if (!(await gotoFeed(page, quoteUrl))) return { ok: false, note: '原帖页加载失败，跳过不发' };
  await gsleep(CFG.pacing.readDwellGaussMs);
  const art = await findArticleByStatus(page, m[1]);
  if (!art) return { ok: false, note: '按 statusId 未找到原帖（可能已删），跳过不发' };
  const rt = await art.$('[data-testid="retweet"]');
  if (!rt) return { ok: false, note: '转推按钮未找到' };
  await humanClick(page, rt);
  await sleep(1200);
  // 菜单项多语言：引用帖子/引用贴文/引用/Quote post/ポストを引用（bitbrowser 基建三语惯例）
  const clicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const q = items.find((el) => /引用|^quote/i.test((el.textContent || '').trim()));
    if (!q) return false;
    q.click();
    return true;
  }).catch(() => false);
  if (!clicked) return { ok: false, note: '引用菜单项未找到' };
  await page.waitForSelector(SEL.replyBox, { timeout: 12000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '引用编辑框未出现' };
  if (!(await typeReply(page, text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page);
  if (r !== true) return { ok: r === true, unknown: r === 'unknown', raw: r };
  const toast = await page.evaluate(() => ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim()).catch(() => '');
  return /发过|already/i.test(toast || '') ? { ok: true, note: '已存在（重复，非本次新发）' } : { ok: true, note: '新发·引用帖' };
}

function executeAction(page, entry) {
  if (SIMULATE) return Promise.resolve({ ok: true, simulated: true });
  if (entry.type === 'reply') return replyToPost(page, entry);
  if (entry.type === 'follow') return followUser(page, entry.targetHandle);
  if (entry.type === 'unfollow') return unfollowUser(page, entry.targetHandle);
  if (entry.type === 'post') return entry.quote && entry.quoteUrl ? postQuote(page, entry.text, entry.quoteUrl) : postTweet(page, entry.text);
  return likePost(page, entry);
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('state/PAUSE 急停生效中，退出'); process.exit(0); }
  if (LEDGER.meta.abortedToday === today()) { console.error(`该账号今日已熔断(${LEDGER.meta.abortReason||''})，按规范停跑`); process.exit(1); }

  const queue = loadQueue();
  // 对账：崩溃残留的 intent 一律转 unknown（可能已发出，禁止重试），并补记额度（保守口径）
  let reconciled = 0;
  for (const e of queue) if (e.status === 'intent') { e.status = 'unknown'; e.result = '进程中断，结果未知（禁重试）'; ledgerRecord(e.type); reconciled += 1; }

  const hour = new Date().getHours();
  const inWindow = hour >= L.activeHours[0] && hour < L.activeHours[1];
  const IGNORE_HOURS = argv.includes('--ignore-hours') || !!ENTRY_ID; // ENTRY_ID=到点定时拉起（计划内已审动作，10-20 互关帖预制 06:00 起会跨守窗）
  if (!DRY && !SIMULATE && !inWindow && !IGNORE_HOURS) { console.error(`不在执行窗 ${L.activeHours[0]}:00-${L.activeHours[1]}:00，退出（模拟/DRY 不受限；手动测试可加 --ignore-hours）`); process.exit(1); }
  if (IGNORE_HOURS && !DRY && !SIMULATE) console.warn('⚠ --ignore-hours：本次为窗外手动执行（应有用户明确指令）');

  if (DRY) {
    console.log(`[DRY] 队列 ${QUEUE_FILE} 共 ${queue.length} 条，将执行：`);
    for (const e of queue.filter((x) => x.status === 'planned')) {
      const capOk = capLeftRolling(e.type) > 0;
      console.log(` - ${e.id} ${e.type}${e.window ? '@' + e.window : ''} ${capOk ? '' : '[额度不足将跳过]'} ${e.type === 'reply' ? e.text.slice(0, 30) + '… ' + e.postUrl : e.targetHandle || ''}`);
    }
    if (reconciled) console.log(`[DRY] 注意：${reconciled} 条 intent 残留将转 unknown`);
    console.log('[DRY] 未做任何修改（队列与账本不变）');
    process.exit(0);
  }

  let locked = false;
  for (let attempt = 1; attempt <= 16; attempt++) { try { acquireLock(); locked = true; break; } catch (le) { if (attempt === 16) throw le; console.log(`[锁等待] ${le.message}，75 秒后重试(${attempt}/16)`); await sleep(75000); } } // 10-18：定时单条与执行窗可能撞锁，等待让路而非放弃；10-20 补跑节与定时帖并发增多，8→16
  if (reconciled) { saveQueue(queue); log({ action: 'reconcile', unknown: reconciled }); }
  const deadline = Date.now() + X.sessionMaxMinutes * 60000;
  let done = 0, browser = null, ws = null;
  const stats = { executed: [], skipped: [], unknown: [], failed: [] };
  try {
    let page = null;
    if (!SIMULATE) {
      ws = await openWindow(ACCT.profileId);
      browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
      // 记录进入前的既有页签（10-21 修复：窗口可能被常驻进程/其他任务占用，清理时只能关自己新开的，别拆别人工位）
      try { PRE_EXISTING_PAGES = new Set(await browser.pages()); } catch { PRE_EXISTING_PAGES = new Set(); }
      page = await browser.newPage();
      page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开（10-20 全天协议超时根因）
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!(await verifyLogin(page, ACCT.handle))) throw new Error(`登录态校验失败：期望 @${ACCT.handle}`);
    }
    // 选品器（10-20 用户拍板"交付必达"）：到点定时帖永远插队先发（排期误差压到秒级，不再被主轮锁压 30-45 分钟）；
    // 其余按队列顺序。死线只收本会话不判死队列——planned 项留给补跑节/round --entry 续跑
    const nextItem = () => {
      if (ENTRY_ID) { const x = queue.find((y) => y.id === ENTRY_ID); return (x && x.status === 'planned') ? x : null; }
      const now = Date.now();
      let first = null;
      for (const e of queue) {
        if (e.status !== 'planned') continue;
        if (WINDOW && e.window && e.window !== WINDOW) continue;
        if (e.type === 'post' && e.postAt) {
          if (Date.parse(e.postAt) <= now + 5000) return e; // 到点帖插队即发
          continue; // 未到点：留给后续扫描或 round --entry 拉起
        }
        if (!first) first = e;
      }
      return first;
    };
    while (true) {
      if (sessionAborted || Date.now() > deadline || done >= MAX_ACTIONS) break;
      const e = nextItem();
      if (!e) break;
      const ageMin = (Date.now() - Date.parse(e.createdAt)) / 60000;
      if (ageMin > (e.ttlMin || X.queueTtlMinutes)) { e.status = 'skipped'; e.result = 'TTL 过期'; stats.skipped.push(e.id); continue; }
      // 权重维护条目（v1.1 M2）：按发帖时间复查黄金窗，过期放弃；固定窗版（10-19 拍板，e.fixed）不守黄金窗——12:35/19:35 撞不上 45-180min，改为 maintain-fixed 已在选帖时限帖龄 20min~14h
      if (e.kind === 'maintain' && e.postAt && !e.fixed) {
        const postAge = (Date.now() - e.postAt) / 60000;
        if (postAge > ((CFG.maintain || {}).goldenMaxMin || 180)) { e.status = 'skipped'; e.result = `黄金窗已过（帖龄${Math.round(postAge)}分钟）`; stats.skipped.push(e.id); continue; }
      }
      // 质量门兜底（planner 是第一道，这里是第二道）：不合格直接跳过，不放行
      if (e.type === 'reply') {
        const qc = quality.check(e.text);
        if (!qc.ok) { e.status = 'skipped'; e.result = '质量门未过: ' + qc.reason; stats.skipped.push(e.id); continue; }
        e.text = qc.cleaned;
      }
      if (capLeftRolling(e.type) <= 0) { e.status = 'skipped'; e.result = `滚动24h额度不足(${e.type})`; stats.skipped.push(e.id); continue; }
      // 定时发布（10-18 拍板）：到点判定已上移至选品器（postAt 未到的帖根本不会被选中）；
      // 间隔保护=相邻帖 ≥60 秒：不足则顺延等待（而非跳过）——账本时间戳记在尝试时，
      // 批量过期帖紧接着进入循环会被误杀（10-19 实战：butcher 白丢 2 条）；等待上限 90 秒，超出仍跳过
      // 账本已 filter(Number.isFinite)，lastPost 恒为有限数或 0
      if (e.type === 'post') {
        const lastPost = Math.max(0, ...((LEDGER.actions.post || []).filter(Number.isFinite)));
        if (lastPost > 0) {
          const gapLeft = 60 * 1000 - (Date.now() - lastPost);
          // review 抓出：原 ">90s 跳过"分支在 lastPost 为过去时间时永不可达（gapLeft≤60s）；
          // 实际风险只有账本脏数据（lastPost 在未来）——那时最多等 90 秒，不再跳过（跳过=白丢帖）
          if (gapLeft > 0) await sleep(Math.min(gapLeft, 90 * 1000));
        }
      }

      // exactly-once：发送前落盘 intent
      e.status = 'intent';
      saveQueue(queue);
      if (CRASH_HOOK) { console.error('[测试钩子] intent 已落盘，模拟崩溃退出'); process.exit(70); }
      ledgerRecord(e.type); // 保守：动作尝试即计额度

      let r;
      if (e.type === 'reply' && e.followFirst) {
        const fr = await (SIMULATE ? Promise.resolve({ ok: true, simulated: true }) : followUser(page, e.targetHandle));
        log({ action: 'execute', kind: e.kind || undefined, id: e.id + '-follow', type: 'follow', target: e.targetHandle, status: fr.ok ? 'done' : 'unknown', note: '互关先关注' });
        if (!fr.ok) {
          // 先关注失败则不发回复（Kimi 评审抓出：文案口径"可如实说已关注"，关注没成仍回复=虚假表述风险）
          ledgerRecord('follow');
          e.status = 'skipped'; e.result = '先关注未成功，跳过回复（防"已关注"虚假表述）'; stats.skipped.push(e.id);
          saveQueue(queue);
          continue;
        }
        syncContacts(e, 'follow'); ledgerRecord('follow'); // 先关注同样计入滚动关注账本（2026-10-16 修复：此前漏记）
        await gsleep(X.followFirstGapGaussMs);
      }
      r = await executeAction(page, e).catch((err) => ({ ok: false, note: err.message }));
      // 瞬态错误（协议超时/网络抖动）：3 次退避重试（8/15/30s）——10-20 用户拍板"交付必达"：单点抖动不许丢量。
      // 仍败记 failed 并打 transientFail 标记（不投任何票），会话收尾时翻回 planned 交补跑节再试（retryRound<2 封顶防死循环）
      const isTransient = (rr) => /Protocol error|timed out|TimeoutError|net::|ERR_/i.test((rr && rr.note) || '');
      let transient = isTransient(r);
      for (let a = 0; !r.ok && !r.unknown && transient && a < 3; a++) {
        await sleep([8000, 15000, 30000][a]);
        r = await executeAction(page, e).catch((err) => ({ ok: false, note: err.message }));
        transient = isTransient(r);
        if (r.ok) r.note = '瞬态重试成功(第' + (a + 1) + '次重试)';
      }
      if (!r.ok && !r.unknown && transient) r.note = (r.note || '') + '（瞬态重试3次仍败）';

      if (r.ok) { e.status = 'done'; e.result = SIMULATE ? 'simulated' : 'ok'; done += 1; stats.executed.push(e.id); if (e.type === 'reply') { syncContacts(e, 'reply'); recordReply(e); } if (e.type === 'follow') syncContacts(e, 'follow'); }
      else if (r.unknown) { e.status = 'unknown'; e.result = '结果不明（占额度，禁重试，待核）: ' + (r.note || ''); stats.unknown.push(e.id); }
      // 关注幂等（10-18 条件回关）：实际已关注过的人按钮不出现，算完成不计失败（防误触连续失败熔断）
      else if (e.type === 'follow' && /可能已关注/.test(r.note || '')) {
        e.status = 'done'; e.result = '已关注过（幂等）'; done += 1; stats.executed.push(e.id);
      }
      // 权重维护（v1.1 M6）：目标帖不可见/已删是目标侧原因，跳过不计失败熔断
      else if (e.kind === 'maintain' && /未找到目标帖|页面加载失败/.test(r.note || '')) {
        e.status = 'skipped'; e.result = '目标帖不可见（维护跳过）: ' + (r.note || ''); stats.skipped.push(e.id);
      }
      // 失败处理（10-20 拍板"交付必达"）：连败熔断已拆——单条失败只记日志，队列永远继续；
      // 瞬态失败打标记，会话收尾翻回 planned 交补跑节再试。唯一整窗刹车=下方风控 toast
      else {
        e.status = 'failed'; e.result = r.note || '失败'; stats.failed.push(e.id);
        if (transient) e.transientFail = true;
      }
      saveQueue(queue);
      log({ action: 'execute', kind: e.kind || undefined, id: e.id, type: e.type, target: e.targetHandle || e.statusId, status: e.status, note: e.result, text: (e.type === 'post' || e.type === 'reply') ? String(e.text).slice(0, 60) : undefined });

      if (!sessionAborted) {
        const t = await (SIMULATE ? Promise.resolve(null) : riskToast(page));
        if (t) { sessionAborted = true; LEDGER.meta.abortedToday = today(); LEDGER.meta.abortReason = '风控toast: ' + t; saveLedger(LEDGER); }
      }
      if (done < MAX_ACTIONS) await gsleep(X.actionGapGaussMs);
    }
    // 交付必达（10-20 拍板）：熔断已拆，不再有任何"会话中止清场"——planned 项永远不死在队列里。
    // 会话收尾：瞬态失败项翻回 planned（retryRound<2 封顶），由补跑节/下一窗续跑；风控刹车时不翻（当日已停）
    if (!sessionAborted) {
      let requeued = 0;
      for (const e of queue) {
        if (e.status === 'failed' && e.transientFail && (e.retryRound || 0) < 2) {
          e.status = 'planned'; e.retryRound = (e.retryRound || 0) + 1; delete e.transientFail;
          e.result = (e.result || '') + ' → 翻回待跑（补跑第' + e.retryRound + '轮）'; requeued += 1;
        }
      }
      if (requeued) { saveQueue(queue); log({ action: 'requeue', count: requeued }); }
    }
  } finally {
    // 关闭多余页签再断开（10-19 修复：定时发帖多个 executor 进程共用窗口，各自关自己的 page
    // 会留下别人的页签→累积 22 个。改为全量清理；
    // 10-19 二次修复：必须留 1 页——比特浏览器 syncTabs 会把开着的页签回写进窗口配置的
    // 启动页 url，每次开窗全部复活，越积越多（owen 曾 11 页）。留 1 页 + 启动页配置单一化，双保险）
    // 10-21 三次修复：只关"本次会话新开的"页签（PRE_EXISTING_PAGES 之外的）——窗口被常驻/其他任务
    // 占用时，别拆别人工位；历史遗留空页签（窗口开的首次会话里没有 PRE_EXISTING）照清不误
    if (browser) {
      try {
        const allPages = await browser.pages();
        for (const p of allPages) {
          if (PRE_EXISTING_PAGES && PRE_EXISTING_PAGES.has(p)) continue; // 别人的工位，不碰
          if (allPages.length === 1) break; // 至少留 1 页
          try { await p.close(); } catch { }
        }
      } catch { }
      await browser.disconnect();
    }
    if (ws) await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { });
    saveQueue(queue);
    releaseLock();
  }
  log({ action: 'session', ...stats, combinedUsed: { reply: usedNow('reply'), follow: usedNow('follow'), like: usedNow('like') } });
  console.log(JSON.stringify({ account: ACCOUNT, queue: QUEUE_FILE, simulated: SIMULATE || undefined, ...stats, rollingUsed: { reply: usedNow('reply'), follow: usedNow('follow'), like: usedNow('like'), post: usedNow('post') } }, null, 2));
})().catch((e) => { console.error(e.message || e); try { releaseLock(); } catch { } process.exit(1); });
