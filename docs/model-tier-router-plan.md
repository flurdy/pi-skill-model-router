# Architect Plan: Pi model-tier router

> **Historical taxonomy note (2026-07-16):** this implementation plan predates the
> `focused-coding` / `advanced-coding` split. Its `standard-coding` examples describe
> the class now named `advanced-coding`; current configuration guidance lives in
> [`../README.md`](../README.md). Paths below preserve the original `ai-tools`
> implementation location before this package was extracted.

## Planning tier

- **Tier:** premium
- **Why:** Model switching, nested skills, cost confirmation, and restoration have subtle lifecycle risks.
- **Implementation tier:** advanced-coding is sufficient once this plan is approved; use a focused review afterward.

## Goal

Create a Pi extension in:

```text
~/Code/flurdy/ai-tools/pi/model-tier-router/
```

It will read semantic routing metadata from skills, map tiers to locally configured Pi models, switch models for the skill run, and restore the previous model afterward.

It must ignore Claude-specific `model: haiku`.

## Recommended structure

```text
pi/model-tier-router/
├── index.ts
├── config.ts
├── routing.ts
├── routing.test.ts
├── model-tier-router.example.json
├── package.json
├── tsconfig.json
└── README.md
```

- `index.ts`: Pi events, model switching, UI and lifecycle state
- `config.ts`: global/project configuration loading and validation
- `routing.ts`: pure tier ranking, candidate selection and path logic
- `routing.test.ts`: unit tests using Node’s test runner
- Nested package metadata is for typechecking/testing; Pi still loads TypeScript directly.

Install by symlinking the directory:

```bash
ln -s ~/Code/flurdy/ai-tools/pi/model-tier-router \
  ~/.pi/agent/extensions/model-tier-router
```

Pi discovers `index.ts` inside the directory.

## Configuration

Global configuration:

```text
~/.pi/agent/model-tier-router.json
```

Optional trusted-project override:

```text
<project>/.pi/model-tier-router.json
```

Example shape:

```json
{
  "enabled": true,
  "routeImplicitSkillReads": true,
  "restoreAfterRun": true,
  "tiers": {
    "cheap-bulk": {
      "rank": 10,
      "thinking": "low",
      "candidates": [
        {
          "model": "provider/model-id",
          "metered": false
        }
      ]
    },
    "standard-coding": {
      "rank": 20,
      "thinking": "high",
      "candidates": []
    },
    "long-context-audit": {
      "rank": 30,
      "thinking": "high",
      "candidates": []
    },
    "premium-reasoning": {
      "rank": 40,
      "thinking": "high",
      "candidates": []
    },
    "premium-review": {
      "rank": 40,
      "thinking": "high",
      "candidates": []
    }
  }
}
```

Candidate order provides fallback order. Actual IDs must come from `pi --list-models`; no provider IDs should be hard-coded in the extension.

Project configuration overrides global configuration by tier. Project config must only be read when `ctx.isProjectTrusted()` is true.

## Skill detection

### Explicit invocation

Listen to the `input` event and detect:

```text
/skill:<name>
```

Before Pi expands the skill:

1. Resolve the command through `pi.getCommands()`.
2. Require `source === "skill"`.
3. Use `sourceInfo.path` rather than searching known directories.
4. Parse that skill’s frontmatter.
5. Apply its route before the first LLM response.

This supports package, global, configured, and project-local skills without duplicating Pi’s discovery rules.

### Model-initiated skill loading

Pi has no dedicated “skill loaded” event. Models load skills using the `read` tool.

During `before_agent_start`, cache the canonical paths of `event.systemPromptOptions.skills`. Then intercept `tool_call` for `read`:

1. Canonicalise the requested path with `realpath`.
2. Require it to match a skill Pi loaded for this turn.
3. Require the file to be `SKILL.md` or a registered root skill file.
4. Read `model-tier`.
5. For an unmetered candidate, switch before the tool result causes the next model call.
6. For a metered candidate, skip the switch without opening a model-initiated blocking prompt.

This reduces false positives when an agent merely inspects an unrelated `SKILL.md` and ensures implicit reads fail closed on spend.

Provide `routeImplicitSkillReads: false` as an escape hatch.

