// insights.js — Owen 互动研究（只读）：扫 Owen 通知页，聚合"最近谁跟我互动最多"
// 规范依据: ./规范与约束.md §6.3（纯只读：不点赞、不回复、不关注、不发帖）
// 用法: node insights.js [--screens N] [--top N] [--days N] [--dry] [--force]
//   --dry   只抓取解析并打印报告，不写任何 state 文件
//   --force 越过 09:00-22:00 执行窗（仅人工排查用）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const INS = CFG.insights;
const STATE_DIR = path.join(ROOT, 'state');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const SCREENS = parseInt(argOf('screens', String(INS.maxScreens)), 10);
const TOPN = parseInt(argOf('top', String(INS.topN)), 10);
const DAYS = parseInt(argOf('days', String(INS.recentDays)), 10);

// ── 工具（与 boost.js 同款拟人滚动） ──────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
async function humanScroll(page, totalPx) {
  const segs = 5 + Math.floor(Math.random() * 8);
  for (let i = 0; i < segs; i++) {
    const px = (totalPx / segs) * (0.7 + Math.random() * 0.6);
    await page.evaluate((p) => window.scrollBy({ top: p, behavior: 'smooth' }), px);
    await sleep(100 + Math.random() * 300);
  }
  if (Math.random() < 0.15) {
    await page.evaluate((p) => window.scrollBy({ top: -p, behavior: 'smooth' }), totalPx * 0.4);
    await sleep(600 + Math.random() * 1200);
  }
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── 比特浏览器 ──────────────────────────────────────────
async function openWindow(profileId) {
  const j = await fetch(CFG.bitbrowser + '/browser/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }),
  }).then((r) => r.json());
  if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j));
  return j.data.ws;
}
async function closeWindow(profileId) {
  await fetch(CFG.bitbrowser + '/browser/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }),
  });
}

// ── 通知解析 ──────────────────────────────────────────────
// Owen 窗口是繁中界面（"已喜歡你的貼文/回覆"、"和其他 21 人已跟隨你"），butcher 等窗口是简中；正则繁简 + 英文三兼容
// 注意顺序：「已喜歡你的回覆」是 like 不是 reply，like 必须先判
function parseNotif(raw, selfHandle) {
  const t = raw.text;
  let type = 'other';
  if (/喜歡|喜欢|liked/i.test(t)) type = 'like';
  else if (/跟隨你|跟随你|followed you|关注了你/i.test(t)) type = 'follow';
  else if (/提到了|mentioned/i.test(t)) type = 'mention';
  else if (/轉發|转发|reposted/i.test(t)) type = 'repost';
  else if (/引用了|quoted/i.test(t)) type = 'quote';
  else if (/回覆|回复|replied/i.test(t)) type = 'reply';
  const others = (t.match(/和(?:其他|另外)\s*(\d+)\s*(?:人|位)/) || t.match(/and\s+(\d+)\s+others/i) || [])[1];
  const handles = raw.handles.filter((h) => h !== selfHandle);
  const fp = raw.handles.join(',') + '|' + type + '|' + t.slice(0, 60); // 通知级指纹（跨 run 去重）
  return { type, at: raw.at, handles, names: raw.names, others: others ? parseInt(others, 10) : 0, text: t, fp };
}

// 页面侧提取一条通知的结构（防御式：无 time 无用户链接的杂项 cell 直接丢）
// 通知条目 testid = "notification"（2026-10 实测；列表容器是 cellInnerDiv）
async function readNotifs(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-testid="notification"]')].map((el) => {
      const time = el.querySelector('time');
      const text = clean(el.innerText).slice(0, 220);
      const names = {};
      for (const a of el.querySelectorAll('a[href^="/"]')) {
        const href = a.getAttribute('href') || '';
        if (!/^\/[A-Za-z0-9_]{1,15}$/.test(href)) continue;
        const h = href.slice(1).toLowerCase();
        const n = clean(a.textContent);
        if (!(h in names) && n && !n.startsWith('@')) names[h] = n; // 有文字的链接 = 显示名
        else if (!(h in names)) names[h] = null; // 头像链接占位
      }
      return { at: time ? time.getAttribute('datetime') : null, text, handles: Object.keys(names), names };
    }).filter((n) => n.at || n.handles.length);
  }).catch(() => []);
}

