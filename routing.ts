import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCandidate {
	model: string;
	/** Legacy or project-local classification. Prefer global modelPolicies for exact-model policy. */
	metered?: boolean;
	weight?: number;
}

export type SelectionPolicy = "first-available" | "weighted-random";

export interface SelectionPoolEntry {
	model: string;
	weight: number;
}

export interface CandidateSelection {
	candidate: ModelCandidate | undefined;
	policy: SelectionPolicy;
	pool: SelectionPoolEntry[];
}

export type ConfiguredConsentPolicy = "ask" | "allow";
export type EffectiveConsentPolicy = "not-applicable" | "not-needed" | ConfiguredConsentPolicy;
export type TierConfigurationSource = "global" | "project";

export interface ModelPolicy {
	metered: boolean;
	consent: ConfiguredConsentPolicy;
}

export interface ResolvedCandidatePolicy {
	meteredClassification: MeteredClassification;
	consentPolicy: Exclude<EffectiveConsentPolicy, "not-applicable">;
}

export interface TierRoute {
	rank: number;
	thinking: ThinkingLevel;
	selection?: SelectionPolicy;
	routingDisabled?: boolean;
	candidates: ModelCandidate[];
}

export interface SkillRoutingMetadata {
	tier?: string;
	costPolicy?: string;
	meteredPolicy?: string;
	effort?: ThinkingLevel;
}

export interface ActiveTier {
	tier: string;
	rank: number;
}

export interface ModelIdentity {
	provider: string;
	model: string;
}

export type MeteredClassification = boolean | "unknown";
export type ConsentBasis = "not-needed" | "configured" | "confirmed" | "declined" | "unavailable-ui" | "not-requested-implicit" | "not-applicable";
export type RestorationResult = "not-applicable" | "pending" | "deferred" | "restored" | "failed" | "cancelled-by-manual-override";

/** One consistent account of a model-routing decision, including outcomes that retain the current route. */
export interface RouteDecisionRecord {
	requestedTier: string;
	effectiveTier: string;
	candidate: ModelCandidate | null;
	effectiveModel: ModelIdentity | null;
	thinkingLevel: ThinkingLevel;
	meteredClassification: MeteredClassification;
	consentPolicy: EffectiveConsentPolicy;
	consentBasis: ConsentBasis;
	selectionPolicy: SelectionPolicy;
	selectionPool: SelectionPoolEntry[];
	reason: string;
	warnings: string[];
	restoration: RestorationResult;
}

export interface RouteDecisionInput {
	requestedTier: string;
	effectiveTier?: string;
	candidate?: ModelCandidate;
	effectiveModel?: ModelIdentity;
	thinkingLevel: ThinkingLevel;
	meteredClassification?: MeteredClassification;
	consentPolicy?: EffectiveConsentPolicy;
	consentBasis: ConsentBasis;
	selectionPolicy?: SelectionPolicy;
	selectionPool?: SelectionPoolEntry[];
	reason: string;
	warnings?: string[];
	restoration?: RestorationResult;
}

export function createRouteDecision(input: RouteDecisionInput): RouteDecisionRecord {
	return {
		requestedTier: input.requestedTier,
		effectiveTier: input.effectiveTier ?? input.requestedTier,
		candidate: input.candidate ? { ...input.candidate } : null,
		effectiveModel: input.effectiveModel ? { ...input.effectiveModel } : null,
		thinkingLevel: input.thinkingLevel,
		meteredClassification: input.meteredClassification ?? input.candidate?.metered ?? "unknown",
		consentPolicy: input.consentPolicy ?? (input.candidate ? (input.candidate.metered === false ? "not-needed" : "ask") : "not-applicable"),
		consentBasis: input.consentBasis,
		selectionPolicy: input.selectionPolicy ?? "first-available",
		selectionPool: (input.selectionPool ?? []).map((entry) => ({ ...entry })),
		reason: input.reason,
		warnings: [...(input.warnings ?? [])],
		restoration: input.restoration ?? "not-applicable",
	};
}

export type TierDecision = "initial" | "upgrade" | "retain-lower" | "retain-equal";

interface RoutingFrontmatter extends Record<string, unknown> {
	"model-tier"?: unknown;
	"model-cost-policy"?: unknown;
	"model-metered-policy"?: unknown;
	model?: unknown;
	"model-second-opinion-tier"?: unknown;
	effort?: unknown;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const normalized = optionalString(value);
	return normalized && THINKING_LEVELS.includes(normalized as ThinkingLevel)
		? (normalized as ThinkingLevel)
		: undefined;
}

