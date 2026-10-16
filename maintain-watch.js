// maintain-watch.js — 权重维护侦测器（v1.1，方案见 权重维护计划.md）
// 用法: node maintain-watch.js [--dry]（一轮即退出；schtasks Xops维护侦测 白天每 25 分钟拉起）
// 流程: 轮询 FxTwitter 看 targets 新帖 → 挑帖（帖龄45min~3h 黄金窗、每目标每日≤2帖、
//       互吹圈占比>1/3跳过、维护号 ghost/deboost 熔断）→ 每帖 1 个维护号（轮换随机）点赞；
//       butcher 对 Owen 另按 48h 间隔生成 1 条 LLM 回复（过质量门，失败不凑数）
//       → 写独立 queue/maintain-<日期>-<账号>.json → 拉起 executor 消费（绝不碰三窗队列）。
// --dry: 只打印决策不落盘不入队不拉起（测试用，不受 activeHours 限制）。
// 降级: PAUSE 生效退出；比特浏览器不在线时 executor 自行报错记日志，下轮再来；
//       fxtwitter 连续 pollFailStop 轮失败→只记录不排新动作。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { generateReply } = require('./llm');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const M = CFG.maintain || {};
const L = CFG.limits || {};
const DRY = process.argv.includes('--dry');
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), ...obj }) + '\n');
}
// 维护专属台账（v1.1 H2）：对象数组，去重 + per-target/per-号日帽 + 回复间隔判断
const MLED = path.join(STATE_DIR, 'maintain-ledger.json');
const loadMLed = () => readJson(MLED, { actions: [] }).actions || [];
const appendMLed = DRY ? () => { } : (e) => { const j = readJson(MLED, { actions: [] }); j.actions.push({ at: nowIso(), ...e }); writeJson(MLED, j); }; // --dry 绝不写真实台账
// 游标状态（v1.1 M7）：lastSeen/已处理/轮询失败计数/最近成功时间
const MSTATE = path.join(STATE_DIR, 'maintain-state.json');
const loadMSt = () => readJson(MSTATE, { lastSeen: {}, processed: {}, pollFails: 0, lastPollOk: null, lastRun: null });
const saveMSt = (s) => writeJson(MSTATE, s);

// 熔断（v1.1 H4）：只看 ghost/deboost 两维（search 受限不阻断点赞）；快照缺失=放行+记日志
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

