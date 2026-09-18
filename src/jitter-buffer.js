// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cumulative Web Inc.
/**
 * AdaptiveJitterBuffer — NetEQ-inspired playout buffer for real-time voice.
 *
 * Design-masters lineage (credited as studied, not endorsed):
 *  - WebRTC NetEQ: delay manager with exponential-forgetting histograms
 *    (underrun + reorder), a ~2 s history window separating temporary jitter
 *    from permanent delay change, and time-stretch accelerate/decelerate to
 *    absorb drift without audible glitches.
 *  - LiveKit: first-class, min/max-bounded playout delay as an operator knob.
 *  - Twilio Media Streams guidance: the playout clock must follow the audio
 *    clock, never the network clock (see README "The Twilio playout-buffer
 *    pitfall").
 *
 * This is a deliberately simplified reference implementation: linear
 * resampling for time-stretch (NetEQ uses WSOLA with pitch detection —
 * roadmap), energy-gated VAD (no neural VAD — roadmap), no codec (raw PCM).
 *
 * Units: samples are 16 kHz mono linear PCM unless stated otherwise.
 */

const NOMINAL_RATE_PER_MS = 16; // 16 samples per ms at 16 kHz

export class AdaptiveJitterBuffer {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=16000]
   * @param {number} [opts.frameMs=20]            playout quantum
   * @param {number} [opts.minDelayMs=40]         LiveKit-style lower bound
   * @param {number} [opts.maxDelayMs=400]        LiveKit-style upper bound
   * @param {number} [opts.quantile=0.95]         target-delay quantile
   * @param {number} [opts.forgetFactor=0.995]    per-packet exponential decay
   * @param {number} [opts.historyWindowMs=2000]  NetEQ's 2 s window
   * @param {number} [opts.stretchRate=0.10]      ±10% time-stretch authority
   * @param {number} [opts.drainGuardRatio=1.5]   playout-rate anomaly threshold
   * @param {number} [opts.drainGuardWindowMs=500] anomaly confirmation window
   */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    this.frameMs = opts.frameMs ?? 20;
    this.frameSamples = Math.round((this.sampleRate * this.frameMs) / 1000);
    this.minDelayMs = opts.minDelayMs ?? 40;
    this.maxDelayMs = opts.maxDelayMs ?? 400;
    this.quantile = opts.quantile ?? 0.95;
    this.forgetFactor = opts.forgetFactor ?? 0.995;
    this.historyWindowMs = opts.historyWindowMs ?? 2000;
    this.stretchRate = opts.stretchRate ?? 0.1;
    this.drainGuardRatio = opts.drainGuardRatio ?? 1.5;
    this.drainGuardWindowMs = opts.drainGuardWindowMs ?? 500;

    // Delay-manager histogram: buckets of 10 ms, exponential forgetting.
    this.bucketMs = 10;
    this.bucketCount = Math.ceil(this.maxDelayMs / this.bucketMs) + 1;
    this.histogram = new Float64Array(this.bucketCount);
    this.delaySamples = []; // { relDelayMs, atMs } — bounded history window
    this.baseArrivalMs = null;
    this.baseTs = null;

    // Playout state
    this.queue = []; // array of Int16Array chunks (each frameSamples)
    this.bufferedSamples = 0;
    this.targetDelayMs = this.minDelayMs;
    this.lastFrame = new Int16Array(this.frameSamples); // for concealment
    this.underflows = 0;
    this.overflows = 0;
    this.stretches = 0; // time-stretch operations applied
    this.drainAnomalies = 0;

    // Playout-rate monitor (the Twilio pitfall detector)
    this.outSamplesTotal = 0;
    this.rateWindowStartMs = null;
    this.rateWindowSamples = 0;
    this.anomalyActive = false;
    this.paceGuard = false; // when true, playout refuses >1x realtime pulls
    this.lastPlayoutMs = null;

    // Latency samples (send-time -> playout-time), for p50/p95.
    this.latencySamples = [];
    this.sendTimes = new Map(); // seq -> sendMs

    this.listeners = {};
    this.started = false;
  }

  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  emit(event, data) {
    for (const cb of this.listeners[event] ?? []) cb(data);
  }

  /**
   * Ingest one frame of network audio.
   * @param {Int16Array} samples  frameSamples of 16 kHz PCM
   * @param {number} seq          monotonically increasing sequence number
   * @param {number} [sendMs]     sender timestamp (for latency measurement)
   * @param {number} [arrivalMs]   arrival time (defaults to Date.now())
   */
  push(samples, seq, sendMs = null, arrivalMs = null) {
    const now = arrivalMs ?? Date.now();
    if (sendMs != null) this.sendTimes.set(seq, sendMs);

    // Relative delay vs the fastest observed packet: NetEQ's core signal.
    // relDelay = (arrival - arrival0) - (mediaTime - mediaTime0).
    // With fixed-size frames, media time advances seq * frameMs.
    // The base ratchets to the fastest frame seen: if a frame beats the
    // base, the base moves (otherwise an unlucky first packet would
    // permanently underestimate jitter and starve playout).
    if (this.baseArrivalMs == null) {
      this.baseArrivalMs = now;
      this.baseSeq = seq;
    }
    const mediaElapsedMs = (seq - this.baseSeq) * this.frameMs;
    const arrivalElapsedMs = now - this.baseArrivalMs;
    let relDelayMs = arrivalElapsedMs - mediaElapsedMs;
    if (relDelayMs < 0) {
      this.baseArrivalMs = now - mediaElapsedMs;
      relDelayMs = 0;
    }

    // Forget old history (2 s window: jitter vs permanent shift classifier).
    const cutoff = now - this.historyWindowMs;
    while (this.delaySamples.length && this.delaySamples[0].atMs < cutoff) {
      this.delaySamples.shift();
    }
    this.delaySamples.push({ relDelayMs, atMs: now });

    // Exponential-forgetting histogram update.
    for (let i = 0; i < this.bucketCount; i++) this.histogram[i] *= this.forgetFactor;
    const bucket = Math.min(this.bucketCount - 1, Math.floor(relDelayMs / this.bucketMs));
    this.histogram[bucket] += 1;

    this._recomputeTargetDelay();

    // Queue the audio (drop duplicates / ancient frames).
    if (samples.length !== this.frameSamples) {
      throw new Error(`push: expected ${this.frameSamples} samples, got ${samples.length}`);
    }
    this.queue.push(samples);
    this.bufferedSamples += samples.length;

    // Overflow: buffer beyond target + one max burst -> drop oldest frame.
    const bufferedMs = (this.bufferedSamples / this.sampleRate) * 1000;
    const ceilingMs = this.targetDelayMs + this.maxDelayMs;
    if (bufferedMs > ceilingMs) {
      const dropped = this.queue.shift();
      this.bufferedSamples -= dropped.length;
      this.overflows++;
      this.emit('overflow', { bufferedMs, ceilingMs });
    }
    if (!this.started && bufferedMs >= this.targetDelayMs) this.started = true;
  }

  _recomputeTargetDelay() {
    let total = 0;
    for (const v of this.histogram) total += v;
    if (total <= 0) {
      this.targetDelayMs = this.minDelayMs;
      return;
    }
    const threshold = total * this.quantile;
    let acc = 0;
    let levelMs = this.minDelayMs;
    for (let i = 0; i < this.bucketCount; i++) {
      acc += this.histogram[i];
      if (acc >= threshold) {
        levelMs = (i + 1) * this.bucketMs;
        break;
      }
    }
    // LiveKit-style clamp: operator bounds always win.
    this.targetDelayMs = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, levelMs));
  }

  /** Simple energy VAD: voiced if RMS above threshold. */
  _isVoiced(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length) / 32768;
    return rms > 0.02;
  }

  /** Linear-resample time-stretch by `rate` (+ = slow down, - = speed up). */
  _stretch(frame, rate) {
    const srcLen = frame.length;
    const dstLen = Math.round(srcLen / (1 + rate));
    const out = new Int16Array(this.frameSamples);
    // Resample then pad/trim to exactly one frame.
    for (let i = 0; i < this.frameSamples; i++) {
      const pos = (i / this.frameSamples) * dstLen;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = frame[Math.min(srcLen - 1, i0)];
      const b = frame[Math.min(srcLen - 1, i0 + 1)];
      out[i] = Math.round(a + (b - a) * frac);
    }
    return out;
  }

  _conceal() {
    // Underflow concealment: repeat last frame with 0.8 decay (avoids the
    // harsh click of pure silence while clearly marking a gap).
    const out = new Int16Array(this.frameSamples);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(this.lastFrame[i] * 0.8);
    this.underflows++;
    this.emit('underflow', { count: this.underflows });
    return { samples: out, concealed: true, stretched: false };
  }

  /**
   * Pull one playout frame. Call every frameMs in realtime.
   * Returns null when the pace guard is holding back an over-eager consumer
   * (the drain-anomaly backpressure signal) — the caller must NOT treat null
   * as silence to fast-forward; it must wait for the next tick.
   */
  getFrame(nowMs = Date.now()) {
    // --- Playout-drain guard (the Twilio pitfall detector) ---
    if (this.lastPlayoutMs != null) {
      const dt = nowMs - this.lastPlayoutMs;
      if (dt > 0) {
        if (this.rateWindowStartMs == null) {
          this.rateWindowStartMs = nowMs;
          this.rateWindowSamples = 0;
        }
        this.rateWindowSamples += this.frameSamples;
        const winMs = nowMs - this.rateWindowStartMs;
        if (winMs >= this.drainGuardWindowMs) {
          const nominal = (this.sampleRate / 1000) * winMs;
          const ratio = this.rateWindowSamples / nominal;
          if (ratio > this.drainGuardRatio && !this.anomalyActive) {
            this.anomalyActive = true;
            this.paceGuard = true;
            this.drainAnomalies++;
            this.emit('drain-anomaly', {
              measuredRatio: ratio,
              windowMs: winMs,
              message:
                `Playout draining at ${ratio.toFixed(2)}x realtime — ` +
                `classic playout-buffer clock mismatch (cf. Twilio 4-5x signature). ` +
                `Pace guard engaged: releases throttled to 1x realtime.`,
            });
          } else if (ratio <= 1.1 && this.anomalyActive) {
            this.anomalyActive = false;
            this.paceGuard = false;
            this.emit('drain-recovered', { measuredRatio: ratio });
          }
          this.rateWindowStartMs = nowMs;
          this.rateWindowSamples = 0;
        }
      }
    }
    this.lastPlayoutMs = nowMs;

    if (this.paceGuard) {
      // Refuse to feed an over-eager consumer: hold the audio, don't destroy it.
      return null;
    }

    if (!this.queue.length) return this._conceal();

    const bufferedMs = (this.bufferedSamples / this.sampleRate) * 1000;
    let frame = this.queue[0];
    let stretched = false;

    if (bufferedMs < this.targetDelayMs - this.frameMs) {
      // Running dry: decelerate (stretch) voiced audio to buy time.
      if (this._isVoiced(frame)) {
        frame = this._stretch(frame, this.stretchRate);
        stretched = true;
        this.stretches++;
      }
      // Consume the frame normally after stretching.
      this.queue.shift();
      this.bufferedSamples -= this.frameSamples;
    } else if (bufferedMs > this.targetDelayMs + this.frameMs) {
      // Running hot: accelerate voiced audio; drop a silence frame outright.
      if (this._isVoiced(frame)) {
        frame = this._stretch(frame, -this.stretchRate);
        stretched = true;
        this.stretches++;
        this.queue.shift();
        this.bufferedSamples -= this.frameSamples;
      } else {
        // Silence frame while running hot: drop it outright — inaudible
        // latency reduction — then take the next frame for playout.
        this.queue.shift();
        this.bufferedSamples -= this.frameSamples;
        if (this.queue.length) {
          frame = this.queue.shift();
          this.bufferedSamples -= this.frameSamples;
        } else {
          frame = new Int16Array(this.frameSamples); // deliberate silence, not an underflow
        }
      }
    } else {
      this.queue.shift();
      this.bufferedSamples -= this.frameSamples;
    }

    this.lastFrame = frame.slice();
    this.outSamplesTotal += frame.length;
    return { samples: frame, concealed: false, stretched };
  }

  /** RFC 3550-style jitter estimate (ms) over inter-arrival deltas. */
  jitterEstimateMs() {
    if (this.delaySamples.length < 2) return 0;
    let j = 0;
    for (let i = 1; i < this.delaySamples.length; i++) {
      const d = Math.abs(this.delaySamples[i].relDelayMs - this.delaySamples[i - 1].relDelayMs);
      j += (d - j) / 16;
    }
    return j;
  }

  recordLatency(seq, playoutMs) {
    const sendMs = this.sendTimes.get(seq);
    if (sendMs == null) return;
    this.latencySamples.push(playoutMs - sendMs);
    this.sendTimes.delete(seq);
    if (this.latencySamples.length > 10000) this.latencySamples.shift();
  }

  latencyPercentiles() {
    const s = [...this.latencySamples].sort((a, b) => a - b);
    if (!s.length) return { p50: null, p95: null, n: 0 };
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { p50: q(0.5), p95: q(0.95), n: s.length };
  }

  stats() {
    return {
      targetDelayMs: Math.round(this.targetDelayMs * 10) / 10,
      bufferedMs: Math.round(((this.bufferedSamples / this.sampleRate) * 1000) * 10) / 10,
      jitterEstimateMs: Math.round(this.jitterEstimateMs() * 10) / 10,
      underflows: this.underflows,
      overflows: this.overflows,
      stretches: this.stretches,
      drainAnomalies: this.drainAnomalies,
      paceGuard: this.paceGuard,
      latency: this.latencyPercentiles(),
    };
  }
}
