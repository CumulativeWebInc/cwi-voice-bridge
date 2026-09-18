import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linearToMulaw, mulawToLinear, decodeMulawBuffer, encodeMulawBuffer } from '../src/mulaw.js';

describe('G.711 μ-law', () => {
  it('decodes 0xFF to ~0 (the well-known idle code)', () => {
    assert.equal(mulawToLinear(0xff), 0);
  });

  it('round-trips PCM through μ-law within companding tolerance', () => {
    const pcm = new Int16Array(1000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(30000 * Math.sin(i * 0.11));
    const back = decodeMulawBuffer(encodeMulawBuffer(pcm));
    let maxErr = 0;
    for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs(pcm[i] - back[i]));
    // μ-law is lossy; error must stay within a companding step (~±600 at full scale).
    assert.ok(maxErr < 700, `maxErr=${maxErr}`);
  });

  it('is antisymmetric: encode(-x) flips only the sign bit', () => {
    const p = linearToMulaw(1000);
    const n = linearToMulaw(-1000);
    assert.equal(p ^ n, 0x80);
  });

  it('clips without wrapping at full scale', () => {
    const hi = decodeMulawBuffer(encodeMulawBuffer(new Int16Array([32767])));
    // G.711 μ-law max decoded magnitude is 32124 by construction.
    assert.ok(hi[0] > 30000 && hi[0] <= 32124, `hi=${hi[0]}`);
  });
});
