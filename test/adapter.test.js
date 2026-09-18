import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { WebSocketVoiceAdapter } from '../src/voice-adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('WebSocketVoiceAdapter', () => {
  it('round-trips PCM16 frames over a real localhost WebSocket', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const port = wss.address().port;

    const serverGot = [];
    wss.on('connection', (ws) => {
      const server = new WebSocketVoiceAdapter({ socket: ws });
      server.onAudio((pcm) => serverGot.push(pcm));
      server.connect();
    });

    const client = new WebSocketVoiceAdapter({ url: `ws://127.0.0.1:${port}` });
    await client.connect();

    const frame = new Int16Array(320);
    for (let i = 0; i < 320; i++) frame[i] = i;
    await client.sendAudio(frame);
    await sleep(150);
    assert.equal(serverGot.length, 1);
    assert.deepEqual(Array.from(serverGot[0].slice(0, 5)), [0, 1, 2, 3, 4]);

    // Interface conformance: abstract methods throw when unimplemented.
    const { VoiceAdapter } = await import('../src/voice-adapter.js');
    const base = new VoiceAdapter();
    await assert.rejects(base.connect(), /not implemented/);
    await client.close();
    wss.close();
  });

  it('requires url or socket', () => {
    assert.throws(() => new WebSocketVoiceAdapter({}), /needs opts.url or opts.socket/);
  });
});
