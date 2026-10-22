// feishu-report.js — 项目级运行报告推飞书群（10-21 拍板）：每 6 小时一次
// 内容：各账号数据（粉丝/雷达/今日动作量）+ 任务完成情况 + 卡点（异常清单）+ fullwin 常驻状态
// 用法: node feishu-report.js [--dry]（dry 只打印不推送）
// 凭据在 feishu.json（gitignored，严禁入库）：{app_id, app_secret, chat_id}
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const FS = JSON.parse(fs.readFileSync(path.join(ROOT, 'feishu.json'), 'utf8'));
const { ensureRadarFresh, ensureProfilesFresh } = require('./fresh-data');
const DRY = process.argv.includes('--dry');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowBj = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

// ── 推送双通道（10-21：飞书群 + Grok bot webhook，一边失败不连坐另一边） ──
async function pushCursor(text) {
  const r = await fetch(FS.cursor.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + FS.cursor.token },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text().catch(() => '');
  if (!r.ok) throw new Error('cursor webhook http ' + r.status + ': ' + t.slice(0, 100));
  return t.slice(0, 80);
}
// ── 飞书推送（自建应用：tenant_access_token → im/v1/messages） ──
async function push(text) {
  const tk = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FS.app_id, app_secret: FS.app_secret }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());
  if (!tk.tenant_access_token) throw new Error('取 tenant_access_token 失败: ' + JSON.stringify(tk).slice(0, 120));
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk.tenant_access_token },
    body: JSON.stringify({ receive_id: FS.chat_id, msg_type: 'text', content: JSON.stringify({ text }) }),
    signal: AbortSignal.timeout(15000),
  }).then((x) => x.json());
  if (r.code !== 0) throw new Error('推送失败 code=' + r.code + ' ' + JSON.stringify(r.msg || r).slice(0, 120));
  return true;
}

