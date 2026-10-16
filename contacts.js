// contacts.js — 通用关系台账（P1）：三源采集 → 互惠打分 → 关系分层 → 有界存储
// 规范依据: ./执行计划-综合版.md P1 / ./规范与约束.md §10
// 用法:
//   node contacts.js --account butcher --build      文件源建池/更新（follows 台账 + communityAuthors + owen-insights 导入）
//   node contacts.js --account butcher --scan       浏览器只读：扫自己通知页并入池（守 09:00-22:00 执行窗）
//   node contacts.js --account butcher --liveness   FxTwitter 存活检查（纯 HTTP，标 gone；逐号限速）
//   node contacts.js --account butcher --report     只读打印报告
// 性质: 纯只读采集与分析——不点赞、不回复、不关注、不点击任何互动按钮。
// 有界存储: 活跃池 poolCap(150) 按分淘汰入 archived；archived TTL 90 天清除；每人事件 ≤60；
//           archived 里的对象再活跃自动复活回活跃池。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const C = Object.assign({ poolCap: 150, archiveCap: 300, archiveTtlDays: 90, dormantDays: 14, activeWindowDays: 30, maxScreens: 8, maxSessionMinutes: 12 }, CFG.contacts || {});
const L = CFG.limits;

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ACCOUNT = argOf('account', 'butcher');
const MODE = argv.includes('--build') ? 'build' : argv.includes('--scan') ? 'scan' : argv.includes('--liveness') ? 'liveness' : argv.includes('--report') ? 'report' : null;
if (!MODE) { console.error('用法: node contacts.js --account <key> --build|--scan|--liveness|--report'); process.exit(1); }

const ACCT = CFG.accounts.find((a) => a.key === ACCOUNT);
if (!ACCT) { console.error('config.accounts 无此账号: ' + ACCOUNT); process.exit(1); }
// 自家矩阵号永不入池（它们的出现是任务效果，不是自然关系）
const OWN = new Set([ACCT.handle.toLowerCase(), (CFG.target.handle || '').toLowerCase(), ...CFG.accounts.map((a) => a.handle.toLowerCase())].filter(Boolean));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const isoDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

function log(line) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'contacts', account: ACCOUNT, ...line }) + '\n');
}

// ── 台账读写（fail-closed，同 boost.js P0 语义） ─────────
function blankLedger() { return { updated: null, people: {}, archived: {} }; }
function loadLedger() {
  const p = path.join(STATE_DIR, `contacts-${ACCOUNT}.json`);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return blankLedger(); throw e; }
  let st = null;
  try { st = JSON.parse(raw); } catch { }
  if (!st || typeof st !== 'object') {
    try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch { }
    throw new Error(`关系台账损坏（已备份），终止：${p}`);
  }
  return { ...blankLedger(), ...st };
}
function saveLedger(led) {
  led.updated = new Date().toISOString();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`), JSON.stringify(led, null, 2));
}

function entryOf(led, handle) {
  return (led.people[handle] = led.people[handle] || {
    handle, name: null, firstSeen: new Date().toISOString(), updatedAt: null,
    sources: [],
    relation: { weFollow: null, theyFollow: null, mutual: false },
    activity: { theirEvents: [], theirLastAt: null, ourReplies: 0, ourLastReplyAt: null },
    eligibility: { blocked: null, gone: false },
    score: 0, stage: 'new',
  });
}
// 事件合并：键=日期|类型|来源，跨 run 去重；每人保留最近 60 条
function addEvents(e, events) {
  const seen = new Set(e.activity.theirEvents.map((x) => x.join('|')));
  for (const [date, type, source] of events) {
    if (!date) continue;
    const k = `${date}|${type}|${source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    e.activity.theirEvents.push([date, type, source]);
  }
  e.activity.theirEvents.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (e.activity.theirEvents.length > 60) e.activity.theirEvents = e.activity.theirEvents.slice(-60);
  const last = e.activity.theirEvents[e.activity.theirEvents.length - 1];
  const lastIso = last ? last[0] : null;
  if (lastIso && (!e.activity.theirLastAt || lastIso > isoDate(e.activity.theirLastAt))) e.activity.theirLastAt = lastIso;
}

