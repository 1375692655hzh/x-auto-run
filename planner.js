// planner.js — 计划器（P3 大脑）：把关系池/互关话题/粉丝列表 → LLM 文案 → 质量门 → 当轮动作队列
// 用法: node planner.js --account butcher --mode visit|community|followback|all --window am|mid|pm
//   visit      纯 HTTP+LLM（不开浏览器）：关系池选对象 → FxTwitter 取对方最新帖 → 生成留言 → 入队
//   community  浏览器只读扫描互关话题 → 过滤 → LLM 生成互关回复（先关注后回复） → 入队
//   followback 浏览器只读扫自己粉丝列表 → 真人候选 → 入队关注动作
// 性质: planner 本身零互动（扫描只读、生成纯本地/LLM）；动作由 executor 执行。
// 配额: config.rounds.quotas（每窗）+ 每日总量 = 三窗之和；与已入队条目合并对账。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { generateReply } = require('./llm');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const R = CFG.rounds || {};
const WINS = Object.keys((CFG.rounds || {}).windows || { am: 1, mid: 1, pm: 1 }); // 窗位列表配置驱动（10-18 起四窗 8:30/13:00/16:00/20:00）
const L = CFG.limits;

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'butcher');
const WINDOW = argOf('window', 'am');
const MODE = argOf('mode', 'visit');
const MODES = String(MODE).split(',').map((x) => x.trim()).filter(Boolean);
const RQ = Object.assign({}, (CFG.rounds || {}).quotas || {}, ((CFG.rounds || {}).quotasByAccount || {})[ACCOUNT] || {}); // 每号配额=默认档打底+每号覆盖（10-18：wcixot 有独立数字，新增默认任务自动继承）
const ACCT = CFG.accounts.find((a) => a.key === ACCOUNT);
if (!ACCT) { console.error('config.accounts 无此账号: ' + ACCOUNT); process.exit(1); }
const PERSONA = (CFG.personas || {})[ACCOUNT];
if (!PERSONA) { console.error('config.personas 无此账号人设: ' + ACCOUNT); process.exit(1); }
const PROMPTS = CFG.prompts || {};
const PB = ((CFG.promptsByAccount || {})[ACCOUNT]) || {}; // 每号提示词覆盖（10-18 wcixot）
const briefOf = (m) => PB[m] || PROMPTS[m];
const OWN = new Set([ACCT.handle.toLowerCase(), (CFG.target.handle || '').toLowerCase(), ...CFG.accounts.map((a) => a.handle.toLowerCase())].filter(Boolean));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const log = (line) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'planner', account: ACCOUNT, window: WINDOW, ...line }) + '\n');
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ── 任务台账（新系统自己的去重/历史；读时并入 boost 旧台账视图） ──
const TS_FILE = path.join(STATE_DIR, `taskstate-${ACCOUNT}.json`);
function loadTaskstate() {
  const ts = readJson(TS_FILE) || { repliedAuthors: {}, repliedPosts: {}, replyHistory: [], tagIndex: 0 };
  ts.repliedAuthors = ts.repliedAuthors || {}; ts.repliedPosts = ts.repliedPosts || {}; ts.replyHistory = ts.replyHistory || [];
  // 并入 boost 旧台账视图（只读合并，不写回 boost 文件）
  const boost = readJson(path.join(STATE_DIR, ACCOUNT + '.json')) || {};
  for (const [h, d] of Object.entries(boost.communityAuthors || {})) if (!ts.repliedAuthors[h]) ts.repliedAuthors[h] = d;
  for (const id of Object.keys(boost.community || {})) if (!ts.repliedPosts[id]) ts.repliedPosts[id] = '2026-10-01';
  return ts;
}
function saveTaskstate(ts) { fs.writeFileSync(TS_FILE, JSON.stringify(ts, null, 2)); }

