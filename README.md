# Pi Skill Model Router

A provider-neutral [Pi](https://pi.dev) extension that maps portable skill metadata such as `model-tier: standard` to exact models configured on your machine. It also applies skill `effort` as Pi's thinking level and restores the previous model and thinking level when the run finishes.

Exact provider/model IDs and spend policy stay in local JSON configuration. The extension ships no provider defaults.

## Related repositories

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
| `tiers.<name>.rank` | Controls nested upgrades. A run can move only to a higher rank. |
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

A project tier replaces the global tier with the same name. Other global tiers remain available. Spend authority stays global: project `modelPolicies` and `usageLedger` are ignored, and project candidates cannot weaken a global metered classification.

## Routing behavior

A skill declares capability and reasoning needs in frontmatter:

```yaml
model-tier: premium
effort: xhigh
```

Supported effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The first routed skill snapshots the current model and thinking level. Nested skills may upgrade to a higher-ranked tier or raise thinking, but never downgrade either. Pi restores the original route when the run settles.

Routing boundaries:

- Explicit `/skill:name` commands route after Pi accepts and expands the skill.
- Model-initiated skill reads route only when `routeImplicitSkillReads` is enabled and the read path exactly matches a skill loaded for that turn.
- Plain prompts do not select a tier.
- Skills queued while another run is streaming keep the active route because Pi has no safe message-scoped routing boundary for them.
- A manual model selection stops further routing and cancels automatic restoration for that run.

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
/model-tier reload
/model-tier on
/model-tier off
```

- `status` reports the active route, restoration state, configuration paths and warnings, ledger health, and the last route decision.
- `usage` summarizes locally observed Pi response counters by tier and exact model.
- `reload` rereads router configuration.
- `on` and `off` are in-memory overrides; they do not edit files.

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