// ── 打分与分层 ────────────────────────────────────────────
// 互惠分 = 近30天对方互动加权次数(自通知1.0/Owen圈0.4) + 2×活跃衰减 + 互关加成2 − 单向付出惩罚3
// （我们连回≥2次而对方近30天零互动 → 降权；分数透明可解释，报告里给全分解）
function computeScore(e) {
  const since30 = today();
  const from = new Date(Date.now() - C.activeWindowDays * 86400000).toISOString().slice(0, 10);
  const ev30 = e.activity.theirEvents.filter(([d]) => d >= from && d <= since30);
  const weighted = ev30.reduce((s, [, , src]) => s + (src === 'own-notif' ? 1.0 : src === 'owen-insights' ? 0.4 : 0.5), 0);
  const lastDate = isoDate(e.activity.theirLastAt);
  const days = lastDate ? dayDiff(lastDate, today()) : 999;
  const recency = Math.exp(-days / 14);
  const mutualBoost = e.relation.mutual ? 2 : 0;
  const oneWay = e.activity.ourReplies >= 2 && ev30.length === 0 ? 3 : 0;
  return {
    score: +(weighted + 2 * recency + mutualBoost - oneWay).toFixed(2),
    breakdown: { their30w: +weighted.toFixed(1), recency: +recency.toFixed(2), mutual: mutualBoost, oneWayPenalty: -oneWay },
  };
}
function stageOf(e) {
  if (e.eligibility.gone) return 'gone';
  if (e.eligibility.blocked) return 'blocked';
  const lastDate = isoDate(e.activity.theirLastAt);
  const days = lastDate ? dayDiff(lastDate, today()) : 999;
  if (days > C.dormantDays && !e.relation.mutual) return 'dormant'; // 互关者不因沉默降级为 dormant（关系还在）
  if (e.relation.mutual && days <= C.activeWindowDays) return 'active';
  if (e.relation.mutual) return 'mutual';
  if (e.activity.ourReplies >= 1) return 'contacted';
  return 'new';
}
function rescore(led) {
  const all = [...Object.values(led.people), ...Object.values(led.archived)];
  for (const e of all) { const r = computeScore(e); e.score = r.score; e.stage = stageOf(e); e.updatedAt = new Date().toISOString(); }
}

// ── 收敛：淘汰/复活/归档清理 ──────────────────────────────
function settle(led) {
  // 复活：归档对象若又有了近窗互动，搬回活跃池；本轮已生成新条目时先合并历史，避免覆盖丢事件
  for (const [h, e] of Object.entries(led.archived)) {
    const lastDate = isoDate(e.activity.theirLastAt);
    if ((lastDate && dayDiff(lastDate, today()) <= C.dormantDays) || e.relation.mutual) {
      const fresh = led.people[h];
      if (fresh) {
        addEvents(fresh, e.activity.theirEvents);
        if (e.relation.mutual) fresh.relation.mutual = true;
        if (e.relation.theyFollow && !fresh.relation.theyFollow) fresh.relation.theyFollow = e.relation.theyFollow;
        if (e.relation.weFollow && !fresh.relation.weFollow) fresh.relation.weFollow = e.relation.weFollow;
        for (const s of e.sources) if (!fresh.sources.includes(s)) fresh.sources.push(s);
        if (e.firstSeen < fresh.firstSeen) fresh.firstSeen = e.firstSeen;
      } else {
        delete led.archived[h];
        led.people[h] = e;
      }
    }
  }
  // 活跃池超帽：按分末位归档
  const people = Object.values(led.people);
  if (people.length > C.poolCap) {
    people.sort((a, b) => b.score - a.score);
    for (const e of people.slice(C.poolCap)) { delete led.people[e.handle]; led.archived[e.handle] = { ...e, archivedAt: today() }; }
  }
  // 归档区：TTL 清除 + 总量帽
  const arch = Object.values(led.archived);
  const ttlDrop = arch.filter((e) => e.archivedAt && dayDiff(e.archivedAt, today()) > C.archiveTtlDays);
  for (const e of ttlDrop) delete led.archived[e.handle];
  const rest = Object.values(led.archived);
  if (rest.length > C.archiveCap) {
    rest.sort((a, b) => b.score - a.score);
    for (const e of rest.slice(C.archiveCap)) delete led.archived[e.handle];
  }
  return { dropped: ttlDrop.length };
}