// ── 当日队列（跨窗合并对账） ──
function queuePath(win) { return path.join(QUEUE_DIR, `${today()}-${win}-${ACCOUNT}.json`); }
function loadQueue(win) { const q = readJson(queuePath(win)); return Array.isArray(q) ? q : []; }
function saveQueue(win, q) { fs.mkdirSync(QUEUE_DIR, { recursive: true }); fs.writeFileSync(queuePath(win), JSON.stringify(q, null, 2)); }
function countedToday(kind) { // 今日各窗已排的某类条目（planned/intent/done/unknown 均计，skipped 不计）
  let n = 0;
  for (const w of WINS) for (const e of loadQueue(w)) if (e.kind === kind && e.status !== 'skipped') n += 1;
  return n;
}
const dailyQuota = (kind) => WINS.reduce((s, w) => s + (RQ[kind] || {})[w], 0) || 0;
const windowQuota = (kind) => (RQ[kind] || {})[WINDOW] || 0;

// ── FxTwitter：取对象最新一条自发非回复帖（≤72h） ──
async function fetchLatestPost(handle) {
  const since = Math.floor(Date.now() / 1000 - 72 * 3600);
  try {
    const r = await fetch(`https://api.fxtwitter.com/2/profile/${handle}/statuses?with_replies=1&since=${since}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const h = handle.toLowerCase();
    const own = (j.results || []).filter((s) => ((s.author && s.author.screen_name) || '').toLowerCase() === h && !s.reposted_by && !s.replying_to && !s.possibly_sensitive);
    own.sort((a, b) => (b.created_timestamp || 0) - (a.created_timestamp || 0));
    const p = own[0];
    if (!p) return null;
    return { statusId: String(p.id), postUrl: `https://x.com/${handle}/status/${p.id}`, text: (p.text || '').slice(0, 600), at: p.created_at };
  } catch { return null; }
}

// ── 模式一：串门（纯 HTTP） ──
async function planVisit(ts) {
  const contacts = readJson(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`));
  if (!contacts) { console.log('关系池未建，串门跳过'); return []; }
  const inWindow = loadQueue(WINDOW).filter((e) => e.kind === 'visit' && e.status !== 'skipped').length;
  const cap = Math.min(windowQuota('visit') - inWindow, dailyQuota('visit') - countedToday('visit'));
  if (cap <= 0) { console.log('串门额度已满'); return []; }
  // 今日已入队对象（含其他窗）不重复选
  const queuedHandles = new Set();
  for (const w of WINS) for (const e of loadQueue(w)) if (e.status !== 'skipped' && e.targetHandle) queuedHandles.add(e.targetHandle);
  const baseId = loadQueue(WINDOW).length; // 补跑时 ID 续编，避免重复
  // 14天真关系门槛（2026-10-16 用户拍板：只计近2周与本号的真实互动；Owen圈候选默认不用于串门）
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const lastReal = (e) => {
    const evs = (e.activity && e.activity.theirEvents || []).filter((x) => x[2] === 'own-notif').map((x) => x[0]);
    if (e.activity && e.activity.ourLastReplyAt) evs.push(e.activity.ourLastReplyAt);
    if (e.relation && e.relation.weFollow && e.relation.weFollow.since) evs.push(e.relation.weFollow.since);
    if (e.relation && e.relation.theyFollow) evs.push(e.relation.theyFollow);
    return evs.sort().pop() || null;
  };
  const cands = Object.values(contacts.people || {})
    .filter((e) => !['gone', 'blocked', 'dormant'].includes(e.stage))
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const e of cands) {
    if (out.length >= cap) break;
    if (queuedHandles.has(e.handle)) continue; // 今日已排过的不重复
    const lr = lastReal(e);
    if (!lr || lr < cutoff14) continue; // 近14天与本号无真实互动 → 不选（含 Owen 圈候选）
    // 限频：互关好友 7 天 1 条，其他 21 天 1 条（taskstate 与 contacts 双查）
    const cd = (e.relation && e.relation.mutual) || e.stage === 'active' ? 7 : 21;
    const last = ts.repliedAuthors[e.handle] || (e.activity && e.activity.ourLastReplyAt) || null;
    if (last && dayDiff(last, today()) < cd) continue;
    const post = await fetchLatestPost(e.handle);
    if (!post) continue; // 72h 无自发新帖 → 跳过不凑数
    try {
      const r = await generateReply({ post: post.text, author: e.handle, persona: PERSONA, brief: briefOf('visit'), history: ts.replyHistory.slice(-8) });
      const qc = quality.check(r.text, { history: ts.replyHistory });
      if (!qc.ok) { console.log(`  质量门未过(@${e.handle}): ${qc.reason}`); continue; }
      out.push({ id: `${today()}-${WINDOW}-visit-${baseId + out.length + 1}`, account: ACCOUNT, type: 'reply', kind: 'visit', postUrl: post.postUrl, statusId: post.statusId, targetHandle: e.handle, text: qc.cleaned, followFirst: false, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() });
      console.log(`  串门入队 @${e.handle}（${e.stage}，分${e.score}）：${qc.cleaned.slice(0, 36)}…`);
    } catch (err) { console.log(`  LLM 失败(@${e.handle}): ${String(err.message).slice(0, 80)}`); }
    await sleep(rand(800, 1600));
  }
  return out;
}

// ── 浏览器只读原语（复用已验证实现） ──
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
async function collectPosts(page, limit) {
  return page.evaluate((limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, limit).map((art) => {
      const link = art.querySelector('a[href*="/status"]');
      const time = art.querySelector('time');
      const text = art.querySelector('[data-testid="tweetText"]');
      const nameEl = art.querySelector('[data-testid="User-Name"] a[href^="/"]');
      return {
        id: (link && (link.getAttribute('href').match(/\/status\/(\d+)/) || [])[1]) || null,
        link: link ? link.getAttribute('href') : null,
        time: time ? time.getAttribute('datetime') : null,
        text: text ? clean(text.textContent).slice(0, 300) : '',
        author: nameEl ? nameEl.getAttribute('href').replace(/^\//, '').toLowerCase() : null,
        locked: [...art.querySelectorAll('button, [role="button"]')].some((b) => /subscribe to unlock|订阅.{0,2}解锁|ロック解除/i.test((b.textContent || '').trim())),
      };
    }).filter((p) => p.id && p.link);
  }, limit).catch(() => []);
}

// ── 模式二：互关话题选帖（浏览器只读扫描） ──
async function planCommunity(ts) {
  const cap = Math.min(windowQuota('community'), dailyQuota('community') - countedToday('community'));
  if (cap <= 0) { console.log('互关额度已满'); return []; }
  const hour = new Date().getHours();
  if (hour < L.activeHours[0] || hour >= L.activeHours[1]) { console.log('不在执行窗，互关扫描跳过（守窗）'); return []; }
  const tags = CFG.task2.hashtags;
  const tag = tags[ts.tagIndex % tags.length];
  ts.tagIndex += 1; saveTaskstate(ts);
  const ws = await openWindow(ACCT.profileId);
  let cands = [];
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!(await verifyLogin(page, ACCT.handle))) throw new Error('登录态校验失败');
      await page.goto(`https://x.com/search?q=${encodeURIComponent('#' + tag)}&f=live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 45000 }).catch(() => { });
      await sleep(3000);
      for (let i = 0; i < 4; i++) { await humanScroll(page, rand(700, 1100)); await sleep(rand(600, 1200)); }
      const posts = await collectPosts(page, R.scanPosts || 30);
      const kws = (CFG.task2.keywords || []).map((k) => k.toLowerCase());
      const cutoff = Date.now() - 3 * 86400000;
      cands = posts.filter((p) => {
        const t = (p.text || '').toLowerCase();
        const authorCd = !ts.repliedAuthors[p.author] || dayDiff(ts.repliedAuthors[p.author], today()) >= L.communityAuthorCooldownDays;
        return kws.some((k) => t.includes(k))
          && p.author && !OWN.has(p.author) && !p.locked
          && p.time && Date.parse(p.time) >= cutoff
          && !ts.repliedPosts[p.id] && authorCd;
      });
      // 同作者只取一条 + 打乱（挑选感）
      const seen = new Set();
      cands = cands.filter((p) => { if (seen.has(p.author)) return false; seen.add(p.author); return true; });
      cands = cands.sort(() => Math.random() - 0.5).slice(0, cap + 3); // 多备 3 个给质量门淘汰
      console.log(`话题 #${tag} 扫描 ${posts.length} 条 → 候选 ${cands.length} 条（本轮配额 ${cap}）`);
    } finally { try { await page.close(); } catch { } await browser.disconnect(); } // 10-18 修复：先关页面再断开（漏关页面会随 BitBrowser 会话恢复累积）
  } finally { await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { }); }
  const baseId = loadQueue(WINDOW).length; // 补跑时 ID 续编，避免重复
  const queuedHandles = new Set();
  for (const w of WINS) for (const e of loadQueue(w)) if (e.status !== 'skipped' && e.targetHandle) queuedHandles.add(e.targetHandle);
  const out = [];
  for (const p of cands) {
    if (out.length >= cap) break;
    if (queuedHandles.has(p.author)) continue;
    try {
      const r = await generateReply({ post: p.text, author: p.author, persona: PERSONA, brief: briefOf('community'), history: ts.replyHistory.slice(-8) });
      const qc = quality.check(r.text, { history: ts.replyHistory });
      if (!qc.ok) { console.log(`  质量门未过(@${p.author}): ${qc.reason}`); continue; }
      out.push({ id: `${today()}-${WINDOW}-community-${baseId + out.length + 1}`, account: ACCOUNT, type: 'reply', kind: 'community', postUrl: 'https://x.com' + p.link, statusId: p.id, targetHandle: p.author, text: qc.cleaned, followFirst: true, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() });
      console.log(`  互关入队 @${p.author}：${qc.cleaned.slice(0, 36)}…`);
    } catch (err) { console.log(`  LLM 失败(@${p.author}): ${String(err.message).slice(0, 80)}`); }
    await sleep(rand(800, 1600));
  }
  return out;
}

