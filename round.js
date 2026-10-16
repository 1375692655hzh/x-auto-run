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

const run = (args) => {
  console.log(`\n===== ${args.join(' ')} =====`);
  const r = spawnSync(process.execPath, args.map((a) => a.replace(/^node\s+/, '')), { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
};

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('state/PAUSE 急停生效中，本轮跳过'); process.exit(0); }
  const rs = loadRounds();
  const dry = rs.completed < (CFG.rounds.dryRounds || 0);
  console.log(`执行窗 ${WINDOW} 开始（第 ${rs.completed + 1} 轮，${dry ? '演练模式：扫描/生成/队列全真，点击关闭' : '真实执行模式'}）`);

  const okPlan = run([path.join(ROOT, 'planner.js'), '--account', ACCOUNT, '--mode', 'all', '--window', WINDOW]);
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
