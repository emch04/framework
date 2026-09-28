"""Tests of the model service with stub backends: no model, no numpy, no network
beyond 127.0.0.1. Run from the package folder:

  python3 -m unittest discover -s server/tests -t server
"""

import base64
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402

TOKEN = 'a-test-token-of-32-characters-ok'


def b64(data):
    return base64.b64encode(data).decode()


class Segment:
    def __init__(self, text, tokens, logprob, no_speech):
        self.text, self.tokens, self.avg_logprob, self.no_speech_prob = text, [0] * tokens, logprob, no_speech


class StubEmbed:
    def __init__(self):
        self.calls = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return [[float(len(t)), 1.0, 0.0] for t in texts]


class StubRerank:
    def score(self, query, documents):
        return [1.0 if query.split()[0] in d else 0.1 for d in documents]


class StubNli:
    def classify(self, pairs):
        return [{'entailment': 0.7, 'neutral': 0.2, 'contradiction': 0.1} for _ in pairs]


class StubEntities:
    def __init__(self):
        self.calls = []

    def predict(self, chunks, labels, threshold):
        self.calls.append((list(chunks), list(labels), threshold))
        found = []
        for chunk in chunks:
            items = []
            start = chunk.find('Ada Lovelace')
            if start >= 0:
                items.append({'text': 'Ada Lovelace', 'label': labels[0], 'start': start,
                              'end': start + 12, 'score': 0.912345})
            found.append(items)
        return found


class StubTranscribe:
    def __init__(self):
        self.calls = []

    def transcribe(self, pcm, language, prompt, vad):
        self.calls.append((len(pcm), language, prompt, vad))
        return [Segment(' Hello', 3, -0.2, 0.1), Segment(' world.', 1, -1.0, 0.5)], language or 'en'


class Broken:
    def embed(self, texts):
        raise RuntimeError('secret content must not be logged: ' + texts[0])


def stub_factories():
    backends = {'embed': StubEmbed(), 'rerank': StubRerank(), 'nli': StubNli(),
                'entities': StubEntities(), 'transcribe': StubTranscribe()}
    return backends, {name: (lambda b=b: b) for name, b in backends.items()}


def make_config(**overrides):
    base = {'port': 0, 'preload': False, 'models': {name: {'id': f'{name}-model'} for name in app.MODEL_NAMES}}
    for key, value in overrides.items():
        if key == 'models':
            for name, section in value.items():
                base['models'][name].update(section)
        else:
            base[key] = value
    return app.load_config(env={}, overrides=base)


