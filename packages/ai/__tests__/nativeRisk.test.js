const { validateNativeTools, createToolCaller, toolRiskOf, waitsForToolConfirmation, runToolLoop, createSourceLedger } = require('../src');
const tool = (risk = 'LOW') => ({ name: 'add_note', description: 'Add note', parameters: { type: 'object' }, kind: 'confirm', risk, run: jest.fn(async () => ({ data: 'prepared', card: {} })), perform: jest.fn(async () => ({ data: 'done', undo: { id: '1' } })), undo: jest.fn() });

test('strict risk validation is opt-in; unsafe writes and low confirmations without undo fail', () => {
  const t = tool(); expect(validateNativeTools([t], { requireRisk: true })).toEqual([t]);
  delete t.risk; expect(validateNativeTools([t])).toEqual([t]);
  expect(() => validateNativeTools([t], { requireRisk: true })).toThrow('risk');
  expect(() => validateNativeTools([{ ...tool('HIGH'), kind: 'write' }], { requireRisk: true })).toThrow('LOW');
  expect(() => validateNativeTools([{ ...tool(), undo: undefined }], { requireRisk: true })).toThrow('undo');
});

test.each(['MEDIUM', 'HIGH', 'UNKNOWN'])('%s confirmation waits; run prepares but perform never executes', async (risk) => {
  const t = tool(risk === 'UNKNOWN' ? undefined : risk); if (risk === 'UNKNOWN') delete t.risk;
  expect(toolRiskOf(t)).toBe(risk); expect(waitsForToolConfirmation(t)).toBe(true);
  const record = jest.fn(); const call = createToolCaller({ tools: [t], confirmationPolicy: { threshold: 'MEDIUM' }, record });
  const result = await call({ id: '1', name: t.name, args: {} });
  expect(t.run).toHaveBeenCalledTimes(1); expect(t.perform).not.toHaveBeenCalled();
  expect(result.result.status).toContain('confirm'); expect(record.mock.calls[0][0].tool.kind).toBe('confirm');
});

test('LOW auto-performs only when explicitly enabled, keeps undo and records effective write', async () => {
  const t = tool(); const record = jest.fn();
  const call = createToolCaller({ tools: [t], confirmationPolicy: { threshold: 'MEDIUM' }, record });
  expect((await call({ id: '1', name: t.name, args: {} })).result).toBe('done');
  expect(t.perform).toHaveBeenCalledTimes(1); expect(record.mock.calls[0][0]).toMatchObject({ tool: { kind: 'write' }, found: { undo: { id: '1' } } });
  const old = tool(); await createToolCaller({ tools: [old] })({ id: '2', name: old.name, args: {} });
  expect(old.perform).not.toHaveBeenCalled();
});

test('after reading untrusted sources even LOW waits; sources/evidence remain collected', async () => {
  const ledger = createSourceLedger(); const exposure = { untrusted: false };
  const read = { ...tool(), name: 'read_page', kind: 'read', run: async () => ({ data: 'read text', sources: [{ url: 'https://example.test', title: 'Source' }] }) };
  const write = tool();
  const call = createToolCaller({ tools: [read, write], confirmationPolicy: { threshold: 'MEDIUM' }, exposure, readsUntrusted: (t) => t.name === 'read_page', keep: ledger.keep });
  await call({ id: '1', name: read.name, args: {} }); await call({ id: '2', name: write.name, args: {} });
  expect(exposure.untrusted).toBe(true); expect(write.perform).not.toHaveBeenCalled(); expect(ledger.sources()).toHaveLength(1); expect(ledger.evidence()[0]).toContain('read text');
});

test('preparation can request confirmation and auto-perform never happens after tool timeout', async () => {
  const t = tool(); t.run = async () => ({ confirm: true, data: 'untrusted' });
  const result = await createToolCaller({ tools: [t], confirmationPolicy: 'never' })({ id: '1', name: t.name, args: {} });
  expect(result.result.status).toContain('confirm'); expect(t.perform).not.toHaveBeenCalled();
  let resolve; const slow = tool(); slow.run = () => new Promise((done) => { resolve = done; });
  await createToolCaller({ tools: [slow], confirmationPolicy: 'never', timeoutMs: 5 })({ id: '2', name: slow.name, args: {} });
  resolve({ data: 'late' }); await new Promise((done) => setTimeout(done, 1));
  expect(slow.perform).not.toHaveBeenCalled();
});

test('turn and total-time boundaries finish without tools, and per-tool deadline returns a model-readable error', async () => {
  let time = 0; const seen = [];
  const call = createToolCaller({ tools: [{ ...tool(), name: 'read_slow', kind: 'read', run: async () => new Promise(() => {}) }], timeoutMs: 5 });
  const turn = async ({ tools }) => { seen.push(tools); return tools.length ? { text: null, toolCalls: [{ id: '1', name: 'read_slow', args: {} }] } : { text: 'final', toolCalls: [] }; };
  const messages = [];
  expect(await runToolLoop({ system: 's', messages, tools: [{}], turn, callTool: async (c) => { const result = await call(c); time = 100; return result; }, maxTurns: 6, maxMs: 50, now: () => time })).toEqual({ text: 'final', turns: 2 });
  expect(seen[1]).toEqual([]); expect(messages[1].result.error).toContain('too long');
});

test('Tertius existing exposure object and default write result remain unchanged', async () => {
  const exposure = { untrusted: true };
  const write = { ...tool(), kind: 'write', run: jest.fn(async (_args, ctx) => { expect(ctx.exposure).toBe(exposure); return { confirm: true, data: { status: 'waiting' } }; }) };
  const result = await createToolCaller({ tools: [write], context: { exposure } })({ id: '1', name: write.name, args: {} });
  expect(result.result).toEqual({ status: 'waiting' }); expect(write.perform).not.toHaveBeenCalled();
});
