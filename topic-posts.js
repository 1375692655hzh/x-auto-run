// topic-posts.js — 互关帖全程预制+定时发布（10-20 拍板终版）
// 用法: node topic-posts.js --account fullwin [--dry]
// 05:50 计划任务拉起（Xops互关帖预制-fullwin）：
//   ① 开窗口深滚 #蓝V互关 抓近 24h 参考池（滚动至 24h 前帖出现为止）
//   ② mimo 成批生成 10 条互关帖正文（分时段语气：早盘/上午/午间/午后/晚间/复盘/深夜），质量门把关
//   ③ 程序化强附六 tag（不依赖 LLM）
//   ④ 写队列 queue/<日期>-topic-<账号>.json，postAt=每 2h 整点 ±0~45min 随机
//   ⑤ 进程驻留，到点 spawn executor --entry（ENTRY_ID 豁免守窗门）
// 失败原则：参考池抓空/LLM 全灭 → 当天不发（宁缺）；单条质量门不过 → 重生一次仍不过 → 该槽跳过
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateReply } = require('./llm');
const { closeWindowIfFree } = require('./resident-guard');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const QUEUE_DIR = path.join(ROOT, 'queue');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'fullwin');
const ACCT = (CFG.accounts || []).find((a) => a.key === ACCOUNT);
const TC = Object.assign({
  topic: '蓝V互关', points: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24], jitterMin: 45,
  postTags: ['#蓝V互关', '#蓝朋友', '#浇朋友', '#浇个朋友', '#交个朋友', '#交朋友'],
  llmChannel: 'mimo', refHours: 24, scanScrolls: 14,
}, ((CFG.resident || {})[ACCOUNT] || {}).topicPosts || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowIso = () => new Date().toISOString();
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function audit(obj) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), task: 'topicPosts', account: ACCOUNT, ...obj }) + '\n'); }
function ledgerRecord(type) {
  const f = path.join(STATE_DIR, `ledger-${ACCOUNT}.json`);
  const cut = Date.now() - 24 * 3600000;
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = { actions: {}, meta: {} }; }
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  (j.actions[type] = j.actions[type] || []).push(Date.now());
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
}

// 时段语气（拍板：预制的帖要有一点时间属性）
const TONE = (h) => h < 8 ? '清晨开盘前：一天的开始，从容立计划' : h < 12 ? '上午盘中：盯盘中的即时感想' : h < 14 ? '午间：上半场小结的轻松口吻' : h < 18 ? '午后盘中：耐心和纪律' : h < 20 ? '傍晚：收盘前后的一天收束感' : h < 22 ? '晚间复盘：把判断摊开复盘' : '深夜：安静的自我整理';

