// dashboard.js — 本地监控页面服务 v2（定稿版：数据页 指标/四维度 1:1 + 双图 + 关系池两表 + 权重池；任务页 类别列+设定/建议+完成量/设定量）
// 约定：红涨绿跌（用户 2026-10-16 拍板）；增长同时显示 绝对值+百分比；纯本地只读，不碰任何账号。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const X = Object.assign({ rollingCaps: { reply: 8, follow: 18, like: 15, unfollow: 5 } }, CFG.executor || {});
const GRID_DAYS = 7, DATA_DAYS = 7; // 10-18 三方方案④：任务表 2→7 天格

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = parseInt(argOf('port', '8787'), 10);

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
function lastNDays(n) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(dstr(new Date(Date.now() - i * 86400000))); return out; }
const DAYS_ARR = lastNDays(GRID_DAYS);
const HDAYS_ARR = lastNDays(DATA_DAYS);
const TODAY = dstr(new Date());

const G0 = (CFG.graphAccounts || [{}])[0];
const FB = CFG.follow.followBack, UF = CFG.follow.unfollowTimeout;
// 任务时间线（2026-10-16 重构）：按一天时间排序；多时间节点拆独立行（早/午/晚窗各自成行）。
// 伪控制面板原则：set=设定量【只显示你实际拍板/config 里真实存在的值，没有就是"未设定"】；
//                sug=建议量【引擎/参考档位】；status=当前开关状态（对话即控制）。
const WL = { am: '早', mid: '午', pm: '下', eve: '晚', p1: '早', p2: '午', p3: '晚' }; // 10-19 起：am-eve 四窗=wcixot 互关专用；p1/p2/p3=butcher 运营窗（合并全任务）+wcixot 发布窗（bat 锁窄模式）
const Q = ((CFG.rounds || {}).quotas) || {};
const QB = Object.assign({}, Q, (((CFG.rounds || {}).quotasByAccount) || {}).butcher) || Q; // butcher 实际配额（10-19 三运营窗 9+8+8 / 7+7+6）
const QW = Object.assign({}, Q, (((CFG.rounds || {}).quotasByAccount) || {}).wcixot) || Q; // wcixot 实际配额
function windowRows(w, t, QX, who) { // 互关窗行（10-19 起四窗 8:30/13/16/20 仅 wcixot 在跑）
  const f = (m) => (((m || {})[w] != null) ? m[w] : null);
  return [
    { id: `community:${w}`, t, cat: '社区互关', name: `互关评论·${WL[w]}窗${who ? `（${who}）` : ''}`, unit: '条', status: 'on', set: `${f(QX.community)} 条（你拍板）`, setNum: f(QX.community), sug: '≤10/天=低风险；20-50/天=高风险档（XActions 分档；20/天在分档线上，已如实告知）',
      desc: '互关话题选帖（帖龄≤3天/作者14天冷却）→先关注后回复（LLM 文案）' },
    { id: `follow:${w}`, t, cat: '社区互关', name: `关注帖主·${WL[w]}窗`, unit: '人', status: 'on', set: '随互关评论 1:1 产生（条件行事，非按量）', setNum: null, sug: '日上限=滚动关注帽 50（XActions 20-150 按账龄；官方400/天硬顶）',
      desc: '每条互关评论自动先关注帖主（画像筛选 粉≥30/关注≤2000/比例≤5；关注失败该评论不发）——互关的组成部分，不是独立任务' },
    { id: `followReply:${w}`, t, cat: '社区互关', name: `条件回关·${WL[w]}窗`, unit: '人', status: 'on', set: '条件行事：满足即回（安全上限 ≤5/窗·≤20/天）', setNum: null, sug: '按需回真实互动者（比旧"逢粉必回"精准；XActions follow-back 50/场次上限内）',
      desc: '对方 7 天内回复过我+关注过我且未关注过→回关；候选为 0 就不做，绝不凑数' },
    { id: `unfollow:${w}`, t, cat: '社区互关', name: `取关·${WL[w]}窗`, unit: '人', status: 'off', set: '0（不做，你拍板）', setNum: null, sug: '0——不建议自动化（XActions 明示强烈不建议；follow churn 属执法违规画像）',
      desc: '非互关清理能力默认关（unfollowPolicy off + 额度0 双保险）' },
  ];
}
// 运营窗行（10-19 拍板双号 3+1 收窗：一次开窗=拉取+互关+条件回关+串门+发帖，p2/p3 另含权重维护）
function opsRows(w, t, who, QX) {
  const f = (m) => (((m || {})[w] != null) ? m[w] : null);
  const rows = [];
  rows.push({ id: `community:${w}`, t, cat: '社区互关', name: `互关评论·运营窗${WL[w]}${who ? '（' + who + '）' : ''}`, unit: '条', status: 'on', set: `${f(QX.community)} 条（你拍板 10-19 三窗分配）`, setNum: f(QX.community), sug: '≤10/天=低风险；20-50/天=高风险档（XActions 分档；已如实告知）',
    desc: '运营窗内一次开窗连做：拉取→互关→条件回关→串门→定时发帖' });
  rows.push({ id: `follow:${w}`, t, cat: '社区互关', name: `关注帖主·运营窗${WL[w]}`, unit: '人', status: 'on', set: '随互关评论 1:1 产生', setNum: null, sug: '日上限=滚动关注帽（XActions 分档；官方400/天硬顶）', desc: '每条互关评论自动先关注帖主（画像筛选）' });
  rows.push({ id: `followReply:${w}`, t, cat: '社区互关', name: `条件回关·运营窗${WL[w]}`, unit: '人', status: 'on', set: '无任务上限（10-19 拍板全账号：回复+关注双条件满足即回）', setNum: null, sug: '真实约束=候选条件+滚动关注帽（引擎安全网）', desc: '半夜链通知扫描喂候选；窗内满足条件即回' });
  const BA = ((CFG.posts || {}).budgetByAccount || {})[who || 'butcher'] || ((CFG.posts || {}).budget) || {};
  const a = (BA.windowAllocation || {})[w];
  const fmt = (x) => (x != null && typeof x === 'object' ? `${x.min}~${x.max}` : String(x ?? 0));
  rows.push({ id: `post:${w}`, t, cat: '原创发布', name: `原创发布·运营窗${WL[w]}${who ? '（' + who + '）' : ''}`, unit: '帖', status: 'wait-feed', set: `${fmt(a)} 帖（你拍板区间·间隔1~10min定时发布）`, setNum: null, sug: '区间随机 8~18/天（你拍板 10-18；官方50/天硬顶；引擎帽20/天）',
    desc: '窗内拉取即发（对齐云端生成完成 09:35/12:35/19:35）' });
  rows.push({ id: `visit:${w}`, t, cat: '主动互动', name: `关系池串门·运营窗${WL[w]}${who ? '（' + who + '）' : ''}`, unit: '条', status: 'on', set: `${f(QX.visit)} 条（你拍板）`, setNum: f(QX.visit), sug: '回复类合计分档同前', desc: '互惠分选人→对方最新帖留言（LLM+质量门）' });
  if (w !== 'p1') rows.push({ id: `maintain:${w}`, t, cat: '主动互动', name: `权重维护·运营窗${WL[w]}${who ? '（' + who + '）' : ''}`, unit: '次', status: 'on', set: '≤1 帖/目标/窗（10-19 拍板：不随帖，固定午晚两窗，早上不做）', setNum: null, sug: '维护计入点赞/回复总帽', desc: '帖龄 20min~14h 新帖点赞（butcher 另有≤1条/48h 回复）；互吹圈>1/3 跳过；雷达熔断' });
  return rows;
}
const TASK_ROWS = [
  { id: 'nightChain', t: '03:20', cat: '系统运维', name: '半夜数据窗（一条链）', unit: '次', status: 'on', set: '1 次/天·凌晨2-5点窗（+随机0-90min）', setNum: 1, sug: '1/天：互关粉丝占比全量扫描+雷达四维度+关系池通知扫描合并为一条链（10-19 拍板 3+1 收窗）', desc: 'followers-scan（各号自己窗口只读翻粉丝）→ radar --check（**项目级，零账号窗口**：HTTP 直取结果页优先，无缓存终值才起本机无头 Chrome；站点临时故障时该号置空不告警，次日自动重试）→ contacts --build+--scan --night（butcher+wcixot 通知页）；产出清晨全部就绪' },
  { id: 'health', t: '09:00', cat: '系统运维', name: '指标日检', unit: '次', status: 'on', set: '1 次', setNum: 1, sug: '1/天', desc: '10-19 拍板定位=纯指标通道：FxTwitter 只取数字（粉丝/关注/发帖数/24h回复数）+suspended 硬事实；健康判定唯一权威=雷达四维（见半夜数据窗），建议通道已删（不稳易误判）' },
  { id: 'owen', t: '10:00', cat: '主动互动', name: 'Owen帖加持（外部任务）', unit: '帖', status: 'paused', set: '2 帖（旧拍板）', setNum: 2, sug: '≤2/天（外部任务维持旧档；X算法：直接导航不计推荐权重，仅关系维护价值）', desc: '外部 boost.js 任务：满45分钟新帖四连——**已退役**（10-17，接替者=权重维护互动行；ZCode 旧轮 10-18 已删除）' },
  { id: 'graph', t: '10:00', cat: '主动互动', name: '图谱点赞（外部任务）', unit: '赞', status: 'paused', set: '2 赞/轮（旧拍板）', setNum: null, sug: '点赞类合计≤20/天（XActions 50-100/天档，我们取约1/3更保守）', desc: '@' + (G0.handle || '?') + ' + @antiAIvo 随机点赞（只赞不评）——已随 boost.js 退役（10-17），能力未迁移，复活需拍板' },
  ...opsRows('p1', '09:35', 'butcher', QB),
  ...opsRows('p2', '12:35', 'butcher', QB),
  ...opsRows('p3', '19:35', 'butcher', QB),
  ...opsRows('p1', '09:35', 'wcixot', QW),
  ...opsRows('p2', '12:35', 'wcixot', QW),
  ...opsRows('p3', '19:35', 'wcixot', QW),
  { id: 'maintain', t: '12:35/19:35 窗内', cat: '主动互动', name: '权重维护互动（统一固定窗）', unit: '次', status: 'on', set: '≤1 帖/目标/窗 · ≤3 次/号/天（v1.1 拍板）', setNum: null, sug: '维护计入当日点赞/回复总帽', desc: '10-19 拍板收编：随帖侦测任务已删（黄金窗时序让位于开窗节奏），全部维护并进 p2/p3 运营窗（butcher→owen、wcixot→butcher+owen）；fullwin 退出矩阵（无运营窗账号，4粉小号贡献极低）' },
  { id: 'verifyReply', t: '已下线', cat: '系统运维', name: '回复可见性抽查（已下线）', unit: '次', status: 'off', set: '—', setNum: null, sug: '—', desc: '10-19 拍板下线：走 FxTwitter 路径不稳定易误判，回复可见性以雷达四维（ghost/deboost 两维即回复可见性检测）为准，每晚 03:20 半夜数据窗' },
  { id: 'passive', t: '随通知', cat: '被动回复', name: '回复他人的回复', unit: '', status: 'pending', set: '不限（你拍板）', setNum: null, sug: '计入回复日总量分档：合计≤5-10/天=低风险（XActions；官方200/天硬顶）', desc: '别人在我们帖下的回复→回应；评论模块待接入' },
  { id: 'report', t: '22:05', cat: '系统运维', name: '每日日报', unit: '份', status: 'on', set: '1 份', setNum: 1, sug: '1/天（复盘频率；XActions 建议每日审计）', desc: '计划任务 Xops日报 自动生成' },
];

