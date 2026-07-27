import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig, type UsageLedgerConfig } from "./config.ts";
import modelTierRouter, { reconcileUsageLedger, type UsageLedgerPort } from "./index.ts";
import type { UsageRecordV1 } from "./usage.ts";
import {
	canonicalPath,
	decideTier,
	maxThinkingLevel,
	parseSkillRouting,
	permitsImplicitRouting,
	requiresConsentConfirmation,
	resolveCandidatePolicy,
	selectCandidate,
	selectRouteCandidate,
	type RouteDecisionRecord,
	type TierRoute,
} from "./routing.ts";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

function assistantMessage(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider,
		model: modelId,
		content: [],
		usage: {
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.UTC(2026, 6, 16),
	};
}

const standard: TierRoute = {
	rank: 20,
	thinking: "high",
	candidates: [
		{ model: "missing/first", metered: false },
		{ model: "provider/model/id", metered: false },
	],
};

class FakeUsageLedger implements UsageLedgerPort {
	starts = 0;
	drains = 0;
	private readonly healthState: { pending: number; dropped: number; writeErrors: number };
	private readonly events: string[];
	private readonly name: string;

	constructor(
		healthState = { pending: 0, dropped: 0, writeErrors: 0 },
		events: string[] = [],
		name = "ledger",
	) {
		this.healthState = healthState;
		this.events = events;
		this.name = name;
	}

	start(): void {
		this.starts++;
		this.events.push(`${this.name}:start`);
	}

	health(): { pending: number; dropped: number; writeErrors: number } {
		return this.healthState;
	}

	enqueue(_record: UsageRecordV1): void {}

	async drain(): Promise<void> {
		this.drains++;
		this.events.push(`${this.name}:drain`);
	}

	async drainWithin(_timeoutMs: number): Promise<void> {
		await this.drain();
	}

	async readRecords(): Promise<{ records: UsageRecordV1[]; skipped: number }> {
		return { records: [], skipped: 0 };
	}
}

describe("skill routing metadata", () => {
	it("extracts router fields and ignores Claude and second-opinion model fields", () => {
		const metadata = parseSkillRouting(`---
name: review
model: haiku
model-tier: premium
model-cost-policy: deliberate-premium
model-metered-policy: ask-above-standard
model-second-opinion-tier: independent-reasoning
effort: xhigh
---
Body
`);
		assert.deepEqual(metadata, {
			tier: "premium",
			costPolicy: "deliberate-premium",
			meteredPolicy: "ask-above-standard",
			effort: "xhigh",
		});
	});
});

describe("tier decisions", () => {
	it("establishes a first tier and permits only higher-ranked upgrades", () => {
		const economy = { tier: "economy", rank: 10 };
		const standard = { tier: "standard", rank: 20 };
		const premium = { tier: "premium", rank: 40 };
		assert.equal(decideTier(undefined, economy), "initial");
		assert.equal(decideTier(economy, standard), "upgrade");
		assert.equal(decideTier(standard, premium), "upgrade");
		assert.equal(decideTier(premium, economy), "retain-lower");
	});

	it("uses ranks rather than names for private routes", () => {
		const privateLow = { tier: "private-low", rank: 25 };
		const privateHigh = { tier: "private-high", rank: 30 };
		assert.equal(decideTier(privateLow, privateHigh), "upgrade");
		assert.equal(decideTier(privateHigh, privateLow), "retain-lower");
	});

	it("retains the root route for equal-ranked tiers", () => {
		assert.equal(decideTier({ tier: "premium", rank: 40 }, { tier: "private-equivalent", rank: 40 }), "retain-equal");
	});

	it("permits thinking upgrades but not downgrades", () => {
		assert.equal(maxThinkingLevel("medium", "xhigh"), "xhigh");
		assert.equal(maxThinkingLevel("high", "low"), "high");
		assert.equal(maxThinkingLevel("max", "xhigh"), "max");
	});
});

describe("candidate selection", () => {
	it("requires confirmation only for unresolved metered or unknown-cost consent", () => {
		assert.equal(requiresConsentConfirmation({ meteredClassification: true, consentPolicy: "ask" }), true);
		assert.equal(requiresConsentConfirmation({ meteredClassification: "unknown", consentPolicy: "ask" }), true);
		assert.equal(requiresConsentConfirmation({ meteredClassification: true, consentPolicy: "allow" }), false);
		assert.equal(requiresConsentConfirmation({ meteredClassification: "unknown", consentPolicy: "allow" }), true);
		assert.equal(requiresConsentConfirmation({ meteredClassification: false, consentPolicy: "not-needed" }), false);
		assert.equal(permitsImplicitRouting({ meteredClassification: "unknown", consentPolicy: "allow" }), false);
		assert.equal(permitsImplicitRouting({ meteredClassification: true, consentPolicy: "allow" }), true);
	});

	it("resolves global and project candidate policy without allowing project downgrades", () => {
		const metered = { metered: true, consent: "allow" as const };
		const unmetered = { metered: false, consent: "ask" as const };
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model", metered: true }, "global", metered), {
			meteredClassification: true,
			consentPolicy: "allow",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model", metered: false }, "project", metered), {
			meteredClassification: true,
			consentPolicy: "allow",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model", metered: true }, "project", unmetered), {
			meteredClassification: true,
			consentPolicy: "ask",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model", metered: false }, "project"), {
			meteredClassification: "unknown",
			consentPolicy: "ask",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model" }, "global", metered), {
			meteredClassification: true,
			consentPolicy: "allow",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model" }, "global"), {
			meteredClassification: "unknown",
			consentPolicy: "ask",
		});
		assert.deepEqual(resolveCandidatePolicy({ model: "provider/model" }, "project", unmetered), {
			meteredClassification: false,
			consentPolicy: "not-needed",
		});
	});

	it("uses only exact configured candidates for pre-launch selection", () => {
		const selected = selectCandidate(standard, [model("provider", "model/id"), model("other", "first")]);
		assert.deepEqual(selected, { model: "provider/model/id", metered: false });
	});

	it("does not broaden to arbitrary available models when configured candidates are exhausted", () => {
		assert.equal(selectCandidate(standard, [model("provider", "different")]), undefined);
	});

	it("draws weighted candidates at cumulative boundaries after eligibility filtering", () => {
		const route: TierRoute = {
			rank: 20,
			thinking: "high",
			selection: "weighted-random",
			candidates: [
				{ model: "provider/a", metered: false, weight: 3 },
				{ model: "provider/b", metered: true, weight: 1 },
			],
		};
		const available = [model("provider", "a"), model("provider", "b")];
		assert.equal(selectRouteCandidate(route, available, () => true, () => 0).candidate?.model, "provider/a");
		assert.equal(selectRouteCandidate(route, available, () => true, () => 0.749).candidate?.model, "provider/a");
		assert.equal(selectRouteCandidate(route, available, () => true, () => 0.75).candidate?.model, "provider/b");
		const filtered = selectRouteCandidate(route, available, (candidate) => !candidate.metered, () => 0.99);
		assert.equal(filtered.candidate?.model, "provider/a");
		assert.deepEqual(filtered.pool, [{ model: "provider/a", weight: 3 }]);
		const availableFallback = selectRouteCandidate(route, [model("provider", "b")], () => true, () => 0);
		assert.equal(availableFallback.candidate?.model, "provider/b");
		assert.deepEqual(availableFallback.pool, [{ model: "provider/b", weight: 1 }]);
	});
});

