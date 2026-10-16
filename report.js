// report.js — 每日人话日报生成器（纯只读）：把审计日志/账本/健康/池子翻译成一页能看懂的日报
// 用法: node report.js [--date 2026-10-15]（默认今天）
// 输出: 日报/YYYY-MM-DD.md + 控制台同屏
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const X = Object.assign({ rollingCaps: { reply: 8, follow: 18, like: 15, unfollow: 5 } }, CFG.executor || {});

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DATE = argOf('date', today());
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const TASK_CN = {
  1: 'Owen帖加持', 2: '社群互关回复', 3: '关注闭环', graph: '图谱点赞',
  contacts: '关系台账采集(只读)', executor: '队列执行器', insights: 'Owen通知研究(只读)',
};

// ── 审计日志 → 人话条目 ──────────────────────────────────
const logFile = path.join(STATE_DIR, `log-${DATE.slice(0, 7)}.jsonl`);
const real = [], sys = [];
try {
  for (const l of fs.readFileSync(logFile, 'utf8').trim().split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j.at || !j.at.startsWith(DATE)) continue;
    const acct = j.account || '-';
    if (j.dry) { sys.push(`${hm(j.at)} [${acct}] (演练) ${TASK_CN[j.task] || j.task} ${j.post || j.target || ''}`); continue; }
    if (j.task === 1) real.push(`${hm(j.at)} [${acct}] ${TASK_CN[1]}：帖 ${String(j.post).slice(-6)} 完成 ${(j.actions || []).join('+')}`);
    else if (j.task === 2) real.push(`${hm(j.at)} [${acct}] ${TASK_CN[2]}：给 @${j.author} 回复「${String(j.text || '').slice(0, 24)}…」${j.unknown ? '（结果未确认，已占额度禁重发）' : ''}`);
    else if (j.task === 3) real.push(`${hm(j.at)} [${acct}] ${j.action === 'followBack' ? '回关' : j.action === 'unfollow' ? '超时取关' : '主动关注'}：@${j.target}${j.verified === false ? '（未确认）' : ''}`);
    else if (j.task === 'graph') real.push(`${hm(j.at)} [${acct}] ${TASK_CN.graph}：@${j.target} 的帖 ${String(j.post).slice(-6)}`);
    else if (j.task === 'contacts') sys.push(`${hm(j.at)} [${acct}] ${TASK_CN.contacts}：${j.action}${j.events ? ' ' + j.events + ' 条事件' : j.pool ? ' 池=' + j.pool : ''}`);
    else if (j.task === 'executor') sys.push(`${hm(j.at)} [${acct}] ${TASK_CN.executor}：${j.action}${j.id ? ' ' + j.id : ''} ${j.status || ''}${j.note ? ' ' + j.note : ''}`);
    else sys.push(`${hm(j.at)} [${acct}] ${TASK_CN[j.task] || j.task} ${j.action || ''} ${j.target || j.post || ''}`);
  }
} catch { /* 当日无日志 */ }

// ── 额度（boost 当日 + 滚动24h 合并） ────────────────────
const rows = [];
for (const acct of CFG.accounts.filter((a) => a.watch !== false)) { // 未授权接入号（watch:false）不进额度表
  const st = readJson(path.join(STATE_DIR, acct.key + '.json'));
  const d = (st && st.daily && st.daily[DATE]) || {};
  const led = readJson(path.join(STATE_DIR, `ledger-${acct.key}.json`)) || { actions: {} };
  const cut = Date.now() - 24 * 3600 * 1000;
  const cnt = (t) => ((led.actions[t] || []).filter((x) => x > cut)).length;
  rows.push(`- ${acct.key}：回复 ${(d.owenReplies || 0) + (d.communityReplies || 0) + cnt('reply')}/${X.rollingCaps.reply} · 关注 ${(d.follows || 0) + cnt('follow')}/${X.rollingCaps.follow} · 点赞 ${(d.likes || 0) + cnt('like')}/${X.rollingCaps.like} · 取关 ${(d.unfollows || 0) + cnt('unfollow')}/${X.rollingCaps.unfollow}`);
}

// ── 健康快照 ─────────────────────────────────────────────
let health = '（今日未检测）';
try {
  const snap = readJson(path.join(STATE_DIR, 'health-snapshots', DATE + '.json'));
  if (snap) {
    const parts = Object.values(snap.accounts || {}).map((e) => {
      const icon = e.verdict === 'green' ? '🟢' : e.verdict === 'suspended' ? '🔴' : '⚪(未知)';
      return `${icon} @${e.handle} ${e.verdict}（粉丝 ${e.profile.followers ?? '?'}，48h 自发 ${e.statuses.ownCount ?? '?'}，敏感 ${e.statuses.sensitiveCount ?? 0}）`;
    });
    if (parts.length) health = parts.join('\n');
  }
} catch { }

// ── 关系池 ───────────────────────────────────────────────
let pools = '';
for (const acct of CFG.accounts) {
  const c = readJson(path.join(STATE_DIR, `contacts-${acct.key}.json`));
  if (!c) continue;
  const ppl = Object.values(c.people || {});
  const by = {};
  for (const e of ppl) by[e.stage] = (by[e.stage] || 0) + 1;
  pools += `- ${acct.key}：${ppl.length} 人（${Object.entries(by).map(([k, v]) => k + ':' + v).join(' ') || '空'}）\n`;
}

// ── 队列 ─────────────────────────────────────────────────
let queues = '';
try {
  for (const f of fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'))) {
    const q = readJson(path.join(QUEUE_DIR, f));
    if (!Array.isArray(q)) continue;
    const by = {};
    for (const e of q) by[e.status] = (by[e.status] || 0) + 1;
    queues += `- ${f}：${q.length} 条（${Object.entries(by).map(([k, v]) => k + ':' + v).join(' ')}）\n`;
  }
} catch { }

const md = `# 运营日报 ${DATE}

## 一、今日在 X 平台真实发生的动作（${real.length} 条）
${real.length ? real.map((x) => '- ' + x).join('\n') : '- 无（今日零真实互动）'}

## 二、系统动作（只读/开发/演练，${sys.length} 条）
${sys.length ? sys.map((x) => '- ' + x).join('\n') : '- 无'}

## 三、额度消耗（今日+滚动24h 合并口径）
${rows.join('\n')}

## 四、账号健康
${health}

## 五、关系池
${pools || '- 未建池'}
## 六、队列
${queues || '- 无队列文件'}

> 生成于 ${new Date().toISOString()}（node report.js）；实时全貌：node status.js；总控看板：运营看板.md
`;
fs.mkdirSync(path.join(ROOT, '日报'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '日报', `${DATE}.md`), md);
console.log(md);
console.log(`已写入 日报/${DATE}.md`);
