# Per-model metered consent for the Pi model-tier router

**Status:** Implemented by `ai-tools-jk2`

**Date:** 2026-07-26

**Decision bead:** `ai-tools-6t3`

**Implementation bead:** `ai-tools-jk2`

**Runtime assessed:** Pi 0.82.0

## Decision

Keep confirmation for every explicit metered route as the backward-compatible default. Add an optional, global-only exact-model policy map that keeps cost classification and consent separate:

```json
{
  "modelPolicies": {
    "anthropic/claude-sonnet-5": {
      "metered": true,
      "consent": "allow"
    }
  }
}
```

Supported consent values are:

- `ask`: require the existing confirmation for every explicit route and exclude the model from implicit routing;
- `allow`: route without confirmation from either an explicit skill command or an enabled implicit skill read.

An absent, malformed, or unknown consent value resolves to `ask`. Exact `provider/model` identity is required. `metered` remains the cost-exposure classification; `consent` only controls how consent is obtained. For an effectively unmetered model, consent resolves to `not-needed` regardless of a redundant configured value. The router must not infer either value from provider, authentication, historical spend, skill metadata, or the usage ledger.

The `modelPolicies` map is read only from `~/.pi/agent/model-tier-router.json`. Project `modelPolicies` entries are ignored with a warning. It is the preferred exact-model source for both classification and consent, so global candidates may omit inline `metered`. Inline `metered` remains supported for legacy files and for project candidates that need to make handling stricter.

An explicit global `modelPolicies` entry supplies classification and consent. It wins over conflicting global inline values and emits a warning. Without an explicit entry, consistent global inline classifications form the exact-model policy with consent `ask`; conflicting global inline classifications resolve conservatively to `metered: true` and warn. A global candidate with neither an inline classification nor an exact policy is unknown-cost: explicit routing asks and implicit routing skips.

A trusted project may reorder or replace tier candidates, but it cannot weaken global spend policy:

- if the exact model has a global policy, effective metering is the stricter of the global and project classifications (`true` wins), and only global consent can be `allow`;
- a project candidate marked `metered: true` without a global policy remains metered with consent `ask`;
- a project candidate marked `metered: false` without a global policy is treated as unknown-cost: explicit routing requires confirmation and implicit routing skips.

This narrows the current trusted-project behavior for project-only candidates classified `metered: false`, but it fails closed and is necessary to prevent a project tier override from silently authorizing spend. Users who want a project-only model to route without prompts must add its exact global `modelPolicies` entry.

## Routing behavior

| Candidate and route source | Effective behavior | Consent basis |
| --- | --- | --- |
| effectively `metered: false` | Route without a prompt | `not-needed` |
| effectively `metered: true`, explicit, policy absent/`ask` | Prompt immediately before switching; decline/no UI retains the current model | `confirmed`, `declined`, or `unavailable-ui` |
| effectively `metered: true`, explicit, `allow` | Route without a prompt | `configured` |
| effectively `metered: true`, implicit skill read, policy absent/`ask` | Skip without prompting | `not-requested-implicit` |
| effectively `metered: true`, implicit skill read, `allow` | Route without a prompt | `configured` |
| unknown-cost project candidate, explicit | Prompt immediately before switching; decline/no UI retains the current model | `confirmed`, `declined`, or `unavailable-ui` |
| unknown-cost project candidate, implicit skill read | Skip without prompting | `not-requested-implicit` |

`allow` is an explicit global authorization for the exact model. Implicit routing additionally requires `routeImplicitSkillReads` to be effective and an exact read of a skill Pi loaded for that turn. Because `routeImplicitSkillReads` currently defaults to `true`, the `allow` model policy itself is the decisive new opt-in; setting `routeImplicitSkillReads: false` disables all implicit routing.

Headless print/JSON modes continue to fail closed for `ask`: without a confirmation UI, the router retains the current model. `allow` is configuration consent and therefore does not require runtime UI.

Configuration reload applies the newly loaded policy to later routing decisions. It does not alter an active route, trigger a model change, or persist session approval state.

Consent continues to gate model switching, not the existing nested no-downgrade thinking rule. An initial skipped or declined route retains both model and thinking. During an active routed run, a retained, declined, or implicit-skip nested request may still raise thinking monotonically; it never lowers thinking or changes models without consent.

## Weighted-selection interaction

This decision supplies the consent contract for `ai-tools-nrw`; implementation bead `ai-tools-jk2` blocks weighted work. This decision does not choose the weighting algorithm.

- Explicit weighted selection may consider every exact, available configured candidate. After one candidate is selected, apply its consent policy before switching. A declined `ask` candidate must not fall through to another model as an unconsented retry.
- Implicit weighted selection may consider `metered: false` candidates and exact metered candidates with effective policy `allow`; it must exclude metered candidates whose policy is `ask`.
- Selection, consent, and availability remain pre-launch concerns. Neither feature authorizes post-launch fallback.
- The weighted-selection bead must specify whether a declined selection advances its process-local schedule; this consent decision only requires that decline retains the current model.

## Observability

Extend the normalized route-decision record rather than adding a second status subsystem:

- add effective consent policy: `not-applicable`, `not-needed`, `ask`, or `allow`;
- add `configured` to the consent-basis outcomes;
- retain the exact selected candidate, metered classification, reason, warnings, and restoration state.

