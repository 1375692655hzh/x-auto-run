// cloud-posts.js — 云帖定时发布（10-20 拍板：脱离常驻，与互关帖同款调度形态）
// 用法: node cloud-posts.js --account fullwin [--dry]
// 调度: Xops云帖-fullwin 每小时 :50（上游 :40 出文后 10 分钟）
// 流程: content-pull --account 拉取 → 读投递箱 → 当小时额度（白天 8-22 时 ≤2 条 / 夜里 1 条）
//   → 余量写回投递文件下小时继续 → 写队列（postAt=现在+2~8min 间隔）→ 驻留到点 spawn executor --entry
// 独立帽：postCloud ≤50/天（与互关帖 postTopic 分立，10-20 拍板）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const QUEUE_DIR = path.join(ROOT, 'queue');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'fullwin');
const RC = ((CFG.resident || {})[ACCOUNT] || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowIso = () => new Date().toISOString();
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), task: 'cloudPosts', account: ACCOUNT, ...obj }) + '\n'); }
const LEDGER_FILE = path.join(STATE_DIR, `ledger-${ACCOUNT}.json`);
function loadLedger() { const cut = Date.now() - 24 * 3600000; let j = readJson(LEDGER_FILE, { actions: {}, meta: {} }); for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut); return j; }
function ledgerRecord(type) { const j = loadLedger(); (j.actions[type] = j.actions[type] || []).push(Date.now()); fs.writeFileSync(LEDGER_FILE, JSON.stringify(j, null, 2)); }
function usedToday(type) { const cut = new Date(); cut.setHours(0, 0, 0, 0); return (loadLedger().actions[type] || []).filter((ts) => ts > cut.getTime()).length; }
const quota = () => { const h = new Date().getHours(); const [d, e] = [8, 22]; return (h >= d && h < e) ? (RC.cloudDayHourMax != null ? RC.cloudDayHourMax : 2) : (RC.cloudNightHourMax != null ? RC.cloudNightHourMax : 1); };

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效，退出'); process.exit(0); }
  // ① 拉取
  const pull = spawnSync(process.execPath, [path.join(ROOT, 'content-pull.js'), '--account=' + ACCOUNT], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(ROOT, 'x-daily-cert.pem') } });
  if (pull.status !== 0) { audit({ action: 'cloudPull', status: 'failed', note: 'content-pull 非零退出' }); LOG('拉取失败，退出'); process.exit(1); }
  // ② 取额度内条目
  const room = Math.max(0, (RC.postCapDay || 50) - usedToday('postCloud'));
  if (room <= 0) { audit({ action: 'cloudPost', status: 'skipped', note: '云帖帽满(50)' }); process.exit(0); }
  const take = Math.min(quota(), room);
  let queued = 0;
  const entries = [];
  for (const f of fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.startsWith(`pull-${ACCOUNT}-`) && f.endsWith('.json')) : []) {
    const items = readJson(path.join(INBOX, f), []);
    const roomLeft = Math.max(0, take - queued);
    const fileItems = items.slice(0, roomLeft);
    for (const it of fileItems) { entries.push({ text: it.text, quote: it.quote, quoteUrl: it.quoteUrl }); queued++; }
    const rest = items.slice(fileItems.length); // 余量写回，下一小时继续
    if (rest.length) writeJson(path.join(INBOX, f), rest);
    else { try { fs.renameSync(path.join(INBOX, f), path.join(INBOX, f + '.done-' + Date.now())); } catch { } }
    if (queued >= take) break;
  }
  if (!entries.length) { audit({ action: 'cloudPost', status: 'none', note: '投递箱空（上游无新内容或缓存未滴）' }); process.exit(0); }
  LOG(`本小时额度 ${take}，取到 ${entries.length} 条`);

  // ③ 写队列 + 定时拉起（2~8min 间隔）
  const qFile = path.join(QUEUE_DIR, `${today()}-cloud-${ACCOUNT}-${new Date().getHours()}.json`);
  let delayMin = rand(1, 3);
  const queue = entries.map((e, i) => {
    const postAt = Date.now() + delayMin * 60000;
    delayMin += rand(2, 8);
    return { id: `${today()}-cloud-${ACCOUNT}-${new Date().getHours()}-${i + 1}`, account: ACCOUNT, type: 'post', kind: 'cloud-post', text: e.text, quote: e.quote, quoteUrl: e.quoteUrl, window: 'cloud', postAt: new Date(postAt).toISOString(), status: 'planned', createdAt: nowIso() };
  });
  if (DRY) { for (const e of queue) LOG(`[DRY] ${new Date(e.postAt).toTimeString().slice(0, 5)}: ${e.text.slice(0, 50)}…`); process.exit(0); }
  writeJson(qFile, queue);
  audit({ action: 'cloudPost', status: 'queued', count: queue.length });
  for (const e of queue) {
    const delay = Math.max(0, Date.parse(e.postAt) - Date.now());
    LOG(`[定时] ${e.id} → ${new Date(e.postAt).toTimeString().slice(0, 8)}`);
    setTimeout(() => {
      LOG(`到点发布 ${e.id}`);
      spawnSync(process.execPath, [path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', qFile, '--entry', e.id], { cwd: ROOT, stdio: 'inherit' });
      ledgerRecord('post'); ledgerRecord('postCloud');
    }, delay);
  }
  const lastMs = Math.max(...queue.map((e) => Date.parse(e.postAt))) - Date.now() + 5 * 60000;
  setTimeout(() => { LOG('本小时发布完毕，退出'); process.exit(0); }, Math.max(lastMs, 30 * 1000));
})().catch((e) => { console.error('FATAL:', e.message || e); audit({ action: 'cloudPost', status: 'fatal', note: String(e.message || e).slice(0, 100) }); process.exit(1); });