class Running:
    """A server on an ephemeral port, stdout captured (the logs)."""

    def __init__(self, config=None, factories=None, **kwargs):
        self.config = config or make_config()
        if factories is None:
            self.backends, factories = stub_factories()
        self.logs = io.StringIO()
        with redirect_stdout(self.logs):
            self.server = app.create_server(self.config, factories, **kwargs)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        with redirect_stdout(self.logs):
            self.server.serve_forever(poll_interval=0.05)

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, method, path, body=None, raw=None, headers=None, token=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        all_headers = {'Content-Type': 'application/json'}
        if token:
            all_headers['Authorization'] = f'Bearer {token}'
        all_headers.update(headers or {})
        connection.request(method, path, body=data, headers=all_headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, (json.loads(payload) if payload else None)


class ConfigTests(unittest.TestCase):
    def test_defaults_bind_loopback_without_token(self):
        config = app.load_config(env={})
        self.assertEqual(config['host'], '127.0.0.1')
        self.assertEqual(config['port'], 5007)
        self.assertIsNone(config['token'])
        self.assertTrue(all(config['models'][n]['path'] is None for n in app.MODEL_NAMES))

    def test_models_dir_resolves_default_folders_and_ids(self):
        config = app.load_config(env={'MODELS_DIR': '/srv/models'})
        self.assertEqual(config['models']['embed']['path'], '/srv/models/bge-m3-onnx-int8')
        self.assertEqual(config['models']['embed']['id'], 'bge-m3-onnx-int8')
        self.assertEqual(config['models']['transcribe']['path'], '/srv/models/faster-whisper-base')
        self.assertEqual(config['models']['entities']['encoder_dir'], '/srv/models/_dependances')

    def test_enabled_subset_leaves_others_unconfigured(self):
        config = app.load_config(env={'MODELS_DIR': '/srv/m', 'MODELS_ENABLED': 'embed, rerank'})
        self.assertTrue(config['models']['embed']['path'])
        self.assertIsNone(config['models']['nli']['path'])
        self.assertIsNone(config['models']['transcribe']['path'])

    def test_per_model_environment_is_typed(self):
        config = app.load_config(env={
            'MODELS_EMBED_MAX_BATCH': '8', 'MODELS_TRANSCRIBE_LANGUAGES': 'fr,en',
            'MODELS_TRANSCRIBE_MAX_SECONDS': '12.5', 'MODELS_PRELOAD': 'false',
            'MODELS_ENTITIES_LABEL_MAP': '{"personne": "person"}', 'MODELS_ENTITIES_THRESHOLD': '0.3',
            'MODELS_EMBED_PATH': '/x/bge', 'MODELS_THREADS': '3'})
        self.assertEqual(config['models']['embed']['max_batch'], 8)
        self.assertEqual(config['models']['transcribe']['languages'], ['fr', 'en'])
        self.assertEqual(config['models']['transcribe']['max_seconds'], 12.5)
        self.assertFalse(config['preload'])
        self.assertEqual(config['models']['entities']['label_map'], {'personne': 'person'})
        self.assertEqual(config['models']['entities']['threshold'], 0.3)
        self.assertEqual(config['models']['embed']['path'], '/x/bge')
        self.assertEqual(config['models']['embed']['threads'], 3)
        self.assertEqual(config['models']['transcribe']['threads'], 4)

    def test_bad_environment_values_are_refused(self):
        for env in ({'MODELS_PORT': 'abc'}, {'MODELS_PRELOAD': 'maybe'}, {'MODELS_ENABLED': 'embed,gpu'},
                    {'MODELS_ENTITIES_LABEL_MAP': '[1]'}, {'MODELS_TRANSCRIBE_LANGUAGES': 'french'},
                    {'MODELS_EMBED_MAX_BATCH': '0'}, {'MODELS_PORT': '70000'},
                    {'MODELS_TRANSCRIBE_MIN_SECONDS': '40'}):
            with self.subTest(env=env), self.assertRaises(app.ConfigError):
                app.load_config(env=env)

    def test_config_file_merges_and_rejects_unknown_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'models.json')
            with open(path, 'w') as handle:
                json.dump({'port': 6000, 'models': {'rerank': {'path': '/m/rr', 'batch_size': 4}}}, handle)
            config = app.load_config(env={'MODELS_CONFIG': path, 'MODELS_PORT': '6001'})
            self.assertEqual(config['port'], 6001)
            self.assertEqual(config['models']['rerank']['batch_size'], 4)
            self.assertEqual(config['models']['rerank']['id'], 'rr')
            with open(path, 'w') as handle:
                json.dump({'models': {'rerank': {'gpu': True}}}, handle)
            with self.assertRaises(app.ConfigError):
                app.load_config(env={'MODELS_CONFIG': path})
            with self.assertRaises(app.ConfigError):
                app.load_config(env={'MODELS_CONFIG': os.path.join(folder, 'missing.json')})

    def test_public_bind_requires_a_long_token(self):
        with self.assertRaises(app.ConfigError):
            app.load_config(env={'MODELS_HOST': '0.0.0.0'})
        with self.assertRaises(app.ConfigError):
            app.load_config(env={'MODELS_HOST': '0.0.0.0', 'MODELS_TOKEN': 'short'})
        self.assertEqual(app.load_config(env={'MODELS_HOST': '0.0.0.0', 'MODELS_TOKEN': TOKEN})['token'], TOKEN)
        self.assertEqual(app.load_config(env={'MODELS_HOST': '::1'})['host'], '::1')

    def test_token_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'token')
            with open(path, 'w') as handle:
                handle.write(TOKEN + '\n')
            self.assertEqual(app.load_config(env={'MODELS_TOKEN_FILE': path})['token'], TOKEN)
            with self.assertRaises(app.ConfigError):
                app.load_config(env={'MODELS_TOKEN_FILE': os.path.join(folder, 'none')})

    def test_transcribe_body_limit_follows_max_seconds(self):
        config = make_config()
        self.assertEqual(app.body_limit(config, 'embed'), 256 * 1024)
        self.assertGreater(app.body_limit(config, 'transcribe'), 30 * 16000 * 2 * 4 // 3)
        shorter = make_config(models={'transcribe': {'max_seconds': 5}})
        self.assertLess(app.body_limit(shorter, 'transcribe'), app.body_limit(config, 'transcribe'))


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.config = make_config()

    def invalid(self, endpoint, data):
        with self.assertRaises(app.InvalidInput):
            app.VALIDATORS[endpoint](data, self.config)

    def test_every_invalid_input_is_refused(self):
        audio = b64(bytes(32000))
        cases = [
            ('rerank', {'query': '', 'documents': ['a']}), ('rerank', {'query': 'q', 'documents': []}),
            ('rerank', {'query': 'q', 'documents': ['a'] * 51}), ('rerank', {'query': 'q', 'documents': [3]}),
            ('nli', {'pairs': []}), ('nli', {'pairs': [{'premise': 'a'}]}),
            ('nli', {'pairs': [{'premise': 'a', 'hypothesis': 'b'}] * 21}), ('nli', {'pairs': ['a']}),
            ('entities', {'text': ''}), ('entities', {'text': 'x' * 8001}),
            ('entities', {'text': 'Hi', 'labels': []}), ('entities', {'text': 'Hi', 'labels': [5]}),
            ('entities', {'text': 'Hi', 'labels': ['x' * 51]}), ('entities', {'text': 'Hi', 'labels': ['a'] * 11}),
            ('entities', []),
            ('embed', {'texts': []}), ('embed', {'texts': ['a'] * 33}), ('embed', {'texts': ['a', '']}),
            ('embed', {'texts': [3]}), ('embed', {'texts': ['x' * 2001]}), ('embed', {'texts': 'Hello'}),
            ('embed', []),
            ('transcribe', {'language': 'fr'}), ('transcribe', {'audio': 'not base64 !'}),
            ('transcribe', {'audio': b64(bytes(3))}), ('transcribe', {'audio': b64(bytes(1000))}),
            ('transcribe', {'audio': b64(bytes(31 * 16000 * 2))}),
            ('transcribe', {'audio': audio, 'language': 'french'}), ('transcribe', {'audio': audio, 'language': 3}),
            ('transcribe', {'audio': audio, 'prompt': 'x' * 601}), ('transcribe', {'audio': audio, 'prompt': 3}),
            ('transcribe', {'audio': audio, 'vad': 'yes'}), ('transcribe', []),
        ]
        for endpoint, data in cases:
            with self.subTest(endpoint=endpoint, data=str(data)[:60]):
                self.invalid(endpoint, data)

    def test_rerank_truncates_long_documents(self):
        query, documents = app.validate_rerank({'query': 'q' * 3000, 'documents': ['a' * 5000]}, self.config)
        self.assertEqual((len(query), len(documents[0])), (2000, 2000))

    def test_limits_follow_configuration(self):
        config = make_config(models={'embed': {'max_batch': 2, 'max_chars': 5}})
        self.assertEqual(app.validate_embed({'texts': ['abcde', 'b']}, config), ['abcde', 'b'])
        with self.assertRaises(app.InvalidInput):
            app.validate_embed({'texts': ['a', 'b', 'c']}, config)
        with self.assertRaises(app.InvalidInput):
            app.validate_embed({'texts': ['abcdef']}, config)

    def test_entities_default_and_deduplicated_labels(self):
        self.assertEqual(app.validate_entities({'text': 'Hi'}, self.config), ('Hi', ['person']))
        self.assertEqual(app.validate_entities({'text': 'Hi', 'labels': [' city', 'city', 'person']}, self.config)[1],
                         ['city', 'person'])

    def test_transcribe_accepts_and_normalises(self):
        pcm, language, prompt, vad = app.validate_transcribe(
            {'audio': b64(bytes(32000)), 'language': 'es', 'prompt': ' Ada. '}, self.config)
        self.assertEqual((len(pcm), language, prompt, vad), (32000, 'es', 'Ada.', False))
        self.assertIsNone(app.validate_transcribe({'audio': b64(bytes(32000))}, self.config)[1])
        self.assertIsNone(app.validate_transcribe({'audio': b64(bytes(32000)), 'language': 'auto'}, self.config)[1])
        self.assertEqual(app.validate_transcribe({'audio': b64(bytes(32000))}, self.config)[2], '')
        self.assertTrue(app.validate_transcribe({'audio': b64(bytes(32000)), 'vad': True}, self.config)[3])

    def test_transcribe_language_list_and_auto_languages(self):
        config = make_config(models={'transcribe': {'languages': ['fr', 'ln'], 'auto_languages': ['ln']}})
        self.assertEqual(app.validate_transcribe({'audio': b64(bytes(32000)), 'language': 'fr'}, config)[1], 'fr')
        self.assertIsNone(app.validate_transcribe({'audio': b64(bytes(32000)), 'language': 'ln'}, config)[1])
        with self.assertRaises(app.InvalidInput):
            app.validate_transcribe({'audio': b64(bytes(32000)), 'language': 'de'}, config)

    def test_transcribe_vad_can_be_disabled(self):
        config = make_config(models={'transcribe': {'allow_vad': False}})
        with self.assertRaises(app.InvalidInput):
            app.validate_transcribe({'audio': b64(bytes(32000)), 'vad': True}, config)

    def test_audio_bounds_are_exact(self):
        low, high = app.audio_byte_limits(self.config)
        self.assertEqual((low, high), (6400, 960000))
        app.validate_transcribe({'audio': b64(bytes(low))}, self.config)
        app.validate_transcribe({'audio': b64(bytes(high))}, self.config)
        self.invalid('transcribe', {'audio': b64(bytes(low - 2))})
        self.invalid('transcribe', {'audio': b64(bytes(high + 2))})


class HelperTests(unittest.TestCase):
    def test_confidence_is_weighted_by_tokens(self):
        text, logprob, no_speech = app.summarize_segments([Segment(' Hello', 3, -0.2, 0.1), Segment(' Ada.', 1, -1.0, 0.5)])
        self.assertEqual(text, 'Hello Ada.')
        self.assertAlmostEqual(logprob, -0.4)
        self.assertAlmostEqual(no_speech, 0.2)
        self.assertEqual(app.summarize_segments([]), ('', app.LOGPROB_WITHOUT_TEXT, 1.0))

    def test_empty_segments_are_skipped_in_text(self):
        self.assertEqual(app.summarize_segments([Segment('  ', 0, -0.5, 0.9), Segment(' Yes', 2, -0.1, 0.1)])[0], 'Yes')

    def test_chunks_cut_on_spaces_and_keep_offsets(self):
        text = 'alpha beta gamma delta'
        pieces = app.chunks(text, 11)
        self.assertEqual(''.join(p for _, p in pieces), text)
        for offset, piece in pieces:
            self.assertEqual(text[offset:offset + len(piece)], piece)
            self.assertLessEqual(len(piece), 11)
        self.assertEqual(app.chunks('abcdefghij', 4), [(0, 'abcd'), (4, 'efgh'), (8, 'ij')])
        self.assertEqual(app.chunks('', 4), [])


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.running = Running()
        cls.backends = cls.running.backends

    @classmethod
    def tearDownClass(cls):
        cls.running.close()

    def call(self, *args, **kwargs):
        return self.running.request(*args, **kwargs)

    def test_livez_and_health(self):
        self.assertEqual(self.call('GET', '/livez'), (200, {'status': 'ok'}))
        status, body = self.call('GET', '/health')
        self.assertEqual(status, 200)
        self.assertEqual(body['version'], app.VERSION)
        self.assertEqual(set(body['models']), set(app.MODEL_NAMES))
        self.assertEqual(body['models']['embed'], {'configured': True, 'loaded': body['models']['embed']['loaded'],
                                                   'failed': False, 'model': 'embed-model'})
        self.assertNotIn('modeles', body)

    def test_embed_returns_model_id_and_dimensions(self):
        status, body = self.call('POST', '/embed', {'texts': ['ab', 'abcd']})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'vectors': [[2.0, 1.0, 0.0], [4.0, 1.0, 0.0]], 'model': 'embed-model', 'dimensions': 3})

    def test_rerank(self):
        status, body = self.call('POST', '/rerank', {'query': 'capital city', 'documents': ['the capital', 'cats']})
        self.assertEqual((status, body), (200, {'scores': [1.0, 0.1], 'model': 'rerank-model'}))

    def test_nli(self):
        status, body = self.call('POST', '/nli', {'pairs': [{'premise': 'a', 'hypothesis': 'b'}]})
        self.assertEqual(status, 200)
        self.assertEqual(body['results'], [{'entailment': 0.7, 'neutral': 0.2, 'contradiction': 0.1}])
        self.assertEqual(body['model'], 'nli-model')

    def test_entities_offsets_across_chunks(self):
        text = 'filler words here. ' * 100 + 'Signed by Ada Lovelace.'
        status, body = self.call('POST', '/entities', {'text': text, 'labels': ['person']})
        self.assertEqual(status, 200)
        found = body['entities'][0]
        self.assertEqual(text[found['start']:found['end']], 'Ada Lovelace')
        self.assertEqual((found['label'], found['score']), ('person', 0.9123))
        chunks, labels, threshold = self.backends['entities'].calls[-1]
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= 1500 for c in chunks))
        self.assertEqual((labels, threshold), (['person'], 0.5))

    def test_transcribe(self):
        status, body = self.call('POST', '/transcribe', {'audio': b64(bytes(32000)), 'language': 'fr', 'prompt': 'Ada'})
        self.assertEqual(status, 200)
        self.assertEqual(body['text'], 'Hello world.')
        self.assertEqual((body['language'], body['avg_logprob'], body['no_speech_prob']), ('fr', -0.4, 0.2))
        self.assertEqual((body['audio_ms'], body['model']), (1000, 'transcribe-model'))
        self.assertIsInstance(body['duration_ms'], int)
        self.assertEqual(self.backends['transcribe'].calls[-1], (32000, 'fr', 'Ada', False))

    def test_invalid_inputs_answer_400_with_code(self):
        status, body = self.call('POST', '/embed', {'texts': []})
        self.assertEqual(status, 400)
        self.assertEqual(body['error']['code'], 'invalid_input')
        self.assertEqual(self.call('POST', '/nli', raw=b'{not json')[1]['error']['code'], 'invalid_json')
        self.assertEqual(self.call('POST', '/nli', raw=b'[' * 128000 + b']' * 128000)[1]['error']['code'], 'invalid_json')
        self.assertEqual(self.call('POST', '/nli', raw=b'\xff\xfe')[1]['error']['code'], 'invalid_json')

    def test_empty_body_400(self):
        status, body = self.call('POST', '/embed', raw=b'')
        self.assertEqual((status, body['error']['code']), (400, 'body_required'))

    def test_oversized_body_refused_from_the_header(self):
        status, body = self.call('POST', '/rerank', raw=json.dumps({'query': 'q', 'documents': ['a' * 300_000]}).encode())
        self.assertEqual((status, body['error']['code']), (413, 'payload_too_large'))
        connection = http.client.HTTPConnection('127.0.0.1', self.running.port, timeout=10)
        connection.putrequest('POST', '/transcribe')
        connection.putheader('Content-Length', str(1_400_000))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_chunked_body_refused(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.running.port, timeout=10)
        connection.putrequest('POST', '/embed')
        connection.putheader('Transfer-Encoding', 'chunked')
        connection.endheaders()
        connection.send(b'5\r\nhello\r\n0\r\n\r\n')
        self.assertEqual(connection.getresponse().status, 411)
        connection.close()

    def test_unknown_routes_and_methods(self):
        self.assertEqual(self.call('GET', '/nothing')[0], 404)
        self.assertEqual(self.call('POST', '/nothing', {'a': 1})[1]['error']['code'], 'not_found')
        self.assertEqual(self.call('GET', '/embed')[1]['error']['code'], 'method_not_allowed')
        self.assertEqual(self.call('DELETE', '/embed')[0], 405)
        self.assertEqual(self.call('POST', '/reclasser', {'question': 'q', 'passages': ['a']})[0], 404)

    def test_keep_alive_survives_an_error(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.running.port, timeout=10)
        for body in ({'texts': []}, {'texts': ['ok']}):
            connection.request('POST', '/embed', body=json.dumps(body).encode())
            response = connection.getresponse()
            response.read()
        self.assertEqual(response.status, 200)
        connection.close()

    def test_responses_are_not_cached_and_hide_versions(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.running.port, timeout=10)
        connection.request('GET', '/livez')
        response = connection.getresponse()
        response.read()
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        self.assertEqual(response.getheader('Server'), 'models')
        connection.close()

    def test_logs_never_contain_texts(self):
        self.call('POST', '/embed', {'texts': ['a very private sentence']})
        self.call('POST', '/embed', {'texts': ['x' * 5000]})
        logs = self.running.logs.getvalue()
        self.assertIn('/embed 200 n=1', logs)
        self.assertNotIn('private sentence', logs)


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.running = Running(make_config(token=TOKEN))

    @classmethod
    def tearDownClass(cls):
        cls.running.close()

    def test_missing_or_wrong_token_401(self):
        self.assertEqual(self.running.request('GET', '/health')[0], 401)
        status, body = self.running.request('POST', '/embed', {'texts': ['a']}, token='wrong-token-of-enough-length')
        self.assertEqual((status, body['error']['code']), (401, 'unauthorized'))
        self.assertEqual(self.running.request('POST', '/embed', {'texts': ['a']}, token=TOKEN[:-1])[0], 401)

    def test_bearer_and_header_token_accepted(self):
        self.assertEqual(self.running.request('POST', '/embed', {'texts': ['a']}, token=TOKEN)[0], 200)
        self.assertEqual(self.running.request('GET', '/health', headers={'X-Models-Token': TOKEN})[0], 200)
        self.assertEqual(self.running.request('GET', '/health', headers={'Authorization': 'bearer ' + TOKEN})[0], 200)

    def test_livez_needs_no_token(self):
        self.assertEqual(self.running.request('GET', '/livez')[0], 200)

    def test_unauthenticated_oversized_upload_is_refused_before_size(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.running.port, timeout=10)
        connection.putrequest('POST', '/transcribe')
        connection.putheader('Content-Length', str(50_000_000))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 401)
        connection.close()

    def test_comparison_is_constant_time(self):
        calls = []
        original = app.hmac.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return original(a, b)
        app.hmac.compare_digest = spy
        try:
            self.running.request('GET', '/health', token=TOKEN)
        finally:
            app.hmac.compare_digest = original
        self.assertEqual(calls, [(TOKEN.encode(), TOKEN.encode())])


