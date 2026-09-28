#!/usr/bin/env python3
"""
Local CPU model service — small models kept in RAM behind a loopback HTTP API.

Built for a VPS without a GPU: every model runs on the CPU (ONNX int8,
CTranslate2 int8, torch CPU), each one is OPTIONAL, loaded lazily (or preloaded
at start), guarded by its own lock, and can be unloaded after an idle period.
A model that fails to load answers 503 on its own route; the others keep
answering. Nothing is downloaded at run time.

Texts and audio received are NEVER logged: only route, status, sizes, counts
and durations.

Endpoints (JSON in, JSON out):
  GET  /livez       -> {"status": "ok"}                           (never needs the token)
  GET  /health      -> {"status", "version", "models": {name: {configured, loaded, failed, model}}}
  POST /embed       {"texts": [str]}                              -> {"vectors", "model", "dimensions"}
  POST /rerank      {"query": str, "documents": [str]}           -> {"scores", "model"}
  POST /nli         {"pairs": [{"premise", "hypothesis"}]}       -> {"results": [{"entailment","neutral","contradiction"}], "model"}
  POST /entities    {"text": str, "labels": [str]?}              -> {"entities": [{"text","label","start","end","score"}], "model"}
  POST /transcribe  {"audio": base64 PCM16LE mono, "language": str|null?, "prompt": str?, "vad": bool?}
                    -> {"text","language","avg_logprob","no_speech_prob","duration_ms","audio_ms","model"}

Errors: {"error": {"code": "...", "message": "..."}} with a stable `code`.

Configuration: defaults < JSON file (MODELS_CONFIG) < environment. See
README.md next to this file.
"""

import base64
import binascii
import copy
import gc
import hmac
import ipaddress
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '0.1.0'

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

MODEL_NAMES = ('embed', 'rerank', 'nli', 'entities', 'transcribe')

# Folder looked up under `models_dir` when a model has no explicit `path`.
DEFAULT_FOLDERS = {
    'embed': 'bge-m3-onnx-int8',
    'rerank': 'gte-reranker-onnx-int8',
    'nli': 'mdeberta-xnli-multilingual',
    'entities': 'gliner-multi-v2.1',
    # "base" over "small": measured 0.35 s against 1.2 s per sentence on a
    # laptop CPU, for a lower recognition rate. Point `path` elsewhere to trade.
    'transcribe': 'faster-whisper-base',
}

DEFAULTS = {
    'host': '127.0.0.1',
    'port': 5007,
    'token': None,
    'token_file': None,
    'models_dir': None,
    'enabled': list(MODEL_NAMES),
    'threads': 2,
    'preload': True,
    'max_body_bytes': 256 * 1024,
    'socket_timeout_s': 30,
    'queue_timeout_s': 30,
    'max_rss_mb': 0,
    'idle_unload_s': 0,
    'legacy_routes': False,
    'models': {
        'embed': {
            'path': None, 'id': None, 'threads': 0, 'max_batch': 32, 'max_chars': 2000,
            'max_tokens': 512,
            # One text per forward pass: the int8 model is dynamically quantised,
            # activation scales depend on the whole batch, and the same text next
            # to a longer one came out at cosine 0.995 of itself. A stored vector
            # must not depend on its batch neighbours.
            'batch_size': 1,
        },
        'rerank': {
            'path': None, 'id': None, 'threads': 0, 'max_batch': 50, 'max_chars': 2000,
            'max_tokens': 512, 'batch_size': 16,
        },
        'nli': {
            'path': None, 'id': None, 'threads': 0, 'max_batch': 20, 'max_chars': 2000,
            'max_tokens': 512,
        },
        'entities': {
            'path': None, 'id': None, 'threads': 0, 'max_chars': 8000, 'max_labels': 10,
            'max_label_chars': 50, 'threshold': 0.5,
            # The encoder reads at most ~384 words: longer texts are cut in chunks.
            'chunk_chars': 1500,
            # One chunk at a time: batches of 6 took memory to 4.8 GB.
            'batch_size': 1,
            'default_labels': ['person'],
            'label_map': {},
            # Local copy of the encoder named in gliner_config.json; relative to
            # models_dir when not absolute.
            'encoder_dir': '_dependances',
        },
        'transcribe': {
            'path': None, 'id': None, 'threads': 4,
            'min_seconds': 0.2, 'max_seconds': 30, 'max_prompt_chars': 600,
            'languages': None, 'auto_languages': [], 'vad': False, 'allow_vad': True,
        },
    },
}