// ── 累积库（跨 run 通知指纹去重 + 按人聚合） ──────────────
function loadCum() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'owen-insights.json'), 'utf8'));
    return { updated: null, people: {}, seen: [], runs: [], ...c };
  } catch { return { updated: null, people: {}, seen: [], runs: [] }; }
}
function saveCum(c) {
  c.updated = new Date().toISOString();
  c.seen = c.seen.slice(-5000); // 指纹集封顶，防无限膨胀
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'owen-insights.json'), JSON.stringify(c, null, 2));
}
function mergeCum(cum, notifs) {
  const known = new Set(cum.seen);
  let added = 0;
  const fresh = [];
  const localDay = (iso) => { // 通知 datetime 是 UTC，统计口径用本地日期
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  for (const n of notifs) {
    if (known.has(n.fp)) continue;
    known.add(n.fp); cum.seen.push(n.fp); added += 1; fresh.push(n);
    const day = n.at ? localDay(n.at) : null;
    for (const h of n.handles) {
      const p = (cum.people[h] = cum.people[h] || { handle: h, name: null, total: 0, types: {}, ev: [], lastAt: null, firstSeen: null });
      p.total += 1;
      p.types[n.type] = (p.types[n.type] || 0) + 1;
      if (day) { p.ev.push([day, n.type]); p.ev = p.ev.slice(-60); }
      if (!p.lastAt || (n.at && n.at > p.lastAt)) p.lastAt = n.at;
      if (!p.firstSeen || (n.at && n.at < p.firstSeen)) p.firstSeen = n.at;
      if (!p.name && n.names[h]) p.name = n.names[h];
    }
  }
  return { added, fresh };
}

// ── 报告 ──────────────────────────────────────────────
const fmtDT = (iso) => { // 通知 datetime 是 UTC，展示转本地
  if (!iso) return '-';
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function recentCount(p, days) {
  const cutoff = today(); // 简化：直接比日期字符串
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return p.ev.filter(([d]) => d >= from && d <= cutoff).length;
}
const TYPE_CN = { like: '赞', reply: '回', repost: '转', follow: '关', mention: '提', quote: '引', other: '他' };
// 自家矩阵号在报告里标记出来（它们的出现是 boost 任务的效果，不算自然互动）
const OWN = new Set([INS.handle.toLowerCase(), CFG.target.handle.toLowerCase(), ...CFG.accounts.map((a) => a.handle.toLowerCase())]);
const ownTag = (h) => OWN.has(h) ? ' ←自家号' : '';

// ── 主流程 ──────────────────────────────────────────────
(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) {
    console.error('检测到 state/PAUSE —— 全局急停开关生效中，本次不执行（删除该文件恢复）');
    process.exit(0);
  }
  const h = new Date().getHours();
  if (!DRY && !FORCE && (h < CFG.limits.activeHours[0] || h >= CFG.limits.activeHours[1])) {
    console.error(`当前不在执行窗 ${CFG.limits.activeHours[0]}:00-${CFG.limits.activeHours[1]}:00，跳过（--force 可越过）`);
    process.exit(1);
  }
  const deadline = Date.now() + INS.maxSessionMinutes * 60000;
  const self = INS.handle.toLowerCase();
  let ws = null;
  const out = { ranAt: new Date().toISOString(), account: self, screens: SCREENS };

  try {
    ws = await openWindow(INS.profileId);
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const page = await browser.newPage();
    try {
      // 登录态校验（同 boost.js）
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForSelector('a[data-testid="AppTabBar_Profile_Link"]', { timeout: 20000 }); } catch { throw new Error('登录态校验失败：未找到 profile 链接'); }
      const href = await page.evaluate(() => {
        const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return a ? a.getAttribute('href') : null;
      });
      if (!href || href.toLowerCase() !== '/' + self) throw new Error(`登录态校验失败：期望 @${INS.handle}，实际 ${href}`);
      console.log(`[insights] 登录态 OK (@${INS.handle})`);

      // 轻热身：先在主页刷 10-25s 再进通知页（拟人动线）
      const warm = Date.now() + rand(10000, 25000);
      while (Date.now() < warm) { await humanScroll(page, rand(300, 700)); await sleep(rand(700, 1600)); }

      // 进通知页（全部 tab，含赞/回复/转发/关注/提及），加载失败重试一次
      let ok = false;
      for (let i = 0; i < 2 && !ok; i++) {
        try {
          await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('[data-testid="notification"]', { timeout: 45000 });
          ok = true;
        } catch { if (i === 0) await sleep(3000); }
      }
      if (!ok) throw new Error('通知页加载失败');
      await sleep(2500);

      // 逐屏抓取 + 去重
      const seen = new Set();
      const raws = [];
      for (let s = 0; s < SCREENS; s++) {
        if (Date.now() > deadline) { out.stopped = '会话超时收尾'; break; }
        for (const r of await readNotifs(page)) {
          if (!seen.has(r.text + '|' + (r.at || ''))) { seen.add(r.text + '|' + (r.at || '')); raws.push(r); }
        }
        await humanScroll(page, rand(600, 1000));
        await sleep(rand(900, 2200));
      }
      out.cells = raws.length;

      // 解析 → 指纹去重 merge 进累积库
      const notifs = raws.map((r) => parseNotif(r, self));
      const cum = loadCum();
      const { added, fresh } = mergeCum(cum, notifs);
      out.newNotifs = added;
      out.window = {
        oldest: notifs.map((n) => n.at).filter(Boolean).sort()[0] || null,
        newest: notifs.map((n) => n.at).filter(Boolean).sort().pop() || null,
      };
      out.byType = notifs.reduce((m, n) => { m[n.type] = (m[n.type] || 0) + 1; return m; }, {});
      out.hiddenOthers = notifs.reduce((s, n) => s + n.others, 0); // "和另外 N 人"折叠掉的互动量

      // 近 N 天排行（本次快照口径 + 累积库口径）
      const people = {};
      for (const n of notifs) for (const h of n.handles) {
        const p = (people[h] = people[h] || { handle: h, name: n.names[h] || null, total: 0, types: {}, lastAt: null });
        p.total += 1; p.types[n.type] = (p.types[n.type] || 0) + 1;
        if (!p.lastAt || (n.at && n.at > p.lastAt)) p.lastAt = n.at;
        if (!p.name && n.names[h]) p.name = n.names[h];
      }
      const rank = Object.values(people).filter((p) => p.total > 0)
        .sort((a, b) => b.total - a.total || (b.lastAt || '').localeCompare(a.lastAt || '')).slice(0, TOPN);
      const rankCum = Object.values(cum.people)
        .map((p) => ({ handle: p.handle, name: p.name, recent: recentCount(p, DAYS), total: p.total, types: p.types, lastAt: p.lastAt }))
        .filter((p) => p.recent > 0)
        .sort((a, b) => b.recent - a.recent || (b.lastAt || '').localeCompare(a.lastAt || '')).slice(0, TOPN);

      // 落盘：当日快照 + 累积库 + 审计日志（dry 全不写）
      if (!DRY) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        out.snapshotRank = rank;
        out.cumulativeRank = rankCum;
        fs.writeFileSync(path.join(STATE_DIR, `insights-${today()}.json`), JSON.stringify(out, null, 2));
        cum.runs.push({ at: out.ranAt, screens: SCREENS, cells: out.cells, added });
        cum.runs = cum.runs.slice(-60);
        saveCum(cum);
        fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`),
          JSON.stringify({ at: out.ranAt, account: 'owen', task: 'insights', screens: SCREENS, cells: out.cells, added, dry: false }) + '\n');
      }

      // ── 控制台报告 ──
      console.log('\n===== Owen 互动研究报告（' + today() + (DRY ? ' DRY' : '') + '）=====');
      console.log(`抓取: ${SCREENS} 屏 / ${out.cells} 条通知（新 ${added}，重复 ${out.cells - added}）` +
        (out.hiddenOthers ? `；折叠的"另外N人"互动 ${out.hiddenOthers} 次` : ''));
      console.log(`覆盖: ${(out.window.oldest || '?').slice(0, 16)} ~ ${(out.window.newest || '?').slice(0, 16)}`);
      console.log('类型分布: ' + Object.entries(out.byType).map(([k, v]) => `${TYPE_CN[k] || k} ${v}`).join(' · '));
      console.log(`\n── 本次快照 Top ${rank.length}（本次抓到的互动）──`);
      for (let i = 0; i < rank.length; i++) {
        const p = rank[i];
        const ty = Object.entries(p.types).map(([k, v]) => (TYPE_CN[k] || k) + v).join(' ');
        console.log(`${String(i + 1).padStart(2)}. @${p.handle.padEnd(16)} ${String(p.total).padStart(3)} 次  ${ty}  最近 ${fmtDT(p.lastAt)}${p.name ? '  ' + p.name : ''}${ownTag(p.handle)}`);
      }
      console.log(`\n── 近 ${DAYS} 天 Top ${rankCum.length}（累积库口径，共 ${Object.keys(cum.people).length} 人）──`);
      for (let i = 0; i < rankCum.length; i++) {
        const p = rankCum[i];
        const ty = Object.entries(p.types).map(([k, v]) => (TYPE_CN[k] || k) + v).join(' ');
        console.log(`${String(i + 1).padStart(2)}. @${p.handle.padEnd(16)} 近${DAYS}天 ${String(p.recent).padStart(3)} / 累积 ${String(p.total).padStart(3)}  ${ty}  最近 ${fmtDT(p.lastAt)}${ownTag(p.handle)}`);
      }
      const newFaces = [...new Set(fresh.flatMap((n) => n.handles))].filter((x) => fresh.filter((n) => n.handles.includes(x)).length >= 2);
      if (newFaces.length) console.log('\n本次新入榜（此前未记录，今日互动≥2次）: ' + newFaces.map((x) => '@' + x).join(', '));
      if (out.stopped) console.log('注意: ' + out.stopped);
    } finally {
      try { await page.close(); } catch { }
      await browser.disconnect(); // 10-18 修复：先关页面
    }
  } catch (e) {
    console.error('[insights] 出错: ' + e.message);
    process.exitCode = 1;
  } finally {
    if (ws) await closeWindow(INS.profileId).catch(() => {});
  }
})();
