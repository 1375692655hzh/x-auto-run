// verify-reply.js — 回复可见性抽查（统计规范 v1.1 C2，新任务）
// 用法: node verify-reply.js [--window am|mid|pm]（schtasks 窗后 +40min 拉起：10:55/16:00/21:00）
// 逻辑: 匿名拉 butcher 近 4h 带回复时间线 → 取本窗发出的最新 1-2 条回复 → 逐条 GET /2/status/<id>
//       命中=可见；404/缺失→复测 1 次→仍缺=疑似隐藏。结果合并写当日快照 replyVisibility 字段；
//       连续 2 天可见率 <50% → 写 state/radar-reprobe.flag 触发雷达复测（maintain-watch 消费）。
// 性质: 纯 HTTP 匿名，零暴露；只记录不自动处置（unknown≠异常 铁律）。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const API = 'https://api.fxtwitter.com';
const RUN_KEYS = CFG.accounts.filter((a) => a.role === 'run').map((a) => a.key); // 10-18 双运行号：butcher+wcixot
const argv = process.argv.slice(2);
const WIN = ((argv.find((a) => a.startsWith('--window=')) || '').slice('--window='.length) || 'am');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }; // 本地(北京)日期——曾用 UTC 致凌晨任务写错日（10-17 互关扫描写入昨日快照，Codex 抓出）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'verifyReply', account: 'butcher', ...obj }) + '\n'); }

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { err: r.status };
  try { return { data: await r.json() }; } catch { return { err: 'badjson' }; }
}

async function checkOne(key) {
  const acct = CFG.accounts.find((a) => a.key === key);
  const HANDLE = (acct || {}).handle || key; // 双号覆盖（10-18 wcixot 复刻）
  const audit = (obj) => fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'verifyReply', account: key, ...obj }) + '\n');
  // 1) 近 4h 带回复时间线 → 本人发出的回复（author==self && replying_to）；端点偶发空响应，重试 1 次
  const since = Math.floor((Date.now() - 4 * 3600000) / 1000);
  let tl = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    tl = await getJSON(`${API}/2/profile/${HANDLE}/statuses?with_replies=1&since=${since}`);
    if (tl.data && !tl.err) break;
    if (attempt === 1) { LOG('时间线拉取失败(' + (tl.err || '空') + ')，8 秒后重试'); await sleep(8000); }
  }
  if (tl.err || !tl.data) { LOG('时间线拉取失败: ' + (tl.err || '空') + '，本轮放弃（不写任何结论）'); audit({ action: 'skip', note: 'timeline 失败 ' + (tl.err || '') }); return; }
  const h = HANDLE.toLowerCase();
  const replies = (tl.data.results || []).filter((x) => ((x.author && x.author.screen_name) || '').toLowerCase() === h && x.replying_to && !x.reposted_by)
    .sort((a, b) => (b.created_timestamp || 0) - (a.created_timestamp || 0)).slice(0, 2);
  if (!replies.length) { LOG('近 4h 无本人回复，无抽查对象'); audit({ action: 'skip', note: '无回复可查' }); return; }

  // 2) 逐条匿名核验（复测 1 次）
  const results = [];
  for (const r of replies) {
    const id = String(r.id);
    let visible = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const c = await getJSON(`${API}/2/status/${id}`);
      if (c.data && (!c.err)) { visible = true; break; }
      if (attempt === 1) await sleep(6000); // 索引落地缓冲后复测
    }
    results.push({ id, target: (r.replying_to && r.replying_to.screen_name) || r.replying_to, visible });
    LOG(`回复 ${id.slice(-8)} → @${(r.replying_to && r.replying_to.screen_name) || r.replying_to} ：${visible ? '✓ 可见' : '✗ 疑似隐藏'}`);
    await sleep(1500);
  }
  const visible = results.filter((x) => x.visible).length;

  // 3) 合并写当日快照（不覆盖其他字段）
  const snapPath = path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
  const snap = readJson(snapPath, { accounts: {} });
  const hist = snap.replyVisibility || [];
  snap.replyVisibility = [...hist.filter((x) => x.window !== WIN || x.account !== key), { account: key, window: WIN, at: new Date().toISOString(), checked: results.length, visible, results }];
  writeJson(snapPath, snap);

  // 4) 当日汇总：连续 2 天可见率 <50% → 触发雷达复测 flag
  const byDay = {};
  for (const e of snap.replyVisibility) { const d = (e.at || '').slice(0, 10); byDay[d] = byDay[d] || { checked: 0, visible: 0 }; byDay[d].checked += e.checked; byDay[d].visible += e.visible; }
  const days = Object.entries(byDay).sort().slice(-2);
  const lowStreak = days.length === 2 && days.every(([, v]) => v.checked > 0 && v.visible / v.checked < 0.5);
  if (lowStreak) { writeJson(path.join(STATE_DIR, 'radar-reprobe.flag'), { handle: HANDLE, at: new Date().toISOString(), note: `回复可见率连续2天<50%（${days.map(([, v]) => v.visible + '/' + v.checked).join('、')}）` }); LOG('⚠ 可见率连续 2 天 <50%，已写雷达复测 flag'); }

  audit({ action: 'check', window: WIN, checked: results.length, visible, note: results.map((x) => x.id.slice(-8) + (x.visible ? '✓' : '✗')).join(' ') });
  console.log(`[${key}] 本窗抽查：可见 ${visible}/${results.length}`);
}