LOOPBACK_HOSTS = {'localhost'}
LANGUAGE_RE = re.compile(r'^[a-z]{2,3}$')
TOKEN_MIN_CHARS = 16
# Speech models of the Whisper family read 16 kHz mono; the API takes PCM at that rate only.
SAMPLE_RATE = 16000
LOGPROB_WITHOUT_TEXT = -10.0
NLI_KEYS = ('entailment', 'neutral', 'contradiction')


class ConfigError(ValueError):
    pass


class InvalidInput(ValueError):
    pass


def log(message):
    print(f'[models] {message}', flush=True)


# ─── Configuration ─────────────────────────────────────────────────────────

def _merge(base, extra, where='config'):
    for key, value in extra.items():
        if key not in base:
            raise ConfigError(f'{where}.{key}: unknown key')
        if isinstance(base[key], dict) and key != 'label_map':
            if not isinstance(value, dict):
                raise ConfigError(f'{where}.{key}: object expected')
            _merge(base[key], value, f'{where}.{key}')
        else:
            base[key] = value
    return base


def _parse_env(raw, default, name):
    """Parse an environment string with the type of its default value."""
    if isinstance(default, bool):
        if raw.lower() in ('1', 'true', 'yes', 'on'):
            return True
        if raw.lower() in ('0', 'false', 'no', 'off', ''):
            return False
        raise ConfigError(f'{name}: boolean expected')
    if isinstance(default, int) and not isinstance(default, bool):
        try:
            return int(raw)
        except ValueError:
            pass
        try:
            return float(raw)
        except ValueError:
            raise ConfigError(f'{name}: number expected') from None
    if isinstance(default, float):
        try:
            return float(raw)
        except ValueError:
            raise ConfigError(f'{name}: number expected') from None
    if isinstance(default, list) or name.endswith('_LANGUAGES'):
        return [part.strip() for part in raw.split(',') if part.strip()]
    if isinstance(default, dict):
        try:
            value = json.loads(raw)
        except ValueError:
            raise ConfigError(f'{name}: JSON object expected') from None
        if not isinstance(value, dict):
            raise ConfigError(f'{name}: JSON object expected')
        return value
    return raw


def load_config(env=None, overrides=None):
    """defaults < JSON file named by MODELS_CONFIG < MODELS_* environment < overrides."""
    env = os.environ if env is None else env
    config = copy.deepcopy(DEFAULTS)
    path = env.get('MODELS_CONFIG')
    if path:
        try:
            with open(path, encoding='utf-8') as handle:
                data = json.load(handle)
        except (OSError, ValueError) as error:
            raise ConfigError(f'MODELS_CONFIG: cannot read ({type(error).__name__})') from None
        if not isinstance(data, dict):
            raise ConfigError('MODELS_CONFIG: JSON object expected')
        _merge(config, data)

    for key, default in DEFAULTS.items():
        if key == 'models':
            continue
        name = f'MODELS_{key.upper()}'
        if key == 'models_dir':
            name = 'MODELS_DIR'
        if name in env:
            config[key] = _parse_env(env[name], default, name)
    for model, defaults in DEFAULTS['models'].items():
        for key, default in defaults.items():
            name = f'MODELS_{model.upper()}_{key.upper()}'
            if name in env:
                config['models'][model][key] = _parse_env(env[name], default, name)

    if overrides:
        _merge(config, copy.deepcopy(overrides))

    if not config['token'] and config['token_file']:
        try:
            with open(config['token_file'], encoding='utf-8') as handle:
                config['token'] = handle.read().strip()
        except OSError:
            raise ConfigError('token_file: cannot read') from None
    return validate_config(config)


def _positive_int(value, name, allow_zero=False):
    if isinstance(value, bool) or not isinstance(value, int) or value < (0 if allow_zero else 1):
        raise ConfigError(f'{name}: {"non-negative" if allow_zero else "positive"} integer expected')


def _positive_number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
        raise ConfigError(f'{name}: positive number expected')


