# Weighted candidate selection for the Pi model-tier router

**Status:** Implemented by `ai-tools-nrw`

**Date:** 2026-07-26

## Decision

Add opt-in `weighted-random` selection while preserving `first-available` as the default. Each routed run makes one independent draw over the exact configured candidates that are both available and eligible for the route source.

```json
{
  "selection": "weighted-random",
  "candidates": [
    { "model": "openai-codex/gpt-5.6-terra", "metered": false, "weight": 3 },
    { "model": "anthropic/claude-sonnet-5", "metered": true, "weight": 1 }
  ]
}
```

Weights express expected routed-run share within the eligible pool. They are not token, billing, quota, latency, or quality controls. Runs vary in size, and the usage ledger records responses rather than exact selection fairness.

## Why weighted random

The current first-available list cannot express sharing while its first candidate remains available. Deterministic round-robin would add cursor state but Pi reloads and rebinds extensions during session replacement, so short sessions and separately spawned processes would repeatedly restart the schedule and bias its first positions. Persisting or locking a shared cursor is disproportionate.

Stateless weighted random:

- has no restart, reload, session, or cross-process cursor semantics;
- naturally renormalizes when availability or consent eligibility changes;
- preserves the configured distribution in expectation across independent processes;
- is straightforward to test with an injected random source.

A 3:1 policy can select the lower-weight candidate first or more than once in a short sample. Exact short-run sequencing is explicitly not promised.

## Eligibility and consent

`first-available` keeps its current behavior exactly: select the first available candidate, then apply consent. It does not fall through after a decline or no-UI skip.

`weighted-random` filters before drawing:

- interactive explicit route: every available candidate participates; selected `ask` candidates prompt;
- headless explicit route: candidates requiring confirmation are excluded;
- implicit route: effectively unmetered and exact globally `allow` candidates participate; metered `ask` and unknown-cost candidates are excluded.

Decline, failed model selection, or later restoration never triggers another draw or fallback. Equal/lower nested tiers retain the active model without drawing. A successful higher-tier upgrade makes one new draw in that tier.

## Configuration validation

- `selection` accepts `first-available` or `weighted-random`; omitted means `first-available`.
- Every weighted candidate must declare an integer `weight` from 1 to 100.
- Any invalid or missing weighted candidate weight disables routing for the complete tier until fixed. Candidates are neither dropped nor reinterpreted as first-available because either could silently increase paid share.
- Weights on a first-available tier are ignored with a warning.
- A weighted tier with no eligible candidates retains the current model and records `no-eligible-candidate`.

## Observability

The normalized route-decision record includes:

- `selectionPolicy`;
- the exact pre-launch `selectionPool` with effective weights;
- the selected candidate, effective metering and consent, reason, warnings, and restoration state.

No persistent fairness counters or new telemetry subsystem are added.

## External review

A bounded panel asked Claude Fable, Claude Opus, and OpenRouter Moonshot Kimi K3. Fable and Opus both recommended a narrow go after per-model consent, but disagreed on random versus a deterministic schedule. Kimi failed once and was not retried, leaving quorum unmet and no consensus assessment.

Fable favored stateless random to avoid process-reset bias. Opus favored a deterministic schedule for short-run predictability. Installed Pi lifecycle evidence resolved the disagreement in favor of random: extension closure state does not survive every session replacement, while durable shared state would add unjustified complexity.

## Rollback

Remove `selection` and candidate `weight` fields, or set `selection` to `first-available`. No persisted routing state or migration cleanup is required.
