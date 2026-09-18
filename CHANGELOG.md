# Changelog

## Unreleased

- README truth-rule pass: removed the unsourced Daily voice-pipeline
  claim; replaced unsupported audio-quality assertions ("fine for
  voice", "transparent in our tests") with explicit "unproven / no
  quality test exists" statements. No code changes.

## 1.0.0 — 2026-09-18

Initial public release.

- `AdaptiveJitterBuffer`: NetEQ-inspired adaptive playout buffer
  (16 kHz PCM, 20 ms frames) — relative-delay tracking with base-delay
  ratchet, ~2 s history window, exponential-forgetting delay histogram,
  quantile target delay, LiveKit-style min/max bounds, energy-gated
  time-stretch, underflow concealment, overflow protection, and a
  playout-drain guard with pace-guard backpressure.
- `VoiceAdapter` / `WebSocketVoiceAdapter`: minimal carrier-neutral
  voice interface (`connect`/`sendAudio`/`onAudio`/`onEvent`/`close`).
- `PatterTwilioBridge`: patter-customized Twilio Media Streams connector —
  μ-law 8 kHz ↔ PCM 16 kHz, inbound jitter buffering, hard 20 ms outbound
  pacer (1× realtime on the wire under any producer burst), Twilio
  `media`/`mark`/`clear` handling, Telnyx native-PCM16 and Plivo
  carrier selection, patter-style per-call metrics.
- G.711 μ-law codec (verified against the well-known 0xFF→0 idle code
  and full-scale clipping behavior).
- Mic-less deterministic loopback demo (`npm run demo`) with measured
  p50/p95 playout latency, 4×-drain attack/recovery, and burst-pacer
  wire-rate measurement.
- 25/25 tests green (`npm test`).
- License: Apache-2.0 open core + commercial licensing note.