def is_loopback(host):
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_config(config):
    if not isinstance(config['host'], str) or not config['host']:
        raise ConfigError('host: text expected')
    _positive_int(config['port'], 'port', allow_zero=True)
    if config['port'] > 65535:
        raise ConfigError('port: 0 to 65535')
    for key in ('threads', 'max_body_bytes', 'socket_timeout_s', 'queue_timeout_s'):
        _positive_int(config[key], key)
    for key in ('max_rss_mb', 'idle_unload_s'):
        _positive_int(config[key], key, allow_zero=True)
    token = config['token']
    if token is not None and (not isinstance(token, str) or len(token) < TOKEN_MIN_CHARS):
        raise ConfigError(f'token: at least {TOKEN_MIN_CHARS} characters')
    if not token and not is_loopback(config['host']):
        # A model service reachable from the network without a token is an
        # open CPU for anyone who finds the port.
        raise ConfigError('token: required when host is not a loopback address')
    enabled = config['enabled']
    if not isinstance(enabled, list) or any(name not in MODEL_NAMES for name in enabled):
        raise ConfigError(f'enabled: subset of {", ".join(MODEL_NAMES)}')

    models = config['models']
    for name in MODEL_NAMES:
        section = models[name]
        _positive_int(section['threads'], f'models.{name}.threads', allow_zero=True)
        for key in ('max_batch', 'max_chars', 'max_tokens', 'batch_size', 'max_labels', 'max_label_chars',
                    'chunk_chars', 'max_prompt_chars'):
            if key in section:
                _positive_int(section[key], f'models.{name}.{key}')
    entities = models['entities']
    if not isinstance(entities['threshold'], (int, float)) or not 0 <= entities['threshold'] <= 1:
        raise ConfigError('models.entities.threshold: 0 to 1')
    labels = entities['default_labels']
    if not isinstance(labels, list) or not labels or not all(isinstance(x, str) and x.strip() for x in labels):
        raise ConfigError('models.entities.default_labels: non-empty list of texts')
    if not isinstance(entities['label_map'], dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in entities['label_map'].items()):
        raise ConfigError('models.entities.label_map: object of texts')
    transcribe = models['transcribe']
    _positive_number(transcribe['min_seconds'], 'models.transcribe.min_seconds')
    _positive_number(transcribe['max_seconds'], 'models.transcribe.max_seconds')
    if transcribe['min_seconds'] >= transcribe['max_seconds']:
        raise ConfigError('models.transcribe: min_seconds must be below max_seconds')
    for key in ('languages', 'auto_languages'):
        value = transcribe[key]
        if value is None and key == 'languages':
            continue
        if not isinstance(value, list) or not all(isinstance(x, str) and LANGUAGE_RE.match(x) for x in value):
            raise ConfigError(f'models.transcribe.{key}: list of language codes')

    for name in MODEL_NAMES:
        section = models[name]
        path = section['path']
        if not path and config['models_dir']:
            path = os.path.join(config['models_dir'], DEFAULT_FOLDERS[name])
        section['path'] = path if name in enabled else None
        if section['path'] and not section['id']:
            section['id'] = os.path.basename(os.path.normpath(section['path']))
        if not section['threads']:
            section['threads'] = config['threads']
    encoder = entities['encoder_dir']
    if encoder and not os.path.isabs(encoder):
        base = config['models_dir'] or (os.path.dirname(os.path.normpath(entities['path'])) if entities['path'] else '')
        entities['encoder_dir'] = os.path.join(base, encoder) if base else encoder
    return config


