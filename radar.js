// radar.js — shadowbanradar.com 限流雷达（浏览器渲染通道）：读取 /zh/r/<handle> 结果页的四维度判定
// 用法:
//   node radar.js --dump                    渲染 butcher 结果页，打印可见文本（探测 DOM 用）
//   node radar.js --check                   渲染 + 解析四维度 → 写入 state/health-snapshots/<今日>.json 的 radar 字段
// 设计: 用中性窗口（config.radar.profileId，默认 WCixot 油管窗口）渲染，不用 butcher 窗口——
//       避免把执行号 Cookie 与检测站关联；纯只读浏览，不点任何按钮。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const RC = Object.assign({ profileId: '9271f8e085944b0a8a6685aa19e8b2f7', handles: ['MarketButcher88', 'Owenwin888'], waitMs: 12000 }, CFG.radar || {});

const argv = process.argv.slice(2);
const DUMP = argv.includes('--dump');
const CHECK = argv.includes('--check');
const HANDLES_ARG = ((argv.find((a) => a.startsWith('--handles=')) || '').slice('--handles='.length) || '').split(',').map((s) => s.trim()).filter(Boolean);
if (HANDLES_ARG.length) RC.handles = HANDLES_ARG; // 单号复测用（统计规范 v1.1：熔断触发/19:40 晚检）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 日额度护栏（v1.1 C8）：当日已跑检查数 ≥10 拒跑（免费档 ~30/天，固定 5 + 复测 ≤10，红线 30）
function radarChecksToday() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', `log-${today().slice(0, 7)}.jsonl`), 'utf8').trim().split('\n')
      .filter((l) => { try { const j = JSON.parse(l); return j.task === 'radar' && j.at && j.at.slice(0, 10) === today(); } catch { return false; } }).length;
  } catch { return 0; }
}

async function openWindow(profileId) {
  const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }) }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j));
  return j.data.ws;
}

async function renderResult(handle) {
  const ws = await openWindow(RC.profileId);
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1366 + Math.floor(Math.random() * 60), height: 900 });
      await page.goto(`https://shadowbanradar.com/zh/r/${handle}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(RC.waitMs); // 等 SPA 渲染 + 数据拉取
      const text = await page.evaluate(() => (document.body.innerText || '').replace(/\n{3,}/g, '\n\n'));
      // 官方 aria 通道：容器 aria-label 含四维度判定全文（机器可读，比图标可靠）
      const aria = await page.evaluate(() => {
        const el = document.querySelector('[aria-label*="搜索建议限制"], [aria-label*="Search suggestion"]');
        return el ? el.getAttribute('aria-label') : null;
      }).catch(() => null);
      // DOM 探针：四维度条目与其父节点的类名/aria（状态多为图标，靠类名或 aria 判通过与否）
      const domInfo = await page.evaluate(() => {
        const labels = ['搜索建议', '搜索', '回复隐藏', '回复'];
        const out = [];
        for (const el of document.querySelectorAll('li,div,section')) {
          const t = (el.textContent || '').trim();
          if (t.length > 30 || !t) continue;
          if (labels.some((l) => t === l || t.startsWith(l))) {
            const cls = [el.className, el.parentElement && el.parentElement.className].filter(Boolean).join(' | ').slice(0, 120);
            const aria = el.getAttribute('aria-label') || (el.parentElement && el.parentElement.getAttribute('aria-label')) || '';
            const svg = el.querySelector('svg') ? 'svg:' + ([...el.querySelectorAll('svg')].map((s) => s.getAttribute('class')).join(',')) : '';
            out.push({ text: t.slice(0, 20), cls, aria, svg });
          }
        }
        return out.slice(0, 12);
      }).catch(() => []);
      const url = page.url();
      await page.close();
      return { url, text, aria };
    } finally { await browser.disconnect(); }
  } finally {
    await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: RC.profileId }) }).catch(() => { });
  }
}

// 解析四维度：优先 aria-label（"搜索建议限制: 未见限制, …"），无 aria 时退回文本正则
function parseFour(text, aria) {
  const out = { suggestion: null, search: null, ghost: null, deboost: null };
  if (aria) {
    for (const part of aria.split(',')) {
      const m = part.match(/^\s*([^:：]+)[:：]\s*(.+?)\s*$/);
      if (!m) continue;
      const [k, v] = [m[1], m[2]];
      if (/搜索建议|suggestion/i.test(k)) out.suggestion = v;
      else if (/搜索|search/i.test(k) && !/建议|suggestion/i.test(k)) out.search = v;
      else if (/回复隐藏|ghost/i.test(k)) out.ghost = v;
      else if (/回复排序|deboost/i.test(k)) out.deboost = v;
    }
  } else {
    const map = [['suggestion', /搜索建议[^\n]*/], ['search', /搜索封禁|搜索限制[^\n]*/], ['ghost', /幽灵封禁|回复隐藏[^\n]*/], ['deboost', /回复降权|回复排序[^\n]*/]];
    for (const [key, re] of map) { const m = text.match(re); out[key] = m ? m[0].slice(0, 120) : null; }
  }
  const score = (text.match(/(\d+)\s*\/\s*100/) || [])[1] || null;
  const verdict = (text.match(/未检测到限流|检测到限流/) || [])[0] || null;
  const age = (text.match(/账户年龄[^\d]*(\d+)\s*天/) || [])[1] || null;
  return { ...out, score, verdict, accountAgeDays: age };
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); process.exit(0); }
  const usedToday = radarChecksToday();
  if (CHECK && usedToday >= 10) { console.error(`雷达日额度护栏：今日已 ${usedToday} 次检查（上限 10），拒跑`); process.exit(1); }
  const results = {};
  for (const h of RC.handles) {
    const r = await renderResult(h);
    console.log(`\n===== @${h}（${r.url}）=====`);
    if (DUMP) console.log(r.text.slice(0, 2600));
    const four = parseFour(r.text, r.aria);
    results[h] = { url: r.url, four, ariaRaw: r.aria };
    console.log(JSON.stringify(four));
    await sleep(3000);
  }
  if (CHECK) {
    const p = path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
    let snap = {};
    try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
    snap.checkedAt = snap.checkedAt || new Date().toISOString();
    // 逐号合并：本次解析全空（渲染/解析失败）的号保留快照旧结果，不拿空值覆盖好数据（10-16 教训：曾把 Owen 早间 100/100 覆盖成 null）
    const prev = (snap.radar && snap.radar.results) || {};
    const okFour = (f) => f && Object.values(f).some((v) => v != null);
    const merged = {};
    for (const h of RC.handles) {
      merged[h] = okFour(results[h] && results[h].four) ? results[h] : (prev[h] || results[h]);
    }
    snap.radar = { fetchedAt: new Date().toISOString(), results: merged };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'radar', account: 'butcher', action: 'check', note: RC.handles.join(',') + ' 四维度判定' }) + '\n');
    console.log(`\n已写入 ${p} 的 radar 字段`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
