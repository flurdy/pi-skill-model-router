# Pi Model Tier Router

Small, provider-neutral Pi extension that maps semantic skill metadata such as `model-tier: standard` to exact locally configured models and honors skill `effort` as Pi's thinking level. It restores the previous model and thinking level when the agent run settles.

Exact provider/model IDs stay in local JSON configuration; the extension contains no provider defaults.

## Related repositories

- [flurdy/ai-tools](https://github.com/flurdy/ai-tools) contains complementary Pi and Claude Code tooling, plus this router's pre-extraction history.
- [flurdy/agent-skills](https://github.com/flurdy/agent-skills) contains shared cross-client skills whose portable `model-tier` and `effort` metadata this extension can enforce in Pi.

## Requirements

- Pi 0.80.6 or newer
- Node.js 22.19 or newer for the development scripts

## Configure

List the models available with your current authentication:

```bash
pi --list-models
```

Choose one of the credential-free examples, then replace every placeholder with an exact `provider/model-id` from that output:

- **Generic** (`model-tier-router.example.json`): the smallest portable baseline, with one candidate in each tier, the usage ledger disabled, and an exact-model `allow` example that must be reviewed before use.
- **Opinionated** (`model-tier-router.opinionated.example.json`): a concrete July 2026 policy snapshot using OpenAI Codex, Anthropic Claude, and Google Gemini candidates, enabled bounded local usage telemetry, and `medium`/`medium`/`xhigh` default thinking. It is a starting point, not a claim that those models are available or have the same cost classification for you.

From a source checkout, copy the generic baseline:

```bash
cp ./model-tier-router.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

Or copy the opinionated policy:

```bash
cp ./model-tier-router.opinionated.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

Candidate selection is bounded and happens before the provider request. `first-available` is the compatibility default and selects the first configured candidate currently available. Opt-in `weighted-random` makes one independent routed-run draw over the available candidates eligible for that route source; weights describe expected run share, not tokens, billing, quota, latency, or quality. Neither mode is a post-launch retry list. Global `modelPolicies` is the preferred exact-model source for metering classification and consent, so candidates may omit `metered`; legacy inline classifications remain supported. An unclassified candidate is unknown-cost rather than assumed free. The router never guesses cost exposure from provider, authentication details, portable skill metadata, historical spend, or the usage ledger.

Metered candidates default to `ask`: explicit `/skill:name` commands require interactive confirmation, while decline or a missing confirmation UI retains the prior model. Optional global-only `modelPolicies` can authorize an exact model with `consent: "allow"`, avoiding repeated prompts. `allow` also permits an enabled implicit skill read to use that exact metered model without blocking. An effectively unmetered candidate routes without a prompt regardless of consent. Project `modelPolicies` are ignored, and project candidates cannot lower a global metered classification; a project-only or unclassified candidate without an exact global policy is treated as unknown-cost, prompts explicitly, and skips implicitly.

For weighted selection, interactive explicit routes draw from every available candidate and prompt if the selected candidate is `ask`. Headless explicit and implicit routes exclude candidates that cannot route without a prompt. Decline or model-selection failure retains the current model without another draw or candidate fallback. Equal/lower nested tiers retain the active draw; a successful higher-tier upgrade draws once in the new tier.

The generic example deliberately illustrates `allow` for a placeholder premium model. Replace the placeholder and reassess both `metered` and `consent`, or remove `modelPolicies` to retain per-run confirmation. The opinionated example pre-authorizes no metered model.

### Opinionated policy choices

The opinionated example deliberately chooses:

- `enabled: true` so the copied file is active once the extension is installed.
- `routeImplicitSkillReads: true` so loaded skills can use an available locally unmetered candidate; a metered candidate is skipped unless its exact global policy is `allow`.
- `economy` (rank 10) and `standard` (rank 20) at `medium` thinking, and `premium` (rank 40) at `xhigh`, allowing nested work to upgrade but never silently downgrade a route.
- `weighted-random` candidate sharing: economy uses 6:1:1, standard 3:1, and premium 3:1:1 weights. Each run is an independent draw over its eligible available pool; short samples need not match those ratios.
- An OpenAI Codex candidate classified as locally unmetered in this policy, plus metered Anthropic and, for economy, Google alternatives. Metered candidates remain subject to exact-model consent after selection.
- `usageLedger.enabled: true`, with a 30-day/10 MiB retention bound, for local Pi-normalized response counters. This is global-only telemetry; it records no prompts, responses, credentials, account identifiers, repository paths, or session-file paths.

The provider/model IDs and classifications reflect one local setup as of July 2026. They may be unavailable, renamed, separately billed, included in a subscription, or unsuitable in another setup. `metered: false` is never inferred from a provider, model name, or subscription: keep it only when your own authentication and cost policy make that classification correct. The opinionated example keeps these classifications in global `modelPolicies` and pre-authorizes no metered model, so every explicit metered selection asks immediately before routing; decline or a missing confirmation UI leaves the current route unchanged. Run `pi --list-models`, remove unavailable candidates, and reassess every policy before using it.

## Runtime fallback safety

The router does **not** implement post-launch provider/model fallback. Pi may retry a failed request on the same route, but this router never responds to provider failure by switching candidates or broadening to arbitrary models from Pi's registry.

Any future runtime adapter fallback must be designed and tested as a separate feature. It must:

1. consider only a finite, explicitly configured candidate list;
2. before the first provider request, preflight every candidate's exact `provider/model` identity and `metered` classification;
3. treat a classification as *inherited* when it comes from a default or outer route rather than the candidate entry, and as *unknown* when it is absent or cannot be resolved;
4. require one pre-launch consent covering the complete bounded candidate list if any candidate is metered, inherited, or unknown; disclose each resolved identity and classification, and abort the entire fallback plan if any remain unresolved; and
5. stop on exhaustion rather than select an arbitrary available model.

Fallback execution belongs in the runtime adapter, not this parent skill router. These rules preserve the initial route's spend-consent boundary across every post-launch route change.

A trusted project can override top-level options and complete tier entries in:

```text
<project>/.pi/model-tier-router.json
```

Project configuration is ignored unless Pi trusts the project. A project tier replaces the global tier with the same name; other global tiers remain available. Spend authority remains global: project `modelPolicies` and `usageLedger` are ignored. Global candidate classifications provide an exact-model floor, so project candidates can make handling stricter but cannot silently make a globally metered model unmetered.

Supported options:

- `enabled`: enable routing on load.
- `routeImplicitSkillReads`: route model-initiated `read` calls for skills loaded into that turn's Pi system prompt.
- `tiers.<name>.rank`: nested skills may move to a higher rank, but never to an equal or lower rank.
- `tiers.<name>.thinking`: default Pi thinking level when the skill does not declare `effort`.
- `tiers.<name>.selection`: optional `first-available` (default) or `weighted-random`. Any other value disables routing for the whole tier until fixed rather than silently falling back to `first-available`.
- `tiers.<name>.candidates`: exact model candidates, optional legacy/project-local `metered` classification, and (for weighted tiers) required integer `weight` values from 1 to 100. An invalid weight disables routing for the whole tier until fixed rather than silently changing paid share. A candidate without inline classification needs an exact global model policy to route without the unknown-cost consent boundary.
- `modelPolicies.<provider/model>.metered`: preferred global exact-model classification. It wins over conflicting global inline classifications; project candidates can only make the effective classification stricter.
- `modelPolicies.<provider/model>.consent`: optional global `ask` (default) or `allow`. `allow` authorizes explicit and enabled implicit routing for an effectively metered exact model.
- `usageLedger`: optional global-only local telemetry. It defaults to disabled; when enabled it writes Pi-normalized assistant-response token counters under `~/.pi/agent/model-tier-router/usage/v1/`. `retentionDays` and `maxBytes` bound retention. Project configuration cannot enable it.

The shared portable taxonomy uses `economy` for low-risk deterministic work,
`standard` for normal workflows and bounded implementation, and `premium` for work
where substantial judgment or the cost of a mistake justifies the strongest configured
capability. Skill `effort` expresses reasoning depth independently, so `standard` can
serve both routine coordination and high-effort coding. Configure these three routes
with strictly increasing ranks so nested skills can upgrade but never silently
downshift.

The router continues to accept arbitrary private/project tier names, but shared skills
should use only economy, standard, or premium.

## Skill metadata

The router reads these optional frontmatter fields with Pi's frontmatter parser:

```yaml
model-tier: premium
effort: xhigh
```

Effective exact-model metering plus the global consent policy controls the confirmation gate. Skill metadata and project policy cannot waive it. A valid `effort` value (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) overrides the tier's default thinking level. Nested skills may raise thinking but never lower it, including when a model switch is declined or skipped. The router deliberately ignores Claude-specific `model: haiku` metadata.

Explicit `/skill:name` commands are detected during Pi's `input` event and routed from `before_agent_start` only after Pi has accepted and expanded that skill. This prevents a later input handler from leaving behind a premature model switch. Skill commands queued while an agent is already streaming continue on the active model because Pi 0.80.6 has no final-expanded, message-scoped boundary where that route can be applied safely; switching during `input` could also affect intervening tool or steering continuations, so the router warns instead of switching too early. Model-initiated reads route only when the canonical read path exactly matches a skill file Pi loaded for that turn. This includes `SKILL.md` and registered root skill Markdown files without scanning or reimplementing Pi's discovery rules; metered matches fail closed without prompting, while unmetered matches may route normally.

Plain prompts do not select a tier at prompt start. Absent an owed restoration, they retain the current model unless the agent later reads an exact loaded skill file with routing metadata. Pi 0.80.6 has no run-local model/thinking setter, and queued prompts have no final-expanded, message-scoped routing boundary. See the [non-skill routing assessment](docs/pi-direct-turn-model-routing-assessment.md) for source evidence, alternatives, the no-go decision on automatic classification, and the conditional explicit tier-alias proposal.

## Install for testing

```bash
pi -e ./index.ts
```

## Install globally from Git

Pin an immutable commit or tag so future package updates cannot silently move the router:

```bash
pi install git:github.com/flurdy/pi-model-tier-router@<commit-or-tag>
```

The Git package loads only `index.ts`. It does not install or modify router policy. Copy and review a credential-free example separately:

```bash
cp ~/.pi/agent/git/github.com/flurdy/pi-model-tier-router/model-tier-router.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

For local development from this checkout, keep using `pi -e`; no symlink is required. Restart Pi or run `/reload` after changing installed package or configuration files.

## Commands

```text
/model-tier status
/model-tier usage
/model-tier reload
/model-tier on
/model-tier off
```

`reload` rereads router JSON configuration. `on` and `off` are in-memory overrides for the current extension instance; they do not edit local files.

Status reports the active tier and skills, selected/original models, pending restoration, loaded configuration paths, retained configuration validation warnings, route warnings, ledger health, and the last normalized route-decision record. Configuration warnings persist for the loaded configuration, so a tier disabled by invalid configuration stays diagnosable after the run that hit it; route warnings are per-run and clear when the agent settles. A tier disabled by invalid configuration records reason `invalid-tier-configuration`, which is distinct from `no-eligible-candidate` (a valid weighted tier whose eligible pool is empty) and `no-available-candidate`. The record consistently carries the requested and effective tiers, selection policy and exact pre-launch pool, selected configured candidate, effective provider/model, thinking level, effective metered classification, consent policy and basis, route reason/warnings, and restoration result. Usage ledger attribution derives its effective tier and thinking level from the active decision while preserving the assistant message's observed provider/model; a retained nested request therefore remains attributable to the configured route that actually served it.

`/model-tier usage` summarizes local records by tier and exact provider/model in a compact table. It labels them **Pi-normalized observed responses**: they are not subscription quota, provider billing, or cross-provider cost. Pi's `usage.cost` is calculated from configured local model prices, so it is intentionally not persisted as provider-reported cost. Cache reads, cache writes (including optional one-hour writes), output, and optional reasoning counters remain separate; numeric zero values are recorded as known zeroes, while unavailable fields are reported as unknown. Summaries read only canonical `YYYY-MM-DD.jsonl` regular files managed by the ledger.

The ledger records neither prompts nor responses, repository/session-file paths, response IDs, account identifiers, or credentials. It is best-effort: records may be dropped on a full queue, disk error, or abrupt shutdown, and persistence never delays routing or restoration. Configuration reload reuses an unchanged ledger, preserving its queue and health counters; changing or disabling ledger bounds drains the previous instance before replacement. Separate Pi subprocesses (including `pi-subagents` workers) are not rolled into a parent routed run.

## Development

Install the Node version pinned in the repository-root `.nvmrc`, then install from the committed lockfile and run the package checks:

```bash
fnm install
fnm exec --using=.nvmrc npm ci
fnm exec --using=.nvmrc npm run check
```

With `nvm`, run `nvm install && nvm use` before the same `npm` commands. `npm run check` runs the focused tests, typechecking, and the publishable-files allowlist check. After committing package changes, `npm run verify:git-install` performs an isolated install from the immutable local `HEAD`, confirms `/model-tier` discovery through Pi RPC, and verifies that router JSON configuration stays in the external agent directory. Pi loads `index.ts` directly; no build output is required.

## Lifecycle notes

- The first routed skill snapshots the current model and thinking level.
- Higher-ranked nested skills may upgrade the route. Equal- or lower-ranked skills retain the current route, while any nested skill may raise but not lower thinking effort.
- Candidate availability comes from `ctx.modelRegistry.getAvailable()`. Weighted selection filters unavailable and route-source-ineligible candidates before drawing, with no debt or catch-up when a model returns.
- A manual model selection during a routed run disables further routing and cancels automatic restoration, so the extension does not fight `/model` or model cycling.
- Restoration is deferred when another run is already active, then retried at the next `before_agent_start` boundary before any new route is applied.
- A failed restoration remains visible as owed and is retried before the next run or when the agent next settles; routing pauses while usage attribution stays attached to the still-active route. A manual model selection clears the owed state.
- Session shutdown/reload attempts restoration eagerly even when the agent is not idle.

## Contributing

Issues and pull requests are welcome, especially for new routing-policy use cases and Pi compatibility fixes.

## License

[MIT](LICENSE) © [Ivar Abrahamsen](https://flurdy.com)
