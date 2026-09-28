const {
  createSpokenConfirmation,
  createCallTools,
  buildInstructions,
  normalizeSpeech,
  toolDeclarations
} = require('../src');
const {
  createToolRegistry
} = require('@astratra/ai');
const phrases = {
  now: () => 0,
  affirmative: {
    en: ['yes', 'go ahead']
  },
  negative: {
    en: ['no', 'wait']
  }
};
test('speech normalization removes punctuation and accents', () => {
  expect(normalizeSpeech(' Oui, déjà! ')).toBe('oui deja');
});
test('confirmation cannot happen before proposal', () => {
  expect(createSpokenConfirmation(phrases).verify('x', 'en')).toBe('ACTION_MISSING');
});
test('confirmation requires readback', () => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.heard({
    who: 'person',
    text: 'yes'
  });
  expect(c.verify('x', 'en')).toBe('READBACK_MISSING');
});
test('confirmation requires answer after readback', () => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.heard({
    who: 'assistant',
    text: 'readback'
  });
  expect(c.verify('x', 'en')).toBe('ANSWER_MISSING');
});
test.each(['yes', 'go ahead', 'YES!'])('confirmation accepts %s', answer => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.heard({
    who: 'assistant',
    text: 'readback'
  });
  c.heard({
    who: 'person',
    text: answer
  });
  expect(c.verify('x', 'en')).toBe('CONFIRMED');
});
test.each(['no', 'yes no', 'wait yes', 'maybe'])('confirmation rejects %s', answer => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.heard({
    who: 'assistant',
    text: 'readback'
  });
  c.heard({
    who: 'person',
    text: answer
  });
  expect(c.verify('x', 'en')).toBe('CONSENT_MISSING');
});
test('confirmation expires', () => {
  let time = 0;
  const c = createSpokenConfirmation({
    ...phrases,
    now: () => time,
    timeoutMs: 5
  });
  c.propose('x');
  time = 6;
  expect(c.verify('x', 'en')).toBe('ACTION_EXPIRED');
});
test('wrong action cannot use approval', () => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.heard({
    who: 'assistant',
    text: 'readback'
  });
  c.heard({
    who: 'person',
    text: 'yes'
  });
  expect(c.verify('y', 'en')).toBe('ACTION_MISSING');
});
test('clear removes pending action', () => {
  const c = createSpokenConfirmation(phrases);
  c.propose('x');
  c.clear('x');
  expect(c.pendingId).toBeNull();
});
function setup() {
  const registry = createToolRegistry();
  registry.register({
    name: 'read',
    description: 'Read',
    type: 'read',
    roles: ['member'],
    params: {
      id: 'identifier'
    },
    handler: async args => ({
      id: args.id
    })
  });
  registry.register({
    name: 'write',
    description: 'Write',
    type: 'write',
    roles: ['member'],
    handler: async () => {
      throw new Error('must queue');
    }
  });
  const confirmation = createSpokenConfirmation(phrases);
  const sent = [];
  const actions = {
    queue: async () => 'a',
    execute: async () => ({
      success: true
    }),
    cancel: async () => {}
  };
  const tools = createCallTools({
    registry,
    context: {
      userId: 'u',
      role: 'member',
      language: 'en'
    },
    confirmation,
    actions,
    clock: {
      setTimeout,
      clearTimeout
    },
    send: message => sent.push(message)
  });
  return {
    registry,
    confirmation,
    sent,
    actions,
    tools
  };
}
test('declarations use registry role', () => {
  const {
    registry
  } = setup();
  expect(toolDeclarations(registry, 'member').map(x => x.name)).toEqual(['read', 'write', 'confirm_action', 'cancel_action']);
  expect(toolDeclarations(registry, 'other')).toEqual([]);
});
test('declarations carry parameter types and required fields', () => {
  const {
    createToolRegistry
  } = require('@astratra/ai');
  const registry = createToolRegistry();
  registry.register({
    name: 'sample',
    description: 'Sample',
    type: 'read',
    roles: ['member'],
    params: {
      count: 'number of items',
      note: 'string optional',
      enabled: 'boolean flag',
      metadata: { type: 'object', required: false }
    },
    handler: async () => null
  });
  const schema = toolDeclarations(registry, 'member')[0].parameters;
  expect(schema.properties.count.type).toBe('number');
  expect(schema.properties.enabled.type).toBe('boolean');
  expect(schema.properties.metadata.type).toBe('object');
  expect(schema.required).toEqual(['count', 'enabled']);
});
test('read handler runs with caller identity', async () => {
  expect(await setup().tools.call({
    name: 'read',
    args: {
      id: 'one'
    }
  })).toEqual({
    id: 'one'
  });
});
test('unknown tool is denied', async () => {
  expect(await setup().tools.call({
    name: 'unknown'
  })).toEqual({
    code: 'TOOL_DENIED'
  });
});
test('write is queued and shown', async () => {
  const s = setup();
  expect(await s.tools.call({
    name: 'write'
  })).toEqual({
    code: 'CONFIRMATION_REQUIRED',
    actionId: 'a'
  });
  expect(s.sent[0].type).toBe('confirm');
});
test('write does not execute before confirmation', async () => {
  const s = setup();
  const run = jest.spyOn(s.actions, 'execute');
  await s.tools.call({
    name: 'write'
  });
  expect(run).not.toHaveBeenCalled();
});
test('spoken approval runs queued write once', async () => {
  const s = setup();
  await s.tools.call({
    name: 'write'
  });
  s.confirmation.heard({
    who: 'assistant',
    text: 'readback'
  });
  s.confirmation.heard({
    who: 'person',
    text: 'yes'
  });
  expect(await s.tools.call({
    name: 'confirm_action',
    args: {
      actionId: 'a'
    }
  })).toEqual({
    code: 'ACTION_DONE'
  });
  expect(s.confirmation.pendingId).toBeNull();
});
test('cancel clears queued write', async () => {
  const s = setup();
  await s.tools.call({
    name: 'write'
  });
  expect(await s.tools.call({
    name: 'cancel_action',
    args: {
      actionId: 'a'
    }
  })).toEqual({
    code: 'ACTION_CANCELLED'
  });
  expect(s.confirmation.pendingId).toBeNull();
});
test('unproposed cancel is denied', async () => {
  expect(await setup().tools.call({
    name: 'cancel_action',
    args: {
      actionId: 'a'
    }
  })).toEqual({
    code: 'ACTION_MISSING'
  });
});
test('client confirmation is explicit without spoken readback', async () => {
  const s = setup();
  await s.tools.call({
    name: 'write'
  });
  expect(await s.tools.confirmByClient('a')).toEqual({
    code: 'ACTION_DONE'
  });
  expect(s.sent.at(-1).type).toBe('action_done');
});
test('client confirmation rejects a different action', async () => {
  const s = setup();
  await s.tools.call({
    name: 'write'
  });
  expect(await s.tools.confirmByClient('other')).toEqual({
    code: 'ACTION_MISSING'
  });
});
test('client cancellation clears pending action', async () => {
  const s = setup();
  await s.tools.call({
    name: 'write'
  });
  expect(await s.tools.cancelByClient('a')).toEqual({
    code: 'ACTION_CANCELLED'
  });
});
test('shield transforms read arguments and output', async () => {
  const s = setup();
  const tools = createCallTools({
    registry: s.registry,
    context: {
      role: 'member'
    },
    confirmation: s.confirmation,
    actions: s.actions,
    clock: {
      setTimeout,
      clearTimeout
    },
    shield: {
      input: () => ({
        id: 'masked'
      }),
      output: () => ({
        safe: true
      })
    }
  });
  expect(await tools.call({
    name: 'read',
    args: {
      id: 'clear'
    }
  })).toEqual({
    safe: true
  });
});
test('async argument unmasking and result masking use distinct hooks', async () => {
  const s = setup();
  const tools = createCallTools({
    registry: s.registry,
    context: {
      role: 'member'
    },
    confirmation: s.confirmation,
    actions: s.actions,
    clock: {
      setTimeout,
      clearTimeout
    },
    shield: {
      args: async () => ({
        id: 'clear'
      }),
      result: async () => ({
        id: '[MASK]'
      })
    }
  });
  expect(await tools.call({
    name: 'read',
    args: {
      id: '[MASK]'
    }
  })).toEqual({
    id: '[MASK]'
  });
});
test('read result can be handed to transcript annotation hook', async () => {
  const s = setup();
  const onResult = jest.fn();
  const tools = createCallTools({
    registry: s.registry,
    context: {
      role: 'member'
    },
    confirmation: s.confirmation,
    actions: s.actions,
    clock: {
      setTimeout,
      clearTimeout
    },
    onResult
  });
  await tools.call({
    name: 'read',
    args: {
      id: 'ref'
    }
  });
  expect(onResult).toHaveBeenCalledWith('read', {
    id: 'ref'
  });
});
test('external tools receive outbound shield without unmasking', async () => {
  const s = setup();
  const seen = [];
  s.registry.register({
    name: 'outside',
    description: 'Outside',
    type: 'read',
    external: true,
    roles: ['member'],
    handler: async args => {
      seen.push(args);
      return {
        ok: true
      };
    }
  });
  const tools = createCallTools({
    registry: s.registry,
    context: {
      role: 'member'
    },
    confirmation: s.confirmation,
    actions: s.actions,
    clock: {
      setTimeout,
      clearTimeout
    },
    shield: {
      input: () => ({
        name: 'clear'
      }),
      external: async () => ({
        name: 'masked'
      })
    }
  });
  await tools.call({
    name: 'outside',
    args: {
      name: 'token'
    }
  });
  expect(seen).toEqual([{
    name: 'masked'
  }]);
});
test('read failure returns code', async () => {
  const s = setup();
  s.registry.register({
    name: 'fail',
    description: 'Fail',
    type: 'read',
    roles: ['member'],
    handler: () => {
      throw new Error('secret');
    }
  });
  expect(await s.tools.call({
    name: 'fail'
  })).toEqual({
    code: 'TOOL_FAILED'
  });
});
test('large result is bounded', async () => {
  const s = setup();
  const tools = createCallTools({
    registry: s.registry,
    context: {
      role: 'member'
    },
    confirmation: s.confirmation,
    clock: {
      setTimeout,
      clearTimeout
    },
    maxResultChars: 2
  });
  expect((await tools.call({
    name: 'read',
    args: {
      id: 'long'
    }
  })).code).toBe('RESULT_TRUNCATED');
});
test('instructions compose injected material', () => {
  expect(buildInstructions({
    persona: 'Guide',
    language: 'en',
    role: 'member',
    catalog: {
      language: {
        en: 'English'
      },
      role: {
        member: 'Member'
      },
      voice: 'Short'
    },
    now: () => 'today'
  })).toBe('Guide\nEnglish\nMember\nShort\ntoday');
});
test('instructions apply shield', () => {
  expect(buildInstructions({
    persona: 'private',
    shield: {
      input: () => 'safe'
    }
  })).toBe('safe');
});
