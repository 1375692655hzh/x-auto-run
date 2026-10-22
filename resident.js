// resident.js — fullwin 常驻运营进程（10-20 拍板）：08:00~23:00 一窗三页
//   页1 光速回复：5min 轮询通知页，新回复/提及 → mimo 生成 → 随机延迟 1-10min 发出（自家矩阵号不自动回，用户手动管）
//   页2 话题巡逻：只做 #蓝V互关，每 8-15min 一轮，每轮最多 4 条评论（无日帽，供给约束），先关注后回复
//   页3 互关帖：每 60-85min（1h±0~25min）一条，tag=用户六话题，素材取近 1h 话题帖参考
//   云端 Fullwin777 内容照常：09:35/12:35/19:35 拉取滴灌并入本进程发布（帖帽 35/天 与互关帖共享）
// LLM 锁定 mimo 通道（用户拍板）；熔断（风控toast 当日停）/PAUSE/滚动账本/审计全接入。
// 用法: node resident.js --account fullwin [--dry] [--watchdog]（看门狗模式：心跳超时则拉起常驻）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateReply, judgeWorthiness } = require('./llm');
const { pickGreet, cachedLabel, storeBio } = require('./interaction');
const quality = require('./quality');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const WATCHDOG = argv.includes('--watchdog');
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ACCOUNT = argOf('account', 'fullwin');
const ACCT = (CFG.accounts || []).find((a) => a.key === ACCOUNT);
const RC = Object.assign({
  startHour: 8, endHour: 23,
  replyPollMin: 5, replyDelayMin: [1, 10],
  patrolTopic: '蓝V互关', patrolGapMin: [8, 15], patrolPerRound: 4,
  postGapMin: [60, 85], postTags: ['#蓝V互关', '#蓝朋友', '#浇朋友', '#浇个朋友', '#交个朋友', '#交朋友'],
  cloudSlots: ['09:35', '12:35', '19:35'], cloudGapMin: [2, 8],
  llmChannel: 'mimo', postCapDay: 35, replyCapDay: 60, followCapDay: 100,
}, ((CFG.resident || {})[ACCOUNT] || {}));
const OWN = new Set((CFG.accounts || []).map((a) => a.handle.toLowerCase()));
const L = CFG.limits || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const nowIso = () => new Date().toISOString();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`), JSON.stringify({ at: nowIso(), task: 'resident', account: ACCOUNT, ...obj }) + '\n'); }
// 误发独立帖旁证登记（10-22）：回复发送成功即登记，verify-reply.js 定时消费——双端点确认才告警进人工待办，
// 不自动处置（用户拍板：FxTwitter 有抽风，不作唯一判据引导操作）
function queueVerify(entry) {
  const f = path.join(STATE_DIR, `pending-verify-${ACCOUNT}.json`);
  const list = readJson(f, []);
  list.push({ at: nowIso(), text: String(entry.text || '').slice(0, 80), statusId: entry.statusId || null, target: entry.target || null, source: entry.source || null, checks: 0 });
  writeJson(f, list.slice(-50));
}

// ── 滚动账本（与 executor 同文件同格式，24h 滚动） ──
const LEDGER_FILE = path.join(STATE_DIR, `ledger-${ACCOUNT}.json`);
function loadLedger() {
  const cut = Date.now() - 24 * 3600000;
  let j = readJson(LEDGER_FILE, { actions: {}, meta: {} });
  for (const k of Object.keys(j.actions)) j.actions[k] = (j.actions[k] || []).filter((ts) => ts > cut);
  return j;
}
function ledgerRecord(type) { const j = loadLedger(); (j.actions[type] = j.actions[type] || []).push(Date.now()); writeJson(LEDGER_FILE, j); }
function usedToday(type) { const cut = new Date(); cut.setHours(0, 0, 0, 0); return (loadLedger().actions[type] || []).filter((ts) => ts > cut.getTime()).length; }

// ── 常驻状态（去重/心跳/游标） ──
const ST_FILE = path.join(STATE_DIR, `resident-${ACCOUNT}.json`);
function loadSt() { return readJson(ST_FILE, { heartbeatAt: null, seenNotifs: {}, seenPosts: {}, lastCloudSlot: {}, material: [], day: null }); }
function saveSt(s) { writeJson(ST_FILE, s); }

// ── 浏览器原语（自 executor 移植：选择器/输入/提交/toast/关注——常驻进程独立持有窗口，不与 executor 共用会话） ──
const SEL = { article: 'article[data-testid="tweet"]', reply: '[data-testid="reply"]', replyBox: '[data-testid="tweetTextarea_0"]', like: '[data-testid="like"]', unlike: '[data-testid="unlike"]', toast: '[data-testid="toast"]' };
const RISK_TOAST = /出错|稍后再试|无法|请重试|try again|something went wrong|limit|restrict|block|エラー|もう一度|制限|できません/i;
async function readToast(page) { return page.evaluate((sel) => { const t = document.querySelector(sel); return t ? (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null; }, SEL.toast).catch(() => null); }
async function riskToast(page) { const t = await readToast(page); return (t && RISK_TOAST.test(t)) ? t : null; }
async function humanClick(page, handle) {
  try { const bb = await handle.boundingBox(); if (bb) { await page.mouse.move(bb.x + bb.width * (0.3 + Math.random() * 0.4), bb.y + bb.height * (0.3 + Math.random() * 0.4), { steps: 6 + Math.floor(Math.random() * 8) }); await sleep(rand(600, 1400)); } } catch { }
  await handle.click();
}
async function verifyLogin(page, handle) {
  try {
    await page.waitForSelector('a[data-testid="AppTabBar_Profile_Link"]', { timeout: 15000 });
    const href = await page.evaluate(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); return a ? a.getAttribute('href') : null; }).catch(() => null);
    if (href && href.toLowerCase() === '/' + handle.toLowerCase()) return true;
  } catch { }
  return false;
}
// 回复上下文绑定探针（10-22"回复变独立帖"事故修复，glm+kimi 联合诊断）：
//   弹窗形态：回复弹窗必含父帖 article（独立发帖弹窗没有——10-22 owen 窗只读探针实测），父帖作者链接须匹配目标 handle
//   无弹窗形态：仅接受 URL 仍是目标帖 permalink 的内联回复框；/home 主发帖框=独立帖通道，硬性拒发
// 注意：弹窗内无 /status/ 链接（实测 dlgStatusLinks=[]），目标校验只能靠父帖作者 handle
function probeReplyComposer(sid, handle) {
  const boxSel = '[data-testid="tweetTextarea_0"]';
  const dlg = document.querySelector('[role="dialog"]');
  if (dlg && dlg.querySelector(boxSel)) {
    const art = dlg.querySelector('article');
    if (!art) return { ok: false, note: 'dialog无父帖卡片(独立发帖弹窗)' };
    if (handle) {
      const hit = [...art.querySelectorAll('a[href^="/"]')].some((a) => ((a.getAttribute('href') || '').split('/')[1] || '').toLowerCase() === handle);
      if (!hit) return { ok: false, note: 'dialog父帖作者非@' + handle };
    }
    return { ok: true, mode: 'dialog' };
  }
  const m = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  if (m && sid && m[1] === String(sid) && document.querySelector(boxSel)) return { ok: true, mode: 'inline' };
  return { ok: false, note: '无绑定composer(' + location.pathname + ')' };
}
async function typeReply(page, text, mode) {
  return page.evaluate((sel, t, m) => {
    // 严格按闸给的作用域取框（10-22：旧兜底 all[last] 会把文字粘进 /home 主发帖框=独立帖通道）；any=发帖页用
    const el = m === 'dialog' ? document.querySelector('[role="dialog"] ' + sel)
      : m === 'inline' ? document.querySelector(sel)
      : (document.querySelector('[role="dialog"] ' + sel) || document.querySelector(sel));
    if (!el) return false;
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, SEL.replyBox, text, mode || 'any').catch(() => false);
}
async function submitReply(page, sid, handle) {
  // 提交前绑定核验（10-22：宁可漏回，不可错发独立帖；发帖流程不传 sid 则跳过此闸）
  if (sid) {
    const g = await page.evaluate(probeReplyComposer, String(sid), handle || null).catch(() => null);
    if (!g || !g.ok) return 'unbound:' + ((g && g.note) || '探针异常');
  }
  const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false);
  const clicked = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    let b = null;
    if (dlg) { const btns = [...dlg.querySelectorAll('[data-testid="tweetButton"]')]; b = btns[btns.length - 1]; }
    else b = document.querySelector('[data-testid="tweetButtonInline"]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click(); return true;
  }).catch(() => false);
  if (!clicked) return false;
  const readSt = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="tweetTextarea_0"]');
    return { dlg: !!document.querySelector('[role="dialog"]'), toast: ((document.querySelector('[data-testid="toast"]') || {}).textContent || '').trim(), boxLen: box && box.textContent ? box.textContent.length : 0 };
  }).catch(() => null);
  const okToast = (t) => /已发送|发过了|送信|already|posted|sent/i.test(t || '');
  const waitToast = async (ms) => { for (let j = 0; j < Math.ceil(ms / 500); j++) { await sleep(500); const s2 = await readSt(); if (s2 && okToast(s2.toast)) return true; } return false; };
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await readSt();
    if (!st) continue;
    if (okToast(st.toast)) return true;
    if (hasDialog && !st.dlg) return (await waitToast(4000)) || 'unknown';
    if (!hasDialog && st.boxLen === 0) return (await waitToast(4000)) || 'unknown';
  }
  return false;
}
async function gotoFeed(page, url, tries = 2, expectSid) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForSelector(SEL.article, { timeout: 45000 }); }
    catch { }
    if (await page.$(SEL.article).catch(() => null)) {
      // 10-22 落地校验：目标帖页被 X 软重定向到 /home 时，后续"输入框存在"等检查全部形同虚设（主发帖框常驻）→独立帖通道；必须视为失败
      if (expectSid && !(page.url() || '').includes('/status/' + expectSid)) { if (i < tries - 1) { await sleep(3000); continue; } return false; }
      return true;
    }
    if (i < tries - 1) await sleep(3000);
  }
  return false;
}
async function findArticleByStatus(page, statusId) {
  for (const a of await page.$$(SEL.article)) {
    if (await a.evaluate((el, sid) => !!el.querySelector(`a[href*="/status/${sid}"]`), statusId).catch(() => false)) return a;
  }
  return null;
}
async function replyOnPage(page, statusId, postUrl, text, entry) {
  // 10-22 入口守卫：statusId 非法=硬性拒发（kimi 诊断：无守卫时畸形 URL 可诱发软重定向→独立帖通道）
  if (!statusId || !/^\d+$/.test(String(statusId))) return { ok: false, note: 'statusId非法:' + String(statusId) };
  if (!(await gotoFeed(page, postUrl, 2, statusId))) return { ok: false, note: '页面加载失败/落地被重定向' };
  await sleep(rand(3000, 6000));
  const art = await findArticleByStatus(page, statusId);
  if (!art) return { ok: false, note: '未找到目标帖' };
  // 读帖停顿（10-21 批3）：按原帖字数停——短帖 2-4s / 长帖 5-9s，加一次轻滚（WeClone'时机'思想）
  const srcLen = (entry && entry.srcLen) || 40;
  const dwellMs = srcLen > 100 ? rand(5000, 9000) : rand(2000, 4000);
  await page.evaluate(() => window.scrollBy({ top: 200 + Math.floor(Math.random() * 200), behavior: 'smooth' })).catch(() => {});
  await sleep(dwellMs);
  const btn = await art.$(SEL.reply);
  if (!btn) return { ok: false, note: '回复按钮未找到' };
  const targetHandle = (((postUrl || '').match(/\/([^/]+)\/status\//) || [])[1] || (entry && entry.targetHandle) || '').toLowerCase() || null;
  await humanClick(page, btn);
  // 等"绑定回复上下文"出现（10-22：原只等任意输入框——/home 主发帖框恒存在，检查形同虚设）
  let gate = null;
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    gate = await page.evaluate(probeReplyComposer, String(statusId), targetHandle).catch(() => null);
    if (gate && gate.ok) break;
  }
  if (!gate || !gate.ok) return { ok: false, note: 'composer无回复绑定:' + ((gate && gate.note) || '探针异常') };
  if (!(await typeReply(page, text, gate.mode))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page, statusId, targetHandle);
  if (typeof r === 'string' && r.indexOf('unbound:') === 0) return { ok: false, note: '提交前绑定丢失:' + r.slice(8) };
  return { ok: r === true, unknown: r === 'unknown', raw: r };
}
async function postOnPage(page, text) {
  try { await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch { return { ok: false, note: '发布页加载失败' }; }
  await page.waitForSelector(SEL.replyBox, { timeout: 20000 }).catch(() => { });
  await sleep(2500);
  if (!(await page.$(SEL.replyBox))) return { ok: false, note: '输入框未出现' };
  if (!(await typeReply(page, text))) return { ok: false, note: '输入失败' };
  await sleep(800);
  const r = await submitReply(page);
  if (r !== true) return { ok: r === true, unknown: r === 'unknown' };
  const toast = await readToast(page);
  return { ok: true, note: /发过|already/i.test(toast || '') ? '已存在(重复)' : '新发' };
}
async function followOnPage(page, handle2) {
  if (!(await gotoFeed(page, 'https://x.com/' + handle2))) return { ok: false, note: '主页加载失败' };
  await sleep(rand(2000, 4000));
  const btn = (await page.$$('button[data-testid$="-follow"]'))[0];
  if (!btn) return { ok: false, note: '关注按钮未找到(可能已关注)' };
  await humanClick(page, btn);
  await sleep(1500);
  if (await page.$('button[data-testid$="-unfollow"]').catch(() => null)) return { ok: true };
  return { ok: false, unknown: true, note: '关注未确认' };
}
async function collectPosts(page, limit = 30) {
  return page.evaluate((limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, limit).map((art) => {
      const link = art.querySelector('a[href*="/status"]');
      const time = art.querySelector('time');
      const text = art.querySelector('[data-testid="tweetText"]');
      const nameEl = art.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const locked = /subscribe to unlock|订阅解锁|ロック解除/i.test(art.textContent || '');
      return {
        id: (link && (link.getAttribute('href') || '').match(/status\/(\d+)/) || [])[1] || null,
        link: link ? link.getAttribute('href') : null,
        time: time ? time.getAttribute('datetime') : null,
        author: nameEl ? (nameEl.getAttribute('href') || '').replace('/', '').split('/')[0] : null,
        text: text ? clean(text.textContent).slice(0, 280) : '',
        hasMedia: !!art.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]'), // 10-20 拍板"没有图片/视频才回复帖子"（全局三账号）：带媒体帖巡逻不回
        locked,
      };
    }).filter((p) => p.id && p.author);
  }, limit).catch(() => []);
}

// ── 动作隔离与瞬态重试（10-20：巡逻 8/8 轮协议挂起的修复） ──
async function withTempPage(bro, fn) { // bro=浏览器实例由调用方传入（模块级定义拿不到主流程的 browser——14:14 实战踩坑）
  const pg = await bro.newPage();
  pg.on('dialog', (d) => d.accept().catch(() => { })); // 防丢草稿弹窗自动点"离开"（10-20 全天协议超时真凶：X 的 beforeunload 模态框卡死整个 CDP 通道）
  await pg.setViewport({ width: 1400 + randi(0, 80), height: 900 });
  try { return await fn(pg); } finally { try { await pg.close(); } catch { } }
}
async function retryTransient(fn) {
  let r = await fn().catch((e) => ({ ok: false, note: 'EXC:' + String(e.message).slice(0, 60) }));
  if (!r.ok && /Protocol error|timed out|TimeoutError|net::|ERR_/i.test(r.note || '')) {
    LOG('瞬态错误，5s 后重试一次: ' + String(r.note).slice(0, 40));
    await sleep(5000);
    r = await fn().catch((e) => ({ ok: false, note: 'EXC重试:' + String(e.message).slice(0, 60) }));
  }
  return r;
}

// ── 看门狗模式 ──
if (WATCHDOG) {
  (async () => {
    if (fs.existsSync(path.join(STATE_DIR, 'PAUSE-' + ACCOUNT))) process.exit(0); // 账号级人工接管期：看门狗静默不拉起
    const st = loadSt();
    // 10-21 升级：心跳+页面双健康才算活——僵尸态（页面全 detached 但循环照跑）心跳照写曾骗过看门狗 7h
    const hbFresh = st.heartbeatAt && Date.now() - Date.parse(st.heartbeatAt) < 20 * 60000;
    const pagesFresh = st.pagesOkAt && Date.now() - Date.parse(st.pagesOkAt) < 30 * 60000;
    const fresh = !!(hbFresh && pagesFresh);
    const hour = new Date().getHours();
    if (fresh || hour < RC.startHour || hour >= RC.endHour) { LOG(`看门狗：${fresh ? '常驻心跳+页面正常' : '不在时段'}，不动`); process.exit(0); }
    LOG('看门狗：常驻失活（心跳超时或页面僵死），拉起常驻进程');
    const { spawn } = require('child_process');
    const child = require('child_process').spawn('cmd', ['/c', path.join(ROOT, `定时-常驻-${ACCOUNT}.bat`)], { detached: true, stdio: 'ignore', cwd: ROOT }); // 拉 bat 才有日志重定向（10-20 修复：直 spawn node 导致常驻无日志）
    child.unref();
    audit({ action: 'watchdogRelaunch' });
  })();
  return;
}

// ══ 主流程 ══
(async () => {
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE-' + ACCOUNT))) { console.error('PAUSE-' + ACCOUNT + ' 生效（账号级人工接管），退出'); process.exit(0); } // 10-21：账号级暂停旗标，任何调度路径复活都在此立即退出（schtasks 禁用态漏火的釜底抽薪）
  if (!ACCT) { console.error('config.accounts 无此账号'); process.exit(1); }
  if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { console.error('PAUSE 生效，退出'); process.exit(0); }
  const led = loadLedger();
  if (led.meta.abortedToday === today()) { console.error(`今日已熔断(${led.meta.abortReason || ''})，不启动`); process.exit(1); }
  const hour = new Date().getHours();
  if (hour < RC.startHour || hour >= RC.endHour) { console.error(`不在常驻时段 ${RC.startHour}:00-${RC.endHour}:00`); process.exit(0); }

  LOG(`常驻启动：@${ACCT.handle}，三页面（回复/巡逻/发布），LLM=${RC.llmChannel}，帖帽${RC.postCapDay} 回复帽${RC.replyCapDay}`);

  // 单实例守卫（10-21 事故：无守卫时一晚 5 次重复启动，新实例清页签把旧实例拆成僵尸）：
  // 已有活实例（心跳新鲜+pid 活）则本次退出。新代码只在页面健康时写心跳，心跳新鲜=真活着
  {
    const prev = loadSt();
    if (prev.heartbeatAt && Date.now() - Date.parse(prev.heartbeatAt) < 20 * 60000 && prev.pid && prev.pid !== process.pid) {
      try { process.kill(prev.pid, 0); console.error(`已有活实例(pid ${prev.pid})，本次退出（防拆工位）`); process.exit(0); }
      catch (e) { if (e.code === 'EPERM') { console.error(`已有活实例(pid ${prev.pid})，本次退出`); process.exit(0); } }
    }
  }

  // 工位=开窗+连接+两工作页+登录校验；启动与自愈共用（10-21：detached Frame 后原代码无任何恢复路径）
  let browser = null, pageReply = null, pagePost = null;
  async function openWorkPages() {
    const j = await fetch(CFG.bitbrowser + '/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).then((r) => r.json());
    if (!j.success) throw new Error('开窗失败: ' + JSON.stringify(j).slice(0, 100));
    const b2 = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null, protocolTimeout: 90000 });
    try {
      try { const ps0 = await b2.pages(); for (let i = 1; i < ps0.length; i++) { try { await ps0[i].close(); } catch { } } } catch { } // 清孤儿页
      const pr = await b2.newPage(); await pr.setViewport({ width: 1400 + randi(0, 120), height: 900 });
      const pp = await b2.newPage(); await pp.setViewport({ width: 1400 + randi(0, 120), height: 900 });
      // 常驻页全部自动应答模态框（beforeunload"离开此网站"等）——10-20 全天协议超时根因
      for (const pg of [pr, pp]) pg.on('dialog', (d) => d.accept().catch(() => { }));
      await pr.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
      if (!(await verifyLogin(pr, ACCT.handle))) throw new Error('登录态校验失败');
      const old = browser;
      browser = b2; pageReply = pr; pagePost = pp; // 全部就绪才切换引用
      if (old) { try { await old.disconnect(); } catch { } }
      return true;
    } catch (e) { try { await b2.disconnect(); } catch { } throw e; }
  }
  try { await openWorkPages(); }
  catch (e) { console.error(String(e.message || e)); await cleanup(); process.exit(1); }

  const st = loadSt();
  st.pid = process.pid; // 供 executor 守卫探活（resident-guard.js）与单实例判断
  // 跨日重置（10-21 修复 Codex 抓出的死代码：st.day 先设后查致 userReplies 永不重置）
  if (st.day !== today()) { st.seenNotifs = {}; st.seenPosts = {}; st.lastCloudSlot = {}; st.userReplies = {}; st.termUse = {}; st.emojiDay = { n: 0, end: 0 }; st.day = today(); saveSt(st); }
  let aborted = false;
  const sendQueue = []; // {kind, statusId, postUrl, author, text, sendAt}
  // 10-20 拍板 24 小时制：进程全天在岗（至当日 23:59 自灭，00:05 由计划任务接替）；
  // 互动（巡逻/光速回复/互关帖）仅 interactionHours[8,22] 内；云帖全天——白天每小时≤2、夜里(22~8)1条/小时
  const IH = RC.interactionHours || [8, 22];
  const topicOff = !!(RC.topicPosts && RC.topicPosts.enabled); // 10-20：互关帖改预制定时发布（topic-posts.js），常驻页3功能下线
  const userReplyCount = (author) => { st.userReplies = st.userReplies || {}; return (st.userReplies[(author || '').toLowerCase()] || 0); };
  const userReplyIncr = (author) => { st.userReplies = st.userReplies || {}; st.userRepliesTotal = st.userRepliesTotal || {}; const a = (author || '').toLowerCase(); st.userReplies[a] = (st.userReplies[a] || 0) + 1; st.userRepliesTotal[a] = (st.userRepliesTotal[a] || 0) + 1; saveSt(st); }; // Total 跨日不重置（关系分级用）
  const userCapOk = (author) => userReplyCount(author) < (RC.perUserReplyCapDay != null ? RC.perUserReplyCapDay : 3);
  // ── 回复多样性控制（10-22 拍板 A/B/C，交付零影响设计）：A 称呼词日限 2/词=软偏好（降权重抽不拒发）；
  // B emoji 收尾率>30% 时剥句尾 emoji（剥了照发不拒发）；C 同人语境递进（brief 注入"上次回他的是X"）；
  // 全部只动文本层：不动量/不动帽/不动通过率
  const ADDR_TERMS = ['老师', '老哥', '朋友', '兄弟', '兄dei', '大佬', '家人', '宝子', '哥们', '伙计'];
  const termsIn = (t) => ADDR_TERMS.filter((w) => String(t || '').includes(w));
  const cappedTerms = () => ADDR_TERMS.filter((w) => ((st.termUse || {})[w] || 0) >= 2);
  const END_EMOJI = /[\p{Extended_Pictographic}\uFE0F][\p{Extended_Pictographic}\uFE0F\s]*$/u;
  const endsEmoji = (t) => END_EMOJI.test(String(t || '').trim());
  const stripEndEmoji = (t) => String(t || '').trim().replace(END_EMOJI, '').trim();
  const emojiRateHigh = () => { const d = st.emojiDay || { n: 0, end: 0 }; return d.n >= 10 && d.end / d.n > 0.3; };
  function noteReplyStyle(author, text) { // 发送成功时记多样性统计+同人语境
    st.termUse = st.termUse || {}; st.emojiDay = st.emojiDay || { n: 0, end: 0 };
    for (const w of termsIn(text)) st.termUse[w] = (st.termUse[w] || 0) + 1;
    st.emojiDay.n++; if (endsEmoji(text)) st.emojiDay.end++;
    st.lastReplyTo = st.lastReplyTo || {};
    st.lastReplyTo[(author || '').toLowerCase()] = String(text || '').slice(0, 40);
    const ks = Object.keys(st.lastReplyTo); if (ks.length > 200) for (const k of ks.slice(0, ks.length - 200)) delete st.lastReplyTo[k];
    saveSt(st);
  }
  // 防复读历史（10-21 修复：三处 history 恒空致相似度防线断线；环形缓冲 100 条，范本 planner.js）
  const pushReplyHistory = (text) => { st.replyHistory = st.replyHistory || []; st.replyHistory.push(String(text).slice(0, 120)); if (st.replyHistory.length > 100) st.replyHistory = st.replyHistory.slice(-100); saveSt(st); };
  const recentHistory = () => (st.replyHistory || []).slice(-8);
  const interactOk = () => { const h = new Date().getHours(); return h >= IH[0] && h < IH[1]; };
  const cloudQuota = () => interactOk() ? (RC.cloudDayHourMax != null ? RC.cloudDayHourMax : 2) : (RC.cloudNightHourMax != null ? RC.cloudNightHourMax : 1);
  // 10-21 bug5：重启恢复持久化待发（只恢复 30 分钟内的，过期的丢弃留审计）
  for (const x of (st.pendingInbox || [])) {
    if (Date.parse(x.sendAt) > Date.now() - 30 * 60000) sendQueue.push({ kind: 'replyInbox', ...x });
    else audit({ action: 'inboxDrop', target: x.author, note: '重启恢复时已过期>30min，丢弃' });
  }
  if ((st.pendingInbox || []).length) { st.pendingInbox = []; saveSt(st); }
  let nextReplyPoll = Date.now() + 60 * 1000;
  let nextPatrol = Date.now() + rand(60, 180) * 1000;
  let nextPost = Date.now() + rand(3, 10) * 60000; // 启动后先热身，不立即发
  const endAt = new Date(); endAt.setHours(23, 59, 0, 0);

  async function checkAbort(page, where) {
    const t = await riskToast(page);
    if (t) {
      aborted = true;
      const lg = loadLedger(); lg.meta.abortedToday = today(); lg.meta.abortReason = '风控toast(' + where + '): ' + t; writeJson(LEDGER_FILE, lg);
      audit({ action: 'abort', note: where + ': ' + t });
      LOG('⚠ 风控 toast，当日熔断退出: ' + t);
    }
    return aborted;
  }
  async function cleanup() {
    try { const ps = await browser.pages(); for (let i = 3; i < ps.length; i++) { try { await ps[i].close(); } catch { } } } catch { }
    try { await browser.disconnect(); } catch { }
    await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ACCT.profileId }) }).catch(() => { });
  }

  // ── 光速回关（10-22 拍板方案A，fullwin/butcher 共用本文件同步生效）：光速回复发出后顺带判定——
  // 对方主页 userFollowIndicator 徽章=对方关注我方（10-22 双侧实证：粉丝主页有/非粉丝无，testid 三语无关）；
  // 徽章在+我方未关注→当场回关。终身去重 followBackDone；非粉标记 7 天后再查；任务不设上限（10-19 拍板），唯一约束=滚动关注帽安全网
  async function followBackIfFan(author) {
    const h = (author || '').toLowerCase();
    if (!h) return;
    st.followBackDone = st.followBackDone || {};
    const prev = st.followBackDone[h];
    if (prev === 'done') return;
    if (prev && prev.indexOf('notfan-') === 0 && prev.slice(7) > new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) return; // 7 天内查过非粉，不重复开页
    if (usedToday('follow') >= RC.followCapDay) { audit({ action: 'followBack', target: author, status: 'skipped', note: '滚动关注帽安全网' }); return; }
    const r = await withTempPage(browser, async (pg) => {
      if (!(await gotoFeed(pg, 'https://x.com/' + author))) return { ok: false, note: '主页加载失败' };
      await sleep(rand(2000, 3500));
      const probe = await pg.evaluate(() => ({
        fan: !!document.querySelector('[data-testid="userFollowIndicator"]'),
        canFollow: !!document.querySelector('button[data-testid$="-follow"]'),
        following: !!document.querySelector('button[data-testid$="-unfollow"]'),
      })).catch(() => null);
      if (!probe) return { ok: false, note: '主页探针失败' };
      if (probe.following) return { ok: true, already: true };
      if (!probe.fan) return { ok: false, notfan: true };
      if (!probe.canFollow) return { ok: false, note: '关注按钮未找到' };
      const btn = (await pg.$$('button[data-testid$="-follow"]'))[0];
      await humanClick(pg, btn);
      await sleep(1500);
      if (await pg.$('button[data-testid$="-unfollow"]').catch(() => null)) return { ok: true };
      return { ok: false, unknown: true, note: '回关未确认' };
    }).catch((e) => ({ ok: false, note: 'EXC:' + String(e.message).slice(0, 50) }));
    if (r.ok && r.already) { st.followBackDone[h] = 'done'; saveSt(st); audit({ action: 'followBack', target: author, status: 'done', note: '已关注过' }); return; }
    if (r.ok) { st.followBackDone[h] = 'done'; saveSt(st); ledgerRecord('follow'); audit({ action: 'followBack', target: author, status: 'done', note: '对方回复+关注双条件满足，已回关' }); LOG('光速回关 @' + author); return; }
    if (r.notfan) { st.followBackDone[h] = 'notfan-' + today(); saveSt(st); audit({ action: 'followBack', target: author, status: 'skipped', note: '对方未关注我方（7天后再查）' }); return; }
    audit({ action: 'followBack', target: author, status: r.unknown ? 'unknown' : 'failed', note: r.note });
  }

  // ── 页1：光速回复轮询（通知页） ──
  async function pollNotifications() {
    try {
      await pageReply.goto('https://x.com/notifications/mentions', { waitUntil: 'domcontentloaded', timeout: 60000 }); // 提及页=只含回复/提及（10-20 用户截图指路：全部页被关注/点赞洪流淹没，回复类沉底）
      // 抓取加固：提及页的通知是 article 帖子元素（实测：无 notification testid，正文=对方回复帖本体）
      let got = await pageReply.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).then(() => true).catch(() => false);
      if (!got) { await pageReply.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { }); got = await pageReply.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).then(() => true).catch(() => false); }
      await sleep(2500);
      for (let i = 0; i < 3; i++) { await pageReply.evaluate(() => window.scrollBy({ top: 700 + Math.floor(Math.random() * 300), behavior: 'smooth' })).catch(() => { }); await sleep(1200); }
      const items = await pageReply.evaluate(() => {
        return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 25).map((n) => {
          const link = n.querySelector('a[href*="/status/"]');
          const nameEl = n.querySelector('[data-testid="User-Name"] a[href^="/"]');
          const textEl = n.querySelector('[data-testid="tweetText"]');
          return { href: link ? link.getAttribute('href') : null, author: nameEl ? (nameEl.getAttribute('href') || '').replace('/', '').split('/')[0] : null, txt: (textEl ? (textEl.textContent || '') : '').replace(/\s+/g, ' ').trim().slice(0, 200) };
        });
      }).catch(() => []);
      let queued = 0, replyish = 0, greetTpl = 0, bioFetchesThisRound = 0; // 每轮重置（10-21 补修②）
      for (const it of items) {
        if (!it.href || !it.author) continue;
        // 分类=关键词正则 ∪ 结构判定（语言无关：回复/提及的链接指向【别人】的帖；赞/关注指向我们的帖或无帖链接——10-20 用户截图实证通知页为中文，且此前抓取层静默为零，结构判定兜底防再瞎）
        const isReplyMention = /回复|回覆|reply|返信|提到|mention|提及|メンション/i.test(it.txt)
          || !it.href.toLowerCase().includes('/' + ACCT.handle.toLowerCase() + '/');
        if (!isReplyMention) continue;
        replyish++;
        if (OWN.has(it.author.toLowerCase())) continue; // 自家矩阵号不自动回（用户手动管，防互吹自动化）
        const key = it.href + '|' + it.author.toLowerCase();
        if (st.seenNotifs[key]) continue;
        // 10-21 bug4 修复：不再生成前标记已见（生成失败=通知永久丢失）；改为各出口标——成功入队/转待办/确定跳过时
        if (!userCapOk(it.author)) { audit({ action: 'inboxSkip', target: it.author, note: '单用户回复上限' }); st.seenNotifs[key] = nowIso(); continue; }
        if (DRY) { LOG(`[DRY] 应回复 @${it.author} 的通知 ${it.href}`); st.seenNotifs[key] = nowIso(); continue; }
        const postUrl = 'https://x.com' + it.href;
        const statusId = (it.href.match(/status\/(\d+)/) || [])[1];
        // 10-22 入口守卫（对齐 inbox-reply.js 已有写法）：链接提取不出 statusId 的通知不进入任何后续流程
        if (!statusId) { st.seenNotifs[key] = nowIso(); saveSt(st); audit({ action: 'inboxSkip', target: it.author, note: 'badlink:通知链接无法提取statusId', href: String(it.href).slice(0, 80) }); continue; }
        // ── 分场景双阈值（10-21 codex 裁决版 B，用户拍板）：招呼 ≤12 硬门 / 轻内容 ≤20 硬门 / 实质提问转人工待办 ──
        const txt0 = (it.txt || '').replace(/^(@\w+\s*)+/, '').trim();
        const visLen = (s) => [...String(s)].length; // 字素级长度（codex 指出：JS length 把 emoji 算 2 码元，口径用字素）
        const hasQWord = /怎么|为什么|什么|哪|如何|能不能|是不是|讲讲|说说|分析|解释|止损|仓位|建议|看法|怎么看|什么渠道|怎么开/.test(txt0);
        const hasQ = /[？?]/.test(txt0);
        const isGreet = /来了|来咯|欢迎|大佬好|膜拜|互关|回关|关注你|关注了|已关注|回访|支持一波|报到|串门|顶|前排|围观|做大做强|兄弟|学习|不错|可以|强|牛|厉害|早上好|早安|晚安|好呀/.test(txt0) && visLen(txt0) <= 24 && !(hasQWord && (hasQ || visLen(txt0) > 10)); // codex 复核修正：社交问号不误杀（早上好呀？）、已关注/回访类招呼收编
        const isQuestion = (hasQWord && (hasQ || visLen(txt0) >= 6)) || /讲讲|说说|分析|解释/.test(txt0); // 问词+≥6字即实质提问（'你蓝V走的什么渠道'这类无问号短问） // 实质提问=问词+问号或够长；祈使问（讲讲/说说）无问号也算；社交问号不算
        if (isQuestion) {
          // 实质提问不硬回短答——转人工待办队列（可见队列，不是审计一行），用户手动补答
          const todoFile = path.join(STATE_DIR, `human-todo-${ACCOUNT}.json`);
          let todo = { pending: [] };
          try { todo = JSON.parse(fs.readFileSync(todoFile, 'utf8')); if (!Array.isArray(todo.pending)) todo.pending = []; } catch { }
          todo.pending.push({ at: nowIso(), author: it.author, text: txt0.slice(0, 120), postUrl, statusId, status: 'pending' });
          fs.writeFileSync(todoFile, JSON.stringify(todo, null, 2));
          st.seenNotifs[key] = nowIso(); saveSt(st); // 转待办=已处理，标已见
          audit({ action: 'humanTodo', target: it.author, note: '实质提问转人工: ' + txt0.slice(0, 30) });
          continue;
        }
        const scene = isGreet ? 'greet' : 'light';
        // ── 批2（10-21）：greet 走模板库（0 LLM=真光速）+ 身份标签（bio 缓存 7 天，未命中惰性抓一次） ──
        // 10-21 补修②：bio 抓取每轮上限 2 个（无上限会阻塞轮询 25-50s=队列饥饿复发；超限本轮用无标签模板，下轮再抓）
        let greetLabel = cachedLabel(ACCOUNT, it.author) || null;
        if (!greetLabel && bioFetchesThisRound < 2) {
          bioFetchesThisRound++;
          try {
            greetLabel = await withTempPage(browser, async (pg) => {
              await pg.goto('https://x.com/' + it.author, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await sleep(1500);
              return pg.evaluate(() => { const el = document.querySelector('[data-testid="UserDescription"]'); return el ? el.textContent.trim().slice(0, 160) : ''; }).catch(() => '');
            });
            greetLabel = greetLabel ? storeBio(ACCOUNT, it.author, greetLabel) : null;
          } catch { greetLabel = null; }
        }
        if (scene === 'greet') {
          const recentSet = new Set((st.replyHistory || []).slice(-24).concat((st.pendingInbox || []).map((x) => x.text)));
          let tmpl = pickGreet(greetLabel, recentSet);
          // A 称呼词日限（软偏好）：抽中的模板含今日已用够的称呼词就再抽两次，仍命中照发（不为这条丢回复）
          for (let t = 0; t < 2 && tmpl && termsIn(tmpl).some((w) => cappedTerms().includes(w)); t++) tmpl = pickGreet(greetLabel, recentSet);
          if (tmpl) {
            const tc = quality.check(tmpl, { casual: true, history: st.replyHistory || [] });
            if (tc.ok && [...tc.cleaned].length <= (RC.greetHardLen || 12)) {
              // B emoji 收尾超限剥尾（剥了照发不拒发）
              let out = tc.cleaned;
              if (emojiRateHigh() && endsEmoji(out)) { const s = stripEndEmoji(out); if ([...s].length >= 3) out = s; }
              sendQueue.push({ kind: 'replyInbox', statusId, postUrl, author: it.author, text: out, sendAt: Date.now() + rand(...(scene === 'greet' ? [0.5, 1.5] : [1.5, 5])) * 60000 });
              st.pendingInbox = (st.pendingInbox || []).concat([{ statusId, postUrl, author: it.author, text: out, sendAt: sendQueue[sendQueue.length - 1].sendAt }]);
              st.seenNotifs[key] = nowIso(); saveSt(st); queued++; greetTpl++;
              continue; // 模板路径结束，不走 LLM
            }
          }
          // 模板耗尽/未过门→落 LLM 兜底（走下方生成路径）
        }
        const hardCap = scene === 'greet' ? (RC.greetHardLen || 12) : (RC.lightHardLen || 20);
        const totalN = ((st.userRepliesTotal || {})[(it.author || '').toLowerCase()] || 0);
        const rel = totalN >= 5 ? '老熟人（可镜像反捧、开轻玩笑、称兄道弟）' : totalN >= 2 || userReplyCount(it.author) >= 1 ? '眼熟（可加社区黑话和 emoji）' : '陌生人（客气短句，不玩梗不称兄道弟）'; // 10-21 补修④：累计跨日+当天并行
        const target = scene === 'greet' ? `4-10 个字，像手机上顺手回的一句${greetLabel ? '（对方是' + greetLabel + '，可带上称呼）' : ''}；对方是${rel}` : `8-16 个字，一句话点到对方说的具体内容；对方是${rel}`;
        // 超长硬拒→重生成一次（保留原意压到上限，不是硬缩到极短）→仍超跳过
        // 10-21 bug3 修复：history 接真实环形缓冲（原恒空致防复读断线）；casual=true 放行无标点短句
        const brief = `这是一条对方发给我们（回复或提及）的消息，作为帖子主人回应对方；回复 ${target}。风格参考（只学节奏不复用内容）：真人回复像随手打的——'哈哈，互相学习' '来了兄弟' '确实，这波我认'——口语、短促、不书面、不总结。`
          // C 同人语境递进：告知上次回他的是什么，换角度不重复套路
          + (((st.lastReplyTo || {})[(it.author || '').toLowerCase()]) ? `你上次回他的是"${(st.lastReplyTo || {})[(it.author || '').toLowerCase()]}"——换个角度接着聊，别重复套路。` : '')
          // A 称呼词日限（LLM 路径）：今天用够的词直接禁
          + (cappedTerms().length ? `今天"${cappedTerms().join('、')}"这些称呼已用够，开头别带称呼词。` : '');
        let r = await generateReply({ post: it.txt, author: it.author, persona: (CFG.personas || {})[ACCOUNT], brief, history: recentHistory(), channel: RC.llmChannel, maxLen: hardCap, fallbackProvider: RC.llmFallback }).catch(() => null);
        let qc = r && r.text ? quality.check(r.text, { history: st.replyHistory || [], casual: true }) : null;
        if (qc && qc.ok && visLen(qc.cleaned) > hardCap) {
          audit({ action: 'replyLen', target: it.author, note: `${scene}超长${visLen(qc.cleaned)}字重生成` });
          r = await generateReply({ post: it.txt, author: it.author, persona: (CFG.personas || {})[ACCOUNT], brief: brief + `上一版超长了，保留原意压缩到 ${hardCap} 字以内，压不了就别说。`, history: recentHistory(), channel: RC.llmChannel, maxLen: hardCap, fallbackProvider: RC.llmFallback }).catch(() => null);
          qc = r && r.text ? quality.check(r.text, { history: st.replyHistory || [], casual: true }) : null;
        }
        if (qc && qc.ok && visLen(qc.cleaned) > hardCap) { audit({ action: 'replyLen', target: it.author, note: `${scene}仍超长跳过(${visLen(qc.cleaned)}字)` }); st.seenNotifs[key] = nowIso(); saveSt(st); continue; }
        if (qc && qc.ok) {
          // B emoji 收尾超限剥尾（剥了照发不拒发）
          let out = qc.cleaned;
          if (emojiRateHigh() && endsEmoji(out)) { const s = stripEndEmoji(out); if ([...s].length >= 3) out = s; }
          sendQueue.push({ kind: 'replyInbox', statusId, postUrl, author: it.author, text: out, sendAt: Date.now() + rand(RC.replyDelayMin[0], RC.replyDelayMin[1]) * 60000 });
          st.pendingInbox = (st.pendingInbox || []).concat([{ statusId, postUrl, author: it.author, text: out, sendAt: sendQueue[sendQueue.length - 1].sendAt }]); saveSt(st); // 10-21 bug5：待发持久化，重启不丢
          st.seenNotifs[key] = nowIso(); saveSt(st);
          queued++;
        } else { audit({ action: 'replyGen', note: `@${it.author} 生成未过门(${qc ? qc.reason : 'LLM失败'})` }); st.seenNotifs[key] = nowIso(); saveSt(st); }
      }
      // 观测日志（10-20：全天 0 产出却零日志的教训）——每轮都记录看到什么
      LOG(`页1：通知 ${items.length} 条 / 回复类 ${replyish} / 新入队 ${queued}（模板 ${greetTpl}/LLM ${queued - greetTpl}）`);
      if (items.length && !queued) audit({ action: 'inboxPoll', note: `通知${items.length}/回复类${replyish}/入队0`, sample: items.slice(0, 2).map((i) => (i.txt || '').slice(0, 40)).join(' || ') });
    } catch (e) { LOG('页1 轮询异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 页2：话题巡逻（纯云端池驱动，10-21 拍板"原有路径直接清了"）：浏览器搜索页扫描与常驻 pageTopic 已删除——池失败=本轮跳过+留痕，绝不留暗兜
  const XM = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'x-mutual.json'), 'utf8')); } catch { return null; } })();
  async function poolPosts(hours, limit) {
    const r = await fetch(`${XM.base}/v1/posts?hours=${hours}&limit=${limit}&exclude_rt=1`, { headers: { Authorization: 'Bearer ' + XM.key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('云端池 http ' + r.status);
    const d = await r.json();
    return (d.posts || []).filter((p) => p && p.text && p.author && p.author.username && !p.is_retweet)
      .sort((a, b) => (((b.metrics || {}).like_count || 0) + ((b.metrics || {}).reply_count || 0)) - (((a.metrics || {}).like_count || 0) + ((a.metrics || {}).reply_count || 0)))
      .map((p) => ({ id: p.id, author: p.author.username, text: String(p.text).replace(/\s+/g, ' ').trim().slice(0, 280), time: p.created_at, link: (p.url || '').replace('https://x.com', ''), url: p.url, locked: false, hasMedia: false }));
  }
  async function patrol() {
    try {
      let posts;
      try { posts = await poolPosts(4, 30); LOG(`页2：云端池 ${posts.length} 条（4h窗口，按互动热度排序）`); }
      catch (e) { LOG(`页2：云端池失败(${String(e.message).slice(0, 50)})，本轮跳过`); audit({ action: 'patrolSource', source: 'api-fail', note: String(e.message).slice(0, 60) }); return; }
      const fresh = posts.filter((p) => !st.seenPosts[p.id] && !OWN.has((p.author || '').toLowerCase()));
      for (const p of posts) st.seenPosts[p.id] = nowIso();
      st.material = posts.map((p) => ({ id: p.id, author: p.author, text: p.text, time: p.time })).slice(0, 12); // 页3 素材（近 1h 参考用）
      // 同作者每轮只取一条（10-20 拍板方案二）：先按作者去重再取每轮上限，活跃作者（顶帖党）一轮最多吃一条
      const seenAuth = new Set();
      const take = fresh.filter((p) => { const a = (p.author || '').toLowerCase(); if (seenAuth.has(a)) return false; seenAuth.add(a); return true; }).slice(0, RC.patrolPerRound);
      LOG(`页2：新帖 ${fresh.length} 条，取 ${take.length} 条评论`);
      for (const p of take) {
        if (aborted) break; // 回复总量帽已拆（10-20 拍板'回复不需要帽子'）；单用户上限见 userReplyCount
        if (!userCapOk(p.author)) { audit({ action: 'patrolSkip', target: p.author, note: '单用户回复上限' }); continue; }
        // 价值预判（10-21 批3②）：灌水帖不硬凑
        const worth = await judgeWorthiness({ post: p.text, author: p.author }).catch(() => '值');
        if (worth === '不值') { audit({ action: 'patrolSkip', target: p.author, note: '价值预判：灌水/零信息' }); continue; }
        // 10-22 拍板文案规则：CTA 轮换池（25% 无 CTA 直接收尾）；禁回访/串门/回踩类承诺（两号无串门模块）；教师爷刹车（不评判对方运营）
        const CTA_POOL = ['收尾自然带一句"常来往"类互动引导', '收尾带"评论区接着聊"类引导', '收尾带"互相关注"类引导', '收尾不带任何引导，内容说完就收'];
        const cta = CTA_POOL[randi(0, CTA_POOL.length - 1)];
        const r = await generateReply({ post: p.text, author: p.author, persona: (CFG.personas || {})[ACCOUNT], brief: `这是互关话题帖；真诚回应他帖子的具体内容，自然表达希望互相关注（不要声称已关注）。${cta}。禁止承诺"回访/串门/回踩"（我们不去别人主页互动）。只聊内容和盘面：不给对方的账号运营提建议、不评判对方怎么运营。`, history: recentHistory(), channel: RC.llmChannel, fallbackProvider: RC.llmFallback }).catch(() => null);
        const qc = r && r.text ? quality.check(r.text, { history: st.replyHistory || [] }) : null;
        if (!(qc && qc.ok)) { audit({ action: 'patrolGen', target: p.author, note: `生成未过门(${qc ? qc.reason : 'LLM失败'})，跳过` }); continue; }
        if (DRY) { LOG(`[DRY] 应评论 @${p.author}: ${qc.cleaned.slice(0, 30)}…`); continue; }
        // 动作隔离（10-20 用户建议）：每个动作独立临时页+用完即关，与搜索页状态彻底解耦；瞬态错误重试一次
        const postUrl = 'https://x.com' + (p.link || ('/i/web/status/' + p.id));
        let rr = await withTempPage(browser, (pg) => retryTransient(() => replyOnPage(pg, p.id, postUrl, qc.cleaned, { srcLen: [...(p.text || '')].length, targetHandle: p.author })));
        if (rr.ok || rr.unknown) { ledgerRecord('reply'); userReplyIncr(p.author); pushReplyHistory(qc.cleaned); noteReplyStyle(p.author, qc.cleaned); queueVerify({ text: qc.cleaned, statusId: p.id, target: p.author, source: 'patrolReply' }); audit({ action: 'patrolReply', target: p.author, statusId: p.id, status: rr.ok ? 'done' : 'unknown', text: qc.cleaned.slice(0, 40) }); }
        else audit({ action: 'patrolReply', target: p.author, statusId: p.id, status: 'failed', note: rr.note });
        if (rr.ok && usedToday('follow') < RC.followCapDay) {
          const fo = await withTempPage(browser, (pg) => retryTransient(() => followOnPage(pg, p.author)));
          if (fo.ok) { ledgerRecord('follow'); audit({ action: 'follow', target: p.author, note: '巡逻回复后关注' }); }
          else audit({ action: 'follow', target: p.author, status: 'failed', note: fo.note });
        }
        const g = RC.patrolPostGapSec || [25, 60]; await sleep(rand(g[0], g[1]) * 1000); // 帖间隔（10-20 拍板提速：60-180→25-60s）
      }
    } catch (e) { LOG('页2 巡逻异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 页3：互关帖（1h±0~25min 一条，素材=巡逻近帖） ──
  async function postHourly() {
    try {
      if (usedToday('post') >= RC.postCapDay) { LOG('页3：帖帽已满，跳过'); return; }
      const mat = (st.material || []).slice(0, 6).map((m) => `- @${m.author}: ${String(m.text || '').slice(0, 60)}`).join('\n');
      const r = await generateReply({
        post: mat || '（暂无话题素材）',
        persona: (CFG.personas || {})[ACCOUNT],
        brief: `写一条互关帖正文：一两句话表明认真做交易/看盘的人求互相关注；承诺只写真做到的"留言必回、互关的会回关"，禁止"回访/回踩/去你主页"类承诺（我们不去别人主页）；可参考但不得照抄话题里别人帖子的说法；正文结尾用句号，不要写任何 # 标签（系统会自动附加固定标签组）。40~100 字。`,
        history: [], channel: RC.llmChannel,
      }).catch(() => null);
      const qc = r && r.text ? quality.check(r.text, {}) : null;
      if (!(qc && qc.ok)) { audit({ action: 'hourlyGen', note: `生成未过门(${qc ? qc.reason : 'LLM失败'})` }); return; }
      if (DRY) { LOG(`[DRY] 应发互关帖: ${qc.cleaned.slice(0, 40)}… + 标签组`); return; }
      // 标签强制程序化附加（10-20 事故：LLM 系统提示禁标签+质量门剥标签双重绞杀致互关帖裸发）——确定性拼接，不依赖 LLM/质量门
      const tagless = (qc.cleaned || '').trim().replace(/[＃#][^\s＃#，。！？、]+/g, '').trim();
      const postText = tagless + '\n\n' + RC.postTags.join(' ');
      const rr = await postOnPage(pagePost, postText);
      if (rr.ok || rr.unknown) { ledgerRecord('post'); audit({ action: 'hourlyPost', status: rr.ok ? 'done' : 'unknown', text: qc.cleaned.slice(0, 50), note: rr.note }); LOG('页3：互关帖已发'); }
      else audit({ action: 'hourlyPost', status: 'failed', note: rr.note });
      await checkAbort(pagePost, '互关帖');
    } catch (e) { LOG('页3 发帖异常: ' + String(e.message).slice(0, 60)); }
  }

  // ── 云端内容（10-20 拍板每小时跟随：每小时 :50 拉，当小时额度=白天2/夜里1，余量写回文件留给下一小时） ──
  async function cloudSlot(hourKey) {
    try {
      spawnSync(process.execPath, [path.join(ROOT, 'content-pull.js'), '--account=' + ACCOUNT], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(ROOT, 'x-daily-cert.pem') } });
      const quota = cloudQuota();
      let queued = 0;
      let delayMin = 1;
      for (const f of fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : []) {
        if (!f.startsWith(`pull-${ACCOUNT}-`) || !f.endsWith('.json')) continue;
        const items = readJson(path.join(INBOX, f), []);
        const room = Math.max(0, Math.min(quota - queued, RC.postCapDay - usedToday('post') - sendQueue.filter((q) => q.kind === 'cloud').length));
        for (const it of items.slice(0, room)) {
          sendQueue.push({ kind: 'cloud', text: it.text, sendAt: Date.now() + delayMin * 60000 });
          queued++; delayMin += rand(RC.cloudGapMin[0], RC.cloudGapMin[1]);
        }
        const rest = items.slice(room);
        if (rest.length) writeJson(path.join(INBOX, f), rest); // 额度外的余量写回，下一小时继续消费
        else { try { fs.renameSync(path.join(INBOX, f), path.join(INBOX, f + '.done-' + Date.now())); } catch { } }
        if (queued >= quota) break;
      }
      audit({ action: 'cloudSlot', slot: hourKey, quota, queued, rest: fs.existsSync(INBOX) ? (fs.readdirSync(INBOX).filter((f) => f.startsWith('pull-' + ACCOUNT + '-') && f.endsWith('.json')).length) : 0 });
    } catch (e) { audit({ action: 'cloudSlot', slot: hourKey, note: String(e.message).slice(0, 60) }); }
  }

  // ── 主循环 ──
  LOG(`主循环开始，23:59 自灭（00:05 计划任务接替）；互动窗 ${IH[0]}-${IH[1]} 点，云帖全天（白天≤${cloudQuota()}条/时）；干跑=${DRY}`);
  while (!aborted && Date.now() < endAt.getTime()) {
    // 健康心跳（10-21 事故修复：僵尸态循环照跑、心跳照写，看门狗被骗 7h）：
    // 探针通过才写心跳；探针失败→清心跳+进程内重开工位（60s 冷却）；连败 15 轮→自灭交看门狗拉起
    let pagesOk = false;
    try {
      await Promise.race([
        (async () => { await browser.pages(); await pageReply.evaluate(() => 1); await pagePost.evaluate(() => 1); })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('探针超时')), 10000)),
      ]);
      pagesOk = true;
    } catch { pagesOk = false; }
    if (pagesOk) {
      st.heartbeatAt = nowIso(); st.pagesOkAt = nowIso(); st.degradedRounds = 0; saveSt(st);
    } else {
      st.degradedRounds = (st.degradedRounds || 0) + 1;
      st.heartbeatAt = null; saveSt(st); // 心跳清空：看门狗/executor 守卫立即能看到失活
      LOG(`⚠ 页面探针失败(连续${st.degradedRounds})`);
      audit({ action: 'residentDegraded', note: `probe fail x${st.degradedRounds}` });
      const cooled = !st.lastRecoverAt || Date.now() - Date.parse(st.lastRecoverAt) > 60000;
      if (cooled) {
        st.lastRecoverAt = nowIso(); saveSt(st);
        try {
          await openWorkPages();
          st.degradedRounds = 0; st.heartbeatAt = nowIso(); st.pagesOkAt = nowIso(); saveSt(st);
          LOG('✅ 工位重开成功，恢复心跳'); audit({ action: 'residentRecover', status: 'done' });
        } catch (e) { LOG('工位重开失败: ' + String(e.message).slice(0, 80)); audit({ action: 'residentRecover', status: 'failed', note: String(e.message).slice(0, 80) }); }
      }
      if ((st.degradedRounds || 0) >= 15) {
        LOG('连续恢复失败，自灭退出（看门狗 10min 内拉起）');
        st.heartbeatAt = null; saveSt(st);
        audit({ action: 'residentFatal', note: '探针连败15轮自灭' });
        try { await cleanup(); } catch { }
        process.exit(1);
      }
      await sleep(20 * 1000);
      continue;
    }
    const now = new Date();
    const hourKey = `${today()}-${now.getHours()}`;
    try {
      // 延迟发送队列最先（10-20 饥饿事故：巡逻长轮占满循环，12 条入队光速回复被饿死——
      // 回复用户是最高优先级；定时器先推进再执行，防异常/长耗时后立即重跑）
      for (let i = sendQueue.length - 1; i >= 0 && !DRY; i--) {
        const q = sendQueue[i];
        if (q.sendAt > Date.now()) continue;
        sendQueue.splice(i, 1);
        if (q.kind === 'replyInbox') {
          // 10-22 发送前守卫：statusId 缺失/非法=拒发（防"找不到目标帖还发帖"类异常路径；glm 实证现代码虽失败安全，守卫消除观测盲区）
          if (!q.statusId || !/^\d+$/.test(String(q.statusId))) {
            audit({ action: 'inboxReply', target: q.author, status: 'failed', note: 'statusId缺失拒发', postUrl: q.postUrl });
            st.pendingInbox = (st.pendingInbox || []).filter((x) => !(x.statusId === q.statusId && x.text === q.text)); saveSt(st);
            continue;
          }
          // 队列发送也包瞬态重试+兜底捕获（10-20：裸 replyOnPage 抛 ProtocolError 会把条目吃掉并冒泡打断主循环）；
          // 且走独立临时页（对照实锤：长期停在通知页的 pageReply 会 wedge，临时页从未卡过）
          // 10-21 bug2 修复：风控 toast 在临时页上读（原查 pageReply 常驻页=永远读不到，风控信号漏检）；
          // 成功/不明都写回复历史（防复读），并从持久化待发里移除（bug5 配套；10-22 改复合键——statusId 缺失时原单键比较会误删整组）
          const rr = await withTempPage(browser, async (pg) => {
            const r2 = await retryTransient(() => replyOnPage(pg, q.statusId, q.postUrl, q.text, { srcLen: [...(q.srcText || '')].length, targetHandle: q.author }));
            const risk = await riskToast(pg).catch(() => null); // 页关前读走 toast
            return { ...r2, risk };
          }).catch((e) => ({ ok: false, note: 'EXC:' + String(e.message).slice(0, 50) }));
          if (rr.ok || rr.unknown) { ledgerRecord('reply'); userReplyIncr(q.author); pushReplyHistory(q.text); noteReplyStyle(q.author, q.text); queueVerify({ text: q.text, statusId: q.statusId, target: q.author, source: 'inboxReply' }); audit({ action: 'inboxReply', target: q.author, statusId: q.statusId, postUrl: q.postUrl, status: rr.ok ? 'done' : 'unknown', text: q.text.slice(0, 40) }); }
          else audit({ action: 'inboxReply', target: q.author, statusId: q.statusId, postUrl: q.postUrl, status: 'failed', note: rr.note });
          st.pendingInbox = (st.pendingInbox || []).filter((x) => !(x.statusId === q.statusId && x.text === q.text)); saveSt(st);
          // 光速回关（10-22 拍板方案A）：回复先发出（速度不受影响），随后顺带判定回关
          if ((rr.ok || rr.unknown) && !rr.risk) await followBackIfFan(q.author);
          if (rr.risk) { const lg = loadLedger(); lg.meta.abortedToday = today(); lg.meta.abortReason = '风控toast(光速回复): ' + rr.risk; writeJson(LEDGER_FILE, lg); aborted = true; audit({ action: 'abort', note: '光速回复: ' + rr.risk }); LOG('⚠ 风控 toast，当日熔断: ' + rr.risk); break; }
        } else if (q.kind === 'cloud') {
          if (usedToday('postCloud') >= RC.postCapDay) { audit({ action: 'cloudPost', status: 'skipped', note: '云帖帽满' }); continue; }
          const rr = await retryTransient(() => postOnPage(pagePost, q.text)).catch((e) => ({ ok: false, note: 'EXC:' + String(e.message).slice(0, 50) }));
          if (rr.ok || rr.unknown) { ledgerRecord('post'); ledgerRecord('postCloud'); audit({ action: 'cloudPost', status: rr.ok ? 'done' : 'unknown', text: q.text.slice(0, 40), note: rr.note }); }
          else audit({ action: 'cloudPost', status: 'failed', note: rr.note });
          if (await checkAbort(pagePost, '云帖')) break;
        }
      }
      // 互动三路守互动窗（夜里只发帖不互动）；定时器先推进再执行（防异常/长耗时后立即重跑饿死队列）
      if (interactOk() && Date.now() >= nextReplyPoll) { nextReplyPoll = Date.now() + RC.replyPollMin * 60000; await pollNotifications(); if (aborted) break; }
      if (interactOk() && Date.now() >= nextPatrol) { nextPatrol = Date.now() + rand(RC.patrolGapMin[0], RC.patrolGapMin[1]) * 60000; await patrol(); if (aborted) break; }
      if (!topicOff && interactOk() && Date.now() >= nextPost) { nextPost = Date.now() + rand(RC.postGapMin[0], RC.postGapMin[1]) * 60000; await postHourly(); if (aborted) break; }
      // 云帖已调度化（cloud-posts.js 每小时 :50 独立调度，10-20）：常驻不再管云帖，防双发
      if (!RC.cloudScheduler && !DRY && now.getMinutes() >= (RC.cloudPullMinute != null ? RC.cloudPullMinute : 50) && st.lastCloudHour !== hourKey) {
        st.lastCloudHour = hourKey; saveSt(st); await cloudSlot(hourKey); if (aborted) break;
      }
      if (fs.existsSync(path.join(STATE_DIR, 'PAUSE-' + ACCOUNT))) { LOG('账号级人工接管（PAUSE 旗标），优雅退出'); break; } // 运行中被接管也立即收场，不用等下次启动
      if (fs.existsSync(path.join(STATE_DIR, 'PAUSE'))) { LOG('PAUSE 出现，退出'); break; }
    } catch (e) { LOG('主循环异常(继续): ' + String(e.stack || e.message).slice(0, 200)); audit({ action: 'loopError', note: String(e.stack || e.message).slice(0, 160) }); }
    await sleep(20 * 1000);
  }
  st.heartbeatAt = null; saveSt(st);
  LOG('常驻结束，清场退出');
  await cleanup();
  audit({ action: 'residentEnd', note: aborted ? '熔断' : '到点/PAUSE' });
  process.exit(0);
})().catch(async (e) => { console.error('FATAL:', e.message || e); try { const st = loadSt(); st.heartbeatAt = null; saveSt(st); } catch { } audit({ action: 'residentFatal', note: String(e.message || e).slice(0, 120) }); process.exit(1); });
