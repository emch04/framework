# Guard models: which open models, and why

`@astratra/models` serves two protection models next to the five it already had:

| Endpoint | Model | Licence | Size on disk | Languages |
|---|---|---|---|---|
| `POST /injection` | [Horizon-Labs/prompt-injection-guard-small](https://huggingface.co/Horizon-Labs/prompt-injection-guard-small) | Apache-2.0 | 256 MB (int8 ONNX) + 33 MB tokenizer | trained on 30 languages, French and English evaluated |
| `POST /moderation` | [Horizon-Labs/content-safety-guard-small](https://huggingface.co/Horizon-Labs/content-safety-guard-small) | Apache-2.0 | 256 MB (int8 ONNX) + 33 MB tokenizer | 24 languages, French and English evaluated |

Both are 141M-parameter encoders (mmBERT-small, MIT) that run on the CPU with
`onnxruntime`: no GPU, no torch. Nothing is trained here; the weights are
downloaded by `astratra-models fetch` at the commit and SHA-256 pinned in
`data/models-manifest.json`, and are never part of the npm package.

## What we checked ourselves

Before choosing, both models were downloaded and run through the service with
French and English inputs (the `RealGuardModelsTest` cases in
`server/tests/test_real_models.py`, skipped when the weights are absent):

- injection: classic overrides ("ignore all previous instructions",
  "ignorez toutes les instructions précédentes"), an instruction planted in a
  web page or an e-mail for the assistant, a persona jailbreak, and an
  instruction hidden at the end of a long document all score above 0.99; a
  recipe request, an invoice, a search result, "how do I make git ignore
  whitespace changes" and "ignore my previous e-mail, the meeting moved" score
  below 0.05;
- moderation: threats, harassment, hate, self-harm and explicit sexual content
  are flagged in both languages with the right category; ordinary French
  ("comment tuer un processus", "un match violent") is not flagged. A text that
  asks for an explicit story about a 12-year-old is flagged `sexual_minors`.

## Candidates examined

Licence tags and sizes are those of the Hugging Face API on 9 October 2026.

### Prompt injection and jailbreak

| Candidate | Licence | Size | Languages | Decision |
|---|---|---|---|---|
| **Horizon-Labs/prompt-injection-guard-small** | Apache-2.0 | 268 MB int8 ONNX | multilingual, French and English evaluated | **Chosen.** Trained on indirect injection (documents, tool outputs, e-mails) as well as direct attacks; its own benchmark reports low over-blocking (96% on NotInject). Built-in normalizer for invisible and full-width characters. Small enough for a VPS. |
| Horizon-Labs/prompt-injection-guard-base | Apache-2.0 | 641 MB int8 ONNX | same | Not retained by default: about 1.4 points of macro score better, twice the size. Usable by pointing `MODELS_INJECTION_PATH` at a folder prepared the same way; not in the manifest. |
| protectai/deberta-v3-base-prompt-injection-v2 | Apache-2.0 | 738 MB, no quantized graph | English only | Rejected: no French; high false-alarm rate on benign prompts with trigger words in the publisher benchmark above. |
| meta-llama/Llama-Prompt-Guard-2-86M | Llama 4 community licence, gated (manual approval) | 1.1 GB | multilingual | Rejected: gated download and a custom licence with conditions; a user could not simply run `fetch`. |
| qualifire/prompt-injection-sentinel | "other", gated | 1.6 GB | English | Rejected: non-standard licence, gated, English only. |
| patronus-studio/wolf-defender-prompt-injection | Apache-2.0 | 218 MB to 1.2 GB variants | German and English | Rejected: no French. |
| proventra/mdeberta-v3-base-prompt-injection | MIT | 1.1 GB, fp32 only, no ONNX | multilingual base, no published evaluation | Rejected: no evidence of quality in French, heavy on the CPU. |
| rogue-security/prompt-injection-jailbreak-sentinel-v2 | "other" | not checked | not checked | Rejected: non-standard licence. |
| testsavantai/prompt-injection-defender-base-v0 | none declared | 268 MB | English | Rejected: no licence. |
| vllm-sr/mmbert32k-jailbreak-detector-merged | Apache-2.0 | 1.2 GB | labelled English | Rejected: jailbreak only, large, English. |

### Content moderation (violence, harassment, sexual, sexual involving minors, self-harm, hate)

| Candidate | Licence | Size | Languages | Decision |
|---|---|---|---|---|
| **Horizon-Labs/content-safety-guard-small** | Apache-2.0 | 268 MB int8 ONNX | 24 languages, French in the benchmark | **Chosen.** The only open candidate that returns a score per category with the requested categories (`hate`, `harassment`, `violence`, `sexual`, `sexual_minors`, `self_harm`, plus nine more), multilingual, on the CPU, with per-category thresholds shipped. |
| Horizon-Labs/content-safety-guard-base | Apache-2.0 | 641 MB | same | Same family, 1.2 points of F1 better, twice the size. Not in the manifest. |
| Qwen/Qwen3Guard-Gen-0.6B | Apache-2.0 | 1.5 GB (bf16), no ONNX | many | Rejected: generative model (decodes text, needs torch), no per-category scores. A good second opinion for an operator with spare CPU, but not a drop-in classifier. |
| unitary/multilingual-toxic-xlm-roberta | Apache-2.0 | 1.1 GB, pickle `.bin` | 7 languages | Rejected: toxicity labels only (no self-harm, no sexual-minors), pickle weights. |
| textdetox/bert-multilingual-toxicity-classifier, distilbert-multilingual-toxicity-classifier | OpenRAIL++ | not checked | multilingual | Rejected: binary toxicity, and a behavioural-use licence with downstream conditions. |
| Horizon-Labs/multilingual-toxicity-small | Apache-2.0 | 268 MB | multilingual | Rejected: toxicity only, no categories. |
| KoalaAI/Text-Moderation | OpenRAIL | not checked | English | Rejected: English only, behavioural-use licence. |
| nvidia Aegis / Nemotron Content Safety, meta Llama Guard, google ShieldGemma | NVIDIA, Llama, Gemma licences | 2 to 8 GB | various | Rejected: custom licences and several gigabytes on the CPU. |

## Limits you must know

- **`sexual_minors` is weak** (F1 0.39 on the publisher's test set; our own
  smoke test saw a score of 0.41 against a 0.25 threshold on a clear case).
  Do not rely on it alone for child-safety or legal compliance: use it as one
  signal, with human review.
- Categories `violence` and `harassment` are moderate (F1 0.56 and 0.52). The
  model over-blocks about a fifth of "safe but scary" prompts in the XSTest
  benchmark: tune `MODELS_MODERATION_THRESHOLDS` on your own traffic.
- Category scores only mean something for a text flagged as a whole
  (`unsafe` over its threshold); the service follows that rule and reports no
  category otherwise.
- The injection model reads a text in isolation: it cannot know whether an
  instruction is legitimate in context. Its published recall on one indirect
  benchmark (BIPIA) is 0.53 at the default threshold. A guard lowers the
  threshold before an action and forbids the action without a human anyway.
- The publisher is recent and its models have few downloads. The mitigation is
  the pin: a commit hash and a SHA-256 per file, checked at download and at
  startup, so a later change of the repository changes nothing for you.
  Review `data/models-manifest.json` before moving a pin.

## Licences and credits

Nothing is redistributed: the weights are downloaded by the user from
Hugging Face, under their own licence. The licences allow commercial use.
Credits required or customary are in [data/MODELS-NOTICE](../data/MODELS-NOTICE).