// ── 模式三：回关采集（浏览器只读扫粉丝列表） ──
async function planFollowback(ts) {
  const cap = Math.min(windowQuota('followBack') || 0, 30); // 10-18 起回关配额同源每号表（butcher 已拍板 0）
  if (cap <= 0) { console.log('回关额度已满'); return []; }
  const hour = new Date().getHours();
  if (hour < L.activeHours[0] || hour >= L.activeHours[1]) { console.log('不在执行窗，回关扫描跳过'); return []; }
  const contacts = readJson(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`));
  const boost = readJson(path.join(STATE_DIR, ACCOUNT + '.json')) || {};
  const knownFollows = new Set([...Object.keys(boost.follows || {}), ...Object.keys(boost.followBackDone || {}),
    ...Object.values((contacts && contacts.people) || {}).filter((e) => e.relation && e.relation.weFollow).map((e) => e.handle)]);
  const ws = await openWindow(ACCT.profileId);
  let cands = [];
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!(await verifyLogin(page, ACCT.handle))) throw new Error('登录态校验失败');
      await page.goto(`https://x.com/${ACCT.handle}/followers`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="UserCell"]', { timeout: 30000 }).catch(() => { });
      for (let i = 0; i < 12; i++) {
        if ((await page.$$('[data-testid="UserCell"]')).length >= (CFG.follow.followBack.scanCells || 40)) break;
        await humanScroll(page, rand(500, 900)); await sleep(rand(800, 1600));
      }
      const cells = await page.$$('[data-testid="UserCell"]');
      for (const cell of cells) {
        if (cands.length >= cap + 5) break;
        const info = await cell.evaluate((el) => ({
          handle: ((el.querySelector('a[href^="/"]') || {}).getAttribute ? el.querySelector('a[href^="/"]').getAttribute('href') : '').replace(/^\//, '').toLowerCase(),
          hasAvatar: !!el.querySelector('img'),
          hasBio: el.querySelectorAll('div[dir="auto"]').length >= 3,
          canFollowBack: !!el.querySelector('button[data-testid$="-follow"]'),
        })).catch(() => null);
        if (!info || !info.handle || !info.canFollowBack || !info.hasAvatar || !info.hasBio) continue;
        if (OWN.has(info.handle) || knownFollows.has(info.handle)) continue;
        cands.push(info.handle);
      }
      console.log(`粉丝列表扫描 ${cells.length} 格 → 回关候选 ${cands.length}（本轮 ${cap}）`);
    } finally { try { await page.close(); } catch { } await browser.disconnect(); } // 10-18 修复：先关页面再断开（漏关页面会随 BitBrowser 会话恢复累积）
  } finally { await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { }); }
  return cands.slice(0, cap).map((h, i) => ({ id: `${today()}-${WINDOW}-fb-${i + 1}`, account: ACCOUNT, type: 'follow', kind: 'followback', targetHandle: h, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() }));
}

