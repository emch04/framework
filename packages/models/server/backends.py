"""
Real CPU backends of the model service. Imported only when a model is loaded,
so app.py (validation, HTTP, configuration) runs and is tested with the
standard library alone.

Each backend exposes one method, the contract app.py relies on:
  EmbedBackend.embed(texts)                         -> [[float]]  (L2-normalised)
  RerankBackend.score(query, documents)             -> [float]    (0..1, higher = more relevant)
  NliBackend.classify(pairs)                        -> [{"entailment","neutral","contradiction"}]
  EntitiesBackend.predict(chunks, labels, threshold)-> [[{"text","label","start","end","score"}]] per chunk
  TranscribeBackend.transcribe(pcm, language, prompt, vad) -> (segments, detected_language)
"""

import json
import os
import tempfile

NLI_LABELS = {'entailment': 'entailment', 'neutral': 'neutral', 'contradiction': 'contradiction'}


def _onnx_session(path, threads):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return ort.InferenceSession(path, sess_options=options, providers=['CPUExecutionProvider'])


def _onnx_file(folder):
    """The quantised graph when present, the plain one otherwise."""
    for name in ('model_quantized.onnx', 'model_int8.onnx', 'model.onnx'):
        path = os.path.join(folder, 'onnx', name)
        if os.path.isfile(path):
            return path
    raise FileNotFoundError('no ONNX graph under onnx/')


def _tokenizer(folder, max_tokens):
    from tokenizers import Tokenizer
    tokenizer = Tokenizer.from_file(os.path.join(folder, 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=max_tokens)
    tokenizer.enable_padding()
    return tokenizer


def _inputs(tokenizer, items, names):
    import numpy as np
    encoded = tokenizer.encode_batch(items)
    columns = {
        'input_ids': [e.ids for e in encoded],
        'attention_mask': [e.attention_mask for e in encoded],
        'token_type_ids': [e.type_ids for e in encoded],
    }
    return {name: np.array(columns[name], dtype=np.int64) for name in names}


class _OnnxBackend:
    def __init__(self, section):
        folder = section['path']
        self.session = _onnx_session(_onnx_file(folder), section['threads'])
        self.tokenizer = _tokenizer(folder, section['max_tokens'])
        self.names = [i.name for i in self.session.get_inputs()]
        self.section = section


class RerankBackend(_OnnxBackend):
    """Cross-encoder reranker (e.g. gte-multilingual-reranker): sigmoid of the first logit."""

    def score(self, query, documents):
        import numpy as np
        size = self.section['batch_size']
        result = []
        for i in range(0, len(documents), size):
            batch = [(query, d) for d in documents[i:i + size]]
            logits = self.session.run(None, _inputs(self.tokenizer, batch, self.names))[0][:, 0]
            result.extend((1.0 / (1.0 + np.exp(-logits))).tolist())
        return [float(s) for s in result]


class NliBackend(_OnnxBackend):
    """Natural language inference (e.g. mDeBERTa XNLI): softmax over the three classes,
    ordered by the model's own id2label."""

    def __init__(self, section):
        super().__init__(section)
        with open(os.path.join(section['path'], 'config.json'), encoding='utf-8') as handle:
            id2label = json.load(handle)['id2label']
        self.keys = [NLI_LABELS[id2label[str(i)].lower()] for i in range(len(id2label))]

    def classify(self, pairs):
        import numpy as np
        logits = self.session.run(None, _inputs(self.tokenizer, pairs, self.names))[0]
        exp = np.exp(logits - logits.max(axis=1, keepdims=True))
        probabilities = exp / exp.sum(axis=1, keepdims=True)
        return [{key: float(row[i]) for i, key in enumerate(self.keys)} for row in probabilities]


class EmbedBackend(_OnnxBackend):
    """Dense embeddings (e.g. bge-m3): CLS token of the last layer, L2-normalised,
    so the dot product of two vectors is their cosine."""

    def embed(self, texts):
        import numpy as np
        size = self.section['batch_size']
        result = []
        for i in range(0, len(texts), size):
            output = self.session.run(None, _inputs(self.tokenizer, texts[i:i + size], self.names))[0]
            cls = output[:, 0, :]
            norms = np.linalg.norm(cls, axis=1, keepdims=True)
            result.extend((cls / np.maximum(norms, 1e-12)).tolist())
        return [[float(x) for x in v] for v in result]


class EntitiesBackend:
    """GLiNER zero-shot entities. Its config names an encoder (a hub name or a
    path of the machine that prepared it); it is pointed at the local copy in
    `encoder_dir` through a temporary folder of symlinks, so the model folder is
    never modified and nothing is downloaded."""

    def __init__(self, section):
        import torch
        from gliner import GLiNER
        torch.set_num_threads(section['threads'])
        folder = section['path']
        with open(os.path.join(folder, 'gliner_config.json'), encoding='utf-8') as handle:
            config = json.load(handle)
        encoder = os.path.join(section['encoder_dir'], os.path.basename(config['model_name'].rstrip('/')))
        if not os.path.isdir(encoder):
            raise FileNotFoundError('GLiNER encoder missing from encoder_dir')
        config['model_name'] = encoder
        with tempfile.TemporaryDirectory() as links:
            for name in os.listdir(folder):
                if name != 'gliner_config.json':
                    os.symlink(os.path.join(folder, name), os.path.join(links, name))
            with open(os.path.join(links, 'gliner_config.json'), 'w', encoding='utf-8') as handle:
                json.dump(config, handle)
            self.model = GLiNER.from_pretrained(links, local_files_only=True)
        self.model.eval()
        self.batch_size = section['batch_size']

    def predict(self, chunks, labels, threshold):
        import torch
        with torch.inference_mode():
            found = self.model.inference(chunks, labels, threshold=threshold, batch_size=self.batch_size)
        return [[{'text': e['text'], 'label': e['label'], 'start': int(e['start']), 'end': int(e['end']),
                  'score': float(e['score'])} for e in items] for items in found]


class TranscribeBackend:
    """faster-whisper int8 on the CPU. Greedy, temperature 0, no fallback
    sampling and no conditioning on previous text: latency matters more than a
    second chance, and the confidence tells the caller when to ask again. The
    optional prompt carries expected vocabulary (names, product terms): it
    raised recognised names from 2 to 11 out of 17 in a measurement."""

    def __init__(self, section):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(section['path'], device='cpu', compute_type='int8',
                                  cpu_threads=section['threads'])

    def transcribe(self, pcm, language, prompt, vad):
        import numpy as np
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        segments, info = self.model.transcribe(
            audio, language=language, beam_size=1, temperature=0.0,
            condition_on_previous_text=False, without_timestamps=True, vad_filter=bool(vad),
            initial_prompt=prompt or None)
        return list(segments), info.language


BACKENDS = {
    'embed': EmbedBackend, 'rerank': RerankBackend, 'nli': NliBackend,
    'entities': EntitiesBackend, 'transcribe': TranscribeBackend,
}


def create(name, section):
    return BACKENDS[name](section)
