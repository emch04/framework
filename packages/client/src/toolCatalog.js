/**
 * Every destination a dashboard can offer, declared once.
 *
 * A dashboard that hard-codes its tiles serves exactly one role. Declared as
 * DATA — id, path, roles — it serves as many as the product has, and adding a
 * screen is adding a line rather than editing a component.
 *
 * ACCESS IS DECLARED PER TOOL, AND REFUSED BY DEFAULT. A tool lists the roles
 * that may reach it; anything else — including a missing role, which is what a
 * half-restored session looks like — is refused. The alternative, listing who
 * is forbidden, silently admits every role added later.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It decides what a screen OFFERS, and the
 * server decides what it grants. Keeping a forbidden tile out of sight spares
 * someone a screen that would only error at them; it stops nobody determined.
 */

/** Read-only outside: a catalogue that callers can splice is not a catalogue. */
function freeze(tools) {
  return Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
}

/**
 * @param {Array<{id: string, path: string, roles: string[], titleKey?: string,
 *   subtitleKey?: string, kind?: string, endpoint?: string}>} tools
 *   Order matters: it is the order the dashboard renders.
 */
function createToolCatalog(tools = []) {
  const list = Array.isArray(tools) ? tools : [];
  const seen = new Set();

  for (const tool of list) {
    if (!tool || typeof tool.id !== 'string' || !tool.id) {
      throw new Error('createToolCatalog: every tool needs an id.');
    }
    if (typeof tool.path !== 'string' || !tool.path) {
      throw new Error(`createToolCatalog: tool "${tool.id}" needs a path.`);
    }
    if (!Array.isArray(tool.roles)) {
      throw new Error(`createToolCatalog: tool "${tool.id}" needs a roles array.`);
    }
    if (seen.has(tool.id)) {
      throw new Error(`createToolCatalog: duplicate tool id "${tool.id}" — the second is unreachable.`);
    }
    seen.add(tool.id);
  }

  const all = freeze(list);
  const paths = new Set(all.map((tool) => tool.path));

  function canAccess(tool, role) {
    if (!tool || !role) return false;
    return tool.roles.includes(role);
  }

  return {
    all,

    byId(id) {
      return all.find((tool) => tool.id === id);
    },

    canAccess,

    /** What this role may see, in the catalogue's own order. */
    forRole(role) {
      return role ? all.filter((tool) => canAccess(tool, role)) : [];
    },

    /** A path the catalogue never declared is not a tool. */
    hasPath(path) {
      return paths.has(path);
    },

    /**
     * A tool with no endpoint cannot be opened on its own: it needs something
     * chosen first — a customer, a period, a document. Saying so here lets the
     * dashboard route to the picker instead of to an empty screen.
     */
    needsContext(tool) {
      return Boolean(tool) && !tool.endpoint;
    }
  };
}

module.exports = { createToolCatalog };
