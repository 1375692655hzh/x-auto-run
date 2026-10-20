// report.js — 每日账号运营日报（10-19 拍板简洁版，纯只读）：每号一段（完成量/粉丝/雷达/发布/异常）+ 系统一行
// 用法: node report.js [--date 2026-10-20]（默认今天）
// 输出: 日报/YYYY-MM-DD.md + 控制台同屏
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DATE = argOf('date', today());
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ── 审计日志 → 每号计数（只认真实执行，dry/simulated 不计）─────────
const logFile = path.join(STATE_DIR, `log-${DATE.slice(0, 7)}.jsonl`);
const stats = {}; // key -> {community, followback, visit, post, maintain, follow, unknown:[], failed:[], skipped:{}}
function bucket(key) {
  if (!stats[key]) stats[key] = { community: 0, followback: 0, visit: 0, post: 0, maintain: 0, follow: 0, unknown: [], failed: [], postTimes: [] };
  return stats[key];
}
try {
  for (const l of fs.readFileSync(logFile, 'utf8').trim().split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.dry || j.simulated || !j.at) continue;
    // 北京日期过滤（review 抓出：j.at 是 UTC ISO，直接 startsWith(DATE) 会漏 00:00-08:00 的凌晨动作）；
    // 脏行守卫（kimi 复核抓出：不可解析的 j.at 会让 toISOString 抛 RangeError 被外层 catch 吞掉→当天统计清零）
    const atMs = Date.parse(j.at);
    if (!Number.isFinite(atMs)) continue;
    const bjDay = new Date(atMs + 8 * 3600000).toISOString().slice(0, 10);
    if (bjDay !== DATE) continue;
    if (j.task !== 'executor' || j.action !== 'execute') {
      // 互关帖（10-21 拍板，mutual-post.js 独立脚本）：按同口径计入原创发帖
      if (!(j.task === 'mutualPost' && j.action === 'post')) continue;
    }
    const b = bucket(j.account);
    if (j.status === 'unknown') { b.unknown.push(`${(j.id || '').slice(11)} ${j.type}${j.note ? '：' + String(j.note).slice(0, 40) : ''}`); continue; }
    if (j.status === 'failed') { b.failed.push(`${(j.id || '').slice(11)} ${String(j.note || '').slice(0, 40)}`); continue; }
    if (j.status !== 'done') continue;
    // kind 优先于 type 判分支（review 抓出：followback-reply 是 type=follow，排在 kind 前会被误计入关注帖主）
    if (j.kind === 'maintain') b.maintain += 1;
    else if (j.type === 'post') { b.post += 1; b.postTimes.push(j.at); }
    else if (j.kind === 'followback-reply' || j.kind === 'followback') b.followback += 1;
    else if (j.type === 'follow') b.follow += 1;
    else if (j.kind === 'community') b.community += 1;
    else if (j.kind === 'visit') b.visit += 1;
  }
} catch { }

// ── 快照：粉丝+雷达（当日缺则回溯昨天）────────────────────────
function pickSnap() {
  for (const d of [DATE, new Date(Date.parse(DATE) - 86400000).toISOString().slice(0, 10)]) {
    const s = readJson(path.join(STATE_DIR, 'health-snapshots', `${d}.json`));
    if (s) return { snap: s, day: d };
  }
  return { snap: null, day: null };
}
const { snap, day: snapDay } = pickSnap();
const ySnap = readJson(path.join(STATE_DIR, 'health-snapshots', `${new Date(Date.parse(DATE) - 86400000).toISOString().slice(0, 10)}.json`));

// ── 每号一段 ─────────────────────────────────────────────
const runAccounts = (CFG.accounts || []).filter((a) => a.role === 'run');

