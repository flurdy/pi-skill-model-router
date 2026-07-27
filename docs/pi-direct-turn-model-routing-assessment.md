# Safe model-tier routing for non-skill Pi turns

**Status:** Investigation and recommendation for `ai-tools-5mq`

**Runtime assessed:** Pi `0.80.6`

**Planning tier:** Premium — model selection affects spend, persistent user defaults, queued work, and concurrent Pi sessions.

## Decision

Do **not** add declarative default-tier routing or automatic prompt classification to the model-tier router on Pi 0.80.6.

Pi exposes a safe pre-provider boundary for the initial idle prompt, but its extension model/thinking setters are persistent rather than run-local. Queued steering and follow-up prompts bypass that boundary. Automatic switching would therefore overwrite global defaults, could override explicit startup/model choices, could not classify queued work consistently, and would amplify a cross-process last-writer-wins race already present during temporary skill routing.

The only conditionally safe addition is a deliberately narrow, user-initiated alias:

```text
/model-tier use <tier>
```

It would behave like a semantic `/model` selection, not automatic routing: idle-only, no queued messages, exact configured candidate, explicit metered confirmation, intentional persistence, no restoration, no automatic reapplication, and immediate deference to later `/model` or model cycling. This is worth implementing only if semantic tier names, candidate ordering, and tier thinking defaults provide enough convenience over Pi's existing `/model` UI.

| Approach | Verdict | Decisive reason |
| --- | --- | --- |
| Declarative `defaultTier` in router config | **No-go** | Extension context cannot distinguish a launcher/CLI/session choice from a settings default, and applying/restoring the tier writes global defaults. |
| User-selectable sticky mode | **No-go as an automatic mode** | Reapplying a mode would fight later explicit choices and retain the persistence race. |
| Explicit `/model-tier use <tier>` alias | **Conditional go** | One user-requested persistent selection adds no background restoration race and can fail closed on metered candidates. |
| Automatic prompt classification | **No-go** | No run-local setter or message-scoped final-expanded queued boundary; classifier cost/consent and correctness also remain unresolved. |

Until Pi exposes run-local model selection, choose the model for ordinary turns through the launcher, `--model`, `/model`, or model cycling. Keep router-controlled temporary switching limited to explicit/verified skill boundaries.

## Current behavior

The router has only two route triggers:

1. An idle `/skill:name` input is staged during `input`, then applied during `before_agent_start` only if Pi's expanded prompt still matches the same skill (`index.ts:445-473`).
2. A model-initiated `read` routes only when the canonical path exactly matches a skill Pi loaded for that turn (`index.ts:475-489`).

A plain prompt matches neither path. `before_agent_start` may repay an earlier owed restoration and caches loaded skill paths, but it does not select a tier for an ordinary prompt. Configuration contains no direct-turn tier or classifier (`config.ts:13-18`, `config.ts:107-149`).

Existing tests characterize the boundary:

- Loading skills into an ordinary turn does not switch until an exact loaded skill file is read (`routing.test.ts:811-819`).
- A staged skill route is discarded when the final expanded prompt does not match (`routing.test.ts:851-857`).
- A skill queued during streaming retains the active model and is not switched prematurely (`routing.test.ts:859-873`).
- Manual model selection cancels skill restoration and prevents later nested routing from fighting the user (`routing.test.ts:964-980`).

The focused baseline passed on 2026-07-20:

```text
fnm exec --using=.nvmrc npm test
# 50 tests passed, 0 failed
```

The harness mocks model and thinking setters in memory (`routing.test.ts:477-534`). It proves router state transitions but does not reproduce Pi's global settings writes; persistence and concurrency therefore require installed-runtime source evidence and integration coverage.

## Pi lifecycle boundaries

The installed `core/...` paths below are relative to `@earendil-works/pi-coding-agent/dist/` in Pi 0.80.6. Paths beginning `pi-agent-core/...` refer to its installed `@earendil-works/pi-agent-core` dependency.