// ── 模式三b：条件回关（10-18 用户拍板"别人回复我+关注我→可以回关"）──
// 数据源=关系池通知扫描的 theirEvents：7 天内同时有 (reply|mention) 事件与 follow 事件、且我方尚未关注的人才回；
// 与旧"逢粉必回"不同：只回有真实互动的人；回关后 relation.weFollow 落档不再重复。
async function planReplyFollowBack(ts) {
  const contacts = readJson(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`));
  if (!contacts) { console.log('关系池未建，条件回关跳过'); return []; }
  const inWin = loadQueue(WINDOW).filter((e) => e.kind === 'followback-reply' && e.status !== 'skipped').length;
  const cap = Math.min(windowQuota('replyFollowBack') - inWin, 30 - countedToday('followback-reply'));
  if (cap <= 0) { console.log('条件回关额度已满/未配置'); return []; }
  const cut7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const queuedHandles = new Set();
  for (const w of WINS) for (const e of loadQueue(w)) if (e.kind === 'followback-reply' && e.targetHandle) queuedHandles.add(e.targetHandle.toLowerCase());
  const out = [];
  const baseId = loadQueue(WINDOW).length;
  for (const e of Object.values(contacts.people || {})) {
    if (out.length >= cap) break;
    const h = (e.handle || '').toLowerCase();
    if (!h || OWN.has(h) || queuedHandles.has(h)) continue;
    if (e.relation && e.relation.weFollow) continue; // 已关注过不重复
    const evs = (e.activity && e.activity.theirEvents) || [];
    const recent = evs.filter((x) => x[0] >= cut7);
    const replied = recent.some((x) => x[1] === 'reply' || x[1] === 'mention');
    const followed = recent.some((x) => x[1] === 'follow');
    if (!(replied && followed)) continue;
    out.push({ id: `${today()}-${WINDOW}-frb-${baseId + out.length + 1}`, account: ACCOUNT, type: 'follow', kind: 'followback-reply', targetHandle: e.handle, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() });
    console.log(`  条件回关入队: @${e.handle}（7天内 回复+关注 双条件满足）`);
  }
  if (!out.length) console.log('无条件回关候选（每日 09:35/09:45 通知扫描后更新候选）');
  return out;
}

// ── 模式四：取关采集（能力 2026-10-16 建；默认策略 off，改 config.follow.unfollowPolicy 启用） ──
// 参考：WCixot 取关自动化（非互关优先/互关保留/随机节奏）+ XActions smartUnfollow（白名单/仅清理自己关注的/宽限期）。
// 执行侧双保险：rollingCaps.unfollow=0 时执行器直接拒（fail-closed）；执行时现场复查互关徽标，互关一律保留。
async function planUnfollow(ts) {
  const UP = Object.assign({ mode: 'off', perRun: 0, graceDays: 14, scanCells: 60, whitelist: [] }, (CFG.follow && CFG.follow.unfollowPolicy) || {});
  if (UP.mode === 'off' || !UP.perRun) { console.log('取关策略未启用（config.follow.unfollowPolicy.mode=off）'); return []; }
  const hour = new Date().getHours();
  if (hour < L.activeHours[0] || hour >= L.activeHours[1]) { console.log('不在执行窗，取关扫描跳过'); return []; }
  const whitelist = new Set([...(UP.whitelist || []), CFG.target.handle.toLowerCase(), ...CFG.accounts.map((a) => a.handle.toLowerCase())]);
  const contacts = readJson(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`));
  const ws = await openWindow(ACCT.profileId);
  let cands = [];
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!(await verifyLogin(page, ACCT.handle))) throw new Error('登录态校验失败');
      await page.goto(`https://x.com/${ACCT.handle}/following`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="UserCell"]', { timeout: 30000 }).catch(() => { });
      for (let i = 0; i < 14; i++) {
        if ((await page.$$('[data-testid="UserCell"]')).length >= (UP.scanCells || 60)) break;
        await humanScroll(page, rand(500, 900)); await sleep(rand(800, 1600));
      }
      const cells = await page.$$('[data-testid="UserCell"]');
      for (const cell of cells) {
        const info = await cell.evaluate((el) => ({
          handle: ((el.querySelector('a[href^="/"]') || {}).getAttribute ? el.querySelector('a[href^="/"]').getAttribute('href') : '').replace(/^\//, '').toLowerCase(),
          mutual: !!el.querySelector('[data-testid="userFollowIndicator"]'), // "关注你"徽标=互关
          isFollowing: !!el.querySelector('button[data-testid$="-unfollow"]'),
        })).catch(() => null);
        if (!info || !info.handle || !info.isFollowing) continue;
        if (OWN.has(info.handle) || whitelist.has(info.handle)) continue;
        if (UP.mode === 'nonFollowers' && info.mutual) continue; // 互关保留
        if (UP.mode === 'trackedTimeout') {
          const c = contacts && contacts.people[info.handle];
          const since = c && c.relation && c.relation.weFollow && c.relation.weFollow.since;
          if (!since || dayDiff(since, today()) < (UP.graceDays || 14)) continue; // 只清有记录且过宽限期的
        }
        cands.push(info.handle);
        if (cands.length >= (UP.perRun || 0) + 5) break; // 多备几个给现场复查淘汰
      }
      console.log(`关注列表扫描 ${cells.length} 格 → 取关候选 ${cands.length}（模式 ${UP.mode}，本轮 ${UP.perRun}）`);
    } finally { try { await page.close(); } catch { } await browser.disconnect(); } // 10-18 修复：先关页面再断开（漏关页面会随 BitBrowser 会话恢复累积）
  } finally { await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { }); }
  const baseId = loadQueue(WINDOW).length;
  return cands.slice(0, UP.perRun).map((h, i) => ({ id: `${today()}-${WINDOW}-unfollow-${baseId + i + 1}`, account: ACCOUNT, type: 'unfollow', kind: 'unfollow', targetHandle: h, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() }));
}

