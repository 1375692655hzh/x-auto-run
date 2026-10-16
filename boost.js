// ⛔ 已退役（2026-10-17，权重维护计划 v1.1 拍板①）：本文件不再被任何定时任务调用，仅留档。
//    接替者=权重维护侦测器 maintain-watch.js（挑帖制/仅点赞/低频回复，走统一管线）。
//    ZCode 自动化页面里的旧 10:00 灰度轮（早已暂停）可删除。
// boost.js — 大号给 @Owenwin888 做权重（爱心→书签→复制链接→回复，无转发）+ 社群互关回复
// 规范依据: ./规范与约束.md（改约束先改文档再改代码）
// 用法: node boost.js [--account butcher|fullwin|both] [--task 1|2|all] [--dry] [--force]
//                    [--max-posts N] [--max-replies N]
//   --dry  演练模式：不点击、不输入、不写状态、不热身
//   --force 越过 09:00-22:00 执行窗（仅人工排查用）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const L = CFG.limits;

const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const ACCOUNT = argOf('account', 'both');
const TASK = argOf('task', 'all');
const MAX_POSTS = parseInt(argOf('max-posts', String(CFG.target.maxPostsPerRun)), 10);
const MAX_REPLIES = parseInt(argOf('max-replies', String(CFG.task2.repliesPerDay)), 10);

// ── 基础工具 ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// 高斯随机（Box-Muller）：拟人时序的核心，拒绝均匀分布
function gauss(mean, sd) {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(mean * 0.2, mean + z * sd);
}
const gsleep = (pair) => sleep(gauss(pair[0], pair[1]));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const SEL = {
  article: 'article[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
  like: '[data-testid="like"]',
  unlike: '[data-testid="unlike"]',
  reply: '[data-testid="reply"]',
  share: 'button[aria-label*="分享"], button[aria-label*="Share"], button[aria-label*="共有"], [data-testid="share"]',
  bookmarkBtn: '[data-testid="bookmark"]',
  replyBox: '[data-testid="tweetTextarea_0"]',
  tweetButton: '[data-testid="tweetButton"]',
  toast: '[data-testid="toast"]',
  profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
};
const MENU_BOOKMARK = ['bookmark', '书签', 'ブックマーク'];
const MENU_COPYLINK = ['copy link', '复制链接', 'コピー'];
const RISK_TOAST = /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block|エラー|もう一度|制限|できません/i;

// ── 状态（跨会话去重 + 每日计数 + 熔断标记） ─────────────
function blankState() {
  return { owen: {}, community: {}, communityAuthors: {}, tplUse: {}, daily: {}, tagIndex: 0, graph: {}, follows: {}, followBackDone: {}, pendingFollows: {} };
}
function loadState(key) {
  const p = path.join(STATE_DIR, key + '.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return blankState(); throw e; } // 首次运行无文件 = 正常
  let st = null;
  try { st = JSON.parse(raw); } catch { /* fallthrough */ }
  if (!st || typeof st !== 'object' || Array.isArray(st)) {
    // fail-closed（2026-10-15 P0）：状态损坏时去重/额度记录不可信，备份后终止，绝不带空白状态继续写动作
    try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch { }
    throw new Error(`状态文件损坏（已备份为 ${p}.corrupt-*），终止运行：${p}`);
  }
  return { ...blankState(), ...st };
}
function saveState(key, st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, key + '.json'), JSON.stringify(st, null, 2));
}
function day(state) { return (state.daily[today()] = state.daily[today()] || { abort: {} }); }
function capLeft(state, type) {
  // fail-closed（2026-10-15 P0）：未配置或 ≤0 的动作类型一律视为无额度（原 `|| 99` 会把 0 帽放大成 99）
  const cap = L.dailyCaps[type];
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return cap - (day(state)[type] || 0);
}
function capUse(state, type, n = 1) { day(state)[type] = (day(state)[type] || 0) + n; }
function appendLog(line) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), dry: DRY, ...line }) + '\n');
}

// 模板轮换：同号不连续复用 + 同模板冷却 N 天（防字符串指纹）
// cooldownPolicy（2026-10-15 P0）：'hard' = 池内无合格模板返回 null（调用方跳过该条回复）；
// 'soft' = 现行回退行为。默认 soft：现有模板池小（4-6 条）配 7 天冷却，硬模式会把社区回复压到 ~1 条/天，
// 属行为变更，P0 只加开关不改行为；P2 LLM 生成上线后切 hard。
function pickTemplate(pool, poolKey, state) {
  const use = (state.tplUse = state.tplUse || {});
  const pu = (use[poolKey] = use[poolKey] || { last: null, used: {} });
  let cands = pool.filter((t) => t !== pu.last && dayDiff(pu.used[t] || '2000-01-01', today()) >= L.templateCooldownDays);
  if (!cands.length && (L.templateCooldownPolicy || 'soft') === 'hard') return null;
  if (!cands.length) cands = pool.filter((t) => t !== pu.last);
  if (!cands.length) cands = pool;
  const t = pick(cands);
  if (!DRY) { pu.last = t; pu.used[t] = today(); }
  return t;
}

