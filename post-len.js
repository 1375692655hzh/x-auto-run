// post-len.js — 帖文超限修复（10-21 事故根因修复）
// 事故：6 条云帖加权字数 296~463 全部超 X 280 上限（CJK 算 2），compose 发布按钮被禁用、
// 发不出去且无 note。修复策略（用户拍板"按推荐执行"）：LLM 重压缩为主 → 加权截断兜底，两步全自动。
const { chat } = require('./llm');
const { weightedLen } = require('./quality');

const MAX_W = 270; // 280 上限留 10 余量（防标签/计数口径差异）
// 与 quality.js CJK_RE 同口径，保证计数一致
const WIDE_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\u3000-\u303F\uFF01-\uFF60]/;

/** 加权截断：按字符累计到 maxW，在句边界（。！？!?.；）收口，补省略号 */
function truncateWeighted(text, maxW = MAX_W) {
  const t = String(text || '').trim();
  if (weightedLen(t) <= maxW) return t;
  let n = 0, cut = 0;
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const w = WIDE_RE.test(chars[i]) ? 2 : 1;
    if (n + w > maxW - 2) { cut = i; break; } // 留 2 给省略号
    n += w;
  }
  let out = chars.slice(0, cut).join('').trim();
  const m = out.match(/^[\s\S]*[。！？!?.；]/); // 最后一个句边界内收口（避免半个句子+省略号）
  if (m && weightedLen(m[0]) > 20) out = m[0];
  return out.replace(/[\s,，、;；]+$/, '') + '…';
}

/**
 * 保证帖文 ≤ maxW 加权：不超直接回；超则先 LLM 重压缩（保留要点），失败/仍超则加权截断兜底。
 * 返回 { text, via: 'ok'|'llm'|'trunc', before, after }
 */
async function ensurePostLen(text, { maxW = MAX_W, channel, fallbackProvider } = {}) {
  const before = weightedLen(String(text || ''));
  if (before <= maxW) return { text: String(text || '').trim(), via: 'ok', before, after: before };
  let out = null, via = 'trunc';
  try {
    const r = await chat({
      messages: [
        { role: 'system', content: `你把长帖压缩成能发在 X 上的短版。X 计数规则：中文/全角字符算 2、英文数字算 1，总加权不超过 ${maxW}。要求：保留原文最核心的 1~3 个事实点与数字；保持原语言与口吻；不用标签、不用 @、不带链接；只输出压缩后的正文，不带任何前缀或解释。` },
        { role: 'user', content: `压缩到加权 ${maxW} 以内：\n"""${String(text).slice(0, 1200)}"""` },
      ],
      temperature: 0.3, maxTokens: 384, provider: channel, fallbackProvider,
    });
    const t = String((r && r.text) || '').trim();
    if (t && weightedLen(t) <= maxW) { out = t; via = 'llm'; }
  } catch { /* LLM 挂了走截断兜底，交付不许断 */ }
  if (!out) out = truncateWeighted(text, maxW);
  return { text: out, via, before, after: weightedLen(out) };
}

module.exports = { ensurePostLen, truncateWeighted, MAX_W };