class DegradedTests(unittest.TestCase):
    def test_failed_and_missing_models_answer_503_others_keep_working(self):
        _, factories = stub_factories()

        def broken():
            raise FileNotFoundError('no such folder')
        factories['entities'] = broken
        del factories['transcribe']
        running = Running(make_config(preload=True), factories)
        try:
            with redirect_stdout(running.logs):
                running.server.models.preload()
            health = running.request('GET', '/health')[1]['models']
            self.assertEqual((health['entities']['failed'], health['entities']['loaded']), (True, False))
            self.assertEqual((health['transcribe']['configured'], health['transcribe']['model']), (False, None))
            self.assertTrue(health['embed']['loaded'])
            status, body = running.request('POST', '/entities', {'text': 'Ada Lovelace came.'})
            self.assertEqual((status, body['error']['code']), (503, 'model_unavailable'))
            status, body = running.request('POST', '/transcribe', {'audio': b64(bytes(32000))})
            self.assertEqual((status, body['error']['code']), (503, 'model_not_configured'))
            self.assertEqual(running.request('POST', '/rerank', {'query': 'q', 'documents': ['a']})[0], 200)
            self.assertIn('entities UNAVAILABLE (FileNotFoundError)', running.logs.getvalue())
        finally:
            running.close()

    def test_backend_exception_is_500_without_content_in_logs(self):
        running = Running(make_config(), {'embed': Broken})
        try:
            status, body = running.request('POST', '/embed', {'texts': ['patient record 42']})
            self.assertEqual((status, body['error']['code']), (500, 'internal_error'))
            self.assertNotIn('patient record', json.dumps(body))
            self.assertIn('/embed 500 RuntimeError', running.logs.getvalue())
            self.assertNotIn('patient record', running.logs.getvalue())
        finally:
            running.close()

    def test_inconsistent_backend_output_is_500(self):
        class Short:
            def embed(self, texts):
                return [[0.1]]
        running = Running(make_config(), {'embed': Short})
        try:
            self.assertEqual(running.request('POST', '/embed', {'texts': ['a', 'b']})[0], 500)
        finally:
            running.close()

    def test_memory_limit_refuses_to_load(self):
        running = Running(make_config(max_rss_mb=100), stub_factories()[1], rss_reader=lambda: 150.0)
        try:
            status, body = running.request('POST', '/embed', {'texts': ['a']})
            self.assertEqual((status, body['error']['code']), (503, 'memory_limit'))
            self.assertFalse(running.request('GET', '/health')[1]['models']['embed']['failed'])
        finally:
            running.close()

    def test_busy_model_answers_503_after_queue_timeout(self):
        running = Running(make_config(queue_timeout_s=1))
        slot = running.server.models.slots['embed']
        slot.lock.acquire()
        try:
            status, body = running.request('POST', '/embed', {'texts': ['a']})
            self.assertEqual((status, body['error']['code']), (503, 'busy'))
        finally:
            slot.lock.release()
            running.close()


