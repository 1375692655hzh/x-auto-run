// interaction.js — 互动真人化模块（10-21 批2）：招呼模板库 + 身份标签 + bio 缓存
// 设计来源：三方调研合并（Kimi 槽位组合+严去重 / Codex 证据分级 / GLM 成本分层）
// 铁律：模板库内容人工审定入库；同一输出串 24h 内全账号不重复；身份标签只来自明确自述或 bio 原文，不脑补
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, 'state');

// ── 招呼模板库（通用社区短句，非用户个人语料——10-21 用户纠偏"别局限于我的案例"） ──
// 三槽组合：开场 × 身份槽(动态) × 收尾(可空)，组合空间 12×N×10；7 天内同条目最多 2 次
const GREET_OPEN = ['来了来了', '来咯', '这就来', '欢迎欢迎', '又来一位', '来了兄弟', '哈哈来了', '报到', '来了', '来了呀', '这不得来', '收到'];
const GREET_TAIL = ['一起做大做强', '常来聊聊', '多多交流', '互关互关', '一起加油', '常来往', '👬', '🤝', '🚀', ''];
const FALLBACK_LABELS = ['朋友', '老师', '老哥', '兄dei'];

/** 选一条招呼——按近期已发去重（传入 recentSet=近 24h 已发串 Set）；耗尽返回 null（调用方走 LLM 兜底） */
function pickGreet(label, recentSet) {
  const labels = label ? [label, ...FALLBACK_LABELS] : FALLBACK_LABELS;
  const cands = [];
  for (const o of GREET_OPEN) for (const l of labels) for (const t of GREET_TAIL) {
    const s = t ? `${o}，${l}${t ? ' ' + t : ''}`.replace('  ', ' ').trim() : `${o}，${l}`;
    // 长度约束（greet 硬门 12 字素）
    if ([...s].length > 12) continue;
    cands.push(s);
  }
  // 去重后随机
  const pool = cands.filter((s) => !recentSet || !recentSet.has(s));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── 身份标签（证据分级：bio 原文关键词 > 消息内明确自述 > 无） ──
const LABEL_MAP = [
  [/ai|人工智能|机器学习|llm|gpt|claude/i, 'AI 大神'],
  [/游戏|game ?dev|unity|unreal/i, '游戏开发大佬'],
  [/交易|炒股|美股|量化|投资|金融|盘面/i, '交易大佬'],
  [/港[股]打新|ipo/i, '打新老哥'],
  [/写作|小说|作者|记者|编辑/i, '写作老师'],
  [/创业|startup|founder|ceo/i, '创业老哥'],
  [/设计|design|ui|ux/i, '设计大佬'],
  [/币|crypto|btc|eth|web3/i, '币圈老哥'],
];
function labelFromBio(bio) {
  if (!bio) return null;
  for (const [re, label] of LABEL_MAP) if (re.test(bio)) return label;
  return null;
}

// ── bio 缓存（TTL 7 天；未命中由调用方惰性抓，本模块不抓页面——成本分层） ──
function loadBioCache(accountKey) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `bio-cache-${accountKey}.json`), 'utf8')); } catch { return {}; }
}
function saveBioCache(accountKey, cache) { fs.writeFileSync(path.join(STATE_DIR, `bio-cache-${accountKey}.json`), JSON.stringify(cache, null, 2)); }
function cachedLabel(accountKey, handle) {
  const c = loadBioCache(accountKey)[(handle || '').toLowerCase()];
  if (!c || !c.bio || Date.now() - Date.parse(c.fetchedAt) > 7 * 86400000) return null;
  return c.label || null;
}
function storeBio(accountKey, handle, bio) {
  const cache = loadBioCache(accountKey);
  cache[(handle || '').toLowerCase()] = { bio: String(bio).slice(0, 160), label: labelFromBio(bio), fetchedAt: new Date().toISOString() };
  saveBioCache(accountKey, cache);
  return cache[(handle || '').toLowerCase()].label;
}

module.exports = { pickGreet, labelFromBio, cachedLabel, storeBio, GREET_OPEN, GREET_TAIL };
