# Skill boundaries and first-route baseline protection

**Status:** Current routing contract; installed-runtime assessment rechecked against Pi 0.85.0 on 2026-09-06.

## Decision

Keep routing limited to verified skill boundaries. Plain prompts do not select a tier, and queued skills retain the active route. Do not add a prompt classifier, direct-turn default tier, or model-name capability heuristics.

The first implicit skill read uses exact configured membership as a conservative baseline floor. This is local rank policy, not evidence of model quality or startup user intent. Explicit initial skill commands retain their existing authority and cost-consent behavior.

## First-route policy

A baseline is the effective model immediately before a first route attempt, not necessarily the model at session startup. Resolve its exact `provider/model` against enabled candidates in valid configured tiers. Only one distinct matching rank establishes a known baseline. Duplicate candidates or multiple tiers at that same rank do not create ambiguity; conflicting ranks do. Disabled candidates and tiers with invalid routing configuration provide no evidence. A baseline need not appear in the currently available candidate pool to have configured rank evidence.

| Situation | Behavior |
| --- | --- |
| First implicit read; known baseline rank below requested tier | Apply existing candidate selection and spend eligibility. Preserve at least the current requested thinking on a successful switch. |
| First implicit read; baseline rank equal/higher | Retain exact model and thinking. No candidate draw, confirmation, routed state, usage attribution, or restoration obligation. |
| First implicit read; unknown, missing, or conflicting-rank baseline | Retain exact model and thinking; explain the uncertainty and explicit skill alternative. No inferred rank. |
| Same-rank membership in several valid tiers | Treat the baseline rank as known without assigning it an arbitrary owning tier. |
| First explicit `/skill:name` | Existing initial selection and effort semantics, including lower tiers/thinking, with existing consent requirements. |
| Later read after baseline retention | Reevaluate current baseline. A qualifying higher-ranked request may still route. |
| Nested skill after a successful route | Existing rank-only upgrades and monotonic requested thinking, regardless of explicit/implicit invocation. |
| Unavailable/ineligible candidate, declined consent, or failed switch | No fallback/redraw. A first attempt leaves baseline thinking unchanged; existing nested thinking behavior remains. |

`routing.ts:baselineRank` owns membership resolution; `index.ts:routeSkill` applies the first-implicit guard before selection. Retained decisions use effective tier `(baseline)` and reasons `baseline-unknown`, `baseline-ambiguous`, `baseline-retain-equal`, or `baseline-retain-lower`. They do not pretend that the requested tier was activated.

This intentionally narrows implicit routing: an unlisted starting model will not automatically switch. Users can configure consistent membership, explicitly invoke a skill, or disable implicit routing. No configuration file is changed by the extension.

## Thinking and spend authority

For a first successful implicit switch, requested thinking is the maximum of current thinking and skill/tier effort. That request is retained through model-specific clamping for subsequent upgrades. A first explicit invocation still selects its declared/default effort. Retained baselines leave thinking untouched, even if the skill asks for more; use an explicit skill command to request that change.

Neither rank nor model identity implies cost. Selection still resolves exact global model policy, applies the existing trusted-project restrictions, and excludes metered-ask/unknown-cost routes from implicit selection. Weighted selection makes one eligible draw; first-available selection does not fall through after consent rejection or switch failure. Retaining an already selected model is not a new consent grant and does not authorize later routes to it.

## Manual selection and restoration

An idle selection establishes the next baseline. An observed non-restore selection during a turn cancels routing and automatic restoration, including when no routed state yet exists. Cancellation is scoped to that turn, not permanently to the session. A fresh idle turn can route again. Failed/deferred restoration retains existing retry and manual-escape behavior.

Only the router's expected `set` target event is ignored while switching/restoring; a different selection during that await cancels ownership. Consent completion and switch completion are checked before further thinking changes or route attribution. Settlement restores only router-owned state, never the pre-route snapshot after an observed override.

