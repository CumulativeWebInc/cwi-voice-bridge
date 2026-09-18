## Twenty Minds — Should cwi-voice-bridge ship to public GitHub now, or hold for more hardening?

Facts (max 5):
1. 25/25 tests green; loopback demo measures p50=60ms/p95=80ms playout latency, 4x drain detected at 3.84x with recovery at 0.98x, outbound wire paced at 49.0 frames/s under a 5 s burst.
2. Known explicit assumptions documented in README: patter in-SDK hook unverified (sidecar deployment works without it), Plivo wire format assumed μ-law, linear resampling, energy VAD.
3. License hygiene done: Apache-2.0 + COMMERCIAL-LICENSE.md + SPDX headers on all source; single dependency `ws` (MIT).
4. Black's bar is "PERFECT"/magnificent/no demo-ware; the kill rule was tests-green-first, now met; announcements (Francesco reply, X post, Moltbook post) still need parent/browser delegation.
5. The release is reversible: v1.0.0 open-source tag; follow-up fixes ship as commits; nothing irreversible happens on publish.

### Verdicts (one sentence + one risk each)
1. Skeptic — Ship; the strongest argument against shipping is "Francesco might find the sidecar assumption naive," which would be true whether we ship today or in a month.
   Risk: shipping lets us mistake "published" for "evaluated" — zero external users is still zero.
2. Data scientist — Ship; 25/25 green plus measured p50/p95 and a 3.84x detection are the numbers the README claims, and every claim has a measurement behind it.
   Risk: the demo's virtual-clock Phase 1 and localhost tests are not a real PSTN call — the numbers are honest but lab-bound.
3. User advocate — Ship; Francesco's team gets a real repo to evaluate today instead of a promise, which is what "built for Patter, not a demo" means.
   Risk: if the first thing they hit is the unverified in-SDK hook (A1), the "customized for Patter" claim feels thin on contact.
4. Contrarian — Hold; "PERFECT" was the order and a sidecar with four documented assumptions is by definition not perfect — perfect would be the verified in-SDK hook.
   Risk: holding for perfect means never shipping — the in-SDK hook needs Patter's team anyway, which only happens after they see the repo.
5. Engineer — Ship; the code is small (1,526 lines total), dependency-light, timer-clean (no hangs), and every timer/queue has a bound — the maintenance surface is tiny.
   Risk: the 20 ms pacer jitters ±2–3 ms under load, and someone will file that as a bug on day one.
6. Economist — Ship; the open-core-now/paid-licenses-later pipeline only starts producing option value once the repo is public and citable.
   Risk: Apache-2.0 gives away the core patent grant for free — the commercial upside was already priced at zero the moment we chose the license.
7. Security reviewer — Ship; the attack surface is a WebSocket server the deployer configures — no auth, secrets, or credential handling in the code at all, so there is nothing to leak.
   Risk: deployers will point Twilio at the bridge without TLS termination in front, and plaintext audio is a real-world footnote we should print louder.
8. Child-of-five explainer — Ship, because "we made the phone line stop eating the robot's words and proved it with a stopwatch" is a sentence anyone understands.
   Risk: the five-year-old also thinks the stopwatch proves it works on every phone, everywhere.
9. 10-year historian — Ship; in 2036 the record will show CWI published a measured voice-plumbing fix in the open, not that it waited for a perfect Patter hook.
   Risk: historians also record the repos that shipped v1.0.0 and were never touched again — maintenance is the real verdict.
10. Devil's accountant — Ship; the true cost so far is compute time (already spent), and holding burns more worker sessions for diminishing polish.
    Risk: the hidden cost is reputation — one "this doesn't work with real Patter" reply from Francesco costs more than a week of polish would have.
11. Field operator — Ship; day-to-day this repo needs nothing — no server, no cron, no dashboard — its worst Tuesday is an issue filed about Plivo.
    Risk: "needs nothing" is true until someone actually deploys it, at which point the operator is Francesco's team, not us.
12. Systems thinker — Ship; publishing unblocks the whole downstream chain — the X reply, the announcement posts, the Gear Ledger entry, Patter-team evaluation — while holding blocks all of them.
    Risk: the feedback loop we want (Francesco's evaluation) only closes if he actually clicks, which shipping doesn't guarantee.
13. Risk underwriter — Ship; the tail risk is a public technical correction from an expert, which is cheap (a commit) and even useful (engagement).
    Risk: the real tail is silence — shipping to zero evaluators, which the "don't bring back zeros" rule counts as a kill signal, not a win.
14. Open-source maintainer — Ship; the README reads like a reference doc, assumptions are explicit, the demo is one command — strangers can read, fork, and trust this.
    Risk: trust also needs a CHANGELOG and issue templates, which don't exist yet — small, but strangers notice.
15. Negotiator — Ship; our best move is giving Francesco's team something concrete before asking for anything; our walk-away is the repo standing alone as a real artifact regardless.
    Risk: if they never engage, we've negotiated with ourselves — the repo is the consolation prize, not the deal.
16. Time traveler (2036) — Ship; looking back, the repos that mattered were the ones published when the conversation was live — Francesco's thread is live this week.
    Risk: the traveler also remembers timing windows missed by shipping too early with the wrong abstraction.
17. First-principles physicist — Ship; what must be true is that paced 1x output and measured latency exist in code, and they do — 25 tests and a demo verify the physics.
    Risk: physics in the lab (virtual clock, localhost) is not physics on the PSTN — the irreducible fact is we haven't made a real phone call.
18. Ethicist — Ship; no one is harmed, no consent needed — it's our code, our measurements, honestly labeled, with assumptions explicit.
    Risk: the announcement posts must keep every adjective tied to a number, or we cross from honest to hype.
19. Competitor analyst — Ship; the strongest competitor (an established voice-AI infra vendor) would answer with a managed service and a sales call — our edge is the open, measured, forkable core.
    Risk: they see the roadmap too — WSOLA, neural VAD, Opus are all public now, and they can out-build us on each.
20. Black's chair — Ship; results only, $0 path first, verify before asserting — 25/25 green, measured numbers, kill rule met — but the Francesco reply and announcements still need the parent, so report the repo as the result and hand off the browser work.
    Risk: his "PERFECT" bar means the reply to Francesco must not oversell the sidecar as an in-SDK integration — one padded claim burns the trust.

### Synthesis
- Decision: Ship the public repo now.
- Why: the skeptic's "waiting doesn't fix the assumption," the systems thinker's "shipping unblocks every downstream step," and Black's chair's "kill rule met, results only" converge — the assumptions are documented, the numbers are measured, and holding produces nothing.
- Dissent recorded: the contrarian's strongest minority — "PERFECT" was the order and four documented assumptions are not perfect; answer: perfection here means honest and measured, not assumption-free, and the in-SDK hook needs Patter's team, which only engages after they see the repo.
- Confidence: high — fact that would change it: if a real PSTN loopback test contradicted the lab numbers (we haven't made a real call; A4/A5 in Limitations say so openly).
- Changed the pre-run lean? no (lean was ship; kill-criterion count: 1 no-change run).
