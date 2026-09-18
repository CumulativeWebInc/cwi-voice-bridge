// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cumulative Web Inc.
/**
 * G.711 μ-law encode/decode.
 *
 * Twilio Media Streams (and classic telephony) ships 8 kHz μ-law PCM.
 * cwi-voice-bridge works internally at 16 kHz linear PCM; the Twilio
 * adapter (twilio-adapter.js) uses this module at the boundary.
 *
 * Reference: ITU-T G.711, μ-law companding.
 */

const BIAS = 0x84;
const CLIP = 32635;

// Segment endpoints for the 16-bit magnitude (standard G.711 table).
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function findSegment(val) {
  for (let i = 0; i < SEG_END.length; i++) {
    if (val <= SEG_END[i]) return i;
  }
  return 7;
}

/** Linear 16-bit PCM sample -> μ-law byte. */
export function linearToMulaw(sample) {
  let s = sample;
  let sign;
  if (s < 0) {
    s = -s;
    sign = 0x80;
  } else {
    sign = 0x00;
  }
  if (s > CLIP) s = CLIP;
  s += BIAS;
  const exponent = findSegment(s);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/** μ-law byte -> linear 16-bit PCM sample. Max magnitude is 32124 (per G.711). */
export function mulawToLinear(ulaw) {
  const u = (~ulaw) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

/** Decode a Buffer/Uint8Array of μ-law bytes -> Int16Array linear PCM. */
export function decodeMulawBuffer(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

/** Encode Int16Array linear PCM -> Buffer of μ-law bytes. */
export function encodeMulawBuffer(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}