## Frontmatter handling

Use Pi’s exported `parseFrontmatter()` rather than a handwritten YAML parser.

Recognise:

```yaml
model-tier: premium-review
model-cost-policy: deliberate-premium
model-metered-policy: ask-above-standard
```

Deliberately ignore:

```yaml
model: haiku
model-second-opinion-tier: independent-reasoning
```

`model-second-opinion-tier` describes the external opinion requested by the skill; it should not change the model orchestrating `/second-opinion`.

Unknown or unconfigured tiers should leave the current model unchanged and show a warning only once per run.

## Routing algorithm

For a requested tier:

1. Look up its route configuration.
2. Query `ctx.modelRegistry.getAvailable()`.
3. Select the first configured candidate that is available.
4. If no candidate is available, retain the current model and notify.
5. If the candidate is marked `metered`:
   - Explicit `/skill:name` in interactive/RPC mode: always ask for confirmation, regardless of skill policy metadata.
   - Explicit `/skill:name` in print/JSON mode: skip the switch safely and continue on the current model.
   - Model-initiated skill read: never open a blocking spend prompt; skip the switch and retain the current route/model.
6. Snapshot the original model and thinking level before the first switch.
7. Call `pi.setModel()`.
8. Set the configured thinking level.
9. Display the active tier in Pi’s status area.

Do not infer whether a model uses OAuth or an API key. Local configuration's `metered` flag is the spend authority; portable skill cost/policy metadata may provide confirmation context but cannot waive the gate.

## Nested skills

Use a no-downgrade rule within one agent run:

- The first routed skill establishes the active tier.
- A nested skill with a higher `rank` may upgrade.
- A lower-ranked nested skill must not downgrade.
- Equal-ranked but different tiers retain the existing/root route.

Example:

```text
total-review: premium-review (40)
  └── clean-code: cheap-bulk (10)
```

The run remains on `premium-review`.

Conversely:

```text
complete-task: standard-coding (20)
  └── verify-task: premium-reasoning (40)
```

The run may upgrade to `premium-reasoning`.

## Restoration and manual overrides

Maintain per-run state:

```text
original model
original thinking level
active tier/rank
routed skill names
whether the extension is currently switching
whether the user manually overrode the model
```

Restore on `agent_settled`, not `agent_end`, because `agent_settled` occurs after retries, compaction recovery, and queued continuations.

Listen to `model_select`:

- Ignore events caused by this extension.
- If the user cycles or sets a model during a routed run, mark it as a manual override.
- A manual override cancels automatic restoration, avoiding an unexpected model change afterward.

On restoration:

1. Restore the original model.
2. Restore the original thinking level.
3. Clear the footer status and run state.

Also clear state safely on session shutdown/reload.

## Commands and observability

Add a small command surface:

```text
/model-tier status
/model-tier reload
/model-tier off
/model-tier on
```

`status` should show:

- enabled/disabled
- active tier and skill
- selected model
- original model
- whether restoration is pending
- config paths loaded
- unavailable candidate warnings

Do not add an interactive configuration editor in the first version.

Use concise notifications:

```text
model-tier: architect → premium-reasoning → openai/…
model-tier: retained premium-review; ignored nested cheap-bulk
model-tier: restored openai/…
```

Never print credentials or auth configuration.

## Implementation slices

1. **Pure routing core**
   - Types and config schema
   - Config merging
   - Frontmatter extraction
   - Tier ranking and candidate selection
   - Unit tests

2. **Explicit `/skill:` routing**
   - Resolve skills through `pi.getCommands()`
   - Switch model before expansion
   - Metered confirmation
   - Basic status command

3. **Implicit skill-read routing**
   - Cache loaded skill paths
   - Intercept canonical matching `read` calls
   - Apply no-downgrade semantics

4. **Lifecycle safety**
   - Snapshot model/thinking
   - Restore at `agent_settled`
   - Detect manual model overrides
   - Clean state on shutdown/reload

5. **Documentation and installation**
   - Example configuration
   - Symlink instructions
   - Cross-link from the root `ai-tools/README.md`
   - Explain interaction with Claude’s `model: haiku`