describe("configuration", () => {
	it("ships only the portable three-tier taxonomy", () => {
		const example = JSON.parse(
			readFileSync(new URL("./model-tier-router.example.json", import.meta.url), "utf8"),
		) as { modelPolicies: Record<string, { metered: boolean; consent: string }>; tiers: Record<string, TierRoute> };
		const { tiers } = example;
		assert.deepEqual(example.modelPolicies, {
			"provider/cheap-model-id": { metered: false },
			"provider/workflow-model-id": { metered: false },
			"provider/premium-model-id": { metered: true, consent: "allow" },
		});
		assert.deepEqual(Object.keys(tiers), ["economy", "standard", "premium"]);
		assert.deepEqual(tiers.economy.candidates, [{ model: "provider/cheap-model-id" }]);
		assert.deepEqual(tiers.standard.candidates, [{ model: "provider/workflow-model-id" }]);
		assert.deepEqual(tiers.premium.candidates, [{ model: "provider/premium-model-id" }]);
		assert.ok(tiers.economy.rank < tiers.standard.rank);
		assert.ok(tiers.standard.rank < tiers.premium.rank);
	});

	it("ships a validated, credential-free opinionated policy example", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			readFileSync(new URL("./model-tier-router.opinionated.example.json", import.meta.url), "utf8"),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(Object.keys(result.config.tiers), ["economy", "standard", "premium"]);
		assert.deepEqual(result.config.usageLedger, { enabled: true, retentionDays: 30, maxBytes: 10 * 1024 * 1024 });
		assert.deepEqual(result.config.tiers.economy.candidates, [
			{ model: "openai-codex/gpt-5.6-luna", weight: 6 },
			{ model: "anthropic/claude-haiku-4-5", weight: 1 },
			{ model: "google/gemini-3.5-flash", weight: 1 },
		]);
		assert.deepEqual(result.config.tiers.standard.candidates, [
			{ model: "openai-codex/gpt-5.6-terra", weight: 3 },
			{ model: "anthropic/claude-sonnet-5", weight: 1 },
		]);
		assert.deepEqual(result.config.tiers.premium.candidates, [
			{ model: "openai-codex/gpt-5.6-sol", weight: 3 },
			{ model: "anthropic/claude-fable-5", weight: 1 },
			{ model: "anthropic/claude-opus-4-8", weight: 1 },
		]);
		assert.equal(result.config.tiers.economy.selection, "weighted-random");
		assert.equal(result.config.tiers.standard.selection, "weighted-random");
		assert.equal(result.config.tiers.premium.selection, "weighted-random");
		assert.ok(result.config.tiers.economy.rank < result.config.tiers.standard.rank);
		assert.ok(result.config.tiers.standard.rank < result.config.tiers.premium.rank);
	});

	it("loads global configuration and merges trusted project tiers", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				enabled: true,
				restoreAfterRun: false,
				tiers: {
					standard: { rank: 20, thinking: "high", candidates: [{ model: "global/standard", metered: false }] },
					cheap: { rank: 10, thinking: "low", candidates: [] },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "model-tier-router.json"),
			JSON.stringify({
				tiers: {
					standard: { rank: 25, thinking: "medium", candidates: [{ model: "project/standard", metered: true }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.equal("restoreAfterRun" in result.config, false);
		assert.equal(result.config.tiers.standard.rank, 25);
		assert.equal(result.config.tiers.standard.candidates[0]?.model, "project/standard");
		assert.equal(result.config.tiers.cheap.rank, 10);
		assert.equal(result.loadedPaths.length, 2);
	});

	it("keeps arbitrary private tier names syntactically valid", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				tiers: {
					"private-review": { rank: 30, thinking: "high", candidates: [{ model: "private/review", metered: false }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.tiers["private-review"]?.candidates[0]?.model, "private/review");
	});

	it("ignores an untrusted project override", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ enabled: true }));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ enabled: false }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.loadedPaths, [join(agentDir, "model-tier-router.json")]);
	});

	it("loads an opt-in usage ledger only from global configuration", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ usageLedger: { enabled: true, retentionDays: 14, maxBytes: 4096 } }));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ usageLedger: { enabled: false, retentionDays: 7, maxBytes: 2048 } }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.deepEqual(result.config.usageLedger, { enabled: true, retentionDays: 14, maxBytes: 4096 });
		assert.match(result.warnings.join("\n"), /usageLedger is global-only and was ignored/);
	});

	it("loads global exact-model consent and derives conservative classification floors", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				modelPolicies: {
					"provider/allowed": { metered: true, consent: "allow" },
					"provider/conflict": { metered: false, consent: "allow" },
					"provider/invalid-consent": { metered: true, consent: "forever" },
					"provider/missing-metered": { consent: "allow" },
					invalid: { metered: true, consent: "allow" },
				},
				tiers: {
					first: { rank: 10, thinking: "low", candidates: [
						{ model: "provider/allowed", metered: true },
						{ model: "provider/conflict", metered: true },
						{ model: "provider/shared", metered: false },
					] },
					second: { rank: 20, thinking: "high", candidates: [
						{ model: "provider/shared", metered: true },
						{ model: "provider/invalid-consent", metered: true },
					] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.deepEqual(result.config.modelPolicies["provider/allowed"], { metered: true, consent: "allow" });
		assert.deepEqual(result.config.modelPolicies["provider/conflict"], { metered: false, consent: "allow" });
		assert.deepEqual(result.config.modelPolicies["provider/shared"], { metered: true, consent: "ask" });
		assert.deepEqual(result.config.modelPolicies["provider/invalid-consent"], { metered: true, consent: "ask" });
		assert.deepEqual(result.config.tiers.first.candidates[0], { model: "provider/allowed", metered: true });
		assert.equal(result.config.modelPolicies["provider/missing-metered"], undefined);
		assert.equal(result.config.modelPolicies.invalid, undefined);
		assert.match(result.warnings.join("\n"), /provider\/conflict.*conflicts with global candidate classification/);
		assert.match(result.warnings.join("\n"), /provider\/shared.*conflicting global candidate classifications/);
		assert.match(result.warnings.join("\n"), /provider\/invalid-consent.*invalid consent/);
		assert.match(result.warnings.join("\n"), /provider\/missing-metered.*boolean metered flag/);
		assert.match(result.warnings.join("\n"), /modelPolicies key "invalid" must use provider\/model/);
	});

	it("ignores project model policies and treats project-only unmetered candidates as unknown-cost", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({
			modelPolicies: { "provider/known": { metered: true, consent: "allow" } },
			tiers: { standard: { rank: 20, thinking: "high", candidates: [{ model: "provider/known", metered: true }] } },
		}));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({
			modelPolicies: {
				"provider/known": { metered: false, consent: "allow" },
				"provider/project-only": { metered: false, consent: "allow" },
			},
			tiers: {
				standard: { rank: 25, thinking: "medium", candidates: [{ model: "provider/known", metered: false }] },
				private: { rank: 30, thinking: "high", candidates: [{ model: "provider/project-only", metered: false }] },
			},
		}));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.deepEqual(result.config.modelPolicies["provider/known"], { metered: true, consent: "allow" });
		assert.equal(result.config.modelPolicies["provider/project-only"], undefined);
		assert.equal(result.config.tierSources.standard, "project");
		assert.equal(result.config.tierSources.private, "project");
		assert.deepEqual(
			resolveCandidatePolicy(result.config.tiers.standard.candidates[0]!, result.config.tierSources.standard!, result.config.modelPolicies["provider/known"]),
			{ meteredClassification: true, consentPolicy: "allow" },
		);
		assert.deepEqual(
			resolveCandidatePolicy(result.config.tiers.private.candidates[0]!, result.config.tierSources.private!, result.config.modelPolicies["provider/project-only"]),
			{ meteredClassification: "unknown", consentPolicy: "ask" },
		);
		assert.match(result.warnings.join("\n"), /modelPolicies is global-only and was ignored/);
		assert.match(result.warnings.join("\n"), /provider\/project-only.*unknown-cost/);
	});

	it("validates weighted-random tiers and disables malformed weighted routing", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ tiers: {
			weighted: {
				rank: 20,
				thinking: "high",
				selection: "weighted-random",
				candidates: [
					{ model: "provider/a", metered: false, weight: 3 },
					{ model: "provider/b", metered: true, weight: 1 },
				],
			},
			invalid: {
				rank: 30,
				thinking: "high",
				selection: "weighted-random",
				candidates: [{ model: "provider/c", metered: false, weight: 0 }],
			},
			overMaximum: {
				rank: 31,
				thinking: "high",
				selection: "weighted-random",
				candidates: [{ model: "provider/large", metered: false, weight: 101 }],
			},
			fractional: {
				rank: 32,
				thinking: "high",
				selection: "weighted-random",
				candidates: [{ model: "provider/fractional", metered: false, weight: 1.5 }],
			},
			ordered: {
				rank: 40,
				thinking: "high",
				candidates: [{ model: "provider/d", metered: false, weight: 2 }],
			},
			malformed: {
				rank: 50,
				thinking: "high",
				selection: "weighted-random",
				candidates: [
					{ model: "provider/paid", metered: true, weight: 1 },
					{ model: "provider/broken" },
				],
			},
		} }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.tiers.weighted.selection, "weighted-random");
		assert.deepEqual(result.config.tiers.weighted.candidates.map((candidate) => candidate.weight), [3, 1]);
		assert.equal(result.config.tiers.invalid.selection, "weighted-random");
		assert.equal(result.config.tiers.invalid.routingDisabled, true);
		assert.equal(selectRouteCandidate(result.config.tiers.invalid, [model("provider", "c")]).candidate, undefined);
		assert.equal(result.config.tiers.overMaximum.routingDisabled, true);
		assert.equal(selectRouteCandidate(result.config.tiers.overMaximum, [model("provider", "large")]).candidate, undefined);
		assert.equal(result.config.tiers.fractional.routingDisabled, true);
		assert.equal(selectRouteCandidate(result.config.tiers.fractional, [model("provider", "fractional")]).candidate, undefined);
		assert.equal(result.config.tiers.ordered.selection, "first-available");
		assert.equal(result.config.tiers.ordered.candidates[0]?.weight, undefined);
		assert.equal(result.config.tiers.malformed.routingDisabled, true);
		assert.equal(selectRouteCandidate(result.config.tiers.malformed, [model("provider", "paid")]).candidate, undefined);
		assert.match(result.warnings.join("\n"), /weight must be an integer from 1 to 100; tier routing disabled/);
		assert.match(result.warnings.join("\n"), /weight is ignored by first-available selection/);
	});

	it("fails closed on an invalid explicit selection policy instead of defaulting to first-available", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ tiers: {
			typo: {
				rank: 60,
				thinking: "high",
				selection: "weighted_random",
				candidates: [
					{ model: "provider/paid", metered: true, weight: 3 },
					{ model: "provider/free", metered: false, weight: 1 },
				],
			},
		} }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.tiers.typo.selection, "first-available");
		assert.equal(result.config.tiers.typo.routingDisabled, true);
		assert.equal(
			selectRouteCandidate(result.config.tiers.typo, [model("provider", "paid"), model("provider", "free")]).candidate,
			undefined,
		);
		assert.match(result.warnings.join("\n"), /has an invalid selection policy; tier routing disabled/);
		assert.doesNotMatch(result.warnings.join("\n"), /weight is ignored by first-available selection/);
	});

	it("allows policy-first candidates and fails closed when classification is unresolved", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				modelPolicies: { "provider/policy": { metered: true, consent: "allow" } },
				tiers: {
					premium: { rank: 40, thinking: "high", candidates: [{ model: "provider/policy" }, { model: "provider/unresolved" }, { model: "provider/invalid", metered: "false" }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.deepEqual(result.config.tiers.premium.candidates, [{ model: "provider/policy" }, { model: "provider/unresolved" }]);
		assert.deepEqual(
			resolveCandidatePolicy(result.config.tiers.premium.candidates[0]!, "global", result.config.modelPolicies["provider/policy"]),
			{ meteredClassification: true, consentPolicy: "allow" },
		);
		assert.deepEqual(
			resolveCandidatePolicy(result.config.tiers.premium.candidates[1]!, "global", result.config.modelPolicies["provider/unresolved"]),
			{ meteredClassification: "unknown", consentPolicy: "ask" },
		);
		assert.match(result.warnings.join("\n"), /metered must be boolean when provided/);
	});
});

