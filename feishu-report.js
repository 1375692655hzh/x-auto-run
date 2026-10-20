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
  const freshNote = [rf.status === 'fulfilled' && rf.value.fresh ? '雷达现采' : '雷达沿用快照', pf.status === 'fulfilled' && pf.value.fresh ? '粉丝现采' : '粉丝沿用快照'].join('·');
  // ── 数据聚合 ──
  const snap = readJson(path.join(STATE_DIR, 'health-snapshots', `${today()}.json`), null) || readJson(path.join(STATE_DIR, 'health-snapshots', `${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}.json`), null);
  const accounts = (CFG.accounts || []).filter((a) => a.role !== 'observer');
  const cut = new Date(); cut.setHours(0, 0, 0, 0);
  const cutMs = cut.getTime();

  const lines = [];
  lines.push(`📊 X 运营项目运行报告（${nowBj()}｜${freshNote}）`);

  for (const a of accounts) {
    const led = readJson(path.join(STATE_DIR, `ledger-${a.key}.json`), { actions: {}, meta: {} });
    const cnt = (k) => ((led.actions || {})[k] || []).filter((t) => t > cutMs).length;
    const radar = snap && snap.radar && snap.radar.results && snap.radar.results[a.handle];
    const rf = radar && radar.four && Object.values(radar.four).some((v) => v != null)
      ? `${radar.four.score || '?'}分${['ghost', 'deboost', 'search', 'suggestion'].filter((k) => radar.four[k] && !/未见/.test(radar.four[k])).length ? '⚠有受限' : '全绿'}` : '无数据';
    const foll = snap && snap.accounts && snap.accounts[a.key] && snap.accounts[a.key].profile && snap.accounts[a.key].profile.followers;
    const aborted = led.meta && led.meta.abortedToday === today();
    lines.push(`\n@${a.handle}`);
    lines.push(`  粉丝 ${foll ?? '?'} | 雷达 ${rf}${aborted ? ' | ⛔今日已熔断' : ''}`);
    lines.push(`  今日动作: 帖${cnt('post')} 回复${cnt('reply')} 关注${cnt('follow')} 赞${cnt('like')}${cnt('postTopic') ? `（互关帖${cnt('postTopic')}/云帖${cnt('postCloud')}）` : ''}`);
  }

  // fullwin 常驻状态
  const rs = readJson(path.join(STATE_DIR, 'resident-fullwin.json'), null);
  const hbAge = rs && rs.heartbeatAt ? Math.round((Date.now() - Date.parse(rs.heartbeatAt)) / 60000) : -1;
  lines.push(`\n🏠 fullwin 常驻：${hbAge >= 0 ? (hbAge < 20 ? `✅心跳 ${hbAge}min前` : `❌心跳超时 ${hbAge}min前`) : '未在运行（人工时段）'}`);

  // 卡点=今日异常条目
  const logFile = path.join(STATE_DIR, `log-${today().slice(0, 7)}.jsonl`);
  let abnormal = [];
  try {
    for (const l of fs.readFileSync(logFile, 'utf8').trim().split('\n')) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (!j.at || Date.parse(j.at) < cutMs - 8 * 3600000) continue; // 北京零点起
      if (j.dry) continue;
      if (j.status === 'failed' || j.action === 'loopError' || j.action === 'abort') abnormal.push(`${(j.account || '').slice(0, 8)} ${j.action || ''} ${(j.note || j.result || '').slice(0, 30)}`);
    }
  } catch { }
  abnormal = abnormal.slice(-6);
  lines.push(`\n🚧 卡点（今日异常 ${abnormal.length ? '' : '：无'}）`);
  if (abnormal.length) lines.push(abnormal.map((x) => '  · ' + x).join('\n'));

  const text = lines.join('\n');
  console.log(text);
  if (DRY) { console.log('\n[DRY] 未推送'); return; }
  const [fR, cR] = await Promise.allSettled([push(text), pushCursor(text)]);
  if (fR.status === 'fulfilled') console.log('\n✅ 飞书群已推送'); else console.error('\n❌ 飞书推送失败:', fR.reason && fR.reason.message);
  if (cR.status === 'fulfilled') console.log('✅ Grok bot webhook 已推送'); else console.error('❌ Grok webhook 失败:', cR.reason && cR.reason.message);
  if (fR.status === 'rejected' && cR.status === 'rejected') throw new Error('两通道全部失败');
})().catch((e) => { console.error('报告失败:', e.message); process.exit(1); });