(async () => {
  // ── 现采（10-21 拍板）：报告生成时现场拉雷达+粉丝（TTL 内自动跳过），慢数据只留互关占比走半夜快照 ──
  const [rf, pf] = await Promise.allSettled([ensureRadarFresh(), ensureProfilesFresh()]);
  const siteBroken = rf.status === 'fulfilled' && rf.value.siteBroken;
  const freshNote = [siteBroken ? '雷达通道故障(站点改版)' : rf.status === 'fulfilled' && rf.value.fresh ? '雷达现采' : '雷达沿用快照', pf.status === 'fulfilled' && pf.value.fresh ? '粉丝现采' : '粉丝沿用快照'].join('·');
  // ── 数据聚合 ──
  const snap = readJson(path.join(STATE_DIR, 'health-snapshots', `${today()}.json`), null) || readJson(path.join(STATE_DIR, 'health-snapshots', `${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}.json`), null);
  const accounts = (CFG.accounts || []).filter((a) => a.role !== 'observer');

  const lines = [];
  lines.push(`📊 X 运营项目运行报告（${nowBj()}｜${freshNote}）`);

  for (const a of accounts) {
    const led = readJson(path.join(STATE_DIR, `ledger-${a.key}.json`), { actions: {}, meta: {} });
    const cnt = (k) => ((led.actions || {})[k] || []).filter((t) => t > Date.now() - 6 * 3600000).length; // 滚动近 6h（10-21 拍板：6h 报告配 6h 窗，不再零点清零式累计）
    const radar = snap && snap.radar && snap.radar.results && snap.radar.results[a.handle];
    const rf = !radar ? '无数据'
      : radar.channelError ? `通道故障(${String(radar.channelError).slice(0, 20)})`
      : radar.four && Object.values(radar.four).some((v) => v != null)
        ? `${radar.four.score || '?'}分${['ghost', 'deboost', 'search', 'suggestion'].filter((k) => radar.four[k] && !/未见/.test(radar.four[k])).length ? '⚠有受限' : '全绿'}${radar.staleDay ? '(昨日值)' : ''}` : '无数据';
    const foll = snap && snap.accounts && snap.accounts[a.key] && snap.accounts[a.key].profile && snap.accounts[a.key].profile.followers;
    // 环比基线=昨日收盘（昨日快照文件的最后写入值）；基线缺失如实标注；百分比仅基数≥100 时显示（新号百分比失真）
    const ySnap = readJson(path.join(STATE_DIR, 'health-snapshots', `${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}.json`), null);
    const yFoll = ySnap && ySnap.accounts && ySnap.accounts[a.key] && ySnap.accounts[a.key].profile && ySnap.accounts[a.key].profile.followers;
    let fanLine;
    if (foll == null) fanLine = '粉丝 ?';
    else if (yFoll == null) fanLine = `粉丝 ${foll}（基线缺失）`;
    else {
      const delta = foll - yFoll;
      fanLine = `粉丝 ${foll}（较昨日收盘 ${delta >= 0 ? '+' : ''}${delta}${yFoll >= 100 ? `，${delta >= 0 ? '+' : ''}${(delta / yFoll * 100).toFixed(1)}%` : ''}）`;
    }
    const aborted = led.meta && led.meta.abortedToday === today();
    lines.push(`\n@${a.handle}`);
    lines.push(`  ${fanLine}${aborted ? ' | ⛔今日已熔断' : ''}`);
    lines.push(`  雷达 ${rf}`);
    lines.push(`  近6h动作: 帖${cnt('post')} 回复${cnt('reply')} 关注${cnt('follow')} 赞${cnt('like')}${cnt('postTopic') ? `（互关帖${cnt('postTopic')}/云帖${cnt('postCloud')}）` : ''}`);
  }

  // 回复多样性观测（10-22 拍板）：近 24h 光速+巡逻回复的称呼词 Top3 / emoji 收尾率 / 巡逻 CTA 含量
  try {
    const logF = path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`);
    const cut24 = Date.now() - 24 * 3600000;
    const TERMS = ['老师', '老哥', '朋友', '兄弟', '兄dei', '大佬', '家人', '宝子', '哥们', '伙计'];
    const CTA_WORDS = ['常来往', '多交流', '多来往', '常来常往', '回访', '串门', '互相关注', '互关'];
    const termCnt = {}; let total = 0, emojiEnd = 0, patrolN = 0, patrolCta = 0;
    for (const l of fs.readFileSync(logF, 'utf8').split('\n')) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (!j.at || Date.parse(j.at) < cut24) continue;
      if (!/^(inboxReply|patrolReply)$/.test(j.action || '') || j.status !== 'done' || !j.text) continue;
      total++;
      for (const w of TERMS) if (j.text.includes(w)) termCnt[w] = (termCnt[w] || 0) + 1;
      if (/[\p{Extended_Pictographic}\uFE0F][\p{Extended_Pictographic}\uFE0F\s]*$/u.test(j.text.trim())) emojiEnd++;
      if (j.action === 'patrolReply') { patrolN++; if (CTA_WORDS.some((w) => j.text.includes(w))) patrolCta++; }
    }
    if (total) {
      const top3 = Object.entries(termCnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w}×${n}`).join('/') || '无';
      lines.push(`\n🧬 回复多样性(24h)：称呼Top3 ${top3} ｜ emoji收尾 ${Math.round(emojiEnd / total * 100)}%（目标≤30%）｜ 巡逻CTA含量 ${patrolN ? Math.round(patrolCta / patrolN * 100) : 0}%（${patrolCta}/${patrolN}）`);
    }
  } catch { }

  // fullwin 常驻状态
  const rs = readJson(path.join(STATE_DIR, 'resident-fullwin.json'), null);
  const hbAge = rs && rs.heartbeatAt ? Math.round((Date.now() - Date.parse(rs.heartbeatAt)) / 60000) : -1;
  lines.push(`\n🏠 fullwin 常驻：${hbAge >= 0 ? (hbAge < 20 ? `✅心跳 ${hbAge}min前` : `❌心跳超时 ${hbAge}min前`) : '未在运行（人工时段）'}`);

  // 待人工回复（实质提问队列，codex 裁决：审计≠待办，必须可见）
  let todoCount = 0;
  try {
    for (const a of accounts) {
      const td = readJson(path.join(STATE_DIR, 'human-todo-' + a.key + '.json'), null);
      const pend = (td && td.pending || []).filter((x) => x.status === 'pending');
      if (pend.length) { lines.push(`
📬 待你人工回复（@${a.handle}，${pend.length} 条）：`); pend.slice(0, 3).forEach((x) => lines.push('  · @' + x.author + '：' + (x.text || '').slice(0, 30) + ' → ' + x.postUrl)); todoCount += pend.length; }
    }
  } catch { }

  // 卡点=近 6 小时异常条目（与动作量同窗，6h 脉冲口径）
  const logFile = path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`);
  let abnormal = [];
  const cut6h = Date.now() - 6 * 3600000;
  try {
    for (const l of fs.readFileSync(logFile, 'utf8').trim().split('\n')) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      const tMs = Date.parse(j.at || '');
      if (!Number.isFinite(tMs) || tMs < cut6h) continue;
      if (j.dry) continue;
      if (j.status === 'failed' || j.action === 'loopError' || j.action === 'abort') abnormal.push(`${(j.account || '').slice(0, 8)} ${j.action || ''} ${(j.note || j.result || '').slice(0, 30)}`);
    }
  } catch { }
  abnormal = abnormal.slice(-6);
  lines.push(`\n🚧 卡点（近6h异常${abnormal.length ? '' : '：无'}）`);
  if (abnormal.length) lines.push(abnormal.map((x) => '  · ' + x).join('\n'));

  const text = lines.join('\n');
  console.log(text);
  if (DRY) { console.log('\n[DRY] 未推送'); return; }
  const [fR, cR] = await Promise.allSettled([push(text), pushCursor(text)]);
  if (fR.status === 'fulfilled') console.log('\n✅ 飞书群已推送'); else console.error('\n❌ 飞书推送失败:', fR.reason && fR.reason.message);
  if (cR.status === 'fulfilled') console.log('✅ Grok bot webhook 已推送'); else console.error('❌ Grok webhook 失败:', cR.reason && cR.reason.message);
  if (fR.status === 'rejected' && cR.status === 'rejected') throw new Error('两通道全部失败');
})().catch((e) => { console.error('报告失败:', e.message); process.exit(1); });
