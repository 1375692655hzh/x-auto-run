// maintain-fixed.js — 固定窗权重维护（10-19 拍板：butcher→owen 不随帖侦测，固定进 12:35/19:35 运营窗，早上不做）
// 用法: node maintain-fixed.js --account butcher --window p2 [--dry]
// 与 maintain-watch 的差异：不做黄金 45-180min 窗口限制（固定窗撞不上），改为"自上次运行以来的新帖，帖龄 20min~14h"；
//       每窗每目标最多 1 帖（postsPerTargetPerDay=2 由 p2+p3 两窗凑满）；互吹圈占比/雷达熔断/台账去重规则不变。
// 产出: 条目直接追加进当轮运营窗队列（queue/<日期>-<窗>-<账号>.json），由本轮 executor 同会话消费——一次开窗全做完。
const fs = require('fs');
const path = require('path');
const { generateReply } = require('./llm');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const M = CFG.maintain || {};
const DRY = process.argv.includes('--dry');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'butcher');
const WINDOW = argOf('window', 'p2');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowIso = () => new Date().toISOString();
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), task: 'maintainFixed', ...obj }) + '\n');
}
// 与 maintain-watch 共用同一份台账（去重 + 日帽 + 回复间隔全靠它）
const MLED = path.join(STATE_DIR, 'maintain-ledger.json');
const loadMLed = () => readJson(MLED, { actions: [] }).actions || [];
const appendMLed = DRY ? () => { } : (e) => { const j = readJson(MLED, { actions: [] }); j.actions.push({ at: nowIso(), ...e }); writeJson(MLED, j); };

// 熔断口径与 maintain-watch 一致：只看 ghost/deboost；快照缺失=放行
function radarOk(handle) {
  for (const d of [today(), new Date(Date.now() - 86400000).toISOString().slice(0, 10)]) {
    const snap = readJson(path.join(STATE_DIR, 'health-snapshots', `${d}.json`), null);
    const four = snap && snap.radar && snap.radar.results && snap.radar.results[handle] && snap.radar.results[handle].four;
    if (!four) continue;
    const bad = ['ghost', 'deboost'].filter((k) => four[k] && !/未见/.test(four[k]));
    if (bad.length) return { ok: false, why: `${bad.join('+')} 已检测到(${d})` };
    return { ok: true };
  }
  return { ok: true, why: '无雷达快照（放行）' };
}

