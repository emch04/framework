'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
// The realm has no require, process, fetch, timers or host functions. JSON is
// parsed inside it: even Object/Function constructors belong to that realm.
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
// Reject imports with a realm-local error. A host Error would expose its host
// Function constructor through a caught rejection. The worker enables VM module
// callbacks so Node does not substitute a host missing-flag error.
const importDenied = vm.runInContext('new Error("Dynamic imports are unavailable.")', context);
const literal = (s) => JSON.stringify(s);
const script = `
'use strict';
const candidate = (${workerData.source});
const evaluation = (() => {
// Capture the realm's primitives before invoking the candidate.
const objectFreeze = Object.freeze, values = Object.values, keys = Object.keys, hasOwn = Object.hasOwn;
const parse = JSON.parse, stringify = JSON.stringify;
const promiseResolve = Promise.resolve.bind(Promise);
const promiseThen = Function.prototype.call.bind(Promise.prototype.then);
const input = parse(${literal(workerData.input)});
const config = parse(${literal(workerData.config)});
let intentions = 0; const journal = [];
const freeze = (value) => { if (value && typeof value === 'object') { objectFreeze(value); for (const v of values(value)) freeze(v); } return value; };
freeze(input); freeze(config);
const canonical = (v) => v === null || typeof v !== 'object' ? stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + keys(v).sort().map(k => stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const tools = Object.create(null);
for (const [name, tool] of Object.entries(config)) tools[name] = async (args = null) => {
  journal.push({ sequence: journal.length + 1, tool: name, kind: tool.kind, input: parse(stringify(args)), simulated: true });
  if (tool.kind === 'write') { intentions++; return { simulated: true, intention: true }; }
  const recorded = tool.recordings?.find(r => canonical(r.input) === canonical(args));
  return recorded ? recorded.output : hasOwn(tool, 'response') ? tool.response : { simulated: true, status: 'unknown' };
};
freeze(tools);
let completed = false, serialized;
promiseThen(promiseResolve(candidate(input, tools)), output => {
  const json = stringify({ output, intentions, journal });
  if (json.length > 1000000) throw new Error('Output limit');
  serialized = json; completed = true;
}, () => { serialized = null; completed = true; });
return objectFreeze({ result: () => completed ? serialized : null });
})();
`;
try {
  vm.runInContext(script, context, { timeout: workerData.timeout, importModuleDynamically: () => { throw importDenied; } });
  const result = vm.runInContext('evaluation.result()', context, { timeout: workerData.timeout });
  if (typeof result !== 'string') parentPort.postMessage({ status: 'unknown', reason: 'execution_failed', intentions: 0 });
  else {
    const parsed = JSON.parse(result);
    parentPort.postMessage({ status: 'completed', ...parsed });
  }
} catch (_error) {
  parentPort.postMessage({ status: 'unknown', reason: 'execution_failed', intentions: 0 });
}
