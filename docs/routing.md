# Routing reference

[README](../README.md#routing-behavior) · [Configuration](configuration.md) · [Policy evidence](policy-evidence.md)

The router selects only exact configured models; ranks describe local policy, not model quality or cost. A skill requests a tier and reasoning effort:

```yaml
model-tier: premium
effort: xhigh
```

Supported effort values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

## Invocation boundaries

| Input | Routing boundary | Limitation |
|---|---|---|
| Explicit `/skill:name` | After Pi accepts and expands the skill | First explicit route may choose its tier/thinking even from a higher or unknown baseline, subject to spend gates. |
| Model-initiated skill read | Only with `routeImplicitSkillReads` enabled and an exact read-path match to a skill loaded for that turn | Can route even when read only for context; execution intent cannot be inferred. |
| Plain prompt | No tier selection | The router does not automatically classify arbitrary work. |
| Skill queued while streaming | Keeps the active route | Pi has no safe message-scoped routing boundary for queued skills. |

The first successful route snapshots the current model and thinking. Once a routed run exists, either invocation source may select only a higher-ranked tier or raise requested thinking. Pi may clamp effective thinking; the router retains the higher request for later upgrades. The original model and thinking are restored when the run settles, subject to manual override and restoration failures described below.

## First implicit baseline

Baseline evidence comes only from enabled candidates of valid configured tiers whose exact `provider/model` matches the current model. Disabled candidates/tiers contribute nothing. A model may have several tier memberships.

| Requested rank relative to baseline memberships | Default `downshift` | Global `floor` |
|---|---|---|
| Above every membership rank | Route upward, preserving at least current thinking | Same |
| Below every membership rank | May route downward, using candidate preference, skill effort, or tier thinking | Retain model and thinking |
| Matches any membership rank | Retain model and thinking | Same |
| Strictly between membership ranks (ambiguous) | Retain model and thinking | Same |
| No membership (unknown) | Retain model and thinking | Same |

All routes remain subject to candidate availability and spend gates. Retaining a first implicit baseline makes **no candidate draw, routed run, or restoration obligation**.

**Default change:** `implicitBaselinePolicy: "downshift"` allows, for example, standard/high to become economy/medium on the first implicit read. Set global `"floor"` before loading this behavior to preserve the previous no-downshift rule. `floor` blocks downward routing, not all routing; project overrides cannot change it.

`/model-tier status` reports the policy and successful `initial-downshift` decisions. Retained decisions use effective tier `(baseline)`:

- Known equal/higher retainments for valid requested tiers emit one informational notice per skill and model.
- Invalid requested tiers retain actionable configuration warnings regardless of baseline rank.
- Unknown/ambiguous baselines warn and point to the explicit skill command because intent is unresolved.

## Thinking precedence

Only a candidate actually switched to contributes its preference, in this order:

1. `candidates[].thinking`
2. Skill `effort`
3. `tiers.<name>.thinking`

The candidate preference belongs to its tier, so one model can have different preferences in different tiers:

```json
{
  "tiers": {
    "economy": { "rank": 10, "thinking": "medium", "candidates": [{ "model": "provider/model-id", "thinking": "low" }] },
    "premium": { "rank": 40, "thinking": "xhigh", "candidates": [{ "model": "provider/model-id", "thinking": "high" }] }
  }
}
```

A preference is calibration, **not a cap**:

- First explicit routes and permitted first implicit downshifts may lower thinking.
- First implicit upgrades keep at least current thinking; nested upgrades never lower the run's requested thinking. Pi may then clamp to model capabilities.
- Retained nested tiers, declines, unavailable candidates, and failed switches use skill `effort` or requested-tier `thinking`, not a candidate preference from an unsuccessful switch.

Status shows requested/effective thinking; the last decision shows the selected candidate and preference.

## Candidate selection

Selection happens **before** the provider request, within configured and currently available candidates:

| Policy/outcome | Behavior | No fallback guarantee |
|---|---|---|
| `first-available` | Select the first enabled, available, policy-allowed candidate | If it cannot route, stop rather than trying the next candidate. |
| `weighted-random` | Remove disabled, unavailable, denied, or route-ineligible candidates; make one independent weighted draw | Weights mean expected run share, not token/cost/quota/latency/quality share. |
| Declined consent or failed switch | Keep the current model | No redraw or attempt with another candidate. |

The router never performs post-launch provider fallback. Any future fallback must be bounded to named candidates, resolve identity and cost classification before launch, obtain consent for the complete fallback set when needed, and stop on exhaustion.

## Metering and consent

Global exact-model `modelPolicies` are the preferred classification authority. The router never guesses cost from provider, model name, authentication, skill metadata, historical spend, or the usage ledger.

| Effective policy | Explicit skill with UI | Implicit or headless route |
|---|---|---|
| Unmetered | Routes without prompting | Eligible |
| Metered, `consent: "allow"` | Routes without prompting | Eligible |
| Metered, `consent: "ask"` | Prompts before routing | Excluded |
| Unknown cost | Prompts before routing | Excluded |

`ask` is the default for metered models. Declined consent or unavailable confirmation UI keeps the current model. Legacy inline classifications remain supported; unclassified candidates without an exact global policy remain unknown cost. Trusted project candidates cannot weaken global metering; see [configuration authority](configuration.md#files-and-authority).

## Manual choice and lifecycle limits

To preserve a deliberate model choice, use `/model-tier off` **while idle, before selecting the model or starting work**. This disables new explicit and implicit attempts; `/model-tier on` resumes them. It does not cancel in-flight consent/setters or restoration already owed. Overrides are in memory and cleared by `/model-tier reload`, Pi `/reload`, or restart.

- An idle manual selection sets the next baseline, not a persistent pin: default `downshift` may later lower it.
- An observed selection during a turn stops further routing and cancels automatic restoration, even before a first routed skill. Pending consent/switch operations recheck state before applying thinking or claiming a route.
- Pi has no startup-choice or selection-initiator provenance and emits no event for same-model selections. Other extensions' non-restore selections are treated conservatively as manual; only the router's expected target event is ignored. This is **not an atomic model-selection lock**.
- Restoration can be deferred or fail; inspect status. Session history does not provide crash recovery: a crash before settlement can leave the routed model selected on resume.
- On Pi 0.85.0, extension setters change session history, not global defaults. Older supported Pi versions may persist defaults; this is version-specific evidence, not a claim about every Pi release.

See the [direct-turn routing assessment](pi-direct-turn-model-routing-assessment.md) for lifecycle evidence and limitations, and the [metered-consent](model-tier-metered-consent-decision.md) and [weighted-selection](model-tier-weighted-selection-decision.md) decisions for design rationale.