| Boundary | Runtime evidence | Consequence for routing |
| --- | --- | --- |
| Initial input | `core/agent-session.js:776-898` emits `input`, expands skills/templates, validates the current model, then awaits `before_agent_start` before `_runAgentPrompt`. | The final initial prompt can be inspected before its first provider request. A failed/expired current model may fail validation before a proposed target is selected. |
| Extension ordering | `core/extensions/runner.js:794-834` awaits `before_agent_start` handlers sequentially. | Routing from this event completes before the agent starts, but extension order can still change prompt/system state; route only from the final event payload. |
| Queued steering/follow-up | `core/agent-session.js:791-823` emits `input` before final expansion, then expands, enqueues, and returns without another `before_agent_start`. Queue helpers feed the active core loop directly. | A queued prompt has no final-expanded, message-scoped routing boundary. An input-time switch can affect later calls but may also affect intervening tool or steering continuations, especially before a follow-up is drained. |
| Provider calls | `pi-agent-core/dist/agent.js:273-318` snapshots model/thinking into loop config; `core/agent-session.js:235-252` refreshes the current session model/thinking after each turn; `pi-agent-core/dist/agent-loop.js:77-200` applies that refresh before later provider calls. | Initial idle routing can precede the first snapshot. A queued-input switch can reach a subsequent call, but Pi does not bind that switch to one queued message or restore it after that message. Current policy therefore retains one route for the whole active run. |
| `before_provider_request` | `core/extensions/types.d.ts:492-498,762-790` permits payload replacement but does not select a provider/model in session state. | Rewriting a payload model would be provider-specific, bypass registry/thinking/session attribution, and cannot switch API adapters safely. It is not a provider-neutral escape hatch. |
| Model selection | `core/agent-session.js:1171-1188,1859-1868` changes agent state, appends session history, writes global default provider/model, reclamps thinking, and emits `model_select`. | `pi.setModel()` is not temporary. Every route and restoration changes global defaults. |
| Thinking selection | `core/agent-session.js:1248-1267` appends session history and writes the global default thinking level when it changes. | `pi.setThinkingLevel()` has the same persistence concern as model routing. |
| Settlement | `core/agent-session.js:728-765,280-298` processes retries, compaction recovery, and queued continuations before marking the run inactive and awaiting `agent_settled`. | `agent_settled` remains the right restoration boundary for existing skill runs, but restoration is another persistent write rather than a session-only reset. |
| Manual selection | `core/extensions/types.d.ts:590-597` exposes only `set`, `cycle`, and `restore`; startup model provenance is not exposed. | The router can recognize selections occurring during an active routed run, but cannot prove whether the initial model came from explicit CLI/launcher intent, session restore, scoped models, or settings. |

## Persisted-default race

Pi's settings storage locks and merges writes (`core/settings-manager.js:341-397`), which protects file integrity and unrelated fields. It does not provide compare-and-swap ownership for `defaultProvider`, `defaultModel`, or `defaultThinkingLevel`. Those fields remain last-writer-wins (`core/settings-manager.js:455-460,496-499`).

A possible two-process interleaving is:

1. Pi A temporarily routes from model S to model P; P is written as the global default.
2. Pi B explicitly selects model M; M is written as the global default.
3. Pi A settles and restores S; S overwrites B's newer explicit choice.

A hard kill between steps 1 and 3 can instead leave P as the next session's default. The current skill router is already exposed to this residual risk because it must call the public persistent setter. Applying the same switch/restore cycle to every plain prompt would make the exposure routine rather than skill-scoped.

The extension cannot repair this safely by rewriting `settings.json` itself: doing so would bypass Pi's settings manager, race other fields, and couple the router to an internal file schema. The proper prerequisite is a Pi-supported run/session-local model and thinking override.

## Alternatives considered

### 1. Declarative default tier

Possible mechanisms are selecting the tier at `session_start` or on each idle `before_agent_start`.