/** Extract only router-owned metadata. Claude's `model` and second-opinion metadata are intentionally ignored. */
export function parseSkillRouting(content: string): SkillRoutingMetadata {
	const { frontmatter } = parseFrontmatter<RoutingFrontmatter>(content);
	return {
		tier: optionalString(frontmatter["model-tier"]),
		costPolicy: optionalString(frontmatter["model-cost-policy"]),
		meteredPolicy: optionalString(frontmatter["model-metered-policy"]),
		effort: optionalThinkingLevel(frontmatter.effort),
	};
}

export function maxThinkingLevel(left: ThinkingLevel, right: ThinkingLevel): ThinkingLevel {
	return THINKING_LEVELS.indexOf(left) >= THINKING_LEVELS.indexOf(right) ? left : right;
}

export function decideTier(active: ActiveTier | undefined, requested: ActiveTier): TierDecision {
	if (!active) return "initial";
	if (requested.rank > active.rank) return "upgrade";
	if (requested.rank < active.rank) return "retain-lower";
	return "retain-equal";
}

/**
 * Selects one exact configured candidate before the provider request starts.
 *
 * This is deliberately not a post-launch retry mechanism. Runtime fallback, if
 * introduced, must remain bounded to configured candidates and reapply the
 * identity, metering, and consent checks documented in README.md.
 */
export function selectCandidate(route: TierRoute, available: Model<Api>[]): ModelCandidate | undefined {
	return selectRouteCandidate(route, available).candidate;
}

export function selectRouteCandidate(
	route: TierRoute,
	available: Model<Api>[],
	isEligible: (candidate: ModelCandidate) => boolean = () => true,
	random: () => number = Math.random,
): CandidateSelection {
	const policy = route.selection ?? "first-available";
	if (route.routingDisabled) return { candidate: undefined, policy, pool: [] };
	const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
	const availableCandidates = route.candidates.filter((candidate) => availableIds.has(candidate.model));
	if (policy === "first-available") {
		return {
			candidate: availableCandidates[0],
			policy,
			pool: availableCandidates.map((candidate) => ({ model: candidate.model, weight: 1 })),
		};
	}

	const eligible = availableCandidates.filter(isEligible);
	const pool = eligible.map((candidate) => ({ model: candidate.model, weight: candidate.weight ?? 1 }));
	const totalWeight = pool.reduce((total, entry) => total + entry.weight, 0);
	if (totalWeight === 0) return { candidate: undefined, policy, pool };
	let draw = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * totalWeight;
	for (const candidate of eligible) {
		draw -= candidate.weight ?? 1;
		if (draw < 0) return { candidate, policy, pool };
	}
	return { candidate: eligible.at(-1), policy, pool };
}

export function findExactModel(candidate: ModelCandidate, available: Model<Api>[]): Model<Api> | undefined {
	return available.find((model) => `${model.provider}/${model.id}` === candidate.model);
}

export function resolveCandidatePolicy(
	candidate: ModelCandidate,
	tierSource: TierConfigurationSource,
	globalPolicy?: ModelPolicy,
): ResolvedCandidatePolicy {
	if (tierSource === "global") {
		if (globalPolicy) {
			return {
				meteredClassification: globalPolicy.metered,
				consentPolicy: globalPolicy.metered ? globalPolicy.consent : "not-needed",
			};
		}
		return candidate.metered === undefined
			? { meteredClassification: "unknown", consentPolicy: "ask" }
			: { meteredClassification: candidate.metered, consentPolicy: candidate.metered ? "ask" : "not-needed" };
	}

	if (!globalPolicy) {
		return candidate.metered === true
			? { meteredClassification: true, consentPolicy: "ask" }
			: { meteredClassification: "unknown", consentPolicy: "ask" };
	}
	if (globalPolicy.metered) {
		return { meteredClassification: true, consentPolicy: globalPolicy.consent };
	}
	if (candidate.metered) {
		return { meteredClassification: true, consentPolicy: "ask" };
	}
	return { meteredClassification: false, consentPolicy: "not-needed" };
}

export function requiresConsentConfirmation(policy: ResolvedCandidatePolicy): boolean {
	return policy.meteredClassification === "unknown"
		|| (policy.meteredClassification && policy.consentPolicy === "ask");
}

export function permitsImplicitRouting(policy: ResolvedCandidatePolicy): boolean {
	return policy.meteredClassification === false
		|| (policy.meteredClassification === true && policy.consentPolicy === "allow");
}

export async function canonicalPath(path: string, cwd: string): Promise<string | undefined> {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	try {
		return await realpath(resolve(cwd, normalized));
	} catch {
		return undefined;
	}
}
