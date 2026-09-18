#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cumulative Web Inc.
/**
 * cwi-voice-bridge loopback demo (mic-less, one command).
 *
 * Simulates a full voice path with reproducible network conditions:
 *   tone generator (440 Hz, the WebRTC test-stub pattern)
 *     -> jitter injector (deterministic RNG, configurable)
 *     -> AdaptiveJitterBuffer
 *     -> playout at 1x realtime
 *
 * Phase 1 is a live-stream simulation on a virtual clock: frames are pushed
 * with network delays and played out concurrently at exactly 1x realtime.
 * Measured p50/p95 send->playout latency is printed.
 *
 * Phase 2 replays Francesco's failure: the consumer drains the buffer at
 * 4x realtime (the Twilio playout-buffer signature). The drain guard must
 * detect it, engage the pace guard, and recover — all printed live.
 *
 * Phase 3 exercises the PatterTwilioBridge outbound pacer: bursts of TTS
 * audio are fed as fast as possible; the wire must still see exactly
 * 1x realtime.
 *
 * Usage: node demo/loopback.js [--seed N] [--jitter-ms N] [--drain-x N]
 *
 * Every number printed is measured in the run, not asserted.
 */

import { AdaptiveJitterBuffer } from '../src/jitter-buffer.js';
import { PatterTwilioBridge } from '../src/patter-connector.js';

// Deterministic RNG (mulberry32) — same seed, same numbers, every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs() {
  const args = { seed: 42, jitterMs: 60, drainX: 4 };
  for (let i = 2; i < process.argv.length; i++) {
    const [k, v] = process.argv[i].replace(/^--/, '').split('=');
    if (k === 'seed') args.seed = Number(v);
    if (k === 'jitter-ms') args.jitterMs = Number(v);
    if (k === 'drain-x') args.drainX = Number(v);
  }
  return args;
}

