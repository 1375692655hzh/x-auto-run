// dashboard.js — 本地监控页面服务 v2（定稿版：数据页 指标/四维度 1:1 + 双图 + 关系池两表 + 权重池；任务页 类别列+设定/建议+完成量/设定量）
// 约定：红涨绿跌（用户 2026-10-16 拍板）；增长同时显示 绝对值+百分比；纯本地只读，不碰任何账号。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const X = Object.assign({ rollingCaps: { reply: 8, follow: 18, like: 15, unfollow: 5 } }, CFG.executor || {});
const GRID_DAYS = 2, DATA_DAYS = 7;

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
const WL = { am: '早', mid: '午', pm: '晚' };
const Q = ((CFG.rounds || {}).quotas) || {};
function windowRows(w, t) {
  const f = (m) => ((m || {})[w] != null ? m[w] : null);
  return [
    { id: `post:${w}`, t, cat: '原创发布', name: `原创发布·${WL[w]}窗`, unit: '帖', status: 'wait-feed', set: `${((CFG.posts && CFG.posts.budget && CFG.posts.budget.windowAllocation) || {})[w] ?? 0} 帖（拍板：Gentle ${((CFG.posts || {}).budget || {}).perDay || 2} 条/天，早1午0晚1）`, setNum: ((CFG.posts && CFG.posts.budget && CFG.posts.budget.windowAllocation) || {})[w] ?? null, sug: '1-2/天起步→≤5/天（XActions Gentle2~Normal5 档；官方50/天硬顶；X算法：每帖2h黄金窗，多发互相稀释）',
      desc: '绑定内容源（x-daily-serve）→ 拉取增量 hash 去重 → 缓冲 48h → 按窗预算滴灌 posts-inbox → 自动发布' },
    { id: `visit:${w}`, t, cat: '主动互动', name: `关系池串门·${WL[w]}窗`, unit: '条', status: 'on', set: `${f(Q.visit)} 条（你拍板）`, setNum: f(Q.visit), sug: '回复类合计≤5-10/天=低风险档（XActions 回复分档；官方200/天硬顶）',
      desc: '互惠分选人→对方最新帖留言（LLM+质量门，限频7/21天，近14天真关系口径）' },
    { id: `community:${w}`, t, cat: '社区互关', name: `互关评论·${WL[w]}窗`, unit: '条', status: 'on', set: `${f(Q.community)} 条（你拍板）`, setNum: f(Q.community), sug: '≤10/天=低风险；20-50/天=高风险档（XActions 分档；当前设定20/天落在高风险区，已如实告知）',
      desc: '互关话题选帖→先关注后回复（LLM 文案）' },
    { id: `follow:${w}`, t, cat: '社区互关', name: `关注帖主·${WL[w]}窗`, unit: '人', status: 'on', set: `${f(Q.follow)} 人（你拍板）`, setNum: f(Q.follow), sug: '≤30-50/天（XActions 20-150按账龄；账龄30天小号取下沿；官方400/天硬顶）',
      desc: '对评论对象过画像筛选后关注，比例>' + CFG.follow.ratioGuard.maxRatio + ' 当日停' },
    { id: `followBack:${w}`, t, cat: '社区互关', name: `回关新粉·${WL[w]}窗`, unit: '人', status: 'on', set: `10 人（你的"10/每小时"按窗落地）`, setNum: 10, sug: '≤30/天·按需（XActions follow-back 50/场次参考；只回真人宁缺）',
      desc: '粉丝列表 ' + (FB.scanCells || 40) + ' 格内真人回关' },
    { id: `unfollow:${w}`, t, cat: '社区互关', name: `取关·${WL[w]}窗`, unit: '人', status: 'off', set: '0（不做，你拍板）', setNum: null, sug: '0——不建议自动化（XActions 明示强烈不建议；follow churn 属执法违规画像）',
      desc: '非互关清理能力默认关（unfollowPolicy off + 额度0 双保险）' },
  ];
}
const TASK_ROWS = [
  { id: 'mutualScan', t: '03:20', cat: '系统运维', name: '互关粉丝占比扫描', unit: '次', status: 'on', set: '1 次/号·每天凌晨（10-18 你定：24h 扫一次，之后 24h 占比计算全部复用该互关数）', setNum: 1, sug: '1/天·凌晨低峰（扫描全量翻粉丝列表；全天占比=扫得互关数÷当日最新粉丝数，计算复用不再扫）', desc: 'followers-scan 每日凌晨全量数互关一次；监控页全天用该分子÷最新粉丝数出占比' },
  { id: 'health', t: '09:00', cat: '系统运维', name: '健康日检', unit: '次', status: 'on', set: '1 次', setNum: 1, sug: '1/天（radar 方法论：四项检测每日至少一检）', desc: 'FxTwitter 匿名三通道，喂六宫格/两图' },
  { id: 'radar', t: '09:10', cat: '系统运维', name: '限流雷达', unit: '次', status: 'on', set: '1 次（双号）', setNum: 1, sug: '1/天（shadowbanradar 免费档 30 次/天内充裕；过多检测无增益）', desc: 'shadowbanradar 渲染通道，四维度判定+分数' },
  { id: 'scan', t: '09:35', cat: '系统运维', name: '关系池扫描', unit: '次', status: 'on', set: '1 次/8屏', setNum: 1, sug: '1/天（只读零风险；同日重复扫描无增量收益——通知已去重）', desc: '只读扫通知页喂关系池' },
  { id: 'owen', t: '10:00', cat: '主动互动', name: 'Owen帖加持（外部任务）', unit: '帖', status: 'paused', set: '2 帖（旧拍板）', setNum: 2, sug: '≤2/天（外部任务维持旧档；X算法：直接导航不计推荐权重，仅关系维护价值）', desc: '外部 boost.js 任务：满45分钟新帖四连——**已退役**（10-17，接替者=权重维护互动行；ZCode 旧轮 10-18 已删除）' },
  { id: 'graph', t: '10:00', cat: '主动互动', name: '图谱点赞（外部任务）', unit: '赞', status: 'paused', set: '2 赞/轮（旧拍板）', setNum: null, sug: '点赞类合计≤20/天（XActions 50-100/天档，我们取约1/3更保守）', desc: '@' + (G0.handle || '?') + ' + @antiAIvo 随机点赞（只赞不评）——已随 boost.js 退役（10-17），能力未迁移，复活需拍板' },
  ...windowRows('am', '10:20'),
  ...windowRows('mid', '15:20'),
  ...windowRows('pm', '20:20'),
  { id: 'maintain', t: '随帖', cat: '主动互动', name: '权重维护互动', unit: '次', status: 'on', set: '≤2 帖/目标 · 1 号/帖 · ≤3 次/号（v1.1 拍板）', setNum: null, sug: '维护动作计入当日点赞(≤20)/回复总帽（XActions 分档同前；从被维护账号角度=黄金窗内分散信号）', desc: '侦测器白天每25分钟盯 butcher/Owen 新帖：45min~3h 黄金窗挑帖点赞（butcher 对 Owen 另有≤1条/2天回复）；自然互动占比>1/3 跳过；幽灵/降权熔断' },
  { id: 'verifyReply', t: '随窗(+40分)', cat: '系统运维', name: '回复可见性抽查', unit: '次', status: 'on', set: '每窗后 1 次 ×1-2 条（v1.1）', setNum: 1, sug: '事件触发 3 次/天（零暴露直测回复隐藏风险；与雷达交叉验证）', desc: '10:55/16:00/21:00 匿名核验刚发回复外部可见性；连续2天<50%自动触发雷达复测' },
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
      const winByHour = hour0 < 14 ? 'am' : hour0 < 18 ? 'mid' : 'pm'; // 旧系统无窗字段，按时段归属
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
        const w = (String(j.id).match(/-(am|mid|pm)-/) || [])[1] || winByHour;
        let base;
        if (j.type === 'post') base = 'post';
        else if (j.type === 'follow') base = /-fb-/.test(j.id) ? 'followBack' : 'follow';
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
    const P = (tE && tE.profile) || {};
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
        if (Sdate && Sdate <= '2026-10-17') m.txt = '口径切换期（10-18 前=48h 基数），环比暂不可比' + (Sdate ? ' · 截至' + Sdate.slice(5) : ''); // 24h 口径 10-18 起，此前快照为 48h 基数，跨口径环比会虚低
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
    // 限流雷达（shadowbanradar 渲染通道）：当日快照里的 radar 字段为准
    let radar = null;
    const rsnap = readJson(path.join(STATE_DIR, 'health-snapshots', `${TODAY}.json`));
    if (rsnap && rsnap.radar && rsnap.radar.results && rsnap.radar.results[a.handle]) {
      radar = { fetchedAt: rsnap.radar.fetchedAt, url: rsnap.radar.results[a.handle].url, four: rsnap.radar.results[a.handle].four };
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
    const g1 = (agg[a.key] || {})[TODAY] || {};
    const sumWin = (p) => ['am', 'mid', 'pm'].reduce((n, w) => n + ((g1[`${p}:${w}`] || {}).count || 0), 0);
    const planWin = (m) => ['am', 'mid', 'pm'].reduce((n, w) => n + (m && m[w] != null ? m[w] : 0), 0);
    const quotas = [
      { label: '互关评论', unit: '条', done: sumWin('community'), planned: planWin(Q.community), plannedText: String(planWin(Q.community)), note: '三窗合计 7+7+6（你拍板）' },
      { label: '关注帖主', unit: '人', done: sumWin('follow'), planned: planWin(Q.follow), plannedText: String(planWin(Q.follow)), note: '三窗合计（你拍板 20/天）' },
      { label: '回关新粉', unit: '人', done: sumWin('followBack'), planned: FB.perDay, plannedText: String(FB.perDay), note: '10/窗 ×3 封顶（你的 10/小时 落地）' },
      { label: '关系串门', unit: '条', done: sumWin('visit'), planned: planWin(Q.visit), plannedText: String(planWin(Q.visit)), note: '三窗合计 4+3+3（你拍板）' },
      { label: '原创发布', unit: '帖', done: sumWin('post'), planned: null, plannedText: '未设定', note: '你尚未拍板发布量；引擎帽 ≤10/天·2/窗' },
      { label: '点赞', unit: '赞', done: (g1.graph || {}).count || 0, planned: ((CFG.dailyCaps || {}).likes != null ? CFG.dailyCaps.likes : null), plannedText: '≤' + ((CFG.dailyCaps || {}).likes ?? 20) + ' 引擎帽', note: '图谱点赞暂停中；引擎滚动帽 20/天' },
      { label: '取关', unit: '人', done: sumWin('unfollow'), planned: 0, plannedText: '0（不做）', note: '你拍板不做（unfollowPolicy off + 滚动帽 0 双保险）' },
    ];
    return {
      key: a.key, handle: a.handle, name: acctName || a.key,
      role: ({ run: '运行号（唯一授权真实互动）', linked: '已接入 · 未授权（不执行任务）', maintain: '已接入 · 维护授权（仅点赞 butcher/owen，v1.1）', observer: '观察者窗口（只读检测专用）' })[a.role || 'linked'],
      roleNote: a.note || '',
      isRun: a.role === 'run',
      verdict: tE ? tE.verdict : null, asOf: todayKey,
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
  return { generatedAt: new Date().toISOString(), days: DAYS_ARR, hdays: HDAYS_ARR, taskRows, reports, accounts };
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
const PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X 运营监控</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; background: #eef1f5; color: #1c2733; font-size: 14px; }
  .app { display: flex; min-height: 100vh; }
  .side { width: 200px; background: #10202e; color: #cfe0ee; padding: 18px 12px; flex-shrink: 0; }
  .side h1 { font-size: 15px; color: #fff; margin-bottom: 3px; }
  .side .sub { font-size: 11px; color: #7d95a8; margin-bottom: 16px; }
  .acct-btn { display: block; width: 100%; text-align: left; background: transparent; border: none; color: #cfe0ee; padding: 10px 12px; border-radius: 8px; cursor: pointer; margin-bottom: 8px; font-size: 14px; }
  .acct-btn .nm { display: inline-block; max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; } /* 账号名称（X 昵称）过长省略 */
  .acct-btn:hover { background: #1b3247; }
  .acct-btn.on { background: #24557a; color: #fff; }
  .acct-btn .h { font-size: 11px; color: #8fa9bd; margin-top: 2px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
  .dot.g { background: #35c46f; } .dot.u { background: #b9bec4; } .dot.r { background: #e5484d; }
  .main { flex: 1; padding: 16px 26px; min-width: 0; } /* 不设 max-width：内容随窗口铺满，右侧不留白 */
  .topbar { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .tabs button { border: none; background: #dfe6ed; padding: 7px 24px; font-size: 14px; border-radius: 8px 8px 0 0; cursor: pointer; color: #51606e; }
  .tabs button.on { background: #fff; color: #111; font-weight: 700; }
  .meta { font-size: 12px; color: #8a97a3; margin-left: auto; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(16,32,46,.07); }
  .card h3 { font-size: 13px; color: #51606e; font-weight: 700; margin-bottom: 10px; }
  .card h3 .src { font-weight: 400; font-size: 11px; color: #98a5b1; margin-left: 8px; }
  .row1 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }   /* 左右各占一半 */
  .grid6 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .metric { border: 1px solid #e4eaf0; border-radius: 9px; padding: 9px 11px; }
  .metric .label { font-size: 12px; color: #6b7885; }
  .metric .val { font-size: 21px; font-weight: 800; margin: 1px 0; }
  .metric .delta { font-size: 11.5px; }
  /* 红涨绿跌（2026-10-16 用户拍板） */
  .up { color: #d64545; } .down { color: #1f9d55; } .flat { color: #98a5b1; }
  .ratio-v { color: #1f9d55; }
  .dims { display: flex; flex-direction: column; gap: 7px; }
  .dim { border: 1px solid #e4eaf0; border-radius: 8px; padding: 8px 11px; display: flex; align-items: center; gap: 10px; }
  .dim .icon { font-size: 15px; width: 20px; text-align: center; }
  .dim .name { font-size: 13px; font-weight: 700; width: 96px; }
  .dim .st { font-size: 11.5px; color: #6b7885; flex: 1; }
  .ok-t { color: #1f9d55; } .unk-t { color: #98a5b1; } .wait-t { color: #c2761b; }
  .charts2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .pool2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #edf1f5; padding: 6px 8px; font-size: 12.5px; text-align: center; }
  th { color: #6b7885; font-weight: 600; background: #f7fafc; }
  td.l { text-align: left; }
  .badge { display: inline-block; font-size: 10px; border-radius: 4px; padding: 1px 6px; margin-left: 5px; }
  .badge.new { background: #e3f0fb; color: #2563a8; font-weight: 700; }
  .tasktable th, .tasktable td { border: 1px solid #e2e8ee; padding: 8px 8px; font-size: 12.5px; text-align: center; vertical-align: middle; }
  .tasktable { table-layout: fixed; }
  td.cat { font-weight: 800; font-size: 12.5px; color: #24557a; background: #f4f8fc; }
  .t-name { font-weight: 700; font-size: 13px; }
  .cat-tag { display: inline-block; font-size: 10px; border-radius: 4px; padding: 1px 6px; background: #eef3f8; color: #24557a; margin-right: 4px; vertical-align: 1px; }
  .t-desc { font-size: 11.5px; color: #6b7885; line-height: 1.4; }
  .tgt .set { font-size: 12.5px; color: #6d5a1e; font-weight: 700; display: block; }
  .tgt .sug { font-size: 11px; color: #98a5b1; line-height: 1.5; }
  .tgt .sug .sug-head { color: #4a5866; }
  .tgt .sug .sugv { font-weight: 800; font-size: 12.5px; color: #1d6fb8; }
  .tgt .sug .sug-rest { color: #98a5b1; }
  .cell-n { font-weight: 700; font-size: 13px; }
  .cell-n .frac { color: #98a5b1; font-weight: 400; font-size: 11px; }
  .cell-t { color: #6d7c8a; font-size: 10.5px; display: block; margin-top: 1px; }
  td.dimc { color: #c3ccd4; }
  /* 整行底色只看任务状态（2026-10-16 用户设计）：能运行=白底；暂停/停用/待接入/未投递=灰底 */
  tr.row-on td { background: #ffffff; }
  tr.row-off td { background: #eceff3; }
  /* 已完成格=全站唯一一种绿，优先级高于行底色：无论行是白是灰，做了就是同一个绿，无深浅差 */
  td.fillc, tr.row-on td.fillc, tr.row-off td.fillc { background: #ddf3e4; }
  tr.row-off .t-name { color: #5c6a76; }
  tr.row-off .cat-tag { background: #dfe3e9; color: #6b7885; }
  tr.row-off .t-desc, tr.row-off .set, tr.row-off .sug, tr.row-off .ttime { color: #97a3ae; }
  tr.row-off .sug .sugv { color: #6a94b8; }
  .unk { color: #c2761b; font-size: 11px; }
  .foot-note { font-size: 11px; color: #98a5b1; margin-top: 8px; }
  .qrow { display: flex; flex-wrap: wrap; gap: 10px; }
  .linkchip { font-size: 9.5px; background: #33506a; color: #d8e8f5; border-radius: 4px; padding: 1px 5px; vertical-align: 1px; font-weight: 600; }
  .qchip { flex: 1 1 138px; min-width: 128px; max-width: 190px; border: 1px solid #e2e8ee; border-radius: 9px; padding: 8px 10px 9px; background: #fbfcfe; }
  .qchip.qchip-off { background: #f1f3f6; }
  .qtop { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .qlabel { font-size: 12px; font-weight: 700; color: #2c3a47; }
  .qnum { font-size: 14px; font-weight: 800; color: #1f6e43; }
  .qsep { color: #98a5b1; font-weight: 400; padding: 0 1px; }
  .qunit { font-size: 10.5px; color: #8a97a3; font-weight: 400; margin-left: 2px; }
  .qbar { position: relative; height: 13px; border-radius: 7px; background: #e8edf3; overflow: hidden; }
  .qbar i { position: absolute; left: 0; top: 0; bottom: 0; background: #4a9e6f; border-radius: 7px; }
  .qbar .qpct { position: absolute; right: 6px; top: 0; font-size: 9.5px; line-height: 13px; color: #4a5b68; }
  .qbar-none { background: #f1f3f6; text-align: center; }
  .qbar-none .qnone { font-size: 9.5px; line-height: 13px; color: #a7b2bd; }
  .btn-refresh { border: 1px solid #c8d4de; background: #fff; border-radius: 7px; padding: 5px 14px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
<div class="app">
  <div class="side">
    <h1>X 运营监控</h1>
    <div class="sub">本地只读 · 数据=审计日志</div>
    <div id="accts"></div>
  </div>
  <div class="main">
    <div class="topbar">
      <div class="tabs">
        <button id="tab-data" class="on" onclick="switchTab('data')">数据</button>
        <button id="tab-task" onclick="switchTab('task')">任务</button>
      </div>
      <button class="btn-refresh" onclick="load()">刷新</button>
      <div class="meta" id="meta"></div>
    </div>
    <div id="view-data"></div>
    <div id="view-task" style="display:none"></div>
  </div>
</div>
<script>
var DATA = null, CUR = null;
function vDot(v) { return v === 'green' ? 'g' : v === 'suspended' ? 'r' : 'u'; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function switchTab(t) {
  document.getElementById('tab-data').className = t === 'data' ? 'on' : '';
  document.getElementById('tab-task').className = t === 'task' ? 'on' : '';
  document.getElementById('view-data').style.display = t === 'data' ? '' : 'none';
  document.getElementById('view-task').style.display = t === 'task' ? '' : 'none';
}
function pick(i) { CUR = DATA.accounts[i].key; render(); }
function render() {
  var side = '';
  for (var i = 0; i < DATA.accounts.length; i++) {
    var a = DATA.accounts[i];
    side += '<button class="acct-btn' + (a.key === CUR ? ' on' : '') + '" onclick="pick(' + i + ')" title="' + esc(a.roleNote) + '">'
      + '<span class="dot ' + vDot(a.verdict) + '"></span><span class="nm">' + esc(a.name) + '</span>' + (a.isRun ? '' : ' <span class="linkchip">' + (a.role === 'observer' ? '观察者' : '仅接入') + '</span>')
      + '<div class="h">@' + esc(a.handle) + (a.metrics[0].val != null ? ' · ' + a.metrics[0].val + '粉' : '') + '</div></button>';
  }
  document.getElementById('accts').innerHTML = side;
  document.getElementById('meta').textContent = '数据截至 ' + (cur().asOf || '—') + ' · 生成 ' + new Date(DATA.generatedAt).toLocaleTimeString('zh-CN') + ' · 60s 自动刷新';
  document.getElementById('view-data').innerHTML = renderData(cur());
  document.getElementById('view-task').innerHTML = renderTask(cur());
}
function cur() { for (var k = 0; k < DATA.accounts.length; k++) if (DATA.accounts[k].key === CUR) return DATA.accounts[k]; return DATA.accounts[0]; }

function renderData(a) {
  var h = '<div class="row1">';
  // 左：核心指标（3×2）
  h += '<div class="card"><h3>核心指标<span class="src">快照差值 · 红涨绿跌</span></h3><div class="grid6">';
  for (var i = 0; i < a.metrics.length; i++) {
    var m = a.metrics[i];
    h += '<div class="metric"><div class="label">' + esc(m.label) + '</div><div class="val' + (m.isRatio ? ' ratio-v' : '') + '">' + (m.val != null ? m.val : '—') + '</div><div class="delta ' + m.cls + '">' + esc(m.txt) + '</div></div>';
  }
  h += '</div></div>';
  // 右：健康四维度（radar 渲染通道优先，无则退回自建三通道）
  if (a.radar && a.radar.four) {
    var f = a.radar.four;
    var rows = [['搜索建议限制', f.suggestion], ['搜索限制', f.search], ['回复隐藏(幽灵)', f.ghost], ['回复排序降低', f.deboost]];
    h += '<div class="card"><h3>健康监测 · 四维度<span class="src">shadowbanradar 渲染通道 · ' + (f.score || '?') + '/100 ' + esc(f.verdict || '') + ' · ' + new Date(a.radar.fetchedAt).toLocaleString('zh-CN') + '</span></h3><div class="dims">';
    for (var k3 = 0; k3 < rows.length; k3++) {
      var v3 = rows[k3][1];
      var icon3 = v3 == null ? ['◐', 'unk-t'] : (/未见/.test(v3) ? ['✓', 'ok-t'] : ['✕', 'down']);
      h += '<div class="dim"><div class="icon ' + icon3[1] + '">' + icon3[0] + '</div><div class="name">' + rows[k3][0] + '</div><div class="st">' + esc(v3 || '未知') + '</div></div>';
    }
    h += '</div><div style="font-size:11px;margin-top:6px"><a href="' + esc(a.radar.url) + '" target="_blank" style="color:#3d8fd1">结果页 ↗</a></div></div>';
  } else {
    h += '<div class="card"><h3>健康监测 · 四维度<span class="src">自建通道（radar 当日未跑）</span></h3><div class="dims">';
    for (var j = 0; j < a.dims.length; j++) {
      var d = a.dims[j];
      h += '<div class="dim"><div class="icon ' + d.cls + '">' + d.icon + '</div><div class="name">' + esc(d.name) + '</div><div class="st">' + esc(d.st) + '</div></div>';
    }
    h += '</div></div>';
  }
  h += '</div>';
  // 两图并排
  h += '<div class="charts2">' + chartLine(a) + chartBar(a) + '</div>';
  // 关系池两表
  h += '<div class="pool2">';
  h += '<div class="card"><h3>关系池 · 今日互动<span class="src">今晨通知扫描所得</span></h3><table><tr><th>#</th><th>对象</th><th>得分</th><th>互动</th></tr>';
  if (!a.poolSummary) h += '<tr><td colspan="4" class="flat">未建池</td></tr>';
  else if (!a.todayPool.length) h += '<tr><td colspan="4" class="flat">' + (a.scanToday ? '今日暂无新增互动' : '今日扫描未运行（09:35 任务）') + '</td></tr>';
  else for (var p = 0; p < a.todayPool.slice(0, 10).length; p++) {
    var tp = a.todayPool[p];
    h += '<tr><td>' + (p + 1) + '</td><td class="l">@' + esc(tp.handle) + '</td><td><b>' + tp.score + '</b></td><td>' + esc(tp.types) + '</td></tr>';
  }
  h += '</table></div>';
  h += '<div class="card"><h3>关系池 · 历史得分（日更）<span class="src">近30天互惠分 · NEW=入池未接触</span></h3><table><tr><th>#</th><th>对象</th><th>得分</th><th>最近互动</th></tr>';
  if (!a.topPool.length) h += '<tr><td colspan="4" class="flat">未建池</td></tr>';
  for (var q = 0; q < a.topPool.length; q++) {
    var tp2 = a.topPool[q];
    h += '<tr><td>' + (q + 1) + '</td><td class="l">@' + esc(tp2.handle) + (tp2.isNew ? ' <span class="badge new">NEW</span>' : '') + '</td><td><b>' + tp2.score + '</b></td><td>' + esc(tp2.last) + '</td></tr>';
  }
  if (a.poolSummary) h += '<tr><td colspan="4" class="flat">池共 ' + a.poolSummary.size + ' 人 = 近14天真互动 ' + a.poolSummary.real14 + ' + 更早 ' + a.poolSummary.realOld + ' + Owen圈候选 ' + a.poolSummary.owenOnly + '（不用于串门）｜归档 ' + a.poolSummary.archived + '｜分层：' + (Object.keys(a.poolSummary.by).map(function (k2) { return k2 + ':' + a.poolSummary.by[k2]; }).join(' ') || '空') + '</td></tr>';
  h += '</table></div></div>';
  // 权重维护账号池
  h += '<div class="card"><h3>权重维护账号池<span class="src">维护矩阵（10-17 拍板）：所有号维护 butcher+owen 的权重，各自排除自己；实际执行以各行为准</span></h3><table><tr><th>账号</th><th>维护类型</th><th>接入方式</th><th>状态</th><th>近7日记录</th></tr>';
  for (var w = 0; w < a.maintain.length; w++) {
    var mw = a.maintain[w];
    h += '<tr><td class="l"><b>' + esc(mw.account) + '</b></td><td>' + esc(mw.type) + '</td><td>' + esc(mw.via) + '</td><td class="wait-t">' + esc(mw.status) + '</td><td>' + esc(mw.recent) + '</td></tr>';
  }
  h += '</table></div>';
  return h;
}
function chartLine(a) {
  var pts = a.series;
  var h = '<div class="card"><h3>粉丝走势（近7日 · 折线）</h3>';
  if (pts.length < 2) return h + '<div class="flat" style="padding:30px 0;text-align:center">快照不足（每日健康检测后自动出图）</div></div>';
  var W = 460, H = 130, p2 = 34, min = Math.min.apply(null, pts.map(function (x) { return x.v; })) - 2, max = Math.max.apply(null, pts.map(function (x) { return x.v; })) + 2;
  var xs = pts.map(function (x, i2) { return p2 + (W - 2 * p2) * (i2 / (pts.length - 1)); });
  var ys = pts.map(function (x) { return 14 + (H - 46) * (1 - (x.v - min) / (max - min)); });
  h += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">';
  h += '<line x1="' + p2 + '" y1="14" x2="' + p2 + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/><line x1="' + p2 + '" y1="' + (H - 26) + '" x2="' + (W - 14) + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/>';
  h += '<polyline points="' + xs.map(function (x, i3) { return x.toFixed(1) + ',' + ys[i3].toFixed(1); }).join(' ') + '" fill="none" stroke="#3d8fd1" stroke-width="2.5"/>';
  for (var i = 0; i < pts.length; i++) {
    h += '<circle cx="' + xs[i] + '" cy="' + ys[i] + '" r="3.5" fill="#3d8fd1"><title>' + pts[i].d + ' ' + pts[i].v + '粉</title></circle>';
    if (pts[i].d === a.asOf || i === pts.length - 1) h += '<text x="' + xs[i] + '" y="' + (ys[i] - 8) + '" font-size="11" text-anchor="middle" fill="#51606e">' + pts[i].v + '</text>';
    h += '<text x="' + xs[i] + '" y="' + (H - 10) + '" font-size="9.5" text-anchor="middle" fill="#8a97a3">' + pts[i].d.slice(5) + '</text>';
  }
  return h + '</svg></div>';
}
function chartBar(a) {
  var pts = a.series;
  var h = '<div class="card"><h3>粉丝量（近7日 · 柱状）</h3>';
  if (pts.length < 2) return h + '<div class="flat" style="padding:30px 0;text-align:center">快照不足</div></div>';
  var W = 460, H = 130, max = Math.max.apply(null, pts.map(function (x) { return x.v; })) + 3;
  var bw = Math.min(40, (W - 70) / pts.length - 10);
  h += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block"><line x1="30" y1="' + (H - 26) + '" x2="' + (W - 14) + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/>';
  for (var i = 0; i < pts.length; i++) {
    var x = 40 + i * ((W - 70) / pts.length), bh = (H - 46) * (pts[i].v / max);
    var isLast = i === pts.length - 1;
    h += '<rect x="' + x + '" y="' + (H - 26 - bh) + '" width="' + bw + '" height="' + bh + '" fill="' + (isLast ? '#3d8fd1' : '#9ec4e3') + '"><title>' + pts[i].d + ' ' + pts[i].v + '粉</title></rect>';
    h += '<text x="' + (x + bw / 2) + '" y="' + (H - 31 - bh) + '" font-size="10" text-anchor="middle" fill="#51606e">' + pts[i].v + '</text>';
    h += '<text x="' + (x + bw / 2) + '" y="' + (H - 10) + '" font-size="9.5" text-anchor="middle" fill="#8a97a3">' + pts[i].d.slice(5) + '</text>';
  }
  return h + '</svg></div>';
}
// 建议量格式化（2026-10-16）：首个"（"前=主值段，数值加粗提色（sugv）；括号内出处说明保持浅灰
function sugFmt(s) {
  if (!s) return '';
  var parts = String(s).split('（');
  var head = parts.shift();
  var rest = parts.length ? '<span class="sug-rest">（' + esc(parts.join('（')) + '</span>' : '';
  var headFmt = esc(head).replace(/([≤≥]?\\d+(?:\\.\\d+)?(?:\\s*[-~]\\s*\\d+(?:\\.\\d+)?)?(?:\\s*\\/\\s*[天窗帖次份条人赞轮hH])?)/g, '<b class="sugv">$1</b>'); // 注意：本段在页面模板字符串内，正则转义必须双反斜杠（单杠会被模板吃掉→下发语法错误→整页白屏，10-16 已踩坑）
  return '<span class="sug-head">' + headFmt + '</span>' + rest;
}
function quotaBlock(a) {  if (!a.isRun || !a.quotas || !a.quotas.length) return ''; // 额度条只属于运行号；接入未授权号不展示额度
  var h = '<div class="card"><h3>今日额度 · ' + esc(DATA.days[DATA.days.length - 1]) + '<span style="font-weight:400;font-size:11px;color:#98a5b1">（单向任务 · 完成总量/规划当天总量）</span></h3><div class="qrow">';
  for (var i = 0; i < a.quotas.length; i++) {
    var q = a.quotas[i];
    var pct = 0;
    if (q.planned > 0) pct = Math.min(100, Math.round((q.done / q.planned) * 100));
    else if (q.planned === 0 && q.done > 0) pct = 100;
    var noBar = q.planned == null; // 未设定：不画进度条
    h += '<div class="qchip' + (q.planned === 0 ? ' qchip-off' : '') + '" title="' + esc(q.note) + '">'
      + '<div class="qtop"><span class="qlabel">' + esc(q.label) + '</span><span class="qnum">' + q.done + '<span class="qsep">/</span>' + esc(q.plannedText) + '<span class="qunit">' + esc(q.unit) + '</span></span></div>'
      + '<div class="qbar' + (noBar ? ' qbar-none' : '') + '">' + (noBar ? '<span class="qnone">待拍板</span>' : '<i style="width:' + pct + '%"></i><span class="qpct">' + (q.planned === 0 ? '停' : pct + '%') + '</span>') + '</div>'
      + '</div>';
  }
  return h + '</div><div class="foot-note">完成量 = 当日真实动作审计（演练/模拟不计）；规划量 = 你拍板的当日总量，未拍板的如实显示未设定/引擎帽。</div></div>';
}
function renderTask(a) {
  var wd = ['日', '一', '二', '三', '四', '五', '六'];
  var ST = { on: ['●运行', 'ok-t'], paused: ['●暂停', 'wait-t'], off: ['●停用', 'flat'], pending: ['●待接入', 'flat'], 'wait-feed': ['●未投递', 'wait-t'], 'ready-feed': ['●待发布', 'ok-t'] };
  var h = '';
  if (!a.isRun) {
    h += '<div class="card" style="border-left:4px solid #c8a23c"><b>' + esc(a.role) + '</b>'
      + '<div class="t-desc" style="margin-top:4px">' + esc(a.roleNote || '该账号仅接入注册表，未授权执行任务。') + ' 下方任务表全灰=该号不运行任何任务；历史数据（若有）只读展示。</div></div>';
  }
  h += quotaBlock(a) + '<div class="tbl-wrap"><table class="tasktable"><colgroup><col style="width:58px"><col style="width:286px"><col style="width:66px"><col style="width:158px"><col style="width:132px">'
    + DATA.days.map(function () { return '<col style="width:104px">'; }).join('') + '</colgroup>'
    + '<tr><th>时间</th><th>任务 / 说明</th><th>状态</th><th>设定量<span style="font-weight:400;font-size:10px;color:#98a5b1">（当次执行量·你拍板）</span></th><th>建议量<span style="font-weight:400;font-size:10px;color:#98a5b1">（每日总量·X算法/XActions 档位）</span></th>';
  for (var i = 0; i < DATA.days.length; i++) {
    var dd = new Date(DATA.days[i] + 'T00:00:00');
    h += '<th' + (i === DATA.days.length - 1 ? ' class="today"' : '') + '>' + DATA.days[i].slice(5) + '<br><span style="font-size:10px;color:#8a97a3;font-weight:400">周' + wd[dd.getDay()] + '</span></th>';
  }
  h += '</tr>';
  var rows = DATA.taskRows;
  for (var r2 = 0; r2 < rows.length; r2++) {
    var row = rows[r2];
    var st = ST[row.status] || ['●', 'flat'];
    if (!a.isRun) st = ['●未授权', 'flat']; // 接入号：任何任务都不在此号上运行
    h += '<tr class="' + (row.status === 'on' && a.isRun ? 'row-on' : 'row-off') + '"><td class="ttime">' + esc(row.t) + '</td>'
      + '<td class="l"><span class="cat-tag">' + esc(row.cat) + '</span> <span class="t-name">' + esc(row.name) + '</span><div class="t-desc" title="' + esc(row.desc) + '">' + esc(row.desc) + '</div></td>'
      + '<td class="' + st[1] + '" style="font-size:11px;font-weight:600">' + st[0] + '</td>'
      + '<td class="tgt"><span class="set">' + (a.isRun ? esc(row.set) : '—') + '</span></td>' // 设定量=butcher 拍板值，接入号显示"—"避免误读
      + '<td class="tgt"><span class="sug">' + sugFmt(row.sug) + '</span></td>';
    for (var c = 0; c < DATA.days.length; c++) {
      var d = DATA.days[c];
      var cell = null;
      if (row.id === 'report') { cell = DATA.reports[d] ? { count: 1, times: ['22:05'], items: ['日报文件已生成'] } : null; }
      else if (row.id === 'health') { var e = a.health[d]; if (e) cell = { count: 1, times: [], items: ['判定 ' + e.verdict + (e.profile && e.profile.followers != null ? ' · ' + e.profile.followers + '粉' : '')] }; }
      else {
        var g = a.grid[d] && a.grid[d][row.id];
        if (g) cell = g;
        else if (/^community:/.test(row.id) && a.grid[d] && a.grid[d].roundDry) cell = { count: 0, times: [], items: ['演练轮已完整运行（扫描/生成/入队全真），未点击发送'], dry: true };
      }
      if (!cell) { h += '<td class="dimc">·</td>'; continue; }
      var frac = row.setNum ? '<span class="frac">/' + row.setNum + esc(row.unit) + '</span>' : '';
      var times = (cell.times || []).slice(0, 3).join('/');
      var tip = (cell.items || []).slice(0, 10).join('\\n') || (row.name + ' ' + cell.count);
      h += '<td class="fillc" title="' + esc(tip).replace(/\\n/g, '&#10;') + '"><span class="cell-n">' + (row.id === 'health' || row.id === 'radar' ? '✓' : (cell.dry ? '演练' : cell.count + frac)) + '</span>'
        + (times ? '<span class="cell-t">' + times + '</span>' : '') + (cell.unknown ? '<span class="unk">不明' + cell.unknown + '</span>' : '') + '</td>';
    }
    h += '</tr>';
  }
  h += '</table></div><p class="foot-note">时间线排序；设定量=<b>当次执行量</b>（你拍板的每窗/每次值）；建议量=<b>每日总量角度</b>（源自 XActions 风险分档与 X 算法/执法源码结论）；回复类（串门+互关+被动）共用同一"每日回复总量"分档；日期格=完成量/设定量+时间。</p>';
  return h;
}
function load() {
  fetch('/api/data').then(function (r) { return r.json(); }).then(function (j) {
    DATA = j;
    if (!CUR && j.accounts.length) CUR = j.accounts[0].key;
    render();
  });
}
load();
setInterval(load, 60000);
</script>
</body>
</html>`;

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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.on('error', (e) => { console.error('启动失败: ' + e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`监控页面: http://127.0.0.1:${PORT}  （Ctrl+C 停止；日常双击 打开监控页面.bat）`);
});
