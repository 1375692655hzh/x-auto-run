// round.js — 执行窗编排器：planner（选帖/选人/回关采集→LLM→队列）→ executor（消费队列）
// 用法: node round.js --account butcher --window am|mid|pm
// 灰度门：state/rounds-state.json 的 completed < config.rounds.dryRounds 时，本轮 executor 走 --dry（全流程演练不点击）。
// 说明：planner 的浏览器扫描是真做的（验证选帖/扫描路径），dry 只关闭 executor 的点击与输入。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'butcher');
const WINDOW = argOf('window', 'am');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const RS_FILE = path.join(STATE_DIR, 'rounds-state.json');
function loadRounds() { try { return JSON.parse(fs.readFileSync(RS_FILE, 'utf8')); } catch { return { completed: 0 }; } }
function saveRounds(r) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(RS_FILE, JSON.stringify(r, null, 2)); }
function log(line) {
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'round', account: ACCOUNT, ...line }) + '\n');
}

const run = (args, opts = {}) => {
  console.log(`\n===== ${args.join(' ')} =====`);
  const r = spawnSync(process.execPath, args.map((a) => a.replace(/^node\s+/, '')), { cwd: ROOT, stdio: 'inherit', ...opts });
  return r.status === 0;
};

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('state/PAUSE 急停生效中，本轮跳过'); process.exit(0); }
  // 三窗健康门（统计规范 v1.1 待办①，保守档）：当日健康快照 suspended/敏感标记 → 停窗；unknown/缺快照 → 照常（检测失败≠异常铁律）
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'health-snapshots', `${today()}.json`), 'utf8'));
    const e = snap.accounts && snap.accounts[ACCOUNT];
    const suspended = e && ((e.verdict === 'suspended') || (e.profile && e.profile.state === 'suspended'));
    const sensitive = e && e.statuses && (e.statuses.sensitiveCount || 0) > 0;
    if (suspended || sensitive) {
      console.error(`健康门：停窗（${suspended ? '账号 suspended' : '敏感标记>0'}）`);
      log({ action: 'healthGate', window: WINDOW, note: '停窗: ' + (suspended ? 'suspended' : '敏感标记') });
      process.exit(0);
    }
    console.log('健康门：通过');
  } catch { console.log('健康门：当日无快照，照常执行（unknown≠异常）'); }
  const rs = loadRounds();
  const dry = rs.completed < (CFG.rounds.dryRounds || 0);
  // 窗口模式（10-18 四窗拍板）：互关窗(8:30/13/16/20)=community+条件回关；串门发布窗(10:30/20:30)=visit+post——从 config.rounds.windows[WINDOW].modes 读取
  const WCFG = ((CFG.rounds || {}).windows || {})[WINDOW] || {};
  const MODES = argOf('modes', WCFG.modes || 'all');
  console.log(`执行窗 ${WINDOW} 开始（${WCFG.time || '?'}，模式: ${MODES}，第 ${rs.completed + 1} 轮，${dry ? '演练模式' : '真实执行模式'}）`);

  // 发布窗内置拉取（10-18 拍板：p1/p2/p3 与云端生成完成时刻 09:35/12:35/19:35 对齐——窗内先拉后滴灌，planner 再拾取发布）
  if (MODES.includes('pull')) {
    run([path.join(ROOT, 'content-pull.js')], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(ROOT, 'x-daily-cert.pem') } });
  }
  const okPlan = run([path.join(ROOT, 'planner.js'), '--account', ACCOUNT, '--mode', MODES, '--window', WINDOW]);
  if (!okPlan) log({ action: 'round', window: WINDOW, note: 'planner 失败' });

  // 固定窗权重维护（10-19 拍板：不随帖，固定进运营窗）：条目直接追加进本窗队列，executor 同会话消费
  if (MODES.includes('maintain')) {
    run([path.join(ROOT, 'maintain-fixed.js'), '--account', ACCOUNT, '--window', WINDOW]);
  }

  const queueFile = path.join(ROOT, 'queue', `${today()}-${WINDOW}-${ACCOUNT}.json`);
  if (!fs.existsSync(queueFile)) {
    console.log('本轮无队列（候选不足或额度已满）');
    log({ action: 'round', window: WINDOW, dry, note: '无队列' });
    if (!dry) { rs.completed += 1; saveRounds(rs); }
    return;
  }

  // 定时发布（10-18 拍板）：post 条目带 postAt 精确时刻（间隔 1~10min 随机）——到点逐条单独拉起 executor --entry
  // 普通会话只跑非 post 条目（串门等）；post 未到点由 executor 自动跳过，这里再逐条设到点定时器
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const posts = (Array.isArray(queue) ? queue : []).filter((e) => e && e.type === 'post' && e.status === 'planned' && e.postAt);
  if (posts.length && !dry) {
    for (const p of posts) {
      const delay = Math.max(0, Date.parse(p.postAt) - Date.now());
      console.log(`[定时发布] ${p.id} → ${new Date(p.postAt).toLocaleTimeString('zh-CN')}（${Math.round(delay / 60000)} 分钟后）`);
      setTimeout(() => {
        console.log(`\n===== 定时发布 ${p.id} =====`);
        const r = spawnSync(process.execPath, [path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', queueFile, '--entry', p.id], { cwd: ROOT, stdio: 'inherit' });
        log({ action: 'scheduledPost', window: WINDOW, id: p.id, ok: r.status === 0 });
      }, delay);
    }
  }

  const execArgs = [path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', queueFile, '--window', WINDOW];
  if (dry) execArgs.push('--dry');
  const okExec = run(execArgs);
  log({ action: 'round', window: WINDOW, dry, plannerOk: okPlan, executorOk: okExec, scheduledPosts: posts.length });
  if (okExec) { rs.completed += 1; saveRounds(rs); }
  console.log(`执行窗 ${WINDOW} 结束（${dry ? '演练' : '真实'}${posts.length ? `；${posts.length} 条定时帖待发（进程驻留到点拉起）` : ''}）`);

  // ── 交付必达（2026-10-20 用户拍板）：队列跑不完绝不收工 ──
  // ①补跑节：主会话收口后仍有 planned（死线截断/瞬态翻回/核验翻回）→ 15 分钟后续跑同一队列，直到跑空或 21:45 收口线（activeHours 22 点收）
  // ②unknown 核验：会话产出 unknown → 30 分钟后 verify-unknown.js 匿名核验，未发出的翻回 planned 并立即续评估补跑
  // 唯一刹车：风控 toast 当日锁（executor 写 ledger.meta.abortedToday）与 PAUSE 文件
  const ledgerFile = path.join(STATE_DIR, `ledger-${ACCOUNT}.json`);
  const abortedToday = () => { try { return (JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).meta || {}).abortedToday === today(); } catch { return false; } };
  const queueNow = () => { try { const q = JSON.parse(fs.readFileSync(queueFile, 'utf8')); return Array.isArray(q) ? q : []; } catch { return []; } };
  const pendingWork = () => queueNow().filter((e) => e && e.status === 'planned' && !(e.type === 'post' && e.postAt && Date.parse(e.postAt) > Date.now())).length; // 未到点帖有 round 定时器兜底，不算欠账
  const hasUnknown = () => queueNow().some((e) => e && e.status === 'unknown');
  let catchRound = 0, catchScheduled = false, verifyScheduled = false;
  const cutoffReached = () => { const c = new Date(); c.setHours(21, 45, 0, 0); return Date.now() > c.getTime(); };
  const scheduleCatchup = (delayMin, why) => {
    if (catchScheduled || catchRound >= 8) return;
    if (cutoffReached()) { console.log('[补跑] 已过 21:45 收口线，剩余 planned 留档（不窗外执行）'); log({ action: 'catchupStop', note: '过21:45收口线' }); return; }
    if (abortedToday()) { console.log('[补跑] 风控刹车当日生效，不再补跑'); log({ action: 'catchupStop', note: '风控刹车' }); return; }
    catchScheduled = true; catchRound += 1;
    const n = catchRound;
    console.log(`[补跑] 第 ${n} 节 ${delayMin} 分钟后拉起（${why}）`);
    setTimeout(() => {
      catchScheduled = false;
      if (abortedToday()) { log({ action: 'catchupStop', note: '风控刹车' }); return; }
      const left = pendingWork();
      if (!left) { console.log('[补跑] 队列已空，收工'); log({ action: 'catchupStop', note: '队列已空' }); return; }
      console.log(`\n===== 补跑节 #${n}（剩 ${left} 条 planned） =====`);
      run([path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', queueFile, '--window', WINDOW]);
      log({ action: 'catchup', round: n, leftBefore: left, leftAfter: pendingWork() });
      armFollowups(); // 续评估：还没跑完就再排下一节
    }, delayMin * 60000);
  };
  const scheduleVerify = () => {
    if (verifyScheduled || !hasUnknown()) return;
    if (abortedToday()) return;
    verifyScheduled = true;
    console.log('[核验] 30 分钟后对 unknown 条目做匿名核验（FxTwitter 只读，零暴露）');
    setTimeout(() => {
      verifyScheduled = false;
      if (abortedToday()) { log({ action: 'verifySkip', note: '风控刹车' }); return; }
      if (!hasUnknown()) return;
      console.log('\n===== unknown 自动核验 =====');
      run([path.join(ROOT, 'verify-unknown.js'), '--account', ACCOUNT, '--queue', queueFile]);
      log({ action: 'verifyUnknown', pendingAfter: pendingWork() });
      armFollowups(); // 核验翻回的条目立即续评估
    }, 30 * 60000);
  };
  function armFollowups() {
    const left = pendingWork();
    if (left > 0) scheduleCatchup(15, `剩 ${left} 条 planned`);
    if (hasUnknown()) scheduleVerify();
  }
  if (!dry) armFollowups();
})().catch((e) => { console.error(e); process.exit(1); });
