/**
 * User-owned, path-scoped model deny policy shared with other local tools.
 *
 * The file lives at a fixed location under the user's home directory and can only
 * remove candidates from selection: it never grants consent or reclassifies cost.
 */

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export const DISABLED_MODELS_FILE = join(".agents", "disabled-models.json");
export const LOCAL_AGENTS = ["claude", "codex", "gemini"] as const;
const MAX_BYTES = 1024 * 1024;
const MAX_RULES = 256;
const RULE_KEYS = new Set(["id", "roots", "models", "agents", "reason"]);
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[^/\s]+\/\S+$/;

export interface DisabledModelsEvaluation {
	status: "missing" | "loaded" | "invalid";
	path: string;
	error?: string;
	/** IDs of rules whose roots contain the evaluated directory, in file order. */
	matchedRules: string[];
	/** Exact provider/model identity → "rule: reason" details. */
	deniedModels: Map<string, string[]>;
	deniedAgents: Map<string, string[]>;
}

interface Rule {
	id: string;
	roots: string[];
	models: string[];
	agents: string[];
	reason?: string;
}

function invalid(path: string, error: string): DisabledModelsEvaluation {
	return { status: "invalid", path, error, matchedRules: [], deniedModels: new Map(), deniedAgents: new Map() };
}

function stringList(value: unknown, label: string, pattern?: (item: string) => boolean): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !(pattern?.(item) ?? item.length > 0))) {
		throw new Error(`${label} must be an array of valid strings`);
	}
	return value as string[];
}

function parseRules(raw: string): Rule[] {
	const document = JSON.parse(raw) as unknown;
	if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("policy must be an object");
	const record = document as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((key) => key !== "version" && key !== "rules");
	if (unknownKeys.length) throw new Error(`unknown top-level fields: ${unknownKeys.join(", ")}`);
	if (record.version !== 1) throw new Error("version must be 1");
	if (!Array.isArray(record.rules) || record.rules.length > MAX_RULES) throw new Error(`rules must be an array of at most ${MAX_RULES}`);
	const ids = new Set<string>();
	return record.rules.map((value, index) => {
		const label = `rule ${index + 1}`;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
		const item = value as Record<string, unknown>;
		const extra = Object.keys(item).filter((key) => !RULE_KEYS.has(key));
		if (extra.length) throw new Error(`${label} has unknown fields: ${extra.join(", ")}`);
		if (typeof item.id !== "string" || !RULE_ID.test(item.id)) throw new Error(`${label} id is invalid`);
		if (ids.has(item.id)) throw new Error(`${label} duplicates id ${item.id}`);
		ids.add(item.id);
		const roots = stringList(item.roots, `${label} roots`, isAbsolute);
		if (roots.length === 0) throw new Error(`${label} roots must name at least one absolute path`);
		const models = stringList(item.models, `${label} models`, (model) => MODEL_ID.test(model));
		const agents = stringList(item.agents, `${label} agents`, (agent) => (LOCAL_AGENTS as readonly string[]).includes(agent));
		if (models.length === 0 && agents.length === 0) throw new Error(`${label} must deny at least one model or agent`);
		if (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.trim() === "" || item.reason.length > 500)) {
			throw new Error(`${label} reason must be a non-empty string of at most 500 characters`);
		}
		return { id: item.id, roots, models, agents, reason: item.reason as string | undefined };
	});
}

function spellings(path: string): string[] {
	const lexical = resolve(path);
	try {
		const real = realpathSync(lexical);
		return real === lexical ? [lexical] : [lexical, real];
	} catch {
		return [lexical];
	}
}

function contains(root: string, path: string): boolean {
	return root === sep || path === root || path.startsWith(root + sep);
}

function deny(target: Map<string, string[]>, key: string, detail: string): void {
	const details = target.get(key) ?? [];
	details.push(detail);
	target.set(key, details);
}

/** Re-reads the fixed policy and evaluates it for one working directory. */
export function evaluateDisabledModels(homeDir: string, cwd: string): DisabledModelsEvaluation {
	const path = join(homeDir, DISABLED_MODELS_FILE);
	let raw: string;
	try {
		const bytes = readFileSync(path);
		if (bytes.length > MAX_BYTES) return invalid(path, "policy exceeds 1 MiB");
		raw = bytes.toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing", path, matchedRules: [], deniedModels: new Map(), deniedAgents: new Map() };
		}
		return invalid(path, `could not read policy (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	let rules: Rule[];
	try {
		rules = parseRules(raw);
	} catch (error) {
		return invalid(path, error instanceof SyntaxError ? "malformed JSON" : (error as Error).message);
	}
	const locations = spellings(cwd);
	const evaluation: DisabledModelsEvaluation = { status: "loaded", path, matchedRules: [], deniedModels: new Map(), deniedAgents: new Map() };
	for (const rule of rules) {
		const roots = rule.roots.flatMap(spellings);
		if (!roots.some((root) => locations.some((location) => contains(root, location)))) continue;
		evaluation.matchedRules.push(rule.id);
		const detail = rule.reason ? `${rule.id}: ${rule.reason}` : rule.id;
		for (const model of rule.models) deny(evaluation.deniedModels, model, detail);
		for (const agent of rule.agents) deny(evaluation.deniedAgents, agent, detail);
	}
	return evaluation;
}

export function describeDisabledModels(evaluation: DisabledModelsEvaluation): string {
	if (evaluation.status === "missing") return `${evaluation.path} (absent)`;
	if (evaluation.status === "invalid") return `${evaluation.path} (invalid: ${evaluation.error}; routing stopped)`;
	return `${evaluation.path} (matched rules: ${evaluation.matchedRules.join(", ") || "none"})`;
}
