'use strict';

/* global AbortController, FormData, Blob */

const fs = require('node:fs/promises');
const path = require('node:path');
const { ExtractionError } = require('./errors');
const { extractTables } = require('./tables');

const MEDIA_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp'
};
const FORMAT_KEYS = { md: 'md_content', json: 'json_content', text: 'text_content', html: 'html_content' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client d'un service docling-serve (Docling, MIT, Python) : on envoie un PDF,
 * un DOCX ou une image, on récupère le texte structuré en Markdown et en JSON,
 * avec les tableaux remis en grilles. Aucune dépendance ; `fetch` injectable.
 */
function createDoclingClient({
  baseUrl = 'http://127.0.0.1:5001',
  apiKey = null,
  timeoutMs = 300_000,
  maxFileBytes = 50 * 1024 * 1024,
  pollIntervalMs = 2_000,
  fetch: fetchImpl = globalThis.fetch,
  sleep = wait
} = {}) {
  let base;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocole');
    base = url.toString().replace(/\/+$/, '');
  } catch {
    throw new TypeError('INVALID_BASE_URL');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('FETCH_REQUIRED');

  async function request(route, { method = 'GET', body, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetchImpl(`${base}${route}`, {
        method,
        body,
        headers: apiKey ? { 'X-Api-Key': apiKey } : {},
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ExtractionError('TIMEOUT', `Pas de réponse en ${timeout} ms`, { cause: error });
      throw new ExtractionError('UNREACHABLE', `Service d'extraction injoignable (${base})`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function failure(response) {
    let detail = null;
    try { detail = await response.json(); } catch { /* corps non JSON */ }
    const message = typeof detail?.detail === 'string' ? detail.detail : `Réponse HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) return new ExtractionError('UNAUTHORIZED', 'Clé API refusée', { status: response.status });
    return new ExtractionError('HTTP_ERROR', message, { status: response.status, details: detail });
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (error) {
      throw new ExtractionError('INVALID_RESPONSE', 'Réponse non JSON', { cause: error });
    }
  }

  function buildForm(bytes, filename, mediaType, { formats, options }) {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: mediaType }), filename);
    for (const format of formats) form.append('to_formats', format);
    const map = { ocr: 'do_ocr', ocrEngine: 'ocr_engine', tableMode: 'table_mode', pdfBackend: 'pdf_backend', includeImages: 'include_images' };
    for (const [key, field] of Object.entries(map)) if (options[key] !== undefined) form.append(field, String(options[key]));
    for (const lang of [].concat(options.ocrLang ?? [])) form.append('ocr_lang', lang);
    return form;
  }

  function shape(payload, formats) {
    if (payload?.status === 'failure') {
      throw new ExtractionError('CONVERSION_FAILED', 'Le service n\'a pas pu convertir le document', { details: payload.errors ?? null });
    }
    const document = payload?.document;
    if (!document || typeof document !== 'object') throw new ExtractionError('INVALID_RESPONSE', 'Réponse sans document');
    const out = {
      status: payload.status ?? 'success',
      processingTimeMs: Number.isFinite(payload.processing_time) ? Math.round(payload.processing_time * 1000) : null,
      warnings: payload.errors ?? [],
      markdown: null,
      json: null,
      text: null,
      html: null,
      tables: []
    };
    for (const [format, key] of Object.entries(FORMAT_KEYS)) {
      if (formats.includes(format) && document[key] !== undefined && document[key] !== null) out[format === 'md' ? 'markdown' : format] = document[key];
    }
    out.tables = extractTables(document.json_content);
    return out;
  }

  /**
   * `file` : Buffer/Uint8Array (avec `filename`) ou chemin de fichier.
   * `formats` : parmi md, json, text, html (défaut md + json : le JSON donne les tableaux).
   * `async: true` passe par la file de tâches du service (gros documents).
   */
  async function convert({ file, filename, formats = ['md', 'json'], options = {}, async: useAsync = false } = {}) {
    let bytes = file;
    let name = filename;
    if (typeof file === 'string') {
      bytes = await fs.readFile(file);
      name = name || path.basename(file);
    }
    if (!(bytes instanceof Uint8Array)) throw new TypeError('FILE_REQUIRED');
    if (!name) throw new TypeError('FILENAME_REQUIRED');
    const mediaType = MEDIA_TYPES[path.extname(name).toLowerCase()];
    if (!mediaType) throw new ExtractionError('UNSUPPORTED_FILE', `Type de fichier non géré : ${path.extname(name) || name}`);
    if (bytes.length === 0) throw new ExtractionError('UNSUPPORTED_FILE', 'Fichier vide');
    if (bytes.length > maxFileBytes) throw new ExtractionError('FILE_TOO_LARGE', `Fichier de ${bytes.length} octets, limite ${maxFileBytes}`);
    const wanted = [...new Set(formats)];
    if (!wanted.length || wanted.some((f) => !FORMAT_KEYS[f])) throw new RangeError('INVALID_FORMATS');
    const form = buildForm(bytes, name, mediaType, { formats: wanted.includes('json') ? wanted : [...wanted, 'json'], options });

    if (!useAsync) {
      const response = await request('/v1/convert/file', { method: 'POST', body: form });
      if (!response.ok) throw await failure(response);
      return shape(await readJson(response), wanted);
    }

    const submitted = await request('/v1/convert/file/async', { method: 'POST', body: form });
    if (!submitted.ok) throw await failure(submitted);
    const { task_id: taskId } = await readJson(submitted);
    if (!taskId) throw new ExtractionError('INVALID_RESPONSE', 'Tâche sans identifiant');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const poll = await request(`/v1/status/poll/${encodeURIComponent(taskId)}`);
      if (!poll.ok) throw await failure(poll);
      const state = (await readJson(poll)).task_status;
      if (state === 'success') break;
      if (state === 'failure') throw new ExtractionError('CONVERSION_FAILED', 'La tâche de conversion a échoué', { details: { taskId } });
      if (Date.now() + pollIntervalMs > deadline) throw new ExtractionError('TIMEOUT', `Conversion pas terminée après ${timeoutMs} ms`, { details: { taskId } });
      await sleep(pollIntervalMs);
    }
    const result = await request(`/v1/result/${encodeURIComponent(taskId)}`);
    if (!result.ok) throw await failure(result);
    return shape(await readJson(result), wanted);
  }

  /** Sonde : ne lance jamais. */
  async function health() {
    try {
      const response = await request('/health', { timeout: 5_000 });
      return { ok: response.ok, status: response.ok ? 'ok' : response.status === 401 ? 'unauthorized' : 'error' };
    } catch (error) {
      return { ok: false, status: error.code === 'TIMEOUT' ? 'timeout' : 'unreachable' };
    }
  }

  return { convert, health };
}

module.exports = { createDoclingClient, MEDIA_TYPES };