def body_limit(config, endpoint):
    """Largest request body accepted by an endpoint, read from the header before the body."""
    if endpoint == 'transcribe':
        audio = audio_byte_limits(config)[1]
        prompt = config['models']['transcribe']['max_prompt_chars'] * 6
        return max(config['max_body_bytes'], audio * 4 // 3 + 4 + prompt + 64 * 1024)
    return config['max_body_bytes']


def audio_byte_limits(config):
    section = config['models']['transcribe']
    return int(section['min_seconds'] * SAMPLE_RATE) * 2, int(section['max_seconds'] * SAMPLE_RATE) * 2


# ─── Validation ────────────────────────────────────────────────────────────

def _text(value):
    return isinstance(value, str) and value.strip() != ''


def _object(data):
    if not isinstance(data, dict):
        raise InvalidInput('object expected')
    return data


def validate_embed(data, config):
    section = config['models']['embed']
    texts = _object(data).get('texts')
    if not isinstance(texts, list) or not 1 <= len(texts) <= section['max_batch']:
        raise InvalidInput(f'texts: list of 1 to {section["max_batch"]}')
    if not all(_text(t) and len(t) <= section['max_chars'] for t in texts):
        raise InvalidInput(f'texts: 1 to {section["max_chars"]} characters each')
    return texts


def validate_rerank(data, config):
    section = config['models']['rerank']
    data = _object(data)
    query, documents = data.get('query'), data.get('documents')
    if not _text(query):
        raise InvalidInput('query: text expected')
    if not isinstance(documents, list) or not 1 <= len(documents) <= section['max_batch']:
        raise InvalidInput(f'documents: list of 1 to {section["max_batch"]}')
    if not all(isinstance(d, str) for d in documents):
        raise InvalidInput('documents: texts expected')
    limit = section['max_chars']
    # Long documents are truncated, not refused: a reranker only needs the head.
    return query[:limit], [d[:limit] for d in documents]


def validate_nli(data, config):
    section = config['models']['nli']
    pairs = _object(data).get('pairs')
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= section['max_batch']:
        raise InvalidInput(f'pairs: list of 1 to {section["max_batch"]}')
    limit = section['max_chars']
    result = []
    for pair in pairs:
        if not isinstance(pair, dict) or not _text(pair.get('premise')) or not _text(pair.get('hypothesis')):
            raise InvalidInput('pairs: premise and hypothesis expected')
        result.append((pair['premise'][:limit], pair['hypothesis'][:limit]))
    return result


def validate_entities(data, config):
    section = config['models']['entities']
    data = _object(data)
    text = data.get('text')
    if not _text(text) or len(text) > section['max_chars']:
        raise InvalidInput(f'text: 1 to {section["max_chars"]} characters')
    labels = data.get('labels', section['default_labels'])
    if (not isinstance(labels, list) or not 1 <= len(labels) <= section['max_labels']
            or not all(_text(x) and len(x) <= section['max_label_chars'] for x in labels)):
        raise InvalidInput(f'labels: list of 1 to {section["max_labels"]} texts')
    return text, list(dict.fromkeys(x.strip() for x in labels))


def validate_transcribe(data, config):
    section = config['models']['transcribe']
    data = _object(data)
    audio = data.get('audio')
    if not _text(audio):
        raise InvalidInput('audio: base64 text expected')
    try:
        pcm = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError):
        raise InvalidInput('audio: base64 expected') from None
    low, high = audio_byte_limits(config)
    if len(pcm) % 2 or not low <= len(pcm) <= high:
        raise InvalidInput(f'audio: PCM 16-bit little-endian mono 16 kHz, {section["min_seconds"]} to {section["max_seconds"]} seconds')
    language = data.get('language')
    if language is not None and language != 'auto':
        allowed = section['languages']
        if not isinstance(language, str) or not LANGUAGE_RE.match(language) or (
                allowed is not None and language not in allowed):
            raise InvalidInput('language: unsupported code' if allowed is None
                               else f'language: one of {", ".join(allowed)} or auto')
    if language == 'auto' or language in section['auto_languages']:
        # Languages the model knows badly (or mixed with another) are left to detection.
        language = None
    prompt = data.get('prompt', '')
    if not isinstance(prompt, str) or len(prompt) > section['max_prompt_chars']:
        raise InvalidInput(f'prompt: text of at most {section["max_prompt_chars"]} characters')
    vad = data.get('vad', section['vad'])
    if not isinstance(vad, bool) or (vad and not section['allow_vad']):
        raise InvalidInput('vad: boolean expected' if not isinstance(vad, bool) else 'vad: disabled on this server')
    return pcm, language, prompt.strip(), vad


VALIDATORS = {
    'embed': validate_embed, 'rerank': validate_rerank, 'nli': validate_nli,
    'entities': validate_entities, 'transcribe': validate_transcribe,
}


# ─── Pure helpers shared with the backends ─────────────────────────────────

def summarize_segments(segments):
    """Text of speech segments and their confidence: `avg_logprob` and
    `no_speech_prob` averaged with the token count of each segment as weight."""
    if not segments:
        return '', LOGPROB_WITHOUT_TEXT, 1.0
    weights = [max(1, len(s.tokens)) for s in segments]
    total = sum(weights)
    text = ' '.join(s.text.strip() for s in segments if s.text.strip())
    logprob = sum(w * s.avg_logprob for w, s in zip(weights, segments)) / total
    no_speech = sum(w * s.no_speech_prob for w, s in zip(weights, segments)) / total
    return text, float(logprob), float(no_speech)


