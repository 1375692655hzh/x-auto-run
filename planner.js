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
const DIAG = argv.includes('--scan-diag'); // 诊断模式：只扫描+死因统计，不入队不生成（10-20 互关 0 条事故排查用）
const DIAG_TOTAL = { scanned: 0, cands: 0, rej: {} };
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
const dailyQuota = (kind) => WINS.reduce((s, w) => s + ((RQ[kind] || {})[w] || 0), 0); // 10-18 修复：p 窗无值致 NaN→0→额度永远为 0
const windowQuota = (kind) => (RQ[kind] || {})[WINDOW] || 0;

// ── FxTwitter：取对象最新一条自发非回复帖（≤72h） ──
// 10-20 用户拍板"没有图片才回复帖子"：带图/视频帖跳过（我们看不到图，回复必违和），
// 沿时间线往下找最近一条无媒体帖；72h 内全是带图帖 → 返回 null 本窗不串（不凑数）
const hasMedia = (s) => { const m = s.media || {}; return ((m.photos || []).length + (m.videos || []).length + (m.all || []).length) > 0; };
async function fetchLatestPost(handle) {
  const since = Math.floor(Date.now() / 1000 - 72 * 3600);
  try {
    const r = await fetch(`https://api.fxtwitter.com/2/profile/${handle}/statuses?with_replies=1&since=${since}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const h = handle.toLowerCase();
    const own = (j.results || []).filter((s) => ((s.author && s.author.screen_name) || '').toLowerCase() === h && !s.reposted_by && !s.replying_to && !s.possibly_sensitive);
    own.sort((a, b) => (b.created_timestamp || 0) - (a.created_timestamp || 0));
    const SKIP_MEDIA = (CFG.limits || {}).skipMediaReplies !== false;
    const p = SKIP_MEDIA ? own.find((s) => !hasMedia(s)) : own[0];
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
  // 30天真关系窗（10-20 用户拍板放宽 14→30："串门供给必达"——butcher 池仅 14 人曾晚窗只排到 1 条；
  // 互关成功对象由 executor.syncContacts 自动入池（weFollow.since 即新鲜真互动），供给随运营自增长）
  const freshDays = (CFG.rounds || {}).visitFreshDays || 30;
  const cutoffReal = new Date(Date.now() - freshDays * 86400000).toISOString().slice(0, 10);
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
    if (!lr || lr < cutoffReal) continue; // 近30天与本号无真实互动 → 不选（含 Owen 圈候选）
    // 限频：互关好友 7 天 1 条，其他 21 天 1 条（taskstate 与 contacts 双查）
    const cd = (e.relation && e.relation.mutual) || e.stage === 'active' ? 7 : 21;
    const last = ts.repliedAuthors[e.handle] || (e.activity && e.activity.ourLastReplyAt) || null;
    if (last && dayDiff(last, today()) < cd) continue;
    const post = await fetchLatestPost(e.handle);
    if (!post) continue; // 72h 无自发新帖 → 跳过不凑数
    // 生成失败换语气重试 1 次（10-20 拍板"交付必达"：质量门淘汰不许丢计划量；仍不过才放弃该候选）
    let qc = null;
    for (let g = 0; g < 2; g++) {
      try {
        const r = await generateReply({ post: post.text, author: e.handle, persona: PERSONA, brief: briefOf('visit'), history: ts.replyHistory.slice(-8) });
        qc = quality.check(r.text, { history: ts.replyHistory });
      } catch (err) { console.log(`  LLM 失败(@${e.handle}): ${String(err.message).slice(0, 80)}`); qc = null; break; }
      if (qc.ok) break;
      console.log(`  质量门未过(@${e.handle}，第${g + 1}次): ${qc.reason}${g === 0 ? '，重试' : ''}`);
    }
    if (!qc || !qc.ok) continue;
    out.push({ id: `${today()}-${WINDOW}-visit-${baseId + out.length + 1}`, account: ACCOUNT, type: 'reply', kind: 'visit', postUrl: post.postUrl, statusId: post.statusId, targetHandle: e.handle, text: qc.cleaned, followFirst: false, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() });
    console.log(`  串门入队 @${e.handle}（${e.stage}，分${e.score}）：${qc.cleaned.slice(0, 36)}…`);
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
        hasPhoto: !!art.querySelector('[data-testid="tweetPhoto"]'), // 10-20 拍板"没有图片才回复帖子"：带图帖在互关过滤层淘汰
        locked: [...art.querySelectorAll('button, [role="button"]')].some((b) => /subscribe to unlock|订阅.{0,2}解锁|ロック解除/i.test((b.textContent || '').trim())),
      };
    }).filter((p) => p.id && p.link);
  }, limit).catch(() => []);
}

// ── 模式二：互关话题选帖（浏览器只读扫描） ──
async function planCommunity(ts) {
  const cap = Math.min(windowQuota('community'), dailyQuota('community') - countedToday('community'));
  if (cap <= 0 && !DIAG) { console.log('互关额度已满'); return []; }
  const scanCap = DIAG ? 99 : cap; // 诊断模式不受配额门（排查看的是供给，不是额度）
  const hour = new Date().getHours();
  if (hour < L.activeHours[0] || hour >= L.activeHours[1]) { console.log('不在执行窗，互关扫描跳过（守窗）'); return []; }
  const tags = CFG.task2.hashtags;
  // 每窗多话题扫描凑配额（10-20 修复：原"一轮一话题"使整窗配额押在单话题瞬时状态上——
  // wcixot p1 轮到干涸的 #浇朋友 7 条全筛 → 0/14 事故；K3 原设计本就是轮换多话题）
  // 10-20 深夜二次加固（交付必达）：topicsPerScan=3 是下限不是上限——没凑满 cap+3 就轮完全部话题，杜绝"3 话题同时干涸"死角
  const topicsPerScan = Math.max(1, (CFG.task2 || {}).topicsPerScan || 3);
  const maxTopics = Math.max(topicsPerScan, tags.length);
  const ws = await openWindow(ACCT.profileId);
  let cands = [];
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!(await verifyLogin(page, ACCT.handle))) throw new Error('登录态校验失败');
      for (let ti = 0; ti < maxTopics; ti++) {
        if (!DIAG && cands.length >= cap + 3 && ti >= topicsPerScan) break; // 凑够下限后才允许提前收；未凑满轮完全部话题
        const tag = tags[ts.tagIndex % tags.length];
        ts.tagIndex += 1; saveTaskstate(ts);
      await page.goto(`https://x.com/search?q=${encodeURIComponent('#' + tag)}&f=live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 45000 }).catch(() => { });
      await sleep(3000);
      for (let i = 0; i < 4; i++) { await humanScroll(page, rand(700, 1100)); await sleep(rand(600, 1200)); }
      const posts = await collectPosts(page, R.scanPosts || 30);
      // 10-20 用户拍板"按建议执行"拆除：关键词过滤/作者14天冷却/帖龄3天上限/同批同作者单条——
      // 互关要求=话题页的帖就回；保留的硬正确：自家号排除、订阅帖（用户旧规）、已回过的帖去重
      // 10-20 深夜追加（拍板"没有图片才回复帖子"）：带图帖淘汰（看不到图，回复必违和）
      const SKIP_MEDIA = (CFG.limits || {}).skipMediaReplies !== false;
      const rej = { 自家号: 0, 锁定帖: 0, 已回过帖: 0, 带图帖: 0 };
      const fresh = posts.filter((p) => {
        if (!p.author) return false;
        if (OWN.has(p.author)) { rej.自家号++; return false; }
        if (p.locked) { rej.锁定帖++; return false; }
        if (SKIP_MEDIA && p.hasPhoto) { rej.带图帖++; return false; }
        if (ts.repliedPosts[p.id]) { rej.已回过帖++; return false; }
        return true;
      });
      const rejLine = Object.entries(rej).filter(([, v]) => v > 0).map(([k, v]) => k + '×' + v).join('、') || '无';
      console.log(`话题 #${tag} 扫描 ${posts.length} 条 → 新增候选 ${fresh.length} 条（本轮配额 ${cap}；淘汰：${rejLine}）`);
      if (DIAG) { DIAG_TOTAL.scanned += posts.length; DIAG_TOTAL.cands += fresh.length; for (const [k, v] of Object.entries(rej)) DIAG_TOTAL.rej[k] = (DIAG_TOTAL.rej[k] || 0) + v; }
      cands = cands.concat(fresh); // 跨话题累计，凑满配额
      } // end 话题循环
      if (DIAG) { console.log('[诊断汇总] 扫描 ' + DIAG_TOTAL.scanned + ' 条 → 合格候选 ' + DIAG_TOTAL.cands + '；死因合计：' + (Object.entries(DIAG_TOTAL.rej).filter(([, v]) => v > 0).map(([k, v]) => k + '×' + v).join('、') || '无')); return []; } // 诊断模式：只扫描统计，不入队不生成不消耗 LLM
      cands = cands.sort(() => Math.random() - 0.5).slice(0, cap + 3); // 多备 3 个给质量门淘汰
    } finally { try { await page.close(); } catch { } await browser.disconnect(); } // 10-18 修复：先关页面再断开（漏关页面会随 BitBrowser 会话恢复累积）
  } finally { await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { }); }
  const baseId = loadQueue(WINDOW).length; // 补跑时 ID 续编，避免重复
  const queuedHandles = new Set();
  for (const w of WINS) for (const e of loadQueue(w)) if (e.status !== 'skipped' && e.targetHandle) queuedHandles.add(e.targetHandle);
  const out = [];
  for (const p of cands) {
    if (out.length >= cap) break;
    if (queuedHandles.has(p.author)) continue;
    // 生成失败换语气重试 1 次（10-20 拍板"交付必达"：质量门淘汰不许丢计划量；候选有 +3 缓冲，双保险）
    let qc = null;
    for (let g = 0; g < 2; g++) {
      try {
        const r = await generateReply({ post: p.text, author: p.author, persona: PERSONA, brief: briefOf('community'), history: ts.replyHistory.slice(-8) });
        qc = quality.check(r.text, { history: ts.replyHistory });
      } catch (err) { console.log(`  LLM 失败(@${p.author}): ${String(err.message).slice(0, 80)}`); qc = null; break; }
      if (qc.ok) break;
      console.log(`  质量门未过(@${p.author}，第${g + 1}次): ${qc.reason}${g === 0 ? '，重试' : ''}`);
    }
    if (!qc || !qc.ok) continue;
    out.push({ id: `${today()}-${WINDOW}-community-${baseId + out.length + 1}`, account: ACCOUNT, type: 'reply', kind: 'community', postUrl: 'https://x.com' + p.link, statusId: p.id, targetHandle: p.author, text: qc.cleaned, followFirst: true, window: WINDOW, status: 'planned', createdAt: new Date().toISOString() });
    console.log(`  互关入队 @${p.author}：${qc.cleaned.slice(0, 36)}…`);
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
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开
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
  // 10-19 拍板：条件回关全账号无任务上限（满足"7天内回复过我+关注过我"即回，不设每日/每窗额度）；
  // 60 仅是防异常爆量的护栏，真实约束=候选条件筛选 + 滚动关注帽（executor.rollingCaps.follow）
  const cap = 60;
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
    page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动点离开
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
  // 10-20 修复：{min,max} 区间对象直接进 Math.min=NaN（曾致窗帽形同虚设）——改为"日期+窗+账号"做种子掷确定数，
  // 与 content-pull 滴灌两边算出同一个数（互不协调也不错位，杜绝滴 3 条消费帽 6 条的错位）
  const BA = ((CFG.posts || {}).budgetByAccount || {})[ACCOUNT] || (CFG.posts || {}).budget || {};
  const alloc = (BA.windowAllocation || {})[WINDOW];
  const seedRoll = (mn, mx) => { const s = `${today()}|${WINDOW}|${ACCOUNT}|${mn}|${mx}`; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return mn + (h % (mx - mn + 1)); };
  const allocN = alloc && typeof alloc === 'object' ? seedRoll(alloc.min, alloc.max) : alloc;
  const inWindow = loadQueue(WINDOW).filter((e) => e.kind === 'post' && e.status !== 'skipped').length;
  const cap = Math.min(allocN != null ? allocN : PC.perWindow, PC.perWindow, (BA.perDay != null ? BA.perDay : PC.perDay) - countedToday('post'));
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
  // 修复（10-19 发布死锁根因）：即使 texts 为空也要消费文件（改名 .done），否则空文件永远留在投递箱 →
  // content-pull 看到"未消费"拒绝滴新 → planner 看到"无内容"不消费 → 死锁，全天发布=0
  for (const f of usedFiles) { try { fs.renameSync(path.join(POSTS_INBOX, f), path.join(POSTS_INBOX, f + '.done-' + Date.now())); } catch { } }
  if (!texts.length) { console.log('posts-inbox/ 无待发内容（文件已消费防死锁）'); return []; }
  // 去重：今日各窗队列 + 已发历史
  const seen = new Set(ts.replyHistory);
  for (const w of WINS) for (const e of loadQueue(w)) if (e.text) seen.add(e.text);
  const baseId = loadQueue(WINDOW).length;
  const out = [];
  // 定时发布（10-18 用户拍板）：每条帖带 postAt 精确时刻=窗起点+首帖起步延迟+累计随机间隔(1~10min/条)，由 round 到点逐条单独拉起
  const GAP = (CFG.posts || {}).gapMin || [1, 10];
  // 首帖起步延迟 0~5min（10-19 拍板）：三号同刻开窗，原"第1条=窗起点即发"会让三号首帖全落同一 49 秒带=协同时间指纹；每号每天独立掷一次
  const FD = (CFG.posts || {}).firstPostDelayMin || [0, 5];
  const wTime = (((CFG.rounds || {}).windows || {})[WINDOW] || {}).time || '09:35';
  let cumMin = FD[0] + Math.random() * (FD[1] - FD[0]);
  for (const t of texts) {
    if (out.length >= cap - inWindow) break;
    if (!t || !t.text || seen.has(t.text)) { console.log('  跳过（空/重复）:', String(t.text).slice(0, 24)); continue; }
    const wl = quality.weightedLen(t.text);
    if (wl > 280) { console.log(`  跳过（超长 ${wl}>280）:`, t.text.slice(0, 24)); continue; }
    seen.add(t.text); // C2 修复：选中即入去重集（同批相同文本不再二次入队）
    if (out.length > 0) cumMin += GAP[0] + Math.random() * (GAP[1] - GAP[0]); // 第 1 条=窗起点即发，其后累计 1~10min 随机
    const [wh, wm] = String(wTime).split(':').map(Number);
    const bj = new Date(Date.now() + 8 * 3600000); // 北京日期分量
    const postAtMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), wh - 8, wm) + cumMin * 60000 + Math.floor(Math.random() * 50) * 1000; // 北京墙钟 wh:wm +累计间隔 +秒级随机
    out.push({ id: `${today()}-${WINDOW}-post-${baseId + out.length + 1}`, account: ACCOUNT, type: 'post', kind: 'post', text: t.text, quote: t.quote || undefined, quoteUrl: t.quoteUrl || undefined, window: WINDOW, postAt: new Date(postAtMs).toISOString(), status: 'planned', createdAt: new Date().toISOString() });
    console.log(`  发布入队（${wl}字重${t.quote ? '·引用帖' : ''}·定时 ${String(wTime)}+${cumMin.toFixed(0)}min）: ${t.text.slice(0, 32)}…`);
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