// 轮询目标时间线（纯 HTTP 只读）→ 本人原创帖（非回复/非转发/非敏感/计数正常）
async function fetchOwnPosts(handle) {
  try {
    const since = Math.floor((Date.now() - 6 * 3600000) / 1000);
    const r = await fetch(`https://api.fxtwitter.com/2/profile/${handle}/statuses?with_replies=1&since=${since}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const h = handle.toLowerCase();
    return (j.results || [])
      .filter((s) => ((s.author && s.author.screen_name) || '').toLowerCase() === h && !s.reposted_by && !s.replying_to && !s.possibly_sensitive)
      .map((s) => ({
        statusId: String(s.id), text: (s.text || '').slice(0, 600), postAt: (s.created_timestamp || 0) * 1000,
        likes: s.likes ?? null, replies: s.replies ?? null,
      }));
  } catch { return null; }
}

function maintainerCountToday(acctKey) {
  const cut = today();
  return loadMLed().filter((e) => e.account === acctKey && e.at.slice(0, 10) === cut).length;
}
function targetSelectedToday(targetHandle) {
  const cut = today();
  return new Set(loadMLed().filter((e) => e.targetHandle === targetHandle && e.at.slice(0, 10) === cut).map((e) => e.statusId)).size;
}
function lastReplyAt(acctKey, targetHandle) {
  const es = loadMLed().filter((e) => e.account === acctKey && e.action === 'reply' && e.targetHandle === targetHandle);
  return es.length ? Date.parse(es[es.length - 1].at) : 0;
}

// 单账号入队并拉起 executor（detached，不阻塞；账号锁由 executor 自己把持）
function enqueueAndRun(acct, entries) {
  if (DRY) { LOG(`[DRY] 应入队 ${entries.length} 条（未落盘未拉起）`); return; }
  const file = path.join(QUEUE_DIR, `maintain-${today()}-${acct}.json`);
  const q = readJson(file, []).concat(entries);
  writeJson(file, q);
  audit({ task: 'maintainWatch', action: 'enqueue', account: acct, count: entries.length, queue: path.basename(file) });
  // 保护区（统计规范 v1.1 C5/8）：三执行窗 ±30min + 09:25-09:55 关系池扫描段——区内只入队，延迟到保护区结束再拉起 executor（防账号锁/双开窗冲突）
  const ZONES = [['09:25', '09:55'], ['10:10', '10:40'], ['15:10', '15:40'], ['20:10', '20:40']];
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const inZone = ZONES.find((z) => {
    const [a, b] = [z[0].split(':').map(Number), z[1].split(':').map(Number)];
    return nowMin >= a[0] * 60 + a[1] && nowMin < b[0] * 60 + b[1];
  });
  const spawnNow = () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'executor.js'), '--account', acct, '--queue', file], { detached: true, stdio: 'ignore', cwd: ROOT });
    child.unref();
    LOG(`已入队 ${entries.length} 条 → executor 后台消费（${path.basename(file)}）`);
  };
  if (inZone) {
    const [h, m] = inZone[1].split(':').map(Number);
    const delay = ((h * 60 + m) - nowMin) * 60000 - (Date.now() % 60000); // 到保护区结束整分
    LOG(`处于保护区 ${inZone[0]}-${inZone[1]}，${Math.round(delay / 60000)} 分钟后自动拉起 executor`);
    setTimeout(spawnNow, Math.max(0, delay));
  } else spawnNow();
}

// 雷达复测 flag（统计规范 v1.1）：熔断/可见率异常时写入 state/radar-reprobe.flag，侦测器消费（同号 2h 去抖）
const RFLAG = path.join(STATE_DIR, 'radar-reprobe.flag');
function consumeReprobeFlag() {
  if (DRY) return;
  const flag = readJson(RFLAG, null);
  if (!flag || !flag.handle) return;
  const last = (loadMSt().reprobeAt || {})[flag.handle] || 0;
  if (Date.now() - last < 2 * 3600000) return; // 去抖：同号 2h 一次
  const st = loadMSt(); st.reprobeAt = st.reprobeAt || {}; st.reprobeAt[flag.handle] = Date.now(); saveMSt(st);
  try { fs.unlinkSync(RFLAG); } catch { }
  audit({ task: 'maintainWatch', action: 'radarReprobe', handle: flag.handle, note: flag.note || '' });
  const child = spawn(process.execPath, [path.join(ROOT, 'radar.js'), '--check', '--handles=' + flag.handle], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref();
  LOG(`雷达复测 flag 消费：@${flag.handle}（${flag.note || '熔断'}）`);
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); process.exit(0); }
  if (!M.enabled) { console.error('maintain.enabled=false，退出'); process.exit(0); }
  const hour = new Date().getHours();
  if (!DRY && (hour < (L.activeHours || [9, 22])[0] || hour >= (L.activeHours || [9, 22])[1])) { LOG('不在 9-22 活动窗，本轮退出'); process.exit(0); }
  consumeReprobeFlag();

  const st = loadMSt();
  st.lastRun = nowIso();
  const acctByKey = Object.fromEntries(CFG.accounts.map((a) => [a.key, a]));
  const perAcct = {}; // acct -> entries[]
  let notes = [];

  let pollOkAll = true;
  for (const tKey of M.targets || []) {
    const tAcct = acctByKey[tKey];
    if (!tAcct) continue;
    const posts = await fetchOwnPosts(tAcct.handle);
    if (posts == null) { pollOkAll = false; notes.push(`@${tAcct.handle} 轮询失败`); continue; }
    st.lastSeen[tKey] = posts.length ? posts[0].statusId : st.lastSeen[tKey];

    // 候选：黄金窗内 + 计数正常（v1.1 L2：数据异常帖跳过）
    const now = Date.now();
    const cands = posts.filter((p) => {
      const ageMin = (now - p.postAt) / 60000;
      return p.postAt && ageMin >= (M.goldenMinMin || 45) && ageMin <= (M.goldenMaxMin || 180) && p.likes != null && p.replies != null;
    }).sort((a, b) => ((b.likes + b.replies) - (a.likes + a.replies)));

    if (targetSelectedToday(tAcct.handle) >= (M.postsPerTargetPerDay || 2)) { notes.push(`@${tAcct.handle} 今日已选满${M.postsPerTargetPerDay}帖`); continue; }
    for (const p of cands) {
      if (targetSelectedToday(tAcct.handle) >= (M.postsPerTargetPerDay || 2)) break;
      const already = loadMLed().some((e) => e.statusId === p.statusId);
      if (already) continue;
      const natural = (p.likes || 0) + (p.replies || 0);
      if (1 / Math.max(natural, 1) > (M.dominanceRatio || 0.34)) { notes.push(`帖${p.statusId.slice(-6)} 自然互动${natural}，维护会超1/3，跳过`); continue; }
      // 选维护号：目标在名单内 + 单号日帽 + ghost/deboost 熔断（被熔断的号写复测 flag）
      const radarBlocked = [];
      const eligible = Object.entries(M.maintainers || {})
        .filter(([k, cfgm]) => (cfgm.targets || []).includes(tKey) && acctByKey[k])
        .map(([k]) => k)
        .filter((k) => {
          if (maintainerCountToday(k) >= (M.perMaintainerDailyCap || 3)) return false;
          const ro = radarOk(acctByKey[k].handle);
          if (!ro.ok) radarBlocked.push({ handle: acctByKey[k].handle, why: ro.why });
          return ro.ok;
        });
      if (radarBlocked.length && !DRY) writeJson(RFLAG, { handle: radarBlocked[0].handle, at: nowIso(), note: '维护熔断: ' + radarBlocked[0].why });
      if (!eligible.length) { notes.push(`帖${p.statusId.slice(-6)} 无可用维护号（日帽或熔断）`); continue; }
      const by = eligible[Math.floor(Math.random() * eligible.length)];
      const mCfg = M.maintainers[by];
      const remainMin = Math.max(5, Math.round((M.goldenMaxMin || 180) - (now - p.postAt) / 60000));
      const base = { kind: 'maintain', statusId: p.statusId, postUrl: `https://x.com/${tAcct.handle}/status/${p.statusId}`, targetHandle: tAcct.handle, postAt: p.postAt, createdAt: nowIso(), ttlMin: remainMin, status: 'planned' };
      perAcct[by] = perAcct[by] || [];
      let idSeq = perAcct[by].length;
      perAcct[by].push({ id: `m-${today()}-${by}-${++idSeq}`, type: 'like', ...base });
      appendMLed({ account: by, action: 'like', statusId: p.statusId, targetHandle: tAcct.handle });
      // butcher 对 Owen 的低频回复（48h 间隔；LLM+质量门，失败不凑数）
      if (by === 'butcher' && (mCfg.actions || []).includes('reply') && Date.now() - lastReplyAt('butcher', tAcct.handle) > (M.replyMinGapHours || 48) * 3600000 && natural >= 5) {
        const persona = (CFG.personas || {}).butcher;
        const brief = ((CFG.prompts || {}).visit || '') + '\n这是权重维护场景：对被维护账号的新帖做一条真诚、有信息量的回应。';
        const r = await generateReply({ post: p.text, author: tAcct.handle, persona, brief }).catch(() => null);
        const qc = r && r.text ? quality.check(r.text, {}) : null;
        if (qc && qc.ok) {
          perAcct[by].push({ id: `m-${today()}-${by}-${++idSeq}`, type: 'reply', text: qc.cleaned, ...base });
          appendMLed({ account: by, action: 'reply', statusId: p.statusId, targetHandle: tAcct.handle });
        } else {
          notes.push(`帖${p.statusId.slice(-6)} 回复生成未过质量门(${qc ? qc.reason : 'LLM失败'})，只点赞`);
        }
      }
      notes.push(`帖${p.statusId.slice(-6)} → @${acctByKey[by].handle} 点赞${perAcct[by].some((x) => x.type === 'reply') ? '+回复' : ''}（自然互动${natural}）`);
      st.processed[p.statusId] = nowIso();
    }
  }
  st.pollFails = pollOkAll ? 0 : (st.pollFails || 0) + 1;
  st.lastPollOk = pollOkAll ? nowIso() : st.lastPollOk;
  // 清理 7 天前的 processed 游标
  const cut7 = Date.now() - 7 * 86400000;
  for (const [sid, at] of Object.entries(st.processed)) if (Date.parse(at) < cut7) delete st.processed[sid];
  if (!DRY) saveMSt(st);

  if (st.pollFails >= (M.pollFailStop || 5)) {
    notes.push(`连续 ${st.pollFails} 轮轮询失败，本轮不排新动作`);
    audit({ task: 'maintainWatch', action: 'poll', note: notes.join('；') });
    console.log(notes.join('\n')); process.exit(0);
  }
  for (const [acct, entries] of Object.entries(perAcct)) enqueueAndRun(acct, entries);
  audit({ task: 'maintainWatch', action: 'poll', note: notes.join('；') || '无候选帖' });
  console.log(notes.length ? notes.join('\n') : '无候选帖（黄金窗内无新帖或全部被规则跳过）');
  if (DRY) console.log('[DRY] 以上为决策预览：未写台账/未入队/未拉起 executor');
  if (!DRY && pollOkAll) await sleep(500);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
