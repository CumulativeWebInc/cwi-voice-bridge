import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveJitterBuffer } from '../src/jitter-buffer.js';

const FS = 320;

function tone(seq) {
  const f = new Int16Array(FS);
  for (let i = 0; i < FS; i++) f[i] = Math.round(10000 * Math.sin((seq * FS + i) * 0.05));
  return f;
}
const silence = () => new Int16Array(FS);

describe('AdaptiveJitterBuffer', () => {
  it('converges target delay under injected jitter (quantile of delay distribution)', () => {
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 40, maxDelayMs: 400, quantile: 0.95 });
    let t = 0;
    // Deterministic jitter: delays cycle 0..100 ms.
    for (let seq = 0; seq < 200; seq++) {
      const delay = (seq * 37) % 100;
      jb.push(tone(seq), seq, t, t + delay);
      t += 20;
    }
    const s = jb.stats();
    // 95th percentile of {0..100} ≈ 95 ms -> target should be near it, clamped.
    assert.ok(s.targetDelayMs >= 80 && s.targetDelayMs <= 120, `target=${s.targetDelayMs}`);
  });

  it('stays at min delay on a clean network', () => {
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 40 });
    let t = 0;
    for (let seq = 0; seq < 100; seq++) {
      jb.push(tone(seq), seq, t, t);
      t += 20;
    }
    assert.equal(jb.stats().targetDelayMs, 40);
  });

  it('ratchets the delay base to the fastest frame (unlucky first packet)', () => {
    // First frame suffers 100 ms; the rest see uniform 0..60 ms jitter.
    // Without base-ratcheting the relative delays would all read <= 0 and
    // the target would pin at the 40 ms minimum, starving playout.
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 40, maxDelayMs: 400 });
    const frame = () => tone(0);
    jb.push(frame(), 0, 0, 100);
    let t = 20;
    for (let seq = 1; seq < 200; seq++) {
      const delay = (seq * 37) % 61;
      jb.push(frame(), seq, t, t + delay);
      t += 20;
    }
    const target = jb.stats().targetDelayMs;
    assert.ok(target > 50 && target <= 90, `target=${target} (should cover the 0..60 ms spread)`);
  });

  it('conceals underflows by repeating the last frame (not silence)', () => {
    const jb = new AdaptiveJitterBuffer();
    const f = jb.getFrame();
    assert.equal(f.concealed, true);
    assert.equal(jb.stats().underflows, 1);
    // Concealment decays the last frame; with a zero start it is silence.
    assert.ok(f.samples.every((v) => v === 0));
  });

  it('drops oldest frame on overflow and counts it', () => {
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 40, maxDelayMs: 80 });
    let t = 0;
    for (let seq = 0; seq < 200; seq++) {
      jb.push(tone(seq), seq, t, t); // never played out
      t += 20;
    }
    assert.ok(jb.stats().overflows > 0, 'expected overflows');
  });

  it('detects a 4x-realtime playout drain and engages the pace guard', () => {
    const jb = new AdaptiveJitterBuffer({ drainGuardWindowMs: 200 });
    let anomalies = 0;
    jb.on('drain-anomaly', () => anomalies++);
    for (let seq = 0; seq < 80; seq++) jb.push(tone(seq), seq);
    // Pull at 4x realtime: 5 ms between 20 ms frames, virtual clock.
    let now = 1_000_000;
    let nulls = 0;
    for (let i = 0; i < 300; i++) {
      const f = jb.getFrame(now);
      if (f === null) nulls++;
      else jb.push(tone(1000 + i), 1000 + i); // keep it fed like a live stream
      now += 5;
    }
    assert.ok(anomalies >= 1, 'drain anomaly should fire');
    assert.ok(nulls > 0, 'pace guard should return null backpressure');
    assert.equal(jb.stats().paceGuard, true);
  });

  it('releases the pace guard when drain returns to 1x', () => {
    const jb = new AdaptiveJitterBuffer({ drainGuardWindowMs: 200 });
    let recovered = false;
    jb.on('drain-recovered', () => (recovered = true));
    for (let seq = 0; seq < 80; seq++) jb.push(tone(seq), seq);
    let now = 1_000_000;
    for (let i = 0; i < 200; i++) {
      jb.getFrame(now);
      now += 5; // 4x
    }
    assert.equal(jb.stats().paceGuard, true);
    for (let i = 0; i < 60; i++) {
      jb.getFrame(now);
      now += 20; // back to 1x
    }
    assert.equal(recovered, true);
    assert.equal(jb.stats().paceGuard, false);
  });

  it('time-stretches voiced audio when running dry instead of glitching', () => {
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 200, maxDelayMs: 400 });
    let t = 0;
    for (let seq = 0; seq < 4; seq++) {
      jb.push(tone(seq), seq, t, t); // only 80 ms buffered vs 200+ target
      t += 20;
    }
    const f = jb.getFrame(t);
    assert.equal(f.stretched, true, 'voiced frame should be decelerated when dry');
    assert.ok(jb.stats().stretches > 0);
  });

  it('skips silence frames when running hot (free latency reduction)', () => {
    const jb = new AdaptiveJitterBuffer({ minDelayMs: 40, maxDelayMs: 400 });
    let t = 0;
    for (let seq = 0; seq < 30; seq++) {
      jb.push(seq < 10 ? silence() : tone(seq), seq, t, t);
      t += 20;
    }
    const before = jb.stats().bufferedMs;
    jb.getFrame(t);
    const after = jb.stats().bufferedMs;
    assert.ok(after < before, `buffer should shrink: ${before} -> ${after}`);
  });

  it('rejects mis-sized frames loudly', () => {
    const jb = new AdaptiveJitterBuffer();
    assert.throws(() => jb.push(new Int16Array(100), 0), /expected 320 samples/);
  });

  it('measures latency percentiles from send->playout timestamps', () => {
    // Batch pattern: all 50 frames (1000 ms) are pushed before playout starts,
    // so the buffer needs headroom above the burst via maxDelayMs.
    const jb = new AdaptiveJitterBuffer({ maxDelayMs: 1200 });
    let t = 0;
    for (let seq = 0; seq < 50; seq++) {
      jb.push(tone(seq), seq, t, t + 30); // 30 ms network delay
      t += 20;
    }
    for (let i = 0; i < 50; i++) {
      const f = jb.getFrame(1000 + i * 20);
      if (f && !f.concealed) jb.recordLatency(i, 1000 + i * 20);
    }
    const { p50, p95, n } = jb.latencyPercentiles();
    assert.ok(n > 40, `n=${n}`);
    assert.ok(p50 >= 900 && p50 <= 1100, `p50=${p50}`);
    assert.ok(p95 >= p50, `p95=${p95} < p50=${p50}`);
  });
});