// ── 模式五：原创发布拾取（2026-10-16 补全）──
// 接口约定：内容源（你自己的发布自动化/数据站）把成品文案投递到 posts-inbox/ 目录：
//   *.json = ["文案1","文案2"] 或 [{"text":"文案"}]；*.txt = 一行一条。
// planner 拾取→280 加权校验→去重（今日队列+已发历史）→按 2/窗·10/天 入队→原文件改名为 *.done.json（留审计）。
// 内容不过质量门（你的编辑权），只做上限与去重；执行走 compose 页，成功只认"已发送"气泡。
const POSTS_INBOX = path.join(ROOT, 'posts-inbox');
async function planPost(ts) {
  const PC = Object.assign({ perWindow: 2, perDay: 10 }, CFG.posts || {});
  // 窗预算硬门（三方方案 2026-10-18）：拍板的 windowAllocation 优先于引擎帽（午窗=0 绝不发），防手工投递绕过；多号各用各的预算（budgetByAccount，10-18 wcixot 接入）
  const BA = ((CFG.posts || {}).budgetByAccount || {})[ACCOUNT] || (CFG.posts || {}).budget || {};
  const alloc = (BA.windowAllocation || {})[WINDOW];
  const inWindow = loadQueue(WINDOW).filter((e) => e.kind === 'post' && e.status !== 'skipped').length;
  const cap = Math.min(alloc != null ? alloc : PC.perWindow, PC.perWindow, (BA.perDay != null ? BA.perDay : PC.perDay) - countedToday('post'));
  if (cap - inWindow <= 0) { console.log('发布预算已满或本窗分配为 0（拍板档位）'); return []; }
  let files = [];
  try {
    // P7 多号防串号（10-18 wcixot 接入前置）：只拾取本账号前缀 pull-<ACCOUNT>-* 与手动投放的非 pull- 前缀文件；他号的投递绝不跨号消费；C1：.done- 归档绝不再扫
    files = fs.readdirSync(POSTS_INBOX).filter((f) => ((f.startsWith(`pull-${ACCOUNT}-`) || !f.startsWith('pull-')) && f.endsWith('.json') && !f.includes('.done-')) || f.endsWith('.txt'));
  } catch { return []; }
  const texts = []; // 元素为 {text, quote?, quoteUrl?}（10-18 引用帖）
  const usedFiles = [];
  for (const f of files) {
    let items = [];
    try {
      const raw = fs.readFileSync(path.join(POSTS_INBOX, f), 'utf8');
      if (f.endsWith('.txt')) items = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t }));
      else { const j = JSON.parse(raw); const arr = Array.isArray(j) ? j : (j.items || j.posts || []); items = arr.map((x) => (typeof x === 'string' ? { text: x } : x)).filter((x) => x && x.text); }
    } catch { console.log(`  投递文件解析失败: ${f}`); continue; }
    usedFiles.push(f);
    for (const it of items) texts.push({ text: String(it.text).trim(), quote: !!it.quote, quoteUrl: it.quoteUrl || it.quote_url || null });
    if (texts.length >= cap + 5) break;
  }
  if (!texts.length) { console.log('posts-inbox/ 无待发内容'); return []; }
  // 去重：今日各窗队列 + 已发历史
  const seen = new Set(ts.replyHistory);
  for (const w of WINS) for (const e of loadQueue(w)) if (e.text) seen.add(e.text);
  const baseId = loadQueue(WINDOW).length;
  const out = [];
  for (const t of texts) {
    if (out.length >= cap - inWindow) break;
    if (!t || !t.text || seen.has(t.text)) { console.log('  跳过（空/重复）:', String(t.text).slice(0, 24)); continue; }
    const wl = quality.weightedLen(t.text);
    if (wl > 280) { console.log(`  跳过（超长 ${wl}>280）:`, t.text.slice(0, 24)); continue; }
    seen.add(t.text); // C2 修复：选中即入去重集（同批相同文本不再二次入队）
    out.push({ id: `${today()}-${WINDOW}-post-${baseId + out.length + 1}`, account: ACCOUNT, type: 'post', kind: 'post', text: t.text, quote: t.quote || undefined, quoteUrl: t.quoteUrl || undefined, window: WINDOW, jitterSec: 60 + Math.floor(Math.random() * 120), status: 'planned', createdAt: new Date().toISOString() }); // jitterSec：发帖窗内 60-180s 随机偏移防整点指纹（三方方案 P4）
    console.log(`  发布入队（${wl}字重${t.quote ? '·引用帖' : ''}）: ${t.text.slice(0, 32)}…`);
  }
  // 消费投递文件（改名留审计；后缀去掉 .json 防重扫=C1 双保险；未入队的超额内容保留在 .done 里不丢）
  for (const f of usedFiles) { try { fs.renameSync(path.join(POSTS_INBOX, f), path.join(POSTS_INBOX, f + '.done-' + Date.now())); } catch { } }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────
