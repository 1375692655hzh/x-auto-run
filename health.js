// health.js — 账号健康日检（纯 HTTP 匿名，零账号风险，不开任何浏览器窗口）
// 规范依据: ./规范与约束.md §7.1 / ./执行计划-综合版.md P0
// 用法: node health.js [--accounts=butcher,fullwin]（默认 config.accounts 全部）
// 通道（2026-10-15）:
//   1. FxTwitter /2/profile/<handle>        存活 / 粉丝关注数（封禁返回 404 reason=suspended）
//   2. FxTwitter /2/profile/<handle>/statuses  近 24h 回复数 / 最新帖时间（发帖中断=异常线索；10-18 用户拍板 48h→24h）
//   3. FxTwitter /2/typeahead               建议索引是否收录（suggestion ban 软信号，仅记录）
// 语义: 任一通道失败/数据缺失 = unknown —— 不计健康也不计异常（审计纠偏：检测失败≠被限流）。
//       本版不做异常判定与自动处置，只记录快照与环比，供周复盘与 P4 控制器使用。
// 输出: state/health-snapshots/YYYY-MM-DD.json + 控制台报告；重复运行当日覆盖更新。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SNAP_DIR = path.join(ROOT, 'state', 'health-snapshots');
const API = 'https://api.fxtwitter.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function getJSON(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const body = await r.text();
    try { return { status: r.status, ok: r.status === 200, data: JSON.parse(body) }; }
    catch { return { status: r.status, ok: false, err: 'bad-json' }; }
  } catch (e) {
    return { ok: false, err: (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

// statuses 响应（实测 2026-10-15）：{code, results[], cursor}；条目含 author/created_at/views/
// possibly_sensitive/replying_to/reposted_by。repost 条目的 url 指向原帖，须按 author 归属区分自发与转发。
function digestStatuses(res, handle) {
  if (!res.ok) return { state: 'unknown', err: res.err || ('http ' + res.status) };
  const d = res.data || {};
  const list = Array.isArray(d.results) ? d.results
    : Array.isArray(d.tweets) ? d.tweets
    : Array.isArray(d.statuses) ? d.statuses
    : Array.isArray(d) ? d : null;
  if (!list) return { state: 'unknown', err: 'shape' };
  const h = (handle || '').toLowerCase();
  const own = list.filter((s) => ((s.author && s.author.screen_name) || '') .toLowerCase() === h);
  const reposts = list.filter((s) => s.reposted_by);
  const views = own.map((s) => (s.views && (s.views.count ?? s.views)) ?? null).filter((v) => Number.isFinite(v));
  // 注意：created_at 是 "Thu Oct 15 ..." 文本，字典序排序会跨月错乱（Wed Sep > Thu Oct），必须用数值时间戳
  const newest = own.map((s) => ({ ts: s.created_timestamp || 0, at: s.created_at })).sort((a, b) => b.ts - a.ts)[0];
  return {
    state: 'ok',
    count: list.length,
    ownCount: own.length,
    repostCount: reposts.length,
    newestAt: newest ? newest.at : null,
    minViews: views.length ? Math.min(...views) : null,
    sensitiveCount: own.filter((s) => s.possibly_sensitive).length,
  };
}

function digestProfile(res) {
  if (!res.ok) {
    const suspended = res.status === 404 && res.data && res.data.reason === 'suspended';
    return { state: suspended ? 'suspended' : 'unknown', err: res.err || ('http ' + res.status) };
  }
  const u = (res.data && res.data.user) || {};
  return {
    state: 'ok',
    name: (u.name || '').trim() || null, // X 显示昵称（监控页侧栏账号名称）
    followers: u.followers ?? null,
    following: u.following ?? null,
    statuses: u.statuses ?? null, // 原创帖累计（X 口径：含回复不含转发）
    likes: u.likes ?? null,
    protected: !!u.protected,
  };
}

function digestTypeahead(res, handle) {
  if (!res.ok) return { state: 'unknown', err: res.err || ('http ' + res.status) };
  const users = (res.data && (res.data.users || (res.data.result && res.data.result.users))) || [];
  const h = handle.toLowerCase();
  const found = users.some((u) => ((u.screen_name || u.handle || '') + '').toLowerCase() === h);
  return { state: 'ok', found };
}

(async () => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const arg = (process.argv.find((a) => a.startsWith('--accounts=')) || '').slice('--accounts='.length);
  const LIGHT = process.argv.includes('--light'); // 晚间轻检档（v1.1 C6）：仅 profile 端点×watch 号，喂 22:30 日报收盘数
  const keys = arg ? arg.split(',').map((s) => s.trim()).filter(Boolean) : CFG.accounts.filter((a) => a.watch !== false).map((a) => a.key); // 默认只扫 watch 账号；接入未授权（watch:false）不占每日检测
  const file = path.join(SNAP_DIR, today() + '.json');
  let snap = { date: today(), checkedAt: null, accounts: {} };
  try { snap = { ...snap, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* 当日首跑 */ }

  // 上一份历史快照（环比用，只读不改）
  let prev = null;
  try {
    const files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json') && f < today() + '.json').sort();
    if (files.length) prev = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, files[files.length - 1]), 'utf8'));
  } catch { /* 无历史 */ }

  const report = {};
  for (const key of keys) {
    const acct = CFG.accounts.find((a) => a.key === key);
    if (!acct) { report[key] = { error: 'config 无此账号' }; continue; }
    const h = acct.handle;

    const p = digestProfile(await getJSON(`${API}/2/profile/${h}`));
    await sleep(1500);
    let s = { state: 'skipped' };
    if (!LIGHT) {
      const since = Math.floor(Date.now() / 1000 - 24 * 3600); // 24h 窗口（10-18 用户拍板：回复数口径 48h→24h）
      s = digestStatuses(await getJSON(`${API}/2/profile/${h}/statuses?with_replies=1&since=${since}`), h);
    }

    if (LIGHT) {
      // 轻检档：只刷新 profile 数字，其余字段（statuses/mutual/昨日判定）原样保留
      const prevAcct = (snap.accounts[key] || {});
      snap.accounts[key] = { ...prevAcct, handle: h, profile: p, lightAt: new Date().toISOString() };
      report[key] = { light: true, followers: p.followers, following: p.following, statuses: p.statuses, state: p.state };
      continue;
    }

    const entry = { handle: h, profile: p, statuses: s };
    // 定位（10-19 拍板）：health=纯指标通道（粉丝/关注/发帖数/回复数+suspended 硬事实）；
    // 健康判定唯一权威=雷达四维（半夜数据窗），typeahead 建议通道已删（fx 不稳致误判，用户拍板）
    entry.verdict = p.state === 'suspended' ? 'suspended' : 'green';

    const pv = prev && prev.accounts && prev.accounts[key];
    if (pv) {
      entry.delta = {
        followers: (p.followers ?? null) !== null && (pv.profile.followers ?? null) !== null ? p.followers - pv.profile.followers : null,
        posts24h: s.count ?? null,
        prevPosts24h: pv.statuses.count ?? null,
      };
    }
    // 合并更新：保留其他任务写进该账号条目的字段（如 followers-scan 的 mutual、radar 相关），不整体覆盖（10-16 教训）
    snap.accounts[key] = { ...(snap.accounts[key] || {}), ...entry };
    report[key] = { verdict: entry.verdict, followers: p.followers, own24h: s.ownCount, reposts24h: s.repostCount, newestAt: s.newestAt, minViews: s.minViews, sensitive: s.sensitiveCount, delta: entry.delta };
  }

  snap.checkedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`健康快照已写入 state/health-snapshots/${today()}.json`);
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
