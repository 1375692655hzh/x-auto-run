// status.js — 最小控制面（P2）：一条命令看清系统全貌（纯只读，不碰任何账号）
// 用法: node status.js [--account butcher]
// 输出六块：急停/锁/熔断 · 健康 · 关系台账 · 额度（今日+滚动24h）· 队列 · 最近审计
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const X = Object.assign({ rollingCaps: { reply: 8, follow: 18, like: 15, unfollow: 5 } }, CFG.executor || {});

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ACCOUNT = argOf('account', 'butcher');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = (iso) => { if (!iso) return '-'; const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const line = (s = '') => console.log(s);

// ── 1 急停 / 锁 / 熔断 ───────────────────────────────────
line('━━ 系统开关 ━━');
line(`PAUSE 急停: ${fs.existsSync(path.join(STATE_DIR, 'PAUSE')) ? '⚠ 生效中（全停）' : '未启用'}`);
const lock = readJson(path.join(STATE_DIR, `lock-${ACCOUNT}.json`));
line(`账号锁(${ACCOUNT}): ${lock ? `运行中 pid=${lock.pid} since ${hm(new Date(lock.at).toISOString())}` : '空闲'}`);
const ledger = readJson(path.join(STATE_DIR, `ledger-${ACCOUNT}.json`)) || { actions: {}, meta: {} };
line(`当日熔断: ${ledger.meta.abortedToday === today() ? '⚠ ' + (ledger.meta.abortReason || '已熔断') : '无'}`);

// ── 2 健康快照 ───────────────────────────────────────────
line('━━ 健康检测（FxTwitter 匿名日检） ━━');
const snapDir = path.join(STATE_DIR, 'health-snapshots');
let snaps = [];
try { snaps = fs.readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort(); } catch { }
if (!snaps.length) line('（暂无快照）');
else {
  const snap = readJson(path.join(snapDir, snaps[snaps.length - 1]));
  const e = snap && snap.accounts && snap.accounts[ACCOUNT];
  if (!e) line(`（${snaps[snaps.length - 1]} 无 ${ACCOUNT} 记录）`);
  else {
    const icon = e.verdict === 'green' ? '🟢' : e.verdict === 'suspended' ? '🔴' : '⚪';
    line(`${icon} ${e.verdict} @${e.handle}（${hm(snap.checkedAt)}）`);
    const fd = (e.delta && Number.isFinite(e.delta.followers)) ? `（较上次 ${e.delta.followers >= 0 ? '+' : ''}${e.delta.followers}）` : '';
    const own = e.statuses.ownCount ?? '?';
    const rp = e.statuses.repostCount ?? '?';
    const sens = e.statuses.sensitiveCount ?? '?';
    line(`   粉丝 ${e.profile.followers ?? '?'}${fd} · 24h 回复 ${own} 条 + 转发 ${rp} · 最新动作 ${hm(e.statuses.newestAt)} · 敏感标记 ${sens} · 建议索引 ${e.typeahead.found ? '收录' : '未收录'}`);
  }
}

// ── 3 关系台账 ───────────────────────────────────────────
line('━━ 关系台账 ━━');
const contacts = readJson(path.join(STATE_DIR, `contacts-${ACCOUNT}.json`));
if (!contacts) line('（未建池：node contacts.js --account ' + ACCOUNT + ' --build）');
else {
  const ppl = Object.values(contacts.people || {});
  const byStage = {};
  for (const e of ppl) byStage[e.stage] = (byStage[e.stage] || 0) + 1;
  line(`活跃池 ${ppl.length} / 归档 ${Object.keys(contacts.archived || {}).length}（更新 ${hm(contacts.updated)}）`);
  line(`   分层: ${Object.entries(byStage).map(([k, v]) => `${k}:${v}`).join(' ') || '空'}`);
  const top = ppl.sort((a, b) => b.score - a.score).slice(0, 3);
  for (const t of top) line(`   Top: @${t.handle} 分${t.score} ${t.stage} 对方最近 ${t.activity.theirLastAt ? t.activity.theirLastAt.slice(0, 10) : '-'}`);
}

// ── 4 额度（今日 boost 计数 + 滚动 24h 合并口径） ─────────
line('━━ 额度（今日 + 滚动24h 合并口径） ━━');
const st = readJson(path.join(STATE_DIR, ACCOUNT + '.json'));
const d = (st && st.daily && st.daily[today()]) || {};
const boostReply = (d.owenReplies || 0) + (d.communityReplies || 0);
const cut = Date.now() - 24 * 3600 * 1000;
const led = (t) => ((ledger.actions[t] || []).filter((x) => x > cut)).length;
const rows = [
  ['回复', boostReply + led('reply'), X.rollingCaps.reply],
  ['关注', (d.follows || 0) + led('follow'), X.rollingCaps.follow],
  ['点赞', (d.likes || 0) + led('like'), X.rollingCaps.like],
  ['取关', (d.unfollows || 0) + led('unfollow'), X.rollingCaps.unfollow],
];
for (const [name, used, cap] of rows) {
  const pct = cap ? Math.round((used / cap) * 100) : 0;
  line(`   ${name} ${used}/${cap} ${pct >= 90 ? '⚠ ' : ''}${'|'.repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, '·')} ${pct}%`);
}

// ── 5 队列 ───────────────────────────────────────────────
line('━━ 动作队列 ━━');
let qfiles = [];
try { qfiles = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json')); } catch { }
if (!qfiles.length) line('（无队列文件）');
for (const f of qfiles) {
  const q = readJson(path.join(QUEUE_DIR, f));
  if (!Array.isArray(q)) { line(`   ${f}: 格式异常`); continue; }
  const by = {};
  for (const e of q) by[e.status] = (by[e.status] || 0) + 1;
  line(`   ${f}: ${q.length} 条 ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' ')}`);
}

// ── 6 最近审计 ───────────────────────────────────────────
line('━━ 最近审计（末 6 条） ━━');
const logFile = path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`);
try {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-6);
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      const t = [j.task, j.action].filter(Boolean).join('/');
      line(`   ${hm(j.at)} [${j.account || '-'}] ${t} ${j.target || j.post || j.statusId || ''} ${j.status || ''} ${(j.note || j.result || '').toString().slice(0, 40)}`);
    } catch { }
  }
} catch { line('（无审计日志）'); }