// ── 源1：follows 台账 + communityAuthors（读 state/<账号>.json） ──
function buildFromFileSources(led) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, ACCOUNT + '.json'), 'utf8')); } catch { /* 尚无状态文件 */ }
  const nFollows = Object.keys(st.follows || {}).length, nFB = Object.keys(st.followBackDone || {}).length, nAuthors = Object.keys(st.communityAuthors || {}).length;
  for (const [h, v] of Object.entries(st.follows || {})) {
    if (OWN.has(h)) continue;
    const e = entryOf(led, h);
    e.relation.weFollow = { since: v.day, via: v.via };
    if (v.mutual) e.relation.mutual = true;
    if (!e.sources.includes('follows')) e.sources.push('follows');
  }
  for (const [h, d] of Object.entries(st.followBackDone || {})) {
    if (OWN.has(h)) continue;
    const e = entryOf(led, h);
    e.relation.theyFollow = e.relation.theyFollow || d;
    e.relation.mutual = true; // 对方关注了我们且我们已回关
    addEvents(e, [[d, 'follow', 'follows']]);
    if (!e.sources.includes('follows')) e.sources.push('follows');
  }
  for (const [h] of Object.entries(st.pendingFollows || {})) {
    if (OWN.has(h)) continue;
    const e = entryOf(led, h);
    if (!e.sources.includes('follows')) e.sources.push('follows');
  }
  for (const [h, d] of Object.entries(st.communityAuthors || {})) {
    if (OWN.has(h)) continue;
    const e = entryOf(led, h);
    e.activity.ourReplies = Math.max(e.activity.ourReplies, 1); // 台账只存最近一次日期，条数下限=1（P2 队列化后精确累计）
    if (!e.activity.ourLastReplyAt || d > e.activity.ourLastReplyAt) e.activity.ourLastReplyAt = d;
    if (!e.sources.includes('community-task')) e.sources.push('community-task');
  }
  return { follows: nFollows, followBackDone: nFB, communityAuthors: nAuthors };
}

// ── 源2：owen-insights 导入（Owen 互动圈，通用工具消费外部任务数据） ──
function buildFromOwenInsights(led) {
  let cum = null;
  try { cum = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'owen-insights.json'), 'utf8')); } catch { return 0; }
  let n = 0;
  for (const [h, p] of Object.entries(cum.people || {})) {
    if (OWN.has(h)) continue;
    const e = entryOf(led, h);
    if (p.name && !e.name) e.name = p.name;
    addEvents(e, (p.ev || []).map(([d, t]) => [d, t, 'owen-insights']));
    if (!e.sources.includes('owen-insights')) e.sources.push('owen-insights');
    n += 1;
  }
  return n;
}

// ── 源3：自己通知页只读扫描（复用 insights.js 已验证的 DOM 逻辑） ──
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
  } catch { /* 走兜底 */ }
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
function parseNotifType(text) {
  const t = text || '';
  if (/喜歡|喜欢|liked/i.test(t)) return 'like';
  if (/跟隨你|跟随你|followed you|关注了你/i.test(t)) return 'follow';
  if (/提到了|mentioned/i.test(t)) return 'mention';
  if (/轉發|转发|reposted/i.test(t)) return 'repost';
  if (/回覆|回复|replied/i.test(t)) return 'reply';
  return 'other';
}
async function readNotifs(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-testid="notification"]')].map((el) => {
      const time = el.querySelector('time');
      const text = clean(el.innerText).slice(0, 220);
      const handles = [];
      for (const a of el.querySelectorAll('a[href^="/"]')) {
        const href = a.getAttribute('href') || '';
        if (/^\/[A-Za-z0-9_]{1,15}$/.test(href) && !handles.includes(href.slice(1).toLowerCase())) handles.push(href.slice(1).toLowerCase());
      }
      return { at: time ? time.getAttribute('datetime') : null, text, handles };
    }).filter((n) => n.at || n.handles.length);
  }).catch(() => []);
}
async function scanOwnNotifications(led) {
  const hour = new Date().getHours();
  if (hour < L.activeHours[0] || hour >= L.activeHours[1]) throw new Error(`不在执行窗 ${L.activeHours[0]}:00-${L.activeHours[1]}:00（只读扫描同样守窗，明早窗内再跑）`);
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) throw new Error('state/PAUSE 急停生效中');
  const deadline = Date.now() + C.maxSessionMinutes * 60000;
  const ws = await openWindow(ACCT.profileId);
  let collected = 0, screens = 0;
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="notification"]', { timeout: 45000 }).catch(() => { });
      for (let i = 0; i < C.maxScreens && Date.now() < deadline; i++) {
        const notifs = await readNotifs(page);
        for (const n of notifs) {
          const type = parseNotifType(n.text);
          if (type === 'other') continue;
          const date = isoDate(n.at);
          for (const h of n.handles) {
            if (OWN.has(h)) continue;
            const e = entryOf(led, h);
            addEvents(e, [[date, type, 'own-notif']]);
            if (!e.sources.includes('own-notif')) e.sources.push('own-notif');
            collected += 1;
          }
        }
        screens += 1;
        await humanScroll(page, rand(700, 1200));
        await sleep(rand(1200, 2600));
      }
      await page.close();
    } finally { await browser.disconnect(); }
  } finally { await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { }); }
  return { collected, screens };
}

