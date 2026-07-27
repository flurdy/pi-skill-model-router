# Pi model-tier usage ledger spike

- **Date:** 2026-07-16
- **Bead:** `ai-tools-b9n`
- **Pi:** 0.80.6

## Decision

**Conditional go:** retain an opt-in, local-only ledger for **Pi-normalized assistant-response usage** attributed to the active model-tier route.

Do not describe it as exact provider billing, subscription quota, or universally provider-observed usage. Pi exposes normalized token fields on finalized assistant messages, but does not expose field-level provenance, a native router-run identifier, skill/tier attribution, or provider-reported cost. Pi's `usage.cost` is calculated from configured local model prices and is deliberately omitted from the ledger.

## Evidence

- `message_end` exposes finalized `AssistantMessage` usage, provider, model, optional response model, stop reason, and timestamp.
- It runs before `SessionManager` persists the assistant message, so the ledger captures `event.message` directly rather than rescanning session history.
- The router's existing `RunState` establishes the initial route, supports nested upgrades, tracks skills, and restores only after `agent_settled`.
- `agent_settled` occurs after retries, compaction recovery, and queued continuations. Attribution is disabled before restoration to avoid leaking a failed restoration into a later unrelated run.
- Pi runs extension event handlers synchronously in its lifecycle. The writer therefore only enqueues an immutable record in `message_end`; file writes are batched asynchronous drains.

## Record contract

Each v1 JSONL record contains an opaque Pi session ID, locally generated route-run and record IDs, response index, tier/source skill/routed skill list, actual provider/model, thinking level, stop reason, and individual input/cache-read/cache-write/cache-write-1h/output/reasoning fields.

It excludes prompts, responses, repository paths, session-file paths, response IDs, account identifiers, credentials, and cost. Positive finite Pi-normalized counters are retained; zero, absent, and invalid counters are conservatively represented as unknown because Pi has no field-availability bitmap. Reasoning remains a subset of output and is never added again.

## Operational policy

- Global configuration only; disabled by default.
- Local path: `~/.pi/agent/model-tier-router/usage/v1/`.
- Directory/files use restrictive modes (`0700` / `0600`).
- Bounded queue: 1,000 records; batch target: 64 records or 32 KiB.
- Default retention: 30 days and 10 MiB.
- Write failures and queue pressure increment health counters; they never alter routing or restoration.
- Parent sessions do not aggregate separately spawned Pi subprocesses.

## Validation

Focused unit tests cover normalization, reasoning separation, JSONL persistence, malformed-line skipping, bounded-queue drops, existing router lifecycle behavior, and configuration validation. A local Node 26 synthetic benchmark of the synchronous `message_end` critical path ran 100,000 record normalizations/ID+timestamp constructions in 66.57 ms (0.666 µs each) and 100,000 bounded-queue enqueues in 2.93 ms (0.029 µs each); filesystem appends are outside that path and run in asynchronous batches. Interactive Pi smoke testing remains the final integration check for actual provider usage behavior and route upgrades.
