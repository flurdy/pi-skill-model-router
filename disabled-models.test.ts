import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { describeDisabledModels, evaluateDisabledModels } from "./disabled-models.ts";

function fixture(policy?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "disabled-models-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const member = join(root, "elsewhere", "member");
	mkdirSync(join(home, ".agents"), { recursive: true });
	mkdirSync(join(workspace, "repos"), { recursive: true });
	mkdirSync(join(workspace, "nested", "deep"), { recursive: true });
	mkdirSync(member, { recursive: true });
	mkdirSync(join(root, "workspace-sibling"), { recursive: true });
	symlinkSync(member, join(workspace, "repos", "member"));
	const write = (value: unknown) => writeFileSync(
		join(home, ".agents", "disabled-models.json"),
		typeof value === "string" ? value : JSON.stringify(value),
	);
	if (policy !== undefined) write(policy);
	return { root, home, workspace, member, write };
}

describe("disabled-models policy", () => {
	it("treats a missing file as no policy", () => {
		const { home, workspace } = fixture();
		const result = evaluateDisabledModels(home, workspace);
		assert.equal(result.status, "missing");
		assert.equal(result.deniedModels.size, 0);
		assert.match(describeDisabledModels(result), /absent/);
	});

	it("matches descendants on path-component boundaries and accumulates overlapping rules", () => {
		const { root, home, workspace, write } = fixture();
		write({
			version: 1,
			rules: [
				{ id: "outer", roots: [workspace], models: ["vendor/a"], reason: "licence" },
				{ id: "inner", roots: [join(workspace, "nested")], models: ["vendor/a", "vendor/b"], agents: ["gemini"] },
			],
		});

		const deep = evaluateDisabledModels(home, join(workspace, "nested", "deep"));
		assert.deepEqual(deep.matchedRules, ["outer", "inner"]);
		assert.deepEqual(deep.deniedModels.get("vendor/a"), ["outer: licence", "inner"]);
		assert.deepEqual(deep.deniedModels.get("vendor/b"), ["inner"]);
		assert.deepEqual(deep.deniedAgents.get("gemini"), ["inner"]);

		assert.deepEqual(evaluateDisabledModels(home, workspace).matchedRules, ["outer"]);
		assert.deepEqual(evaluateDisabledModels(home, join(root, "workspace-sibling")).matchedRules, []);
	});

	it("matches through symlinks in either the cwd or the root", () => {
		const { home, workspace, member, write } = fixture();
		write({ version: 1, rules: [{ id: "member", roots: [join(workspace, "repos", "member")], models: ["vendor/a"] }] });
		assert.deepEqual(evaluateDisabledModels(home, member).matchedRules, ["member"]);
		write({ version: 1, rules: [{ id: "real", roots: [member], models: ["vendor/a"] }] });
		assert.deepEqual(evaluateDisabledModels(home, join(workspace, "repos", "member")).matchedRules, ["real"]);
	});

	it("keeps roots absent on this machine valid but unmatched", () => {
		const { home, workspace, write } = fixture();
		write({ version: 1, rules: [{ id: "other-machine", roots: ["/nonexistent/other/machine"], models: ["vendor/a"] }] });
		const result = evaluateDisabledModels(home, workspace);
		assert.equal(result.status, "loaded");
		assert.deepEqual(result.matchedRules, []);
	});

	it("rejects malformed or ambiguous policy rather than ignoring it", () => {
		const { home, workspace, write } = fixture();
		const rule = { id: "r", roots: [workspace], models: ["vendor/a"] };
		const cases: Array<[unknown, RegExp]> = [
			["{", /malformed JSON/],
			[[], /must be an object/],
			[{ version: 2, rules: [] }, /version must be 1/],
			[{ version: 1, rules: [], extra: true }, /unknown top-level/],
			[{ version: 1, rules: [{ ...rule, model: ["vendor/b"] }] }, /unknown fields: model/],
			[{ version: 1, rules: [{ ...rule, roots: ["relative/path"] }] }, /roots/],
			[{ version: 1, rules: [{ ...rule, roots: [] }] }, /at least one absolute path/],
			[{ version: 1, rules: [{ id: "r", roots: [workspace] }] }, /at least one model or agent/],
			[{ version: 1, rules: [{ ...rule, models: ["bare-model"] }] }, /models/],
			[{ version: 1, rules: [{ ...rule, agents: ["copilot"] }] }, /agents/],
			[{ version: 1, rules: [rule, rule] }, /duplicates id r/],
			[{ version: 1, rules: [{ ...rule, reason: "" }] }, /reason/],
		];
		for (const [policy, error] of cases) {
			write(policy);
			const result = evaluateDisabledModels(home, workspace);
			assert.equal(result.status, "invalid", JSON.stringify(policy));
			assert.match(result.error ?? "", error);
			assert.equal(result.deniedModels.size, 0);
			assert.match(describeDisabledModels(result), /routing stopped/);
		}
	});
});
