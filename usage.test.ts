import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { access, appendFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { UsageLedger } from "./usage-ledger.ts";
import { addUsageRecord, emptyUsageTotals, formatUsageSummary, normalizeUsage, type UsageRecordV1 } from "./usage.ts";

function message(usage: Partial<AssistantMessage["usage"]> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "provider",
		model: "model",
		content: [],
		usage: {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usage,
		},
		stopReason: "stop",
		timestamp: Date.UTC(2026, 6, 16),
	};
}

function record(timestamp = "2026-07-16T12:00:00.000Z"): UsageRecordV1 {
	return {
		schemaVersion: 1,
		recordId: "record",
		timestamp,
		sessionId: "session",
		routeRunId: "run",
		responseIndex: 1,
		tier: "standard",
		tierSourceSkill: "test",
		routedSkills: ["test"],
		provider: "provider",
		model: "model",
		responseModel: null,
		thinking: "high",
		stopReason: "stop",
		usage: { input: 1, cacheRead: 2, cacheWrite: 3, cacheWrite1h: null, output: 4, reasoning: null },
		unknownUsageFields: ["cacheWrite1h", "reasoning"],
		providerReportedCost: null,
	};
}

describe("usage normalization", () => {
	it("preserves finite zero counters and marks only omitted fields unknown", () => {
		const normalized = normalizeUsage(message({ input: 0, cacheRead: 4, cacheWrite: 0, output: 2, cacheWrite1h: 1 }));
		assert.deepEqual(normalized.usage, { input: 0, cacheRead: 4, cacheWrite: 0, cacheWrite1h: 1, output: 2, reasoning: null });
		assert.deepEqual(normalized.unknownUsageFields, ["reasoning"]);
	});

	it("keeps cache-write-1h and reasoning separate from output totals", () => {
		const totals = addUsageRecord(emptyUsageTotals(), { ...record(), usage: { ...record().usage, cacheWrite1h: 2, output: 10, reasoning: 7 } });
		assert.equal(totals.cacheWrite1h, 2);
		assert.equal(totals.output, 10);
		assert.equal(totals.reasoning, 7);
		assert.equal(totals.unknown.reasoning, 0);
	});

	it("formats grouped counters as a compact table with readable unknown fields", () => {
		const totals = emptyUsageTotals();
		Object.assign(totals, {
			responses: 30,
			input: 1_752_492,
			cacheRead: 1_754_408,
			output: 4_379,
			reasoning: 649,
			unknown: { input: 0, cacheRead: 15, cacheWrite: 30, cacheWrite1h: 0, output: 0, reasoning: 0 },
		});

		const summary = formatUsageSummary(
			[{ route: "economy | openai-codex/gpt-5.6-luna", totals }],
			{ pending: 0, dropped: 0, writeErrors: 0 },
			0,
		);

		assert.match(summary, /Route\s+Resp\s+Input\s+Cache read\s+Cache write\/1h\s+Output\s+Reasoning/);
		assert.match(summary, /economy \| openai-codex\/gpt-5\.6-luna\s+30\s+1\.75M\s+1\.75M\s+0\/0\s+4\.4K\s+649/);
		assert.match(summary, /Unknown token fields \(response count\):\neconomy \| openai-codex\/gpt-5\.6-luna: cache-read 15, cache-write 30/);
		assert.match(summary, /Ledger health: pending 0; dropped 0; write errors 0; skipped records 0/);
	});
});

describe("usage ledger", () => {
	it("writes daily JSONL records and skips malformed lines on read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-"));
		try {
			const ledger = new UsageLedger({ ...UsageLedger.defaults(dir, 30, 1024 * 1024), maxBatchRecords: 1 });
			ledger.enqueue(record());
			await ledger.drain();
			const unexpectedUsageField = { ...record(), usage: { ...record().usage, unexpected: 1 } };
			await appendFile(join(dir, "2026-07-16.jsonl"), `not json\n{\"schemaVersion\":1}\n${JSON.stringify(unexpectedUsageField)}\n`, "utf8");
			const loaded = await ledger.readRecords();
			assert.equal(loaded.records.length, 1);
			assert.equal(loaded.records[0]?.tier, "standard");
			assert.equal(loaded.skipped, 3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads only canonical dated regular files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-files-"));
		try {
			await writeFile(join(dir, "2026-07-16.jsonl"), `${JSON.stringify(record())}\n`, "utf8");
			await writeFile(join(dir, "notes.jsonl"), `${JSON.stringify(record())}\n`, "utf8");
			await mkdir(join(dir, "2026-07-17.jsonl"));
			const ledger = new UsageLedger(UsageLedger.defaults(dir, 30, 1024 * 1024));

			const loaded = await ledger.readRecords();

			assert.equal(loaded.records.length, 1);
			assert.equal(loaded.records[0]?.tier, "standard");
			assert.equal(loaded.skipped, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("prunes expired records before reading summaries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-retention-"));
		try {
			const file = join(dir, "2020-01-01.jsonl");
			await writeFile(file, `${JSON.stringify(record())}\n`, "utf8");
			const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
			await utimes(file, old, old);
			const ledger = new UsageLedger(UsageLedger.defaults(dir, 1, 1024 * 1024));
			const loaded = await ledger.readRecords();
			assert.equal(loaded.records.length, 0);
			await assert.rejects(access(file));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("drops a failed write without throwing into routing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-error-"));
		try {
			const blockedPath = join(dir, "not-a-directory");
			await writeFile(blockedPath, "blocked", "utf8");
			const ledger = new UsageLedger(UsageLedger.defaults(blockedPath, 30, 1024 * 1024));
			ledger.enqueue(record());
			await ledger.drain();
			assert.deepEqual(ledger.health(), { pending: 0, dropped: 1, writeErrors: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("drops records when the bounded queue is full", () => {
		const ledger = new UsageLedger({ ...UsageLedger.defaults(join(tmpdir(), "unused-ledger"), 30, 1024), maxQueue: 1 });
		ledger.enqueue(record());
		ledger.enqueue(record("2026-07-17T12:00:00.000Z"));
		assert.deepEqual(ledger.health(), { pending: 1, dropped: 1, writeErrors: 0 });
	});
});
