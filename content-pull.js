// content-pull.js — 内容源拉取器（2026-10-17）：x-daily-serve 只读接口 → posts-inbox 滴灌
// 用法: node content-pull.js [--dry]（schtasks 10:00/13:00/19:00 各跑一次，对应云端 9/12/18 点三档）
// 流程: 拉今天+昨天 /sent（hash 去重防重发）→ 新内容入本地缓冲 state/content-buffer.json
//       → posts-inbox/ 无未消费 pull-*.json 时，滴灌 min(缓冲, 每窗发布帽=2) 条成投递文件
//       → 现有 planner post 模式在 10:20/15:20/20:20 窗自动拾取发布（280 校验/队列/审计全沿用）
// 滴灌原因: 云端每档 10 条，planner 每窗最多发 2 条且消费即归档——一次全投会让 8 条被归档永不发。
// 时效: 缓冲内容超 48h（sent_at）自动丢弃（财经时效内容，隔档即旧）；缓冲上限 30。
// enabled=false（content-source.json）= 只拉取缓冲不投递，等你放行发布。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'content-source.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const BUF_FILE = path.join(STATE_DIR, 'content-buffer.json');
const DRY = process.argv.includes('--dry');
// 北京时间口径的日期（服务器 date 参数按 sent_at 北京日期过滤；slot 日期与落盘日期可能不同步，如 10-16 晚档 10-17 回填）
const bjDate = (offDays = 0) => new Date(Date.now() + 8 * 3600000 + offDays * 86400000).toISOString().slice(0, 10);
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.appendFileSync(path.join(STATE_DIR, `log-${bjDate(0).slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'contentPull', account: (CFG.accounts.find((a) => a.key === 'butcher') || {}).key || 'butcher', ...obj }) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { err: r.status };
  try { return { data: await r.json() }; } catch { return { err: 'badjson' }; }
}

(async () => {
  const PER_WINDOW = ((CFG.posts || {}).perWindow != null ? CFG.posts.perWindow : 2); // 滴灌步长=每窗发布帽
  const bufState = readJson(BUF_FILE, { pulled: {}, buffer: [] }); // pulled: hash→firstSeenAt
  let fetched = 0, fresh = 0;

  // 1) 拉北京时间今天+昨天（落盘日期口径，跨天错位由 hash 去重兜底）
  for (const d of [bjDate(0), bjDate(-1)]) {
    const j = await fetchJSON(`${SRC.base}/sent?key=${encodeURIComponent(SRC.key)}&account=${encodeURIComponent(SRC.account)}&date=${d}`);
    if (j.err || !j.data) { LOG(`拉取 ${d} 失败(${j.err || '空'})，跳过该日（不写结论）`); continue; }
    const items = j.data.items || [];
    fetched += items.length;
    for (const it of items) {
      const h = it.text_hash || String(it.text).slice(0, 64);
      if (bufState.pulled[h]) continue;
      bufState.pulled[h] = new Date().toISOString();
      bufState.buffer.push({ text: it.text, hash: h, slot: it.slot, sentAt: it.sent_at }); // send_ok 不消费（说明书 v2：内容本体与推送状态无关）
      fresh += 1;
    }
    await sleep(1200);
  }

  // 2) 时效清理：>48h 丢弃；缓冲上限 30；pulled 记录留最近 500 条
  const cut48 = Date.now() - 48 * 3600000;
  const before = bufState.buffer.length;
  bufState.buffer = bufState.buffer.filter((x) => { const t = Date.parse(x.sentAt); return Number.isFinite(t) ? t > cut48 : true; });
  const dropped = before - bufState.buffer.length;
  if (bufState.buffer.length > 30) bufState.buffer = bufState.buffer.slice(-30);
  const pulledKeys = Object.entries(bufState.pulled).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  bufState.pulled = Object.fromEntries(pulledKeys.slice(0, 500));

  // 3) 滴灌：投递箱无未消费 pull-*.json 时才投（防堆叠），每次 ≤ 每窗帽
  let wrote = 0;
  const unconsumed = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => /^pull-.*\.json$/.test(f)) : [];
  if (!SRC.enabled) {
    LOG(`enabled=false：只拉取不投递（缓冲 ${bufState.buffer.length} 条待命）`);
  } else if (unconsumed.length) {
    LOG(`投递箱有未消费文件 ${unconsumed.join(',')}，本轮不投（防堆叠）`);
  } else if (bufState.buffer.length) {
    const batch = bufState.buffer.splice(0, Math.min(PER_WINDOW, bufState.buffer.length));
    if (!DRY) {
      writeJson(path.join(INBOX, `pull-${Date.now()}.json`), batch.map((x) => ({ text: x.text })));
      wrote = batch.length;
      LOG(`已滴灌 ${wrote} 条 → posts-inbox/（缓冲剩 ${bufState.buffer.length}）`);
    } else LOG(`[DRY] 应滴灌 ${batch.length} 条（未写入），缓冲剩 ${bufState.buffer.length}`);
  } else {
    LOG('缓冲为空，无可投内容');
  }

  if (!DRY) writeJson(BUF_FILE, bufState);
  audit({ action: 'pull', fetched, fresh, dropped, buffered: bufState.buffer.length, wrote, enabled: !!SRC.enabled, dry: DRY || undefined });
  console.log(`汇总：拉到 ${fetched} 条，新 ${fresh}，过期丢 ${dropped}，缓冲 ${bufState.buffer.length}，投递 ${wrote}${DRY ? '（DRY 未落盘）' : ''}`);
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
