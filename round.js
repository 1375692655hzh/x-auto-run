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

  const queueFile = path.join(ROOT, 'queue', `${today()}-${WINDOW}-${ACCOUNT}.json`);
  if (!fs.existsSync(queueFile)) {
    console.log('本轮无队列（候选不足或额度已满）');
    log({ action: 'round', window: WINDOW, dry, note: '无队列' });
    if (!dry) { rs.completed += 1; saveRounds(rs); }
    return;
  }
  const execArgs = [path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', queueFile, '--window', WINDOW];
  if (dry) execArgs.push('--dry');
  const okExec = run(execArgs);
  log({ action: 'round', window: WINDOW, dry, plannerOk: okPlan, executorOk: okExec });
  if (okExec) { rs.completed += 1; saveRounds(rs); }
  console.log(`执行窗 ${WINDOW} 结束（${dry ? '演练' : '真实'}）`);
})().catch((e) => { console.error(e); process.exit(1); });
