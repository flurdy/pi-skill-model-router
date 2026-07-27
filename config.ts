import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ConfiguredConsentPolicy,
	ModelPolicy,
	SelectionPolicy,
	TierConfigurationSource,
	TierRoute,
	ThinkingLevel,
} from "./routing.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface UsageLedgerConfig {
	enabled: boolean;
	retentionDays: number;
	maxBytes: number;
}

export interface RouterConfig {
	enabled: boolean;
	routeImplicitSkillReads: boolean;
	usageLedger: UsageLedgerConfig;
	tiers: Record<string, TierRoute>;
	tierSources: Record<string, TierConfigurationSource>;
	modelPolicies: Record<string, ModelPolicy>;
}

export interface LoadedRouterConfig {
	config: RouterConfig;
	globalPath: string;
	projectPath: string;
	loadedPaths: string[];
	warnings: string[];
}

export interface LoadConfigOptions {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	configDirName?: string;
}

function emptyRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function emptyTiers(): Record<string, TierRoute> {
	return emptyRecord<TierRoute>();
}

const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	routeImplicitSkillReads: true,
	usageLedger: { enabled: false, retentionDays: 30, maxBytes: 10 * 1024 * 1024 },
	tiers: emptyTiers(),
	tierSources: emptyRecord<TierConfigurationSource>(),
	modelPolicies: emptyRecord<ModelPolicy>(),
};

function readJson(path: string, warnings: string[]): unknown | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function isExactModelId(value: unknown): value is string {
	return typeof value === "string" && value.includes("/") && !value.startsWith("/") && !value.endsWith("/");
}

function parseTier(name: string, value: unknown, path: string, warnings: string[]): TierRoute | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${path}: tier ${name} must be an object`);
		return undefined;
	}
	const input = value as Record<string, unknown>;
	if (typeof input.rank !== "number" || !Number.isFinite(input.rank)) {
		warnings.push(`${path}: tier ${name} has an invalid rank`);
		return undefined;
	}
	if (typeof input.thinking !== "string" || !THINKING_LEVELS.has(input.thinking as ThinkingLevel)) {
		warnings.push(`${path}: tier ${name} has an invalid thinking level`);
		return undefined;
	}
	if (!Array.isArray(input.candidates)) {
		warnings.push(`${path}: tier ${name} candidates must be an array`);
		return undefined;
	}
	let selection: SelectionPolicy = "first-available";
	let invalidSelectionPolicy = false;
	if (input.selection !== undefined) {
		if (input.selection === "first-available" || input.selection === "weighted-random") selection = input.selection;
		else {
			warnings.push(`${path}: tier ${name} has an invalid selection policy; tier routing disabled`);
			invalidSelectionPolicy = true;
		}
	}

	const candidates: TierRoute["candidates"] = [];
	let invalidWeightedCandidate = false;
	for (const [index, candidate] of input.candidates.entries()) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} must be an object`);
			if (selection === "weighted-random") invalidWeightedCandidate = true;
			continue;
		}
		const item = candidate as Record<string, unknown>;
		let weight: number | undefined;
		if (selection === "weighted-random") {
			if (!Number.isInteger(item.weight) || (item.weight as number) < 1 || (item.weight as number) > 100) {
				warnings.push(`${path}: tier ${name} candidate ${index + 1} weight must be an integer from 1 to 100; tier routing disabled`);
				invalidWeightedCandidate = true;
			} else {
				weight = item.weight as number;
			}
		} else if (item.weight !== undefined && !invalidSelectionPolicy) {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} weight is ignored by first-available selection`);
		}
		if (!isExactModelId(item.model)) {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} must use provider/model`);
			if (selection === "weighted-random") invalidWeightedCandidate = true;
			continue;
		}
		if (item.metered !== undefined && typeof item.metered !== "boolean") {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} metered must be boolean when provided`);
			if (selection === "weighted-random") invalidWeightedCandidate = true;
			continue;
		}
		candidates.push({ model: item.model, ...(item.metered === undefined ? {} : { metered: item.metered }), ...(weight === undefined ? {} : { weight }) });
	}
	return {
		rank: input.rank,
		thinking: input.thinking as ThinkingLevel,
		selection,
		routingDisabled: invalidWeightedCandidate || invalidSelectionPolicy || undefined,
		candidates,
	};
}

function parseModelPolicies(value: unknown, path: string, warnings: string[]): Record<string, ModelPolicy> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${path}: modelPolicies must be an object`);
		return undefined;
	}
	const policies = emptyRecord<ModelPolicy>();
	for (const [model, policy] of Object.entries(value)) {
		if (!isExactModelId(model)) {
			warnings.push(`${path}: modelPolicies key ${JSON.stringify(model)} must use provider/model`);
			continue;
		}
		if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
			warnings.push(`${path}: model policy ${model} must be an object`);
			continue;
		}
		const input = policy as Record<string, unknown>;
		if (typeof input.metered !== "boolean") {
			warnings.push(`${path}: model policy ${model} must declare a boolean metered flag`);
			continue;
		}
		let consent: ConfiguredConsentPolicy = "ask";
		if (input.consent !== undefined) {
			if (input.consent === "ask" || input.consent === "allow") consent = input.consent;
			else warnings.push(`${path}: model policy ${model} has invalid consent; defaulted to ask`);
		}
		policies[model] = { metered: input.metered, consent };
	}
	return policies;
}