class LoadingTests(unittest.TestCase):
    def test_lazy_single_load(self):
        built = []

        def factory():
            built.append(1)
            return StubEmbed()
        running = Running(make_config(), {'embed': factory})
        try:
            self.assertEqual(built, [])
            self.assertFalse(running.request('GET', '/health')[1]['models']['embed']['loaded'])
            for _ in range(3):
                self.assertEqual(running.request('POST', '/embed', {'texts': ['a']})[0], 200)
            self.assertEqual(built, [1])
        finally:
            running.close()

    def test_failed_load_is_not_retried(self):
        attempts = []

        def factory():
            attempts.append(1)
            raise OSError('missing')
        running = Running(make_config(), {'embed': factory})
        try:
            running.request('POST', '/embed', {'texts': ['a']})
            running.request('POST', '/embed', {'texts': ['a']})
            self.assertEqual(attempts, [1])
        finally:
            running.close()

    def test_preload_warms_every_configured_model(self):
        backends, factories = stub_factories()
        config = make_config(preload=True)
        with redirect_stdout(io.StringIO()):
            models = app.Models(config, factories)
            models.preload()
        self.assertTrue(all(s['loaded'] for s in models.health().values()))
        self.assertEqual(backends['embed'].calls, [['warm up']])
        self.assertEqual(backends['transcribe'].calls, [(32000, None, '', False)])

    def test_disabled_model_is_not_configured_even_with_a_factory(self):
        config = make_config(enabled=['embed'])
        models = app.Models(config, stub_factories()[1])
        self.assertFalse(models.slots['rerank'].configured)
        self.assertTrue(models.slots['embed'].configured)

    def test_idle_unload_then_reload(self):
        now = [100.0]
        built = []

        def factory():
            built.append(1)
            return StubEmbed()
        config = make_config(idle_unload_s=60)
        with redirect_stdout(io.StringIO()):
            models = app.Models(config, {'embed': factory}, clock=lambda: now[0])
            models.slots['embed'].run(lambda b: b.embed(['a']))
            now[0] += 59
            self.assertEqual(models.unload_idle(), [])
            now[0] += 2
            self.assertEqual(models.unload_idle(), ['embed'])
            self.assertFalse(models.slots['embed'].loaded)
            models.slots['embed'].run(lambda b: b.embed(['a']))
        self.assertEqual(built, [1, 1])

    def test_idle_unload_disabled_by_default(self):
        with redirect_stdout(io.StringIO()):
            models = app.Models(make_config(), {'embed': StubEmbed})
            models.slots['embed'].run(lambda b: b.embed(['a']))
        self.assertEqual(models.unload_idle(), [])
        self.assertIsNone(app.start_idle_reaper(type('S', (), {'config': make_config()})()))


