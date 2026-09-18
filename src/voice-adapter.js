// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cumulative Web Inc.
/**
 * VoiceAdapter — the generic real-time voice interface.
 *
 * Any voice product (patter, Vapi, Retell, Daily, a raw WebSocket client)
 * implements this surface to plug into cwi-voice-bridge's audio path.
 * Audio is 16 kHz mono linear PCM (Int16Array) unless the implementation
 * documents otherwise.
 *
 * For patter specifically, see patter-connector.js — PatterTwilioBridge,
 * which implements this interface against patter's Twilio carrier path.
 */

export class VoiceAdapter {
  /** Open the transport. Resolves when the first audio can flow. */
  async connect() {
    throw new Error('VoiceAdapter.connect() not implemented');
  }

  /**
   * Send one frame of 16 kHz PCM audio toward the far end.
   * @param {Int16Array} pcm
   */
  async sendAudio(pcm) {
    throw new Error('VoiceAdapter.sendAudio() not implemented');
  }

  /** Register a handler for inbound 16 kHz PCM frames: cb(Int16Array). */
  onAudio(cb) {
    throw new Error('VoiceAdapter.onAudio() not implemented');
  }

  /** Register a handler for adapter events: cb(eventName, data). */
  onEvent(cb) {
    throw new Error('VoiceAdapter.onEvent() not implemented');
  }

  /** Close the transport and release resources. */
  async close() {
    throw new Error('VoiceAdapter.close() not implemented');
  }
}

/**
 * WebSocketVoiceAdapter — VoiceAdapter over a plain WebSocket carrying
 * binary 16 kHz PCM16 frames. Either dials out (url) or wraps an accepted
 * socket (ws) — useful for tests and for bridging to custom servers.
 */
export class WebSocketVoiceAdapter extends VoiceAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.url]      ws:// or wss:// URL to dial (client mode)
   * @param {object} [opts.socket]   an accepted ws WebSocket (server mode)
   * @param {number} [opts.frameSamples=320]  20 ms @ 16 kHz
   */
  constructor(opts = {}) {
    super();
    if (!opts.url && !opts.socket) {
      throw new Error('WebSocketVoiceAdapter needs opts.url or opts.socket');
    }
    this.url = opts.url ?? null;
    this.socket = opts.socket ?? null;
    this.frameSamples = opts.frameSamples ?? 320;
    this.audioHandlers = [];
    this.eventHandlers = [];
    this._leftover = new Int16Array(0);
  }

  async connect() {
    if (!this.socket) {
      const { WebSocket } = await import('ws');
      this.socket = new WebSocket(this.url);
      await new Promise((resolve, reject) => {
        this.socket.once('open', resolve);
        this.socket.once('error', reject);
      });
    }
    this.socket.on('message', (data) => this._onMessage(data));
    this.socket.on('close', () => this._emit('close', {}));
    this.socket.on('error', (err) => this._emit('error', { error: String(err) }));
    this._emit('open', {});
  }

  _onMessage(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Reframe to exact frameSamples; carry leftovers across messages.
    const total = new Int16Array(this._leftover.length + bytes.length / 2);
    total.set(this._leftover, 0);
    for (let i = 0; i < bytes.length / 2; i++) {
      total[this._leftover.length + i] = bytes.readInt16LE(i * 2);
    }
    let offset = 0;
    while (offset + this.frameSamples <= total.length) {
      const frame = total.slice(offset, offset + this.frameSamples);
      offset += this.frameSamples;
      for (const cb of this.audioHandlers) cb(frame);
    }
    this._leftover = total.slice(offset);
  }

  async sendAudio(pcm) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('WebSocketVoiceAdapter.sendAudio: socket not open');
    }
    const buf = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], i * 2);
    this.socket.send(buf);
  }

  onAudio(cb) {
    this.audioHandlers.push(cb);
  }

  onEvent(cb) {
    this.eventHandlers.push(cb);
  }

  _emit(name, data) {
    for (const cb of this.eventHandlers) cb(name, data);
  }

  async close() {
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.close();
    }
  }
}
