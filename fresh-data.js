// fresh-data.js — 现采层（10-21 拍板"监控台与飞书报告同一体系"）：雷达/粉丝现场抓+TTL 缓存
// 设计：TTL 内直接用当日快照（半夜链/指标检已写的），超 TTL 现场拉并回写快照（合并保留旧字段，
//       绝不空值覆盖）；调用方不阻塞——新鲜度由 TTL 决定，不是每次调用都拉
// TTL：雷达 60min（站点免费档，别打爆）、profile 粉丝 15min（FxTwitter 免登录即时）
// 分级：httpOnly=true 时雷达只 HTTP 直取（不起无头 Chrome）——监控页 60s 轮询场景必须轻
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const RADAR_TTL_MIN = ((CFG.freshData || {}).radarTtlMin) || 60;
const PROFILE_TTL_MIN = ((CFG.freshData || {}).profileTtlMin) || 15;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
const snapFile = () => path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
const okFour = (f) => f && Object.values(f).some((v) => v != null);

// ── 雷达现采（HTTP 直取自 radar.js 通道；httpOnly=true 不起无头） ──
async function fetchRadarHttp(handle) {
  const url = `https://shadowbanradar.com/zh/r/${handle}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return null;
  const html = await r.text();
  const ariaRaw = (html.match(/aria-label="([^"]*搜索建议限制[^"]*)"/) || html.match(/aria-label="([^"]*Search suggestion[^"]*)"/) || [])[1] || null;
  if (!ariaRaw || !/[:：]/.test(ariaRaw) || /正在计算|\[\d+\/4\]|请启用/i.test(ariaRaw)) return null; // 加载态=无缓存终值，现采层放弃（半夜链无头兜底）
  const aria = ariaRaw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = { suggestion: null, search: null, ghost: null, deboost: null };
  for (const part of aria.split(',')) {
    const m = part.match(/^\s*([^:：]+)[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const [k, v] = [m[1], m[2]];
    if (!/未见|检测到|正常|not detected|detected/i.test(v)) continue;
    if (/搜索建议|suggestion/i.test(k)) out.suggestion = v;
    else if (/搜索|search/i.test(k) && !/建议|suggestion/i.test(k)) out.search = v;
    else if (/回复隐藏|ghost/i.test(k)) out.ghost = v;
    else if (/回复排序|deboost/i.test(k)) out.deboost = v;
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ');
  const score = (text.match(/(\d+)\s*\/\s*100/) || [])[1] || null;
  const verdict = (text.match(/未检测到限流|检测到限流/) || [])[0] || null;
  if (!okFour(out)) return null;
  return { url, four: { ...out, score, verdict, accountAgeDays: null }, ariaRaw: aria };
}

/** 雷达新鲜度保证：TTL 内不动；过期则逐号 HTTP 现采（可用的回写快照合并，失败的保留旧值） */
async function ensureRadarFresh(opts = {}) {
  const snap = readJson(snapFile(), {});
  const at = snap.radar && snap.radar.fetchedAt ? Date.parse(snap.radar.fetchedAt) : 0;
  if (Date.now() - at < RADAR_TTL_MIN * 60000) return { fresh: false, why: 'TTL内' };
  const handles = (CFG.radar || {}).handles || [];
  const prev = (snap.radar && snap.radar.results) || {};
  let updated = 0;
  const results = { ...prev };
  for (const h of handles) {
    const r = await fetchRadarHttp(h).catch(() => null);
    if (r) { results[h] = r; updated++; }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  if (!updated) return { fresh: false, why: '现采全失败，保旧值' };
  snap.radar = { fetchedAt: new Date().toISOString(), results };
  writeJson(snapFile(), snap);
  return { fresh: true, updated, total: handles.length };
}

/** profile 粉丝/关注/发帖数现采（FxTwitter 匿名，免登录即时） */
async function ensureProfilesFresh() {
  const snap = readJson(snapFile(), {});
  snap.accounts = snap.accounts || {};
  let oldest = 0;
  for (const a of CFG.accounts || []) {
    const at = snap.accounts[a.key] && snap.accounts[a.key].profileAt ? Date.parse(snap.accounts[a.key].profileAt) : 0;
    if (!oldest || at < oldest) oldest = at;
  }
  if (Date.now() - oldest < PROFILE_TTL_MIN * 60000) return { fresh: false, why: 'TTL内' };
  let updated = 0;
  for (const a of CFG.accounts || []) {
    try {
      const r = await fetch(`https://api.fxtwitter.com/2/profile/${a.handle}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const j = await r.json();
      const u = j.user || j;
      const prev = snap.accounts[a.key] || {};
      snap.accounts[a.key] = { ...prev, handle: a.handle, profile: { followers: u.followers ?? null, following: u.following ?? null, statuses: u.statuses ?? null, state: 'ok' }, profileAt: new Date().toISOString() };
      updated++;
    } catch { }
    await new Promise((r2) => setTimeout(r2, 1200));
  }
  if (updated) writeJson(snapFile(), snap);
  return { fresh: !!updated, updated };
}

module.exports = { ensureRadarFresh, ensureProfilesFresh };
