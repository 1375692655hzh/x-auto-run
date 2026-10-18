
var DATA = null, CUR = '__overview__';
function vDot(v) { return v === 'green' ? 'g' : v === 'suspended' ? 'r' : 'u'; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function switchTab(t) {
  document.getElementById('tab-data').className = t === 'data' ? 'on' : '';
  document.getElementById('tab-task').className = t === 'task' ? 'on' : '';
  document.getElementById('view-data').style.display = t === 'data' ? '' : 'none';
  document.getElementById('view-task').style.display = t === 'task' ? '' : 'none';
}
function pick(i) {
  CUR = i === -1 ? '__overview__' : DATA.accounts[i].key;
  render();
}
function render() {
  var isOverview = CUR === '__overview__';
  var side = '<button class="acct-btn' + (isOverview ? ' on' : '') + '" onclick="pick(-1)" style="border-bottom:1px solid #1b3247;margin-bottom:10px;padding-bottom:12px">'
    + '<span style="font-size:18px">📊</span><span class="nm" style="font-size:15px">总览</span>'
    + '<div class="h">' + (DATA.overview && DATA.overview.alerts && DATA.overview.alerts.length ? DATA.overview.alerts.length + ' 项需关注' : '全部正常') + '</div></button>';
  for (var i = 0; i < DATA.accounts.length; i++) {
    var a = DATA.accounts[i];
    side += '<button class="acct-btn' + (a.key === CUR ? ' on' : '') + '" onclick="pick(' + i + ')" title="' + esc(a.roleNote) + '">'
      + '<span class="dot ' + vDot(a.verdict) + '"></span><span class="nm">' + esc(a.name) + '</span>' + (a.isRun ? '' : ' <span class="linkchip">' + (a.role === 'observer' ? '观察者' : '仅接入') + '</span>')
      + '<div class="h">@' + esc(a.handle) + (a.metrics[0].val != null ? ' · ' + a.metrics[0].val + '粉' : '') + '</div></button>';
  }
  document.getElementById('accts').innerHTML = side;
  document.getElementById('meta').textContent = '生成 ' + new Date(DATA.generatedAt).toLocaleTimeString('zh-CN') + ' · 60s 自动刷新';
  document.getElementById('tabs').style.display = isOverview ? 'none' : '';
  document.getElementById('view-title').textContent = isOverview ? '' : cur() ? cur().name + ' · @' + cur().handle : '';
  document.getElementById('view-overview').style.display = isOverview ? '' : 'none';
  if (isOverview) {
    document.getElementById('view-overview').innerHTML = renderOverview();
  } else {
    document.getElementById('view-overview').innerHTML = '';
    document.getElementById('view-data').innerHTML = renderData(cur());
    document.getElementById('view-task').innerHTML = renderTask(cur());
    // 修复（10-18）：从总览切到账号时数据页一直 display:none——内容填了但看不见
    // 默认显示"数据"页签（如果用户没手动切到任务页）
    if (document.getElementById('view-data').style.display === 'none' && document.getElementById('view-task').style.display === 'none') {
      switchTab('data');
    }
  }
}

// ── 总览层（10-18 三方方案 ③）────────────────────────────
function renderOverview() {
  if (!DATA.overview) return '<div class="card">总览数据未就绪</div>';
  var ov = DATA.overview;
  var runAccounts = DATA.accounts.filter(function(a) { return a.isRun; });
  var otherAccounts = DATA.accounts.filter(function(a) { return !a.isRun; });
  var h = '';

  // A'. 急停横幅
  if (ov.pause) h += '<div style="background:#c0392b;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:12px;font-size:15px;font-weight:700">⏸ 急停生效中（state/PAUSE）——全部任务已停止 · 删除 PAUSE 文件恢复</div>';

  // A. 系统状态条
  var hb = ov.heartbeatAt ? new Date(Date.parse(ov.heartbeatAt) + 8 * 3600000).toISOString().slice(11, 16) : '—';
  var nw = ov.nextWindow ? ov.nextWindow.time + ' ' + ov.nextWindow.key + '（' + ov.nextWindow.modes + '）' : '今天窗口已全部结束';
  h += '<div class="card" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;background:' + (ov.pause ? '#fdecea' : '#eef7f1') + '">';
  h += '<div style="font-size:15px;font-weight:700;color:' + (ov.pause ? '#c0392b' : '#1f6e43') + '">' + (ov.pause ? '■ 急停中' : '● 系统运行中') + '</div>';
  h += '<div style="font-size:13px;color:#51606e">上一动作 ' + hb + ' · 下一窗口 <b>' + esc(nw) + '</b></div>';
  h += '</div>';

  // C. 异常收件箱（无异常显式"✓ 无"）
  h += '<div class="card" style="padding:10px 16px;' + (ov.alerts.length ? 'border-left:4px solid #e5484d' : '') + '">';
  h += '<div style="font-weight:700;font-size:14px;margin-bottom:6px">需要关注（' + ov.alerts.length + '）</div>';
  if (!ov.alerts.length) h += '<div style="font-size:13px;color:#1f6e43">✓ 无异常 · 全部正常</div>';
  else for (var i = 0; i < ov.alerts.length; i++) {
    var al = ov.alerts[i];
    h += '<div style="font-size:13px;padding:3px 0;color:' + (al.level === 'P0' ? '#c0392b' : al.level === 'P1' ? '#c2761b' : '#51606e') + '">' + (al.level === 'P0' ? '🔴' : al.level === 'P1' ? '🟡' : '🔵') + ' ' + esc(al.text) + '</div>';
  }
  h += '</div>';

  // B. 双号并排卡
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
  for (var j = 0; j < runAccounts.length; j++) {
    var a = runAccounts[j];
    var radarScore = a.radar && a.radar.four ? (a.radar.four.score || '?') : '?';
    var radarBad = a.radar && a.radar.four ? ['ghost','deboost','search','suggestion'].filter(function(k){ return a.radar.four[k] && !/未见/.test(a.radar.four[k]); }).length : 0;
    var hbc = '✓正常'; if (a.verdict === 'suspended') hbc = '✕封禁'; else if (radarBad > 0) hbc = '◐受限';
    var postsDone = 0, communityDone = 0, visitDone = 0, totalActions = 0;
    for (var k = 0; k < a.quotas.length; k++) {
      totalActions += a.quotas[k].done || 0;
      if (a.quotas[k].label === '原创发布') postsDone = a.quotas[k].done;
      if (a.quotas[k].label === '互关评论') communityDone = a.quotas[k].done;
      if (a.quotas[k].label === '关系串门') visitDone = a.quotas[k].done;
    }
    var nextPost = ov.postsQueue.filter(function(p) { return p.account === a.key && p.status === 'planned' && Date.parse(p.postAt) > Date.now(); })[0];
    h += '<div class="card" style="padding:12px 16px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px"><b style="font-size:15px">' + esc(a.name) + '</b><span style="font-size:12px;color:' + (hbc === '✓正常' ? '#1f6e43' : hbc === '✕封禁' ? '#c0392b' : '#c2761b') + '">' + hbc + ' · 雷达' + radarScore + '</span></div>';
    h += '<div style="font-size:12px;color:#6b7885;margin-bottom:8px">@' + esc(a.handle) + ' · 今日真实动作 ' + totalActions + ' 件</div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
    h += '<span style="background:#eef3f8;padding:3px 8px;border-radius:5px;font-size:12px">发帖 ' + postsDone + '</span>';
    h += '<span style="background:#eef3f8;padding:3px 8px;border-radius:5px;font-size:12px">互关评 ' + communityDone + '</span>';
    h += '<span style="background:#eef3f8;padding:3px 8px;border-radius:5px;font-size:12px">串门 ' + visitDone + '</span>';
    if (nextPost) h += '<span style="background:#fff3e0;padding:3px 8px;border-radius:5px;font-size:12px">⏱下一帖 ' + new Date(Date.parse(nextPost.postAt) + 8 * 3600000).toISOString().slice(11, 16) + '</span>';
    h += '</div></div>';
  }
  h += '</div>';

  // D. 今日节奏条
  h += '<div class="card" style="padding:10px 16px"><div style="font-weight:700;font-size:14px;margin-bottom:8px">今日节奏</div><div style="display:flex;gap:4px;flex-wrap:wrap">';
  var bjNowMin = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
  for (var w = 0; w < ov.windowsList.length; w++) {
    var win = ov.windowsList[w];
    var isPast = win.time < bjNowMin;
    var isNext = ov.nextWindow && win.time === ov.nextWindow.time;
    h += '<span style="padding:4px 8px;border-radius:5px;font-size:12px;' + (isPast ? 'background:#e2f4e8;color:#1f6e43' : isNext ? 'background:#fff3cd;color:#856404;font-weight:700' : 'background:#f1f3f6;color:#8a97a3') + '">' + (isPast ? '✓' : isNext ? '◉' : '○') + ' ' + win.time + ' ' + win.key + '</span>';
  }
  h += '</div></div>';

  // F. 接入号胶囊
  if (otherAccounts.length) {
    h += '<div class="card" style="padding:8px 16px"><div style="font-size:12px;color:#8a97a3;margin-bottom:6px">接入号（不执行任务）</div><div style="display:flex;gap:8px;flex-wrap:wrap">';
    for (var o = 0; o < otherAccounts.length; o++) {
      var oa = otherAccounts[o];
      h += '<span style="background:#f1f3f6;padding:3px 10px;border-radius:12px;font-size:12px">' + esc(oa.name) + ' · ' + (oa.metrics[0].val != null ? oa.metrics[0].val + '粉' : '?') + ' · 雷达' + (oa.radar && oa.radar.four ? oa.radar.four.score || '?' : '?') + '</span>';
    }
    h += '</div></div>';
  }

  // 动作流 15 条
  h += '<div class="card"><h3>今日动作流（实时）</h3>';
  if (!ov.actionStream.length) h += '<div style="font-size:13px;color:#8a97a3;padding:8px 0">今日尚无真实动作</div>';
  else {
    h += '<table style="width:100%;font-size:13px"><tr style="color:#8a97a3;font-size:11px"><td style="width:60px">时间</td><td style="width:70px">账号</td><td style="width:60px">动作</td><td>对象</td><td style="width:30px">结果</td></tr>';
    for (var s = 0; s < ov.actionStream.length; s++) {
      var as2 = ov.actionStream[s];
      h += '<tr><td>' + as2.at + '</td><td>' + esc(as2.account) + '</td><td>' + esc(as2.action) + '</td><td>' + esc(as2.target) + '</td><td>' + as2.status + '</td></tr>';
    }
    h += '</table>';
  }
  h += '</div>';

  // 定时帖队列
  if (ov.postsQueue.length) {
    h += '<div class="card"><h3>定时帖队列</h3><table style="width:100%;font-size:13px"><tr style="color:#8a97a3;font-size:11px"><td style="width:60px">时刻</td><td style="width:70px">账号</td><td>内容</td><td style="width:50px">状态</td></tr>';
    for (var p = 0; p < ov.postsQueue.length; p++) {
      var pq = ov.postsQueue[p];
      var pst = pq.status === 'done' ? '✓ 已发' : pq.status === 'unknown' ? '? 不明' : pq.status === 'skipped' ? '跳过' : Date.parse(pq.postAt) > Date.now() ? '⏱ 待发' : '⚠ 过点';
      h += '<tr><td>' + (pq.postAt || '').slice(11, 16) + '</td><td>' + esc(pq.account) + '</td><td>' + esc(pq.text) + (pq.quote ? ' <b style="color:#1d6fb8">[引用]</b>' : '') + '</td><td>' + pst + '</td></tr>';
    }
    h += '</table></div>';
  }

  // 7 日完成趋势（④）+ 周汇总
  if (ov.trend && ov.trend.length) {
    h += '<div class="card"><h3>近 7 日完成趋势<span style="font-weight:400;font-size:11px;color:#98a5b1">（完成量柱 · 完成率行 · 口径：条件任务不计分母）</span></h3>';
    h += '<div style="display:flex;gap:3px;align-items:flex-end;height:50px;margin:8px 0">';
    var maxD = Math.max.apply(null, ov.trend.map(function(x){return x.done;})) || 1;
    for (var t = 0; t < ov.trend.length; t++) {
      var tr = ov.trend[t];
      var bh = Math.round((tr.done / maxD) * 44) + 3;
      h += '<div style="flex:1;text-align:center"><div style="background:#4a9e6f;height:' + bh + 'px;border-radius:2px" title="' + tr.d + ' 完成' + tr.done + '"></div><div style="font-size:9px;color:#8a97a3;margin-top:2px">' + tr.d.slice(5) + '</div></div>';
    }
    h += '</div>';
    var totalDone = 0, totalPlan = 0;
    for (var t2 = 0; t2 < ov.trend.length; t2++) { totalDone += ov.trend[t2].done; totalPlan += ov.trend[t2].planned; }
    h += '<div style="font-size:13px;color:#51606e">周汇总：真实动作 <b>' + totalDone + '</b> 件 · 完成率 <b>' + (totalPlan > 0 ? Math.round(totalDone / totalPlan * 100) : 0) + '%</b> · 日报 ' + (ov.weekSummary ? ov.weekSummary.reportsGenerated : '?') + '/' + (ov.weekSummary ? ov.weekSummary.days : 7) + '</div>';
    h += '</div>';
  }

  // title 前缀
  var alertCount = ov.alerts.filter(function(x) { return x.level === 'P0' || x.level === 'P1'; }).length;
  document.title = (ov.pause ? '[急停]' : alertCount ? '[' + alertCount + '项异常]' : '') + ' X 运营监控';

  return h;
}
function cur() { for (var k = 0; k < DATA.accounts.length; k++) if (DATA.accounts[k].key === CUR) return DATA.accounts[k]; return DATA.accounts[0]; }

function renderData(a) {
  var h = '<div class="row1">';
  // 左：核心指标（3×2）
  h += '<div class="card"><h3>核心指标<span class="src">快照差值 · 红涨绿跌</span></h3><div class="grid6">';
  for (var i = 0; i < a.metrics.length; i++) {
    var m = a.metrics[i];
    h += '<div class="metric"><div class="label">' + esc(m.label) + '</div><div class="val' + (m.isRatio ? ' ratio-v' : '') + '">' + (m.val != null ? m.val : '—') + '</div><div class="delta ' + m.cls + '">' + esc(m.txt) + '</div></div>';
  }
  h += '</div></div>';
  // 右：健康四维度（radar 渲染通道优先，无则退回自建三通道）
  if (a.radar && a.radar.four) {
    var f = a.radar.four;
    var rows = [['搜索建议限制', f.suggestion], ['搜索限制', f.search], ['回复隐藏(幽灵)', f.ghost], ['回复排序降低', f.deboost]];
    h += '<div class="card"><h3>健康监测 · 四维度<span class="src">shadowbanradar 渲染通道 · ' + (f.score || '?') + '/100 ' + esc(f.verdict || '') + ' · ' + new Date(a.radar.fetchedAt).toLocaleString('zh-CN') + '</span></h3><div class="dims">';
    for (var k3 = 0; k3 < rows.length; k3++) {
      var v3 = rows[k3][1];
      var icon3 = v3 == null ? ['◐', 'unk-t'] : (/未见/.test(v3) ? ['✓', 'ok-t'] : ['✕', 'down']);
      h += '<div class="dim"><div class="icon ' + icon3[1] + '">' + icon3[0] + '</div><div class="name">' + rows[k3][0] + '</div><div class="st">' + esc(v3 || '未知') + '</div></div>';
    }
    h += '</div><div style="font-size:11px;margin-top:6px"><a href="' + esc(a.radar.url) + '" target="_blank" style="color:#3d8fd1">结果页 ↗</a></div></div>';
  } else {
    h += '<div class="card"><h3>健康监测 · 四维度<span class="src">自建通道（radar 当日未跑）</span></h3><div class="dims">';
    for (var j = 0; j < a.dims.length; j++) {
      var d = a.dims[j];
      h += '<div class="dim"><div class="icon ' + d.cls + '">' + d.icon + '</div><div class="name">' + esc(d.name) + '</div><div class="st">' + esc(d.st) + '</div></div>';
    }
    h += '</div></div>';
  }
  h += '</div>';
  // 两图并排
  h += '<div class="charts2">' + chartLine(a) + chartBar(a) + '</div>';
  // 关系池两表
  h += '<div class="pool2">';
  h += '<div class="card"><h3>关系池 · 今日互动<span class="src">今晨通知扫描所得</span></h3><table><tr><th>#</th><th>对象</th><th>得分</th><th>互动</th></tr>';
  if (!a.poolSummary) h += '<tr><td colspan="4" class="flat">未建池</td></tr>';
  else if (!a.todayPool.length) h += '<tr><td colspan="4" class="flat">' + (a.scanToday ? '今日暂无新增互动' : '今日扫描未运行（09:35 任务）') + '</td></tr>';
  else for (var p = 0; p < a.todayPool.slice(0, 10).length; p++) {
    var tp = a.todayPool[p];
    h += '<tr><td>' + (p + 1) + '</td><td class="l">@' + esc(tp.handle) + '</td><td><b>' + tp.score + '</b></td><td>' + esc(tp.types) + '</td></tr>';
  }
  h += '</table></div>';
  h += '<div class="card"><h3>关系池 · 历史得分（日更）<span class="src">近30天互惠分 · NEW=入池未接触</span></h3><table><tr><th>#</th><th>对象</th><th>得分</th><th>最近互动</th></tr>';
  if (!a.topPool.length) h += '<tr><td colspan="4" class="flat">未建池</td></tr>';
  for (var q = 0; q < a.topPool.length; q++) {
    var tp2 = a.topPool[q];
    h += '<tr><td>' + (q + 1) + '</td><td class="l">@' + esc(tp2.handle) + (tp2.isNew ? ' <span class="badge new">NEW</span>' : '') + '</td><td><b>' + tp2.score + '</b></td><td>' + esc(tp2.last) + '</td></tr>';
  }
  if (a.poolSummary) h += '<tr><td colspan="4" class="flat">池共 ' + a.poolSummary.size + ' 人 = 近14天真互动 ' + a.poolSummary.real14 + ' + 更早 ' + a.poolSummary.realOld + ' + Owen圈候选 ' + a.poolSummary.owenOnly + '（不用于串门）｜归档 ' + a.poolSummary.archived + '｜分层：' + (Object.keys(a.poolSummary.by).map(function (k2) { return k2 + ':' + a.poolSummary.by[k2]; }).join(' ') || '空') + '</td></tr>';
  h += '</table></div></div>';
  // 权重维护账号池
  h += '<div class="card"><h3>权重维护账号池<span class="src">维护矩阵（10-17 拍板）：所有号维护 butcher+owen 的权重，各自排除自己；实际执行以各行为准</span></h3><table><tr><th>账号</th><th>维护类型</th><th>接入方式</th><th>状态</th><th>近7日记录</th></tr>';
  for (var w = 0; w < a.maintain.length; w++) {
    var mw = a.maintain[w];
    h += '<tr><td class="l"><b>' + esc(mw.account) + '</b></td><td>' + esc(mw.type) + '</td><td>' + esc(mw.via) + '</td><td class="wait-t">' + esc(mw.status) + '</td><td>' + esc(mw.recent) + '</td></tr>';
  }
  h += '</table></div>';
  return h;
}
function chartLine(a) {
  var pts = a.series;
  var h = '<div class="card"><h3>粉丝走势（近7日 · 折线）</h3>';
  if (pts.length < 2) return h + '<div class="flat" style="padding:30px 0;text-align:center">快照不足（每日健康检测后自动出图）</div></div>';
  var W = 460, H = 130, p2 = 34, min = Math.min.apply(null, pts.map(function (x) { return x.v; })) - 2, max = Math.max.apply(null, pts.map(function (x) { return x.v; })) + 2;
  var xs = pts.map(function (x, i2) { return p2 + (W - 2 * p2) * (i2 / (pts.length - 1)); });
  var ys = pts.map(function (x) { return 14 + (H - 46) * (1 - (x.v - min) / (max - min)); });
  h += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">';
  h += '<line x1="' + p2 + '" y1="14" x2="' + p2 + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/><line x1="' + p2 + '" y1="' + (H - 26) + '" x2="' + (W - 14) + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/>';
  h += '<polyline points="' + xs.map(function (x, i3) { return x.toFixed(1) + ',' + ys[i3].toFixed(1); }).join(' ') + '" fill="none" stroke="#3d8fd1" stroke-width="2.5"/>';
  for (var i = 0; i < pts.length; i++) {
    h += '<circle cx="' + xs[i] + '" cy="' + ys[i] + '" r="3.5" fill="#3d8fd1"><title>' + pts[i].d + ' ' + pts[i].v + '粉</title></circle>';
    if (pts[i].d === a.asOf || i === pts.length - 1) h += '<text x="' + xs[i] + '" y="' + (ys[i] - 8) + '" font-size="11" text-anchor="middle" fill="#51606e">' + pts[i].v + '</text>';
    h += '<text x="' + xs[i] + '" y="' + (H - 10) + '" font-size="9.5" text-anchor="middle" fill="#8a97a3">' + pts[i].d.slice(5) + '</text>';
  }
  return h + '</svg></div>';
}
function chartBar(a) {
  var pts = a.series;
  var h = '<div class="card"><h3>粉丝量（近7日 · 柱状）</h3>';
  if (pts.length < 2) return h + '<div class="flat" style="padding:30px 0;text-align:center">快照不足</div></div>';
  var W = 460, H = 130, max = Math.max.apply(null, pts.map(function (x) { return x.v; })) + 3;
  var bw = Math.min(40, (W - 70) / pts.length - 10);
  h += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block"><line x1="30" y1="' + (H - 26) + '" x2="' + (W - 14) + '" y2="' + (H - 26) + '" stroke="#e4eaf0"/>';
  for (var i = 0; i < pts.length; i++) {
    var x = 40 + i * ((W - 70) / pts.length), bh = (H - 46) * (pts[i].v / max);
    var isLast = i === pts.length - 1;
    h += '<rect x="' + x + '" y="' + (H - 26 - bh) + '" width="' + bw + '" height="' + bh + '" fill="' + (isLast ? '#3d8fd1' : '#9ec4e3') + '"><title>' + pts[i].d + ' ' + pts[i].v + '粉</title></rect>';
    h += '<text x="' + (x + bw / 2) + '" y="' + (H - 31 - bh) + '" font-size="10" text-anchor="middle" fill="#51606e">' + pts[i].v + '</text>';
    h += '<text x="' + (x + bw / 2) + '" y="' + (H - 10) + '" font-size="9.5" text-anchor="middle" fill="#8a97a3">' + pts[i].d.slice(5) + '</text>';
  }
  return h + '</svg></div>';
}
// 建议量格式化（2026-10-16）：首个"（"前=主值段，数值加粗提色（sugv）；括号内出处说明保持浅灰
function sugFmt(s) {
  if (!s) return '';
  var parts = String(s).split('（');
  var head = parts.shift();
  var rest = parts.length ? '<span class="sug-rest">（' + esc(parts.join('（')) + '</span>' : '';
  var headFmt = esc(head).replace(/([≤≥]?\d+(?:\.\d+)?(?:\s*[-~]\s*\d+(?:\.\d+)?)?(?:\s*\/\s*[天窗帖次份条人赞轮hH])?)/g, '<b class="sugv">$1</b>'); // 注意：本段在页面模板字符串内，正则转义必须双反斜杠（单杠会被模板吃掉→下发语法错误→整页白屏，10-16 已踩坑）
  return '<span class="sug-head">' + headFmt + '</span>' + rest;
}
function quotaBlock(a) {  if (!a.isRun || !a.quotas || !a.quotas.length) return ''; // 额度条只属于运行号；接入未授权号不展示额度
  var h = '<div class="card"><h3>今日额度 · ' + esc(DATA.days[DATA.days.length - 1]) + '<span style="font-weight:400;font-size:11px;color:#98a5b1">（单向任务 · 完成总量/规划当天总量）</span></h3><div class="qrow">';
  for (var i = 0; i < a.quotas.length; i++) {
    var q = a.quotas[i];
    var pct = 0;
    if (q.planned > 0) pct = Math.min(100, Math.round((q.done / q.planned) * 100));
    else if (q.planned === 0 && q.done > 0) pct = 100;
    var noBar = q.planned == null; // 未设定：不画进度条
    h += '<div class="qchip' + (q.planned === 0 ? ' qchip-off' : '') + '" title="' + esc(q.note) + '">'
      + '<div class="qtop"><span class="qlabel">' + esc(q.label) + '</span><span class="qnum">' + q.done + '<span class="qsep">/</span>' + esc(q.plannedText) + '<span class="qunit">' + esc(q.unit) + '</span></span></div>'
      + '<div class="qbar' + (noBar ? ' qbar-none' : '') + '">' + (noBar ? '<span class="qnone">待拍板</span>' : '<i style="width:' + pct + '%"></i><span class="qpct">' + (q.planned === 0 ? '停' : pct + '%') + '</span>') + '</div>'
      + '</div>';
  }
  return h + '</div><div class="foot-note">完成量 = 当日真实动作审计（演练/模拟不计）；规划量 = 你拍板的当日总量，未拍板的如实显示未设定/引擎帽。</div></div>';
}
function renderTask(a) {
  var wd = ['日', '一', '二', '三', '四', '五', '六'];
  var ST = { on: ['●运行', 'ok-t'], paused: ['●暂停', 'wait-t'], off: ['●停用', 'flat'], pending: ['●待接入', 'flat'], 'wait-feed': ['●未投递', 'wait-t'], 'ready-feed': ['●待发布', 'ok-t'] };
  var h = '';
  if (!a.isRun) {
    h += '<div class="card" style="border-left:4px solid #c8a23c"><b>' + esc(a.role) + '</b>'
      + '<div class="t-desc" style="margin-top:4px">' + esc(a.roleNote || '该账号仅接入注册表，未授权执行任务。') + ' 下方任务表全灰=该号不运行任何任务；历史数据（若有）只读展示。</div></div>';
  }
  h += quotaBlock(a) + '<div class="tbl-wrap"><table class="tasktable"><colgroup><col style="width:58px"><col style="width:286px"><col style="width:66px"><col style="width:158px"><col style="width:132px">'
    + DATA.days.map(function () { return '<col style="width:104px">'; }).join('') + '</colgroup>'
    + '<tr><th>时间</th><th>任务 / 说明</th><th>状态</th><th>设定量<span style="font-weight:400;font-size:10px;color:#98a5b1">（当次执行量·你拍板）</span></th><th>建议量<span style="font-weight:400;font-size:10px;color:#98a5b1">（每日总量·X算法/XActions 档位）</span></th>';
  for (var i = 0; i < DATA.days.length; i++) {
    var dd = new Date(DATA.days[i] + 'T00:00:00');
    h += '<th' + (i === DATA.days.length - 1 ? ' class="today"' : '') + '>' + DATA.days[i].slice(5) + '<br><span style="font-size:10px;color:#8a97a3;font-weight:400">周' + wd[dd.getDay()] + '</span></th>';
  }
  h += '</tr>';
  var rows = DATA.taskRows;
  for (var r2 = 0; r2 < rows.length; r2++) {
    var row = rows[r2];
    var st = ST[row.status] || ['●', 'flat'];
    if (!a.isRun) st = ['●未授权', 'flat']; // 接入号：任何任务都不在此号上运行
    h += '<tr class="' + (row.status === 'on' && a.isRun ? 'row-on' : 'row-off') + '"><td class="ttime">' + esc(row.t) + '</td>'
      + '<td class="l"><span class="cat-tag">' + esc(row.cat) + '</span> <span class="t-name">' + esc(row.name) + '</span><div class="t-desc" title="' + esc(row.desc) + '">' + esc(row.desc) + '</div></td>'
      + '<td class="' + st[1] + '" style="font-size:11px;font-weight:600">' + st[0] + '</td>'
      + '<td class="tgt"><span class="set">' + (() => {
        // 发布行例外（10-18 wcixot 接入）：有内容源发布预算的账号（run 号或 budgetByAccount 号）显示自己的拍板值，其余照旧"—"
        const pm = /^post:(\w+)$/.exec(row.id); // 注意：模板字符串内正则转义必须双反斜杠（10-16 已立规矩，10-18 又踩一次）
        if (pm && DATA.postsBudget && DATA.postsBudget[CUR]) { const pb = DATA.postsBudget[CUR]; const ax = (pb.windowAllocation || {})[pm[1]]; const fx = (x) => (x != null && typeof x === 'object' ? x.min + '~' + x.max : String(x ?? 0)); return fx(ax) + ' 帖（你拍板区间·1~10min定时）'; }
        return a.isRun ? esc(row.set) : '—';
      })() + '</span></td>'
      + '<td class="tgt"><span class="sug">' + sugFmt(row.sug) + '</span></td>';
    for (var c = 0; c < DATA.days.length; c++) {
      var d = DATA.days[c];
      var cell = null;
      if (row.id === 'report') { cell = DATA.reports[d] ? { count: 1, times: ['22:05'], items: ['日报文件已生成'] } : null; }
      else if (row.id === 'health') { var e = a.health[d]; if (e) cell = { count: 1, times: [], items: ['判定 ' + e.verdict + (e.profile && e.profile.followers != null ? ' · ' + e.profile.followers + '粉' : '')] }; }
      else {
        var g = a.grid[d] && a.grid[d][row.id];
        if (g) cell = g;
        else if (/^community:/.test(row.id) && a.grid[d] && a.grid[d].roundDry) cell = { count: 0, times: [], items: ['演练轮已完整运行（扫描/生成/入队全真），未点击发送'], dry: true };
      }
      if (!cell) { h += '<td class="dimc">·</td>'; continue; }
      var frac = row.setNum ? '<span class="frac">/' + row.setNum + esc(row.unit) + '</span>' : '';
      var times = (cell.times || []).slice(0, 3).join('/');
      var tip = (cell.items || []).slice(0, 10).join('\n') || (row.name + ' ' + cell.count);
      h += '<td class="fillc" title="' + esc(tip).replace(/\n/g, '&#10;') + '"><span class="cell-n">' + (row.id === 'health' || row.id === 'radar' ? '✓' : (cell.dry ? '演练' : cell.count + frac)) + '</span>'
        + (times ? '<span class="cell-t">' + times + '</span>' : '') + (cell.unknown ? '<span class="unk">不明' + cell.unknown + '</span>' : '') + '</td>';
    }
    h += '</tr>';
  }
  h += '</table></div><p class="foot-note">时间线排序；设定量=<b>当次执行量</b>（你拍板的每窗/每次值）；建议量=<b>每日总量角度</b>（源自 XActions 风险分档与 X 算法/执法源码结论）；回复类（串门+互关+被动）共用同一"每日回复总量"分档；日期格=完成量/设定量+时间。</p>';
  return h;
}
function load() {
  fetch('/api/data').then(function (r) { return r.json(); }).then(function (j) {
    DATA = j;
    // CUR 默认=总览（侧栏第一个入口）
    document.getElementById('conn-warn') && (document.getElementById('conn-warn').style.display = 'none');
    render();
  }).catch(function (e) { // 10-18 修复：断流不再静默保持旧渲染（曾是最危险的误判源）
    var w = document.getElementById('conn-warn');
    if (w) { w.style.display = 'block'; w.textContent = '⚠ 数据获取失败——页面显示的是 ' + (DATA ? '上次成功获取的数据' : '空') + '，将自动重试'; }
  });
}
load();
setInterval(load, 60000);