(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('state/PAUSE 急停生效中，planner 退出'); process.exit(0); }
  const ts = loadTaskstate();
  let entries = [];
  if (MODES.includes('visit') || MODES.includes('all')) entries = entries.concat(await planVisit(ts));
  if (MODES.includes('community') || MODES.includes('all')) entries = entries.concat(await planCommunity(ts));
  if (MODES.includes('followback') || MODES.includes('all')) entries = entries.concat(await planFollowback(ts));
  if (MODES.includes('replyfollowback') || MODES.includes('all')) entries = entries.concat(await planReplyFollowBack(ts));
  if (MODES.includes('unfollow') || MODES.includes('all')) entries = entries.concat(await planUnfollow(ts));
  if (MODES.includes('post') || MODES.includes('all')) entries = entries.concat(await planPost(ts));
  if (entries.length) {
    const q = loadQueue(WINDOW).concat(entries);
    saveQueue(WINDOW, q);
  }
  saveTaskstate(ts);
  log({ action: 'plan', mode: MODE, queued: entries.length, quotaLeft: { visit: dailyQuota('visit') - countedToday('visit'), community: dailyQuota('community') - countedToday('community') } });
  console.log(`\nplanner 完成：入队 ${entries.length} 条 → ${queuePath(WINDOW)}`);
})().catch((e) => { console.error(e.message || e); log({ action: 'plan', mode: MODE, error: String(e.message || e) }); process.exit(1); });