// ① 抓 24h 参考池：云端互关话题池 API 优先（10-21 拍板换源——grok bot 阿里云部署，带互动计数可按热度排序，零窗口）；
//   失败回退本地浏览器深滚（保底链）
const XM = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'x-mutual.json'), 'utf8')); } catch { return null; } })();
async function collectMaterialApi() {
  if (!XM || !XM.base || !XM.key) return null;
  const r = await fetch(`${XM.base}/v1/posts?hours=${TC.refHours}&limit=80&exclude_rt=1`, { headers: { Authorization: 'Bearer ' + XM.key }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('云端池 http ' + r.status);
  const j = await r.json();
  const posts = (j.posts || []).filter((p) => p && p.text && p.author && p.author.username && !p.is_retweet);
  return posts
    .sort((a, b) => (((b.metrics && (b.metrics.like_count + b.metrics.reply_count)) || 0) - ((a.metrics && (a.metrics.like_count + a.metrics.reply_count)) || 0)))
    .map((p) => ({ author: p.author.username, text: String(p.text).replace(/\s+/g, ' ').trim().slice(0, 200), time: p.created_at, id: p.id, url: p.url, likes: (p.metrics && p.metrics.like_count) || 0, replies: (p.metrics && p.metrics.reply_count) || 0 }));
}

// ①-b 本地浏览器深滚（回退链，API 不可用才走）
async function collectMaterialBrowser() {
  const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j).slice(0, 80));
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null, protocolTimeout: 90000 });
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿模态框自动离开
  try {
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`https://x.com/search?q=${encodeURIComponent('#' + TC.topic)}&f=live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    await sleep(2500);
    const pool = new Map();
    const cutoff = Date.now() - TC.refHours * 3600000;
    for (let i = 0; i < TC.scanScrolls; i++) {
      const batch = await page.evaluate(() => [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => {
        const t = a.querySelector('time');
        const te = a.querySelector('[data-testid="tweetText"]');
        const ne = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
        return { time: t ? t.getAttribute('datetime') : null, text: te ? (te.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '', author: ne ? (ne.getAttribute('href') || '').replace('/', '').split('/')[0] : null };
      }));
      for (const p of batch) if (p.time && p.text) pool.set(p.time + '|' + p.author, p);
      const oldest = Math.min(...[...pool.values()].map((p) => Date.parse(p.time)).filter(Number.isFinite));
      if (pool.size > 40 && oldest < cutoff) break; // 覆盖到 24h 前且量够
      await page.evaluate(() => window.scrollBy(0, 900 + Math.floor(Math.random() * 400))).catch(() => { });
      await sleep(rand(1200, 2000));
    }
    return [...pool.values()];
  } finally {
    try { await page.close(); } catch { }
    await browser.disconnect();
    await closeWindowIfFree(ACCOUNT, ACCT.profileId); // 10-21：常驻在场不关窗（防拆 fullwin 工位）
  }
}

async function collectMaterial() {
  try {
    const m = await collectMaterialApi();
    if (m && m.length) { LOG(`参考池=云端池 API：${m.length} 条（24h，按互动热度排序）`); audit({ action: 'material', source: 'api', count: m.length }); return m; }
    LOG('云端池空/未配置，回退浏览器深滚');
  } catch (e) { LOG('云端池失败(' + String(e.message).slice(0, 50) + ')，回退浏览器深滚'); audit({ action: 'material', source: 'api-fail', note: String(e.message).slice(0, 60) }); }
  return collectMaterialBrowser();
}

// ② 生成一条（质量门不过重生一次，仍不过跳过该槽）
async function genOne(point, material) {
  const mat = material.slice(0, 10).map((m) => `- @${m.author}: ${m.text.slice(0, 60)}`).join('\n');
  const brief = `写一条互关帖正文（${TONE(point % 24)}）；一两句话表明认真做交易/看盘的人求互相关注、必回访；可借话题池语气但不得照抄；结尾句号；不要写任何 # 标签（系统会自动附加）。40~100 字。参考池：\n${mat}`;
  for (let i = 0; i < 2; i++) {
    const r = await generateReply({ post: mat || '（参考池为空）', persona: (CFG.personas || {})[ACCOUNT], brief, history: [], channel: TC.llmChannel }).catch(() => null);
    const qc = r && r.text ? quality.check(r.text, {}) : null;
    if (qc && qc.ok) return (qc.cleaned || '').trim().replace(/[＃#][^\s＃#，。！？、]+/g, '').trim();
    LOG(`  ${point}点槽 生成未过门(${qc ? qc.reason : 'LLM失败'})${i === 0 ? '，重生一次' : ''}`);
  }
  return null;
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效，退出'); process.exit(0); }
  LOG(`互关帖预制启动（@${ACCT.handle}，${TC.points.join('/')}`);
  const material = await collectMaterial().catch((e) => { LOG('参考池抓取失败: ' + e.message.slice(0, 60)); return null; });
  if (!material || !material.length) { audit({ action: 'topicGen', status: 'failed', note: '参考池为空，当天不发' }); LOG('参考池为空，当天不发'); process.exit(1); }
  LOG(`参考池 ${material.length} 条（近 ${TC.refHours}h）`);

  // ④ postAt 时刻表（整点±0~45min，24 点=次日 00:00）
  const entries = [];
  for (const point of TC.points) {
    const base = new Date(); base.setHours(point % 24, 0, 0, 0); if (point >= 24) base.setDate(base.getDate() + 1);
    let postAt = base.getTime() + Math.round(rand(-TC.jitterMin, TC.jitterMin)) * 60000;
    if (postAt < Date.now() + 8 * 60000) postAt = Date.now() + rand(8, 20) * 60000; // 过去的槽/太近的就近排
    entries.push({ point, postAt });
  }
  entries.sort((a, b) => a.postAt - b.postAt);

  const qFile = path.join(QUEUE_DIR, `${today()}-topic-${ACCOUNT}.json`);
  const queue = [];
  for (let i = 0; i < entries.length; i++) {
    const { point, postAt } = entries[i];
    LOG(`生成 ${point} 点槽（定时 ${new Date(postAt).toTimeString().slice(0, 5)}）…`);
    const body = await genOne(point, material);
    if (!body) { audit({ action: 'topicGen', status: 'skipped', note: `${point}点槽两次未过门` }); continue; }
    const text = body + '\n\n' + TC.postTags.join(' ');
    if (DRY) { LOG(`[DRY] ${point}点槽: ${text.slice(0, 60)}…`); continue; }
    queue.push({ id: `${today()}-topic-${ACCOUNT}-${i + 1}`, account: ACCOUNT, type: 'post', kind: 'topic-post', text, window: 'topic', postAt: new Date(postAt).toISOString(), status: 'planned', createdAt: nowIso() });
  }
  if (DRY) { LOG(`[DRY] 共 ${entries.length} 槽预览完毕，不写队列不拉起`); process.exit(0); }
  if (!queue.length) { audit({ action: 'topicGen', status: 'failed', note: '全部槽未过质量门，当天不发' }); process.exit(1); }
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.writeFileSync(qFile, JSON.stringify(queue, null, 2));
  audit({ action: 'topicGen', count: queue.length, note: '预制完成' });
  LOG(`预制完成 ${queue.length} 条 → ${path.basename(qFile)}，进程驻留到点发布`);

  // ⑤ 驻留定时拉起
  for (const e of queue) {
    const delay = Math.max(0, Date.parse(e.postAt) - Date.now());
    LOG(`[定时] ${e.id} → ${new Date(e.postAt).toTimeString().slice(0, 8)}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(() => {
      LOG(`到点发布 ${e.id}`);
      spawnSync(process.execPath, [path.join(ROOT, 'executor.js'), '--account', ACCOUNT, '--queue', qFile, '--entry', e.id], { cwd: ROOT, stdio: 'inherit' });
      ledgerRecord('postTopic'); ledgerRecord('post');
    }, delay);
  }
  const lastMs = Math.max(...queue.map((e) => Date.parse(e.postAt))) - Date.now() + 10 * 60000;
  setTimeout(() => { LOG('全部槽已拉起，预制进程退出'); process.exit(0); }, Math.max(lastMs, 60 * 1000));
})().catch((e) => { console.error('FATAL:', e.message || e); audit({ action: 'topicGen', status: 'fatal', note: String(e.message || e).slice(0, 100) }); process.exit(1); });