def chunks(text, size):
    """Cut `text` in pieces of at most `size` characters, on a space when one
    exists, with the start offset of each piece in the original text."""
    start, result = 0, []
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            space = text.rfind(' ', start, end)
            if space > start:
                end = space
        result.append((start, text[start:end]))
        start = end
    return result


# ─── Endpoint logic (backend-agnostic) ─────────────────────────────────────

def run_embed(backend, texts, config):
    vectors = backend.embed(texts)
    vectors = [[float(x) for x in v] for v in vectors]
    if len(vectors) != len(texts) or not vectors or any(len(v) != len(vectors[0]) or not v for v in vectors):
        raise RuntimeError('backend returned inconsistent vectors')
    return {'vectors': vectors, 'model': config['models']['embed']['id'], 'dimensions': len(vectors[0])}


def run_rerank(backend, entry, config):
    query, documents = entry
    scores = [float(s) for s in backend.score(query, documents)]
    if len(scores) != len(documents):
        raise RuntimeError('backend returned inconsistent scores')
    return {'scores': scores, 'model': config['models']['rerank']['id']}


def run_nli(backend, pairs, config):
    results = backend.classify(pairs)
    if len(results) != len(pairs):
        raise RuntimeError('backend returned inconsistent results')
    return {'results': [{key: float(r[key]) for key in NLI_KEYS} for r in results],
            'model': config['models']['nli']['id']}


def run_entities(backend, entry, config):
    section = config['models']['entities']
    text, labels = entry
    to_model = {label: section['label_map'].get(label, section['label_map'].get(label.lower(), label))
                for label in labels}
    from_model = {}
    for label, model_label in to_model.items():
        from_model.setdefault(model_label, label)
    pieces = chunks(text, section['chunk_chars'])
    found = backend.predict([piece for _, piece in pieces], list(dict.fromkeys(to_model.values())),
                            section['threshold'])
    entities = []
    for (offset, _), items in zip(pieces, found):
        for item in items:
            entities.append({
                'text': item['text'],
                'label': from_model.get(item['label'], item['label']),
                'start': offset + int(item['start']),
                'end': offset + int(item['end']),
                'score': round(float(item['score']), 4),
            })
    return {'entities': entities, 'model': section['id']}


def run_transcribe(backend, entry, config):
    pcm, language, prompt, vad = entry
    section = config['models']['transcribe']
    started = time.monotonic()
    segments, detected = backend.transcribe(pcm, language, prompt, vad)
    text, logprob, no_speech = summarize_segments(list(segments))
    return {
        'text': text,
        'language': detected or language or '',
        'avg_logprob': round(logprob, 4),
        'no_speech_prob': round(no_speech, 4),
        'duration_ms': int((time.monotonic() - started) * 1000),
        'audio_ms': int(len(pcm) / 2 / SAMPLE_RATE * 1000),
        'model': section['id'],
    }


RUNNERS = {
    'embed': run_embed, 'rerank': run_rerank, 'nli': run_nli,
    'entities': run_entities, 'transcribe': run_transcribe,
}

COUNTERS = {
    'embed': len, 'rerank': lambda e: len(e[1]), 'nli': len,
    'entities': lambda e: len(e[0]), 'transcribe': lambda e: len(e[0]),
}


# ─── Model slots ───────────────────────────────────────────────────────────

def current_rss_mb():
    """Resident memory of this process in MB (Linux: current; elsewhere: peak)."""
    try:
        with open('/proc/self/statm') as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf('SC_PAGE_SIZE') / (1024 * 1024)
    except (OSError, ValueError, IndexError):
        pass
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak / (1024 * 1024) if sys.platform == 'darwin' else peak / 1024
    except (ImportError, OSError):
        return 0.0