// ── 源4（可选）：FxTwitter 存活检查（纯 HTTP 匿名） ────────
async function liveness(led) {
  let targets = Object.values(led.people).filter((e) => !e.eligibility.gone);
  // --half=1|2：按互惠分拆半池（周一上半区/周四下半区），防一次全池打爆 FxTwitter 日预算（统计规范 v1.1 C3）
  const HALF = ((process.argv.find((a) => a.startsWith('--half=')) || '').slice('--half='.length) || '').trim();
  if (HALF === '1' || HALF === '2') {
    targets = targets.sort((a, b) => (b.score || 0) - (a.score || 0));
    const mid = Math.ceil(targets.length / 2);
    targets = HALF === '1' ? targets.slice(0, mid) : targets.slice(mid);
  }
  let checked = 0, gone = 0, unknown = 0;
  for (const e of targets) {
    let ok = null;
    try {
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 15000);
      const r = await fetch(`https://api.fxtwitter.com/2/profile/${e.handle}`, { signal: ac.signal });
      clearTimeout(tm);
      if (r.status === 200) ok = true;
      else if (r.status === 404) { const j = await r.json().catch(() => ({})); ok = j && j.reason === 'suspended' ? false : null; }
      else ok = null;
    } catch { ok = null; }
    checked += 1;
    if (ok === false) { e.eligibility.gone = true; gone += 1; }
    else if (ok === null) unknown += 1;
    await sleep(1200); // 匿名接口也礼貌限速
  }
  return { checked, gone, unknown };
}

// ── 报告 ─────────────────────────────────────────────────
function report(led) {
  const people = Object.values(led.people);
  const byStage = {}, bySource = {};
  for (const e of people) { byStage[e.stage] = (byStage[e.stage] || 0) + 1; for (const s of e.sources) bySource[s] = (bySource[s] || 0) + 1; }
  const top = people.sort((a, b) => b.score - a.score).slice(0, 12).map((e) => {
    const r = computeScore(e);
    return { handle: e.handle, score: e.score, stage: e.stage, ...r.breakdown, theirLast: isoDate(e.activity.theirLastAt) };
  });
  console.log(JSON.stringify({
    account: ACCOUNT, updated: led.updated,
    pool: people.length, archived: Object.keys(led.archived).length,
    byStage, bySource, top12: top,
  }, null, 2));
}

// ── 主流程 ───────────────────────────────────────────────
(async () => {
  const led = loadLedger();
  if (MODE === 'report') { report(led); return; }

  if (MODE === 'build') {
    const a = buildFromFileSources(led);
    const b = buildFromOwenInsights(led);
    rescore(led);
    const s = settle(led);
    saveLedger(led);
    log({ action: 'build', fromFollows: a.follows, followBackDone: a.followBackDone, communityAuthors: a.communityAuthors, owenInsightsPeople: b, pool: Object.keys(led.people).length, archivedDropped: s.dropped });
    console.log(`建池完成：follows台账 ${a.follows} + 回关记录 ${a.followBackDone} + 社区作者 ${a.communityAuthors} + Owen圈导入 ${b}`);
    report(led);
    return;
  }

  if (MODE === 'scan') {
    const r = await scanOwnNotifications(led);
    rescore(led);
    const s = settle(led);
    saveLedger(led);
    log({ action: 'scan', screens: r.screens, events: r.collected, pool: Object.keys(led.people).length });
    console.log(`通知扫描完成：${r.screens} 屏，采集 ${r.collected} 条互动事件`);
    report(led);
    return;
  }

  if (MODE === 'liveness') {
    const r = await liveness(led);
    saveLedger(led);
    log({ action: 'liveness', ...r });
    console.log(`存活检查完成：${r.checked} 个对象，gone ${r.gone}，unknown ${r.unknown}`);
    return;
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