// 熔断器：同类动作连续失败 N 次当日停用
function breaker(state, type, ok) {
  const d = day(state);
  d.fail = d.fail || {};
  d.fail[type] = ok ? 0 : (d.fail[type] || 0) + 1;
  if (d.fail[type] >= L.consecutiveFailAbort) { d.abort[type] = true; return true; }
  return !!(d.abort && d.abort[type]);
}
const aborted = (state, type) => !!(day(state).abort || {})[type];

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

// ── 拟人行为原语 ────────────────────────────────────────
// 变速滚动：分段 + 段长抖动 + 偶发回看
async function humanScroll(page, totalPx) {
  const segs = 5 + Math.floor(Math.random() * 8);
  for (let i = 0; i < segs; i++) {
    const px = (totalPx / segs) * (0.7 + Math.random() * 0.6);
    await page.evaluate((p) => window.scrollBy({ top: p, behavior: 'smooth' }), px);
    await sleep(100 + Math.random() * 300);
  }
  if (Math.random() < 0.15) { // 偶发"再看一眼"
    await page.evaluate((p) => window.scrollBy({ top: -p, behavior: 'smooth' }), totalPx * 0.4);
    await sleep(600 + Math.random() * 1200);
  }
}

// 点击前先鼠标移过去 hover 一会儿（真实鼠标事件，非 JS 直调 click）
async function humanClick(page, handle) {
  try {
    const bb = await handle.boundingBox();
    if (bb) {
      const tx = bb.x + bb.width * (0.3 + Math.random() * 0.4);
      const ty = bb.y + bb.height * (0.3 + Math.random() * 0.4);
      await page.mouse.move(tx, ty, { steps: 6 + Math.floor(Math.random() * 8) });
      await sleep(rand(...CFG.pacing.hoverMs));
    }
  } catch { /* 元素不在视口时直接点 */ }
  await handle.click();
}

// 会话热身：先像真人一样刷一会儿主页
async function warmUp(page, stats) {
  if (DRY) { stats.warmup = 'dry跳过'; return; }
  const started = Date.now();
  const end = started + rand(...CFG.pacing.warmupMs);
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(SEL.article, { timeout: 45000 }).catch(() => {});
  let rounds = 0;
  while (Date.now() < end) {
    await humanScroll(page, rand(300, 900));
    await sleep(rand(800, 2500));
    rounds += 1;
  }
  stats.warmup = `${Math.round((Date.now() - started) / 1000)}s/${rounds}轮`;
}

// ── 页面动作 ────────────────────────────────────────────
// 登录态校验：优先左侧导航链接；部分窗口布局不渲染该元素，回退用 CDP 读 twid 反查
async function verifyLogin(page, handle) {
  try {
    await page.waitForSelector(SEL.profileLink, { timeout: 15000 });
    const href = await page.evaluate((sel) => {
      const a = document.querySelector(sel);
      return a ? a.getAttribute('href') : null;
    }, SEL.profileLink).catch(() => null);
    if (href && href.toLowerCase() === '/' + handle.toLowerCase()) return true;
  } catch { /* 走兜底 */ }
  try {
    const client = await page.createCDPSession();
    const { cookies } = await client.send('Network.getCookies', { urls: ['https://x.com'] });
    const twid = (cookies.find((c) => c.name === 'twid') || {}).value || '';
    const m = decodeURIComponent(twid).match(/u=(\d+)/);
    if (!m) return false;
    await page.goto('https://x.com/intent/user?user_id=' + m[1], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    return decodeURIComponent(page.url()).toLowerCase().includes('screen_name=' + handle.toLowerCase());
  } catch { return false; }
}

// 分享菜单里按文案找项点击（中英文）
async function clickShareMenuItem(page, texts, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate((tx) => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const el = items.find((n) => { const t = (n.textContent || '').toLowerCase(); return tx.some((x) => t.includes(x)); });
      if (el) { el.click(); return true; }
      return false;
    }, texts).catch(() => false);
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function readToast(page) {
  return page.evaluate((sel) => {
    const t = document.querySelector(sel);
    return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null;
  }, SEL.toast).catch(() => null);
}
async function riskToast(page) { const t = await readToast(page); return (t && RISK_TOAST.test(t)) ? t : null; }

// 合成 paste 事件输入中文（Draft 编辑器对 execCommand 会重复插入）
async function typeReply(page, text) {
  return page.evaluate((sel, t) => {
    const all = document.querySelectorAll(sel);
    const el = document.querySelector('[role="dialog"] ' + sel) || all[all.length - 1];
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, SEL.replyBox, text).catch(() => false);
}

async function submitReply(page) {
  const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false);
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    let b = null;
    if (dlg) {
      const btns = [...dlg.querySelectorAll('[data-testid="tweetButton"]')];
      b = btns[btns.length - 1]; // 弹窗模式：弹窗内提交按钮
    } else {
      b = document.querySelector('[data-testid="tweetButtonInline"]'); // 内联模式：底部输入条提交按钮
    }
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click();
    return true;
  }).catch(() => false);
  if (!clicked) return false;
  // 成功判定（2026-10-15 P0 收紧）：只有成功 toast 才算确认成功；
  // 弹窗关闭/输入框清空只说明"可能已发出" → 返回 'unknown'，调用方按已发出处理（占额度、防重试、标记待核）
  const readSt = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="tweetTextarea_0"]');
    return {
      dlg: !!document.querySelector('[role="dialog"]'),
      toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(),
      boxLen: box && box.textContent ? box.textContent.length : 0,
    };
  }).catch(() => null);
  const okToast = (t) => /已发送|发过了|送信|already|posted|sent/i.test(t || '');
  const waitToast = async (ms) => { // 界面消失后再宽限等 toast（成功提示常晚于弹窗关闭出现）
    for (let j = 0; j < Math.ceil(ms / 500); j++) {
      await sleep(500);
      const st2 = await readSt();
      if (st2 && okToast(st2.toast)) return true;
    }
    return false;
  };
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await readSt();
    if (!st) continue;
    if (okToast(st.toast)) return true;
    if (hasDialog && !st.dlg) return (await waitToast(4000)) || 'unknown'; // 弹窗关闭 ≠ 成功
    if (!hasDialog && st.boxLen === 0) return (await waitToast(4000)) || 'unknown'; // 输入框清空 ≠ 成功
  }
  return false;
}

