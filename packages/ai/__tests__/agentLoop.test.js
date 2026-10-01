const { createToolRegistry, runAgentLoop } = require('../src');

describe('agentLoop', () => {
  test('returns a direct final answer when the model does not request a tool', async () => {
    const registry = createToolRegistry();
    const router = {
      ask: jest.fn(async () => 'plain answer')
    };

    await expect(runAgentLoop({
      prompt: 'question',
      ctx: { requestId: 'req-1' },
      registry,
      router,
      userRole: 'member'
    })).resolves.toBe('plain answer');
  });

  test('executes one allowed tool call and loops to the final answer', async () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'lookup_case',
      description: 'Lookup a case',
      type: 'read',
      roles: ['analyst'],
      params: { id: 'string' },
      handler: async (params, ctx) => ({ id: params.id, tenant: ctx.tenant })
    });
    const router = {
      ask: jest.fn()
        .mockResolvedValueOnce('<tool_call name="lookup_case">{"id":"A-1"}</tool_call>')
        .mockResolvedValueOnce('final answer')
    };

    await expect(runAgentLoop({
      prompt: 'lookup',
      ctx: { tenant: 'demo' },
      history: [],
      registry,
      router,
      userRole: 'analyst'
    })).resolves.toBe('final answer');

    expect(router.ask.mock.calls[1][0]).toContain('<tool_result name="lookup_case">{"id":"A-1","tenant":"demo"}</tool_result>');
  });

  test('rejects a tool call when the role is not allowed', async () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'delete_case',
      description: 'Delete a case',
      type: 'write',
      roles: ['admin'],
      params: { id: 'string' },
      handler: async () => ({ ok: true })
    });
    const router = {
      ask: jest.fn(async () => '<tool_call name="delete_case">{"id":"A-1"}</tool_call>')
    };

    await expect(runAgentLoop({
      prompt: 'delete',
      ctx: {},
      registry,
      router,
      userRole: 'analyst'
    })).rejects.toThrow('not allowed');
  });

  test('stops when tool calls exceed maxSteps', async () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'lookup_case',
      description: 'Lookup a case',
      type: 'read',
      roles: ['analyst'],
      params: {},
      handler: async () => ({ ok: true })
    });
    const router = {
      ask: jest.fn(async () => '<tool_call name="lookup_case">{}</tool_call>')
    };

    await expect(runAgentLoop({
      prompt: 'loop',
      ctx: {},
      registry,
      router,
      userRole: 'analyst',
      maxSteps: 2
    })).rejects.toThrow('maxSteps');
  });

  test('onChunk streams each piece of an async-iterable response as it arrives', async () => {
    const registry = createToolRegistry();
    async function* stream() {
      yield 'plain ';
      yield 'answer';
    }
    const router = { ask: jest.fn(async () => stream()) };
    const chunks = [];

    const result = await runAgentLoop({
      prompt: 'question',
      ctx: {},
      registry,
      router,
      userRole: 'member',
      onChunk: (chunk) => chunks.push(chunk)
    });

    expect(result).toBe('plain answer');
    expect(chunks).toEqual(['plain ', 'answer']);
  });

  test('onChunk is also called for a plain (non-streamed) response', async () => {
    const registry = createToolRegistry();
    const router = { ask: jest.fn(async () => 'plain answer') };
    const chunks = [];

    await runAgentLoop({
      prompt: 'question',
      ctx: {},
      registry,
      router,
      userRole: 'member',
      onChunk: (chunk) => chunks.push(chunk)
    });

    expect(chunks).toEqual(['plain answer']);
  });

  test('confirmTool gates execution: approved calls run normally', async () => {
    const registry = createToolRegistry();
    const handler = jest.fn(async () => ({ ok: true }));
    registry.register({
      name: 'delete_case',
      description: 'Delete a case',
      type: 'write',
      roles: ['admin'],
      params: { id: 'string' },
      handler
    });
    const router = {
      ask: jest.fn()
        .mockResolvedValueOnce('<tool_call name="delete_case">{"id":"A-1"}</tool_call>')
        .mockResolvedValueOnce('done')
    };
    const confirmTool = jest.fn(async () => true);

    const result = await runAgentLoop({
      prompt: 'delete it',
      ctx: {},
      registry,
      router,
      userRole: 'admin',
      confirmTool
    });

    expect(result).toBe('done');
    expect(handler).toHaveBeenCalledWith({ id: 'A-1' }, {});
    expect(confirmTool).toHaveBeenCalledWith({ name: 'delete_case', params: { id: 'A-1' } }, {});
  });

  test('confirmTool gates execution: denied calls never run the handler, loop continues', async () => {
    const registry = createToolRegistry();
    const handler = jest.fn(async () => ({ ok: true }));
    registry.register({
      name: 'delete_case',
      description: 'Delete a case',
      type: 'write',
      roles: ['admin'],
      params: { id: 'string' },
      handler
    });
    const router = {
      ask: jest.fn()
        .mockResolvedValueOnce('<tool_call name="delete_case">{"id":"A-1"}</tool_call>')
        .mockResolvedValueOnce('understood, not deleting')
    };
    const confirmTool = jest.fn(async () => false);

    const result = await runAgentLoop({
      prompt: 'delete it',
      ctx: {},
      registry,
      router,
      userRole: 'admin',
      confirmTool
    });

    expect(result).toBe('understood, not deleting');
    expect(handler).not.toHaveBeenCalled();
    expect(router.ask.mock.calls[1][0]).toContain('"denied":true');
  });

  test('warns on repeated identical calls and stops at the configured limit', async () => {
    const registry = createToolRegistry();
    const handler = jest.fn(async () => ({ ok: true }));
    registry.register({ name: 'lookup', description: 'Lookup', type: 'read', roles: ['member'], handler });
    const router = { ask: jest.fn(async () => '<tool_call name="lookup">{"b":2,"a":1}</tool_call>') };
    const events = [];
    const reason = await runAgentLoop({ prompt: 'q', registry, router, userRole: 'member', loopGuard: { reminder: 2, firmReminder: 3, stop: 4 }, onEvent: event => events.push(event) });
    expect(reason).toMatch(/arrêtée/);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(events.map(event => event.repetitions)).toEqual([2, 3, 4]);
    expect(events[2].type).toBe('tool_loop_stopped');
  });

  test('treats reordered object arguments as the same tool call', async () => {
    const registry = createToolRegistry();
    registry.register({ name: 'lookup', description: 'Lookup', type: 'read', roles: ['member'], handler: async () => ({}) });
    let calls = 0;
    const router = { ask: async () => (++calls === 1 ? '<tool_call name="lookup">{"a":1,"b":2}</tool_call>' : calls === 2 ? '<tool_call name="lookup">{"b":2,"a":1}</tool_call>' : 'done') };
    await runAgentLoop({ prompt: 'q', registry, router, userRole: 'member', loopGuard: { reminder: 2, firmReminder: 4, stop: 6 } });
  });

  test('spills oversized results, rereads a slice, and hides data when storage fails', async () => {
    const registry = createToolRegistry();
    registry.register({ name: 'read', description: 'Read', type: 'read', roles: ['member'], handler: async () => 'x'.repeat(100) });
    const memory = new Map();
    const store = { set: async (id, value) => memory.set(id, value), get: async id => memory.get(id) };
    const prompts = [];
    const router = { ask: async prompt => {
      prompts.push(prompt);
      if (prompts.length === 1) return '<tool_call name="read">{}</tool_call>';
      if (prompts.length === 2) {
        const id = JSON.parse(prompt.match(/<tool_result name="read">(.*?)<\/tool_result>/)[1]).id;
        return `<tool_call name="read_spilled_result">${JSON.stringify({ id, start: 10, length: 5 })}</tool_call>`;
      }
      if (prompts.length === 3) return 'done';
    } };
    await expect(runAgentLoop({ prompt: 'q', registry, router, userRole: 'member', spill: { threshold: 20, store } })).resolves.toBe('done');
    expect(prompts[1]).toContain('"spilled":true');
    expect(prompts[2]).toContain('"text":"xxxxx"');

    const failing = { set: async () => { throw new Error('disk secret'); }, get: async () => null };
    const failRouter = { ask: jest.fn().mockResolvedValueOnce('<tool_call name="read">{}</tool_call>').mockResolvedValueOnce('safe') };
    await runAgentLoop({ prompt: 'q', registry, router: failRouter, userRole: 'member', spill: { threshold: 20, store: failing } });
    expect(failRouter.ask.mock.calls[1][0]).toContain('result_storage_failed');
    expect(failRouter.ask.mock.calls[1][0]).not.toContain('xxxxxxxx');
  });

  test('combines risk analyzers and confirms unknown tools under a threshold policy', async () => {
    const registry = createToolRegistry();
    const handler = jest.fn(async () => ({ ok: true }));
    registry.register({ name: 'act', description: 'Act', type: 'write', risk: 'LOW', roles: ['member'], handler });
    const proposals = [];
    const router = { ask: jest.fn().mockResolvedValueOnce('<tool_call name="act">{}</tool_call>').mockResolvedValueOnce('pending') };
    await runAgentLoop({ prompt: 'q', registry, router, userRole: 'member', confirmationPolicy: { threshold: 'HIGH' }, riskAnalyzers: [async () => 'MEDIUM', async () => 'HIGH'], pendingActions: { propose: async input => { proposals.push(input); return { action: { id: 'p1' } }; } } });
    expect(handler).not.toHaveBeenCalled();
    expect(proposals[0].action).toBe('act');
  });

  test('requires confirmation for an undeclared UNKNOWN risk and honors always/never policies', async () => {
    const registry = createToolRegistry();
    const handler = jest.fn(async () => ({ ok: true }));
    registry.register({ name: 'act', description: 'Act', type: 'write', roles: ['member'], handler });
    const pending = { propose: async () => ({ action: { id: 'unknown-1' } }) };
    const run = async confirmationPolicy => {
      const router = { ask: jest.fn().mockResolvedValueOnce('<tool_call name="act">{}</tool_call>').mockResolvedValueOnce('done') };
      return runAgentLoop({ prompt: 'q', registry, router, userRole: 'member', confirmationPolicy, pendingActions: pending });
    };
    await run({ threshold: 'HIGH' });
    expect(handler).not.toHaveBeenCalled();
    await run('never');
    expect(handler).toHaveBeenCalledTimes(1);
    handler.mockClear();
    await run('always');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('agent loop: failing tools, time budget, last turn', () => {
  const { createToolRegistry: makeRegistry, runAgentLoop: loop } = require('../src');

  function registryWith(handler) {
    const registry = makeRegistry();
    registry.register({ name: 'lookup', description: 'Lookup', type: 'read', roles: ['owner'], handler });
    return registry;
  }

  test('with reportToolErrors, a tool that throws becomes a code the model reads — never its message', async () => {
    const prompts = [];
    const router = { ask: async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? '<tool_call name="lookup">{}</tool_call>' : 'Je n\'ai pas pu vérifier.'; } };
    const registry = registryWith(async () => { throw new Error('ECONNREFUSED 10.0.0.3:27017 internal'); });
    await expect(loop({ prompt: 'q', registry, router, userRole: 'owner', reportToolErrors: true })).resolves.toBe('Je n\'ai pas pu vérifier.');
    expect(prompts[1]).toContain('"error":"tool_failed"');
    expect(prompts[1]).not.toContain('10.0.0.3');
  });

  test('without it, a failing tool still throws as before', async () => {
    const router = { ask: async () => '<tool_call name="lookup">{}</tool_call>' };
    await expect(loop({ prompt: 'q', registry: registryWith(async () => { throw new Error('boom'); }), router, userRole: 'owner' })).rejects.toThrow('boom');
  });

  test('a tool slower than toolTimeoutMs is reported as a timeout', async () => {
    const prompts = [];
    const router = { ask: async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? '<tool_call name="lookup">{}</tool_call>' : 'fin'; } };
    const registry = registryWith(() => new Promise((resolve) => setTimeout(() => resolve('late'), 200)));
    await loop({ prompt: 'q', registry, router, userRole: 'owner', reportToolErrors: true, toolTimeoutMs: 20 });
    expect(prompts[1]).toContain('"error":"tool_timeout"');
  });

  test('out of steps with a finalInstruction: one last turn without tools answers', async () => {
    const prompts = [];
    const router = { ask: async (prompt) => { prompts.push(prompt); return prompts.length <= 2 ? '<tool_call name="lookup">{}</tool_call>' : 'Voici ce que j\'ai lu.'; } };
    const answer = await loop({ prompt: 'q', registry: registryWith(async () => ({ ok: 1 })), router, userRole: 'owner', maxSteps: 2, finalInstruction: 'Answer now, no more tools.' });
    expect(answer).toBe('Voici ce que j\'ai lu.');
    expect(prompts[2]).toContain('Answer now, no more tools.');
    expect(prompts[2]).toContain('Available tools:\n(none)');
  });

  test('a stray tool call in the last turn is removed rather than shown', async () => {
    let n = 0;
    const router = { ask: async () => { n += 1; return n === 1 ? '<tool_call name="lookup">{}</tool_call>' : 'Réponse <tool_call name="lookup">{}</tool_call>'; } };
    const answer = await loop({ prompt: 'q', registry: registryWith(async () => ({})), router, userRole: 'owner', maxSteps: 1, finalInstruction: 'Answer now.' });
    expect(answer).toBe('Réponse');
  });

  test('the time budget stops the loop before maxSteps', async () => {
    let time = 0;
    let asked = 0;
    const router = { ask: async () => { asked += 1; time += 40_000; return '<tool_call name="lookup">{}</tool_call>'; } };
    await expect(loop({ prompt: 'q', registry: registryWith(async () => ({})), router, userRole: 'owner', maxSteps: 10, maxMs: 60_000, now: () => time })).rejects.toThrow(/maxSteps/);
    expect(asked).toBe(2);
  });
});
