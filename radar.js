// radar.js — shadowbanradar.com 限流雷达：读取 /zh/r/<handle> 结果页的四维度判定
// 用法:
//   node radar.js --dump                    打印 MarketButcher88 结果页可见文本（探测用）
//   node radar.js --check                   拉取 + 解析四维度 → 写入 state/health-snapshots/<今日>.json 的 radar 字段
// 设计（10-19 拍板改版）: **纯 HTTP 直取结果页，零窗口零 Cookie**——实测结果页是服务端渲染，
//       四维度判定全文在唯一一个 aria-label 里机器可读；此前"必须真浏览器渲染"的结论只对 /api/scan
//       触发端点成立（反爬挑战），结果页直取 200 全文直出。项目级任务，不依赖任何比特浏览器窗口。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const RC = Object.assign({ handles: ['MarketButcher88', 'Owenwin888'], waitMs: 12000 }, CFG.radar || {});
delete RC.profileId; // 已废：不再使用任何比特浏览器窗口（防旧配置误导）

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

// 判定形 aria 校验：必须是"维度: 结论"对；加载态清单（"正在计算/ [2/4]/请启用JS"）不算
const ariaIsVerdict = (a) => !!a && /[:：]/.test(a) && !/正在计算|\[\d+\/4\]|请启用/i.test(a);

async function fetchResult(handle) {
  const url = `https://shadowbanradar.com/zh/r/${handle}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${handle})`);
  const html = await r.text();
  // 四维度判定全文在唯一一个 aria-label 里（与旧浏览器版同一通道，parseFour 无需改动）
  const ariaRaw = (html.match(/aria-label="([^"]*搜索建议限制[^"]*)"/) || html.match(/aria-label="([^"]*Search suggestion[^"]*)"/) || [])[1] || null;
  const aria = ariaRaw ? ariaRaw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null;
  // 去标签得近似可见文本（score/账号龄正则复用）
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { url, text, aria, viaHttp: true };
}

// ── 本机无头 Chrome 通道（10-19 拍板项目级）：仅当 HTTP 直取拿不到终值（缓存过期、页面处于
//    "正在计算"加载态——实测该站判定计算必须跑 JS）才启用。全新临时配置、零 Cookie、
//    与任何比特浏览器账号窗口无关。
let chromeBrowser = null;
let chromeTmpDir = null;
async function renderInChrome(handle) {
  const puppeteer = require('puppeteer-core');
  const chromePath = RC.chromePath || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (!chromeBrowser) {
    const os = require('os');
    chromeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-chrome-'));
    chromeBrowser = await puppeteer.launch({
      executablePath: chromePath, headless: false, userDataDir: chromeTmpDir, // 10-21 改版修复：站点上 Vercel BotID（x-is-human 挑战）专杀无头 → 有头+去自动化标志（实测 POST /api/scan 403→200）
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--lang=zh-CN', '--window-position=2400,100', '--window-size=900,900'],
    });
  }
  const page = await chromeBrowser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.goto(`https://shadowbanradar.com/zh/r/${handle}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 等判定容器出现（加载态会先渲染清单占位，终值 aria 由前端 POST /api/scan 后重渲染补上——有头实测 ~8s）
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label*="搜索建议限制"], [aria-label*="Search suggestion"]');
      const a = el && el.getAttribute('aria-label') || '';
      return /[:：]/.test(a) && !/正在计算|\[\d+\/4\]|请启用/i.test(a);
    }, { timeout: 150000, polling: 2000 }).catch(() => { });
    const aria = await page.evaluate(() => {
      const el = document.querySelector('[aria-label*="搜索建议限制"], [aria-label*="Search suggestion"]');
      return el ? el.getAttribute('aria-label') : null;
    }).catch(() => null);
    const text = await page.evaluate(() => (document.body.innerText || '').replace(/\n{3,}/g, '\n\n')).catch(() => '');
    return { url: page.url(), text, aria, viaHttp: false };
  } finally { try { await page.close(); } catch { } }
}
async function closeChrome() {
  if (chromeBrowser) { try { await chromeBrowser.close(); } catch { } chromeBrowser = null; }
  // 临时 profile 清理（review 抓出：异常退出会残留 mkdtemp 目录）
  if (chromeTmpDir) { try { fs.rmSync(chromeTmpDir, { recursive: true, force: true }); } catch { } chromeTmpDir = null; }
}

// 单号取结果：HTTP 直取（快）→ 判定形 aria 不成立才落无头 Chrome 渲染
// 单号全链失败不冒泡（review 抓出：一个号抛错会连坐后续号+快照不写+Chrome 残留）——返回空结果走合并保旧值
async function getResult(handle) {
  try {
    try {
      const r = await fetchResult(handle);
      if (ariaIsVerdict(r.aria)) return r;
      console.log(`  @${handle} HTTP 直取为加载态（无缓存终值），转无头 Chrome 渲染…`);
    } catch (e) { console.log(`  @${handle} HTTP 直取失败(${e.message.slice(0, 60)})，转无头 Chrome 渲染…`); }
    return await renderInChrome(handle);
  } catch (e) {
    console.log(`  @${handle} 无头 Chrome 渲染失败(${String(e.message || e).slice(0, 80)})，本号置空（保留快照旧值）`);
    return { url: `https://shadowbanradar.com/zh/r/${handle}`, text: '', aria: null, viaHttp: null }; // viaHttp:null=通道失败（kimi 复核：false 会被误标成无头Chrome通道）
  }
}

