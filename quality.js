// quality.js — 中文回复质量门（P2）：XActions 管线的中文重写版
// 审计实测的三个缺陷在此修复：①纯中文具体评论被误判 generic ②中文 hashtag 不被清除
// ③两次不合格仍放行。本版语义：**不合格一律拒发**（调用方跳过该条，绝不放行）。
// 用法（模块）:
//   const q = require('./quality');
//   const r = q.check(text, { history: [...近7天已发文案] });
//   r.ok === true 才可发送；发送用 r.cleaned（已去 hashtag/链接/白空）
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\u3000-\u303F\uFF01-\uFF60]/;

// 通用开场黑名单：以这些开头=无信息量套话（只匹配开头，不误杀句中引用）
const GENERIC_OPENERS = [
  // 中文
  '顶', '沙发', '前排', '支持', '赞', '好文', '好帖', '写得真好', '说得太好', '说得好', '讲得好',
  '学习了', '学到了', '受教了', '收藏了', 'mark', '蹲一个', '蹲后续', '有意思', '不错', '很好',
  '厉害', '牛', '牛逼', '大佬', '强', '绝了', '爱了', '加油', '冲', '同感', '认同', '同意',
  // 英文（继承 XActions 思路）
  'great post', 'great point', 'great thread', 'great take', 'love this', 'this is so true', 'so true',
  'well said', "couldn't agree more", 'could not agree more', 'thanks for sharing', 'thank you for sharing',
  'interesting take', 'interesting perspective', 'as an ai', 'as a language model',
];

/** X 的 280 加权计数：CJK/全角算 2，其余算 1 */
function weightedLen(s) {
  let n = 0;
  for (const ch of s) n += CJK_RE.test(ch) ? 2 : 1;
  return n;
}

/** 清洗：去 URL、话题标签（含全角＃）、首尾空白与多余空行；返回 {cleaned, removed} */
function clean(text) {
  const before = text || '';
  let t = before
    .replace(/```[a-z]*\n?/gi, '').replace(/```\s*$/g, '')   // 代码围栏
    .replace(/^\s*(回复|reply|comment)\s*[:：]\s*/i, '')       // "回复：" 前缀标签
    .replace(/https?:\/\/\S+/g, '')                            // 链接
    .replace(/[＃#][^\s＃#，。！？、]+/g, '')                    // 话题标签（中文标签直到标点/空白）
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 整体被引号包裹时去掉
  const m = t.match(/^["“”'‘’](.+)["“”'‘’]$/s);
  if (m) t = m[1].trim();
  return { cleaned: t, removed: before.length - t.length };
}

/** CJK 二元组 Jaccard 相似度（防模板化重复） */
function similarity(a, b) {
  const grams = (s) => {
    const t = (s || '').replace(/\s+/g, '');
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * 质量门。返回 { ok, reason?, weightedLen, cleaned }。
 * 规则（任一不过即 ok=false，调用方跳过该条，不放行不重试）：
 *   1) 非空且清洗后仍非空
 *   2) 加权长度 8..280（太短=无信息量，太长超限）
 *   3) 不以通用套话开场（中英）
 *   4) emoji ≤2
 *   5) 与近 7 天已发文案的相似度 < 0.55
 */
function check(text, { history = [], maxLen = 280, minLen = 8, simThreshold = 0.55 } = {}) {
  const { cleaned } = clean(text);
  if (!text || !text.trim()) return { ok: false, reason: '空文案', weightedLen: 0, cleaned };
  if (!cleaned) return { ok: false, reason: '清洗后为空（只剩链接/标签？）', weightedLen: 0, cleaned };
  const len = weightedLen(cleaned);
  if (len > maxLen) return { ok: false, reason: `超长(${len}>${maxLen})`, weightedLen: len, cleaned };
  if (len < minLen) return { ok: false, reason: `过短(${len}<${minLen})，无信息量`, weightedLen: len, cleaned };
  const lower = cleaned.toLowerCase().replace(/^[^a-z\u4e00-\u9fff]+/i, '');
  const hit = GENERIC_OPENERS.find((o) => lower.startsWith(o.toLowerCase()));
  if (hit) return { ok: false, reason: `通用套话开场："${hit}"`, weightedLen: len, cleaned };
  if (!/[。！？…～）)”"”』」]|\p{Extended_Pictographic}$/u.test(cleaned)) {
    return { ok: false, reason: '疑似截断（结尾无标点）', weightedLen: len, cleaned };
  }
  const emojis = (cleaned.match(EMOJI_RE) || []).length;
  if (emojis > 2) return { ok: false, reason: `emoji过多(${emojis})`, weightedLen: len, cleaned };
  for (const h of history) {
    const s = similarity(cleaned, h);
    if (s >= simThreshold) return { ok: false, reason: `与已发文案相似(${s.toFixed(2)})`, weightedLen: len, cleaned };
  }
  return { ok: true, weightedLen: len, cleaned };
}

module.exports = { check, clean, weightedLen, similarity, GENERIC_OPENERS };