Pi does not identify the initiator of a `set` event. Another extension's selection is therefore treated conservatively as manual. Pi also suppresses same-model events, so choosing the already active model is not observable. Startup CLI/launcher/settings/session provenance is unavailable. No permanent manual pin is inferred from those absent events.

The public setter is asynchronous and has no compare-and-swap or cancellation contract. These checks do not make concurrent setters atomic: a setter already awaiting authentication can still finish after a different selection. Exact-target collisions and unobserved selections cannot be attributed reliably. The router stops further ownership when it observes a conflicting selection; it does not issue a compensating setter that could fight an even newer choice.

## Installed Pi lifecycle evidence

Paths below are relative to the installed `@earendil-works/pi-coding-agent/dist/` package, version 0.85.0. Public API semantics are also described in Pi's `docs/extensions.md` under Model Events and `pi.setModel` / `pi.setThinkingLevel`.

| Boundary | Source | Consequence |
| --- | --- | --- |
| Initial prompt | `core/agent-session.js:843-915` emits input, expands skills/templates, validates the baseline, then awaits `before_agent_start`. | Explicit skill routing can precede the first provider call. Baseline authentication failure can occur before routing. |
| Queued messages | `core/agent-session.js:859-872` queues expanded steering/follow-up messages and returns. | No new `before_agent_start` for each queued message; retain one active route. |
| Preflight and run lifetime | `core/agent-session.js:620-621,772-785` marks the core run active after preflight and handles continuations before settlement. | Track preflight authority from `before_agent_start` as well as active-run state; do not use `agent_end` as restoration boundary. |
| Model events | `core/extensions/types.d.ts:630-638`; `core/agent-session.js:1238-1247` | Only `set`, `cycle`, `restore`; same-model events suppressed; no startup or initiator provenance. |
| Model setter | `core/agent-session.js:1254-1270,2050-2055` | Extension setter changes session model/history and reclamps thinking; global defaults change only with `persist`, which the extension adapter does not pass. |
| Thinking setter | `core/agent-session.js:1360-1379,2057` | Extension changes are recorded in session history, clamped to model capabilities, and do not change configured defaults. |

### Correction to the Pi 0.80.6 assessment

The previous assessment found persistent extension setters and a cross-process global-default restoration race on Pi 0.80.6. That is **not the current Pi 0.85.0 contract**: extension setters are session-local. The old persistence-based prohibition must not be used as current evidence.

The package still supports older Pi releases, so the historical persistence caveat remains relevant there. Session-local does not mean transient: route changes remain in session history, and a crash before settlement can leave the routed model selected when that session is resumed. This change does not add crash recovery or reconstruct routing ownership from history.

Even with current session-local setters, missing startup provenance and queued-message boundaries still rule out claiming consistent automatic routing for arbitrary prompts. An explicit semantic tier-selection alias would be separate product work; none is introduced here.

## Verification contract

The event harness in `routing.test.ts` provides deterministic evidence for:

- premium baseline followed by first implicit standard, compared with nested no-downshift behavior;
- equal ranks, unknown identity, conflicting ranks, same-rank duplicates, disabled candidates/tiers;
- zero draws, prompts, thinking changes, attribution, and restoration after baseline retention;
- later qualifying upgrades, preserved thinking requests through clamping, unavailable and failed switches;
- first explicit authority, existing metered eligibility/consent, and queued routing boundaries;
- manual selection before routing, during confirmation/switch/restoration, and recovery in a new turn;
- existing nested upgrade, failed/deferred restoration, and usage-attribution behavior.

Run `npm run check` on Node from `.nvmrc`, then `npm run verify:git-install` against the committed immutable ref. The Git-install check verifies package loading in an isolated Pi agent directory without a provider request. The event harness proves router transitions, not real-provider model quality, billing, or atomic runtime setters. Installed source evidence supplies the lifecycle/persistence distinctions above.