async function collectPosts(page, limit = 20) {
  return page.evaluate((sel, limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll(sel.article)].slice(0, limit).map((art) => {
      const link = art.querySelector('a[href*="/status"]');
      const time = art.querySelector('time');
      const text = art.querySelector(sel.tweetText);
      const nameEl = art.querySelector(sel.userName + ' a[href^="/"]');
      return {
        id: (link && (link.getAttribute('href').match(/\/status\/(\d+)/) || [])[1]) || null,
        link: link ? link.getAttribute('href') : null,
        time: time ? time.getAttribute('datetime') : null,
        text: text ? clean(text.textContent).slice(0, 300) : '',
        author: nameEl ? nameEl.getAttribute('href').replace(/^\//, '').toLowerCase() : null,
        locked: [...art.querySelectorAll('button, [role="button"]')].some((b) => /subscribe to unlock|订阅.{0,2}解锁|ロック解除/i.test((b.textContent || '').trim())),
      };
    }).filter((p) => p.id && p.link);
  }, SEL, limit).catch(() => []);
}

// 加载 feed 页（goto + 等帖子出现），失败自动重试一次
async function gotoFeed(page, url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(SEL.article, { timeout: 45000 });
      return true;
    } catch { if (i < tries - 1) await sleep(3000); }
  }
  return false;
}

