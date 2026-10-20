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
      .map((s) => ({ statusId: String(s.id), text: (s.text || '').slice(0, 600), postAt: (s.created_timestamp || 0) * 1000, likes: s.likes ?? null, replies: s.replies ?? null, hasMedia: !!(((s.media || {}).photos || []).length + ((s.media || {}).videos || []).length + ((s.media || {}).all || []).length) }));
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

  // 保险丝=3N（10-20 用户拍板：N=维护者数目，概率管量、硬帽只削运气波峰；矩阵增减号自动跟随）
  const N_MAINTAINERS = Object.keys(M.maintainers || {}).length || 1;
  const FUSE = (M.capFuseMultiplier != null ? M.capFuseMultiplier : 3) * N_MAINTAINERS;
  const capLeft = () => FUSE - loadMLed().filter((e) => e.account === ACCOUNT && e.at.slice(0, 10) === today()).length;
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
    // 同帖上限=全圈 ≤2 号（10-20 拍板放开：原"一帖只一号"掐死小号评论量；≤2 防 4 号围攻同帖的
    // engagement pod 观感，完全放开只需调 config maintain.perPostRingCap）
    const ringCap = M.perPostRingCap != null ? M.perPostRingCap : 2;
    const cands = posts.filter((p) => {
      const ageMin = (now - p.postAt) / 60000;
      return p.postAt && ageMin >= 20 && ageMin <= 14 * 60 && p.likes != null && p.replies != null;
    }).filter((p) => loadMLed().filter((e) => e.statusId === p.statusId).length < ringCap)
      .sort((a, b) => ((b.likes + b.replies) - (a.likes + a.replies)));
    // 每目标每日帖数=按维护号分账（10-20 拍板"按推荐跑"： butcher/wcixot 各自 2 帖/目标/天，
    // 不再跨号共享挤占——p2 窗 wcixot 先跑曾会把 butcher 挤到无帖可维护）；
    // 同帖去重仍是全局的（下方 statusId 过滤不分号）：一帖只被一个号互动，防多号围攻协同画像（v1.1 M3 保留）
    const selectedToday = new Set(loadMLed().filter((e) => e.account === ACCOUNT && e.targetHandle === tAcct.handle && e.at.slice(0, 10) === today()).map((e) => e.statusId)).size;
    if (selectedToday >= (M.postsPerTargetPerDay || 2)) { notes.push(`@${tAcct.handle} 今日已维护满${M.postsPerTargetPerDay}帖（本号额度）`); continue; }
    // 目标侧保险丝同为 3N（10-20 拍板：单账号[收端]可见动作上限=维护者数目×3；期望 9.1 正常碰不到，只削波峰）
    const targetActionsToday = loadMLed().filter((e) => e.targetHandle === tAcct.handle && e.at.slice(0, 10) === today()).length;
    if (targetActionsToday >= FUSE) { notes.push(`@${tAcct.handle} 今日收圈内维护 ${targetActionsToday} 次达保险丝(${FUSE})，本号跳过`); continue; }
    if (!cands.length) { notes.push(`@${tAcct.handle} 无新候选帖`); continue; }
    const p = cands[0]; // 每窗每目标 1 帖：p2+p3 两窗凑满 postsPerTargetPerDay
    // 10-20 用户终版拍板：概率管量（点赞 0.8 / 回复 1/3 独立掷骰），无自然互动门槛、无互吹圈占比、
    // 无硬日帽（3N 保险丝除外）；两骰皆未中=本窗跳过该目标；LLM+质量门失败降级，不重掷
    const base = { kind: 'maintain', fixed: true, statusId: p.statusId, postUrl: `https://x.com/${tAcct.handle}/status/${p.statusId}`, targetHandle: tAcct.handle, postAt: p.postAt, createdAt: nowIso(), status: 'planned', window: WINDOW };
    const rollLike = Math.random() < (M.likeProbability != null ? M.likeProbability : 0.8);
    const rollReply = (mCfg.actions || []).includes('reply') && Math.random() < (M.replyProbability != null ? M.replyProbability : 0.3333);
    // 10-20 用户拍板"没有图片才回复帖子"：回复骰中但帖带图/视频 → 降级不回复不重掷（点赞照常；看不到图的回复必违和）
    const skipMediaReply = rollReply && (CFG.limits || {}).skipMediaReplies !== false && p.hasMedia;
    let did = [];
    if (rollLike) {
      entries.push({ id: nextId(entries.length + 1), account: ACCOUNT, type: 'like', ...base });
      appendMLed({ account: ACCOUNT, action: 'like', statusId: p.statusId, targetHandle: tAcct.handle, window: WINDOW });
      did.push('点赞');
    }
    if (skipMediaReply) notes.push(`帖${p.statusId.slice(-6)} 带图帖不回复（10-20 拍板），降级处理不重掷`);
    else if (rollReply) {
      const persona = (CFG.personas || {})[ACCOUNT];
      const brief = ((CFG.prompts || {}).visit || '') + '\n这是权重维护场景：对被维护账号的新帖做一条真诚、有信息量的回应。';
      const r = await generateReply({ post: p.text, author: tAcct.handle, persona, brief }).catch(() => null);
      const qc = r && r.text ? quality.check(r.text, {}) : null;
      if (qc && qc.ok) {
        entries.push({ id: nextId(entries.length + 1), account: ACCOUNT, type: 'reply', text: qc.cleaned, ...base });
        appendMLed({ account: ACCOUNT, action: 'reply', statusId: p.statusId, targetHandle: tAcct.handle, window: WINDOW });
        did.push('回复');
      } else notes.push(`帖${p.statusId.slice(-6)} 回复生成未过质量门(${qc ? qc.reason : 'LLM失败'})`);
    }
    notes.push(did.length ? `帖${p.statusId.slice(-6)} → ${ACCOUNT} ${did.join('+')}（帖龄${Math.round((now - p.postAt) / 60000)}min）` : `帖${p.statusId.slice(-6)} 两骰皆未中(赞0.8/回1/3)，本窗跳过`);
  }

  if (!entries.length) { audit({ account: ACCOUNT, window: WINDOW, action: 'none', note: notes.join('；') || '无候选' }); console.log(notes.join('\n') || '无候选帖'); process.exit(0); }
  if (DRY) { console.log('[DRY] 应前插进运营窗队列：'); entries.forEach((e) => console.log(' ', e.id, e.type, e.targetHandle)); process.exit(0); }

  // 前插进当轮运营窗队列（同会话 executor 按文件顺序消费，维护点赞是快动作，确保在 25min 死线内执行）
  writeJson(qFile, entries.concat(q));
  audit({ account: ACCOUNT, window: WINDOW, action: 'enqueue', count: entries.length, queue: path.basename(qFile), note: notes.join('；') });
  console.log(notes.join('\n'));
  console.log(`已前插 ${entries.length} 条维护条目 → ${path.basename(qFile)}（本轮 executor 优先消费）`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
