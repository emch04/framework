const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { connectMcpServer, mcpToolName, validateNativeTools, createToolCaller } = require('../src');

/* Un petit serveur MCP de test, à la manière de Palabre : lire, écrire, et un outil en trop. */
function serveur() {
  const s = new McpServer({ name: 'salle-de-test', version: '1.0.0' }, { instructions: 'Parle librement.' });
  const recus = [];
  s.registerTool('lire_reunion', { description: 'Lit la réunion.', inputSchema: { apres: z.number().int().optional() } },
    async ({ apres }) => ({ content: [{ type: 'text', text: JSON.stringify({ messages: [{ id: 1, texte: 'Bonjour' }], curseur: apres ?? 1 }) }] }));
  s.registerTool('ecrire_message', { description: 'Écrit un message.', inputSchema: { texte: z.string() } },
    async ({ texte }) => { recus.push(texte); return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }; });
  s.registerTool('outil-en-trop', { description: 'Ne doit pas être exposé.' }, async () => ({ content: [{ type: 'text', text: 'non' }] }));
  s.registerTool('echoue', { description: 'Échoue.' }, async () => ({ isError: true, content: [{ type: 'text', text: '{"erreur":"reunion_fermee"}' }] }));
  return { s, recus };
}

async function enMemoire(options = {}) {
  const { s, recus } = serveur();
  const [cote, coteServeur] = InMemoryTransport.createLinkedPair();
  await s.connect(coteServeur);
  const connexion = await connectMcpServer({ transport: cote, ...options });
  return { connexion, recus };
}

describe('mcpClient', () => {
  test('les outils du serveur deviennent des outils natifs valides, préfixés, externes, read par défaut', async () => {
    const { connexion } = await enMemoire({ prefix: 'palabre_', kinds: { ecrire_message: { kind: 'write', risk: 'LOW' } } });
    const noms = connexion.tools.map((t) => t.name).sort();
    expect(noms).toEqual(['palabre_echoue', 'palabre_ecrire_message', 'palabre_lire_reunion', 'palabre_outil_en_trop']);
    const lire = connexion.tools.find((t) => t.name === 'palabre_lire_reunion');
    expect(lire.kind).toBe('read');
    expect(lire.external).toBe(true);
    expect(lire.parameters.type).toBe('object');
    expect(lire.parameters.properties.apres).toBeTruthy();
    expect(connexion.tools.find((t) => t.name === 'palabre_ecrire_message')).toMatchObject({ kind: 'write', risk: 'LOW' });
    expect(connexion.instructions).toBe('Parle librement.');
    const lecture = connexion.tools.filter((t) => t.kind === 'read');
    expect(() => validateNativeTools(lecture)).not.toThrow();
    await connexion.close();
  });

  test('allow limite les outils exposés ; run appelle le serveur et rend le JSON', async () => {
    const { connexion, recus } = await enMemoire({ allow: ['lire_reunion', 'ecrire_message', 'echoue'] });
    expect(connexion.tools.map((t) => t.name).sort()).toEqual(['echoue', 'ecrire_message', 'lire_reunion']);
    const lire = connexion.tools.find((t) => t.name === 'lire_reunion');
    expect(await lire.run({ apres: 4 }, {})).toEqual({ data: { messages: [{ id: 1, texte: 'Bonjour' }], curseur: 4 } });
    await connexion.tools.find((t) => t.name === 'ecrire_message').run({ texte: 'Salut Oracle' }, {});
    expect(recus).toEqual(['Salut Oracle']);
    expect(await connexion.tools.find((t) => t.name === 'echoue').run({}, {})).toEqual({ data: { erreur: true, detail: { erreur: 'reunion_fermee' } } });
    await connexion.close();
  });

  test('les outils MCP passent par createToolCaller comme les autres', async () => {
    const { connexion } = await enMemoire({ allow: ['lire_reunion'] });
    const appeler = createToolCaller({ tools: connexion.tools });
    expect(typeof appeler).toBe('function');
    await connexion.close();
  });

  test('par Streamable HTTP, avec la clé dans l’en-tête', async () => {
    const entetes = [];
    const http1 = http.createServer(async (req, res) => {
      entetes.push(req.headers.authorization);
      if (req.headers.authorization !== 'Bearer plb_test') { res.statusCode = 404; return res.end(); }
      const { s } = serveur();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); s.close(); });
      await s.connect(transport);
      let corps = '';
      for await (const morceau of req) corps += morceau;
      await transport.handleRequest(req, res, corps ? JSON.parse(corps) : undefined);
    });
    await new Promise((ok) => http1.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${http1.address().port}/mcp`;
    try {
      const connexion = await connectMcpServer({ url, headers: { Authorization: 'Bearer plb_test' }, allow: ['lire_reunion'] });
      expect(connexion.tools.map((t) => t.name)).toEqual(['lire_reunion']);
      expect((await connexion.tools[0].run({}, {})).data.messages[0].texte).toBe('Bonjour');
      await connexion.close();
      expect(entetes.every((e) => e === 'Bearer plb_test')).toBe(true);
      await expect(connectMcpServer({ url, headers: { Authorization: 'Bearer mauvaise' } })).rejects.toBeTruthy();
    } finally {
      await new Promise((ok) => http1.close(ok));
    }
  });

  test('les noms MCP sont ramenés aux noms d’Astratra', () => {
    expect(mcpToolName('palabre_', 'Lire-Réunion')).toBe('palabre_lire_r_union');
    expect(mcpToolName('', '9outil')).toBe('mcp_9outil');
    expect(mcpToolName('', 'x'.repeat(80)).length).toBe(64);
  });
});