class Unavailable(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class ModelSlot:
    """One model: built by `factory` on first use (or at preload), one request
    at a time under its own lock. A failed load is final until restart —
    retrying a broken model on every request would cost a load each time."""

    def __init__(self, name, factory, config, rss_reader=current_rss_mb, clock=time.monotonic):
        self.name = name
        self.factory = factory
        self.config = config
        self.rss_reader = rss_reader
        self.clock = clock
        self.lock = threading.Lock()
        self.instance = None
        self.failed = False
        self.last_used = 0.0

    @property
    def configured(self):
        return self.factory is not None

    @property
    def loaded(self):
        return self.instance is not None

    def _load(self):
        if self.instance is not None or self.failed:
            return self.instance
        limit = self.config['max_rss_mb']
        if limit and self.rss_reader() >= limit:
            log(f'{self.name} not loaded: memory limit {limit} MB reached')
            raise Unavailable('memory_limit')
        started = time.monotonic()
        try:
            self.instance = self.factory()
            log(f'{self.name} loaded in {int((time.monotonic() - started) * 1000)} ms')
        except Exception as error:  # noqa: BLE001 — any failure makes the model unavailable
            self.failed = True
            log(f'{self.name} UNAVAILABLE ({type(error).__name__})')
        return self.instance

    def run(self, function):
        """Result of `function(instance)`; raises Unavailable with a code otherwise."""
        if not self.configured:
            raise Unavailable('model_not_configured')
        if not self.lock.acquire(timeout=self.config['queue_timeout_s']):
            raise Unavailable('busy')
        try:
            instance = self._load()
            if instance is None:
                raise Unavailable('model_unavailable')
            try:
                return function(instance)
            finally:
                self.last_used = self.clock()
        finally:
            self.lock.release()

    def unload_if_idle(self, idle_s):
        """Drop the instance when unused for `idle_s` seconds; the next call reloads it."""
        if not idle_s or self.instance is None or not self.lock.acquire(blocking=False):
            return False
        try:
            if self.instance is None or self.clock() - self.last_used < idle_s:
                return False
            self.instance = None
            gc.collect()
            log(f'{self.name} unloaded after {idle_s} s idle')
            return True
        finally:
            self.lock.release()

    def status(self):
        section = self.config['models'][self.name]
        return {'configured': self.configured, 'loaded': self.loaded, 'failed': self.failed,
                'model': section['id'] if self.configured else None}


def real_factories(config):
    """Factories of the real backends for every configured model (imported lazily)."""
    factories = {}
    for name in MODEL_NAMES:
        section = config['models'][name]
        if section['path']:
            factories[name] = (lambda n=name, s=section: _real_backend(n, s))
    return factories


def _real_backend(name, section):
    import backends
    return backends.create(name, section)


WARMUPS = {
    'embed': lambda b, c: b.embed(['warm up']),
    'rerank': lambda b, c: b.score('warm up', ['warm up']),
    'nli': lambda b, c: b.classify([('It rains.', 'It is sunny.')]),
    'entities': lambda b, c: b.predict(['Hello Mary.'], c['models']['entities']['default_labels'],
                                       c['models']['entities']['threshold']),
    'transcribe': lambda b, c: b.transcribe(bytes(SAMPLE_RATE * 2), None, '', False),
}


class Models:
    def __init__(self, config, factories=None, rss_reader=current_rss_mb, clock=time.monotonic):
        factories = real_factories(config) if factories is None else factories
        self.config = config
        self.slots = {name: ModelSlot(name, factories.get(name) if name in config['enabled'] else None,
                                      config, rss_reader, clock)
                      for name in MODEL_NAMES}

    def preload(self):
        """Load and run every configured model once, so the first request is not the slow one."""
        for name, slot in self.slots.items():
            if slot.configured:
                try:
                    slot.run(lambda backend, n=name: WARMUPS[n](backend, self.config))
                except Unavailable:
                    pass
                except Exception as error:  # noqa: BLE001
                    log(f'{name} warm-up failed ({type(error).__name__})')

    def unload_idle(self):
        return [name for name, slot in self.slots.items() if slot.unload_if_idle(self.config['idle_unload_s'])]

    def health(self):
        return {name: slot.status() for name, slot in self.slots.items()}


# ─── Optional aliases for an earlier French API ────────────────────────────
# Off unless `legacy_routes` is true. Each maps an old route to an endpoint,
# translating the request before validation and the response after.

LEGACY_LANGUAGES = {'fr': 'fr', 'en': 'en', 'es': 'es', 'ln': 'auto'}
LEGACY_LABELS = {'personne': 'person'}
LEGACY_HEALTH_NAMES = {'rerank': 'reclasseur', 'nli': 'nli', 'entities': 'entites',
                       'embed': 'vecteurs', 'transcribe': 'transcription'}


def _legacy_rerank_in(data):
    data = _object(data)
    return {'query': data.get('question'), 'documents': data.get('passages')}, None


def _legacy_nli_in(data):
    pairs = _object(data).get('paires')
    if isinstance(pairs, list):
        pairs = [{'premise': p.get('premisse'), 'hypothesis': p.get('hypothese')} if isinstance(p, dict) else p
                 for p in pairs]
    return {'pairs': pairs}, None


def _legacy_entities_in(data):
    data = _object(data)
    labels = data.get('etiquettes', ['personne'])
    back = {}
    if isinstance(labels, list):
        translated = []
        for label in labels:
            if isinstance(label, str) and label.strip().lower() in LEGACY_LABELS:
                back[LEGACY_LABELS[label.strip().lower()]] = label.strip()
                translated.append(LEGACY_LABELS[label.strip().lower()])
            else:
                translated.append(label)
        labels = translated
    return {'text': data.get('texte'), 'labels': labels}, back


def _legacy_embed_in(data):
    return {'texts': _object(data).get('textes')}, None


def _legacy_transcribe_in(data):
    data = _object(data)
    language = data.get('langue')
    if language not in LEGACY_LANGUAGES:
        raise InvalidInput('langue: fr, en, es or ln')
    return {'audio': data.get('audio'), 'language': LEGACY_LANGUAGES[language],
            'prompt': data.get('vocabulaire', '')}, None


LEGACY_ROUTES = {
    '/reclasser': ('rerank', _legacy_rerank_in, lambda r, _: {'scores': r['scores']}),
    '/vecteurs': ('embed', _legacy_embed_in, lambda r, _: {'vecteurs': r['vectors']}),
    '/entites': ('entities', _legacy_entities_in, lambda r, back: {'entites': [
        {'texte': e['text'], 'type': back.get(e['label'], e['label']), 'debut': e['start'],
         'fin': e['end'], 'score': e['score']} for e in r['entities']]}),
    '/transcrire': ('transcribe', _legacy_transcribe_in, lambda r, _: {
        'texte': r['text'], 'langue': r['language'], 'logprob': r['avg_logprob'],
        'sans_parole': r['no_speech_prob'], 'duree_ms': r['duration_ms']}),
}
LEGACY_NLI = (_legacy_nli_in, lambda r, _: {'resultats': [
    {'accord': x['entailment'], 'neutre': x['neutral'], 'contradiction': x['contradiction']} for x in r['results']]})

ROUTES = {f'/{name}': name for name in MODEL_NAMES}


# ─── HTTP ──────────────────────────────────────────────────────────────────

STATUS_BY_CODE = {
    'model_not_configured': 503, 'model_unavailable': 503, 'busy': 503, 'memory_limit': 503,
}


class Handler(BaseHTTPRequestHandler):
    server_version = 'models'
    sys_version = ''

    def version_string(self):
        return self.server_version
    protocol_version = 'HTTP/1.1'

    def setup(self):
        self.timeout = self.server.config['socket_timeout_s']
        super().setup()

    def log_message(self, fmt, *args):  # replaced by `log`, which never sees content
        pass

    def _json(self, status, data, close=False):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if close:
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, code, message, close=False):
        self._json(status, {'error': {'code': code, 'message': message}}, close=close)

    def _authorized(self):
        token = self.server.config['token']
        if not token:
            return True
        header = self.headers.get('Authorization', '')
        supplied = header[7:].strip() if header[:7].lower() == 'bearer ' else self.headers.get('X-Models-Token', '')
        # Constant time: the comparison must not reveal how many leading characters matched.
        return hmac.compare_digest(supplied.encode('utf-8'), token.encode('utf-8'))

    def _path(self):
        return self.path.split('?', 1)[0]

    def do_GET(self):
        path = self._path()
        if path == '/livez':
            self._json(200, {'status': 'ok'})
            return
        if not self._authorized():
            self._error(401, 'unauthorized', 'missing or wrong token')
            return
        if path == '/health':
            models = self.server.models.health()
            body = {'status': 'ok', 'version': VERSION, 'models': models}
            if self.server.config['legacy_routes']:
                body['modeles'] = {LEGACY_HEALTH_NAMES[n]: s['loaded'] for n, s in models.items()}
            self._json(200, body)
        elif path in ROUTES or (self.server.config['legacy_routes'] and path in LEGACY_ROUTES):
            self._error(405, 'method_not_allowed', 'POST expected', close=True)
        else:
            self._error(404, 'not_found', 'no such route')

    def _refuse_method(self):
        self._error(405, 'method_not_allowed', 'GET or POST only', close=True)

    do_PUT = do_DELETE = do_PATCH = _refuse_method

    def _resolve(self, path):
        """(endpoint, translate_in, translate_out) for a POST path, or None."""
        if path in ROUTES:
            return ROUTES[path], None, None
        if self.server.config['legacy_routes'] and path in LEGACY_ROUTES:
            return LEGACY_ROUTES[path]
        return None

    def do_POST(self):
        started = time.monotonic()
        path = self._path()
        route = self._resolve(path)
        if route is None:
            self._error(404, 'not_found', 'no such route', close=True)
            return
        if not self._authorized():
            # Refused before reading the body: an unauthenticated client cannot make us buffer anything.
            self._error(401, 'unauthorized', 'missing or wrong token', close=True)
            return
        endpoint, translate_in, translate_out = route
        config = self.server.config
        if self.headers.get('Transfer-Encoding'):
            self._error(411, 'length_required', 'Content-Length required', close=True)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = -1
        if length > body_limit(config, endpoint):
            # Read from the header, before the body: an oversized upload is never buffered.
            log(f'{path} 413 bytes={length}')
            self._error(413, 'payload_too_large', f'body over {body_limit(config, endpoint)} bytes', close=True)
            return
        if length <= 0:
            self._error(400, 'body_required', 'JSON body required', close=True)
            return
        raw = self.rfile.read(length)
        back = None
        try:
            data = json.loads(raw)
            if path == '/nli' and config['legacy_routes'] and isinstance(data, dict) and 'paires' in data:
                translate_in, translate_out = LEGACY_NLI
            if translate_in:
                data, back = translate_in(data)
            entry = VALIDATORS[endpoint](data, config)
        except InvalidInput as error:
            log(f'{path} 400 bytes={length}')
            self._error(400, 'invalid_input', str(error))
            return
        except (ValueError, RecursionError):
            # RecursionError: a small body of deeply nested brackets is not JSON we want either.
            log(f'{path} 400 bytes={length}')
            self._error(400, 'invalid_json', 'body is not valid JSON')
            return
        try:
            result = self.server.models.slots[endpoint].run(lambda backend: RUNNERS[endpoint](backend, entry, config))
        except Unavailable as unavailable:
            log(f'{path} 503 {unavailable.code}')
            self._error(STATUS_BY_CODE.get(unavailable.code, 503), unavailable.code, 'model not available')
            return
        except Exception as error:  # noqa: BLE001 — only the type is logged, never the content
            log(f'{path} 500 {type(error).__name__}')
            self._error(500, 'internal_error', 'internal error')
            return
        if translate_out:
            result = translate_out(result, back or {})
        log(f'{path} 200 n={COUNTERS[endpoint](entry)} bytes={length} {int((time.monotonic() - started) * 1000)} ms')
        self._json(200, result)