interface PartialRouterConfig {
	enabled?: boolean;
	routeImplicitSkillReads?: boolean;
	usageLedger?: UsageLedgerConfig;
	tiers: Record<string, TierRoute>;
	modelPolicies?: Record<string, ModelPolicy>;
}

function parseConfig(value: unknown, path: string, warnings: string[]): PartialRouterConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${path}: configuration must be an object`);
		return undefined;
	}
	const input = value as Record<string, unknown>;
	const parsed: PartialRouterConfig = { tiers: emptyTiers() };
	for (const key of ["enabled", "routeImplicitSkillReads"] as const) {
		if (input[key] === undefined) continue;
		if (typeof input[key] !== "boolean") warnings.push(`${path}: ${key} must be boolean`);
		else parsed[key] = input[key];
	}
	if (input.usageLedger !== undefined) {
		if (!input.usageLedger || typeof input.usageLedger !== "object" || Array.isArray(input.usageLedger)) {
			warnings.push(`${path}: usageLedger must be an object`);
		} else {
			const ledger = input.usageLedger as Record<string, unknown>;
			if (typeof ledger.enabled !== "boolean") warnings.push(`${path}: usageLedger.enabled must be boolean`);
			else if (!Number.isInteger(ledger.retentionDays) || (ledger.retentionDays as number) < 1) warnings.push(`${path}: usageLedger.retentionDays must be a positive integer`);
			else if (!Number.isInteger(ledger.maxBytes) || (ledger.maxBytes as number) < 1024) warnings.push(`${path}: usageLedger.maxBytes must be an integer of at least 1024`);
			else parsed.usageLedger = { enabled: ledger.enabled, retentionDays: ledger.retentionDays as number, maxBytes: ledger.maxBytes as number };
		}
	}
	if (input.modelPolicies !== undefined) parsed.modelPolicies = parseModelPolicies(input.modelPolicies, path, warnings);
	if (input.tiers !== undefined) {
		if (!input.tiers || typeof input.tiers !== "object" || Array.isArray(input.tiers)) {
			warnings.push(`${path}: tiers must be an object`);
		} else {
			for (const [name, tier] of Object.entries(input.tiers)) {
				const parsedTier = parseTier(name, tier, path, warnings);
				if (parsedTier) parsed.tiers[name] = parsedTier;
			}
		}
	}
	return parsed;
}

function deriveGlobalModelPolicies(
	tiers: Record<string, TierRoute>,
	explicit: Record<string, ModelPolicy> | undefined,
	path: string,
	warnings: string[],
): Record<string, ModelPolicy> {
	const inline = emptyRecord<boolean>();
	for (const tier of Object.values(tiers)) {
		for (const candidate of tier.candidates) {
			if (candidate.metered === undefined) continue;
			const previous = inline[candidate.model];
			if (previous !== undefined && previous !== candidate.metered) {
				warnings.push(`${path}: model ${candidate.model} has conflicting global candidate classifications; treated as metered`);
				inline[candidate.model] = true;
			} else if (previous === undefined) {
				inline[candidate.model] = candidate.metered;
			}
		}
	}

	const policies = emptyRecord<ModelPolicy>();
	for (const [model, metered] of Object.entries(inline)) {
		policies[model] = { metered, consent: "ask" };
	}
	for (const [model, policy] of Object.entries(explicit ?? {})) {
		if (inline[model] !== undefined && inline[model] !== policy.metered) {
			warnings.push(`${path}: model policy ${model} conflicts with global candidate classification; explicit policy wins`);
		}
		policies[model] = policy;
	}
	return policies;
}

function mergeConfig(base: RouterConfig, override: PartialRouterConfig, source: TierConfigurationSource): RouterConfig {
	const tierSources = Object.assign(emptyRecord<TierConfigurationSource>(), base.tierSources);
	for (const name of Object.keys(override.tiers)) tierSources[name] = source;
	return {
		enabled: override.enabled ?? base.enabled,
		routeImplicitSkillReads: override.routeImplicitSkillReads ?? base.routeImplicitSkillReads,
		usageLedger: override.usageLedger ?? base.usageLedger,
		tiers: Object.assign(emptyTiers(), base.tiers, override.tiers),
		tierSources,
		modelPolicies: override.modelPolicies ?? base.modelPolicies,
	};
}

function warnForProjectClassificationGaps(config: RouterConfig, projectPath: string, warnings: string[]): void {
	for (const [tierName, tier] of Object.entries(config.tiers)) {
		if (config.tierSources[tierName] !== "project") continue;
		for (const candidate of tier.candidates) {
			const globalPolicy = config.modelPolicies[candidate.model];
			if (!globalPolicy && candidate.metered !== true) {
				warnings.push(`${projectPath}: tier ${tierName} candidate ${candidate.model} has no global model policy; treated as unknown-cost`);
			} else if (globalPolicy?.metered && candidate.metered === false) {
				warnings.push(`${projectPath}: tier ${tierName} candidate ${candidate.model} cannot lower its global metered classification`);
			}
		}
	}
}

export function loadRouterConfig(options: LoadConfigOptions): LoadedRouterConfig {
	const globalPath = join(options.agentDir, "model-tier-router.json");
	const projectPath = join(options.cwd, options.configDirName ?? ".pi", "model-tier-router.json");
	const loadedPaths: string[] = [];
	const warnings: string[] = [];
	let config = DEFAULT_CONFIG;

	const globalValue = readJson(globalPath, warnings);
	if (globalValue !== undefined) {
		const parsed = parseConfig(globalValue, globalPath, warnings);
		if (parsed) {
			parsed.modelPolicies = deriveGlobalModelPolicies(parsed.tiers, parsed.modelPolicies, globalPath, warnings);
			config = mergeConfig(config, parsed, "global");
			loadedPaths.push(globalPath);
		}
	}

	if (options.projectTrusted) {
		const projectValue = readJson(projectPath, warnings);
		if (projectValue !== undefined) {
			const parsed = parseConfig(projectValue, projectPath, warnings);
			if (parsed) {
				if (parsed.usageLedger) {
					warnings.push(`${projectPath}: usageLedger is global-only and was ignored`);
					parsed.usageLedger = undefined;
				}
				if (parsed.modelPolicies) {
					warnings.push(`${projectPath}: modelPolicies is global-only and was ignored`);
					parsed.modelPolicies = undefined;
				}
				config = mergeConfig(config, parsed, "project");
				warnForProjectClassificationGaps(config, projectPath, warnings);
				loadedPaths.push(projectPath);
			}
		}
	}

	return { config, globalPath, projectPath, loadedPaths, warnings };
}