// ── 误发独立帖旁证核查（10-22"回复变独立帖"事故配套）：消费 resident/executor/inbox-reply 发送成功时登记的 pending-verify-<账号>.json
// 双端点确认制（用户拍板：FxTwitter 有抽风，不作唯一判据引导操作）：
//   ①时间线找到文本匹配帖且非回复 → ②/2/status/<id> 直查仍无 replying_to → 才告警进人工待办（不自动删除/不熔断）
//   拉不到/匹配不到/两端点不一致 = 不确定，不写结论（unknown≠异常 铁律）；重查 4 次或超 24h 丢弃留痕
async function consumePendingVerify(key) {
  const f = path.join(STATE_DIR, `pending-verify-${key}.json`);
  if (!fs.existsSync(f)) return;
  const acct = CFG.accounts.find((a) => a.key === key);
  if (!acct) { writeJson(f, []); return; }
  const HANDLE = acct.handle;
  const audit2 = (obj) => fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'verifyReply', account: key, ...obj }) + '\n');
  const list = readJson(f, []);
  if (!list.length) return;
  const keep = [];
  const norm = (s) => String(s || '').replace(/^(@\w+\s*)+/, '').replace(/\s+/g, '').slice(0, 12);
  for (const e of list) {
    const ageMs = Date.now() - (Date.parse(e.at || 0) || 0);
    if (ageMs < 10 * 60000) { keep.push(e); continue; } // 等 FxTwitter 索引落地
    // 探针①：本人带回复时间线找文本匹配帖（失败重试 1 次）
    let hit = null, fetchOk = false;
    for (let a = 1; a <= 2 && !hit; a++) {
      const tl = await getJSON(`${API}/2/profile/${HANDLE}/statuses?with_replies=1`);
      if (tl.data && !tl.err) {
        fetchOk = true;
        const mine = (tl.data.results || []).filter((x) => ((x.author || {}).screen_name || '').toLowerCase() === HANDLE.toLowerCase());
        const b = norm(e.text);
        hit = mine.find((x) => { const a1 = norm(x.text); return a1 && b && (a1.includes(b) || b.includes(a1)); }) || null;
      }
      if (!hit && a === 1) await sleep(8000);
    }
    if (hit) {
      if (hit.is_reply || hit.replying_to) { audit2({ action: 'replyVerify', status: 'mounted', target: e.target, source: e.source, note: '已挂载✓' }); continue; } // 正常回复，丢弃
      // 探针②：直查该帖确认（防时间线端点抽风误报）
      await sleep(5000);
      const c = await getJSON(`${API}/2/status/${hit.id}`);
      const tw = c.data && !c.err ? (c.data.tweet || c.data) : null;
      const twReal = tw && (tw.id || tw.text) ? tw : null;
      if (twReal && !(twReal.is_reply || twReal.replying_to)) {
        const todoFile = path.join(STATE_DIR, `human-todo-${key}.json`);
        let todo = { pending: [] };
        try { todo = JSON.parse(fs.readFileSync(todoFile, 'utf8')); if (!Array.isArray(todo.pending)) todo.pending = []; } catch { }
        todo.pending.push({ at: new Date().toISOString(), kind: 'bugStandalone', author: e.target, text: '⚠回复变独立帖(双端点确认): ' + String(e.text).slice(0, 60), postUrl: `https://x.com/${HANDLE}/status/${hit.id}`, statusId: String(hit.id), status: 'pending', note: `本应回复 @${e.target}（目标帖 ${e.statusId}），请人工核查后删除` });
        writeJson(todoFile, todo);
        audit2({ action: 'bugStandalone', target: e.target, statusId: e.statusId, leakedId: String(hit.id), source: e.source, text: String(e.text).slice(0, 40) });
        LOG(`⚠ [${key}] 双端点确认误发独立帖 ${hit.id}（本应回 @${e.target}），已进人工待办`);
        continue; // 丢弃（已告警）
      }
      // 直查抽风/两端点不一致 → 不确定，留待下轮
      e.checks = (e.checks || 0) + 1;
      if (e.checks >= 4 || ageMs > 24 * 3600000) { audit2({ action: 'replyVerify', status: 'inconclusive', target: e.target, note: '时间线疑独立帖但直查不确定，放弃（不写结论）' }); continue; }
      keep.push(e); continue;
    }
    if (!fetchOk) { keep.push(e); continue; } // 端点抽风：不计次数，下轮再试
    // 拉取成功但没匹配到：索引未落地/帖未发出/被隐藏——不确定
    e.checks = (e.checks || 0) + 1;
    if (e.checks >= 4 || ageMs > 24 * 3600000) { audit2({ action: 'replyVerify', status: 'inconclusive', target: e.target, note: '多次未匹配到发出帖（未发出/索引缺失/被隐藏皆有可能），不写结论' }); continue; }
    keep.push(e);
  }
  writeJson(f, keep);
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); return; }
  for (const key of RUN_KEYS) { try { await checkOne(key); } catch (e) { console.error(`[${key}] 异常: ${e.message}`); } await sleep(2000); }
  // 消费全部账号的 pending-verify（不限 RUN_KEYS：fullwin 常驻/executor/inbox-reply 都会登记；纯 HTTP 只读，PAUSE 账号也照查——人工接管期更需要）
  for (const f of fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR) : []) {
    const m = f.match(/^pending-verify-(.+)\.json$/);
    if (m) { try { await consumePendingVerify(m[1]); } catch (e) { console.error(`[verify ${m[1]}] 异常: ${e.message}`); } await sleep(1500); }
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
