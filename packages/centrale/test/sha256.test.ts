import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, tailleOctets, utf8 } from '../src/sha256.ts';

test('SHA-256 identique à node:crypto, y compris autour des limites de bloc et en UTF-8', () => {
  const textes = ['', 'abc', 'é', '😀 émoji', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'sel:eleve-123'];
  for (const t of textes) {
    assert.equal(sha256Hex(t), createHash('sha256').update(t, 'utf8').digest('hex'), JSON.stringify(t.slice(0, 20)));
  }
});

test('utf8 et tailleOctets correspondent à Buffer', () => {
  for (const t of ['', 'abc', 'éàü', '日本語', '😀x', 'a\u0000b']) {
    assert.deepEqual(Buffer.from(utf8(t)), Buffer.from(t, 'utf8'));
    assert.equal(tailleOctets(t), Buffer.byteLength(t));
  }
});
