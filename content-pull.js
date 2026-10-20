// content-pull.js — 内容源拉取器 v2（多绑定版，三方方案 2026-10-18 定稿）
// 用法: node content-pull.js [--dry]（schtasks 09:50/13:10/19:10 各跑一次，云端 9/12/18 档后、三窗前）
// 流程: 按 content-source.json bindings 逐号拉北京今天+昨天 → text_hash 去重（缺失用全文 sha256 回退）
//       → 每号独立缓冲 state/content-buffer-<local>.json（48h 时效/上限30）
//       → 滴灌条件：bound && publishAuth && publish && 账号 role=run && 非周末
//       → 滴灌量（补足制，10-20 交付必达）= 窗配额定稿数 − 存量未消费文件里的新鲜文本数；
//         存量文件全重复→归档 .done-dup 解锁；文本级去重=近2天已入队/已发队列文本（云端 text_hash 不稳的终极防线）
//       窗配额定稿={min,max} 区间按"日期+窗+账号"种子掷确定数，与 planner 消费帽同源同数
// 降级: 单日拉取失败跳过不写结论；key 失效(401/403)本轮全停投递并告警；周末不投递（缓冲照常更新/过期）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'content-source.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const INBOX = path.join(ROOT, 'posts-inbox');
const PULL_ONLY = ((process.argv.find((a) => a.startsWith('--account=')) || '').slice('--account='.length) || '').trim(); // 只拉指定号（常驻进程用，防给窗号误滴
const DRY = process.argv.includes('--dry');
// 北京时间口径（服务器 date 参数按 sent_at 北京落盘日期过滤；slot 日期≠落盘日期，实测坑）
const bjDate = (offDays = 0) => new Date(Date.now() + 8 * 3600000 + offDays * 86400000).toISOString().slice(0, 10);
const LOG = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJson(p, j) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
function audit(obj) { fs.appendFileSync(path.join(STATE_DIR, `log-${bjDate(0).slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), task: 'contentPull', ...obj }) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash('sha256').update(String(t).trim()).digest('hex');

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { err: r.status };
  try { return { data: await r.json() }; } catch { return { err: 'badjson' }; }
}

// 下一执行窗（滴灌目标）：am<10:20 / mid<15:20 / pm 其余
function nextWindow() { const m = new Date(Date.now() + 8 * 3600000).getUTCHours() * 60 + new Date(Date.now() + 8 * 3600000).getUTCMinutes(); return m < 575 ? 'p1' : m < 755 ? 'p2' : m < 1175 ? 'p3' : 'p1'; } // 发布窗 09:35/12:35/19:35（分钟界 575/755/1175）
// 今日已入队帖数（该号）：扫今日各窗队列里 type=post 且未跳过的条目（10-20 修复：窗名写死 am/mid/pm 永远数 0，日帽形同虚设 → 改读 config.rounds.windows 键）
function enqueuedToday(local) {
  let n = 0;
  for (const w of Object.keys((CFG.rounds || {}).windows || { p1: 1, p2: 1, p3: 1 })) {
    const q = readJson(path.join(ROOT, 'queue', `${bjDate(0)}-${w}-${local}.json`), []);
    if (Array.isArray(q)) n += q.filter((e) => e && e.type === 'post' && e.status !== 'skipped').length;
  }
  return n;
}
// 近2天该号已入队/已发帖文本集（10-20 交付必达：云端 text_hash 不稳时同一文案会重复入缓冲——
// 10-20 11:26 重滴 butcher P1 三帖、P2 窗被重复文件堵死 0 发帖的事故根因；文本级去重与哈希无关，确定性防线）
function postedTexts(local) {
  const set = new Set();
  for (let d = 0; d < 2; d++) {
    const date = bjDate(-d);
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT, 'queue')).filter((f) => f.startsWith(`${date}-`) && f.endsWith(`-${local}.json`)); } catch { }
    for (const f of files) {
      const q = readJson(path.join(ROOT, 'queue', f), []);
      if (Array.isArray(q)) for (const e of q) if (e && e.text) set.add(String(e.text).trim());
    }
  }
  return set;
}

(async () => {
  const BUDGET = (CFG.posts && CFG.posts.budget) || { perDay: 2, windowAllocation: { am: 1, mid: 0, pm: 1 } };
  const isWeekend = [0, 6].includes(new Date(Date.now() + 8 * 3600000).getUTCDay()) && !(CFG.posts || {}).weekendPublish; // 10-18 用户拍板放开周末投递（weekendPublish=true）
  const roleOf = (k) => (CFG.accounts.find((a) => a.key === k) || {}).role;
  let keyFailed = false;

  for (const b of SRC.bindings || []) {
    if (!b.bound) continue;
    if (PULL_ONLY && b.local !== PULL_ONLY) continue; // 10-20 修复：PULL_ONLY 声明后从未生效——fullwin 常驻每小时/看门狗拉起都给全矩阵误滴（11:26 重滴事故通道）；常驻进程只许碰自己的号
    const acct = CFG.accounts.find((a) => a.key === b.local);
    if (!acct) { LOG(`绑定 ${b.local} 无本地账号，跳过`); continue; }
    const bufFile = path.join(STATE_DIR, `content-buffer-${b.local}.json`);
    const st = readJson(bufFile, { pulled: {}, buffer: [] });
    let fetched = 0, fresh = 0, keyErr = false;

    for (const d of [bjDate(0), bjDate(-1)]) {
      if (keyFailed || keyErr) break;
      const j = await fetchJSON(`${SRC.base}/sent?key=${encodeURIComponent(SRC.key)}&account=${encodeURIComponent(b.source)}&date=${d}`);
      if (j.err === 401 || j.err === 403) { keyErr = true; break; }
      if (j.err || !j.data) { LOG(`[${b.local}] 拉取 ${d} 失败(${j.err || '空'})，跳过该日（不写结论）`); continue; }
      const items = j.data.items || [];
      fetched += items.length;
      for (const it of items) {
        const h = it.text_hash || sha(it.text); // 全文哈希回退（Codex：比前64字符更稳）
        if (st.pulled[h]) continue;
        st.pulled[h] = new Date().toISOString();
        st.buffer.push({ text: it.text, hash: h, slot: it.slot, sentAt: it.sent_at, quote: !!it.quote, quoteUrl: it.quote_url || null }); // quote/quote_url（说明书 v3 引用帖标记，云端保证每档≤4）；send_ok 不消费
        fresh += 1;
      }
      await sleep(1200);
    }
    if (keyErr) { keyFailed = true; LOG(`⚠ key 失效(${b.local}，401/403)，本轮全停投递，请换 key`); audit({ action: 'keyFail', account: b.local }); }

    // 时效清理：>48h 丢弃；缓冲上限 30；pulled 留最近 500
    const cut48 = Date.now() - 48 * 3600000;
    const before = st.buffer.length;
    st.buffer = st.buffer.filter((x) => { const t = Date.parse(x.sentAt); return Number.isFinite(t) ? t > cut48 : true; });
    const dropped = before - st.buffer.length;
    if (st.buffer.length > 30) st.buffer = st.buffer.slice(-30);
    const pk = Object.entries(st.pulled).sort((a, c) => Date.parse(c[1]) - Date.parse(a[1]));
    st.pulled = Object.fromEntries(pk.slice(0, 500));

    // 滴灌决策（10-18 wcixot 接入：授权完全由绑定三开关表达——publishAuth 本身就是用户给的发布授权，不再要求 role=run；
    //   非 run 的发布授权号（如 wcixot）走"拉取后即时轻通道"：滴灌完直接拉起 planner(post)+executor，不占 butcher 三窗）
    let wrote = 0, why = '';
    const canPublish = b.bound && b.publishAuth && b.publish;
    let unconsumed = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.startsWith(`pull-${b.local}-`) && f.endsWith('.json')) : [];
    // 超时清理（10-19 修复）：>2h 未消费的投递文件自动改名 .done-stale，防止空文件死锁全天发布
    for (const sf of unconsumed) {
      try {
        const st2 = fs.statSync(path.join(INBOX, sf));
        if (Date.now() - st2.mtimeMs > 2 * 3600000) {
          fs.renameSync(path.join(INBOX, sf), path.join(INBOX, sf + '.done-stale-' + Date.now()));
          LOG(`清理超时未消费文件: ${sf}（>2h）`);
        }
      } catch { }
    }
    unconsumed = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((f) => f.startsWith(`pull-${b.local}-`) && f.endsWith('.json')) : [];
    if (keyFailed) why = 'key失效全停';
    else if (!canPublish) why = `未授权/未开闸(publishAuth=${b.publishAuth},publish=${b.publish})`;
    else if (isWeekend) why = '周末不投递（拍板 P5）';
    else {
      const BA = (CFG.posts && CFG.posts.budgetByAccount || {})[b.local] || BUDGET;
      const w = nextWindow();
      const allocR = (BA.windowAllocation || {})[w] ?? 0;
      // 10-20 定稿：{min,max} 区间用"日期+窗+账号"做种子掷确定数，与 planner 消费帽同源同数（原两边各自随机=滴3条帽6条的错位）
      const seedRoll = (mn, mx) => { const s = `${bjDate(0)}|${w}|${b.local}|${mn}|${mx}`; let hh = 0; for (let i = 0; i < s.length; i++) hh = (hh * 31 + s.charCodeAt(i)) >>> 0; return mn + (hh % (mx - mn + 1)); };
      const alloc = allocR && typeof allocR === 'object' ? seedRoll(allocR.min, allocR.max) : allocR;
      const posted = postedTexts(b.local);
      // 存量未消费文件（10-20 补足制，拆"一文件堵一窗"）：全重复→归档 .done-dup 解锁；部分有效→留作基座按窗配额定稿数补差额
      let base = [];
      if (unconsumed.length) {
        const f0 = unconsumed.sort()[0];
        const items = (readJson(path.join(INBOX, f0), []) || []).filter((x) => x && x.text);
        const fresh = items.filter((x) => !posted.has(String(x.text).trim()));
        if (!fresh.length && items.length) {
          if (DRY) LOG(`[DRY] 应归档全重复投递文件: ${f0}（${items.length} 条均已入过今日队列）`);
          else { try { fs.renameSync(path.join(INBOX, f0), path.join(INBOX, f0 + '.done-dup-' + Date.now())); LOG(`归档全重复投递文件: ${f0}（${items.length} 条均已入过今日队列）`); } catch { } }
        } else base = fresh.map((x) => ({ text: x.text, quote: !!x.quote, quoteUrl: x.quoteUrl || null }));
      }
      const perDayLeft = (BA.perDay || 2) - enqueuedToday(b.local);
      const deficit = Math.min(alloc, perDayLeft) - base.length;
      if (deficit <= 0) why = base.length ? `投递箱存量 ${base.length} 条已达窗配额定稿 ${alloc}（补足制，无需新滴）` : `预算不足(${w}窗=${alloc}，今日已入队=${enqueuedToday(b.local)})`;
      else if (!DRY) {
        const batch = [];
        for (const x of st.buffer) {
          if (batch.length >= deficit) break;
          const t = String(x.text).trim();
          if (posted.has(t) || base.some((y) => String(y.text).trim() === t) || batch.some((y) => String(y.text).trim() === t)) continue; // 文本级去重（近2天已发/已排/本批内）
          batch.push(x);
        }
        if (!batch.length) why = `缓冲无新鲜文本（需补 ${deficit}，缓冲 ${st.buffer.length} 条全是近2天已发/已排）`;
        else {
          // 即时轻通道健康门前置（仅非 run 授权号）：先过门再写文件，不过门则不写不耗缓冲
          if (roleOf(b.local) !== 'run') {
            let gate = '通过';
            try {
              const snap = readJson(path.join(STATE_DIR, 'health-snapshots', `${bjDate(0)}.json`), {});
              const e = snap.accounts && snap.accounts[b.local];
              if (e && ((e.verdict === 'suspended') || (e.profile && e.profile.state === 'suspended') || (e.statuses && (e.statuses.sensitiveCount || 0) > 0))) gate = '停发';
            } catch { }
            if (gate === '停发') { why = '健康门：停发（suspended/敏感标记），投递保留待下轮'; }
          }
          if (!why) {
            const used = new Set(batch.map((x) => x.hash));
            st.buffer = st.buffer.filter((x) => !used.has(x.hash));
            const all = base.concat(batch.map((x) => ({ text: x.text, quote: x.quote || undefined, quoteUrl: x.quoteUrl || undefined })));
            if (base.length) writeJson(path.join(INBOX, unconsumed.sort()[0]), all); // 补足原文件（同名复写，planner 整文件消费）
            else writeJson(path.join(INBOX, `pull-${b.local}-${Date.now()}.json`), all);
            wrote = batch.length;
            if (roleOf(b.local) !== 'run') {
              const { spawn } = require('child_process');
              spawn(process.execPath, [path.join(ROOT, 'planner.js'), '--account', b.local, '--mode', 'post', '--window', w], { detached: true, stdio: 'ignore', cwd: ROOT }).unref();
              LOG(`[${b.local}] 即时通道：planner(post,${w}) 已拉起（run 号走三窗，此号拉完即排）`);
            }
          }
        }
      } else why = `[DRY] 应补足 ${deficit} 条（基座 ${base.length}，未写入）`;
    }
    if (!DRY) writeJson(bufFile, st);
    audit({ action: 'pull', account: b.local, source: b.source, fetched, fresh, dropped, buffered: st.buffer.length, wrote, note: why || undefined, dry: DRY || undefined });
    LOG(`[${b.local}] 拉${fetched} 新${fresh} 弃${dropped} 缓冲${st.buffer.length} 投递${wrote}${why ? '（' + why + '）' : ''}`);
  }
  if (DRY) console.log('[DRY] 决策预览：未写任何状态/投递文件');
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
