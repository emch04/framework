"""Optional smoke test against REAL models. Skipped unless MODELS_SMOKE_DIR names
a folder holding the model folders and the running python has the backends'
dependencies (see requirements*.txt). Run from the package folder with the
service's own virtual environment:

  MODELS_SMOKE_DIR=/path/to/models [MODELS_SMOKE_AUDIO=/path/to/speech.wav] \
    /path/to/venv/bin/python -m unittest discover -s server/tests -p 'test_real_models.py'

MODELS_SMOKE_AUDIO: optional 16 kHz mono 16-bit WAV of speech, for the
transcription check (only "some text comes back" is asserted).
"""

import base64
import http.client
import importlib.util
import io
import json
import os
import sys
import threading
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402

MODELS_DIR = os.environ.get('MODELS_SMOKE_DIR', '')
AUDIO = os.environ.get('MODELS_SMOKE_AUDIO', '')
DEPENDENCIES = ('onnxruntime', 'tokenizers', 'numpy', 'gliner', 'faster_whisper')
READY = bool(MODELS_DIR) and os.path.isdir(MODELS_DIR) and all(
    importlib.util.find_spec(name) is not None for name in DEPENDENCIES)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


@unittest.skipUnless(READY, 'MODELS_SMOKE_DIR unset or model dependencies missing')
class RealModelsSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = app.load_config(env={'MODELS_DIR': MODELS_DIR}, overrides={'port': 0})
        cls.logs = io.StringIO()
        with redirect_stdout(cls.logs):
            cls.server = app.create_server(cls.config)
            cls.server.models.preload()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=300)
        connection.request('GET' if body is None else 'POST', path,
                           body=None if body is None else json.dumps(body).encode())
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def test_every_model_loads(self):
        status, body = self.call('/health')
        self.assertEqual(status, 200)
        self.assertEqual({n: s['loaded'] for n, s in body['models'].items()},
                         {n: True for n in app.MODEL_NAMES}, self.logs.getvalue())

    def test_embed_meaning_across_languages_and_batch_stability(self):
        texts = ['My son is afraid of the end-of-year exams.',
                 "Mon fils a peur des examens de fin d'année.",
                 'The apple pie recipe needs butter.']
        status, body = self.call('/embed', {'texts': texts})
        self.assertEqual(status, 200)
        self.assertEqual((body['dimensions'], body['model']), (1024, 'bge-m3-onnx-int8'))
        vectors = body['vectors']
        for vector in vectors:
            self.assertAlmostEqual(dot(vector, vector), 1.0, places=3)
        self.assertGreater(dot(vectors[0], vectors[1]), 0.75)
        self.assertLess(dot(vectors[0], vectors[2]), 0.5)
        alone = self.call('/embed', {'texts': [texts[0]]})[1]['vectors'][0]
        self.assertGreater(dot(alone, vectors[0]), 0.999)

    def test_rerank_puts_the_relevant_document_first(self):
        documents = ['The apple pie recipe needs butter and flour.', 'The football match ended in a draw.',
                     'Kinshasa is the capital of the Democratic Republic of the Congo.',
                     'Cats sleep fifteen hours a day.']
        status, body = self.call('/rerank', {'query': 'What is the capital of the DRC?', 'documents': documents})
        self.assertEqual(status, 200)
        self.assertEqual(max(range(4), key=lambda i: body['scores'][i]), 2)

    def test_nli(self):
        pairs = [{'premise': 'Kinshasa is the capital of the DRC.', 'hypothesis': 'The capital of the DRC is Lubumbashi.'},
                 {'premise': 'Kinshasa is the capital of the DRC.', 'hypothesis': 'The capital of the DRC is Kinshasa.'}]
        status, body = self.call('/nli', {'pairs': pairs})
        self.assertEqual(status, 200)
        contradiction, entailment = body['results']
        self.assertGreater(contradiction['contradiction'], 0.8)
        self.assertGreater(entailment['entailment'], 0.8)

    def test_entities_find_people_with_exact_offsets(self):
        text = 'Yesterday in Kinshasa, Josué Mbala handed his homework to Marie Kabongo, his teacher.'
        status, body = self.call('/entities', {'text': text})
        self.assertEqual(status, 200)
        people = {e['text'] for e in body['entities'] if e['label'] == 'person'}
        self.assertTrue({'Josué Mbala', 'Marie Kabongo'} <= people, body)
        for entity in body['entities']:
            self.assertEqual(text[entity['start']:entity['end']], entity['text'])

    def test_transcribe_silence_is_not_a_sentence(self):
        status, body = self.call('/transcribe', {'audio': base64.b64encode(bytes(2 * 16000 * 2)).decode(), 'language': 'en'})
        self.assertEqual(status, 200)
        self.assertTrue(body['text'] == '' or body['no_speech_prob'] > 0.6 or body['avg_logprob'] < -1.0, body)

    @unittest.skipUnless(AUDIO and os.path.isfile(AUDIO), 'MODELS_SMOKE_AUDIO unset')
    def test_transcribe_speech(self):
        with wave.open(AUDIO) as handle:
            self.assertEqual((handle.getframerate(), handle.getnchannels(), handle.getsampwidth()), (16000, 1, 2))
            pcm = handle.readframes(handle.getnframes())
        status, body = self.call('/transcribe', {'audio': base64.b64encode(pcm).decode(), 'language': None})
        self.assertEqual(status, 200)
        self.assertTrue(body['text'])
        self.assertTrue(body['language'])


if __name__ == '__main__':
    unittest.main()
