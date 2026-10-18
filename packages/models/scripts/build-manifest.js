#!/usr/bin/env node
/* global fetch */
/**
 * Maintainer tool: (re)writes data/models-manifest.json.
 *
 * For each model, the Hugging Face repository, the files the service needs and
 * the licence are declared below. The script asks the Hub for the commit hash
 * of the repository (kept as is when the manifest already pins one, unless
 * --update is given), then records the SHA-256 and the size of every file:
 *   - large files are stored in Git LFS and the Hub publishes their SHA-256, so
 *     nothing is downloaded for them;
 *   - small files are not, so they are downloaded (a few kilobytes) and hashed.
 *
 * Never run by the package: weights are not part of it, and the manifest is a
 * reviewed, committed file. Needs the network.
 *
 *   node scripts/build-manifest.js [--update] [--models embed,nli] [--out FILE]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENDPOINT = process.env.HF_ENDPOINT || 'https://huggingface.co';
const MANIFEST = path.join(__dirname, '..', 'data', 'models-manifest.json');

/* The source of truth for what the service needs. `folder` is where the files
   land under the models directory; a source may name its own `dir` under it. */
const SPEC = {
  embed: {
    folder: 'bge-m3-onnx-int8',
    description: 'BGE-M3 dense embeddings, int8 ONNX (CLS pooling, 1024 dimensions)',
    license: 'MIT',
    sources: [{
      repo: 'Xenova/bge-m3',
      files: ['config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json']
    }]
  },
  rerank: {
    folder: 'gte-reranker-onnx-int8',
    description: 'GTE multilingual reranker (cross-encoder), int8 ONNX',
    license: 'Apache-2.0',
    sources: [{
      repo: 'onnx-community/gte-multilingual-reranker-base',
      files: ['config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json']
    }]
  },
  nli: {
    folder: 'mdeberta-xnli-multilingual',
    description: 'mDeBERTa-v3 multilingual NLI (entailment, neutral, contradiction), int8 ONNX',
    license: 'MIT',
    sources: [{
      repo: 'MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7',
      files: ['added_tokens.json', 'config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json']
    }]
  },
  entities: {
    folder: 'gliner-multi-v2.1',
    description: 'GLiNER multilingual zero-shot entities, with the encoder files it names in its configuration',
    license: 'Apache-2.0 (GLiNER), MIT (encoder)',
    sources: [
      { repo: 'urchade/gliner_multi-v2.1', files: ['gliner_config.json', 'model.safetensors'] },
      /* GLiNER 0.2.x builds the encoder from its configuration and reads the
         weights from model.safetensors: only the configuration and the
         tokenizer of the encoder are needed, in the folder `encoder_dir`. */
      {
        repo: 'microsoft/mdeberta-v3-base',
        dir: '_dependances/mdeberta-v3-base',
        files: ['config.json', 'spm.model', 'tokenizer_config.json']
      }
    ]
  },
  transcribe: {
    folder: 'faster-whisper-small',
    description: 'Whisper small converted for CTranslate2 (faster-whisper), int8 on the CPU',
    license: 'MIT',
    sources: [{
      repo: 'Systran/faster-whisper-small',
      files: ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']
    }]
  },
  /* Not fetched by default: faster (about 0.35 s per sentence against 1.2 s on a
     laptop CPU) but twice as many wrong words in French. `fetch --models
     transcribe_base`, then point MODELS_TRANSCRIBE_PATH at its folder. */
  transcribe_base: {
    folder: 'faster-whisper-base',
    description: 'Whisper base converted for CTranslate2 (faster-whisper), int8 on the CPU',
    license: 'MIT',
    optional: true,
    sources: [{
      repo: 'Systran/faster-whisper-base',
      files: ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']
    }]
  },
  injection: {
    folder: 'prompt-injection-guard-small',
    description: 'Multilingual prompt-injection and jailbreak classifier (mmBERT-small, 141M), int8 ONNX',
    license: 'Apache-2.0',
    sources: [{
      repo: 'Horizon-Labs/prompt-injection-guard-small',
      files: ['config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json']
    }]
  },
  moderation: {
    folder: 'content-safety-guard-small',
    description: 'Multilingual content-safety classifier with harm categories (mmBERT-small, 141M), int8 ONNX',
    license: 'Apache-2.0',
    sources: [{
      repo: 'Horizon-Labs/content-safety-guard-small',
      files: ['config.json', 'onnx/model_quantized.onnx', 'special_tokens_map.json', 'thresholds.json', 'tokenizer.json', 'tokenizer_config.json']
    }]
  }
};

async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function hashRemote(repo, revision, file) {
  const response = await fetch(`${ENDPOINT}/${repo}/resolve/${revision}/${file}`);
  if (!response.ok) throw new Error(`${repo}/${file}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

async function describeSource(source, pinned) {
  const head = pinned || (await json(`${ENDPOINT}/api/models/${source.repo}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`${source.repo}: no commit hash`);
  const tree = await json(`${ENDPOINT}/api/models/${source.repo}/revision/${head}?blobs=true`);
  const siblings = new Map(tree.siblings.map((entry) => [entry.rfilename, entry]));
  const files = [];
  for (const file of source.files) {
    const entry = siblings.get(file);
    if (!entry) throw new Error(`${source.repo}@${head.slice(0, 8)}: ${file} does not exist`);
    if (entry.lfs && entry.lfs.sha256) {
      files.push({ path: file, size: entry.size, sha256: entry.lfs.sha256 });
    } else {
      const measured = await hashRemote(source.repo, head, file);
      files.push({ path: file, size: measured.size, sha256: measured.sha256 });
    }
  }
  const out = { repo: source.repo, revision: head, files };
  if (source.dir) out.dir = source.dir;
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const pick = args.includes('--models') ? args[args.indexOf('--models') + 1].split(',') : null;
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : MANIFEST;
  const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { models: {} };
  const models = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    if (pick && !pick.includes(name)) {
      if (previous.models[name]) models[name] = previous.models[name];
      continue;
    }
    const sources = [];
    for (const source of spec.sources) {
      /* A repository already pinned keeps its revision, even when it moved to another model name. */
      const old = Object.values(previous.models).flatMap((m) => m.sources).find((s) => s.repo === source.repo);
      sources.push(await describeSource(source, !update && old ? old.revision : null));
    }
    models[name] = { folder: spec.folder, description: spec.description, license: spec.license, ...(spec.optional ? { optional: true } : {}), sources };
    process.stderr.write(`${name}: ${sources.map((s) => `${s.repo}@${s.revision.slice(0, 8)}`).join(', ')}\n`);
  }
  const manifest = { schema: 1, models };
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`written ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
