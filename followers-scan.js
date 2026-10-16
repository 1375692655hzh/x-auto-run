// followers-scan.js — 互关粉丝占比扫描（只读）：翻自己粉丝列表，统计"我也关注回去"的占比
// 用法: node followers-scan.js [--account=butcher,fullwin,...] [--jitter-min=N]（默认全部 watch 账号；jitter=随机延迟分钟数，调度用）
// 产出: state/health-snapshots/<今日>.json 的 accounts[key].mutual = { at, followersTotal, scanned, mutual, coverage, ratio }
//       + 审计日志 task='mutualScan'
// 调度: Xops互关扫描 每天 03:20（bat 带 --jitter-min=90 → 实际 03:20-04:50，落在你定的凌晨 2-5 点低峰窗口）
// 设计: 必须用每个号自己的窗口——互关状态（我是否关注了该粉丝）只有本人视角的按钮态是对的；
//       只读滚动浏览，不点任何按钮；PAUSE 生效即退出；比特浏览器不在线则当日跳过记日志。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }; // 本地(北京)日期——曾用 UTC 致凌晨任务写错日（10-17 互关扫描写入昨日快照，Codex 抓出）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);

const argKeys = ((process.argv.find((a) => a.startsWith('--account=')) || '').slice('--account='.length) || '').split(',').map((s) => s.trim()).filter(Boolean);
const jitterMin = parseInt((process.argv.find((a) => a.startsWith('--jitter-min=')) || '').slice('--jitter-min='.length) || '0', 10) || 0;

function logLine(obj) {
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');
}

async function openWindow(profileId) {
  const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }) }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j));
  return j.data.ws;
}

// 翻粉丝列表直到加载完（回弹触发懒加载后仍连续无新增）或到屏数上限；返回 Map(handle -> weFollow)
async function scanFollowers(page, maxScreens) {
  const seen = new Map();
  let stagnant = 0;
  for (let s = 0; s < maxScreens; s++) {
    const cells = await page.evaluate(() => {
      return [...document.querySelectorAll('[data-testid="UserCell"]')].map((c) => {
        const a = c.querySelector('a[href^="/"]');
        const handle = a ? a.getAttribute('href').replace(/^\//, '').split('/')[0].toLowerCase() : '';
        // 我是否关注了对方：按钮态为"正在关注"（testid 以 -unfollow 结尾）；-pending（已发请求）也计为已关注
        const weFollow = !!c.querySelector('button[data-testid$="-unfollow"], button[data-testid$="-pending"]');
        return { handle, weFollow };
      }).filter((x) => x.handle && x.handle !== 'i');
    }).catch(() => []);
    let fresh = 0;
    for (const c of cells) if (!seen.has(c.handle)) { seen.set(c.handle, c.weFollow); fresh++; }
    if (fresh === 0) {
      stagnant++;
      // X 虚拟列表懒加载有时中途停住：先上滑再回下拉触发它继续加载（最多回弹两轮）
      if (stagnant <= 2) {
        await page.evaluate(() => window.scrollBy(0, -700));
        await sleep(rand(600, 1200));
        await page.evaluate(() => window.scrollBy(0, 900));
        await sleep(rand(2800, 4200));
        continue;
      }
      if (stagnant >= 3) break;
    } else stagnant = 0;
    await page.evaluate(() => window.scrollBy(0, 1600 + Math.floor(Math.random() * 500)));
    await sleep(rand(2500, 4500));
  }
  return seen;
}

async function scanAccount(acct, snapshot) {
  const ws = await openWindow(acct.profileId);
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
      await page.goto(`https://x.com/${acct.handle}/followers`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-testid="UserCell"]', { timeout: 30000 }).catch(() => { });
      await sleep(rand(2000, 4000));
      const seen = await scanFollowers(page, 70);
      if (seen.size === 0) throw new Error('粉丝列表 0 格（登录态/加载异常）');
      const scanned = seen.size;
      const mutual = [...seen.values()].filter(Boolean).length;
      const entry = (snapshot.accounts || {})[acct.key] || {};
      const followersTotal = (entry.profile && entry.profile.followers != null) ? entry.profile.followers : scanned;
      const coverage = followersTotal > 0 ? Math.min(100, Math.round((scanned / followersTotal) * 100)) : null;
      const ratio = +(mutual / scanned).toFixed(4);
      return { at: new Date().toISOString(), followersTotal, scanned, mutual, coverage, ratio };
    } finally {
      await page.close().catch(() => { });
      await browser.disconnect().catch(() => { });
    }
  } finally {
    await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: acct.profileId }) }).catch(() => { });
  }
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效中，退出'); process.exit(0); }
  const targets = CFG.accounts.filter((a) => a.watch !== false && (!argKeys.length || argKeys.includes(a.key)));
  if (!targets.length) { console.error('无目标账号'); process.exit(1); }
  if (jitterMin > 0) {
    const d = rand(0, jitterMin * 60 * 1000);
    LOG(`随机延迟 ${Math.round(d / 60000)} 分钟后开始（凌晨低峰）`);
    await sleep(d);
  }
  const snapPath = path.join(STATE_DIR, 'health-snapshots', `${today()}.json`);
  for (const acct of targets) {
    try {
      LOG(`扫描 @${acct.handle}（${acct.key}）的粉丝列表…`);
      const snap = (() => { try { return JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch { return { accounts: {} }; } })();
      const res = await scanAccount(acct, snap);
      snap.accounts[acct.key] = snap.accounts[acct.key] || {};
      snap.accounts[acct.key].mutual = res;
      fs.mkdirSync(path.dirname(snapPath), { recursive: true });
      fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));
      logLine({ task: 'mutualScan', account: acct.key, action: 'scan', scanned: res.scanned, mutual: res.mutual, ratio: res.ratio, coverage: res.coverage });
      // lastScan 状态（10-18 拍板）：供 health.js 漂移±10% 触发补扫判断
      const stPath = path.join(STATE_DIR, 'mutual-scan-state.json');
      const mst = (() => { try { return JSON.parse(fs.readFileSync(stPath, 'utf8')); } catch { return {}; } })();
      mst.lastScan = mst.lastScan || {};
      mst.lastScan[acct.key] = { date: today(), followers: res.followersTotal, mutual: res.mutual };
      fs.writeFileSync(stPath, JSON.stringify(mst, null, 2));
      LOG(`@${acct.handle}: 互关 ${res.mutual}/${res.scanned}（占比 ${(res.ratio * 100).toFixed(1)}%，覆盖 ${res.coverage}%）已写入快照`);
    } catch (e) {
      LOG(`@${acct.handle} 失败/跳过: ${String(e.message).slice(0, 120)}`);
      logLine({ task: 'mutualScan', account: acct.key, action: 'skip', note: String(e.message).slice(0, 120) });
    }
    await sleep(rand(3000, 8000));
  }
  LOG('全部完成');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
