'use strict';

/** Lit un WAV PCM 16 bits ou flottant 32 bits ; renvoie des échantillons mono flottants. */
function decodeWav(bytes) {
  const buf = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('INVALID_WAV'), { code: 'INVALID_AUDIO' });
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buf.length;) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw Object.assign(new Error('INVALID_WAV'), { code: 'INVALID_AUDIO' });
  const { tag, channels, sampleRate, bits } = format;
  const supported = (tag === 1 && bits === 16) || (tag === 3 && bits === 32);
  if (!supported || channels < 1) throw Object.assign(new Error('UNSUPPORTED_WAV_FORMAT'), { code: 'INVALID_AUDIO' });
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  if (frames === 0) throw Object.assign(new Error('EMPTY_AUDIO'), { code: 'EMPTY_AUDIO' });
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      const at = (i * channels + c) * bytesPerSample;
      sum += tag === 1 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

/** Rééchantillonnage linéaire : suffisant pour la parole avant un modèle à 16 kHz. */
function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.max(1, Math.round(samples.length * to / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return out;
}

function floatToPcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
  }
  return out;
}

module.exports = { decodeWav, resample, floatToPcm16 };
