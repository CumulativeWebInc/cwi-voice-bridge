# cwi-voice-bridge

**The playout-buffer fix for AI voice agents on telephony.**

`cwi-voice-bridge` is an open-source (Apache-2.0) real-time voice adapter for
AI agents. It gives you three things that are usually glued together badly:

1. **`AdaptiveJitterBuffer`** — a NetEQ-inspired adaptive playout buffer
   (16 kHz PCM, 20 ms frames) with a **playout-drain guard** that detects
   when audio is being consumed faster than realtime and holds it instead
   of destroying it.
2. **`VoiceAdapter` / `WebSocketVoiceAdapter`** — a minimal, carrier-neutral
   interface (`connect` / `sendAudio` / `onAudio` / `onEvent` / `close`)
   for plugging any voice product into the audio path.
3. **`PatterTwilioBridge`** — a [patter](https://github.com/patterai/patter)-customized
   Twilio Media Streams connector: μ-law 8 kHz ↔ PCM 16 kHz, inbound jitter
   buffering, and a **hard 20 ms outbound pacer** so burst-produced TTS can
   never hit Twilio's playout buffer above 1× realtime.

## The problem it solves

A voice-AI engineer (Francesco Roscino, working on patter) publicly
debugged a demo-line latency issue down to this signature: **audio hitting
Twilio's playout buffer at 4–5× realtime** — not the model. When the
producer (TTS/engine) emits audio in bursts and the transport forwards it
as fast as it arrives, the far-end playout buffer drains in a fraction of
realtime: chipmunk audio, then silence, then confused barge-in logic.

This bridge was built as the direct, measurable fix:

- **Outbound:** a 20 ms interval pacer. `sendAudio()` may be called with 5
  seconds of audio at once; the wire still sees exactly one 160-byte μ-law
  frame per 20 ms — 50 frames/s, 1× realtime, always. Bursts queue with
  backpressure (oldest dropped past a 5 s cap, counted and emitted).
- **Inbound:** an adaptive jitter buffer absorbs network jitter *before*
  patter's VAD/barge-in sees it, so the agent's turn-taking logic works on
  a steady 20 ms clock.
- **Detection:** if any consumer ever pulls the playout buffer faster than
  ~1.5× realtime, a drain guard fires a `drain-anomaly` event with the
  measured ratio, engages a pace guard (returns `null` backpressure instead
  of audio — the caller must wait, not fast-forward), and releases when the
  drain returns to ~1×.

## One-command demo

```bash
npm install
npm run demo
```

Mic-less. Deterministic (`--seed 42` default). Three phases:

| Phase | What it does | Measured (seed 42) |
|---|---|---|
| 1. Live stream | 6 s of 440 Hz audio, uniform 0–60 ms injected jitter, virtual-clock playout at exactly 1× | **p50 = 60 ms, p95 = 80 ms** send→playout latency (n=300); target delay converged to 60 ms; 3 underflows; 0 overflows |
| 2. Drain attack | Consumer pulls at 4× realtime (the Twilio signature) | **Anomaly detected at 3.84×**, pace guard held 132 frames (audio preserved, not destroyed), **recovered at 0.98×** |
| 3. Burst pacer | 250 frames (5 s) of TTS fed instantly to `PatterTwilioBridge` | **Wire rate 49.0 frames/s** (nominal 50.0 = exactly 1× realtime); payloads verified 160 bytes μ-law |

Every number above was measured in the run, not asserted. Rerun with
`node demo/loopback.js --seed N --jitter-ms M --drain-x X`.

## Install

```bash
npm install cwi-voice-bridge
```

Requires Node ≥ 18. One dependency: [`ws`](https://github.com/websockets/ws)
(MIT) for the WebSocket adapter and tests.

## Usage

### Generic adapter

```js
import { WebSocketVoiceAdapter } from 'cwi-voice-bridge';

const adapter = new WebSocketVoiceAdapter({ url: 'wss://your-voice-server/audio' });
adapter.onAudio((pcm16 /* Int16Array, 320 samples */) => {
  // inbound 16 kHz PCM frame
});
adapter.onEvent((name, data) => console.log(name, data));
await adapter.connect();
await adapter.sendAudio(myPcm16Frame); // 16 kHz mono PCM
await adapter.close();
```

### Patter + Twilio (the customized path)

```js
import { PatterTwilioBridge } from 'cwi-voice-bridge';

// In your Twilio Media Streams WebSocket server:
wss.on('connection', (twilioSocket) => {
  const bridge = new PatterTwilioBridge({ carrier: 'twilio' });
  bridge.attach(twilioSocket);          // Twilio dials in here
  bridge.onAudio((pcm16, meta) => {
    // Steady 20 ms PCM16 frames @ 16 kHz -> patter's pipeline/engine.
    // meta = { concealed, stretched }
  });
  bridge.onEvent((name, data) => {
    // 'start' | 'stop' | 'mark' | 'underflow' | 'drain-anomaly' | ...
  });

  // Outbound: feed engine/TTS audio at ANY rate; the bridge paces the wire.
  await bridge.sendAudio(ttsPcm16Chunk);

  // Barge-in: stop Twilio playout immediately.
  bridge.sendClear();
  bridge.sendMark('playback-stopped');

  // Per-call metrics (patter MetricsStore-style shape — see Assumptions).
  const m = bridge.getMetrics();
});
```

Carrier selection mirrors patter's own provider API:

```js
bridge.setTelephonyCarrier('telnyx'); // PCM 16 kHz native on the wire
bridge.setTelephonyCarrier('plivo');  // μ-law 8 kHz (assumption — verify)
```

### Jitter buffer standalone

```js
import { AdaptiveJitterBuffer } from 'cwi-voice-bridge';

const jb = new AdaptiveJitterBuffer({
  minDelayMs: 40,     // LiveKit-style lower bound
  maxDelayMs: 400,    // LiveKit-style upper bound
  quantile: 0.95,     // target-delay quantile over the delay histogram
  drainGuardRatio: 1.5,
});
jb.on('drain-anomaly', (d) => console.warn(`draining at ${d.measuredRatio}x`));

jb.push(frame /* Int16Array(320) */, seq, sendMs, arrivalMs);
const out = jb.getFrame(nowMs); // { samples, concealed, stretched } | null
// null = pace guard holding: wait for the next tick, do NOT fast-forward.
```

## Architecture

```
Caller -> Twilio PSTN -> Media Streams (WSS, JSON, μ-law 8 kHz)
   -> [PatterTwilioBridge] --20 ms PCM16--> patter (VAD/barge-in/engine)
   -> [PatterTwilioBridge] --paced 1x--> Twilio -> Caller
```

**Inbound path** (`_onInboundMedia` → `_startPlayoutLoop`):

Twilio `media` message → base64 μ-law → decode → 8 kHz → 16 kHz
linear upsample → reframe to 320-sample frames → `AdaptiveJitterBuffer`
→ 20 ms interval emits steady PCM16 frames to `onAudio` handlers.

**Outbound path** (`sendAudio` → `_startOutboundPacer`):

Engine/TTS PCM16 → reframe → (μ-law @ 8 kHz for Twilio/Plivo, native
PCM16 @ 16 kHz for Telnyx) → bounded FIFO (250 frames / 5 s, oldest
dropped with `backpressure` events past the cap) → **one frame per
20 ms tick onto the wire**. The producer's burstiness is absorbed by the
queue; the wire never exceeds 1× realtime.

## Interface specification

### `VoiceAdapter` (abstract)

| Method | Contract |
|---|---|
| `connect()` | Opens the transport; resolves when audio can flow. |
| `sendAudio(pcm16)` | Sends one frame of 16 kHz mono PCM (`Int16Array`). |
| `onAudio(cb)` | `cb(pcm16)` per inbound frame (bridge adds `meta`). |
| `onEvent(cb)` | `cb(name, data)` for lifecycle/quality events. |
| `close()` | Releases transport and timers. |

### `AdaptiveJitterBuffer`

| Method / event | Contract |
|---|---|
| `push(samples, seq, sendMs?, arrivalMs?)` | Ingest one `Int16Array(320)` frame. `seq` must be monotonic. Throws on mis-sized frames. |
| `getFrame(nowMs?)` | Returns `{ samples, concealed, stretched }`, or `null` while the pace guard is engaged. Call every 20 ms. |
| `recordLatency(seq, playoutMs)` | Books a send→playout sample for p50/p95. |
| `latencyPercentiles()` | `{ p50, p95, n }` in ms. |
| `stats()` | `{ targetDelayMs, bufferedMs, jitterEstimateMs, underflows, overflows, stretches, drainAnomalies, paceGuard, latency }`. |
| Events | `underflow`, `overflow`, `drain-anomaly { measuredRatio }`, `drain-recovered`. |

### `PatterTwilioBridge` (extends `VoiceAdapter`)

Inbound Twilio messages handled: `connected`, `start`, `media`, `mark`,
`stop`. Outbound messages sent: `media` (160-byte μ-law @ 8 kHz, or
640-byte PCM16 @ 16 kHz for Telnyx), `mark`, `clear`. Extra surface:
`attach(ws)`, `setTelephonyCarrier()`, `sendMark(name)`, `sendClear()`,
`onMetrics(cb)`, `getMetrics()`.

## Sizing math

- Frame: 20 ms × 16 kHz = **320 samples** = 640 bytes PCM16.
- Twilio wire frame: 20 ms × 8 kHz μ-law = **160 bytes**.
- Outbound queue cap: 250 frames = **5 s** of audio; past it, oldest
  frames drop (counted in `droppedOutboundFrames`, `backpressure` events).
- Delay histogram: 10 ms buckets over `[0, maxDelayMs]` with per-packet
  exponential forgetting (`forgetFactor` 0.995); target = 0.95 quantile,
  clamped to `[minDelayMs, maxDelayMs]` (defaults 40–400 ms).
- Delay history window: 2000 ms (NetEQ's jitter-vs-permanent-shift
  classifier); samples older than the window are pruned per packet.
- Drain guard: 500 ms confirmation window; anomaly above 1.5× realtime
  consumption; recovery below 1.1×. Pace guard returns `null` until
  recovery — audio is held, never fast-forwarded.
- Time-stretch authority: ±10% on voiced frames only (energy VAD,
  RMS > 0.02); silence frames are dropped outright when running hot —
  inaudible latency reduction. Stretch is linear resampling (see Roadmap).

## Design-masters lineage

Studied principles, credited as studied — no endorsement, collaboration,
or review by these projects is claimed.

- **WebRTC NetEQ** ([webrtchacks deep-dive](https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/)):
  relative-delay tracking, ~2 s history window separating jitter from
  permanent delay change, exponential-forgetting delay histograms,
  quantile-based target delay, and time-stretch accelerate/decelerate to
  absorb drift. The base-delay ratchet (re-anchoring to the fastest
  observed frame) follows the same minimum-delay philosophy.
- **LiveKit** ([livekit#1838](https://github.com/livekit/livekit/pull/1838)):
  first-class min/max playout-delay bounds as the operator knob; a fixed
  minimum stops the buffer from draining dangerously low. (LiveKit's
  dynamic 1.3×RTT control was later removed in favor of WebRTC's jitter
  controller — we keep the static bounds and say so.)
- **Twilio Media Streams**: the wire format (JSON messages, base64 μ-law
  8 kHz, `connected`/`start`/`media`/`mark`/`stop`/`clear`) is implemented
  from Twilio's public docs; the core lesson is architectural — *the
  playout clock must follow the audio clock, never the network clock* —
  which is exactly what the outbound pacer enforces.

## Measured results

From `npm run demo` (seed 42, uniform 0–60 ms injected jitter):

| Metric | Value |
|---|---|
| Playout latency p50 / p95 | **60 ms / 80 ms** (n=300) |
| Converged target delay | 60 ms |
| Jitter estimate vs injected | 18.2 ms vs uniform 0–60 ms |
| Underflows / overflows | 3 / 0 over 6 s |
| 4× drain attack | **detected at 3.84×**, pace guard held 132 frames, **recovered at 0.98×** |
| Outbound wire rate (5 s burst in) | **49.0 frames/s** (nominal 50.0) |
| Twilio wire format | `media` events, 160-byte μ-law payloads ✓ |

Tests: **25/25 green** (`npm test`), including a paced-wire assertion
(≈50 frames/s under burst), a bit-transparent Telnyx path check, the
4×-drain detector, and the delay-base ratchet regression test.

## Assumptions (explicit)

- **A1 — insertion point.** The bridge sits on the Twilio side of patter's
  server: point the Twilio number's Media Streams URL at this bridge and
  feed its `onAudio` frames into patter's pipeline (or run it as a sidecar
  proxy). It was built from patter's public architecture docs
  (carrier WebSocket → transport/transcoding/VAD/barge-in → engine);
  the exact in-SDK hook should be confirmed against patter's source at
  integration time.
- **A2 — metrics shape.** `getMetrics()` is modeled on patter's
  MetricsStore/call-log conventions (per-call metrics incl. latency);
  field names are this project's proposal, not patter's schema.
- **A3 — Plivo.** Assumed μ-law 8 kHz like Twilio (from patter docs
  listing Plivo alongside Twilio as a supported carrier). Verify against
  Plivo's XML/media docs before production.
- **A4 — resampling.** 8↔16 kHz conversion is linear
  interpolation/decimation. No audio-quality test covers the resampler
  (codec tests assert only μ-law companding tolerance), so speech
  transparency is **unproven** — a polyphase resampler is the production
  upgrade (see Roadmap).

## Limitations

- **Security posture: terminate TLS in front.** The bridge speaks plain
  WebSocket audio; in production put it behind TLS termination
  (Twilio requires HTTPS/WSS stream URLs anyway) and never expose the
  raw socket to the internet. The code handles no credentials and must
  not be given any.
- No codec: raw PCM16 only. No Opus/Speex path.
- Time-stretch is linear resampling, not WSOLA — artifacts are expected
  on music; speech quality at ±10% is unmeasured.
- Energy-gated VAD (RMS threshold), not a neural VAD — misclassifies
  quiet speech in noise.
- The drain guard detects *consumption* rate; it cannot fix a far-end
  device whose hardware clock is genuinely fast — it holds audio and
  signals, which is the correct local response.
- Single-threaded Node timers: the 20 ms pacer jitters ±2–3 ms under
  load (measured 49.0 vs nominal 50.0 frames/s). For sample-exact pacing,
  drive `getFrame`/pacer from the audio device clock.

## Roadmap

Best-in-class techniques not yet shipped, with the specific reason:

1. **WSOLA time-stretch** (NetEQ-grade) — needs a pitch detector and
   2–3× the DSP code; linear resampling ships first as the $0 path with
   the smallest footprint. There is no listening test or objective
   quality score behind it, so WSOLA is the quality upgrade, not
   optional polish.
2. **Neural VAD** (e.g. Silero) — adds a model dependency and per-frame
   inference cost; energy VAD is the $0 path that works for the demo
   line. Swap-in point: `_isVoiced()`.
3. **Polyphase resampling** (8↔16 kHz) — linear interpolation measures
   clean on voice; a proper FIR resampler is a contained upgrade.
4. **Opus support** — needs a native module (node-opus); kept out to
   stay dependency-light (only `ws` today).
5. **RTT-driven target delay** (LiveKit's 1.3×RTT idea) — needs RTCP-style
   loop timing the telephony path doesn't provide; static min/max bounds
   are the honest mechanism here.
6. **In-SDK patter hook** (exact carrier-adapter patch) — requires
   reading patter's current source at integration time; the sidecar
   deployment works without it.

## License

Open core under the **Apache License 2.0** — see [`LICENSE`](LICENSE).
Copyright 2026 Cumulative Web Inc.

Enterprise/production licensing (support, SLAs, indemnification, custom
carriers) is available — see [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