describe("usage ledger reload", () => {
	const config: UsageLedgerConfig = { enabled: true, retentionDays: 30, maxBytes: 4096 };

	it("reuses an unchanged ledger with pending records and health state", async () => {
		const ledger = new FakeUsageLedger({ pending: 2, dropped: 3, writeErrors: 1 });
		const managed = await reconcileUsageLedger(
			{ ledger, config },
			{ ...config },
			() => assert.fail("unchanged configuration must not create a ledger"),
		);

		assert.equal(managed.ledger, ledger);
		assert.deepEqual(managed.ledger?.health(), { pending: 2, dropped: 3, writeErrors: 1 });
		assert.equal(ledger.starts, 0);
		assert.equal(ledger.drains, 0);
	});

	it("drains before replacing or disabling a ledger", async () => {
		const events: string[] = [];
		const current = new FakeUsageLedger(undefined, events, "current");
		const replacement = new FakeUsageLedger(undefined, events, "replacement");
		const nextConfig = { ...config, maxBytes: 8192 };

		const replaced = await reconcileUsageLedger(
			{ ledger: current, config },
			nextConfig,
			() => replacement,
		);
		const disabled = await reconcileUsageLedger(replaced, undefined, () => assert.fail("disabled configuration must not create a ledger"));

		assert.deepEqual(events, ["current:drain", "replacement:start", "replacement:drain"]);
		assert.equal(replaced.ledger, replacement);
		assert.equal(replaced.config, nextConfig);
		assert.deepEqual(disabled, { ledger: undefined, config: undefined });
	});
});

describe("path safety", () => {
	it("canonicalises symlinked skill paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const skillDir = join(root, "real-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test\ndescription: test\n---\n");
		symlinkSync(skillDir, join(root, "linked-skill"));
		assert.equal(await canonicalPath("linked-skill/SKILL.md", root), join(skillDir, "SKILL.md"));
	});
});

type EventHandler = (event: any, ctx: any) => unknown;

interface HarnessSkill {
	tier: string;
	rank: number;
	effort?: string;
	costPolicy?: string;
	meteredPolicy?: string;
	metered?: boolean;
	candidates?: Array<{ model: string; metered?: boolean; weight?: number }>;
	selection?: "first-available" | "weighted-random";
	configure?: boolean;
	available?: boolean;
	project?: boolean;
}

interface RouterHarnessOptions {
	clampThinking?: (requested: string, modelId: string) => string;
	confirm?: boolean;
	hasUI?: boolean;
	idle?: boolean;
	legacyRestoreAfterRun?: boolean;
	modelPolicies?: Record<string, { metered: boolean; consent?: string }>;
	random?: () => number;
	routeImplicitSkillReads?: boolean;
	setModelResults?: Record<string, boolean[]>;
}

