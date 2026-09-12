import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queryModelPolicies as query, loadRouterConfig } from "./config.ts";

function fixture(value: unknown, run: (dir: string, source: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "policy-evidence-"));
	const source = JSON.stringify(value);
	writeFileSync(join(dir, "model-tier-router.json"), source);
	try { run(dir, source); }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

test("queries exact global policies without selecting or launching a model", () => {
	fixture({ modelPolicies: {
		"provider/included": { metered: false },
		"provider/paid": { metered: true, consent: "allow" },
	} }, (dir, source) => {
		assert.deepEqual(query(dir, ["provider/included", "provider/paid", "provider/absent"]), {
			version: 1, runtime: "pi", scope: "user",
			source: {
				owner: "@flurdy/pi-skill-model-router", path: join(dir, "model-tier-router.json"),
				status: "loaded", revision: createHash("sha256").update(source).digest("hex"),
			},
			policies: [
				{ model: "provider/included", meteredClassification: false, consentPolicy: "not-needed", basis: "explicit" },
				{ model: "provider/paid", meteredClassification: true, consentPolicy: "allow", basis: "explicit" },
				{ model: "provider/absent", meteredClassification: "unknown", consentPolicy: "ask", basis: "missing" },
			],
		});
		assert.equal(readFileSync(join(dir, "model-tier-router.json"), "utf8"), source);
	});
});

test("re-reads changed policy and binds the revision to the bytes interpreted", () => {
	fixture({ modelPolicies: { "provider/paid": { metered: true, consent: "allow" } } }, (dir) => {
		const first = query(dir, ["provider/paid"]);
		writeFileSync(join(dir, "model-tier-router.json"), JSON.stringify({ modelPolicies: { "provider/paid": { metered: true, consent: "ask" } } }));
		const second = query(dir, ["provider/paid"]);
		assert.notEqual(first.source.revision, second.source.revision);
		assert.equal(second.policies[0].consentPolicy, "ask");
	});
});

test("distinguishes inline conflicts from explicit policy overrides per model", () => {
	fixture({
		tiers: {
			a: { rank: 10, thinking: "high", candidates: [
				{ model: "provider/conflict", metered: false }, { model: "provider/override", metered: true },
				{ model: "provider/legacy", metered: false },
			] },
			b: { rank: 20, thinking: "high", candidates: [{ model: "provider/conflict", metered: true }] },
		},
		modelPolicies: { "provider/override": { metered: false } },
	}, (dir) => {
		assert.deepEqual(query(dir, ["provider/conflict", "provider/override", "provider/legacy"]).policies, [
			{ model: "provider/conflict", meteredClassification: true, consentPolicy: "ask", basis: "conflict" },
			{ model: "provider/override", meteredClassification: false, consentPolicy: "not-needed", basis: "explicit-override" },
			{ model: "provider/legacy", meteredClassification: false, consentPolicy: "not-needed", basis: "inline" },
		]);
	});
});

test("malformed explicit policies cannot fall through to unmetered inline evidence", () => {
	for (const invalid of [{ consent: "allow" }, { metered: false, consent: "forever" }, null]) {
		fixture({
			tiers: { a: { rank: 10, thinking: "high", candidates: [{ model: "provider/bad", metered: false }] } },
			modelPolicies: { "provider/bad": invalid, "provider/good": { metered: true, consent: "allow" } },
		}, (dir) => {
			assert.deepEqual(query(dir, ["provider/bad"]).policies[0], {
				model: "provider/bad", meteredClassification: "unknown", consentPolicy: "ask", basis: "invalid",
			});
			assert.equal(query(dir, ["provider/good"]).policies[0].consentPolicy, "allow");
			// Existing parent routing remains compatible; this probe is more conservative.
			assert.equal(loadRouterConfig({ agentDir: dir, cwd: dir, projectTrusted: false }).config.modelPolicies["provider/bad"]?.metered, false);
		});
	}
});

test("invalid policy maps and unavailable files return bounded unknown evidence", () => {
	fixture({ modelPolicies: [], tiers: { a: { rank: 10, thinking: "high", candidates: [{ model: "provider/m", metered: false }] } } }, (dir) => {
		assert.equal(query(dir, ["provider/m"]).source.status, "invalid");
		assert.equal(query(dir, ["provider/m"]).policies[0].meteredClassification, "unknown");
		writeFileSync(join(dir, "model-tier-router.json"), '{"private":"DO_NOT_EMIT", broken');
		const invalid = query(dir, ["provider/m"]);
		assert.equal(invalid.source.status, "invalid");
		assert.ok(!JSON.stringify(invalid).includes("DO_NOT_EMIT"));
		rmSync(join(dir, "model-tier-router.json"));
		assert.equal(query(dir, ["provider/m"]).source.status, "unavailable");
		assert.equal(query(dir, ["provider/m"]).source.revision, null);
	});
});

test("revision hashes file bytes rather than a lossy text decoding", () => {
	fixture({}, (dir) => {
		const bytes = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([255]), Buffer.from('"}')]);
		writeFileSync(join(dir, "model-tier-router.json"), bytes);
		assert.equal(query(dir, ["provider/m"]).source.revision, createHash("sha256").update(bytes).digest("hex"));
	});
});

test("package declares an explicit policy entry point", () => {
	const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	assert.equal(manifest.exports?.["./policy"], "./config.ts");
});

test("rejects unbounded and nonliteral query identities before reading policy", () => {
	for (const models of [[], Array(33).fill("provider/model"), ["opus"], ["provider/*"], ["provider/model\n"], ["provider/model "], ["provider/"], ["p/" + "x".repeat(512)]]) {
		assert.throws(() => query("/unused", models), /1..32 exact provider\/model identities/);
	}
});
