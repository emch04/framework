'use strict';

/**
 * Connecteur MCP (26/10/2026) : une IA d'Astratra se branche sur un serveur MCP distant (transport « Streamable HTTP »)
 * et en reçoit les outils comme ses outils natifs ({ name, description, parameters, kind, run }), prêts pour
 * runToolLoop / createToolCaller. Tout serveur MCP (GitHub, documentation…) se branche de la même façon.
 *
 * Règles :
 *   - ce que rend un serveur MCP est une DONNÉE NON FIABLE : chaque outil est marqué `external: true`, pour que les gardes
 *     de l'application (prompt-injection) le traitent comme tel ;
 *   - un outil est « read » par défaut ; l'application déclare elle-même ceux qui écrivent (`kinds`), avec leur risque ;
 *   - `allow` limite les outils exposés à une liste connue : un serveur qui ajoute un outil ne le donne pas à l'IA en douce ;
 *   - la clé (en-tête Authorization) n'est jamais journalisée ni rendue.
 */

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_RESULT_MAX = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Un nom d'outil MCP ramené aux noms d'Astratra (minuscules, chiffres, « _ », 64 caractères au plus). */
function toolNameOf(prefix, name) {
  const brut = `${prefix || ''}${String(name)}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+/, '');
  const nom = /^[a-z]/.test(brut) ? brut : `mcp_${brut}`;
  return nom.slice(0, 64);
}

/** Le texte d'un résultat MCP : les parties texte jointes ; un JSON valide est rendu comme objet. */
function resultValue(result, max) {
  const texte = (Array.isArray(result?.content) ? result.content : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .slice(0, max);
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try { return JSON.parse(texte); } catch { return texte; }
}

async function chargerSdk() {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return { Client, StreamableHTTPClientTransport };
}

/**
 * Se connecte à un serveur MCP et rend ses outils au format des outils natifs.
 *
 * @param {object} options
 * @param {string} options.url                 adresse du serveur MCP (https://…/mcp)
 * @param {Record<string,string>} [options.headers] en-têtes envoyés à chaque requête (par exemple Authorization: Bearer …)
 * @param {string} [options.prefix]            préfixe des noms d'outils (par exemple « salon_ »)
 * @param {string[]} [options.allow]           noms MCP des seuls outils à exposer
 * @param {Record<string,{kind?:string,risk?:string}|string>} [options.kinds] genre et risque par nom MCP (défaut read)
 * @param {number} [options.timeoutMs]         délai d'un appel d'outil (défaut 20 s)
 * @param {number} [options.resultMax]         taille maximale du texte rendu (défaut 20 000)
 * @param {{name:string,version:string}} [options.client] identité du client annoncée au serveur
 * @param {object} [options.transport]         transport MCP déjà construit (tests) ; sinon Streamable HTTP
 * @param {Function} [options.fetch]           fetch utilisé par le transport
 * @returns {Promise<{ tools: object[], instructions: string|null, close(): Promise<void> }>}
 */
async function connectMcpServer(options = {}) {
  const { url, headers = {}, prefix = '', allow = null, kinds = {}, timeoutMs = DEFAULT_TIMEOUT_MS, resultMax = DEFAULT_RESULT_MAX } = options;
  if (!options.transport && !url) throw new Error('connectMcpServer: url is required');
  const { Client, StreamableHTTPClientTransport } = await chargerSdk();
  const transport = options.transport || new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  const client = new Client(options.client || { name: 'astratra-ai', version: '1.0.0' });
  await client.connect(transport);

  const decrits = [];
  let curseur;
  do {
    const page = await client.listTools(curseur ? { cursor: curseur } : {});
    decrits.push(...(page.tools || []));
    curseur = page.nextCursor;
  } while (curseur);

  const permis = allow ? new Set(allow) : null;
  const tools = decrits
    .filter((t) => !permis || permis.has(t.name))
    .map((t) => {
      const name = toolNameOf(prefix, t.name);
      if (!NAME.test(name)) return null;
      const reglage = typeof kinds[t.name] === 'string' ? { kind: kinds[t.name] } : (kinds[t.name] || {});
      const parameters = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      return {
        name,
        description: String(t.description || t.title || t.name).slice(0, 2000),
        parameters,
        kind: reglage.kind || 'read',
        ...(reglage.risk ? { risk: reglage.risk } : {}),
        external: true,
        mcp: { name: t.name },
        summary: () => ({}),
        async run(args, ctx = {}) {
          const result = await client.callTool({ name: t.name, arguments: args || {} }, undefined, {
            timeout: timeoutMs,
            ...(ctx.signal ? { signal: ctx.signal } : {})
          });
          const data = resultValue(result, resultMax);
          if (result && result.isError) return { data: { erreur: true, detail: data } };
          return { data };
        }
      };
    })
    .filter(Boolean);

  const instructions = typeof client.getInstructions === 'function' ? (client.getInstructions() || null) : null;
  return {
    tools,
    instructions,
    async close() { await client.close().catch(() => {}); }
  };
}

module.exports = { connectMcpServer, mcpToolName: toolNameOf };
