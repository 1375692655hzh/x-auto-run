// llm.js — LLM 通道适配（P2）：读 llm.json，OpenAI 兼容协议，主备回退链
// 用法（模块）:
//   const { chat, generateReply } = require('./llm');
//   await chat({ messages: [...] });                              // 按回退链尝试
//   await generateReply({ post, author, persona, brief, history }); // 串门/互关回复生成
// 约束: kimi 仅接受 temperature=1（llm.json 内覆写）；60s 超时；失败抛最后一个错误。
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'llm.json'), 'utf8'));

function providerChain() {
  const order = [CFG.active, ...(CFG.fallbacks || [])].filter(Boolean);
  return order.map((n) => [n, CFG.providers[n]]).filter(([, p]) => p && p.baseUrl && p.apiKey);
}

async function callProvider(name, p, { messages, temperature = 0.9, maxTokens = 512, timeoutMs = 60000 }) {
  const temp = Number.isFinite(p.temperature) ? p.temperature : temperature; // provider 级覆写（kimi=1）
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.apiKey },
      body: JSON.stringify({ model: p.model, messages, temperature: temp, max_tokens: maxTokens }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${name} http ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error(`${name} 空回复`);
    return { text: String(text).trim(), provider: name, model: p.model };
  } finally { clearTimeout(tm); }
}

/** 按主备链调用；全部失败抛错（错误信息聚合各家原因）；opts.provider 可锁定单通道（10-20 拍板：fullwin 常驻走 mimo） */
async function chat(opts = {}) {
  let chain = providerChain();
  if (opts.provider) { const pinned = chain.filter(([n]) => n === opts.provider); const fb = opts.fallbackProvider ? chain.filter(([n]) => n === opts.fallbackProvider) : []; chain = [...pinned, ...fb]; } // 首选通道+指定兜底（10-20：fullwin=mimo→ali）
  if (!chain.length) throw new Error(opts.provider ? `llm.json 无 ${opts.provider} 通道或未配 key` : 'llm.json 无可用通道');
  const errs = [];
  for (const [name, p] of chain) {
    try { return await callProvider(name, p, opts); }
    catch (e) { errs.push(e.message); if (opts.noFallback) break; }
  }
  throw new Error('LLM 全通道失败: ' + errs.join(' | '));
}

/**
 * 生成一条针对原帖的回复文案（不负责质量门——调用方须过 quality.check）。
 * - post: 原帖正文（必填）
 * - author: 对方 handle（可空）
 * - persona: 我方人设一句话（必填，决定口吻）
 * - brief: 本次任务补充要求（如"正向留言，引导互相串门"）
 * - history: 我方近期已发回复列表（防重复，取末尾 5 条）
 */
async function generateReply({ post, author, persona, brief, history = [], channel, maxLen, fallbackProvider }) {
  if (!post || !persona) throw new Error('generateReply 需要 post 与 persona');
  const system = [
    `你是 X(Twitter) 账号的运营者本人，用第一人称回复别人的帖子。`,
    `人设：${persona}`,
    brief ? `本次任务要求：${brief}` : '',
    '',
    '硬规则：',
    maxLen ? `- 中文，总字数不超过 ${maxLen}，越短越好，口语自然，符合人设口吻` : '- 1 到 2 句，中文，总字数不超过 120，口语自然，符合人设口吻', // maxLen 可覆写（10-20 拍板：fullwin 光速回复=≤20 字）
    '- 必须回应原帖的具体内容或观点（呼应其中细节，不空泛）',
    '- 可以自然表达希望互相来往/互相关注的意思，但不得声称还没发生的动作（如未关注就说"已关注"）',
    '- 禁止：链接、话题标签(#)、@提及任何账号、AI 身份声明、通用套话（如"说得真好""支持""学习了"）',
    '- 只输出回复正文，不带任何前缀、引号或解释',
  ].filter(Boolean).join('\n');
  const user = [
    author ? `原帖作者：@${author}` : '原帖作者：某人',
    `原帖内容："""${String(post).slice(0, 600)}"""`,
    history.length ? '\n我近期已发过的回复（不要复用它们的开场和结构）：' : '',
    ...history.slice(-5).map((h) => `- ${h}`),
    '',
    '写出回复：',
  ].filter(Boolean).join('\n');
  return chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.9, maxTokens: 256, provider: channel, fallbackProvider });
}

module.exports = { chat, generateReply };