6. **Pi smoke tests**
   - Test via `pi -e ./pi/model-tier-router/index.ts`
   - Then install through the symlink and `/reload`

## Test strategy

### Unit tests

- Global config loads correctly.
- Trusted project config overrides selected global fields.
- Untrusted project config is ignored.
- Exact provider/model IDs resolve.
- Candidate fallback order is respected.
- Missing candidates retain the current model.
- Unknown tiers do nothing.
- `model: haiku` is ignored.
- Lower-ranked nested skills do not downgrade.
- Higher-ranked nested skills upgrade.
- Equal-ranked tiers retain the root route.
- Skill paths are canonicalised across symlinks.
- Manual model override suppresses restoration.

### Manual Pi smoke tests

Create temporary skills for:

- `cheap-bulk`
- `standard-coding`
- `premium-review`
- unknown tier
- no tier

Verify:

1. Explicit `/skill:name` switches before the first response.
2. Automatic unmetered skill reading switches before the next model call.
3. Automatic metered skill reading skips without prompting or changing the route.
4. Nested cheap skill does not downgrade a premium workflow.
5. Unavailable primary uses fallback.
6. Every explicit metered candidate asks before switching, regardless of skill metadata.
7. Metered candidate is skipped in `pi -p`.
8. Original model and thinking are restored after settlement.
9. Manual `/model` selection is preserved.
10. `/reload` leaves no stale active state.
11. Claude-style `model: haiku` has no effect.

## Risks and mitigations

- **False routing when inspecting a skill file**  
  Restrict implicit routing to paths present in Pi’s loaded skills and make it configurable.

- **Provider-specific conversation incompatibility**  
  Prefer switching before the first turn via explicit skill commands. Smoke-test mid-run transitions, especially Google thinking models.

- **Nested workflow downgrades**  
  Enforce rank-based upgrades only.

- **Unexpected premium spending**  
  Treat local candidates marked `metered` as confirmation-required for explicit commands, independent of frontmatter; skip them for implicit reads or when no UI is available.

- **User fights the router with `/model`**  
  Detect manual selection and relinquish control for that run.

- **Configuration drift from `MODEL_ROUTING.md`**  
  Treat the document as semantic policy and the JSON as Pi’s concrete implementation. Cross-link them, but do not parse Markdown as configuration.

## Rollout

1. Run with `pi -e` and temporary test skills.
2. Install globally by symlink.
3. Initially configure only `cheap-bulk` and `standard-coding`.
4. Add premium and Gemini routes after restoration and confirmation behaviour is proven.
5. Keep `enabled: false` or remove the symlink as immediate rollback.

No changes to existing skills are required.

## Fresh-session implementation prompt

```text
Work in /home/ivar/Code/flurdy/ai-tools on main.

Implement the plan at docs/model-tier-router-plan.md.

Read the local Pi 0.80.6 docs completely before coding:
- docs/extensions.md
- docs/skills.md
- docs/models.md
- docs/packages.md

Requirements:
- Keep exact provider/model mappings in ~/.pi/agent/model-tier-router.json, with
  trusted project overrides from .pi/model-tier-router.json.
- Use Pi's parseFrontmatter(), pi.getCommands(), ctx.modelRegistry,
  pi.setModel(), pi.setThinkingLevel(), input/tool_call/before_agent_start,
  model_select, and agent_settled APIs.
- Route explicit /skill:name before expansion.
- Route model-initiated skill reads only when the canonical read path matches a
  skill Pi loaded for the turn.
- Ignore model: haiku and model-second-opinion-tier.
- Nested skills may upgrade by configured rank but never downgrade.
- Every explicitly requested metered candidate requires confirmation regardless
  of skill metadata; skip safely without UI, and skip implicit metered reads
  without prompting.
- Restore original model/thinking at agent_settled unless the user manually
  selected another model.
- Add /model-tier status|reload|on|off.
- Add focused unit tests, an example config, README, installation instructions,
  and update the root ai-tools README.
- Use the existing ai-tools Pi extensions as style references.
- Validate with typechecking/tests and report any Pi integration behaviour that
  still requires an interactive smoke test.

Keep the implementation small and provider-neutral. Do not modify agent-skills.
```
