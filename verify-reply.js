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
const HANDLE = (CFG.accounts.find((a) => a.key === 'butcher') || {}).handle || 'MarketButcher88';
const argv = process.argv.slice(2);
const WIN = ((argv.find((a) => a.startsWith('--window=')) || '').slice('--window='.length) || 'am');
const today = () => new Date().toISOString().slice(0, 10);
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

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); return; }
  // 1) butcher 近 4h 带回复时间线 → 本人发出的回复（author==self && replying_to）；端点偶发空响应，重试 1 次
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
    results.push({ id, target: r.replying_to, visible });
    LOG(`回复 ${id.slice(-8)} → @${r.replying_to} ：${visible ? '✓ 可见' : '✗ 疑似隐藏'}`);
    await sleep(1500);
  }
  const visible = results.filter((x) => x.visible).length;

  // 3) 合并写当日快照（不覆盖其他字段）
  const snapPath = path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
  const snap = readJson(snapPath, { accounts: {} });
  const hist = snap.replyVisibility || [];
  snap.replyVisibility = [...hist.filter((x) => x.window !== WIN), { window: WIN, at: new Date().toISOString(), checked: results.length, visible, results }];
  writeJson(snapPath, snap);

  // 4) 当日汇总：连续 2 天可见率 <50% → 触发雷达复测 flag
  const byDay = {};
  for (const e of snap.replyVisibility) { const d = (e.at || '').slice(0, 10); byDay[d] = byDay[d] || { checked: 0, visible: 0 }; byDay[d].checked += e.checked; byDay[d].visible += e.visible; }
  const days = Object.entries(byDay).sort().slice(-2);
  const lowStreak = days.length === 2 && days.every(([, v]) => v.checked > 0 && v.visible / v.checked < 0.5);
  if (lowStreak) { writeJson(path.join(STATE_DIR, 'radar-reprobe.flag'), { handle: HANDLE, at: new Date().toISOString(), note: `回复可见率连续2天<50%（${days.map(([, v]) => v.visible + '/' + v.checked).join('、')}）` }); LOG('⚠ 可见率连续 2 天 <50%，已写雷达复测 flag'); }

  audit({ action: 'check', window: WIN, checked: results.length, visible, note: results.map((x) => x.id.slice(-8) + (x.visible ? '✓' : '✗')).join(' ') });
  console.log(`本窗抽查：可见 ${visible}/${results.length}，已写入快照 replyVisibility`);
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
