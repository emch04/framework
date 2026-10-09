'use strict';
const { estimateTokens } = require('./budget');
function contextBoundary(messages, options = {}) {
  const keepLast = options.keepLast ?? 8;
  if (!Number.isInteger(keepLast) || keepLast < 0) throw new Error('keepLast must be a non-negative integer.');
  for (const key of ['maxChars', 'maxTokens']) if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key] < 0)) throw new Error(`${key} must be non-negative.`);
  const text = JSON.stringify(messages);
  if (!(options.maxChars !== undefined && text.length > options.maxChars) && !(options.maxTokens !== undefined && estimateTokens(text) > options.maxTokens)) return 0;
  let end = Math.max(0, messages.length - keepLast);
  // Keep complete tool exchanges together at the retained boundary.
  while (end > 0 && messages[end]?.role === 'tool') end -= 1;
  return end;
}
async function summarizeContext(messages, plan, options, summarize) {
  const end = contextBoundary(messages, options);
  if (!end) return false;
  const summary = await summarize({ messages: messages.slice(0, end), plan });
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('Summary must be non-empty text.');
  messages.splice(0, end, { role: 'system', text: `Context summary:\n${summary}` });
  return true;
}
module.exports = { contextBoundary, summarizeContext };
