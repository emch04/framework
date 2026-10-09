'use strict';
const { ready, data, invalid, deepFreeze, fingerprintOf } = require('./common');
const states = new WeakMap();
function configurations(tools = {}) {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) invalid('tools must map names to descriptors or real functions to replace.');
  const out = Object.create(null);
  for (const name of Object.keys(tools)) {
    const own = Object.getOwnPropertyDescriptor(tools, name);
    if (!Object.hasOwn(own, 'value')) invalid('Tool getters are forbidden.');
    const tool = own.value;
    if (typeof tool === 'function') { out[name] = { kind: 'write' }; continue; }
    if (!tool || typeof tool !== 'object') invalid('Invalid tool descriptor.');
    const descriptor = Object.getOwnPropertyDescriptors(tool);
    for (const key of ['kind', 'response', 'recordings']) if (descriptor[key] && !Object.hasOwn(descriptor[key], 'value')) invalid('Tool simulation getters are forbidden.');
    const kind = descriptor.kind?.value;
    if (!['read', 'write', 'confirm'].includes(kind)) invalid('Tool kind must be read, write or confirm.');
    const config = { kind: kind === 'read' ? 'read' : 'write' };
    if (config.kind === 'read') {
      if (descriptor.response) config.response = data(descriptor.response.value);
      if (descriptor.recordings) {
        config.recordings = data(descriptor.recordings.value);
        if (!Array.isArray(config.recordings) || !config.recordings.every((r) => r && Object.hasOwn(r, 'input') && Object.hasOwn(r, 'output'))) invalid('recordings must contain input/output pairs.');
        const ids = config.recordings.map((r) => fingerprintOf(r.input));
        if (new Set(ids).size !== ids.length) invalid('Ambiguous recorded tool inputs.');
      }
    }
    out[name] = config;
  }
  return deepFreeze(JSON.parse(JSON.stringify(out)));
}
async function createSandbox(options = {}) {
  await ready(options);
  const binding = { governor: options.governor, organisationId: options.organisationId };
  const config = configurations(options.tools);
  const journal = [];
  const tools = Object.create(null);
  for (const [name, tool] of Object.entries(config)) {
    tools[name] = async (input = null) => {
      await ready(binding);
      const payload = data(input);
      journal.push({ sequence: journal.length + 1, tool: name, kind: tool.kind, input: payload, simulated: true });
      if (tool.kind === 'write') return { simulated: true, intention: true };
      const record = tool.recordings?.find((r) => fingerprintOf(r.input) === fingerprintOf(payload));
      return record ? data(record.output) : Object.hasOwn(tool, 'response') ? data(tool.response) : { simulated: true, status: 'unknown' };
    };
  }
  const sandbox = Object.freeze({ tools: Object.freeze(tools), async getJournal() { await ready(binding); return data(journal); } });
  states.set(sandbox, { ...binding, config });
  return sandbox;
}
async function sandboxState(sandbox, binding) {
  await ready(binding);
  const state = states.get(sandbox);
  if (!state || state.governor !== binding.governor) invalid('Use a sandbox built with this governor.');
  binding.governor.assertSingleOrganisation(binding.organisationId, state.organisationId);
  return state;
}
module.exports = { createSandbox, sandboxState, configurations };
