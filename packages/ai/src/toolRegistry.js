function createToolRegistry() {
  const tools = [];

  function register(tool) {
    validateTool(tool);
    tools.push({ ...tool, roles: [...tool.roles], params: tool.params || {} });
    return tool;
  }

  function getToolsForRole(role) {
    return tools.filter(tool => tool.roles.includes(role));
  }

  function getToolByName(name) {
    return tools.find(tool => tool.name === name) || null;
  }

  function formatToolsForPrompt(role) {
    return getToolsForRole(role).map(tool => {
      const params = Object.entries(tool.params || {})
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join('\n') || '  (aucun paramètre)';

      return `### ${tool.name} [${String(tool.type).toUpperCase()}]\n${tool.description}\nParamètres:\n${params}`;
    }).join('\n\n');
  }

  return {
    register,
    getToolsForRole,
    getToolByName,
    formatToolsForPrompt
  };
}

function validateTool(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('tool must be an object');
  if (!tool.name) throw new Error('tool.name is required');
  if (!tool.description) throw new Error('tool.description is required');
  if (!tool.type) throw new Error('tool.type is required');
  if (!Array.isArray(tool.roles)) throw new Error('tool.roles must be an array');
  if (typeof tool.handler !== 'function') throw new Error('tool.handler must be a function');
}

module.exports = {
  createToolRegistry
};