Rejected because:

- The extension sees the effective current model, not whether it came from explicit `--model`, a launcher, scoped models, a resumed session, or global defaults.
- An automatic choice could immediately override deliberate startup intent.
- Applying once still persists through `pi.setModel`; applying and restoring per run adds two background writes.
- Pi already supports an explicit persistent default model and launcher/CLI model selection, so duplicating that policy in the router adds ambiguity without a safer lifecycle.

### 2. User-selectable sticky mode

A mode such as `/model-tier auto standard` could promise to route later direct turns. Reapplying it after every prompt is rejected for the same persistence and explicit-precedence reasons as a declarative default.

The safe subset is not really a mode: `/model-tier use <tier>` resolves and selects once. The command must:

- reject while `!ctx.isIdle()` or `ctx.hasPendingMessages()` because extension commands execute immediately even during streaming;
- use only an exact configured and currently available candidate;
- show the exact model, tier thinking level, and persistent scope before confirming a `metered: true` candidate;
- fail closed on decline or without dialog-capable UI;
- call `pi.setModel()` only as the direct result of that user action and avoid a redundant model write when the target is already active;
- set the tier thinking level only after a successful selection;
- create no routed `RunState`, owe no restoration, and perform no later automatic write; and
- let `/model`, Ctrl+P cycling, and later tier selection win immediately.

A later skill route naturally snapshots this explicitly selected model/thinking as its original state and restores to it when the skill run settles.

This alias intentionally follows Pi's normal persistent-selection semantics. It cannot eliminate Pi's cross-process last-writer-wins behavior, but it does not add an asynchronous restoration that can overwrite a later choice.

### 3. Automatic classification

The best available initial hook is `before_agent_start`, where the final idle prompt is known. That is still insufficient:

- queued steer/follow-up prompts bypass it; their earlier `input` event can change the next-turn session model, but that change is not isolated to the queued message and may also route intervening tool/steering continuations;
- local heuristics can silently misclassify ambiguous, adversarial, multilingual, or mixed tasks;
- an LLM classifier adds latency, authentication, provider, metering, privacy, and failure policy before the actual request;
- metered or unknown candidates cannot route without a fresh, exact consent boundary;
- a manual `/model` choice made before the prompt has no exposed provenance for precedence; and
- every classification switch/restoration writes global defaults.

An opt-in automatic mode could clarify user intent but does not solve queue or persistence safety. Automatic classification is therefore no-go, not merely deferred implementation polish.

## Recommended approach

1. Keep current non-skill behavior unchanged on Pi 0.80.6.
2. Document launcher/`--model`/`/model` as the supported way to choose the ordinary-turn model.
3. Do not add `defaultTier`, classifier configuration, or direct-turn restoration state.
4. If semantic selection has demonstrated demand, implement only `/model-tier use <tier>` as an explicit persistent alias with the constraints above.
5. Reconsider per-prompt routing only after Pi supplies all of:
   - a model/thinking setter or `before_agent_start` result with `persist: false` semantics;
   - documented lifetime and automatic reset for that override;
   - startup model-choice provenance or an explicit session opt-in that later model selection cancels; and
   - a final-expanded, message-scoped boundary for queued user turns, or an explicit contract that queued prompts must inherit one whole-run route.

Rewriting provider payloads, patching Pi internals, or directly editing settings are out of scope and should remain no-go.

## Conditional implementation slices

These slices apply only if the explicit semantic alias is approved. They do not authorize automatic routing.

