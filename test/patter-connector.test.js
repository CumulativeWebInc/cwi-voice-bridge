import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PatterTwilioBridge } from '../src/patter-connector.js';
import { encodeMulawBuffer } from '../src/mulaw.js';

const FS = 320;

function fakeSocket() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    on: (ev, cb) => {
      (handlers[ev] ??= []).push(cb);
    },
    emitMsg: (obj) => handlers.message.forEach((cb) => cb(JSON.stringify(obj))),
    send: function (msg) {
      this.sent.push(msg);
    },
    close: () => {},
  };
}

function twilioMediaPayload() {
  // 20 ms of μ-law @ 8 kHz: 160 bytes of a 440 Hz tone.
  const pcm8 = new Int16Array(160);
  for (let i = 0; i < 160; i++) pcm8[i] = Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / 8000));
  return encodeMulawBuffer(pcm8).toString('base64');
}

function attachStartedBridge(opts) {
  const sock = fakeSocket();
  const b = new PatterTwilioBridge(opts);
  b.attach(sock);
  sock.emitMsg({ event: 'connected', protocol: 'websocket', version: '1.0' });
  sock.emitMsg({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ-test-stream',
    start: {
      streamSid: 'MZ-test-stream',
      accountSid: 'AC-test',
      callSid: 'CA-test',
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
  return { sock, b };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('PatterTwilioBridge (Twilio Media Streams protocol)', () => {
  it('handles connected/start and decodes inbound μ-law to 16 kHz PCM frames', async () => {
    const { sock, b } = attachStartedBridge();
    try {
      const got = [];
      b.onAudio((pcm) => got.push(pcm));
      assert.equal(b.streamSid, 'MZ-test-stream');
      assert.equal(b.callSid, 'CA-test');
      // Two 20 ms μ-law chunks (160 samples @ 8 kHz each) -> two 320-sample
      // 16 kHz frames after x2 upsampling.
      for (let i = 0; i < 2; i++) {
        sock.emitMsg({
          event: 'media',
          sequenceNumber: String(i + 2),
          streamSid: 'MZ-test-stream',
          media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload: twilioMediaPayload() },
        });
      }
      await sleep(60); // let the 20 ms playout loop tick
      assert.ok(got.length >= 1, `expected audio-in frames, got ${got.length}`);
      assert.equal(got[0].length, FS);
      assert.equal(b.inboundFrames, 2);
    } finally {
      await b.close();
    }
  });

  it('paces outbound bursts to exactly 1x realtime on the wire', async () => {
    const { sock, b } = attachStartedBridge();
    // Burst 3 s of audio instantly — the TTS-burst scenario.
    const tone = new Int16Array(FS);
    for (let i = 0; i < FS; i++) tone[i] = Math.round(9000 * Math.sin((i * 2 * Math.PI * 440) / 16000));
    for (let i = 0; i < 150; i++) await b.sendAudio(tone);
    const t0 = Date.now();
    const n0 = sock.sent.length;
    await sleep(500);
    const rate = (sock.sent.length - n0) / ((Date.now() - t0) / 1000);
    // Nominal: 50 frames/s. Producer burst must NOT reach the wire faster.
    assert.ok(rate >= 40 && rate <= 60, `wire rate=${rate.toFixed(1)} frames/s, want ~50`);
    await b.close();
  });

  it('emits Twilio-shaped media messages with 160-byte μ-law payloads', async () => {
    const { sock, b } = attachStartedBridge();
    const tone = new Int16Array(FS).fill(5000);
    await b.sendAudio(tone);
    await sleep(60);
    assert.ok(sock.sent.length >= 1);
    const msg = JSON.parse(sock.sent[0]);
    assert.equal(msg.event, 'media');
    assert.equal(msg.streamSid, 'MZ-test-stream');
    assert.equal(Buffer.from(msg.media.payload, 'base64').length, 160);
    await b.close();
  });

  it('sendMark / sendClear use the documented Twilio message shapes', async () => {
    const { sock, b } = attachStartedBridge();
    b.sendMark('tts-done');
    b.sendClear();
    const mark = JSON.parse(sock.sent.find((m) => JSON.parse(m).event === 'mark'));
    const clear = JSON.parse(sock.sent.find((m) => JSON.parse(m).event === 'clear'));
    assert.equal(mark.mark.name, 'tts-done');
    assert.equal(clear.streamSid, 'MZ-test-stream');
    await b.close();
  });

  it('setTelephonyCarrier("telnyx") switches the wire to PCM 16 kHz', async () => {
    const b = new PatterTwilioBridge();
    b.setTelephonyCarrier('telnyx');
    assert.equal(b.wireEncoding, 'pcm16');
    assert.equal(b.wireSampleRate, 16000);
    assert.throws(() => b.setTelephonyCarrier('nope'), /unknown carrier/);
    // Wire proof: telnyx media payload must be 640 bytes (320 samples x 2),
    // never the 160-byte μ-law frame.
    const sent = [];
    const sock = fakeSocket();
    const origSend = sock.send.bind(sock);
    sock.send = (m) => { sent.push(m); origSend(m); };
    b.attach(sock);
    const tone = new Int16Array(FS).fill(1000);
    await b.sendAudio(tone);
    await sleep(40); // let the 20 ms pacer emit one frame
    assert.ok(sent.length >= 1, 'expected a paced telnyx frame on the wire');
    const payload = Buffer.from(JSON.parse(sent[0]).media.payload, 'base64');
    assert.equal(payload.length, 640, `telnyx payload bytes=${payload.length}`);
    // Round-trip: payload decodes back to the original 16 kHz PCM.
    const back = new Int16Array(320);
    for (let i = 0; i < 320; i++) back[i] = payload.readInt16LE(i * 2);
    assert.ok(back.every((v) => v === 1000), 'telnyx path must be bit-transparent');
    await b.close();
  });

  it('applies backpressure instead of unbounded queue growth', async () => {
    const { sock, b } = attachStartedBridge({ maxOutQueueFrames: 5 });
    let bp = 0;
    b.onEvent((name) => {
      if (name === 'backpressure') bp++;
    });
    const tone = new Int16Array(FS).fill(1000);
    for (let i = 0; i < 50; i++) await b.sendAudio(tone);
    assert.ok(b.droppedOutbound > 0, 'oldest frames should be dropped under cap');
    assert.ok(bp > 0, 'backpressure event should fire');
    await b.close();
  });

  it('sendClear() drains the local queue — cancelled utterance never plays', async () => {
    const { sock, b } = attachStartedBridge();
    const tone = new Int16Array(FS).fill(1000);
    await b.sendAudio(tone);
    await b.sendAudio(tone);
    await b.sendAudio(tone);
    assert.equal(b.outQueue.length, 3, 'three frames queued before clear');
    const cancelled = [];
    b.onEvent((name, data) => {
      if (name === 'utterance-cancelled') cancelled.push(data);
    });
    b.sendClear();
    assert.equal(b.outQueue.length, 0, 'local queue drained by sendClear');
    assert.equal(b.utteranceGeneration, 1, 'generation bumped');
    assert.equal(cancelled.length, 1, 'utterance-cancelled event fired');
    assert.equal(cancelled[0].droppedFrames, 3);
    // Let the 20 ms pacer run: nothing but the 'clear' wire event may leave.
    await sleep(60);
    const media = sock.sent.filter((m) => JSON.parse(m).event === 'media');
    assert.equal(media.length, 0, 'no media frames from the cancelled utterance');
    const clear = sock.sent.find((m) => JSON.parse(m).event === 'clear');
    assert.ok(clear, 'carrier clear event still sent');
    const m = b.getMetrics();
    assert.equal(m.staleUtteranceFrames, 3);
    assert.equal(m.utteranceGeneration, 1);
    await b.close();
  });

  it('pacer rejects late chunks tagged with a stale generation', async () => {
    const { sock, b } = attachStartedBridge();
    const tone = new Int16Array(FS).fill(1000);
    await b.sendAudio(tone); // gen 0
    // Simulate a late chunk racing past sendClear(): it carries gen 0.
    b._utteranceGen = 1;
    await sleep(60); // pacer runs on gen 0 queue, then generation moves
    const mediaBefore = sock.sent.filter((m) => JSON.parse(m).event === 'media').length;
    // Now a truly stale frame sneaks into the queue after the boundary.
    b.outQueue.push({ gen: 0, frame: Buffer.alloc(160) });
    await sleep(60);
    const mediaAfter = sock.sent.filter((m) => JSON.parse(m).event === 'media').length;
    assert.equal(mediaAfter, mediaBefore, 'stale-generation frame never reaches the wire');
    assert.ok(b.droppedStaleFrames > 0, 'stale frame counted');
    await b.close();
  });

  it('audio queued after sendClear() plays under the new generation', async () => {
    const { sock, b } = attachStartedBridge();
    const tone = new Int16Array(FS).fill(1000);
    await b.sendAudio(tone);
    b.sendClear();
    assert.equal(b.utteranceGeneration, 1);
    await b.sendAudio(tone); // new utterance, gen 1
    await sleep(60);
    const media = sock.sent.filter((m) => JSON.parse(m).event === 'media');
    assert.ok(media.length >= 1, 'post-clear utterance plays normally');
    assert.equal(b.droppedStaleFrames, 1, 'only the pre-clear frame was stale-dropped');
    await b.close();
  });

  it('getMetrics returns the patter-style per-call snapshot', async () => {
    const { sock, b } = attachStartedBridge();
    sock.emitMsg({
      event: 'media',
      sequenceNumber: '2',
      streamSid: 'MZ-test-stream',
      media: { track: 'inbound', chunk: '1', timestamp: '0', payload: twilioMediaPayload() },
    });
    await sleep(60);
    const m = b.getMetrics();
    assert.equal(m.streamSid, 'MZ-test-stream');
    assert.equal(m.callSid, 'CA-test');
    assert.equal(m.carrier, 'twilio');
    assert.equal(m.wireEncoding, 'mulaw');
    assert.ok(typeof m.jitterMs === 'number');
    assert.ok(typeof m.playoutDelayMs === 'number');
    assert.ok(typeof m.latencyP50Ms === 'number' || m.latencyP50Ms === null);
    await b.close();
  });

  it('stop message shuts the session down cleanly', async () => {
    const { sock, b } = attachStartedBridge();
    let closed = false;
    b.onEvent((name) => {
      if (name === 'close') closed = true;
    });
    sock.emitMsg({ event: 'stop', sequenceNumber: '99', streamSid: 'MZ-test-stream', stop: { accountSid: 'AC-test', callSid: 'CA-test' } });
    await sleep(20);
    assert.equal(closed, true);
    assert.equal(b.closed, true);
  });
});
