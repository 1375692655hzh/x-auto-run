// content-pull.js — 内容源拉取器 v2（多绑定版，三方方案 2026-10-18 定稿）
// 用法: node content-pull.js [--dry]（schtasks 09:50/13:10/19:10 各跑一次，云端 9/12/18 档后、三窗前）
// 流程: 按 content-source.json bindings 逐号拉北京今天+昨天 → text_hash 去重（缺失用全文 sha256 回退）
//       → 每号独立缓冲 state/content-buffer-<local>.json（48h 时效/上限30）
//       → 滴灌条件：bound && publishAuth && publish && 账号 role=run && 非周末 && 投递箱无未消费 pull-<local>-*
//       → 滴灌量 = min(该窗预算 windowAllocation[下一窗], 日预算−今日已入队, 缓冲)
//       滴灌必须精确等于 planner 该窗会消费的量（planner 整文件消费即归档，超额=永不再发）
// 降级: 单日拉取失败跳过不写结论；key 失效(401/403)本轮全停投递并告警；周末不投递（缓冲照常更新/过期）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'content-source.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const DRY = process.argv.includes('--dry');
// 北京时间口径（服务器 date 参数按 sent_at 北京落盘日期过滤；slot 日期≠落盘日期，实测坑）
const bjDate = (offDays = 0) => new Date(Date.now() + 8 * 3600000 + offDays * 86400000).toISOString().slice(0, 10);
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.appendFileSync(path.join(STATE_DIR, `log-${bjDate(0).slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'contentPull', ...obj }) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash('sha256').update(String(t).trim()).digest('hex');

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { err: r.status };
  try { return { data: await r.json() }; } catch { return { err: 'badjson' }; }
}

// 下一执行窗（滴灌目标）：am<10:20 / mid<15:20 / pm 其余
function nextWindow() { const m = new Date(Date.now() + 8 * 3600000).getUTCHours() * 60 + new Date(Date.now() + 8 * 3600000).getUTCMinutes(); return m < 620 ? 'am' : m < 920 ? 'mid' : 'pm'; }
// 今日已入队帖数（该号）：扫今日三窗队列里 type=post 且未跳过的条目
function enqueuedToday(local) {
  let n = 0;
  for (const w of ['am', 'mid', 'pm']) {
    const q = readJson(path.join(ROOT, 'queue', `${bjDate(0)}-${w}-${local}.json`), []);
    if (Array.isArray(q)) n += q.filter((e) => e && e.type === 'post' && e.status !== 'skipped').length;
  }
  return n;
}

(async () => {
  const BUDGET = (CFG.posts && CFG.posts.budget) || { perDay: 2, windowAllocation: { am: 1, mid: 0, pm: 1 } };
  const isWeekend = [0, 6].includes(new Date(Date.now() + 8 * 3600000).getUTCDay());
  const roleOf = (k) => (CFG.accounts.find((a) => a.key === k) || {}).role;
  let keyFailed = false;

  for (const b of SRC.bindings || []) {
    if (!b.bound) continue;
    const acct = CFG.accounts.find((a) => a.key === b.local);
    if (!acct) { LOG(`绑定 ${b.local} 无本地账号，跳过`); continue; }
    const bufFile = path.join(STATE_DIR, `content-buffer-${b.local}.json`);
    const st = readJson(bufFile, { pulled: {}, buffer: [] });
    let fetched = 0, fresh = 0, keyErr = false;

    for (const d of [bjDate(0), bjDate(-1)]) {
      if (keyFailed || keyErr) break;
      const j = await fetchJSON(`${SRC.base}/sent?key=${encodeURIComponent(SRC.key)}&account=${encodeURIComponent(b.source)}&date=${d}`);
      if (j.err === 401 || j.err === 403) { keyErr = true; break; }
      if (j.err || !j.data) { LOG(`[${b.local}] 拉取 ${d} 失败(${j.err || '空'})，跳过该日（不写结论）`); continue; }
      const items = j.data.items || [];
      fetched += items.length;
      for (const it of items) {
        const h = it.text_hash || sha(it.text); // 全文哈希回退（Codex：比前64字符更稳）
        if (st.pulled[h]) continue;
        st.pulled[h] = new Date().toISOString();
        st.buffer.push({ text: it.text, hash: h, slot: it.slot, sentAt: it.sent_at }); // send_ok 不消费（说明书 v2）
        fresh += 1;
      }
      await sleep(1200);
    }
    if (keyErr) { keyFailed = true; LOG(`⚠ key 失效(${b.local}，401/403)，本轮全停投递，请换 key`); audit({ action: 'keyFail', account: b.local }); }

    // 时效清理：>48h 丢弃；缓冲上限 30；pulled 留最近 500
    const cut48 = Date.now() - 48 * 3600000;
    const before = st.buffer.length;
    st.buffer = st.buffer.filter((x) => { const t = Date.parse(x.sentAt); return Number.isFinite(t) ? t > cut48 : true; });
    const dropped = before - st.buffer.length;
    if (st.buffer.length > 30) st.buffer = st.buffer.slice(-30);
    const pk = Object.entries(st.pulled).sort((a, c) => Date.parse(c[1]) - Date.parse(a[1]));
    st.pulled = Object.fromEntries(pk.slice(0, 500));

    // 滴灌决策
    let wrote = 0, why = '';
    const canPublish = b.bound && b.publishAuth && b.publish && roleOf(b.local) === 'run';
    const unconsumed = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.startsWith(`pull-${b.local}-`) && f.endsWith('.json')) : [];
    if (keyFailed) why = 'key失效全停';
    else if (!canPublish) why = `未授权/未开闸(publishAuth=${b.publishAuth},publish=${b.publish},role=${roleOf(b.local)})`;
    else if (isWeekend) why = '周末不投递（拍板 P5）';
    else if (unconsumed.length) why = `投递箱未消费(${unconsumed.join(',')})`;
    else {
      const w = nextWindow();
      const alloc = (BUDGET.windowAllocation || {})[w] ?? 0;
      const drip = Math.min(alloc, (BUDGET.perDay || 2) - enqueuedToday(b.local), st.buffer.length);
      if (drip <= 0) why = `预算/缓冲不足(${w}窗=${alloc}，今日已入队=${enqueuedToday(b.local)}，缓冲=${st.buffer.length})`;
      else if (!DRY) {
        const batch = st.buffer.splice(0, drip);
        writeJson(path.join(INBOX, `pull-${b.local}-${Date.now()}.json`), batch.map((x) => ({ text: x.text })));
        wrote = drip;
      } else why = `[DRY] 应滴灌 ${drip} 条（未写入）`;
    }
    if (!DRY) writeJson(bufFile, st);
    audit({ action: 'pull', account: b.local, source: b.source, fetched, fresh, dropped, buffered: st.buffer.length, wrote, note: why || undefined, dry: DRY || undefined });
    LOG(`[${b.local}] 拉${fetched} 新${fresh} 弃${dropped} 缓冲${st.buffer.length} 投递${wrote}${why ? '（' + why + '）' : ''}`);
  }
  if (DRY) console.log('[DRY] 决策预览：未写任何状态/投递文件');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
