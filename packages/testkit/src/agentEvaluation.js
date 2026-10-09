'use strict';

function withSignal(work, signal) {
  if (!signal) return Promise.resolve().then(work);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Evaluate an injected runner; tools are deterministic fixtures supplied by each scenario. */
async function evaluateAgent({ scenarios, run, signal } = {}) {
  if (!Array.isArray(scenarios) || typeof run !== 'function') throw new Error('scenarios and run are required.');
  const results = [];
  for (const scenario of scenarios) {
    signal?.throwIfAborted();
    if (!scenario || typeof scenario.id !== 'string' || !scenario.id || typeof scenario.question !== 'string') throw new Error('Each scenario needs an id and a question.');
    const calls = [];
    const tools = (scenario.tools || []).map((tool) => ({ ...tool, async run(args, context) {
      signal?.throwIfAborted();
      calls.push({ name: tool.name, args });
      return tool.run(args, context);
    } }));
    try {
      const output = await withSignal(() => run({ question: scenario.question, tools, signal }), signal);
      signal?.throwIfAborted();
      const text = typeof output === 'string' ? output : output?.text || '';
      const checks = [];
      for (const name of scenario.expect?.tools || []) checks.push({ name: `tool:${name}`, passed: calls.some((call) => call.name === name) });
      for (const content of scenario.expect?.content || []) checks.push({ name: `content:${content}`, passed: typeof content === 'string' ? text.includes(content) : new RegExp(content.source, content.flags.replace(/[gy]/g, '')).test(text) });
      const score = scenario.score ? await withSignal(() => scenario.score({ text, calls, output, checks }), signal) : checks.length ? checks.filter((check) => check.passed).length / checks.length : 1;
      if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Score must be between zero and one.');
      results.push({ id: scenario.id, score, passed: score === 1 && checks.every((check) => check.passed), text, calls, checks });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ id: scenario.id, score: 0, passed: false, text: '', calls, checks: [], error: error.message });
    }
  }
  return { results, score: results.length ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0, passed: results.filter((result) => result.passed).length, total: results.length };
}
module.exports = { evaluateAgent };