// ── 审计日志聚合（dry/simulated 不计） ────────────────────
function aggregateLogs() {
  const agg = {};
  const months = new Set(DAYS_ARR.map((d) => d.slice(0, 7)));
  for (const m of months) {
    const f = path.join(STATE_DIR, `log-${m}.jsonl`);
    if (!fs.existsSync(f)) continue;
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').trim().split('\n'); } catch { continue; }
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (!j.at || j.simulated) continue;
      if (j.dry && j.task !== 'round') continue; // 演练动作不计完成量；round 演练标记保留用于网格显示
      const date = j.at.slice(0, 10);
      const acct = j.account || '-';
      const t = new Date(j.at);
      const hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      let row = null, item = null;
      const hour0 = t.getHours();
      const winByHour = hour0 < 10 ? 'am' : hour0 < 12 ? 'p1' : hour0 < 13 ? 'p2' : hour0 < 15 ? 'mid' : hour0 < 18 ? 'pm' : hour0 < 20 ? 'p3' : 'eve'; // 旧系统无窗字段按时段归属
      if (j.task === 'graph' && j.action === 'like') { row = 'graph'; item = `@${j.target} 帖${String(j.post).slice(-4)}`; }
      else if (j.task === 1) { row = 'owen'; item = `帖${String(j.post).slice(-4)} ${(j.actions || []).join('+')}`; }
      else if (j.task === 2) { row = `community:${winByHour}`; item = `@${j.author}「${String(j.text || '').slice(0, 18)}」`; }
      else if (j.task === 3 && j.action === 'follow') { row = `follow:${winByHour}`; item = `@${j.target}`; }
      else if (j.task === 3 && j.action === 'followBack') { row = `followBack:${winByHour}`; item = `@${j.target}`; }
      else if (j.task === 3 && j.action === 'unfollow') { row = `unfollow:${winByHour}`; item = `@${j.target}`; }
      else if (j.task === 'mutualScan' && j.action === 'scan') { row = 'mutualScan'; item = `互关 ${j.mutual}/${j.scanned}（${(j.ratio * 100).toFixed(1)}%，覆盖 ${j.coverage}%）`; }
      else if (j.task === 'verifyReply') { row = 'verifyReply'; item = `可见 ${j.visible}/${j.checked}（${j.window}窗后抽查）`; }
      else if (j.task === 'contacts' && j.action === 'scan') { row = 'scan'; item = `${j.events || '?'}事件/${j.screens || '?'}屏`; }
      else if (j.task === 'radar') { row = 'radar'; item = `双号四维度判定`; }
      else if (j.task === 'executor' && j.kind === 'maintain' && j.action === 'execute' && (j.status === 'done' || j.status === 'unknown')) {
        row = 'maintain'; item = `${j.target ? (String(j.target).startsWith('@') ? j.target : '@' + j.target) : j.statusId} ${j.type === 'reply' ? '维护回复' : '维护点赞'}`;
      }
      else if (j.task === 'executor' && j.action === 'execute' && (j.status === 'done' || j.status === 'unknown')) {
        const w = (String(j.id).match(/-(am|mid|pm|eve|p1|p2|p3)-/) || [])[1] || winByHour;
        let base;
        if (j.type === 'post') base = 'post';
        else if (j.type === 'follow') base = /-fb-/.test(j.id) ? 'followBack' : /-frb-/.test(j.id) ? 'followReply' : 'follow';
        else if (j.type === 'unfollow') base = 'unfollow';
        else base = /community/.test(j.id) ? 'community' : 'visit';
        row = `${base}:${w}`;
        item = j.type === 'post' ? `发布「${String(j.text || '').slice(0, 18)}」${j.status === 'unknown' ? '(不明)' : '✓'}` : `${j.target ? '@' + j.target : j.statusId} ${j.status === 'unknown' ? '结果不明' : '✓'}`;
      }
      const a = (agg[acct] = agg[acct] || {});
      const d = (a[date] = a[date] || {});
      if (!row) { if (j.task === 'round' && j.action === 'round' && j.dry) d.roundDry = true; continue; }
      const c = (d[row] = d[row] || { count: 0, times: new Set(), items: [], unknown: 0 });
      c.count += 1;
      if (String(j.status) === 'unknown') c.unknown += 1;
      c.times.add(hhmm);
      if (item) c.items.push(`${hhmm} ${item}`);
    }
  }
  return agg;
}
// 近 7 天日志计数（dry/simulated 不计），pred 过滤
function countLogs7d(pred) {
  let n = 0;
  const cut = Date.now() - 7 * 86400000;
  const f = path.join(STATE_DIR, `log-${TODAY.slice(0, 7)}.jsonl`);
  if (!fs.existsSync(f)) return n;
  try {
    for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (!j.dry && !j.simulated && Date.parse(j.at) > cut && pred(j)) n += 1;
    }
  } catch { }
  return n;
}

