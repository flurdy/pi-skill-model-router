# Launch-free policy evidence

[README commands](../README.md#commands) · [Configuration](configuration.md) · [Routing consent](routing.md#metering-and-consent)

**Policy evidence is a snapshot, not launch authorization or proof of an effective model.** It reads the current global policy without reloading active routing state, selecting a model, prompting, launching a child, or writing a ledger.

## Interfaces

| Interface | Input | Trust requirement |
|---|---|---|
| Pi command | `/model-tier policy provider/model-id [provider/another-model-id ...]` | Pi supplies its own agent directory. |
| Model-callable `model_policy_evidence` tool | `{"models":["provider/model-id"]}` | A trusted runtime must first resolve every exact model identity that could be exposed. The tool supplies the same envelope in text and structured details. |
| Package export | `queryModelPolicies(agentDir, models)` | Caller obtains `agentDir` from trusted Pi runtime, never project content or model-supplied arguments. |

```typescript
import { queryModelPolicies } from "@flurdy/pi-skill-model-router/policy";
const evidence = queryModelPolicies(agentDir, ["provider/model-id"]);
```

The query reads **global user policy only**. It does not resolve aliases, query authentication, inspect child configuration, or classify Claude CLI, fallback exposure, auxiliary models, or priority service tiers. A configured string match still needs independent runtime identity proof.

## Version 1 envelope

| Field | Meaning |
|---|---|
| `version`, `runtime`, `scope` | `1`, `"pi"`, `"user"` |
| `source` | Owner, absolute path, status (`loaded`, `invalid`, `unavailable`), and SHA-256 revision of the bytes read when available |
| `policies` | Ordered rows with literal `model`, `meteredClassification`, `consentPolicy`, and `basis` |
| `basis` | `explicit`, `explicit-override`, `inline`, `conflict`, `invalid`, `missing`, or `unavailable` |

Requests require **1–32 literal provider/model strings**, each at most **512 characters**. Identities are neither normalized nor fuzzy-matched. Raw configuration, parse-error text, credentials, and account data are never returned.

## Conservative diagnostics

- Valid explicit global policy takes precedence over inline classifications.
- Conflicting inline declarations remain metered/ask.
- A malformed explicit policy yields unknown/ask for that model instead of falling through to inline approval.
- A malformed policy map invalidates the query; unrelated invalid rows do not hide valid rows.

These query diagnostics do not change existing parent routing behavior.

## Consumer obligations

Every query rereads policy. Its revision identifies a snapshot, **not a lock, expiry, user approval, or atomic check-and-launch guarantee**.

Consumers must independently establish:

1. Source authority and current runtime identity.
2. Every primary, fallback, and auxiliary exposure variant.
3. The task's execution scope and launch authorization.
4. Current-run billing consent where required.

The native `delegate-work` adapter may use evidence only after trusted runtime model reporting resolves the primary and **every fallback** identity. It passes the exact primary model and `fast: false` at launch. Qualifying evidence skips only the repeated billing prompt, not task, fanout, mutation, publication, or identity authorization. Unknown, stale, incomplete, non-Pi, or metered/ask evidence still requires current-run consent. Direct-review behavior is unchanged.
