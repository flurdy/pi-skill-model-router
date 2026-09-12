# Pi Skill Model Router

A provider-neutral [Pi](https://pi.dev) extension that maps portable skill metadata such as `model-tier: standard` to exact models configured on your machine. It also applies skill `effort` as Pi's thinking level and restores the previous model and thinking level when the run finishes.

Exact provider/model IDs and spend policy stay in local JSON configuration. The extension ships no provider defaults.

## Related repositories

These independently usable repositories are installed and versioned separately, but complement
the router's model-selection role:

- [flurdy/ai-tools](https://github.com/flurdy/ai-tools) — complementary Pi and Claude Code tooling, plus this router's pre-extraction history.
- [flurdy/agent-skills](https://github.com/flurdy/agent-skills) — shared cross-client skills whose `model-tier` and `effort` metadata this extension can enforce in Pi.

### Companion tools

These tools complement the router but do different jobs:

| Tool | Role |
|---|---|
| [Pi statusline](https://github.com/flurdy/ai-tools/tree/main/pi/statusline) | Displays the active model, thinking level, tokens, cache stats, and Pi-configured estimated cost in Pi's footer. |
| [`token-dashboard`](https://github.com/flurdy/agent-skills/tree/main/skills/token-dashboard) | Read-only current-session and UTC-week token telemetry across Pi, Claude Code, and Codex, with optional OpenRouter analytics. |
| [`model-update-check`](https://github.com/flurdy/agent-skills/tree/main/skills/model-update-check) | Checks configured model IDs against Pi's active catalog and public metadata, then flags models worth reviewing. |

The router controls selection and consent; these tools display or audit what happened. Their token and cost figures are telemetry or local estimates, not provider billing or subscription quota.

## Requirements

- Pi 0.80.6 or newer
- Node.js 22.19 or newer for development

## Install

Pin an immutable commit or tag:

```bash
pi install git:github.com/flurdy/pi-skill-model-router@<commit-or-tag>
```

The package installs the extension only. It does not create or change your routing policy.

For a one-off local development run from a checkout:

```bash
pi -e ./index.ts
```

To dogfood the mutable checkout globally:

```bash
make apply
```

This links the checkout into `~/.pi/agent/extensions/model-tier-router`. The immutable Git package
install remains the reproducible deployment path. Restart Pi after first linking the extension;
`/reload` is sufficient for later source or configuration changes once Pi has loaded it.

## Configure

List the models available through your current Pi authentication:

```bash
pi --list-models
```

Copy an example, then replace every placeholder with an exact `provider/model-id` from that output:

```bash
cp ~/.pi/agent/git/github.com/flurdy/pi-skill-model-router/model-tier-router.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

From a source checkout, copy `./model-tier-router.example.json` instead.

| Example | Use case |
|---|---|
| [`model-tier-router.example.json`](model-tier-router.example.json) | Minimal three-tier policy with first-available selection and the usage ledger disabled. Review or remove its placeholder premium-model `consent: "allow"` policy. |
| [`model-tier-router.opinionated.example.json`](model-tier-router.opinionated.example.json) | July 2026 snapshot with weighted OpenAI, Anthropic, and Google candidates plus bounded local usage telemetry. Treat every model ID and cost classification as local policy to reassess. |

### Core configuration

| Field | Purpose |
|---|---|
| `enabled` | Enables routing when the extension loads. |
| `routeImplicitSkillReads` | Allows loaded skill files read by the model to request a route. |
| `implicitBaselinePolicy` | Global-only `downshift` (default) or `floor` for first implicit reads. Invalid values warn and use `floor`. |
| `tiers.<name>.rank` | Orders nested upgrades and classifies first-implicit baselines. |
| `tiers.<name>.thinking` | Default thinking level when the skill omits `effort`. |
| `tiers.<name>.selection` | `first-available` (default) or `weighted-random`. |
| `tiers.<name>.candidates` | Exact models and, for weighted selection, integer weights from 1 to 100. |
| `tiers.<name>.candidates[].enabled` | Set to `false` to temporarily exclude a candidate without removing its configuration. |
| `modelPolicies.<provider/model>` | Global exact-model `metered` classification and optional `consent`. |
| `usageLedger` | Optional bounded local response-counter telemetry. Disabled by default. |

Invalid selection policies or malformed weighted candidates disable that tier rather than silently changing selection or paid share. Disabled weighted candidates must retain a valid weight so re-enabling them does not silently change the configured distribution:

```json
{
  "model": "anthropic/claude-sonnet-5",
  "weight": 1,
  "enabled": false
}
```

Shared skills should use these portable tiers:

| Tier | Intended use |
|---|---|
| `economy` | Low-risk, deterministic work |
| `standard` | Normal workflows and bounded implementation |
| `premium` | Work requiring substantial judgment or where mistakes are costly |

Configure them with increasing ranks. Private or project-specific tier names are also supported.

### Project overrides

A trusted project can override top-level options and complete tier entries in:

```text
<project>/.pi/model-tier-router.json
```

A project tier replaces the global tier with the same name. Other global tiers remain available. Project `implicitBaselinePolicy`, `modelPolicies`, and `usageLedger` are ignored. Project candidates cannot weaken a global metered classification. The existing `enabled` and `routeImplicitSkillReads` options remain project-overridable.

## Routing behavior

A skill declares capability and reasoning needs in frontmatter:

```yaml
model-tier: premium
effort: xhigh
```

Supported effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The first successful route snapshots the current model and thinking level. Nested skills may select only higher-ranked tiers or raise requested thinking. Pi can clamp effective thinking to model capabilities; the router retains the higher request for later upgrades. The original model and thinking are restored when the run settles.

For a **first implicit skill read**, the current exact `provider/model` must appear in enabled candidates of valid configured tiers at one distinct rank. Multiple memberships at the same rank are valid; disabled candidates/tiers provide no evidence. Equal-rank, unknown, or conflicting-rank baselines retain **both model and thinking**, without a candidate draw, routed run, or restoration obligation.

**Default change:** `implicitBaselinePolicy: "downshift"` permits a known higher-ranked baseline to route to a lower tier through the usual spend gates, using the skill's effort (or tier thinking). Thus standard/high can become economy/medium. Set global `implicitBaselinePolicy: "floor"` before loading this version to retain the previous no-downshift behavior. Upward first-implicit routes still preserve at least current thinking. Status reports the policy and successful `initial-downshift` decisions; retained decisions use effective tier `(baseline)`. Known equal- or higher-ranked retainments for valid requested tiers emit one terse informational notice per skill and model. Invalid requested tiers keep their actionable configuration warning regardless of baseline rank. Unknown or conflicting-rank baselines remain warnings and point to the explicit skill command because their routing intent is unresolved.

These are configured-rank guarantees, not model-quality or cost judgments. A loaded skill read can trigger routing even when read only for context; the router cannot infer execution intent. For a deliberate model choice, run `/model-tier off` **while idle, before selecting the model or starting work**. This prevents explicit and implicit routing; `/model-tier on` resumes it. Startup and same-model choices cannot be detected automatically. `floor` prevents downward routing, not all routing.

A **first explicit skill command**, while routing is enabled, may select its requested tier and thinking even for a higher or unknown baseline, subject to consent. Once a routed run exists, nested no-downshift rules apply to either invocation source.

Routing boundaries:

- Explicit `/skill:name` commands route after Pi accepts and expands the skill.
- Model-initiated skill reads route only when `routeImplicitSkillReads` is enabled and the read path exactly matches a skill loaded for that turn.
- Plain prompts do not select a tier.
- Skills queued while another run is streaming keep the active route because Pi has no safe message-scoped routing boundary for them.
- An idle manual selection establishes the next baseline, not a persistent pin; `downshift` may subsequently lower it. An observed model selection during a turn stops further routing and cancels automatic restoration, even before the first routed skill. Pending consent/switch operations recheck state before applying thinking or claiming a route.
- Pi exposes no startup-choice or selection-initiator provenance and emits no event for same-model selections. Other extensions' non-restore selections are conservatively treated as manual; only the router's expected target event is ignored. This is not an atomic model-selection lock.
- On Pi 0.85.0, extension model/thinking setters change session history but not global defaults. Older supported Pi versions may persist defaults; see the assessment below.

See the [direct-turn routing assessment](docs/pi-direct-turn-model-routing-assessment.md) for the boundary analysis.

### Candidate selection

Selection is bounded to configured, currently available candidates and happens before the provider request:

- `first-available` selects the first enabled configured candidate that is currently available. If that candidate cannot route, the router stops instead of trying the next one.
- `weighted-random` filters disabled, unavailable, or route-ineligible candidates, then makes one independent draw using candidate weights. Weights represent expected run share, not tokens, cost, quota, latency, or quality.
- A declined prompt or failed model switch keeps the current model. The router does not redraw or try another candidate.

The router never performs post-launch provider fallback. Any future fallback must remain bounded to named candidates, resolve identity and cost classification before launch, obtain consent for the complete fallback set when needed, and stop on exhaustion.

### Metering and consent

`modelPolicies` is the preferred source for exact-model cost classification. The router never guesses cost from provider, model name, authentication, skill metadata, historical spend, or the usage ledger.

| Effective policy | Explicit skill | Implicit or headless route |
|---|---|---|
| Unmetered | Routes without prompting | Eligible |
| Metered with `consent: "allow"` | Routes without prompting | Eligible |
| Metered with `consent: "ask"` | Prompts before routing | Excluded |
| Unknown cost | Prompts before routing | Excluded |

`ask` is the default consent for metered models. A declined prompt or unavailable confirmation UI keeps the current model. Legacy inline candidate classifications remain supported, but unclassified candidates without an exact global policy are treated as unknown cost.

## Commands

```text
/model-tier status
/model-tier usage
/model-tier policy provider/model-id [provider/another-model-id ...]
/model-tier reload
/model-tier on
/model-tier off
```

- `status` reports the implicit baseline policy, active route, restoration state, configuration paths and actionable warnings, ledger health, and the last route decision. Normal retained-baseline notices are represented by the decision's reason, model, and thinking fields rather than accumulated as warnings.
- `usage` summarizes locally observed Pi response counters by tier and exact model.
- `reload` rereads router configuration and clears the `on`/`off` override.
- `on` and `off` are in-memory overrides; they do not edit files or survive Pi `/reload` or restart. `off` prevents new routing attempts, not in-flight consent/setters or restoration already owed; use it while idle for model preservation.

### Launch-free policy evidence prototype

The model-callable `model_policy_evidence` tool and `/model-tier policy` command read
the current **global** policy file without reloading active routing state, selecting a
model, prompting, launching a child, or writing a ledger. The tool accepts
`{"models":["provider/model-id"]}` and returns the same envelope in both text and
structured details. The package also exports the query:

```typescript
import { queryModelPolicies } from "@flurdy/pi-skill-model-router/policy";
const evidence = queryModelPolicies(agentDir, ["provider/model-id"]);
```

The caller must obtain `agentDir` from its trusted Pi runtime, not project content or
model-supplied arguments. The command obtains it from Pi itself. This is a policy
snapshot, **not launch authorization or proof of an effective model**. It does not
resolve aliases, query authentication, inspect child configuration, or classify
Claude CLI, fallback exposure, auxiliary models, or priority service tiers.

Version 1 returns `runtime: "pi"`, `scope: "user"`, a `source` with owner, absolute
path, status (`loaded`, `invalid`, `unavailable`) and SHA-256 revision of the bytes
read, plus ordered `policies` rows. Each row contains the literal `model`,
`meteredClassification`, `consentPolicy`, and structured `basis`: `explicit`,
`explicit-override`, `inline`, `conflict`, `invalid`, `missing`, or `unavailable`.
Requests require 1–32 literal provider/model strings of at most 512 characters;
identities are not normalized or fuzzy-matched. A matching configured string still
requires independent runtime identity proof.

Explicit valid global policy retains precedence over inline classifications.
Conflicting inline declarations remain metered/ask. Malformed explicit policies
return unknown/ask for that model instead of falling through to an inline approval;
a malformed policy map invalidates the query. Unrelated invalid rows do not hide
valid rows. These stricter diagnostic rules do not change existing parent routing.
Raw configuration, parse-error text, credentials and account data are never returned.

Every query re-reads policy. The revision identifies a snapshot, not a lock, expiry,
user approval, or atomic check-and-launch guarantee. Consumers must separately verify
source authority, current launch identity, all exposure variants and execution scope.
The native `delegate-work` adapter may use the tool only after its trusted runtime
model reporting has resolved the primary and every fallback identity; it passes the
exact primary model and `fast: false` at launch. Policy evidence skips only the repeated
billing prompt. Unknown, stale, incomplete, non-Pi, or metered/ask evidence still
requires current-run consent. Direct-review behavior is unchanged.

## Usage ledger

When enabled globally, the ledger writes bounded daily JSONL files under:

```text
~/.pi/agent/model-tier-router/usage/v1/
```

It stores Pi-normalized token counters, not provider billing or subscription quota. It does **not** store prompts, responses, credentials, account identifiers, response IDs, or repository/session paths. Writes are best-effort and never delay routing or restoration. Separate Pi subprocesses are not combined into a parent run.

Configure retention with `usageLedger.retentionDays` and `usageLedger.maxBytes`.

## Development

Use the Node version in `.nvmrc`:

```bash
fnm install
fnm exec --using=.nvmrc npm ci
fnm exec --using=.nvmrc npm run check
```

With `nvm`, run `nvm install && nvm use` before the same npm commands. `npm run check` runs tests, typechecking, and the package allowlist check.

After committing package changes, verify an isolated immutable Git install:

```bash
fnm exec --using=.nvmrc npm run verify:git-install
```

Pi loads `index.ts` directly; no build output is required.

## Design notes

- [Metered consent](docs/model-tier-metered-consent-decision.md)
- [Weighted selection](docs/model-tier-weighted-selection-decision.md)
- [Usage ledger](docs/model-tier-usage-ledger-spike.md)
- [Direct-turn routing](docs/pi-direct-turn-model-routing-assessment.md)

## Contributing

Issues and pull requests are welcome, especially for routing-policy use cases and Pi compatibility fixes.

## License

[MIT](LICENSE) © [Ivar Abrahamsen](https://flurdy.com)
