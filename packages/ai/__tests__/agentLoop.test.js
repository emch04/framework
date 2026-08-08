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
});