function healthHistory() {
  const out = {};
  const dir = path.join(STATE_DIR, 'health-snapshots');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { }
  for (const f of files) {
    const date = f.slice(0, 10);
    const snap = readJson(path.join(dir, f));
    if (!snap) continue;
    for (const [key, e] of Object.entries(snap.accounts || {})) {
      (out[key] = out[key] || {})[date] = e;
    }
  }
  return out;
}
function reportExists() {
  const out = {};
  for (const d of DAYS_ARR) out[d] = fs.existsSync(path.join(ROOT, '日报', `${d}.md`));
  return out;
}

// 指标差值：返回 {txt, cls}（红涨绿跌：涨=红 跌=绿）
function fmtDelta(t, p) {
  if (t == null || p == null) return { txt: '—', cls: 'flat' };
  const d = t - p;
  if (d === 0) return { txt: '±0', cls: 'flat' };
  const pct = p > 0 ? (d / p) * 100 : null;
  const sign = d > 0 ? '+' : '';
  const pctTxt = pct != null ? `（${sign}${pct.toFixed(1)}%）` : '';
  return { txt: (d > 0 ? '▲ ' : '▼ ') + sign + d + pctTxt, cls: d > 0 ? 'up' : 'down' };
}

function buildData() {
  const agg = aggregateLogs();
  const health = healthHistory();
  const reports = reportExists();
  const accounts = CFG.accounts.map((a) => {
    const hist = health[a.key] || {};
    const dates = Object.keys(hist).sort();
    const todayKey = hist[TODAY] ? TODAY : (dates[dates.length - 1] || null);
    const prevKey = (() => { const before = dates.filter((d) => d < todayKey); return before.length ? before[before.length - 1] : null; })();
    const tE = todayKey ? hist[todayKey] : null;
    const pE = prevKey ? hist[prevKey] : null;
    // 慢变量"上次已知值"（10-18 总览发现）：今日快照可能被创建但为空（深夜/检测类写入）——所有日更字段回溯最近含数据的快照
    const Pdate = [...dates].reverse().find((d) => hist[d] && hist[d].profile && hist[d].profile.followers != null);
    const P = Pdate ? hist[Pdate].profile : ((tE && tE.profile) || {});
    // 慢变量"上次已知值"语义（10-18 用户拍板）：日更格在今天快照缺该字段时（如轻检日），回溯最近含该字段的快照，不再显示"—"
    const Sdate = [...dates].reverse().find((d) => hist[d] && hist[d].statuses && hist[d].statuses.ownCount != null);
    const S = Sdate ? hist[Sdate].statuses : ((tE && tE.statuses) || {});
    // 账号名称（X 昵称）：从最近含 name 的快照取（health.js 10-16 起记录），取不到回退内部 key
    const acctName = (() => { for (let i = dates.length - 1; i >= 0; i--) { const n = hist[dates[i]] && hist[dates[i]].profile && hist[dates[i]].profile.name; if (n) return n; } return null; })();
    const followers = P.followers ?? null, following = P.following ?? null;
    const metrics = [
      { label: '粉丝量', val: followers, ...fmtDelta(followers, pE && pE.profile ? pE.profile.followers : null) },
      { label: '关注量', val: following, ...fmtDelta(following, pE && pE.profile ? pE.profile.following : null) },
      { label: '关注/粉丝比', val: followers > 0 && following != null ? (following / followers).toFixed(2) : '—', txt: '健康线 ≤' + CFG.follow.ratioGuard.maxRatio, cls: 'flat', isRatio: true },
      { label: '原创帖(累计)', val: P.statuses ?? null, ...fmtDelta(P.statuses ?? null, pE && pE.profile ? pE.profile.statuses ?? null : null) },
      (() => { const m = { label: '回复(近24h)', val: S.ownCount ?? null, ...fmtDelta(S.ownCount ?? null, pE && pE.statuses ? pE.statuses.ownCount ?? null : null) };
        if (S.ownCount != null && Sdate && Sdate !== todayKey) m.txt = (m.txt && m.txt !== '—' ? m.txt + ' · ' : '') + '截至' + Sdate.slice(5);
        if (Sdate && prevKey && (Sdate >= '2026-10-18') !== (prevKey >= '2026-10-18')) m.txt = '口径切换期（10-18 起=24h 基数），环比暂不可比' + (Sdate ? ' · 截至' + Sdate.slice(5) : ''); // K3 评审版条件：仅当 delta 两侧口径不同（一侧≥10-18=24h、另一侧<10-18=48h）才警示，无假阳性且覆盖快照缺失边界
        return m; })(),
      // 互关粉丝占比（10-18 用户拍板口径）：**旧分子÷新分母**=最近一次扫描的互关数 ÷ 今日最新粉丝总数
      // 分子=每天凌晨 03:20 全量扫描一次，之后 24h 全部计算复用该数；分母=每天 09:00 健康日检免费更新
      (() => {
        const MUdates = [...dates].reverse().filter((d) => hist[d] && hist[d].mutual);
        const MUd = MUdates[0], MPd = MUdates[1];
        const MU = MUd ? hist[MUd].mutual : null, MP = MPd ? hist[MPd].mutual : null;
        const rNow = (MU && followers > 0) ? +((MU.mutual / followers) * 100).toFixed(1) : null;
        const rPrev = (MP && MPd && hist[MPd].profile && hist[MPd].profile.followers > 0) ? +((MP.mutual / hist[MPd].profile.followers) * 100).toFixed(1) : null;
        const asOf = MUd ? '截至' + MUd.slice(5) : '';
        let d = { txt: '—', cls: 'flat' };
        if (rNow != null && rPrev != null) {
          const pp = +(rNow - rPrev).toFixed(1);
          d = pp === 0 ? { txt: `${MU.mutual}/${followers} · ${asOf}`, cls: 'flat' }
            : { txt: `${pp > 0 ? '▲ +' : '▼ '}${pp}pp · ${MU.mutual}/${followers} · ${asOf}`, cls: pp > 0 ? 'up' : 'down' };
        } else if (rNow != null) d = { txt: `${MU.mutual}/${followers}${MU.scanned < 20 ? ' · 样本过小' : ''} · ${asOf}`, cls: 'flat' };
        return { label: '互关粉丝占比', val: rNow != null ? rNow + '%' : null, isRatio: true, ...d };
      })(),
    ];
    // 回复可见（v1.1 C2）：当日快照 replyVisibility 实算；无数据显示未启用
    const rvSnap = readJson(path.join(STATE_DIR, 'health-snapshots', `${TODAY}.json`));
    const rvList = (rvSnap && rvSnap.replyVisibility) || [];
    const rvSum = rvList.reduce((acc, x) => ({ checked: acc.checked + (x.checked || 0), visible: acc.visible + (x.visible || 0) }), { checked: 0, visible: 0 });
    const dims = [
      P.state === 'suspended' ? { icon: '✕', cls: 'down', name: '账号状态', st: '封禁/冻结 · ' + todayKey }
        : P.state === 'ok' && (S.sensitiveCount || 0) === 0 ? { icon: '✓', cls: 'ok-t', name: '账号状态', st: `正常 · 无敏感标记 · ${todayKey || '—'}（每日）` }
          : { icon: '◐', cls: 'unk-t', name: '账号状态', st: '未知（检测失败）· ' + (todayKey || '—') },
      (tE && tE.typeahead && tE.typeahead.state) === 'ok' ? { icon: tE.typeahead.found ? '✓' : '✗', cls: tE.typeahead.found ? 'ok-t' : 'wait-t', name: '搜索建议收录', st: (tE.typeahead.found ? '已收录' : '未收录（软信号）') + ` · ${todayKey || '—'}（每日）` }
        : { icon: '◐', cls: 'unk-t', name: '搜索建议收录', st: '未知 · ' + (todayKey || '—') },
      { icon: '⏳', cls: 'wait-t', name: '搜索可见', st: '未启用 · 待观察者窗口接入（P4）' },
      rvSum.checked > 0
        ? { icon: rvSum.visible === rvSum.checked ? '✓' : '✕', cls: rvSum.visible / rvSum.checked >= 0.5 ? 'ok-t' : 'down', name: '回复可见', st: `抽查可见 ${rvSum.visible}/${rvSum.checked}（窗后匿名核验 · v1.1）` }
        : { icon: '◐', cls: 'unk-t', name: '回复可见', st: '今日暂无抽查（窗后 +40 分钟自动核验）' },
    ];
    const series = HDAYS_ARR.map((d) => ({ d, v: hist[d] && hist[d].profile ? hist[d].profile.followers : null })).filter((x) => x.v != null);
    // 限流雷达（shadowbanradar 渲染通道）：当日快照优先，缺则回溯最近含 radar 的快照（10-18 修复：09:10 前打开不再退化"自建通道"）
    let radar = null;
    for (const rd of [TODAY, ...[1, 2].map((n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10))]) {
      const rsnap = readJson(path.join(STATE_DIR, 'health-snapshots', `${rd}.json`));
      if (rsnap && rsnap.radar && rsnap.radar.results && rsnap.radar.results[a.handle] && rsnap.radar.results[a.handle].four) {
        radar = { fetchedAt: rsnap.radar.fetchedAt, date: rd, url: rsnap.radar.results[a.handle].url, four: rsnap.radar.results[a.handle].four };
        break;
      }
    }
    // 关系池
    const contacts = readJson(path.join(STATE_DIR, `contacts-${a.key}.json`));
    let todayPool = [], topPool = [], poolSummary = null, scanToday = false;
    if (contacts) {
      const ppl = Object.values(contacts.people || {});
      const by = {};
      for (const e of ppl) by[e.stage] = (by[e.stage] || 0) + 1;
      // 成分拆解：近14天真互动 / 更早真互动 / Owen圈候选（2026-10-16 用户定口径：只计近2周）
      let real14 = 0, realOld = 0, owenOnly = 0;
      const cut14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      for (const e of ppl) {
        const evs = (e.activity && e.activity.theirEvents || []).filter((x) => x[2] === 'own-notif').map((x) => x[0]);
        if (e.activity && e.activity.ourLastReplyAt) evs.push(e.activity.ourLastReplyAt);
        if (e.relation && e.relation.weFollow && e.relation.weFollow.since) evs.push(e.relation.weFollow.since);
        if (e.relation && e.relation.theyFollow) evs.push(e.relation.theyFollow);
        const lr = evs.sort().pop();
        if (lr && lr >= cut14) real14 += 1;
        else if (lr) realOld += 1;
        else if (e.sources.includes('owen-insights')) owenOnly += 1;
        else realOld += 1;
      }
      poolSummary = { size: ppl.length, archived: Object.keys(contacts.archived || {}).length, by, real14, realOld, owenOnly, real: real14 + realOld };
      for (const e of ppl) {
        const evs = (e.activity && e.activity.theirEvents || []).filter((x) => x[0] === TODAY);
        if (evs.length) {
          scanToday = true;
          const types = [...new Set(evs.map((x) => x[1]))];
          todayPool.push({ handle: e.handle, score: e.score, types: types.join('+') });
        }
      }
      todayPool.sort((x, y) => y.score - x.score);
      topPool = ppl.slice().sort((x, y) => y.score - x.score).slice(0, 10).map((e) => ({ handle: e.handle, score: e.score, isNew: e.stage === 'new', stage: e.stage, last: (e.activity && e.activity.theirLastAt || '').slice(0, 10) || '—' }));
    }
    // 权重维护矩阵（10-17 用户定规则）：所有账号都维护 butcher+owen 的权重，各自排除自己；
    // 行状态如实：唯一存在过的机制是外部 boost.js 加持 Owen（butcher 暂停/fullwin 已收权），其余待接入未授权
    const MT = ['butcher', 'owen'];
    const key2handle = Object.fromEntries(CFG.accounts.map((x) => [x.key, x.handle]));
    const boost7d = countLogs7d((j) => (j.task === 1 && (j.account || 'butcher') === a.key) || (j.kind === 'maintain' && j.account === a.key && j.status === 'done')); // 旧四连 + v1.1 维护互动
    const maintain = [];
    for (const t of MT) {
      if (t === a.key) continue; // 不给自己做权重
      const row = { account: '@' + (key2handle[t] || t), type: '权重加持（爱心→书签→复制链接→回复）' };
      const isOwenBoostOwner = t === 'owen' && (a.key === 'butcher' || a.key === 'fullwin');
      if (isOwenBoostOwner) {
        row.via = a.key === 'butcher' ? '维护侦测器 maintain-watch（v1.1）' : '维护侦测器 maintain-watch（v1.1）';
        row.status = a.key === 'butcher' ? '维护中（旧四连已退役）' : '维护中（仅点赞授权）';
        row.recent = `近7日维护 ${boost7d} 次`;
      } else {
        row.via = '待接入（能力库已具备）';
        row.status = a.role === 'maintain' ? '维护授权·仅点赞（v1.1）' : a.role === 'observer' ? '未启用（观察者号，需放行）' : a.role === 'run' ? '未启用（等你拍板）' : '未授权 · 不执行';
        row.recent = '—';
      }
      maintain.push(row);
    }
    // 今日额度（2026-10-16 用户要求恢复在任务页顶部）：单向任务完成总量/规划当天总量
    // 完成量=当日真实动作审计（aggregateLogs 已滤 dry/simulated）；规划量=你拍板的日总量（没拍板=未设定/引擎帽）
    // 10-18 三方评审修复：①全窗化（原只算 am/mid/pm，漏互关晚窗+发布三窗）②条件任务改事件计数不画目标量 ③点赞计入维护互动
    const g1 = (agg[a.key] || {})[TODAY] || {};
    const WKEYS = Object.keys((CFG.rounds || {}).windows || { am: 1, mid: 1, pm: 1 });
    const sumWin = (p) => WKEYS.reduce((n, w) => n + ((g1[`${p}:${w}`] || {}).count || 0), 0);
    const planWin = (m) => WKEYS.reduce((n, w) => n + (m && typeof m[w] === 'number' ? m[w] : 0), 0);
    const RQA = Object.assign({}, Q, (((CFG.rounds || {}).quotasByAccount || {})[a.key] || {})); // 每号实际配额（10-19 起双号数字分叉：互关 25/40、串门 10/20）
    const quotas = [
      { label: '互关评论', unit: '条', done: sumWin('community'), planned: planWin(RQA.community), plannedText: String(planWin(RQA.community)), note: '三运营窗合计（拍板' + planWin(RQA.community) + '/天）' },
      { label: '关注帖主', unit: '人', done: sumWin('follow'), planned: null, plannedText: '随互关 1:1', note: '条件行事：每条互关评论自动先关注（非按量任务，无目标量）' },
      { label: '条件回关', unit: '人', done: sumWin('followReply'), planned: null, plannedText: '无任务上限', note: '10-19 拍板全账号：回复+关注双条件满足即回；唯一约束=滚动关注帽（引擎安全网非任务量）' },
      { label: '关系串门', unit: '条', done: sumWin('visit'), planned: planWin(RQA.visit), plannedText: String(planWin(RQA.visit)), note: '三运营窗合计（拍板上限：butcher 10/wcixot 20，按关系池实有人数自然衰减）' },
      { label: '原创发布', unit: '帖', done: sumWin('post'), planned: null, plannedText: '8~18/天（区间随机）', note: '10-18 你拍板：早2~5/午3~6/晚3~7，帖间隔1~10min定时发布；引擎帽 20/天' },
      { label: '点赞', unit: '赞', done: ((g1.graph || {}).count || 0) + ((g1.maintain || {}).count || 0), planned: ((CFG.executor && CFG.executor.rollingCaps || {}).like != null ? CFG.executor.rollingCaps.like : null), plannedText: '≤' + (((CFG.executor || {}).rollingCaps || {}).like ?? 20) + ' 引擎帽', note: '含权重维护互动点赞（10-18 修复：原只数已退役图谱行）' },
      { label: '取关', unit: '人', done: sumWin('unfollow'), planned: 0, plannedText: '0（不做）', note: '你拍板不做（unfollowPolicy off + 滚动帽 0 双保险）' },
    ];
    // 健康判定（10-19 用户拍板：雷达为主，FxTwitter 为辅）——有雷达数据时用雷达判定（权威），没跑雷达才退回 FxTwitter 三通道 verdict
    const radarVerdict = (() => {
      if (!radar || !radar.four) return null;
      const bad = ['ghost', 'deboost', 'search', 'suggestion'].filter((k) => radar.four[k] && !/未见/.test(radar.four[k]));
      if (bad.length === 0) return 'green';
      if (bad.includes('ghost') || bad.includes('deboost')) return 'restricted';
      return 'yellow';
    })();
    const fxVerdict = tE ? tE.verdict : null;
    const verdict = radarVerdict || (fxVerdict === 'suspended' ? 'suspended' : fxVerdict === 'green' && radarVerdict === null ? 'green' : fxVerdict);
    return {
      key: a.key, handle: a.handle, name: acctName || a.key,
      role: ({ run: '运行号（唯一授权真实互动）', linked: '已接入 · 未授权（不执行任务）', maintain: '已接入 · 维护授权（仅点赞 butcher/owen，v1.1）', observer: '观察者窗口（只读检测专用）' })[a.role || 'linked'],
      roleNote: a.note || '',
      isRun: a.role === 'run',
      verdict, verdictSource: radarVerdict ? 'radar' : 'fxtwitter', asOf: todayKey,
      metrics, dims, series, radar, quotas,
      todayPool, topPool, poolSummary, scanToday, maintain,
      grid: normalizeGrid(agg[a.key] || {}),
      health: hist,
    };
  });
  // 伪控制面板状态：发布投递箱有待发文件 → 发布行状态从"未投递"变"待发布"
  let inboxHas = false;
  try { inboxHas = fs.readdirSync(path.join(ROOT, 'posts-inbox')).some((f) => (f.endsWith('.json') || f.endsWith('.txt')) && !f.includes('.done')); } catch { }
  const taskRows = TASK_ROWS.map((r) => /^post:/.test(r.id) && inboxHas ? { ...r, status: 'ready-feed' } : r);
  const postsBudget = Object.assign({ butcher: (CFG.posts || {}).budget }, (CFG.posts || {}).budgetByAccount || {});

  // 7 日完成趋势（10-18 ④）：日总量=当日各号审计动作数；完成率分母=各号有 planned 的任务之和
  const trend = HDAYS_ARR.map((d) => {
    let done = 0, planned = 0;
    for (const a of accounts) {
      const g = (agg[a.key] || {})[d] || {};
      for (const cell of Object.values(g)) { if (typeof cell === 'object' && cell) done += cell.count || 0; }
      for (const q of a.quotas) if (q.planned > 0) planned += q.planned;
    }
    return { d, done, planned };
  });
  const weekSummary = { actions: trend.reduce((s2, x) => s2 + x.done, 0), reportsGenerated: HDAYS_ARR.filter((d) => reports[d]).length, days: HDAYS_ARR.length };

  // ══ 总览层（10-18 三方方案 ③）：系统状态/急停/双号卡/异常/节奏/帖队列/动作流 ══
  const pause = fs.existsSync(path.join(STATE_DIR, 'PAUSE'));

  // 心跳：今日最后一条日志时刻（调度静默判定依据）
  let heartbeatAt = null;
  try {
    const lines = fs.readFileSync(path.join(STATE_DIR, `log-${TODAY.slice(0, 7)}.jsonl`), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { try { const j = JSON.parse(lines[i]); if (j.at && j.at.startsWith(TODAY)) { heartbeatAt = j.at; break; } } catch { } }
  } catch { }

  // 下一窗口（从 config rounds.windows 算，今天还没到的最早一个）
  const bjNow = Date.now() + 8 * 3600000;
  const bjHm = new Date(bjNow).toISOString().slice(11, 16);
  const windowsList = Object.entries((CFG.rounds || {}).windows || {}).map(([k, v]) => ({ key: k, time: typeof v === 'object' ? v.time : v, modes: typeof v === 'object' ? v.modes : 'all' })).sort((x, y) => x.time < y.time ? -1 : 1);
  const nextWindow = windowsList.find((w) => w.time > bjHm) || null;

  // 定时帖队列（今日队列文件里 type=post 的条目，与审计对账已发/不明）
  const postsQueue = [];
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'queue')).filter((f) => f.startsWith(TODAY) && f.endsWith('.json') && f.includes('-p'))) {
      try {
        const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'queue', f), 'utf8'));
        if (!Array.isArray(q)) continue;
        for (const e of q) if (e && e.type === 'post' && e.postAt) {
          postsQueue.push({ account: e.account, window: e.window, postAt: e.postAt, status: e.status, text: String(e.text || '').slice(0, 40), quote: !!e.quote });
        }
      } catch { }
    }
  } catch { }
  postsQueue.sort((x, y) => x.postAt < y.postAt ? -1 : 1);

  // 今日动作流（最新 15 条真实动作，跨号）
  const actionStream = [];
  try {
    const lines = fs.readFileSync(path.join(STATE_DIR, `log-${TODAY.slice(0, 7)}.jsonl`), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && actionStream.length < 15; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (!j.at || !j.at.startsWith(TODAY) || j.dry || j.simulated) continue;
        if (j.task === 'round' || j.task === 'planner' || j.task === 'radar' || j.task === 'contacts' || j.task === 'contentPull' || j.task === 'maintainWatch') continue;
        if (j.task === 'executor' && j.action === 'execute') {
          actionStream.push({ at: j.at.slice(11, 19), account: j.account, action: j.type === 'post' ? (j.note && j.note.includes('引用') ? '引用帖' : '发帖') : j.type === 'reply' ? '回复' : j.type === 'follow' ? '关注' : j.type === 'like' ? '点赞' : j.type, target: j.target ? (String(j.target).startsWith('@') ? j.target : '@' + j.target) : '', status: j.status === 'done' ? '✓' : j.status === 'unknown' ? '?' : j.status === 'skipped' ? '跳' : '✗' });
        }
      } catch { }
    }
  } catch { }

  // 异常收件箱（8 规则，服务端算好客户端只渲染）
  const alerts = [];
  if (pause) alerts.push({ level: 'P0', text: '⏸ 急停生效中（state/PAUSE）——全部任务已停' });
  for (const a of accounts) {
    if (a.verdict === 'suspended') alerts.push({ level: 'P0', text: `${a.name} 账号状态：suspended（封禁/冻结）` });
    if (a.radar && a.radar.four) {
      const bad = ['ghost', 'deboost', 'search', 'suggestion'].filter((k) => a.radar.four[k] && !/未见/.test(a.radar.four[k]));
      if (bad.length) alerts.push({ level: a.isRun ? 'P1' : 'P2', text: `${a.name} 雷达${bad.map((k) => ({ ghost: '幽灵', deboost: '降权', search: '搜索', suggestion: '建议' }[k])).join('+')}受限（${((a.radar.four.score) || '?')}/100，截至 ${(a.radar.date || '').slice(5)}）` });
    }
    const uq = (normalizeGrid(agg[a.key] || {})[TODAY] || {});
    let unkCount = 0; for (const [k, v] of Object.entries(uq)) if (typeof v === 'object' && v.unknown && v.items && v.items.some((x) => x.includes('post-') || x.includes('community-') || x.includes('visit-'))) unkCount += v.unknown; // 只计有动作ID的（10-19：session级unknown误计入）
    if (unkCount > 0) alerts.push({ level: 'P0', text: `${a.name} 今日 ${unkCount} 条执行结果不明（unknown 待核）` });
    // 额度将满
    for (const q of a.quotas) if (q.planned > 0 && q.done >= q.planned * 0.9 && q.done < q.planned) alerts.push({ level: 'P2', text: `${a.name} ${q.label} ${q.done}/${q.planned}，额度将满` });
    // 帖过点未发
    for (const pq of postsQueue) if (pq.account === a.key && pq.status === 'planned' && Date.parse(pq.postAt) < Date.now() - 5 * 60000) alerts.push({ level: 'P1', text: `${a.name} 定时帖 ${(pq.postAt || '').slice(11, 16)} 已过点 5 分钟仍未执行` });
    // 健康快照过期
    if (a.isRun && a.asOf && a.asOf < TODAY) alerts.push({ level: 'P2', text: `${a.name} 健康快照截至 ${a.asOf}，今日 09:00 日检未跑或未落盘` });
  }
  // 调度静默
  if (heartbeatAt && Date.now() - Date.parse(heartbeatAt) > 90 * 60000) {
    const h = new Date(Date.parse(heartbeatAt) + 8 * 3600000).toISOString().slice(11, 16);
    alerts.push({ level: 'P1', text: `调度静默：最后日志 ${h}（已 ${Math.round((Date.now() - Date.parse(heartbeatAt)) / 60000)} 分钟无动作）` });
  }
  alerts.sort((x, y) => x.level.localeCompare(y.level));

  return { generatedAt: new Date().toISOString(), days: DAYS_ARR, hdays: HDAYS_ARR, taskRows, reports, accounts, postsBudget,
    overview: { pause, heartbeatAt, nextWindow, windowsList, postsQueue, actionStream, alerts, trend, weekSummary } };
}
function normalizeGrid(g) {
  const out = {};
  for (const [date, rows] of Object.entries(g)) {
    out[date] = {};
    for (const [id, c] of Object.entries(rows)) {
      if (!c || typeof c !== 'object') continue; // 跳过 roundDry 等标记字段
      out[date][id] = { count: c.count, times: [...(c.times || [])], items: c.items, unknown: c.unknown };
    }
    if (rows.roundDry) out[date].roundDry = true; // 演练轮标记（扫描/生成全真、未点击）
  }
  return out;
}

// ── 页面 ─────────────────────────────────────────────────


const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    try {
      const data = JSON.stringify(buildData());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    } catch (e) {
      console.error('buildData 失败:', e.stack || e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  // 静态文件（10-18 拆分：根治模板字符串正则坑）
  const STATIC = { '/': ['public/index.html', 'text/html'], '/index.html': ['public/index.html', 'text/html'], '/app.css': ['public/app.css', 'text/css'], '/app.js': ['public/app.js', 'application/javascript'] };
  const st = STATIC[req.url.split('?')[0]];
  if (st) { try { res.writeHead(200, { 'Content-Type': st[1] + '; charset=utf-8' }); res.end(fs.readFileSync(path.join(ROOT, st[0]))); } catch (e) { res.writeHead(404); res.end('not found'); } return; }
  res.writeHead(404); res.end('not found');
});
server.on('error', (e) => { console.error('启动失败: ' + e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`监控页面: http://127.0.0.1:${PORT}  （Ctrl+C 停止；日常双击 打开监控页面.bat）`);
});