class LabelMapTests(unittest.TestCase):
    def test_api_labels_are_translated_for_the_model_and_back(self):
        backends, factories = stub_factories()
        running = Running(make_config(models={'entities': {'label_map': {'personne': 'person'},
                                                           'default_labels': ['personne']}}), factories)
        try:
            body = running.request('POST', '/entities', {'text': 'Hier Ada Lovelace est venue.'})[1]
            self.assertEqual(body['entities'][0]['label'], 'personne')
            self.assertEqual(backends['entities'].calls[-1][1], ['person'])
            running.request('POST', '/entities', {'text': 'Ada Lovelace', 'labels': ['personne', 'person']})
            self.assertEqual(backends['entities'].calls[-1][1], ['person'])
        finally:
            running.close()


class LegacyRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.running = Running(make_config(legacy_routes=True))
        cls.backends = cls.running.backends

    @classmethod
    def tearDownClass(cls):
        cls.running.close()

    def call(self, *args, **kwargs):
        return self.running.request(*args, **kwargs)

    def test_health_keeps_the_old_shape_too(self):
        body = self.call('GET', '/health')[1]
        self.assertEqual(set(body['modeles']), {'reclasseur', 'nli', 'entites', 'vecteurs', 'transcription'})
        self.assertIn('models', body)

    def test_old_routes_translate_both_ways(self):
        self.assertEqual(self.call('POST', '/reclasser', {'question': 'capital', 'passages': ['capital', 'x']}),
                         (200, {'scores': [1.0, 0.1]}))
        self.assertEqual(self.call('POST', '/vecteurs', {'textes': ['ab']}), (200, {'vecteurs': [[2.0, 1.0, 0.0]]}))
        self.assertEqual(self.call('POST', '/nli', {'paires': [{'premisse': 'a', 'hypothese': 'b'}]}),
                         (200, {'resultats': [{'accord': 0.7, 'neutre': 0.2, 'contradiction': 0.1}]}))
        self.assertEqual(self.call('POST', '/nli', {'pairs': [{'premise': 'a', 'hypothesis': 'b'}]})[1]['model'], 'nli-model')

    def test_old_entities_default_to_person_and_answer_in_old_words(self):
        status, body = self.call('POST', '/entites', {'texte': 'Hier Ada Lovelace est venue.'})
        self.assertEqual(status, 200)
        self.assertEqual(body['entites'], [{'texte': 'Ada Lovelace', 'type': 'personne', 'debut': 5, 'fin': 17, 'score': 0.9123}])
        self.assertEqual(self.backends['entities'].calls[-1][1], ['person'])

    def test_old_transcription(self):
        status, body = self.call('POST', '/transcrire', {'audio': b64(bytes(32000)), 'langue': 'ln', 'vocabulaire': 'Ada'})
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {'texte', 'langue', 'logprob', 'sans_parole', 'duree_ms'})
        self.assertEqual(self.backends['transcribe'].calls[-1], (32000, None, 'Ada', False))
        self.assertEqual(self.call('POST', '/transcrire', {'audio': b64(bytes(32000)), 'langue': 'de'})[0], 400)

    def test_old_invalid_inputs_still_400(self):
        for path, body in (('/reclasser', {'question': '', 'passages': ['a']}), ('/vecteurs', {'textes': []}),
                           ('/entites', {'texte': ''}), ('/nli', {'paires': [{'premisse': 'a'}]}), ('/entites', [])):
            with self.subTest(path=path):
                self.assertEqual(self.call('POST', path, body)[0], 400)


if __name__ == '__main__':
    unittest.main()
