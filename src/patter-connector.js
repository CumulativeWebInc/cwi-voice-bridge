// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cumulative Web Inc.
/**
 * PatterTwilioBridge — a patter-customized voice connector.
 *
 * Where it plugs in (patter's real call path, from PatterAI's public docs):
 *
 *   Caller -> Twilio PSTN -> Twilio Media Streams (WSS, JSON, μ-law 8 kHz)
 *       -> [PatterTwilioBridge] -> patter SDK (transcode/VAD/barge-in)
 *       -> engine (OpenAIRealtime2 / ConvAI / Pipeline) -> back out
 *
 * The bridge sits on the Twilio side of patter's server: Twilio connects its
 * Media Stream WebSocket HERE instead of directly to patter, and the bridge
 * hands patter clean, correctly-paced audio. Two jobs:
 *
 *  1. INBOUND (caller -> agent): μ-law decode -> 8 kHz -> 16 kHz upsample ->
 *     AdaptiveJitterBuffer -> steady 20 ms PCM16 frames. Absorbs network
 *     jitter before patter's VAD/barge-in ever sees it.
 *
 *  2. OUTBOUND (agent -> caller): the critical one. TTS/engine audio enters
 *     at whatever rate the producer emits; the bridge paces it onto the wire
 *     at EXACTLY 1x realtime via a 20 ms playout timer. This is the direct
 *     fix for the failure Francesco debugged: audio hitting Twilio's playout
 *     buffer at 4-5x realtime. The producer can burst; the wire never does.
 *
 * Wire protocol: Twilio Media Streams, documented at
 * twilio.com/docs/voice/media-streams/websocket-messages (studied, not copied).
 * Messages handled: connected / start / media / mark / stop (inbound);
 * media / mark / clear (outbound).
 *
 * Assumptions about patter (explicit; see README "Assumptions"):
 *  A1. Patter's Twilio carrier terminates a Media Streams WebSocket; pointing
 *      the Twilio number's stream URL at this bridge and relaying upstream
 *      (or consuming 'audio-in' in a pipeline hook) needs no patter changes
 *      only if patter exposes the raw carrier socket — otherwise the bridge
 *      runs as a sidecar proxy (documented deployment below).
 *  A2. Metrics shape is modeled on patter's MetricsStore/call-log conventions
 *      (per-call metrics incl. latency); field names are our proposal.
 *  A3. Telnyx path = PCM 16 kHz native (per patter docs); Plivo assumed
 *      μ-law 8 kHz like Twilio (verify before production).
 */

import { AdaptiveJitterBuffer } from './jitter-buffer.js';
import { decodeMulawBuffer, encodeMulawBuffer } from './mulaw.js';
import { VoiceAdapter } from './voice-adapter.js';

export const TWILIO_FRAME_BYTES = 160; // 20 ms of μ-law @ 8 kHz
export const FRAME_MS = 20;

function upsample8kTo16k(pcm8) {
  const out = new Int16Array(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    const a = pcm8[i];
    const b = pcm8[Math.min(pcm8.length - 1, i + 1)];
    out[i * 2] = a;
    out[i * 2 + 1] = Math.round((a + b) / 2);
  }
  return out;
}