| # | Slice | Observable outcome | Acceptance evidence |
| --- | --- | --- | --- |
| 1 | Add idle-only tier selection | `/model-tier use standard` resolves one exact available candidate and configured thinking level; busy/pending sessions refuse without switching. | Focused harness tests assert one selection attempt when idle and none for streaming/pending/unavailable/unknown cases. |
| 2 | Preserve spend and user authority | Metered selection identifies the exact persistent target and requires confirmation; decline/no UI retains model/thinking; later manual selection is never reapplied or restored over. | Tests cover accept/decline/no-UI, assert no `RunState`/restoration, and verify a later `model_select` remains effective. |
| 3 | Document persistence and smoke installed Pi | README calls the command a persistent semantic alias, not run routing; installed Pi demonstrates selection survives restart and a later skill restores to that selected baseline. | `npm test` and typecheck pass; manual smoke uses a temporary `PI_CODING_AGENT_DIR`, verifies expected settings changes, busy refusal, and post-skill restoration. |

**Tracking recommendation:** No additional item now. `ai-tools-5mq` owns the investigation, and Beads searches for "direct turn", "default tier", and "sticky tier" found no related item. Create one focused follow-up through `/triage` only if the explicit alias is wanted or Pi gains a transient routing API.

## Test matrix

| Area | Case | Expected result |
| --- | --- | --- |
| Current baseline | Plain idle prompt | Exact current model/thinking retained; no route decision created. |
| Current baseline | Skills loaded but none read | No model selection until an exact loaded skill path is read. |
| Existing skills | Explicit unmetered `/skill:name` | Route before first provider request, then restore at settlement. |
| Existing skills | Explicit metered skill | Exact candidate confirmation; decline/no UI retains current route. |
| Existing skills | Implicit metered skill read | Never prompt; retain current route. |
| Queue safety | Direct steering or follow-up during streaming | Current router performs no switch/classification; one active route serves the full run. |
| Queue safety | `/model-tier use` while streaming or messages pending | Refuse immediately; no model/thinking/settings change. |
| Alias | Idle unmetered tier | Select exact first available configured candidate once and apply tier thinking. |
| Alias | Unknown tier or no available candidate | Warn and retain exact model/thinking. |
| Alias | Metered accept/decline/no UI | Select only after accept; otherwise retain exact state. |
| Explicit precedence | `/model`, model cycling, or later tier selection after alias | Latest explicit selection remains active; no auto-reapply or restoration. |
| Skill composition | Skill invoked after alias | Skill may upgrade by existing rules; settlement restores to alias-selected baseline. |
| Persistence | Alias selection | Only user-initiated Pi default updates; no later background restoration write. |
| Persistence | Temporary automatic route proposal | Must leave global settings byte-for-byte unchanged; block implementation until Pi API can prove this. |
| Concurrency | Two Pi processes, temporary route plus explicit selection | Explicit selection must not be overwritten; block automatic implementation until supported. |
| Failure | Candidate auth unavailable or `setModel` fails | Retain prior model/thinking; no partial tier state. |
| Automatic classifier prerequisite | Ambiguous/adversarial/multilingual/mixed prompt, classifier failure/timeout | Fail to current route without metered request or global settings change. |
| Runtime lifecycle | Retry, compaction recovery, abort, shutdown, queued continuations | One run route remains stable until true settlement; no premature restore. |

## Rollout and rollback

For the optional alias, first run focused tests, then smoke with `pi -e ./index.ts` and a temporary agent directory. Rollback is removal of the command while leaving existing skill routing and configuration compatible.

There is no rollout for automatic classification on Pi 0.80.6. Its rollback plan cannot compensate for defaults already overwritten by a crash or concurrent restore, which is another reason not to ship it.

## Residual risks and open questions

- Existing skill routing still temporarily persists model and thinking defaults. This assessment limits expansion of that risk; it does not remove it.
- Is semantic `/model-tier use` materially faster or clearer than `/model` with the current three-tier candidate lists? Without demonstrated use, YAGNI favors no new command.
- Will a future Pi release expose transient model/thinking selection and queued-turn lifecycle hooks? Re-evaluate against the installed version rather than assuming API shape.
- If a future automatic mode grants consent for a whole run, how will the UI explain that unknown queued prompts inherit the same metered route? Per-prompt consent remains safer unless Pi adds a final-expanded, message-scoped queued-turn hook.