async function fetchOwnPosts(handle) {
  try {
    const since = Math.floor((Date.now() - 14 * 3600000) / 1000); // 覆盖自上一运营窗以来的帖（p3 距 p2 约 7h，留余量）
    const r = await fetch(`https://api.fxtwitter.com/2/profile/${handle}/statuses?with_replies=1&since=${since}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const h = handle.toLowerCase();
    return (j.results || [])
      .filter((s) => ((s.author && s.author.screen_name) || '').toLowerCase() === h && !s.reposted_by && !s.replying_to && !s.possibly_sensitive)
      .map((s) => ({ statusId: String(s.id), text: (s.text || '').slice(0, 600), postAt: (s.created_timestamp || 0) * 1000, likes: s.likes ?? null, replies: s.replies ?? null }));
  } catch { return null; }
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); process.exit(0); }
  const mCfg = (M.maintainers || {})[ACCOUNT];
  if (!mCfg || !mCfg.fixed) { console.error(`${ACCOUNT} 无 fixed 配置（不是固定窗维护号），退出`); process.exit(0); }
  const windows = String(mCfg.fixed).split(',').map((s) => s.trim());
  if (!windows.includes(WINDOW)) { console.error(`${WINDOW} 不在 ${ACCOUNT} 的固定维护窗 [${windows.join(',')}] 内，退出（早上不做是拍板）`); process.exit(0); }
  const acctByKey = Object.fromEntries(CFG.accounts.map((a) => [a.key, a]));
  const me = acctByKey[ACCOUNT];
  if (!me) { console.error('config.accounts 无此账号'); process.exit(1); }

  // 队列文件先读：id 基数取现有长度（防同窗重跑撞 id——review P1-1）；条目前插（review P0-1：尾插在
  // 25min 会话死线下轮不到维护条目，且台账已预扣当天不可补——前插保证点赞类快动作先执行）
  const qFile = path.join(QUEUE_DIR, `${today()}-${WINDOW}-${ACCOUNT}.json`);
  const q = readJson(qFile, []);
  const qLen = Array.isArray(q) ? q.length : 0;
  const nextId = (n) => `${today()}-${WINDOW}-maint-${qLen + n}`;

  // 维护号自身熔断 + 日帽（帽在目标循环内逐次复查——review P2-7：like+reply 各扣 1，两目标可越帽）
  const capLeft = () => (M.perMaintainerDailyCap || 3) - loadMLed().filter((e) => e.account === ACCOUNT && e.at.slice(0, 10) === today()).length;
  const ro = radarOk(me.handle);
  if (!ro.ok) { audit({ account: ACCOUNT, window: WINDOW, action: 'skip', note: '维护号熔断: ' + ro.why }); console.error('维护号熔断: ' + ro.why); process.exit(0); }

  const entries = [];
  const notes = [];
  for (const tKey of mCfg.targets || []) {
    if (capLeft() <= 0) { notes.push('维护号日帽已满，后续目标不做'); break; }
    const tAcct = acctByKey[tKey];
    if (!tAcct) continue;
    const posts = await fetchOwnPosts(tAcct.handle);
    if (posts == null) { notes.push(`@${tAcct.handle} 轮询失败`); continue; }
    // 固定窗候选：帖龄 20min~14h + 计数正常 + 今日该目标未选满
    const now = Date.now();
    const cands = posts.filter((p) => {
      const ageMin = (now - p.postAt) / 60000;
      return p.postAt && ageMin >= 20 && ageMin <= 14 * 60 && p.likes != null && p.replies != null;
    }).filter((p) => !loadMLed().some((e) => e.statusId === p.statusId))
      .sort((a, b) => ((b.likes + b.replies) - (a.likes + a.replies)));
    const selectedToday = new Set(loadMLed().filter((e) => e.targetHandle === tAcct.handle && e.at.slice(0, 10) === today()).map((e) => e.statusId)).size;
    if (selectedToday >= (M.postsPerTargetPerDay || 2)) { notes.push(`@${tAcct.handle} 今日已维护满${M.postsPerTargetPerDay}帖`); continue; }
    if (!cands.length) { notes.push(`@${tAcct.handle} 无新候选帖`); continue; }
    const p = cands[0]; // 每窗每目标 1 帖：p2+p3 两窗凑满 postsPerTargetPerDay
    const natural = (p.likes || 0) + (p.replies || 0);
    if (1 / Math.max(natural, 1) > (M.dominanceRatio || 0.34)) { notes.push(`帖${p.statusId.slice(-6)} 自然互动${natural}，维护会超1/3，跳过`); continue; }
    const base = { kind: 'maintain', fixed: true, statusId: p.statusId, postUrl: `https://x.com/${tAcct.handle}/status/${p.statusId}`, targetHandle: tAcct.handle, postAt: p.postAt, createdAt: nowIso(), status: 'planned', window: WINDOW };
    entries.push({ id: nextId(entries.length + 1), account: ACCOUNT, type: 'like', ...base });
    appendMLed({ account: ACCOUNT, action: 'like', statusId: p.statusId, targetHandle: tAcct.handle, window: WINDOW });
    let hasReply = false; // 逐目标标志（review P2-8：全数组 some 会把别的目标的回复算进来）
    // 低频回复规则不变：48h 间隔 + 自然互动≥5，LLM+质量门失败不凑数
    const lastReply = loadMLed().filter((e) => e.account === ACCOUNT && e.action === 'reply' && e.targetHandle === tAcct.handle);
    if (capLeft() > 0 && (mCfg.actions || []).includes('reply') && Date.now() - (lastReply.length ? Date.parse(lastReply[lastReply.length - 1].at) : 0) > (M.replyMinGapHours || 48) * 3600000 && natural >= 5) {
      const persona = (CFG.personas || {})[ACCOUNT];
      const brief = ((CFG.prompts || {}).visit || '') + '\n这是权重维护场景：对被维护账号的新帖做一条真诚、有信息量的回应。';
      const r = await generateReply({ post: p.text, author: tAcct.handle, persona, brief }).catch(() => null);
      const qc = r && r.text ? quality.check(r.text, {}) : null;
      if (qc && qc.ok) {
        entries.push({ id: nextId(entries.length + 1), account: ACCOUNT, type: 'reply', text: qc.cleaned, ...base });
        appendMLed({ account: ACCOUNT, action: 'reply', statusId: p.statusId, targetHandle: tAcct.handle, window: WINDOW });
        hasReply = true;
      } else notes.push(`帖${p.statusId.slice(-6)} 回复生成未过质量门(${qc ? qc.reason : 'LLM失败'})，只点赞`);
    }
    notes.push(`帖${p.statusId.slice(-6)} → ${ACCOUNT} 点赞${hasReply ? '+回复' : ''}（自然互动${natural}，帖龄${Math.round((now - p.postAt) / 60000)}min）`);
  }

  if (!entries.length) { audit({ account: ACCOUNT, window: WINDOW, action: 'none', note: notes.join('；') || '无候选' }); console.log(notes.join('\n') || '无候选帖'); process.exit(0); }
  if (DRY) { console.log('[DRY] 应前插进运营窗队列：'); entries.forEach((e) => console.log(' ', e.id, e.type, e.targetHandle)); process.exit(0); }

  // 前插进当轮运营窗队列（同会话 executor 按文件顺序消费，维护点赞是快动作，确保在 25min 死线内执行）
  writeJson(qFile, entries.concat(q));
  audit({ account: ACCOUNT, window: WINDOW, action: 'enqueue', count: entries.length, queue: path.basename(qFile), note: notes.join('；') });
  console.log(notes.join('\n'));
  console.log(`已前插 ${entries.length} 条维护条目 → ${path.basename(qFile)}（本轮 executor 优先消费）`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