function downsample16kTo8k(pcm16) {
  const out = new Int16Array(Math.floor(pcm16.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((pcm16[i * 2] + pcm16[i * 2 + 1]) / 2);
  }
  return out;
}

export class PatterTwilioBridge extends VoiceAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.carrier='twilio']  'twilio' | 'telnyx' | 'plivo'
   * @param {object} [opts.bufferOpts]        AdaptiveJitterBuffer options
   * @param {number} [opts.maxOutQueueFrames=250] outbound backpressure cap (5 s)
   */
  constructor(opts = {}) {
    super();
    this.carrier = opts.carrier ?? 'twilio';
    this.maxOutQueueFrames = opts.maxOutQueueFrames ?? 250;
    this.buffer = new AdaptiveJitterBuffer(opts.bufferOpts);
    this.audioHandlers = [];
    this.eventHandlers = [];
    this.metricsHandlers = [];

    this.ws = null; // Twilio-facing socket (set via attach)
    this.streamSid = null;
    this.callSid = null;
    this.startedAtMs = null;
    this.inboundFrames = 0;
    this.outboundFrames = 0;
    this.droppedOutbound = 0;
    this.outQueue = []; // { gen, frame } μ-law frames awaiting paced send
    this._utteranceGen = 0; // cancellation boundary: sendClear() bumps this
    this.droppedStaleFrames = 0; // frames killed by a stale generation
    this._outTimer = null;
    this._playoutTimer = null;
    this._leftover16 = new Int16Array(0);
    this._pendingSeqs = []; // seqs in playout order, for latency bookkeeping
    this.closed = false;

    // Surface buffer intelligence as bridge events.
    for (const ev of ['underflow', 'overflow', 'drain-anomaly', 'drain-recovered']) {
      this.buffer.on(ev, (data) => this._emit(ev, data));
    }
  }

  /**
   * Mirror of patter's own provider API: set_telephony_carrier.
   * 'twilio' -> μ-law 8 kHz wire; 'telnyx' -> PCM 16 kHz native;
   * 'plivo' -> μ-law 8 kHz (assumption A3).
   */
  setTelephonyCarrier(carrier) {
    if (!['twilio', 'telnyx', 'plivo'].includes(carrier)) {
      throw new Error(`PatterTwilioBridge: unknown carrier "${carrier}"`);
    }
    this.carrier = carrier;
    return this;
  }

  get wireSampleRate() {
    return this.carrier === 'telnyx' ? 16000 : 8000;
  }

  get wireEncoding() {
    return this.carrier === 'telnyx' ? 'pcm16' : 'mulaw';
  }

  /**
   * Attach the Twilio-facing WebSocket. In production this is the socket
   * Twilio opens to your stream URL; in tests it's any ws-compatible socket.
   */
  attach(ws) {
    if (this.ws) throw new Error('PatterTwilioBridge: already attached');
    this.ws = ws;
    ws.on('message', (raw) => this._onTwilioMessage(raw));
    ws.on('close', () => this._shutdown());
    ws.on('error', (err) => this._emit('error', { error: String(err) }));
    return this;
  }

  async connect() {
    // The bridge is server-side: Twilio dials in. connect() resolves when
    // attached; the 'start' event (streamSid) arrives with Twilio's message.
    if (!this.ws) throw new Error('PatterTwilioBridge.connect: no socket attached (call attach() first)');
    this._emit('open', { carrier: this.carrier });
  }

  _onTwilioMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this._emit('protocol-error', { raw: String(raw).slice(0, 120) });
      return;
    }
    switch (msg.event) {
      case 'connected':
        this._emit('twilio-connected', { protocol: msg.protocol, version: msg.version });
        break;
      case 'start': {
        const s = msg.start ?? {};
        this.streamSid = s.streamSid ?? msg.streamSid ?? null;
        this.callSid = s.callSid ?? null;
        this.startedAtMs = Date.now();
        this._startPlayoutLoop();
        this._emit('start', { streamSid: this.streamSid, callSid: this.callSid, tracks: s.tracks });
        break;
      }
      case 'media':
        this._onInboundMedia(msg);
        break;
      case 'mark':
        this._emit('mark', { name: msg.mark?.name ?? null });
        break;
      case 'stop':
        this._emit('stop', { streamSid: this.streamSid, callSid: this.callSid });
        this._shutdown();
        break;
      default:
        this._emit('protocol-error', { event: msg.event });
    }
  }

  _onInboundMedia(msg) {
    const payload = msg.media?.payload;
    if (!payload) return;
    const wire = Buffer.from(payload, 'base64');
    let pcm16;
    if (this.wireEncoding === 'mulaw') {
      pcm16 = upsample8kTo16k(decodeMulawBuffer(wire));
    } else {
      // Telnyx PCM16 native: reframe 20 ms (640 bytes) -> 320 samples.
      const n = Math.floor(wire.length / 2);
      pcm16 = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm16[i] = wire.readInt16LE(i * 2);
    }
    // Reframe to the buffer's exact frame size.
    const total = new Int16Array(this._leftover16.length + pcm16.length);
    total.set(this._leftover16, 0);
    total.set(pcm16, this._leftover16.length);
    const FS = this.buffer.frameSamples;
    let off = 0;
    const now = Date.now();
    while (off + FS <= total.length) {
      const frame = total.slice(off, off + FS);
      const seq = this.inboundFrames;
      // sendMs = arrival time: recordLatency() then measures buffer dwell,
      // the buffer's own contribution to end-to-end latency.
      this.buffer.push(frame, seq, now, now);
      this._pendingSeqs.push(seq);
      this.inboundFrames++;
      off += FS;
    }
    this._leftover16 = total.slice(off);
  }

  _startPlayoutLoop() {
    if (this._playoutTimer) return;
    this._playoutTimer = setInterval(() => {
      if (this.closed) return;
      const f = this.buffer.getFrame();
      if (!f) return; // pace guard holding: do NOT emit — consumer waits.
      const seq = this._pendingSeqs[0];
      // Only consume a seq when a real queued frame was played out —
      // concealment replays the last frame without advancing the queue.
      if (!f.concealed && seq !== undefined) {
        this._pendingSeqs.shift();
        this.buffer.recordLatency(seq, Date.now());
      }
      for (const cb of this.audioHandlers) cb(f.samples, { concealed: f.concealed, stretched: f.stretched });
    }, FRAME_MS);
  }

  /**
   * Outbound: queue engine/TTS audio. It is paced onto the wire at exactly
   * 1x realtime by the playout timer — the producer may burst, the wire may
   * not. This is the anti-4x-realtime mechanism.
   */
  async sendAudio(pcm16) {
    if (this.closed) throw new Error('PatterTwilioBridge.sendAudio: closed');
    const FS = this.buffer.frameSamples;
    // Reframe into exact FS-sample chunks, carrying leftovers.
    const buf = this._sendLeftover && this._sendLeftover.length ? concat16(this._sendLeftover, pcm16) : pcm16;
    const chunks = [];
    let off = 0;
    while (off + FS <= buf.length) {
      chunks.push(buf.slice(off, off + FS));
      off += FS;
    }
    this._sendLeftover = buf.slice(off);
    for (const c of chunks) {
      // Twilio/Plivo: μ-law @ 8 kHz. Telnyx: native PCM16 @ 16 kHz
      // (per patter docs — never downsample the Telnyx path).
      const wire =
        this.wireEncoding === 'mulaw'
          ? encodeMulawBuffer(downsample16kTo8k(c))
          : pcm16ToBytes(c);
      // Tag the frame with the current utterance generation so a later
      // sendClear() can kill it even if it arrives after the cancel.
      this.outQueue.push({ gen: this._utteranceGen, frame: wire });
    }
    while (this.outQueue.length > this.maxOutQueueFrames) {
      this.outQueue.shift();
      this.droppedOutbound++;
      this._emit('backpressure', { dropped: this.droppedOutbound });
    }
    this._startOutboundPacer();
  }

  _startOutboundPacer() {
    if (this._outTimer || !this.ws) return;
    // ONE frame per 20 ms tick. No matter how fast the producer feeds
    // sendAudio(), the wire sees exactly 1x realtime. Ever.
    this._outTimer = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) return;
      // Drop stale-generation frames: the utterance they belong to was
      // cancelled by sendClear(). A late TTS chunk can never restart it.
      let entry = this.outQueue.shift();
      while (entry && entry.gen !== this._utteranceGen) {
        this.droppedStaleFrames++;
        entry = this.outQueue.shift();
      }
      if (!entry) return;
      const msg = {
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: entry.frame.toString('base64') },
      };
      this.ws.send(JSON.stringify(msg));
      this.outboundFrames++;
    }, FRAME_MS);
  }

  /** Send a Twilio mark (for barge-in bookkeeping / playback tracking). */
  sendMark(name) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name } }));
    }
  }

  /**
   * Barge-in / utterance cancellation. Clears Twilio's playout buffer AND
   * the bridge's own paced outbound queue, then bumps the utterance
   * generation so any late TTS chunk from the cancelled utterance is
   * rejected by the pacer instead of being queued and played. The bridge
   * owns the cancellation *mechanism*; patter's engine (VAD/policy) owns
   * the *decision* to interrupt.
   */
  sendClear() {
    this._utteranceGen++;
    const drained = this.outQueue.length;
    this.outQueue = [];
    this.droppedStaleFrames += drained;
    this._sendLeftover = new Int16Array(0); // drop the partial chunk too
    this._emit('utterance-cancelled', { generation: this._utteranceGen, droppedFrames: drained });
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
  }

  /** Current utterance generation (cancellation boundary). */
  get utteranceGeneration() {
    return this._utteranceGen;
  }

  onAudio(cb) {
    this.audioHandlers.push(cb);
  }

  onEvent(cb) {
    this.eventHandlers.push(cb);
  }

  onMetrics(cb) {
    this.metricsHandlers.push(cb);
  }

  _emit(name, data) {
    for (const cb of this.eventHandlers) cb(name, data);
  }

  /** Patter MetricsStore-style per-call metrics snapshot (see A2). */
  getMetrics() {
    const s = this.buffer.stats();
    const m = {
      streamSid: this.streamSid,
      callSid: this.callSid,
      carrier: this.carrier,
      wireEncoding: this.wireEncoding,
      uptimeMs: this.startedAtMs ? Date.now() - this.startedAtMs : 0,
      inboundFrames: this.inboundFrames,
      outboundFrames: this.outboundFrames,
      droppedOutboundFrames: this.droppedOutbound,
      staleUtteranceFrames: this.droppedStaleFrames,
      utteranceGeneration: this._utteranceGen,
      outQueueFrames: this.outQueue.length,
      jitterMs: s.jitterEstimateMs,
      playoutDelayMs: s.targetDelayMs,
      bufferedMs: s.bufferedMs,
      underflows: s.underflows,
      overflows: s.overflows,
      stretches: s.stretches,
      drainAnomalies: s.drainAnomalies,
      latencyP50Ms: s.latency.p50,
      latencyP95Ms: s.latency.p95,
    };
    for (const cb of this.metricsHandlers) cb(m);
    return m;
  }

  _shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this._playoutTimer) clearInterval(this._playoutTimer);
    if (this._outTimer) clearInterval(this._outTimer);
    this._emit('close', this.getMetrics());
  }

  async close() {
    this._shutdown();
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* already gone */ }
      this.ws = null;
    }
  }
}

function concat16(a, b) {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function pcm16ToBytes(pcm) {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], i * 2);
  return buf;
}
