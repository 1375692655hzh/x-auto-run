// verify-unknown.js — unknown（结果不明）条目自动核验与重排（2026-10-20 用户拍板"交付必达"）
// 背景：旧规 unknown=占额度禁重试的死账，10-20 起改为可核验资产——
//   round 会话产出 unknown 30 分钟后由本脚本匿名核验（FxTwitter 只读时间线，零暴露）：
//     已发出 → 记 done（回复补记 taskstate 台账 + 关系池，防 planner 重复生成）
//     未发出 → 翻回 planned（verifyRetries<2 封顶防死循环），由补跑节重发；超 2 次留 unknown 交人工
//     FxTwitter 失败 → 不动任何条目（unknown≠异常 铁律），等下一轮核验
// 用法: node verify-unknown.js --account butcher --queue queue/2026-10-20-p3-butcher.json
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'butcher');
const QUEUE_FILE = argOf('queue', null);
const ACCT = CFG.accounts.find((a) => a.key === ACCOUNT);
if (!ACCT) { console.error('config.accounts 无此账号: ' + ACCOUNT); process.exit(1); }
if (!QUEUE_FILE || !fs.existsSync(QUEUE_FILE)) { console.error('必须指定存在的 --queue <文件>'); process.exit(1); }

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (line) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'verifyUnknown', account: ACCOUNT, ...line }) + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { err: r.status };
  try { return { data: await r.json() }; } catch { return { err: 'badjson' }; }
}

// ── 以下两个台账回写与 executor 同口径（核验确认"已发出"后补记，防 planner 重复生成/关系池失真）──
function syncContactsReply(entry) {
  try {
    const p = path.join(STATE_DIR, `contacts-${ACCOUNT}.json`);
    if (!fs.existsSync(p)) return;
    const led = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = (entry.targetHandle || '').toLowerCase();
    if (!h) return;
    const e = (led.people[h] = led.people[h] || { handle: h, name: null, firstSeen: new Date().toISOString(), updatedAt: null, sources: [], relation: { weFollow: null, theyFollow: null, mutual: false }, activity: { theirEvents: [], theirLastAt: null, ourReplies: 0, ourLastReplyAt: null }, eligibility: { blocked: null, gone: false }, score: 0, stage: 'contacted' });
    e.activity.ourReplies += 1; e.activity.ourLastReplyAt = today();
    if (!e.sources.includes('queue')) e.sources.push('queue');
    e.updatedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(led, null, 2));
  } catch { }
}
function recordReply(entry) {
  try {
    const p = path.join(STATE_DIR, `taskstate-${ACCOUNT}.json`);
    let ts = null;
    try { ts = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
    ts = ts || { repliedAuthors: {}, repliedPosts: {}, replyHistory: [], tagIndex: 0 };
    ts.repliedAuthors = ts.repliedAuthors || {}; ts.repliedPosts = ts.repliedPosts || {}; ts.replyHistory = ts.replyHistory || [];
    if (entry.targetHandle) ts.repliedAuthors[entry.targetHandle] = today();
    if (entry.statusId) ts.repliedPosts[entry.statusId] = today();
    if (entry.text) { ts.replyHistory.push(entry.text); if (ts.replyHistory.length > 50) ts.replyHistory = ts.replyHistory.slice(-50); }
    fs.writeFileSync(p, JSON.stringify(ts, null, 2));
  } catch { }
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('state/PAUSE 急停生效中，退出'); process.exit(0); }
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const unknowns = (Array.isArray(queue) ? queue : []).filter((e) => e && e.status === 'unknown' && (e.type === 'reply' || e.type === 'post'));
  if (!unknowns.length) { console.log('无 unknown 回复/帖条目，收工'); process.exit(0); }
  console.log(`待核验 unknown ${unknowns.length} 条（${unknowns.map((e) => e.id).join(', ')}）`);

  // 近 6h 本人时间线（回复+自发帖一次取回）；端点偶发空响应，重试 1 次
  const HANDLE = ACCT.handle;
  const since = Math.floor((Date.now() - 6 * 3600000) / 1000);
  let tl = null;
  for (let a = 1; a <= 2; a++) {
    tl = await getJSON(`https://api.fxtwitter.com/2/profile/${HANDLE}/statuses?with_replies=1&since=${since}`);
    if (tl.data && !tl.err) break;
    if (a === 1) { console.log('时间线拉取失败，8 秒后重试'); await sleep(8000); }
  }
  if (tl.err || !tl.data) { console.log('FxTwitter 时间线拉取失败，本轮不动任何条目（unknown≠异常，留下轮核验）'); log({ action: 'skip', note: 'timeline 失败 ' + (tl.err || '空') }); process.exit(0); }

  const h = HANDLE.toLowerCase();
  const mine = (tl.data.results || []).filter((x) => ((x.author && x.author.screen_name) || '').toLowerCase() === h && !x.reposted_by);
  let confirmed = 0, requeued = 0, kept = 0;
  for (const e of unknowns) {
    const key = norm(e.text).slice(0, 20); // 20 字前缀足够区分 LLM/云端文案；FxTwitter 全文一般一致
    const hit = mine.find((x) => {
      const tt = norm(x.text);
      if (!key || !tt.startsWith(key)) return false;
      if (e.type === 'reply') return !!x.replying_to;
      return !x.replying_to; // post：自发非回复
    });
    if (hit) {
      e.status = 'done'; e.result = '核验已发（FxTwitter 自动核验，' + String(hit.id || '').slice(-8) + '）'; confirmed += 1;
      if (e.type === 'reply') { syncContactsReply(e); recordReply(e); }
      log({ action: 'confirmed', id: e.id, hitId: String(hit.id || '') });
      console.log(`  ✓ ${e.id} 已发出（远端 ${String(hit.id || '').slice(-8)}）→ 记 done`);
    } else {
      e.verifyRetries = (e.verifyRetries || 0) + 1;
      if (e.verifyRetries <= 2) {
        e.status = 'planned'; e.result = (e.result || '') + ` → 核验未发，翻回重跑（第${e.verifyRetries}次）`; requeued += 1;
        log({ action: 'requeue', id: e.id, verifyRetries: e.verifyRetries });
        console.log(`  ↩ ${e.id} 时间线未见 → 翻回 planned 等补跑（第${e.verifyRetries}次）`);
      } else {
        kept += 1;
        log({ action: 'keepUnknown', id: e.id, note: '核验 2 次仍未见，留 unknown 交人工' });
        console.log(`  ✗ ${e.id} 核验 2 次仍未见 → 留 unknown 交人工核`);
      }
    }
    await sleep(1200);
  }
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  log({ action: 'summary', unknown: unknowns.length, confirmed, requeued, kept });
  console.log(`核验完成：已发 ${confirmed} / 翻回重跑 ${requeued} / 留人工 ${kept}`);
})().catch((e) => { console.error(e.message || e); log({ action: 'error', note: String(e.message || e) }); process.exit(1); });