interface RouterHarness {
	ctx: any;
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	stageSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	startSkill(name: string): Promise<void>;
	invokeSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	loadSkillsForTurn(...names: string[]): Promise<void>;
	readSkill(name: string): Promise<void>;
	invokeCommand(name: string, args?: string): Promise<void>;
	selectManually(next: Model<Api>): Promise<void>;
	setIdle(next: boolean): void;
	setModelPolicies(policies: Record<string, { metered: boolean; consent?: string }>): void;
	setTierRoute(tier: string, route: unknown): void;
	confirmations: Array<{ title: string; message: string }>;
	modelSelectionAttempts: string[];
	modelSelections: string[];
	thinkingSelections: string[];
	notifications: string[];
	usageRecords: UsageRecordV1[];
}

async function createRouterHarness(
	skills: Record<string, HarnessSkill>,
	options: RouterHarnessOptions = {},
): Promise<RouterHarness> {
	const root = mkdtempSync(join(tmpdir(), "model-tier-router-events-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const skillDir = join(root, "skills");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(skillDir, { recursive: true });

	const commands: Array<Record<string, any>> = [];
	const skillsByName = new Map<string, Skill>();
	const globalTiers: Record<string, unknown> = {};
	const projectTiers: Record<string, unknown> = {};
	for (const [name, skill] of Object.entries(skills)) {
		const path = join(skillDir, `${name}.md`);
		const routingMetadata = [
			`model-tier: ${skill.tier}`,
			skill.effort ? `effort: ${skill.effort}` : undefined,
			skill.costPolicy ? `model-cost-policy: ${skill.costPolicy}` : undefined,
			skill.meteredPolicy ? `model-metered-policy: ${skill.meteredPolicy}` : undefined,
		].filter((line): line is string => line !== undefined);
		writeFileSync(path, `---\nname: ${name}\ndescription: test\n${routingMetadata.join("\n")}\n---\nRun ${name}.\n`);
		const sourceInfo = {
			path,
			source: "skill",
			scope: "project" as const,
			origin: "top-level" as const,
			baseDir: skillDir,
		};
		commands.push({
			name: `skill:${name}`,
			source: "skill",
			sourceInfo,
		});
		skillsByName.set(name, {
			name,
			description: "test",
			filePath: path,
			baseDir: skillDir,
			sourceInfo,
			disableModelInvocation: false,
		});
		if (skill.configure !== false) {
			const tiers = skill.project ? projectTiers : globalTiers;
			tiers[skill.tier] = {
				rank: skill.rank,
				thinking: "high",
				selection: skill.selection,
				candidates: skill.candidates ?? [{ model: `provider/${skill.tier}`, metered: skill.metered ?? false }],
			};
		}
	}
	const globalConfigPath = join(agentDir, "model-tier-router.json");
	const writeGlobalConfig = (modelPolicies = options.modelPolicies ?? {}) => writeFileSync(
		globalConfigPath,
		JSON.stringify({
			enabled: true,
			routeImplicitSkillReads: options.routeImplicitSkillReads ?? true,
			modelPolicies,
			...(options.legacyRestoreAfterRun === undefined ? {} : { restoreAfterRun: options.legacyRestoreAfterRun }),
			tiers: globalTiers,
		}),
	);
	writeGlobalConfig();
	if (Object.keys(projectTiers).length > 0) {
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ tiers: projectTiers }));
	}

	const original = model("provider", "original");
	let currentModel = original;
	let thinking = "low";
	const available = [
		original,
		model("provider", "manual"),
		...Object.values(skills)
			.filter((skill) => skill.available !== false)
			.flatMap((skill) => (skill.candidates ?? [{ model: `provider/${skill.tier}`, metered: skill.metered ?? false }])
				.map((candidate) => {
					const separator = candidate.model.indexOf("/");
					return model(candidate.model.slice(0, separator), candidate.model.slice(separator + 1));
				})),
	];
	const handlers = new Map<string, EventHandler[]>();
	const registeredCommands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const setModelResults = new Map(
		Object.entries(options.setModelResults ?? {}).map(([id, results]) => [id, [...results]]),
	);
	let idle = options.idle ?? true;
	const confirmations: Array<{ title: string; message: string }> = [];
	const modelSelectionAttempts: string[] = [];
	const modelSelections: string[] = [];
	const thinkingSelections: string[] = [];
	const notifications: string[] = [];
	const usageRecords: UsageRecordV1[] = [];

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		mode: "tui",
		get model() {
			return currentModel;
		},
		modelRegistry: { getAvailable: () => available },
		isIdle: () => idle,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "test-session" },
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return options.confirm ?? true;
			},
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
		},
	};

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
		return results;
	}

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
			registeredCommands.set(name, command);
		},
		getCommands: () => commands,
		getThinkingLevel: () => thinking,
		setThinkingLevel(next: string) {
			thinking = options.clampThinking?.(next, currentModel.id) ?? next;
			thinkingSelections.push(thinking);
		},
		async setModel(next: Model<Api>) {
			const id = `${next.provider}/${next.id}`;
			modelSelectionAttempts.push(id);
			const configuredResults = setModelResults.get(id);
			if ((configuredResults?.shift() ?? true) === false) return false;
			const previousModel = currentModel;
			currentModel = next;
			modelSelections.push(id);
			await emit("model_select", { model: next, previousModel, source: "set" });
			return true;
		},
	} as unknown as ExtensionAPI;

	modelTierRouter(pi, {
		agentDir,
		random: options.random,
		usageLedger: {
			start() {},
			health: () => ({ pending: 0, dropped: 0, writeErrors: 0 }),
			enqueue: (record) => usageRecords.push(record),
			drain: async () => undefined,
			drainWithin: async () => undefined,
			readRecords: async () => ({ records: [...usageRecords], skipped: 0 }),
		},
	});
	await emit("session_start", { reason: "startup" });

	async function stageSkill(name: string, options: { streamingBehavior?: "steer" | "followUp" } = {}): Promise<void> {
		await emit("input", {
			text: `/skill:${name}`,
			source: "interactive",
			streamingBehavior: options.streamingBehavior,
		});
	}

	async function startSkill(name: string): Promise<void> {
		const command = commands.find((item) => item.name === `skill:${name}`);
		assert.ok(command);
		await emit("before_agent_start", {
			prompt: `<skill name="${name}" location="${command.sourceInfo.path}">\nReferences are relative to ${skillDir}.\n\nRun ${name}.\n</skill>`,
			systemPromptOptions: { skills: [] },
		});
	}

	return {
		ctx,
		emit,
		stageSkill,
		startSkill,
		async invokeSkill(name, options = {}) {
			await stageSkill(name, options);
			if (!options.streamingBehavior) await startSkill(name);
		},
		async loadSkillsForTurn(...names) {
			const loaded = names.map((name) => skillsByName.get(name));
			assert.ok(loaded.every((skill) => skill !== undefined));
			await emit("before_agent_start", {
				prompt: "Use a loaded skill when relevant.",
				systemPromptOptions: { skills: loaded },
			});
		},
		async readSkill(name) {
			const skill = skillsByName.get(name);
			assert.ok(skill);
			await emit("tool_call", { toolName: "read", toolCallId: `read-${name}`, input: { path: skill.filePath } });
		},
		async invokeCommand(name, args = "") {
			const command = registeredCommands.get(name);
			assert.ok(command);
			await command.handler(args, ctx);
		},
		async selectManually(next) {
			const previousModel = currentModel;
			currentModel = next;
			await emit("model_select", { model: next, previousModel, source: "set" });
		},
		setIdle(next) {
			idle = next;
		},
		setModelPolicies(policies) {
			writeGlobalConfig(policies);
		},
		setTierRoute(tier, route) {
			globalTiers[tier] = route;
			writeGlobalConfig();
		},
		confirmations,
		modelSelectionAttempts,
		modelSelections,
		thinkingSelections,
		notifications,
		usageRecords,
	};
}