const sections = runAccounts.map((a) => {
  const b = stats[a.key] || bucket(a.key);
  const own = ((CFG.rounds || {}).quotasByAccount || {})[a.key] || {};
  const sumOwn = (kind) => Object.values(own[kind] || {}).reduce((s, x) => s + (x || 0), 0);
  const lines = [];
  // 分母只认每号自己拍板的量（review 抓出：全局回退会让 fullwin 显示 0/25、maccostin 显示 0/10 串门）
  lines.push(`- 完成量：互关评论 ${b.community}${own.community ? '/' + sumOwn('community') : '（未配置）'} · 条件回关 ${b.followback}（无任务上限） · 串门 ${b.visit}${own.visit ? '/' + sumOwn('visit') : '（未配置）'} · 原创发帖 ${b.post}（区间 8~18）· 权重维护 ${b.maintain}/≤3 · 关注帖主 ${b.follow}`);
  // 粉丝
  const e = snap && snap.accounts && snap.accounts[a.key];
  const yE = ySnap && ySnap.accounts && ySnap.accounts[a.key];
  const fNow = e && e.profile && e.profile.followers, fY = yE && yE.profile && yE.profile.followers;
  lines.push(`- 粉丝：${fNow ?? '?'}${fNow != null && fY != null ? `（${fNow - fY >= 0 ? '+' : ''}${fNow - fY} vs 昨日）` : ''}`);
  // 雷达
  const r = snap && snap.radar && snap.radar.results && snap.radar.results[a.handle];
  if (r && r.four && Object.values(r.four).some((v) => v != null)) {
    const f = r.four;
    lines.push(`- 雷达：${f.score || '?'}分（幽灵${(f.ghost || '?').replace('已检测到', '⚠')}${''} · 降权${f.deboost || '?'} · 搜索${f.search || '?'} · 建议${f.suggestion || '?'}）截至 ${snapDay}`);
  } else lines.push(`- 雷达：今日无数据（站点临时故障或未跑，见半夜数据窗）`);
  // 发布明细
  if (b.postTimes.length) {
    const ts = b.postTimes.map((x) => hm(x)).sort();
    lines.push(`- 发布：${b.post} 条（${ts[0]}~${ts[ts.length - 1]}）`);
  } else lines.push(`- 发布：0 条`);
  // 异常
  const abnormal = [];
  if (b.unknown.length) abnormal.push(`结果不明 ${b.unknown.length}（${b.unknown.slice(0, 3).join('；')}${b.unknown.length > 3 ? '…' : ''}）`);
  if (b.failed.length) abnormal.push(`失败 ${b.failed.length}（${b.failed.slice(0, 2).join('；')}${b.failed.length > 2 ? '…' : ''}）`);
  lines.push(`- 异常：${abnormal.length ? abnormal.join('；') : '无'}`);
  return `## ${a.key}（@${a.handle}）\n${lines.join('\n')}`;
}).join('\n\n');

// ── 系统一行 ─────────────────────────────────────────────
const sysBits = [];
if (snap && snap.radar && snap.radar.fetchedAt) {
  const okR = Object.values(snap.radar.results || {}).filter((r) => r && r.four && Object.values(r.four).some((v) => v != null)).length;
  if (okR) sysBits.push(`雷达 ${okR} 号有数据`);
}
for (const k of Object.keys(snap && snap.accounts || {})) if (snap.accounts[k].mutual) sysBits.push(`互关扫描 ${k} ${(snap.accounts[k].mutual.ratio * 100).toFixed(0)}%`);
if (!sysBits.length) sysBits.push('半夜数据窗未跑/无产出');

// ── 待你回（10-20 配合用户手动上 owen 回复）：今天我们四个号回复了 owen 哪些帖 ──
let replyToOwen = [];
try {
  const mled = readJson(path.join(STATE_DIR, 'maintain-ledger.json')) || { actions: [] };
  replyToOwen = (mled.actions || []).filter((e) => e.action === 'reply' && /owen/i.test(e.targetHandle || '') && e.at && new Date(Date.parse(e.at) + 8 * 3600000).toISOString().slice(0, 10) === DATE);
} catch { }

const md = `# 运营日报 ${DATE}

${sections}
${replyToOwen.length ? `\n## 待你回（owen 手动环节）\n${replyToOwen.map((e) => `- ${e.account} 回了 owen 的帖：https://x.com/${e.targetHandle}/status/${e.statusId}（你去回他 → 成串拿 75 分作者互动权重）`).join('\n')}` : ''}
---
系统：${sysBits.join(' · ')}｜任务面=半夜数据窗 03:20 + 三运营窗×两号（09:35/12:35/19:35）+ 指标日检/晚检 + 日报

> 生成于 ${new Date().toISOString()}（node report.js）；实时全貌：监控页 http://127.0.0.1:8787
`;
fs.mkdirSync(path.join(ROOT, '日报'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '日报', `${DATE}.md`), md);
console.log(md);
console.log(`已写入 日报/${DATE}.md`);