class ModelsServer(ThreadingHTTPServer):
    daemon_threads = True
    # A queue of unauthenticated sockets is cheap to hold; keep it bounded anyway.
    request_queue_size = 64


def create_server(config, factories=None, rss_reader=current_rss_mb, clock=time.monotonic):
    server = ModelsServer((config['host'], config['port']), Handler)
    server.config = config
    server.models = Models(config, factories, rss_reader, clock)
    return server


def start_idle_reaper(server, interval_s=30):
    """Background thread unloading models idle for `idle_unload_s` (no-op when 0)."""
    if not server.config['idle_unload_s']:
        return None
    stop = threading.Event()

    def loop():
        while not stop.wait(interval_s):
            server.models.unload_idle()

    thread = threading.Thread(target=loop, name='models-idle-reaper', daemon=True)
    thread.start()
    return stop


def main(env=None):
    try:
        config = load_config(env)
    except ConfigError as error:
        log(f'configuration error: {error}')
        return 2
    configured = [name for name in MODEL_NAMES if config['models'][name]['path']]
    log(f'version {VERSION} on {config["host"]}:{config["port"]}')
    log(f'models: {", ".join(configured) or "none"}; token: {"set" if config["token"] else "none (loopback only)"}')
    server = create_server(config)
    if config['preload']:
        started = time.monotonic()
        server.models.preload()
        loaded = [n for n, s in server.models.health().items() if s['loaded']]
        log(f'preload {int((time.monotonic() - started) * 1000)} ms; loaded: {", ".join(loaded) or "none"}')
    start_idle_reaper(server)
    log('ready')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('stopping')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