// ── 图谱多元化互动：对 graphAccounts 只点赞不评论（规范 6.1） ──
async function graphEngage(page, acct, state, stats, deadline) {
  stats.graph = stats.graph || { likes: [] };
  for (const g of CFG.graphAccounts || []) {
    if (Date.now() > deadline) { stats.graph.stopped = '会话超时收尾'; break; }
    if (aborted(state, 'like') || capLeft(state, 'likes') <= 0) { stats.graph.skipped = '点赞额度/熔断'; continue; }

    if (!(await gotoFeed(page, 'https://x.com/' + g.handle))) {
      stats.graph.errors = (stats.graph.errors || []).concat(g.handle + ': 页面加载失败');
      continue;
    }
    // 像真人刷资讯一样先浏览一会儿
    if (!DRY) {
      const end = Date.now() + rand(...g.browseMs);
      while (Date.now() < end) { await humanScroll(page, rand(300, 800)); await sleep(rand(800, 2000)); }
    }
    const posts = await collectPosts(page, 10);
    const cutoff = Date.now() - (g.recentDays || 3) * 86400000;
    state.graph = state.graph || {};
    // 近 N 天、未赞过、非置顶旧帖；随机挑（选择性，不是从头扫）
    const cands = posts.filter((p) => p.time && Date.parse(p.time) >= cutoff && !state.graph[p.id] && !p.locked)
      .map((p) => ({ p, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.p)
      .slice(0, Math.min(g.maxLikesPerRun || 2, capLeft(state, 'likes')));

    for (const post of cands) {
      if (DRY) { stats.graph.likes.push({ account: g.handle, post: post.id, dry: true }); continue; }
      if (!(await gotoFeed(page, 'https://x.com' + post.link))) { stats.graph.likes.push({ account: g.handle, post: post.id, note: '页面加载失败跳过' }); continue; }
      await gsleep(CFG.pacing.readDwellGaussMs);
      const arts = await page.$$(SEL.article);
      const unliked = await arts[0].$(SEL.unlike);
      const btn = unliked || (await arts[0].$(SEL.like));
      if (unliked) { state.graph[post.id] = today(); stats.graph.likes.push({ account: g.handle, post: post.id, note: '已赞过' }); continue; }
      if (!btn) { stats.graph.likes.push({ account: g.handle, post: post.id, ok: false, note: '按钮未找到' }); continue; }
      await gsleep(CFG.pacing.actionDelayGaussMs);
      await humanClick(page, btn);
      await sleep(1200);
      state.graph[post.id] = today();
      capUse(state, 'likes');
      stats.graph.likes.push({ account: g.handle, post: post.id, ok: true });
      appendLog({ account: acct.key, task: 'graph', target: g.handle, post: post.id, action: 'like' });
      state.persist && state.persist();
      if (cands.indexOf(post) < cands.length - 1) await gsleep(CFG.pacing.postGapGaussMs);
    }
  }
}

// Owen 回复话术按内容主题路由：硬件 / 宏观财报 / AI行业 / 通用（2026-10-15）
function selectOwenPool(text) {
  const t = (text || '').toLowerCase();
  if (text.length < 25) return { group: 'owenShort', topic: '短帖' };
  if (/hbm|dram|存储|光模块|cpo|台积电|tsm|半导体|产能|芯片|算力/.test(t)) return { group: 'owen', topic: '硬件' };
  if (/财报|营收|eps|加息|降息|美股|大盘|恐慌|起飞|jpm|摩根|gdp|cpi|财报季|恐慌/.test(t)) return { group: 'owenMacro', topic: '宏观' };
  if (/anthropic|openai|grok|claude|arr|大模型|ai/.test(t)) return { group: 'owenAI', topic: 'AI行业' };
  return { group: 'owenGeneric', topic: '通用' };
}

// ── 任务1：Owen 权重加持（like → [bookmark/copylink 随机序] → reply） ──
async function task1(page, acct, state, stats, deadline) {
  const order = CFG.task1.actionsOrder;
  if (!(await gotoFeed(page, 'https://x.com/' + CFG.target.handle))) { stats.task1.skipped = 'Owen 主页加载失败'; return; }
  await sleep(3000);
  const posts = await collectPosts(page, 15);

  const cutoff = Date.now() - CFG.target.lookbackDays * 86400000;
  const ageOk = Date.now() - L.minPostAgeMinutes * 60000;
  const fresh = posts.filter((p) => p.time && Date.parse(p.time) >= cutoff);
  // 帖子年龄门槛：只碰发布 ≥minPostAgeMinutes 的帖（拒绝秒互动）
  const todo = fresh.filter((p) => {
    if (Date.parse(p.time) > ageOk) return false;
    if (p.locked) return false; // 订阅帖不互动（2026-10-14 用户规则）
    const rec = state.owen[p.id];
    return !rec || rec.actions.length < order.length;
  }).slice(0, Math.min(MAX_POSTS, capLeft(state, 'owenPosts')));

  stats.task1.found = fresh.length;
  stats.task1.selected = todo.length;
  stats.task1.ageSkipped = fresh.filter((p) => Date.parse(p.time) > ageOk).length;
  if (aborted(state, 'owenPost')) { stats.task1.skipped = '熔断'; return; }

  for (const post of todo) {
    if (Date.now() > deadline) { stats.task1.stopped = '会话超时收尾'; break; }
    if (!(await gotoFeed(page, 'https://x.com' + post.link))) { stats.task1.actions.push({ post: post.id, note: '页面加载失败，下次重试' }); continue; }
    await gsleep(CFG.pacing.readDwellGaussMs); // 真人阅读停留

    const arts = await page.$$(SEL.article);
    const art = arts[0];
    const rec = state.owen[post.id] || { actions: [] };
    const done = new Set(rec.actions);
    const log = (a) => stats.task1.actions.push(Object.assign({ post: post.id }, a));

    // 1 爱心（固定第一）
    if (order.includes('like') && !done.has('like') && capLeft(state, 'likes') > 0 && !aborted(state, 'like')) {
      const unliked = await art.$(SEL.unlike);
      if (unliked) { done.add('like'); log({ action: 'like', note: '已赞过跳过' }); }
      else if (DRY) { log({ action: 'like', dry: true }); done.add('like'); }
      else {
        await gsleep(CFG.pacing.actionDelayGaussMs);
        const btn = await art.$(SEL.like);
        if (btn) {
          await humanClick(page, btn);
          await sleep(1200);
          done.add('like'); capUse(state, 'likes');
          log({ action: 'like', ok: true });
        } else { log({ action: 'like', ok: false, note: '按钮未找到' }); if (breaker(state, 'like', false)) stats.task1.stopped = 'like熔断'; }
      }
    }

    // 2/3 书签、复制链接（顺序随机，打破固定序列）
    const mid = ['bookmark', 'copylink'].filter((n) => order.includes(n) && !done.has(n));
    if (Math.random() < 0.5) mid.reverse();
    for (const name of mid) {
      if (Date.now() > deadline) break;
      const capType = name === 'bookmark' ? 'bookmarks' : 'copylinks';
      if (capLeft(state, capType) <= 0 || aborted(state, name)) continue;
      if (name === 'bookmark') {
        // 详情页书签是独立按钮，找不到走分享菜单
        const bm = await art.$(SEL.bookmarkBtn);
        if (DRY) { log({ action: name, dry: true }); done.add(name); continue; }
        await gsleep(CFG.pacing.actionDelayGaussMs);
        if (bm) {
          await humanClick(page, bm);
          await sleep(1500);
          done.add(name); capUse(state, capType);
          log({ action: name, ok: true, via: 'direct' });
          continue;
        }
      }
      const share = await art.$(SEL.share);
      if (!share) { log({ action: name, ok: false, note: '分享按钮未找到' }); continue; }
      if (DRY) { log({ action: name, dry: true }); done.add(name); continue; }
      await gsleep(CFG.pacing.actionDelayGaussMs);
      await humanClick(page, share);
      const texts = name === 'bookmark' ? MENU_BOOKMARK : MENU_COPYLINK;
      const clicked = await clickShareMenuItem(page, texts);
      if (clicked) {
        await sleep(1500);
        done.add(name); capUse(state, capType);
        const toast = await readToast(page);
        log({ action: name, ok: true, toast });
        if (await riskToast(page)) throw new Error('风控提示: ' + toast);
      } else {
        await page.keyboard.press('Escape');
        log({ action: name, ok: false, note: '菜单项未找到' });
        if (breaker(state, name, false)) log({ action: name, note: '当日熔断' });
      }
    }

    // 4 回复（固定最后）
    if (order.includes('reply') && !done.has('reply') && capLeft(state, 'owenReplies') > 0 && !aborted(state, 'reply')) {
      const route = selectOwenPool(post.text || '');
      const pool = route.group + '.' + acct.key;
      const tpl = pickTemplate(CFG.templates[route.group][acct.key], pool, state);
      if (!tpl) { log({ action: 'reply', ok: false, note: '无合格模板（冷却硬约束），本帖跳过回复' }); }
      else if (DRY) { log({ action: 'reply', dry: true, text: tpl }); done.add('reply'); }
      else {
        await gsleep(CFG.pacing.actionDelayGaussMs);
        const btn = await art.$(SEL.reply);
        let sent = false;
        if (btn) {
          await humanClick(page, btn);
          try { await page.waitForSelector(SEL.replyBox, { timeout: 10000 }); } catch { /* 底部内联框兜底 */ }
          await sleep(2500); // 等弹窗动画稳定
          if (await page.$(SEL.replyBox)) {
            await typeReply(page, tpl);
            await sleep(800);
            sent = await submitReply(page); // true | 'unknown' | false
          }
        }
        log({ action: 'reply', ok: sent === true, unknown: sent === 'unknown' || undefined, text: tpl, topic: route.topic, toast: sent ? await readToast(page) : undefined });
        breaker(state, 'reply', sent !== false); // unknown 不计失败（可能已发出）
        if (sent) { done.add('reply'); capUse(state, 'owenReplies'); } // unknown 同样占额度并记已处理（保守，防重发）
      }
    }

    const grew = rec.actions.length;
    rec.actions = [...done];
    rec.lastAt = new Date().toISOString();
    if (rec.text === undefined) rec.text = (post.text || '').slice(0, 80);
    state.owen[post.id] = rec;
    // 只有产生了新动作的帖子消耗当日额度，且每帖每天只计一次（失败重试不烧额度）
    const d = day(state);
    d.owenPostsDone = d.owenPostsDone || [];
    if (done.size > grew && !d.owenPostsDone.includes(post.id)) {
      capUse(state, 'owenPosts');
      d.owenPostsDone.push(post.id);
    }
    stats.task1.posts += 1;
    appendLog({ account: acct.key, task: 1, post: post.id, actions: rec.actions });
    state.persist && state.persist();
    if (todo.indexOf(post) < todo.length - 1) {
      await gsleep(CFG.pacing.postGapGaussMs);
      await gsleep(CFG.pacing.postRestGaussMs);
    }
  }
}

// ── 任务2：社群互关回复 ──────────────────────────────────
async function task2(page, acct, state, stats, deadline) {
  const d = day(state);
  const remaining = Math.min(MAX_REPLIES, CFG.task2.repliesPerDay, capLeft(state, 'communityReplies'));
  if (remaining <= 0) { stats.task2.skipped = '今日额度已满'; return; }
  if (aborted(state, 'communityReply')) { stats.task2.skipped = '熔断'; return; }

  const tag = CFG.task2.hashtags[state.tagIndex % CFG.task2.hashtags.length];
  if (!DRY) state.tagIndex += 1;
  const url = `https://x.com/search?q=${encodeURIComponent('#' + tag)}&f=live`;
  if (!(await gotoFeed(page, url))) { stats.task2.skipped = '搜索页加载失败'; return; }
  await sleep(3000);
  for (let i = 0; i < 3; i++) { // 滚动加载候选
    await humanScroll(page, rand(700, 1100));
  }
  const posts = await collectPosts(page, CFG.task2.scanPosts);

  const kws = CFG.task2.keywords.map((k) => k.toLowerCase());
  const selfHandles = [acct.handle.toLowerCase(), CFG.target.handle.toLowerCase(), ...CFG.accounts.map((a) => a.handle.toLowerCase())];
  let targets = posts.filter((p) => {
    const t = p.text.toLowerCase();
    const lastReply = state.communityAuthors[p.author];
    const cooled = !lastReply || dayDiff(lastReply, today()) >= L.communityAuthorCooldownDays;
    return kws.some((k) => t.includes(k))
      && p.author && !selfHandles.includes(p.author)
      && !state.community[p.id] && cooled; // 同帖不重复 + 同作者 14 天冷却
  });
  // 同批次内同作者也只取第一条（防连回同一人的多条帖）
  const seenAuthors = new Set();
  targets = targets.filter((p) => { if (seenAuthors.has(p.author)) return false; seenAuthors.add(p.author); return true; }).slice(0, remaining);

  stats.task2.tag = tag;
  stats.task2.candidates = posts.length;
  stats.task2.selected = targets.length;

  for (const post of targets) {
    if (Date.now() > deadline) { stats.task2.stopped = '会话超时收尾'; break; }
    const tpl = pickTemplate(CFG.templates.community, 'community', state);
    if (!tpl) { stats.task2.replies.push({ post: post.id, note: '无合格模板（冷却硬约束），跳过' }); continue; }
    if (DRY) { stats.task2.replies.push({ post: post.id, author: post.author, dry: true, text: tpl }); continue; }

    if (!(await gotoFeed(page, 'https://x.com' + post.link))) { stats.task2.replies.push({ post: post.id, note: '页面加载失败跳过' }); continue; }
    await gsleep(CFG.pacing.readDwellGaussMs);
    const arts = await page.$$(SEL.article);
    let sent = false;
    const btn = await arts[0].$(SEL.reply);
    if (btn) {
      await humanClick(page, btn);
      try { await page.waitForSelector(SEL.replyBox, { timeout: 10000 }); } catch { /* ignore */ }
      await sleep(2500);
      if (await page.$(SEL.replyBox)) {
        await typeReply(page, tpl);
        await sleep(800);
        sent = await submitReply(page);
      }
    }
    stats.task2.replies.push({ post: post.id, author: post.author, ok: sent === true, unknown: sent === 'unknown' || undefined, text: tpl });
    if (sent) { // true 或 'unknown' 均按"已尝试发出"处理：占额度、同帖去重，绝不重发
      state.community[post.id] = sent === 'unknown' ? tpl + ' [unknown]' : tpl;
      state.communityAuthors[post.author] = today();
      capUse(state, 'communityReplies');
      appendLog({ account: acct.key, task: 2, post: post.id, author: post.author, text: tpl, unknown: sent === 'unknown' || undefined });
      if (CFG.follow.afterCommunityReply) state.pendingFollows[post.author] = today(); // 任务3 补关注
      state.persist && state.persist();
      const toast = await readToast(page);
      if (await riskToast(page)) throw new Error('风控提示: ' + toast);
    } else if (breaker(state, 'communityReply', false)) { stats.task2.stopped = '熔断'; break; }
    if (targets.indexOf(post) < targets.length - 1) await gsleep(CFG.pacing.communityReplyGapGaussMs);
  }
}

// ── 任务3：互关闭环（规范 6.2：主动关注 + 被动回关 + 比例护栏 + 超时取关） ──
// 读某账号主页的粉丝/关注数
async function profileCounts(page, handle) {
  try {
  await page.goto('https://x.com/' + handle, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="UserName"]', { timeout: 30000 });
  await sleep(2500);
  return page.evaluate(() => {
    const parse = (t) => {
      const m = (t || '').replace(/,/g, '').match(/([\d.]+)\s*(万|亿|K|M|B)?/i);
      if (!m) return 0;
      let n = parseFloat(m[1]);
      const u = (m[2] || '').toUpperCase();
      if (u === '万') n *= 1e4; else if (u === '亿') n *= 1e8;
      else if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
      return Math.round(n);
    };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = { followers: 0, following: 0 };
    document.querySelectorAll('a[href$="/followers"], a[href$="/verified_followers"], a[href$="/following"]').forEach((a) => {
      const k = a.getAttribute('href').split('/').pop();
      if (k === 'following') out.following = parse(clean(a.textContent));
      else out.followers += parse(clean(a.textContent));
    });
    return out;
  }).catch(() => ({ followers: 0, following: 0 }));
  } catch { return { followers: 0, following: 0 }; }
}

async function task3(page, acct, state, stats, deadline) {
  const F = CFG.follow;
  stats.follow = stats.follow || { proactive: [], followBacks: [], unfollows: [], filtered: [] };
  const d = day(state);
  if (aborted(state, 'follow')) { stats.follow.skipped = '熔断'; return; }

  // C. 比例护栏：先读自己
  const me = await profileCounts(page, acct.handle);
  const small = me.followers < F.ratioGuard.smallAccountBelowFollowers;
  const line = small ? F.ratioGuard.smallAccountMaxRatio : F.ratioGuard.maxRatio;
  const ratio = me.followers > 0 ? me.following / me.followers : 99;
  stats.follow.self = { ...me, ratio: +ratio.toFixed(2), mode: small ? '小号' : '正常' };
  let proactiveAllow = ratio <= line;
  const proactiveCap = small ? F.ratioGuard.smallAccountProactivePerDay : CFG.task2.repliesPerDay;
  if (!proactiveAllow) stats.follow.guard = `比例 ${ratio.toFixed(2)} > ${line}，当日停主动关注`;

  // A. 主动关注：消化社群回复攒下的 pendingFollows
  const pending = Object.entries(state.pendingFollows || {});
  for (const [handle2] of pending) {
    if (Date.now() > deadline) { stats.follow.stopped = '会话超时收尾'; break; }
    if (!proactiveAllow || (stats.follow.proactive.filter((x) => x.ok || x.unknown).length >= proactiveCap) || capLeft(state, 'follows') <= 0) break;
    if (state.follows[handle2]) { delete state.pendingFollows[handle2]; continue; }
    if (DRY) { stats.follow.proactive.push({ handle: handle2, dry: true }); delete state.pendingFollows[handle2]; continue; }
    await gsleep(F.delayAfterReplyGaussMs);
    const c = await profileCounts(page, handle2);
    const tRatio = c.followers > 0 ? c.following / c.followers : 99;
    const pass = c.followers >= F.filters.minFollowers && c.following <= F.filters.maxFollowing && tRatio <= F.filters.maxTargetRatio;
    if (!pass) {
      stats.follow.filtered.push({ handle: handle2, followers: c.followers, following: c.following });
      delete state.pendingFollows[handle2];
      continue;
    }
    // 互关前先浏览一会儿（真人行为）
    const end = Date.now() + rand(...F.browseMs);
    while (Date.now() < end) { await humanScroll(page, rand(300, 700)); await sleep(rand(700, 1800)); }
    const btns = await page.$$('button[data-testid$="-follow"]');
    if (!btns.length) { stats.follow.proactive.push({ handle: handle2, ok: false, note: '关注按钮未找到' }); continue; }
    await gsleep(F.followGapGaussMs);
    await humanClick(page, btns[0]);
    await sleep(1500);
    // 结果确认（2026-10-15 P0）：按钮翻转为"正在关注"才 ok；仍显示"关注"=失败；两者都不可见=unknown（可能已成功）
    let fstat = 'unknown';
    if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) fstat = 'ok';
    else if ((await page.$$('button[data-testid$="-follow"]')).length) fstat = 'fail';
    state.follows[handle2] = { day: today(), via: 'community', unverified: fstat !== 'ok' || undefined };
    capUse(state, 'follows');
    state.persist && state.persist();
    stats.follow.proactive.push({ handle: handle2, ok: fstat === 'ok', unknown: fstat === 'unknown' || undefined, note: fstat === 'fail' ? '点击后未生效' : undefined });
    appendLog({ account: acct.key, task: 3, action: 'follow', target: handle2, via: 'community', verified: fstat === 'ok' || undefined });
    delete state.pendingFollows[handle2];
  }

  // B. 被动回关：粉丝列表里找"回关"按钮（回关永远改善比例，不受护栏限制）
  if (F.followBack.enabled && capLeft(state, 'follows') > 0 && !aborted(state, 'follow')) {
    const quota = Math.min(F.followBack.perDay, capLeft(state, 'follows'));
    try { await page.goto(`https://x.com/${acct.handle}/followers`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { }
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 30000 }).catch(() => {});
    // 滚动加载到足够深度：排队的老粉也能轮到回关（规范 6.2）
    const wantCells = F.followBack.scanCells || 40;
    for (let i = 0; i < 12; i++) {
      if ((await page.$$('[data-testid="UserCell"]')).length >= wantCells) break;
      await humanScroll(page, rand(500, 900));
      await sleep(rand(800, 1600));
    }
    const cells = await page.$$('[data-testid="UserCell"]');
    let done = 0;
    for (const cell of cells) {
      if (done >= quota || Date.now() > deadline) break;
      const info = await cell.evaluate((el) => ({
        handle: ((el.querySelector('a[href^="/"]') || {}).getAttribute ? el.querySelector('a[href^="/"]').getAttribute('href') : '').replace(/^\//, '').toLowerCase(),
        hasAvatar: !!el.querySelector('img'),
        hasBio: el.querySelectorAll('div[dir="auto"]').length >= 3, // 名字/账号/bio 至少三行
        canFollowBack: !!el.querySelector('button[data-testid$="-follow"]'),
      })).catch(() => null);
      if (!info || !info.handle || !info.canFollowBack || !info.hasAvatar || !info.hasBio) continue;
      if (state.follows[info.handle] || state.followBackDone[info.handle]) continue;
      if (DRY) { stats.follow.followBacks.push({ handle: info.handle, dry: true }); done += 1; continue; }
      const btn = await cell.$('button[data-testid$="-follow"]');
      if (!btn) continue;
      await gsleep(F.followGapGaussMs);
      await humanClick(page, btn);
      await sleep(1500);
      // 结果确认（P0）：cell 内按钮翻转为"正在关注"才确认成功
      const confirmed = await cell.$('button[data-testid$="-unfollow"]').catch(() => null);
      state.follows[info.handle] = { day: today(), via: 'followback', unverified: !confirmed || undefined };
      state.followBackDone[info.handle] = today();
      capUse(state, 'follows');
      state.persist && state.persist();
      done += 1;
      stats.follow.followBacks.push({ handle: info.handle, ok: !!confirmed, unknown: !confirmed || undefined });
      appendLog({ account: acct.key, task: 3, action: 'followBack', target: info.handle, verified: !!confirmed || undefined });
    }
  }

  // D. 超时取关：主动关注满 N 天未互关 → 取关（只清自己主动关注的）
  if (F.unfollowTimeout.enabled && !DRY && capLeft(state, 'unfollows') > 0) {
    const stale = Object.entries(state.follows)
      .filter(([h, v]) => v.via === 'community' && !v.mutual && dayDiff(v.day, today()) >= F.unfollowTimeout.days);
    for (const [h] of stale.slice(0, F.unfollowTimeout.perDay)) {
      if (Date.now() > deadline) break;
      try {
        await page.goto('https://x.com/' + h, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('[data-testid="UserName"]', { timeout: 30000 }).catch(() => {});
        await sleep(2000);
      } catch { continue; }
      const mutual = await page.$('[data-testid="userFollowIndicator"]').catch(() => null);
      if (mutual) { state.follows[h].mutual = true; state.persist && state.persist(); continue; } // 对方关注了我们，保留
      const unbtn = (await page.$$('button[data-testid$="-unfollow"]'))[0];
      if (!unbtn) continue;
      await gsleep(F.followGapGaussMs);
      await humanClick(page, unbtn);
      await sleep(1200);
      const confirm = await page.$('[data-testid="confirmationSheetConfirm"]');
      if (confirm) { await humanClick(page, confirm); await sleep(1500); }
      // 结果确认（P0）：取关成功后页面应出现"关注"按钮；未确认则保留记录下次再试
      const followBack2 = await page.$('button[data-testid$="-follow"]').catch(() => null);
      if (!followBack2) { stats.follow.unfollows.push({ handle: h, ok: false, note: '取关未确认，记录保留' }); continue; }
      delete state.follows[h];
      capUse(state, 'unfollows');
      state.persist && state.persist();
      stats.follow.unfollows.push({ handle: h, ok: true });
      appendLog({ account: acct.key, task: 3, action: 'unfollow', target: h, reason: 'timeout' });
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────
function inActiveWindow() {
  const h = new Date().getHours();
  return h >= L.activeHours[0] && h < L.activeHours[1];
}

(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) {
    console.error('检测到 state/PAUSE —— 全局急停开关生效中，本次不执行（删除该文件恢复）');
    process.exit(0);
  }
  // 调度抖动：启动前随机等待，避免每天准点触发（规范 3）
  const JITTER_MIN = parseInt(argOf('jitter-min', '0'), 10);
  if (JITTER_MIN > 0 && !DRY) {
    const jitter = rand(0, JITTER_MIN * 60000);
    console.log(`随机延迟启动 ${Math.round(jitter / 60000)} 分钟（拟人抖动）...`);
    await sleep(jitter);
  }
  if (!DRY && !FORCE && !inActiveWindow()) {
    console.error(`当前不在执行窗 ${L.activeHours[0]}:00-${L.activeHours[1]}:00，按规范跳过（--force 可越过）`);
    process.exit(1);
  }
  const accounts = CFG.accounts.filter((a) => ACCOUNT === 'both' || a.key === ACCOUNT);
  if (!accounts.length) { console.error('没有匹配的账号: ' + ACCOUNT); process.exit(1); }
  const report = {};

  for (const acct of accounts) {
    const state = loadState(acct.key);
    // 逐动作落盘（2026-10-15 P0）：每完成一个动作立即持久化，崩溃不丢额度/去重记录；函数属性不会被 JSON 序列化
    state.persist = DRY ? () => {} : () => saveState(acct.key, state);
    const stats = { task1: { found: 0, selected: 0, posts: 0, actions: [] }, task2: { replies: [] } };
    const deadline = Date.now() + L.sessionMaxMinutes * 60000;
    let ws = null;
    try {
      if (day(state).sessionAborted) throw new Error('该账号今日已因风控熔断: ' + day(state).sessionAborted);
      ws = await openWindow(acct.profileId);
      const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 300000 });
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1400 + Math.floor(Math.random() * 120), height: 880 + Math.floor(Math.random() * 100) });
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (!(await verifyLogin(page, acct.handle))) throw new Error(`登录态校验失败：期望 @${acct.handle}`);
        console.log(`[${acct.key}] 登录态 OK (@${acct.handle})`);

        // 任务故障隔离：单个任务失败不影响其他任务（风控信号除外，需终止全会话）
        const runStep = async (name, fn) => {
          if (Date.now() > deadline) { stats[name] = Object.assign({}, stats[name], { stopped: '会话超时收尾' }); return; }
          try { await fn(); }
          catch (e) {
            if (RISK_TOAST.test(e.message || '')) throw e;
            stats[name] = Object.assign({}, stats[name], { error: e.message });
            console.error(`[${acct.key}] ${name} 出错(已隔离): ${e.message}`);
          }
        };

        await runStep('warmup', () => warmUp(page, stats));
        await runStep('graph', async () => { // 先刷资讯（规范 6.1 动线）
          if (CFG.graphAccounts && CFG.graphAccounts.length) await graphEngage(page, acct, state, stats, deadline);
        });
        await runStep('task1', async () => {
          if (TASK !== 'all' && TASK !== '1') return;
          if (!DRY) await gsleep(CFG.pacing.taskGapGaussMs);
          return task1(page, acct, state, stats, deadline);
        });
        await runStep('task2', async () => {
          if (TASK !== 'all' && TASK !== '2') return;
          if (!DRY) await gsleep(CFG.pacing.taskGapGaussMs);
          return task2(page, acct, state, stats, deadline);
        });
        await runStep('follow', async () => {
          if (TASK !== 'all' && TASK !== '3') return;
          if (!DRY) await gsleep(CFG.pacing.taskGapGaussMs);
          return task3(page, acct, state, stats, deadline);
        });
        await page.close();
      } finally {
        await browser.disconnect();
      }
    } catch (e) {
      stats.error = e.message;
      if (RISK_TOAST.test(e.message || '')) day(state).sessionAborted = e.message; // 风控 → 当日禁跑
      console.error(`[${acct.key}] 出错: ${e.message}`);
    } finally {
      if (!DRY) saveState(acct.key, state);
      if (ws) await closeWindow(acct.profileId).catch(() => {});
    }
    report[acct.key] = stats;

    // 两账号错开 ≥30 分钟（规范 3）；DRY 演练不需要
    if (ACCOUNT === 'both' && !DRY && accounts.indexOf(acct) < accounts.length - 1) {
      const gap = gauss(35 * 60000, 5 * 60000);
      console.log(`按规范错开两账号，${Math.round(gap / 60000)} 分钟后跑下一个号...`);
      await sleep(gap);
    }
  }

  console.log('\n===== 运行报告 =====');
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
