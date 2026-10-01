'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDoclingClient, ExtractionError, extractTables, tableToMarkdown } = require('../src');

async function startFake(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('latin1') };
      requests.push(entry);
      handler(entry, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const TABLE = {
  prov: [{ page_no: 2 }],
  data: {
    num_rows: 3,
    num_cols: 3,
    table_cells: [
      { text: 'Matière', start_row_offset_idx: 0, end_row_offset_idx: 1, start_col_offset_idx: 0, end_col_offset_idx: 1, column_header: true },
      { text: 'Notes', start_row_offset_idx: 0, end_row_offset_idx: 1, start_col_offset_idx: 1, end_col_offset_idx: 3, column_header: true },
      { text: 'Maths', start_row_offset_idx: 1, end_row_offset_idx: 2, start_col_offset_idx: 0, end_col_offset_idx: 1 },
      { text: '14', start_row_offset_idx: 1, end_row_offset_idx: 2, start_col_offset_idx: 1, end_col_offset_idx: 2 },
      { text: '16', start_row_offset_idx: 1, end_row_offset_idx: 2, start_col_offset_idx: 2, end_col_offset_idx: 3 },
      { text: 'Français | oral', start_row_offset_idx: 2, end_row_offset_idx: 3, start_col_offset_idx: 0, end_col_offset_idx: 1 },
      { text: '12', start_row_offset_idx: 2, end_row_offset_idx: 3, start_col_offset_idx: 1, end_col_offset_idx: 2 }
    ]
  }
};
const OK = { status: 'success', processing_time: 1.234, errors: [], document: { md_content: '# Bulletin\n', json_content: { tables: [TABLE] }, text_content: 'Bulletin' } };

let server;
afterEach(async () => { if (server) await server.close(); server = null; });
const pdf = Buffer.from('%PDF-1.4 faux');

describe('tableaux', () => {
  test('grille avec cellule fusionnée, page et en-tête', () => {
    const [grid] = extractTables({ tables: [TABLE] });
    expect(grid).toEqual({
      rows: [['Matière', 'Notes', 'Notes'], ['Maths', '14', '16'], ['Français | oral', '12', '']],
      numRows: 3, numCols: 3, headerRows: 1, page: 2
    });
    expect(tableToMarkdown(grid)).toBe('| Matière | Notes | Notes |\n| --- | --- | --- |\n| Maths | 14 | 16 |\n| Français \\| oral | 12 |  |');
  });
  test('document sans tableau ou tableau vide', () => {
    expect(extractTables({})).toEqual([]);
    expect(extractTables({ tables: [{}] })[0].rows).toEqual([]);
    expect(tableToMarkdown({ rows: [], headerRows: 0 })).toBe('');
  });
});

describe('conversion synchrone', () => {
  test('envoie le fichier en multipart avec formats et options, clé API, et structure la réponse', async () => {
    server = await startFake((req, res) => json(res, 200, OK));
    const client = createDoclingClient({ baseUrl: server.url, apiKey: 'cle-test' });
    const out = await client.convert({ file: pdf, filename: 'bulletin.pdf', options: { ocr: true, ocrLang: ['fr', 'en'], tableMode: 'accurate' } });
    const req = server.requests[0];
    expect(req.url).toBe('/v1/convert/file');
    expect(req.headers['x-api-key']).toBe('cle-test');
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(req.raw).toContain('name="files"; filename="bulletin.pdf"');
    expect(req.raw).toContain('%PDF-1.4 faux');
    expect(req.raw.match(/name="to_formats"/g)).toHaveLength(2);
    expect(req.raw).toContain('name="do_ocr"');
    expect(req.raw.match(/name="ocr_lang"/g)).toHaveLength(2);
    expect(req.raw).toContain('name="table_mode"');
    expect(out).toMatchObject({ status: 'success', processingTimeMs: 1234, markdown: '# Bulletin\n', text: null });
    expect(out.json.tables).toHaveLength(1);
    expect(out.tables[0].rows[1]).toEqual(['Maths', '14', '16']);
  });

  test('lit un fichier par son chemin', async () => {
    server = await startFake((req, res) => json(res, 200, OK));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'extr-')), 'scan.png');
    fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
    await createDoclingClient({ baseUrl: server.url }).convert({ file });
    expect(server.requests[0].raw).toContain('filename="scan.png"');
    expect(server.requests[0].raw).toContain('Content-Type: image/png');
  });

  test('refuse avant tout envoi : type inconnu, fichier vide, trop gros, formats invalides', async () => {
    server = await startFake((req, res) => json(res, 200, OK));
    const client = createDoclingClient({ baseUrl: server.url, maxFileBytes: 10 });
    await expect(client.convert({ file: pdf, filename: 'x.exe' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(client.convert({ file: Buffer.alloc(0), filename: 'x.pdf' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(client.convert({ file: pdf, filename: 'x.pdf' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(createDoclingClient({ baseUrl: server.url }).convert({ file: pdf, filename: 'x.pdf', formats: ['zip'] })).rejects.toThrow('INVALID_FORMATS');
    await expect(client.convert({ file: pdf })).rejects.toThrow('FILENAME_REQUIRED');
    expect(server.requests).toHaveLength(0);
  });

  test('erreurs du service : clé refusée, HTTP, conversion en échec, réponse invalide', async () => {
    let mode = 'auth';
    server = await startFake((req, res) => {
      if (mode === 'auth') return json(res, 401, {});
      if (mode === 'http') return json(res, 422, { detail: 'format invalide' });
      if (mode === 'fail') return json(res, 200, { status: 'failure', errors: [{ error_message: 'PDF chiffré' }] });
      if (mode === 'html') { res.writeHead(200); return res.end('<html>'); }
      return json(res, 200, { status: 'success' });
    });
    const client = createDoclingClient({ baseUrl: server.url });
    const run = () => client.convert({ file: pdf, filename: 'a.pdf' });
    await expect(run()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    mode = 'http';
    await expect(run()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 422, message: 'format invalide' });
    mode = 'fail';
    await expect(run()).rejects.toMatchObject({ code: 'CONVERSION_FAILED', details: [{ error_message: 'PDF chiffré' }] });
    mode = 'html';
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    mode = 'empty';
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  test('injoignable et délai dépassé', async () => {
    const down = createDoclingClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(down.convert({ file: pdf, filename: 'a.pdf' })).rejects.toMatchObject({ code: 'UNREACHABLE' });
    server = await startFake(() => {});
    const slow = createDoclingClient({ baseUrl: server.url, timeoutMs: 100 });
    const error = await slow.convert({ file: pdf, filename: 'a.pdf' }).catch((e) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect(error.code).toBe('TIMEOUT');
  });
});

describe('conversion asynchrone', () => {
  test('soumet, sonde jusqu’au succès, puis récupère le résultat', async () => {
    let polls = 0;
    server = await startFake((req, res) => {
      if (req.url === '/v1/convert/file/async') return json(res, 200, { task_id: 't 1', task_status: 'pending' });
      if (req.url.startsWith('/v1/status/poll/')) return json(res, 200, { task_status: ++polls < 3 ? 'started' : 'success' });
      if (req.url === '/v1/result/t%201') return json(res, 200, OK);
      return json(res, 404, {});
    });
    const client = createDoclingClient({ baseUrl: server.url, sleep: async () => {}, pollIntervalMs: 1 });
    const out = await client.convert({ file: pdf, filename: 'gros.pdf', async: true });
    expect(polls).toBe(3);
    expect(out.markdown).toBe('# Bulletin\n');
    expect(server.requests.map((r) => r.url)).toEqual(['/v1/convert/file/async', '/v1/status/poll/t%201', '/v1/status/poll/t%201', '/v1/status/poll/t%201', '/v1/result/t%201']);
  });

  test('tâche en échec, et délai dépassé avec l’identifiant de tâche', async () => {
    let state = 'failure';
    server = await startFake((req, res) => {
      if (req.url === '/v1/convert/file/async') return json(res, 200, { task_id: 'abc' });
      return json(res, 200, { task_status: state });
    });
    const client = createDoclingClient({ baseUrl: server.url, sleep: async () => {}, pollIntervalMs: 10, timeoutMs: 5 });
    await expect(client.convert({ file: pdf, filename: 'a.pdf', async: true })).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
    state = 'started';
    await expect(client.convert({ file: pdf, filename: 'a.pdf', async: true })).rejects.toMatchObject({ code: 'TIMEOUT', details: { taskId: 'abc' } });
  });
});

describe('santé', () => {
  test('ok, clé refusée, éteint', async () => {
    let status = 200;
    server = await startFake((req, res) => json(res, status, {}));
    const client = createDoclingClient({ baseUrl: server.url });
    expect(await client.health()).toEqual({ ok: true, status: 'ok' });
    status = 401;
    expect(await client.health()).toEqual({ ok: false, status: 'unauthorized' });
    status = 500;
    expect((await client.health()).status).toBe('error');
    expect(await createDoclingClient({ baseUrl: 'http://127.0.0.1:1' }).health()).toEqual({ ok: false, status: 'unreachable' });
  });
  test('base invalide refusée', () => {
    expect(() => createDoclingClient({ baseUrl: 'nimporte' })).toThrow('INVALID_BASE_URL');
  });
});
