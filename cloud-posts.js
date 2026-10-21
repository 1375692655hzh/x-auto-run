// cloud-posts.js — 云帖定时发布（10-20 拍板：脱离常驻，与互关帖同款调度形态）
// 用法: node cloud-posts.js --account fullwin [--dry]
// 调度: Xops云帖-fullwin 每小时 :50（上游 :40 出文后 10 分钟）
// 流程: content-pull --account 拉取 → 读投递箱 → 当小时额度（白天 8-22 时 ≤2 条 / 夜里 1 条）
//   → 余量写回投递文件下小时继续 → 写队列（postAt=现在+2~8min 间隔）→ 驻留到点 spawn executor --entry
// 独立帽：postCloud ≤50/天（与互关帖 postTopic 分立，10-20 拍板）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const quality = require('./quality');
const { ensurePostLen } = require('./post-len');

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
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE-' + ACCOUNT))) { console.error('PAUSE-' + ACCOUNT + ' 生效，账号级人工接管，退出'); process.exit(0); }
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

  // ②a 补跑清扫（10-21 事故修复：云帖失败无补跑=永久丢量，违背交付必达）：
  // 扫近 2 日云帖队列里 status=failed 且未补跑过的条目，重压缩（超限是真因）后并入本小时额度消化。
  // 必须排在投递箱取件【之前】——先补欠账再上新内容（09:50 实跑教训：排后面会被新内容占满额度挨饿）；
  // 空箱小时也照跑（交付优先于新内容）
  try {
    for (let dd = 1; dd >= 0; dd--) {
      const d = new Date(Date.now() - dd * 86400000);
      const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (let h = 0; h <= 23; h++) {
        const p = path.join(QUEUE_DIR, `${dayStr}-cloud-${ACCOUNT}-${h}.json`);
        if (!fs.existsSync(p)) continue;
        if (h === new Date().getHours() && dd === 0) continue; // 本小时文件还没写，不扫自己
        let q = null; try { q = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        if (!Array.isArray(q)) continue;
        let dirty = false;
        for (const e of q) {
          if (e.status !== 'failed' || e.requeued) continue;
          // 补跑封顶 2 轮（10-21 复核补漏）：收编后的条目再失败会被下小时再收编→无限循环抢额度，
          // 轮次计数必须穿过新队列文件传递（新文件条目丢了 requeueOf，只有 sweepRound 保命）
          if ((e.sweepRound || 0) >= 2) { e.sweepAbandoned = true; e.result = (e.result || '') + ' → 补跑 2 轮仍败，放弃'; dirty = true; continue; }
          if (entries.length >= take) break;
          let t = e.text;
          if (quality.weightedLen(t) > 270) {
            const fx = await ensurePostLen(t, { channel: RC.llmChannel, fallbackProvider: RC.llmFallback }).catch(() => null);
            if (fx && fx.text) t = fx.text;
          }
          entries.push({ text: t, quote: e.quote, quoteUrl: e.quoteUrl, requeueOf: e.id, sweepRound: (e.sweepRound || 0) + 1 });
          e.requeued = true; e.result = (e.result || '') + ` → 补跑清扫收编(${today()}，第${(e.sweepRound || 0) + 1}轮)`; dirty = true;
          audit({ action: 'cloudSweep', status: 'requeued', id: e.id, note: `加权${quality.weightedLen(e.text)}→${quality.weightedLen(t)} 第${(e.sweepRound || 0) + 1}轮` });
        }
        if (dirty) writeJson(p, q);
        if (entries.length >= take) break;
      }
      if (entries.length >= take) break;
    }
  } catch (e) { audit({ action: 'cloudSweep', status: 'error', note: String(e.message || e).slice(0, 80) }); }

  for (const f of fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.startsWith(`pull-${ACCOUNT}-`) && f.endsWith('.json')) : []) {
    const items = readJson(path.join(INBOX, f), []);
    const roomLeft = Math.max(0, take - entries.length);
    const fileItems = items.slice(0, roomLeft);
    for (const it of fileItems) {
      let t = it.text;
      // 入队长度门（10-21 根因修复：上游偶发产出 >280 加权长文，发布按钮被禁用必败）
      if (quality.weightedLen(t) > 270) {
        const fx = await ensurePostLen(t, { channel: RC.llmChannel, fallbackProvider: RC.llmFallback }).catch(() => null);
        if (fx && fx.text) { audit({ action: 'postLenFix', note: `入队压缩 ${fx.before}→${fx.after} via ${fx.via}` }); t = fx.text; }
      }
      entries.push({ text: t, quote: it.quote, quoteUrl: it.quoteUrl }); queued++;
    }
    const rest = items.slice(fileItems.length); // 余量写回，下一小时继续
    if (rest.length) writeJson(path.join(INBOX, f), rest);
    else { try { fs.renameSync(path.join(INBOX, f), path.join(INBOX, f + '.done-' + Date.now())); } catch { } }
    if (entries.length >= take) break;
  }

  if (!entries.length) { audit({ action: 'cloudPost', status: 'none', note: '投递箱空（上游无新内容或缓存未滴）' }); process.exit(0); }
  LOG(`本小时额度 ${take}，取到 ${entries.length} 条${entries.some((e) => e.requeueOf) ? `（含补跑 ${entries.filter((e) => e.requeueOf).length} 条）` : ''}`);

  // ③ 写队列 + 定时拉起（2~8min 间隔）
  const qFile = path.join(QUEUE_DIR, `${today()}-cloud-${ACCOUNT}-${new Date().getHours()}.json`);
  let delayMin = rand(1, 3);
  const queue = entries.map((e, i) => {
    const postAt = Date.now() + delayMin * 60000;
    delayMin += rand(2, 8);
    return { id: `${today()}-cloud-${ACCOUNT}-${new Date().getHours()}-${i + 1}`, account: ACCOUNT, type: 'post', kind: 'cloud-post', text: e.text, quote: e.quote, quoteUrl: e.quoteUrl, window: 'cloud', sweepRound: e.sweepRound || 0, postAt: new Date(postAt).toISOString(), status: 'planned', createdAt: nowIso() };
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
      // 10-21 修复：executor 尝试即记 'post'（保守口径），这里原来无论成败再记 post+postCloud=双记，
      // 6 连败白烧 8+ 条额度。改为：postCloud 仅在 done/unknown（真实发出或可能已发出）时记
      const st = (readJson(qFile, []) || []).find((x) => x && x.id === e.id);
      if (st && (st.status === 'done' || st.status === 'unknown')) ledgerRecord('postCloud');
    }, delay);
  }
  const lastMs = Math.max(...queue.map((e) => Date.parse(e.postAt))) - Date.now() + 5 * 60000;
  setTimeout(() => { LOG('本小时发布完毕，退出'); process.exit(0); }, Math.max(lastMs, 30 * 1000));
})().catch((e) => { console.error('FATAL:', e.message || e); audit({ action: 'cloudPost', status: 'fatal', note: String(e.message || e).slice(0, 100) }); process.exit(1); });
