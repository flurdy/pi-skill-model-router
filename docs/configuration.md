# Configuration reference

[README](../README.md#configure) · [Routing](routing.md) · [Policy evidence](policy-evidence.md)

Exact models and spend policy stay in local JSON. The router ships no provider defaults; use `pi --list-models` to find exact identities available through your current Pi authentication.

## Files and authority

| File | Scope | Authority |
|---|---|---|
| `<agentDir>/model-tier-router.json` (default `~/.pi/agent/model-tier-router.json`) | Global user policy | Sets tiers, options, exact-model cost/consent, baseline policy, and ledger configuration. |
| `<project>/.pi/model-tier-router.json` | Trusted projects only | Can override `enabled`, `routeImplicitSkillReads`, and complete tier entries. |
| `~/.agents/disabled-models.json` | User-owned, path-scoped deny policy | Only narrows candidate selection; never grants consent or changes metered classification. |

A project tier **replaces** the global tier with the same name; other global tiers remain. Project `implicitBaselinePolicy`, `modelPolicies`, and `usageLedger` are ignored. Project candidates cannot weaken a global metered classification or establish an unmetered classification without global evidence.

After changing router JSON, use `/model-tier reload` to reread it; this also clears the in-memory `on`/`off` override. The disabled-model file is read on each attempt instead.

## Examples

| Example | Selection | Review before use |
|---|---|---|
| [Minimal policy](../model-tier-router.example.json) | Three tiers, first-available, ledger disabled | Replace all placeholders. Premium has `metered: true, consent: "allow"`; change to `"ask"` or remove approval unless unattended metered routing is intended. |
| [Weighted policy](../model-tier-router.opinionated.example.json) | Weighted OpenAI, Anthropic, and Google candidates; bounded ledger enabled | Illustrative snapshot only. Reassess every model ID, metered classification, weight, and telemetry setting locally. |

Shared skills normally use portable tiers with increasing configured ranks:

| Tier | Intended use |
|---|---|
| `economy` | Low-risk, deterministic work |
| `standard` | Normal workflows and bounded implementation |
| `premium` | Substantial judgment or costly mistakes |

Private/project-specific tier names are also supported. Rank is local policy, not inferred model quality or cost.

## Fields

| Field | Purpose |
|---|---|
| `enabled` | Enables routing when the extension loads. |
| `routeImplicitSkillReads` | Allows model reads of loaded skills to request routes. |
| `implicitBaselinePolicy` | Global-only `downshift` (default) or `floor` for first implicit reads. Invalid values warn and use `floor`; see [baseline rules](routing.md#first-implicit-baseline). |
| `tiers.<name>.rank` | Orders nested upgrades and classifies first-implicit baselines. |
| `tiers.<name>.thinking` | Default when neither the selected candidate nor skill specifies thinking. |
| `tiers.<name>.selection` | `first-available` (default) or `weighted-random`. |
| `tiers.<name>.candidates` | Exact models; weighted selection requires integer weights from 1 to 100. |
| `tiers.<name>.candidates[].enabled` | `false` temporarily excludes a candidate without removing it. |
| `tiers.<name>.candidates[].thinking` | Optional selected-candidate preference; see [thinking precedence](routing.md#thinking-precedence). |
| `modelPolicies.<provider/model>` | Global exact-model `metered` classification and optional `consent`. |
| `usageLedger` | Optional bounded local response-counter telemetry; disabled by default. |

Invalid selection policies, malformed weighted candidates, or invalid candidate `thinking` **disable that tier** rather than silently changing selection or paid share. Disabled weighted candidates must retain valid weights so re-enabling them does not silently change the configured distribution:

```json
{
  "model": "provider/model-id",
  "weight": 1,
  "enabled": false
}
```

For exact-model metering and consent rules, see [routing consent](routing.md#metering-and-consent). Legacy inline candidate classifications remain supported, but an unclassified candidate without an exact global policy is unknown cost.

## Disabled models

To exclude models in particular directories for licence, legal, or preference reasons, create the user-owned fixed-path policy `~/.agents/disabled-models.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "client-work",
      "roots": ["/home/me/Code/client", "/home/me/Code/client-api"],
      "models": ["provider/model-id"],
      "reason": "Not approved for client code"
    }
  ]
}
```

- **Matching:** Pi's cwd must be a listed root or descendant, using path-component boundaries both as written and after resolving symlinks. Symlinked members living elsewhere need their own roots; there is no workspace discovery.
- **Identity:** `models` contains exact `provider/model` strings. Matching rules accumulate; nothing re-enables a denied model. `agents` (`claude`, `codex`, `gemini`) is accepted for other tools sharing the file and ignored by the router.
- **Selection:** Denied candidates are removed before first-available selection or the weighted draw. The next allowed candidate may route. The decision records `disabled-by-policy`, rule, and reason; no allowed candidates means retaining the current model.
- **Freshness:** The file is reread for every route attempt and after consent, before switching.
- **Failure:** Missing file changes nothing. Malformed, unreadable, or unsupported content (including unknown fields) stops all routing with a warning until fixed; inspect `/model-tier status`.
- **Limits:** The policy does not block manual `/model` selection, restoration of the original model, an already active route, or other launch paths such as subagents. It is not consent or metering authority.

## Usage ledger

Enable `usageLedger` globally to write bounded daily JSONL files under the agent directory (default):

```text
~/.pi/agent/model-tier-router/usage/v1/
```

- Stores Pi-normalized response token counters, **not provider billing or subscription quota**.
- Does not store prompts, responses, credentials, account identifiers, response IDs, or repository/session paths.
- Writes are best-effort and never delay routing or restoration. Separate Pi subprocesses are not combined into a parent run.
- Bound retention with `usageLedger.retentionDays` and `usageLedger.maxBytes`; inspect `/model-tier usage` and ledger health in `/model-tier status`.

See the [usage-ledger design note](model-tier-usage-ledger-spike.md) for rationale and limitations.