function toneFrame(frameSamples, phase) {
  const frame = new Int16Array(frameSamples);
  for (let i = 0; i < frameSamples; i++) {
    frame[i] = Math.round(12000 * Math.sin(phase + (i * 2 * Math.PI * 440) / 16000));
  }
  return { frame, phase: phase + (frameSamples * 2 * Math.PI * 440) / 16000 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { seed, jitterMs, drainX } = parseArgs();
  const FS = 320; // 20 ms @ 16 kHz

  console.log('=== cwi-voice-bridge loopback demo ===');
  console.log(`seed=${seed} jitterMs=${jitterMs} drainX=${drainX}\n`);

  // ---- Phase 1: live-stream jitter absorption, virtual clock -------------
  console.log('--- Phase 1: live stream, 6 s audio, injected jitter (virtual clock) ---');
  const rand = mulberry32(seed);
  const jb = new AdaptiveJitterBuffer({ minDelayMs: 40, maxDelayMs: 400 });
  const N = 300; // 6 s of 20 ms frames
  const arrivals = []; // { seq, sendMs, arrivalMs, frame }
  let phase = 0;
  for (let seq = 0; seq < N; seq++) {
    const { frame, phase: p2 } = toneFrame(FS, phase);
    phase = p2;
    const sendMs = seq * 20;
    arrivals.push({ seq, sendMs, arrivalMs: sendMs + Math.floor(rand() * jitterMs), frame });
  }
  arrivals.sort((a, b) => a.arrivalMs - b.arrivalMs);
  let ai = 0;
  let played = 0;
  let concealed = 0;
  let playedReal = 0;
  // Virtual playout: one frame per 20 ms tick, 1x realtime exactly.
  // The sender seq is stamped into sample[0] so each played-out frame can be
  // mapped back to its send time exactly, even if the buffer dropped frames.
  // The loop ends when all N frames have played out (no tail past the stream).
  for (let now = 0; playedReal < N && now < N * 20 + 6000; now += 20) {
    while (ai < arrivals.length && arrivals[ai].arrivalMs <= now) {
      const a = arrivals[ai++];
      a.frame[0] = a.seq; // measurement stamp (one sample per frame)
      jb.push(a.frame, a.seq, a.sendMs, a.arrivalMs);
    }
    const f = jb.getFrame(now);
    if (!f) continue; // pace guard (should not engage at 1x)
    played++;
    if (f.concealed) {
      concealed++;
    } else {
      playedReal++;
      jb.recordLatency(f.samples[0], now);
    }
  }
  const s1 = jb.stats();
  const { p50, p95, n } = s1.latency;
  console.log(`frames played     : ${played} (concealed: ${concealed})`);
  console.log(`target delay      : ${s1.targetDelayMs} ms`);
  console.log(`jitter estimate   : ${s1.jitterEstimateMs} ms (injected uniform 0-${jitterMs} ms)`);
  console.log(`underflows        : ${s1.underflows}`);
  console.log(`overflows         : ${s1.overflows}`);
  console.log(`time-stretches    : ${s1.stretches}`);
  console.log(`MEASURED playout latency: p50=${p50} ms  p95=${p95} ms  (n=${n})`);

  // ---- Phase 2: the 4x playout-drain failure -----------------------------
  console.log(`\n--- Phase 2: playout draining at ${drainX}x realtime (the Twilio signature) ---`);
  const jb2 = new AdaptiveJitterBuffer();
  let anomalies = 0;
  let recovered = false;
  let anomalyRatio = 0;
  jb2.on('drain-anomaly', (d) => {
    anomalies++;
    anomalyRatio = d.measuredRatio;
    console.log(`!! DRAIN ANOMALY: ${d.measuredRatio.toFixed(2)}x realtime — pace guard engaged`);
  });
  jb2.on('drain-recovered', (d) => {
    recovered = true;
    console.log(`>> recovered: drain ratio back to ${d.measuredRatio.toFixed(2)}x, pace guard released`);
  });
  for (let seq = 0; seq < 60; seq++) {
    const { frame, phase: p2 } = toneFrame(FS, phase);
    phase = p2;
    jb2.push(frame, seq);
    await sleep(2);
  }
  const drainInterval = 20 / drainX;
  let nulls = 0;
  let pulled = 0;
  const drainStart = Date.now();
  while (Date.now() - drainStart < 1200) {
    const f = jb2.getFrame();
    pulled++;
    if (f === null) nulls++;
    else if (f && !f.concealed) {
      const { frame, phase: p2 } = toneFrame(FS, phase);
      phase = p2;
      jb2.push(frame, 1000 + pulled);
    }
    await sleep(drainInterval);
  }
  const recStart = Date.now();
  while (Date.now() - recStart < 1200) {
    jb2.getFrame();
    await sleep(20);
  }
  console.log(`frames pulled     : ${pulled}`);
  console.log(`pace-guard nulls  : ${nulls} (audio held, not destroyed)`);
  console.log(`anomalies detected: ${anomalies} at ${anomalyRatio.toFixed(2)}x (expected >= 1)`);
  console.log(`recovered         : ${recovered}`);

  // ---- Phase 3: PatterTwilioBridge outbound pacing ----------------------
  console.log('\n--- Phase 3: PatterTwilioBridge outbound pacer (burst in, 1x out) ---');
  const sent = [];
  const fakeSocket = {
    readyState: 1,
    send: (msg) => sent.push({ at: Date.now(), msg }),
    on: () => {},
    close: () => {},
  };
  const bridge = new PatterTwilioBridge({ carrier: 'twilio' });
  bridge.attach(fakeSocket);
  bridge.streamSid = 'demo-stream';
  const burstFrames = 250; // 5 s of TTS audio delivered instantly
  let ph = 0;
  for (let i = 0; i < burstFrames; i++) {
    const { frame, phase: p2 } = toneFrame(FS, ph);
    ph = p2;
    await bridge.sendAudio(frame);
  }
  console.log(`burst queued      : ${burstFrames} frames instantly`);
  const w0 = Date.now();
  const n0 = sent.length;
  await sleep(1000);
  const wireFramesPerSec = (sent.length - n0) / ((Date.now() - w0) / 1000);
  console.log(`wire rate         : ${wireFramesPerSec.toFixed(1)} frames/s (nominal 50.0 = exactly 1x realtime)`);
  console.log(`wire pacing OK    : ${wireFramesPerSec >= 45 && wireFramesPerSec <= 55 ? 'YES' : 'NO'}`);
  const sample = JSON.parse(sent[0].msg);
  const payloadLen = Buffer.from(sample.media.payload, 'base64').length;
  console.log(`wire format       : event=${sample.event} payload=${payloadLen} bytes (expect 160 = 20 ms μ-law @ 8 kHz)`);
  await bridge.close();

  console.log('\n--- Reference points (publicly documented) ---');
  console.log('  WebRTC NetEQ : converges ~60-200 ms target delay under jitter (webrtchacks)');
  console.log('  LiveKit      : playout delay 1.3x max(RTT), min/max bounded (livekit#1838)');
  console.log(`  this run     : p50=${p50} ms p95=${p95} ms @ uniform 0-${jitterMs} ms injected jitter`);
  console.log('\nDone. Every number above was measured in this run, not asserted.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