`/model-tier status` already renders the last normalized decision, so these fields make configuration-authorized routes auditable. Unknown tiers and decisions with no candidate use `not-applicable`. Unknown-cost project candidates retain metered classification `unknown` while applying the `ask` behavior. Retained equal/lower-tier decisions report the effective active candidate's policy while keeping consent basis `not-applicable`, showing that no new consent gate ran. The normal route notification must continue to name the exact selected model. No prompts, responses, credentials, account identifiers, or provider billing data are recorded.

## Alternatives

### Session or time-bounded approval

Deferred. “Allow for this session” or “allow for one hour” would reduce prompts, but it introduces mutable state, expiry semantics across reload/resume/fork, and ambiguity across independently spawned Pi processes. Static global configuration is simpler to audit and revoke. Reconsider only if editing the JSON becomes a demonstrated usability problem.

### Periodic confirmation

Rejected for now. Periodic prompts combine the complexity of persisted approval with weaker predictability: a user cannot easily know whether the next run will prompt. The exact global allow-list plus per-run default is clearer.

### Spend-budget routing

Rejected. The optional usage ledger stores Pi-normalized response counters, not provider billing or subscription quota. The user's observed OpenRouter spend being below $1 supports reducing friction for explicitly approved models, but it is not a sound enforcement signal. The router must not claim or enforce a monetary budget from that ledger.

### Treat `metered: false` as consent

Rejected. That would erase the distinction between “this route may incur usage-based cost” and “I authorize this exact paid model without repeated prompts,” weakening status output and future policy changes.

## Implementation slices

| # | Slice | Observable outcome | Acceptance evidence |
| --- | --- | --- | --- |
| 1 | Parse global model policies | Exact metering plus `ask`/`allow` entries load; existing inline candidates remain compatible; malformed and project-only policies fail closed | Focused `loadRouterConfig` tests cover valid, omitted, conflicting, malformed, inline-derived, unknown-cost, and project-supplied entries and warnings |
| 2 | Resolve policy before routing | Globally allowed metered models skip prompts; default explicit candidates still prompt; implicit metered reads route only when globally allowed | Lifecycle harness tests assert model/thinking, confirmation count, decision policy/basis, no-UI behavior, implicit eligibility, unknown project models, and no fallback after decline |
| 3 | Expose and document policy | Status decisions disclose effective policy/basis and examples explain the global-only authority | Snapshot/deep-equality tests for route decisions, README examples, `npm test`, typecheck, and `git diff --check` |

## Test matrix

| Case | Expected result |
| --- | --- |
| Existing global configuration with inline candidate `metered`, no `modelPolicies` map | Existing classification remains effective with consent `ask`; every explicit metered route prompts |
| Exact global model policy with `ask` | Explicit route prompts |
| Exact global model policy with `allow` | Explicit route switches without prompting and records `configured` |
| Unknown consent value or malformed model key | Warning; effective consent is `ask` |
| Conflicting global inline classifications | Warning; effective classification is conservatively metered |
| Explicit model policy conflicts with global inline classification | Warning; explicit global model policy wins |
| Project supplies `modelPolicies` | Warning; global policy remains authoritative |
| Project marks a globally metered model `metered: false` | Global metered classification and consent remain effective |
| Project-only candidate claims `metered: false` | Treat as unknown-cost: explicit route prompts; implicit route skips |
| Same exact model appears in multiple tiers | One global model policy applies consistently |
| Explicit configured route in print/JSON mode | Routes without UI because consent is already configured |
| Explicit `ask` route in print/JSON mode | Retains the current model |
| Implicit metered read with `ask` | Retains the current model without prompting |
| Implicit metered read with `allow` and effective implicit routing | Routes without prompting and records `configured` |
| Implicit metered read with `allow` and `routeImplicitSkillReads: false` | Router ignores the read and retains the current model |
| Reload changes `ask` to `allow` | Later routes use the new policy; active route is unchanged |
| Initial declined `ask` candidate | Retains current model and thinking; does not try another candidate |
| Nested declined or implicit-skip upgrade | Retains the active model but may raise thinking under the existing monotonic rule |
| Unknown/unavailable candidate or unknown tier | Decision policy is `not-applicable`; consent is not consulted |
| Retained equal/lower tier | Reports active candidate policy with consent basis `not-applicable` |

## Rollout and rollback

Ship `modelPolicies` as optional and retain supported inline candidate `metered` values, so existing global files require no migration and continue to default to `ask`. Prefer one exact policy entry per global model and omit redundant candidate classifications. Add an `allow` policy only to the generic documentation example as an opt-in illustration; do not pre-authorize paid models in the opinionated example. Document the fail-closed change for project-only or unclassified candidates.

Rollback is changing an exact model's consent to `ask` or removing its `modelPolicies` entry. Existing inline candidate classifications then restore per-route prompts after `/model-tier reload` or restart. Removing implementation support later causes the unknown top-level map to be ignored while existing `metered: true` candidates continue to prompt.

## Residual risks

- A user can authorize a costly exact model indefinitely and forget the entry. Exact model visibility in route notifications and status mitigates this; automatic expiry is intentionally not added.
- Provider pricing or authentication can change without the model ID changing. `metered: true` keeps that exposure visible, but the user must periodically review local configuration.
- Project-only candidates that previously relied on `metered: false` become confirmation-only until the user adds an exact global model policy. This is an intentional fail-closed compatibility change.
- Separate Pi processes load the same static policy but keep independent routing state. The consent result is consistent; weighted distribution may not be.

## Recommendation

Implement this decision before weighted candidate selection. Keep the first release narrow: optional global exact-model policies with `ask`/`allow`, legacy inline candidate compatibility, a fail-closed project classification floor, no temporary approvals, implicit metered routing only for globally allowed exact models, and no ledger-derived budget logic.
