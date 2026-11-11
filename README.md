# Pi Skill Model Router

A provider-neutral [Pi](https://pi.dev) extension that maps skill `model-tier` metadata to exact models in your local policy, applies `effort` as thinking, and restores the previous model and thinking when the routed run settles. No provider defaults are shipped.

[Install](#install) · [Configure](#configure) · [Commands](#commands) · [Routing behavior](#routing-behavior) · [Development](#development)

## Install

Requires Pi **0.80.6+**. Pin an immutable commit or tag:

```bash
pi install git:github.com/flurdy/pi-skill-model-router@<commit-or-tag>
```

This installs the extension only, not a routing policy. New or reloaded Pi sessions load it.

## Configure

1. List models available through your current Pi authentication: `pi --list-models`.
2. Copy the minimal example to your global agent directory (default path below).
3. Replace **every** placeholder with an exact `provider/model-id` and review its cost policy.

```bash
cp ~/.pi/agent/git/github.com/flurdy/pi-skill-model-router/model-tier-router.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

From a checkout, copy `./model-tier-router.example.json` instead. Once loaded, `/model-tier reload` rereads configuration.

**Review the minimal example's premium `consent: "allow"`: it permits metered routing without another prompt.** Change it to `"ask"` or remove that approval unless intended. The [weighted example](model-tier-router.opinionated.example.json) is illustrative, not a current model or cost recommendation.

Shared skills normally request `economy`, `standard`, or `premium` with increasing configured ranks:

```yaml
model-tier: standard
effort: high
```

Exact identities and spend policy belong in local JSON, not shared skill metadata. See the [configuration reference](docs/configuration.md) for fields, trusted-project overrides, disabled models, and the optional usage ledger.

## Commands

| Command | Use |
|---|---|
| `/model-tier status` | Inspect policy, route/restoration state, paths, warnings, ledger health, and the last decision. |
| `/model-tier usage` | Summarize locally observed response counters by tier and exact model; requires the global ledger. |
| `/model-tier policy provider/model-id [provider/another-model-id ...]` | Read fresh global cost policy without routing or launching a model. |
| `/model-tier reload` | Reread configuration and clear the in-memory `on`/`off` override. |
| `/model-tier on` | Enable new routing attempts in this Pi session. |
| `/model-tier off` | Disable new explicit and implicit routing attempts in this Pi session. |

`on`/`off` do not edit files or survive Pi `/reload` or restart. **Use `off` while idle, before selecting a model or starting work**, to preserve a deliberate choice: it does not cancel in-flight consent/setters or restoration already owed.

The `policy` command and model-callable `model_policy_evidence` tool return a policy snapshot, **not launch authorization or model-identity proof**. See the [policy-evidence reference](docs/policy-evidence.md) for the API, trust boundary, and consumer requirements.

## Routing behavior

| Trigger | First route | Once a routed run exists |
|---|---|---|
| Explicit `/skill:name` accepted and expanded by Pi | Can select the requested tier and thinking, even from a higher or unknown baseline; spend gates still apply. | Can upgrade tier or raise requested thinking, never downshift. |
| Model reads a skill loaded for that turn | Requires `routeImplicitSkillReads`; compares the current exact model's configured ranks. | Same nested no-downshift rule. |
| Plain prompt | Does not select a tier. | Queued skills while streaming keep the active route; there is no safe per-message routing boundary. |

- **Default `implicitBaselinePolicy: "downshift"` can lower the first implicit route's model rank and thinking.** Set global `"floor"` to prevent that downward route; it does not disable upward routing.
- Equal-rank, unknown, or ambiguous first-implicit baselines retain **both model and thinking**, without a draw or restoration obligation. These are configured-rank rules, not quality or cost judgments.
- A loaded skill read can route even when read only for context. Idle manual model selection is a baseline, not a persistent pin; startup and same-model choices cannot be detected automatically.
- An observed model selection during a turn stops routing and cancels automatic restoration. Otherwise, a successful route snapshots the original model/thinking for restoration when the run settles; Pi may clamp thinking to model capabilities.
- Exact global `modelPolicies` govern cost. Metered/ask and unknown-cost routes require explicit confirmation and are excluded from implicit or headless routing. Declines and failed switches keep the current model: no redraw or post-launch provider fallback.

See the [routing reference](docs/routing.md) for baseline comparisons, thinking precedence, selection, consent, and lifecycle limitations.

## Development

Use Node **22.19.0** from `.nvmrc`:

```bash
fnm install
fnm exec --using=.nvmrc npm ci
fnm exec --using=.nvmrc npm run check
# After committing, verify an isolated immutable Git install:
fnm exec --using=.nvmrc npm run verify:git-install
```

With `nvm`, run `nvm install && nvm use` before the npm commands. Checks cover tests, typechecking, and the exact package allowlist. Pi loads `index.ts` directly; no build is needed.

For a one-off checkout run, use `pi -e ./index.ts`. `make apply` instead links the mutable checkout into `~/.pi/agent/extensions/model-tier-router`; restart Pi after first linking. Once loaded, Pi `/reload` can pick up later source/configuration changes. Immutable Git installation remains the reproducible deployment path.

## Related tools and design notes

- [ai-tools](https://github.com/flurdy/ai-tools): complementary Pi/Claude Code tooling and pre-extraction history; [agent-skills](https://github.com/flurdy/agent-skills): portable cross-client skills. Both are independently usable and separately installed/versioned.
- [Pi statusline](https://github.com/flurdy/ai-tools/tree/main/pi/statusline), [`token-dashboard`](https://github.com/flurdy/agent-skills/tree/main/skills/token-dashboard), and [`model-update-check`](https://github.com/flurdy/agent-skills/tree/main/skills/model-update-check) display telemetry or audit models; they do not control router consent. Token/cost figures are local estimates, not provider billing or subscription quota.
- Design rationale: [metered consent](docs/model-tier-metered-consent-decision.md), [weighted selection](docs/model-tier-weighted-selection-decision.md), [usage ledger](docs/model-tier-usage-ledger-spike.md), and [direct-turn routing](docs/pi-direct-turn-model-routing-assessment.md).

## License

[MIT](LICENSE) © [Ivar Abrahamsen](https://flurdy.com)
