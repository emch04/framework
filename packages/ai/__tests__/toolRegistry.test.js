const { createToolRegistry } = require('../src');

describe('toolRegistry', () => {
  test('filters registered tools by role', () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'read_profile',
      description: 'Read a profile',
      type: 'read',
      roles: ['admin', 'member'],
      params: {},
      handler: async () => ({ ok: true })
    });
    registry.register({
      name: 'delete_profile',
      description: 'Delete a profile',
      type: 'write',
      roles: ['admin'],
      params: { id: 'string' },
      handler: async () => ({ ok: true })
    });

    expect(registry.getToolsForRole('member').map(tool => tool.name)).toEqual(['read_profile']);
    expect(registry.getToolsForRole('admin').map(tool => tool.name)).toEqual(['read_profile', 'delete_profile']);
  });

  test('formats tools for prompt with names, descriptions, types, and parameters', () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'lookup_case',
      description: 'Lookup a case',
      type: 'read',
      roles: ['analyst'],
      params: { id: 'string', includeNotes: 'boolean optional' },
      handler: async () => ({ ok: true })
    });
    registry.register({
      name: 'admin_only',
      description: 'Hidden from analysts',
      type: 'write',
      roles: ['admin'],
      params: {},
      handler: async () => ({ ok: true })
    });

    expect(registry.formatToolsForPrompt('analyst')).toBe([
      '### lookup_case [READ]',
      'Lookup a case',
      'Paramètres:',
      '  - id: string',
      '  - includeNotes: boolean optional'
    ].join('\n'));
  });
});
