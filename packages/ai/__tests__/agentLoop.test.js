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