// 解析四维度：优先 aria-label（"搜索建议限制: 未见限制, …"），无 aria 时退回文本正则
// 值校验（10-19）：结论必须含 未见/检测到/正常 类字样——栏目标签、加载态清单不得当判定
// （实战：站点"暂时无法访问 X 数据"时页面只剩栏目骨架，曾把"搜索建议限制"标签当结论写入快照触发红告警）
const isVerdictValue = (v) => v && /未见|检测到|正常|not detected|detected/i.test(v);
function parseFour(text, aria) {
  const out = { suggestion: null, search: null, ghost: null, deboost: null };
  if (aria) {
    for (const part of aria.split(',')) {
      const m = part.match(/^\s*([^:：]+)[:：]\s*(.+?)\s*$/);
      if (!m) continue;
      const [k, v] = [m[1], m[2]];
      if (!isVerdictValue(v)) continue;
      if (/搜索建议|suggestion/i.test(k)) out.suggestion = v;
      else if (/搜索|search/i.test(k) && !/建议|suggestion/i.test(k)) out.search = v;
      else if (/回复隐藏|ghost/i.test(k)) out.ghost = v;
      else if (/回复排序|deboost/i.test(k)) out.deboost = v;
    }
  } else {
    const map = [['suggestion', /搜索建议[^\n]*/], ['search', /搜索封禁|搜索限制[^\n]*/], ['ghost', /幽灵封禁|回复隐藏[^\n]*/], ['deboost', /回复降权|回复排序[^\n]*/]];
    for (const [key, re] of map) { const m = text.match(re); out[key] = m && isVerdictValue(m[0]) ? m[0].slice(0, 120) : null; }
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
    const r = await getResult(h);
    console.log(`\n===== @${h}（${r.url}，${r.viaHttp ? 'HTTP直取' : '无头Chrome'}）=====`);
    if (DUMP) console.log(r.text.slice(0, 2600));
    const four = parseFour(r.text, ariaIsVerdict(r.aria) ? r.aria : null); // 加载态 aria 一律不当判定喂给解析器（10-19：曾把"正在计算"清单文本当判定写入快照）
    results[h] = { url: r.url, four, ariaRaw: ariaIsVerdict(r.aria) ? r.aria : null };
    console.log(JSON.stringify(four));
    await sleep(3000);
  }
  await closeChrome();
  if (CHECK) {
    const p = path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
    let snap = {};
    try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
    snap.checkedAt = snap.checkedAt || new Date().toISOString();
    // 逐号三态合并（10-21 事故修复：站点改版后解析全空，空值仍写进快照把"无数据"盖了一整天）：
    // 本次有值→用新值；本次空→当日旧值→昨日快照值；全空则记 channelError（报告可辨"站点故障"≠"账号无数据"）
    const prev = (snap.radar && snap.radar.results) || {};
    let prevDay = {};
    try {
      const d = new Date(Date.now() - 86400000);
      const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const ySnap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'health-snapshots', `${dayStr}.json`), 'utf8'));
      prevDay = ((ySnap.radar || {}).results) || {};
    } catch { }
    const okFour = (f) => f && Object.values(f).some((v) => v != null);
    const merged = {};
    let anyOk = false;
    // 合并键集=配置内号 ∪ 当日/昨日有真值的键（10-21 复核：--handles 子集扫描不得抹掉其他号——
    // 与 10-16 Owen 被覆盖事故同根；退役号（如 MacCostin5）不得以 channelError 形态自我复制）
    const allH = new Set([...RC.handles, ...Object.keys(prev).filter((h) => okFour(prev[h] && prev[h].four)), ...Object.keys(prevDay).filter((h) => okFour(prevDay[h] && prevDay[h].four))]);
    for (const h of allH) {
      if (okFour(results[h] && results[h].four)) { merged[h] = results[h]; anyOk = true; }
      else if (okFour(prev[h] && prev[h].four)) merged[h] = prev[h];
      else if (okFour(prevDay[h] && prevDay[h].four)) merged[h] = Object.assign({}, prevDay[h], { staleDay: true });
      else merged[h] = { url: (results[h] || {}).url, four: { suggestion: null, search: null, ghost: null, deboost: null, score: null, verdict: null, accountAgeDays: null }, ariaRaw: null, channelError: '站点改版/解析失败(10-21)' };
    }
    // fetchedAt 只在至少 1 号拿到真值时刷新——全空不刷新，TTL 层才会继续尝试现采
    snap.radar = { fetchedAt: anyOk ? new Date().toISOString() : ((snap.radar && snap.radar.fetchedAt) || new Date(Date.now() - 3600000).toISOString()), results: merged };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'radar', account: 'butcher', action: 'check', note: RC.handles.join(',') + ' 四维度判定' }) + '\n');
    console.log(`\n已写入 ${p} 的 radar 字段`);
  }
})().catch(async (e) => { await closeChrome().catch(() => { }); console.error(e.message || e); process.exit(1); });