function lastRouteDecision(harness: RouterHarness): RouteDecisionRecord {
	const status = harness.notifications.at(-1);
	assert.ok(status, "expected /model-tier status output");
	const line = status.split("\n").find((entry) => entry.startsWith("last route decision: "));
	assert.ok(line, "expected a normalized route-decision record in status output");
	return JSON.parse(line.slice("last route decision: ".length)) as RouteDecisionRecord;
}

describe("extension lifecycle", () => {
	it("routes economy, standard, and premium while honoring declared effort", async () => {
		const harness = await createRouterHarness({
			scan: { tier: "economy", rank: 10, effort: "low" },
			build: { tier: "standard", rank: 20, effort: "high" },
			review: { tier: "premium", rank: 40, effort: "xhigh" },
		});

		await harness.invokeSkill("scan");
		await harness.invokeSkill("build");
		await harness.invokeSkill("review");

		assert.deepEqual(harness.modelSelections, ["provider/economy", "provider/standard", "provider/premium"]);
		assert.deepEqual(harness.thinkingSelections, ["low", "high", "xhigh"]);
	});

	it("stages explicit routing until the expanded skill starts, then restores after settlement", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20, effort: "medium" } });
		await harness.stageSkill("review");
		assert.deepEqual(harness.modelSelections, []);

		await harness.startSkill("review");
		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /review → standard → provider\/standard \(thinking:medium\)/);
		await harness.invokeCommand("model-tier", "status");
		assert.deepEqual(lastRouteDecision(harness), {
			requestedTier: "standard",
			effectiveTier: "standard",
			candidate: { model: "provider/standard", metered: false },
			effectiveModel: { provider: "provider", model: "standard" },
			thinkingLevel: "medium",
			meteredClassification: false,
			consentPolicy: "not-needed",
			consentBasis: "not-needed",
			selectionPolicy: "first-available",
			selectionPool: [{ model: "provider/standard", weight: 1 }],
			reason: "routed",
			warnings: [],
			restoration: "pending",
		});

		await harness.emit("agent_settled");
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).restoration, "restored");
		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/original"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "low"]);
		assert.match(harness.notifications.join("\n"), /restored provider\/original \(thinking:low\)/);
	});

	it("restores even when a legacy configuration opt-out is present", async () => {
		const harness = await createRouterHarness(
			{ review: { tier: "standard", rank: 20 } },
			{ legacyRestoreAfterRun: false },
		);
		await harness.invokeSkill("review");
		await harness.emit("agent_settled");

		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/original"]);
		assert.equal(harness.ctx.model.id, "original");
	});

	it("defers non-idle settlement and restores before the next run", async () => {
		const harness = await createRouterHarness(
			{ build: { tier: "standard", rank: 20 } },
			{ idle: false },
		);
		await harness.invokeSkill("build");
		await harness.emit("agent_settled");

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /deferred restoration of provider\/original while another run is active/);
		await harness.invokeCommand("model-tier", "status");
		assert.match(harness.notifications.join("\n"), /restoration owed: true/);

		await harness.emit("before_agent_start", { prompt: "Continue unrelated work.", systemPromptOptions: { skills: [] } });

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard", "provider/original"]);
		assert.equal(harness.ctx.model.id, "original");
	});

	it("retries a failed restoration before the next run", async () => {
		const harness = await createRouterHarness(
			{ build: { tier: "standard", rank: 20 } },
			{ setModelResults: { "provider/original": [false, true] } },
		);
		await harness.invokeSkill("build");
		await harness.emit("agent_settled");

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard", "provider/original"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /could not restore provider\/original; will retry before the next run/);

		await harness.emit("before_agent_start", { prompt: "Continue unrelated work.", systemPromptOptions: { skills: [] } });

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard", "provider/original", "provider/original"]);
		assert.equal(harness.ctx.model.id, "original");
		assert.match(harness.notifications.join("\n"), /restored provider\/original/);
	});

	it("preserves owed attribution and blocks new routes until manual escape", async () => {
		const harness = await createRouterHarness(
			{
				build: { tier: "standard", rank: 20 },
				audit: { tier: "premium", rank: 40 },
			},
			{ setModelResults: { "provider/original": [false, false] } },
		);
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.emit("agent_settled");
		await harness.invokeSkill("audit");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard", "provider/original", "provider/original"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /skipped audit while restoration of provider\/original is owed/);
		assert.equal(harness.usageRecords.length, 2);
		assert.equal(harness.usageRecords[0]?.routeRunId, harness.usageRecords[1]?.routeRunId);
		assert.deepEqual(harness.usageRecords.map((record) => record.responseIndex), [1, 2]);

		await harness.selectManually(model("provider", "manual"));
		await harness.invokeSkill("audit");

		assert.equal(harness.ctx.model.id, "premium");
		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/premium"]);
	});

	it("retries owed restoration eagerly during shutdown even when the agent is not idle", async () => {
		const harness = await createRouterHarness(
			{ build: { tier: "standard", rank: 20 } },
			{ setModelResults: { "provider/original": [false, true] } },
		);
		await harness.invokeSkill("build");
		await harness.emit("agent_settled");
		harness.setIdle(false);
		await harness.emit("session_shutdown", { reason: "quit" });

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard", "provider/original", "provider/original"]);
		assert.equal(harness.ctx.model.id, "original");
	});

	it("simulates configured setModel failures without changing the active model", async () => {
		const harness = await createRouterHarness(
			{ review: { tier: "standard", rank: 20 } },
			{ setModelResults: { "provider/standard": [false] } },
		);
		await harness.invokeSkill("review");

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.deepEqual(harness.modelSelections, []);
		assert.equal(harness.ctx.model.id, "original");
		assert.match(harness.notifications.join("\n"), /could not select provider\/standard/);
	});

	it("requires and captures explicit metered confirmation without skill policy metadata", async () => {
		const harness = await createRouterHarness({
			review: { tier: "premium", rank: 40, metered: true },
		});
		await harness.invokeSkill("review");

		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0]?.message ?? "", /review requests premium → provider\/premium/);
		assert.deepEqual(harness.modelSelections, ["provider/premium"]);
	});

	it("does not fall through to another candidate after metered consent is declined", async () => {
		const harness = await createRouterHarness(
			{
				review: {
					tier: "premium",
					rank: 40,
					selection: "weighted-random",
					candidates: [
						{ model: "provider/paid", metered: true, weight: 1 },
						{ model: "provider/free", metered: false, weight: 3 },
					],
				},
			},
			{ confirm: false, random: () => 0 },
		);
		await harness.invokeSkill("review");
		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0]?.message ?? "", /provider\/paid/);
		assert.deepEqual(harness.modelSelectionAttempts, []);
		assert.equal(harness.ctx.model.id, "original");
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).selectionPolicy, "weighted-random");
		assert.deepEqual(lastRouteDecision(harness).selectionPool, [
			{ model: "provider/paid", weight: 1 },
			{ model: "provider/free", weight: 3 },
		]);
	});

	it("does not fall through a first-available tier after the first candidate is declined", async () => {
		const harness = await createRouterHarness(
			{
				review: {
					tier: "premium",
					rank: 40,
					candidates: [
						{ model: "provider/paid", metered: true },
						{ model: "provider/free", metered: false },
					],
				},
			},
			{ confirm: false },
		);

		await harness.invokeSkill("review");
		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0]?.message ?? "", /provider\/paid/);
		assert.deepEqual(harness.modelSelectionAttempts, []);
		assert.equal(harness.ctx.model.id, "original");
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).reason, "metered-declined");
		assert.equal(lastRouteDecision(harness).selectionPolicy, "first-available");
		assert.deepEqual(lastRouteDecision(harness).selectionPool, [
			{ model: "provider/paid", weight: 1 },
			{ model: "provider/free", weight: 1 },
		]);
	});

	it("does not fall through after a weighted model switch fails", async () => {
		const harness = await createRouterHarness(
			{
				review: {
					tier: "premium",
					rank: 40,
					selection: "weighted-random",
					candidates: [
						{ model: "provider/paid", metered: true, weight: 1 },
						{ model: "provider/free", metered: false, weight: 3 },
					],
				},
			},
			{ random: () => 0, setModelResults: { "provider/paid": [false] } },
		);
		await harness.invokeSkill("review");
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/paid"]);
		assert.deepEqual(harness.modelSelections, []);
		assert.equal(harness.ctx.model.id, "original");
	});

	it("filters metered ask candidates from implicit and headless weighted pools", async () => {
		const skill = {
			review: {
				tier: "premium",
				rank: 40,
				selection: "weighted-random" as const,
				candidates: [
					{ model: "provider/paid", metered: true, weight: 3 },
					{ model: "provider/free", metered: false, weight: 1 },
				],
			},
		};
		const implicit = await createRouterHarness(skill, { random: () => 0 });
		await implicit.loadSkillsForTurn("review");
		await implicit.readSkill("review");
		assert.deepEqual(implicit.confirmations, []);
		assert.deepEqual(implicit.modelSelections, ["provider/free"]);

		const headless = await createRouterHarness(skill, { hasUI: false, random: () => 0 });
		await headless.invokeSkill("review");
		assert.deepEqual(headless.confirmations, []);
		assert.deepEqual(headless.modelSelections, ["provider/free"]);

		const unknownCost = await createRouterHarness(
			{
				review: {
					tier: "project-weighted",
					rank: 40,
					project: true,
					selection: "weighted-random",
					candidates: [
						{ model: "provider/unknown", metered: false, weight: 3 },
						{ model: "provider/free", metered: false, weight: 1 },
					],
				},
			},
			{
				modelPolicies: { "provider/free": { metered: false } },
				random: () => 0,
			},
		);
		await unknownCost.loadSkillsForTurn("review");
		await unknownCost.readSkill("review");
		assert.deepEqual(unknownCost.confirmations, []);
		assert.deepEqual(unknownCost.modelSelections, ["provider/free"]);
		await unknownCost.invokeCommand("model-tier", "status");
		assert.deepEqual(lastRouteDecision(unknownCost).selectionPool, [{ model: "provider/free", weight: 1 }]);
		assert.equal(lastRouteDecision(unknownCost).meteredClassification, false);
		assert.equal(lastRouteDecision(unknownCost).consentPolicy, "not-needed");

		let draws = 0;
		const empty = await createRouterHarness(
			{
				review: {
					tier: "premium",
					rank: 40,
					selection: "weighted-random",
					candidates: [{ model: "provider/paid", metered: true, weight: 1 }],
				},
			},
			{ hasUI: false, random: () => { draws++; return 0; } },
		);
		await empty.invokeSkill("review");
		assert.equal(draws, 0);
		assert.deepEqual(empty.modelSelectionAttempts, []);
		empty.ctx.hasUI = true;
		await empty.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(empty).reason, "no-eligible-candidate");
		assert.deepEqual(lastRouteDecision(empty).selectionPool, []);
	});

	it("reports a disabled tier distinctly and keeps its config warning in status", async () => {
		let draws = 0;
		const harness = await createRouterHarness(
			{
				review: {
					tier: "standard",
					rank: 20,
					selection: "weighted-random",
					candidates: [{ model: "provider/free", metered: false, weight: 1 }],
				},
			},
			{ random: () => { draws++; return 0; } },
		);

		harness.setTierRoute("standard", {
			rank: 20,
			thinking: "high",
			selection: "weighted-random",
			candidates: [{ model: "provider/free", metered: false, weight: 0 }],
		});
		await harness.invokeCommand("model-tier", "reload");
		await harness.invokeSkill("review");

		assert.equal(draws, 0);
		assert.deepEqual(harness.modelSelectionAttempts, []);
		assert.equal(harness.ctx.model.id, "original");
		await harness.emit("agent_settled");

		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).reason, "invalid-tier-configuration");
		const status = harness.notifications.at(-1) ?? "";
		assert.match(status, /config warnings:.*weight must be an integer from 1 to 100; tier routing disabled/);
		assert.match(status, /warnings: \(none\)/);
	});

	it("honors global allow for explicit and implicit metered routes", async () => {
		const skills = { review: { tier: "premium", rank: 40, candidates: [{ model: "provider/premium" }] } };
		const options = { modelPolicies: { "provider/premium": { metered: true, consent: "allow" } } };
		const explicit = await createRouterHarness(skills, options);
		await explicit.invokeSkill("review");
		assert.deepEqual(explicit.confirmations, []);
		assert.deepEqual(explicit.modelSelections, ["provider/premium"]);
		await explicit.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(explicit).consentPolicy, "allow");
		assert.equal(lastRouteDecision(explicit).consentBasis, "configured");

		const implicit = await createRouterHarness(skills, options);
		await implicit.loadSkillsForTurn("review");
		await implicit.readSkill("review");
		assert.deepEqual(implicit.confirmations, []);
		assert.deepEqual(implicit.modelSelections, ["provider/premium"]);

		const headless = await createRouterHarness(skills, { ...options, hasUI: false });
		await headless.invokeSkill("review");
		assert.deepEqual(headless.confirmations, []);
		assert.deepEqual(headless.modelSelections, ["provider/premium"]);
	});

	it("applies one exact global model policy consistently across tiers", async () => {
		const harness = await createRouterHarness(
			{
				build: { tier: "standard", rank: 20, candidates: [{ model: "provider/shared" }] },
				audit: { tier: "premium", rank: 40, candidates: [{ model: "provider/shared" }] },
			},
			{ modelPolicies: { "provider/shared": { metered: true, consent: "allow" } } },
		);

		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");
		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/shared", "provider/shared"]);
		await harness.invokeCommand("model-tier", "status");
		const decision = lastRouteDecision(harness);
		assert.equal(decision.requestedTier, "premium");
		assert.deepEqual(decision.candidate, { model: "provider/shared" });
		assert.equal(decision.meteredClassification, true);
		assert.equal(decision.consentPolicy, "allow");
		assert.equal(decision.consentBasis, "configured");
		assert.equal(decision.reason, "routed");
	});

	it("keeps globally allowed metered models disabled when implicit routing is off", async () => {
		const harness = await createRouterHarness(
			{ review: { tier: "premium", rank: 40, metered: true } },
			{
				modelPolicies: { "provider/premium": { metered: true, consent: "allow" } },
				routeImplicitSkillReads: false,
			},
		);
		await harness.loadSkillsForTurn("review");
		await harness.readSkill("review");
		assert.deepEqual(harness.modelSelectionAttempts, []);
	});

	it("applies reloaded consent only to later routes without changing the active route", async () => {
		const harness = await createRouterHarness(
			{
				build: { tier: "standard", rank: 20 },
				review: { tier: "premium", rank: 40, metered: true },
			},
			{ confirm: false },
		);
		await harness.invokeSkill("build");
		assert.equal(harness.ctx.model.id, "standard");

		harness.setModelPolicies({ "provider/premium": { metered: true, consent: "allow" } });
		await harness.invokeCommand("model-tier", "reload");
		assert.equal(harness.ctx.model.id, "standard");
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);

		await harness.invokeSkill("review");
		assert.equal(harness.confirmations.length, 0);
		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/premium"]);
	});

	it("uses reloaded weighted configuration for later independent draws", async () => {
		const harness = await createRouterHarness(
			{
				review: {
					tier: "standard",
					rank: 20,
					selection: "weighted-random",
					candidates: [
						{ model: "provider/a", metered: false, weight: 9 },
						{ model: "provider/b", metered: false, weight: 1 },
					],
				},
			},
			{ random: () => 0.5 },
		);
		await harness.invokeSkill("review");
		assert.equal(harness.ctx.model.id, "a");
		await harness.emit("agent_settled");

		harness.setTierRoute("standard", {
			rank: 20,
			thinking: "high",
			selection: "weighted-random",
			candidates: [
				{ model: "provider/a", metered: false, weight: 1 },
				{ model: "provider/b", metered: false, weight: 9 },
			],
		});
		await harness.invokeCommand("model-tier", "reload");
		await harness.invokeSkill("review");
		assert.equal(harness.ctx.model.id, "b");
	});

	it("fails closed for a project-only candidate claiming to be unmetered", async () => {
		const harness = await createRouterHarness(
			{ review: { tier: "private", rank: 30, metered: false, project: true } },
			{ confirm: true },
		);
		await harness.invokeSkill("review");
		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0]?.message ?? "", /cost: unknown/);
		assert.deepEqual(harness.modelSelections, ["provider/private"]);
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).meteredClassification, "unknown");
		assert.equal(lastRouteDecision(harness).consentPolicy, "ask");
		assert.equal(lastRouteDecision(harness).consentBasis, "confirmed");

		const implicit = await createRouterHarness(
			{ review: { tier: "private", rank: 30, metered: false, project: true } },
		);
		await implicit.loadSkillsForTurn("review");
		await implicit.readSkill("review");
		assert.deepEqual(implicit.confirmations, []);
		assert.deepEqual(implicit.modelSelectionAttempts, []);
		assert.match(implicit.notifications.join("\n"), /skipped unknown-cost provider\/private/);
	});

	it("simulates declined and unavailable metered confirmation", async () => {
		const skill = { review: { tier: "premium", rank: 40, metered: true, meteredPolicy: "unrecognised-policy" } };
		const declined = await createRouterHarness(skill, { confirm: false });
		await declined.invokeSkill("review");
		assert.equal(declined.confirmations.length, 1);
		assert.deepEqual(declined.modelSelectionAttempts, []);
		assert.equal(declined.ctx.model.id, "original");
		assert.match(declined.notifications.join("\n"), /declined metered provider\/premium/);
		await declined.invokeCommand("model-tier", "status");
		assert.deepEqual(lastRouteDecision(declined), {
			requestedTier: "premium",
			effectiveTier: "premium",
			candidate: { model: "provider/premium", metered: true },
			effectiveModel: { provider: "provider", model: "original" },
			thinkingLevel: "low",
			meteredClassification: true,
			consentPolicy: "ask",
			consentBasis: "declined",
			selectionPolicy: "first-available",
			selectionPool: [{ model: "provider/premium", weight: 1 }],
			reason: "metered-declined",
			warnings: ["declined metered provider/premium for premium"],
			restoration: "not-applicable",
		});

		const headless = await createRouterHarness(skill, { hasUI: false });
		await headless.invokeSkill("review");
		assert.deepEqual(headless.confirmations, []);
		assert.deepEqual(headless.modelSelectionAttempts, []);
		assert.equal(headless.ctx.model.id, "original");
	});

	it("routes an unmetered implicit skill only after its loaded file is read", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20 } });
		await harness.loadSkillsForTurn("review");
		assert.deepEqual(harness.modelSelections, []);

		await harness.readSkill("review");
		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
	});

	it("skips an initial metered implicit skill read without prompting or changing the model", async () => {
		const harness = await createRouterHarness({
			review: { tier: "premium", rank: 40, metered: true },
		});
		await harness.loadSkillsForTurn("review");

		await harness.readSkill("review");

		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelectionAttempts, []);
		assert.deepEqual(harness.thinkingSelections, []);
		assert.equal(harness.ctx.model.id, "original");
		assert.match(harness.notifications.join("\n"), /implicit skill reads do not prompt/);
	});

	it("skips a nested metered implicit skill read without prompting or changing the active route", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40, effort: "xhigh", metered: true, meteredPolicy: "ask-above-standard" },
			quick: { tier: "economy", rank: 10 },
		});
		await harness.invokeSkill("build");
		await harness.loadSkillsForTurn("audit");

		await harness.readSkill("audit");

		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["high", "xhigh"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /implicit skill reads do not prompt/);

		await harness.invokeSkill("quick");
		await harness.invokeCommand("model-tier", "status");
		assert.deepEqual(lastRouteDecision(harness).candidate, { model: "provider/standard", metered: false });
		assert.equal(lastRouteDecision(harness).meteredClassification, false);
		assert.equal(lastRouteDecision(harness).consentPolicy, "not-needed");
	});

	it("retains the active model and raises thinking after a nested explicit route is declined", async () => {
		const harness = await createRouterHarness(
			{
				build: { tier: "standard", rank: 20, effort: "medium" },
				audit: { tier: "premium", rank: 40, effort: "xhigh", metered: true },
			},
			{ confirm: false },
		);

		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");
		assert.equal(harness.confirmations.length, 1);
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "xhigh"]);
		assert.equal(harness.ctx.model.id, "standard");

		await harness.invokeCommand("model-tier", "status");
		const decision = lastRouteDecision(harness);
		assert.equal(decision.requestedTier, "premium");
		assert.equal(decision.effectiveTier, "standard");
		assert.equal(decision.thinkingLevel, "xhigh");
		assert.equal(decision.consentBasis, "declined");
		assert.equal(decision.reason, "metered-declined");
		assert.equal(decision.restoration, "pending");
	});

	it("discards stale routes when a later input handler changes the request", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20 } });
		await harness.stageSkill("review");
		await harness.emit("before_agent_start", { prompt: "A later input handler changed the request", systemPromptOptions: { skills: [] } });

		assert.deepEqual(harness.modelSelections, []);
	});

	it("keeps the active route when a skill is queued during streaming", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.stageSkill("audit", { streamingBehavior: "followUp" });

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /skipped routing queued \/skill:audit/);

		await harness.emit("agent_settled");
		assert.equal(harness.ctx.model.id, "original");
	});

	it("draws once for each successful higher-tier weighted upgrade", async () => {
		let draws = 0;
		const harness = await createRouterHarness(
			{
				build: {
					tier: "standard",
					rank: 20,
					selection: "weighted-random",
					candidates: [{ model: "provider/a", metered: false, weight: 1 }],
				},
				audit: {
					tier: "premium",
					rank: 40,
					selection: "weighted-random",
					candidates: [{ model: "provider/b", metered: false, weight: 1 }],
				},
			},
			{ random: () => { draws++; return 0; } },
		);
		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");
		assert.equal(draws, 2);
		assert.deepEqual(harness.modelSelections, ["provider/a", "provider/b"]);
	});

	it("does not redraw weighted candidates for retained nested tiers", async () => {
		let draws = 0;
		const harness = await createRouterHarness(
			{
				build: {
					tier: "standard",
					rank: 20,
					selection: "weighted-random",
					candidates: [
						{ model: "provider/a", metered: false, weight: 1 },
						{ model: "provider/b", metered: false, weight: 1 },
					],
				},
				peer: { tier: "standard-peer", rank: 20 },
				quick: { tier: "economy", rank: 10 },
			},
			{ random: () => { draws++; return 0; } },
		);
		await harness.invokeSkill("build");
		await harness.invokeSkill("peer");
		assert.equal(draws, 1);
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).requestedTier, "standard-peer");
		assert.equal(lastRouteDecision(harness).effectiveTier, "standard");
		assert.equal(lastRouteDecision(harness).reason, "retain-equal");
		assert.deepEqual(lastRouteDecision(harness).candidate, { model: "provider/a", metered: false, weight: 1 });
		assert.deepEqual(lastRouteDecision(harness).selectionPool, [
			{ model: "provider/a", weight: 1 },
			{ model: "provider/b", weight: 1 },
		]);

		await harness.invokeSkill("quick");
		assert.equal(draws, 1);
		assert.equal(harness.ctx.model.id, "a");
	});

	it("raises nested effort without downgrading the active model or thinking", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20, effort: "medium" },
			"deep-check": { tier: "economy", rank: 10, effort: "xhigh" },
			"quick-check": { tier: "economy", rank: 10, effort: "low" },
		});
		await harness.invokeSkill("build");
		await harness.invokeSkill("deep-check");
		await harness.invokeSkill("quick-check");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "xhigh"]);
		assert.match(harness.notifications.join("\n"), /raised thinking to xhigh for nested deep-check/);
		assert.equal(harness.ctx.model.id, "standard");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.invokeCommand("model-tier", "status");
		assert.deepEqual(lastRouteDecision(harness), {
			requestedTier: "economy",
			effectiveTier: "standard",
			candidate: { model: "provider/standard", metered: false },
			effectiveModel: { provider: "provider", model: "standard" },
			thinkingLevel: "xhigh",
			meteredClassification: false,
			consentPolicy: "not-needed",
			consentBasis: "not-applicable",
			selectionPolicy: "first-available",
			selectionPool: [{ model: "provider/standard", weight: 1 }],
			reason: "retain-lower",
			warnings: [],
			restoration: "pending",
		});
		assert.deepEqual(harness.usageRecords.map((record) => [record.tier, record.thinking]), [["standard", "xhigh"]]);
	});

	it("preserves requested effort across model-specific clamping and later upgrades", async () => {
		const harness = await createRouterHarness(
			{
				deep: { tier: "limited", rank: 20, effort: "xhigh" },
				upgrade: { tier: "capable", rank: 40, effort: "low" },
			},
			{
				clampThinking: (requested, modelId) => modelId === "limited" && requested === "xhigh" ? "high" : requested,
			},
		);
		await harness.invokeSkill("deep");
		await harness.invokeSkill("upgrade");

		assert.deepEqual(harness.modelSelections, ["provider/limited", "provider/capable"]);
		assert.deepEqual(harness.thinkingSelections, ["high", "xhigh"]);
	});

	it("raises effort even when a higher-tier model is unavailable", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 30, effort: "medium" },
			audit: { tier: "unavailable", rank: 40, effort: "xhigh", available: false },
		});
		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "xhigh"]);
		assert.equal(harness.ctx.model.id, "standard");
	});

	it("keeps status and ledger attribution aligned after a nested switch failure", async () => {
		const harness = await createRouterHarness(
			{
				build: { tier: "standard", rank: 20 },
				audit: { tier: "premium", rank: 40 },
			},
			{ setModelResults: { "provider/premium": [false] } },
		);
		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.invokeCommand("model-tier", "status");

		assert.deepEqual(lastRouteDecision(harness), {
			requestedTier: "premium",
			effectiveTier: "standard",
			candidate: { model: "provider/premium", metered: false },
			effectiveModel: { provider: "provider", model: "standard" },
			thinkingLevel: "high",
			meteredClassification: false,
			consentPolicy: "not-needed",
			consentBasis: "not-needed",
			selectionPolicy: "first-available",
			selectionPool: [{ model: "provider/premium", weight: 1 }],
			reason: "model-switch-failed",
			warnings: ["could not select provider/premium; retained provider/standard"],
			restoration: "pending",
		});
		assert.deepEqual(harness.usageRecords.map((record) => [record.tier, record.thinking]), [["standard", "high"]]);
	});

	it("does not route nested skills after a manual model selection", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.selectManually(model("provider", "manual"));
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).restoration, "cancelled-by-manual-override");
		await harness.invokeSkill("audit");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "manual");
		assert.match(harness.notifications.join("\n"), /skipped audit after a manual model selection/);

		await harness.emit("agent_settled");
		assert.equal(harness.ctx.model.id, "manual");
	});

	it("attributes finalized responses across a nested tier upgrade", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.invokeSkill("audit");
		await harness.emit("message_end", { message: assistantMessage("provider", "premium") });

		assert.equal(harness.usageRecords.length, 2);
		assert.equal(harness.usageRecords[0]?.tier, "standard");
		assert.equal(harness.usageRecords[1]?.tier, "premium");
		assert.equal(harness.usageRecords[0]?.routeRunId, harness.usageRecords[1]?.routeRunId);
		assert.deepEqual(harness.usageRecords.map((record) => record.responseIndex), [1, 2]);
		assert.deepEqual(harness.usageRecords[1]?.routedSkills, ["build", "audit"]);
	});

	it("starts fresh attribution for each routed run after settlement", async () => {
		const harness = await createRouterHarness({ build: { tier: "standard", rank: 20 } });
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.emit("agent_settled");
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });

		assert.equal(harness.usageRecords.length, 2);
		assert.notEqual(harness.usageRecords[0]?.routeRunId, harness.usageRecords[1]?.routeRunId);
		assert.deepEqual(harness.usageRecords.map((record) => record.responseIndex), [1, 1]);
	});

	it("stops attribution after a manual override or settlement", async () => {
		const harness = await createRouterHarness({ build: { tier: "standard", rank: 20 } });
		await harness.invokeSkill("build");
		await harness.selectManually(model("provider", "manual"));
		await harness.emit("message_end", { message: assistantMessage("provider", "manual") });
		assert.equal(harness.usageRecords.length, 0);

		const settled = await createRouterHarness({ build: { tier: "standard", rank: 20 } });
		await settled.invokeSkill("build");
		await settled.emit("agent_settled");
		await settled.emit("message_end", { message: assistantMessage("provider", "original") });
		assert.equal(settled.usageRecords.length, 0);
	});

	it("treats inherited object keys as unknown tiers", async () => {
		const harness = await createRouterHarness({ inherited: { tier: "toString", rank: 20, configure: false } });
		await harness.invokeSkill("inherited");

		assert.deepEqual(harness.modelSelections, []);
		assert.match(harness.notifications.join("\n"), /unknown or unconfigured tier toString/);
		await harness.invokeCommand("model-tier", "status");
		assert.equal(lastRouteDecision(harness).consentPolicy, "not-applicable");
		assert.equal(lastRouteDecision(harness).consentBasis, "not-applicable");
	});
});
