import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig, type LoadedRouterConfig, type UsageLedgerConfig } from "./config.ts";
import { UsageLedger } from "./usage-ledger.ts";
import { addUsageRecord, emptyUsageTotals, formatUsageSummary, normalizeUsage, type UsageRecordV1, type UsageTotals } from "./usage.ts";
import {
	canonicalPath,
	createRouteDecision,
	decideTier,
	findExactModel,
	maxThinkingLevel,
	parseSkillRouting,
	permitsImplicitRouting,
	requiresConsentConfirmation,
	resolveCandidatePolicy,
	selectRouteCandidate,
	type ConsentBasis,
	type EffectiveConsentPolicy,
	type MeteredClassification,
	type ModelCandidate,
	type ResolvedCandidatePolicy,
	type ModelIdentity,
	type RouteDecisionRecord,
	type SelectionPolicy,
	type SelectionPoolEntry,
	type SkillRoutingMetadata,
	type ThinkingLevel,
} from "./routing.ts";

const STATUS_KEY = "model-tier-router";

interface RunState {
	originalModel: Model<Api> | undefined;
	originalThinking: ThinkingLevel;
	activeTier: string;
	activeRank: number;
	activeCandidate: ModelCandidate;
	activeMeteredClassification: MeteredClassification;
	activeConsentPolicy: EffectiveConsentPolicy;
	activeSelectionPolicy: SelectionPolicy;
	activeSelectionPool: SelectionPoolEntry[];
	requestedThinking: ThinkingLevel;
	activeThinking: ThinkingLevel;
	routedSkills: string[];
	manualModelOverride: boolean;
	restoreOwed: boolean;
	routeRunId: string;
	responseIndex: number;
	tierSourceSkill: string;
	activeDecision: RouteDecisionRecord;
	attributionActive: boolean;
}

interface PendingExplicitRoute {
	skillName: string;
	path: string;
}

type SkillRouteSource = "explicit-command" | "implicit-read";

function modelIdentity(model: Model<Api> | undefined): ModelIdentity | undefined {
	return model && { provider: model.provider, model: model.id };
}

function modelId(model: Model<Api> | undefined): string {
	const identity = modelIdentity(model);
	return identity ? `${identity.provider}/${identity.model}` : "(none)";
}

export interface UsageLedgerPort {
	start(): void;
	health(): { pending: number; dropped: number; writeErrors: number };
	enqueue(record: UsageRecordV1): void;
	drain(): Promise<void>;
	drainWithin(timeoutMs: number): Promise<void>;
	readRecords(): Promise<{ records: UsageRecordV1[]; skipped: number }>;
}

export interface ManagedUsageLedger {
	ledger: UsageLedgerPort | undefined;
	config: UsageLedgerConfig | undefined;
}

function sameUsageLedgerConfig(left: UsageLedgerConfig | undefined, right: UsageLedgerConfig | undefined): boolean {
	return left?.enabled === right?.enabled
		&& left?.retentionDays === right?.retentionDays
		&& left?.maxBytes === right?.maxBytes;
}

export async function reconcileUsageLedger(
	current: ManagedUsageLedger,
	nextConfig: UsageLedgerConfig | undefined,
	create: (config: UsageLedgerConfig) => UsageLedgerPort,
): Promise<ManagedUsageLedger> {
	if (current.ledger && sameUsageLedgerConfig(current.config, nextConfig)) return current;
	if (!current.ledger && !nextConfig) return { ledger: undefined, config: undefined };

	await current.ledger?.drain();
	const ledger = nextConfig ? create(nextConfig) : undefined;
	ledger?.start();
	return { ledger, config: nextConfig };
}

export interface ModelTierRouterOptions {
	agentDir?: string;
	random?: () => number;
	usageLedger?: UsageLedgerPort;
}

export default function modelTierRouter(pi: ExtensionAPI, options: ModelTierRouterOptions = {}): void {
	let loaded: LoadedRouterConfig | undefined;
	let enabledOverride: boolean | undefined;
	let run: RunState | undefined;
	let pendingExplicitRoute: PendingExplicitRoute | undefined;
	let switchingModel = false;
	let loadedSkills = new Map<string, Skill>();
	let usageLedger: UsageLedgerPort | undefined;
	let usageLedgerConfig: UsageLedgerConfig | undefined;
	let injectedUsageLedgerStarted = false;
	let latestRouteDecision: RouteDecisionRecord | undefined;
	const warningKeys = new Set<string>();
	const unavailableWarnings: string[] = [];

	function isEnabled(): boolean {
		return enabledOverride ?? loaded?.config.enabled ?? true;
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warningKeys.has(key)) return;
		warningKeys.add(key);
		unavailableWarnings.push(message);
		notify(ctx, `model-tier: ${message}`, "warning");
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_KEY,
			run ? `tier:${run.activeTier}:thinking:${run.activeThinking}${run.restoreOwed ? ":restore-owed" : ""}` : undefined,
		);
	}

	function recordRouteDecision(
		ctx: ExtensionContext,
		requestedTier: string,
		candidate: ModelCandidate | undefined,
		consentBasis: ConsentBasis,
		reason: string,
		warnings: string[] = [],
		restoration: RouteDecisionRecord["restoration"] = "not-applicable",
		effectiveTier = requestedTier,
		policy?: { meteredClassification: MeteredClassification; consentPolicy: EffectiveConsentPolicy },
		selection?: { policy: SelectionPolicy; pool: SelectionPoolEntry[] },
	): RouteDecisionRecord {
		const record = createRouteDecision({
			requestedTier,
			effectiveTier,
			candidate,
			effectiveModel: modelIdentity(ctx.model),
			thinkingLevel: pi.getThinkingLevel(),
			meteredClassification: policy?.meteredClassification,
			consentPolicy: policy?.consentPolicy,
			consentBasis,
			selectionPolicy: selection?.policy,
			selectionPool: selection?.pool,
			reason,
			warnings,
			restoration,
		});
		latestRouteDecision = record;
		return record;
	}

	function activateDecision(state: RunState, decision: RouteDecisionRecord, skillName: string): void {
		state.activeDecision = decision;
		state.tierSourceSkill = skillName;
		if (!state.routedSkills.includes(skillName)) state.routedSkills.push(skillName);
	}

	function updateRestoration(state: RunState, restoration: RouteDecisionRecord["restoration"]): void {
		const previous = state.activeDecision;
		state.activeDecision = { ...previous, restoration };
		if (latestRouteDecision === previous) latestRouteDecision = state.activeDecision;
		else if (latestRouteDecision?.restoration === "pending") latestRouteDecision = { ...latestRouteDecision, restoration };
	}

	async function reloadConfig(ctx: ExtensionContext): Promise<void> {
		const agentDir = options.agentDir ?? getAgentDir();
		loaded = loadRouterConfig({
			agentDir,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			configDirName: CONFIG_DIR_NAME,
		});
		if (options.usageLedger) {
			usageLedger = options.usageLedger;
			if (!injectedUsageLedgerStarted) {
				usageLedger.start();
				injectedUsageLedgerStarted = true;
			}
		} else {
			const ledgerConfig = loaded.config.usageLedger;
			const managed = await reconcileUsageLedger(
				{ ledger: usageLedger, config: usageLedgerConfig },
				ledgerConfig.enabled ? ledgerConfig : undefined,
				(config) => new UsageLedger(UsageLedger.defaults(join(agentDir, "model-tier-router", "usage", "v1"), config.retentionDays, config.maxBytes)),
			);
			usageLedger = managed.ledger;
			usageLedgerConfig = managed.config;
		}
		for (const warning of loaded.warnings) notify(ctx, `model-tier: ${warning}`, "warning");
	}

	function recordUsage(message: AssistantMessage, ctx: ExtensionContext): void {
		const state = run;
		if (!state?.attributionActive || !usageLedger) return;
		const { usage, unknownUsageFields } = normalizeUsage(message);
		const record: UsageRecordV1 = {
			schemaVersion: 1,
			recordId: randomUUID(),
			timestamp: new Date(message.timestamp).toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			routeRunId: state.routeRunId,
			responseIndex: ++state.responseIndex,
			tier: state.activeDecision.effectiveTier,
			tierSourceSkill: state.tierSourceSkill,
			routedSkills: [...state.routedSkills],
			provider: message.provider,
			model: message.model,
			responseModel: message.responseModel ?? null,
			thinking: state.activeDecision.thinkingLevel,
			stopReason: message.stopReason,
			usage,
			unknownUsageFields,
			providerReportedCost: null,
		};
		usageLedger.enqueue(record);
	}

	function readMetadata(path: string, ctx: ExtensionContext): SkillRoutingMetadata | undefined {
		try {
			return parseSkillRouting(readFileSync(path, "utf8"));
		} catch (error) {
			warnOnce(ctx, `skill:${path}`, `could not read skill metadata from ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	function raiseRunThinking(state: RunState, requested: ThinkingLevel, skillName: string, ctx: ExtensionContext): void {
		const previousThinking = pi.getThinkingLevel();
		state.requestedThinking = maxThinkingLevel(
			maxThinkingLevel(state.requestedThinking, requested),
			previousThinking,
		);
		if (state.requestedThinking !== previousThinking) pi.setThinkingLevel(state.requestedThinking);
		state.activeThinking = pi.getThinkingLevel();
		const previousDecision = state.activeDecision;
		state.activeDecision = { ...previousDecision, thinkingLevel: state.activeThinking };
		if (latestRouteDecision === previousDecision) latestRouteDecision = state.activeDecision;
		if (state.activeThinking !== previousThinking) {
			notify(ctx, `model-tier: raised thinking to ${state.activeThinking} for nested ${skillName}`, "info");
		}
		updateStatus(ctx);
	}

	async function routeSkill(
		skillName: string,
		path: string,
		source: SkillRouteSource,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!isEnabled() || !loaded) return;
		const config = loaded.config;
		if (run?.restoreOwed) {
			warnOnce(ctx, "restore-owed", `skipped ${skillName} while restoration of ${modelId(run.originalModel)} is owed`);
			return;
		}
		if (run?.manualModelOverride) {
			warnOnce(ctx, "manual-override", `skipped ${skillName} after a manual model selection`);
			return;
		}
		const metadata = readMetadata(path, ctx);
		if (!metadata?.tier) return;

		const currentEffectiveTier = run?.activeDecision.effectiveTier ?? metadata.tier;
		const activeRestoration: RouteDecisionRecord["restoration"] = run ? "pending" : "not-applicable";
		const route = Object.hasOwn(config.tiers, metadata.tier)
			? config.tiers[metadata.tier]
			: undefined;
		if (!route) {
			const warning = `unknown or unconfigured tier ${metadata.tier}; retained ${modelId(ctx.model)}`;
			warnOnce(ctx, `tier:${metadata.tier}`, warning);
			const routeDecision = recordRouteDecision(ctx, metadata.tier, undefined, "not-applicable", "unknown-tier", [warning], activeRestoration, currentEffectiveTier);
			if (run) activateDecision(run, routeDecision, skillName);
			return;
		}

		const requestedThinking = metadata.effort ?? route.thinking;
		const decision = decideTier(run ? { tier: run.activeTier, rank: run.activeRank } : undefined, {
			tier: metadata.tier,
			rank: route.rank,
		});
		if (decision === "retain-lower" || decision === "retain-equal") {
			if (!run) return;
			if (!run.routedSkills.includes(skillName)) run.routedSkills.push(skillName);
			raiseRunThinking(run, requestedThinking, skillName, ctx);
			const routeDecision = recordRouteDecision(
				ctx,
				metadata.tier,
				run.activeCandidate,
				"not-applicable",
				decision,
				[],
				"pending",
				currentEffectiveTier,
				{
					meteredClassification: run.activeMeteredClassification,
					consentPolicy: run.activeConsentPolicy,
				},
				{ policy: run.activeSelectionPolicy, pool: run.activeSelectionPool },
			);
			activateDecision(run, routeDecision, skillName);
			if (decision === "retain-lower") {
				notify(ctx, `model-tier: retained ${run.activeTier}; ignored nested ${metadata.tier}`, "info");
			}
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const tierSource = config.tierSources[metadata.tier] ?? "global";
		const resolvePolicy = (candidate: ModelCandidate): ResolvedCandidatePolicy => resolveCandidatePolicy(
			candidate,
			tierSource,
			config.modelPolicies[candidate.model],
		);
		const selection = selectRouteCandidate(
			route,
			available,
			(candidate) => {
				const policy = resolvePolicy(candidate);
				if (source === "implicit-read") return permitsImplicitRouting(policy);
				return ctx.hasUI || !requiresConsentConfirmation(policy);
			},
			options.random,
		);
		const candidate = selection.candidate;
		const target = candidate ? findExactModel(candidate, available) : undefined;
		if (!candidate || !target) {
			if (run) raiseRunThinking(run, requestedThinking, skillName, ctx);
			const reason = route.routingDisabled
				? "invalid-tier-configuration"
				: selection.policy === "weighted-random" && selection.pool.length === 0
					? "no-eligible-candidate"
					: "no-available-candidate";
			const detail = reason === "invalid-tier-configuration"
				? `invalid configuration disabled routing for ${metadata.tier}; see /model-tier status config warnings`
				: `${reason === "no-eligible-candidate" ? "no eligible" : "no available"} candidate for ${metadata.tier}`;
			const warning = `${detail}; retained ${modelId(ctx.model)}`;
			warnOnce(ctx, `${reason}:${metadata.tier}`, warning);
			const routeDecision = recordRouteDecision(ctx, metadata.tier, undefined, "not-applicable", reason, [warning], activeRestoration, currentEffectiveTier, undefined, selection);
			if (run) activateDecision(run, routeDecision, skillName);
			return;
		}

		const candidatePolicy = resolvePolicy(candidate);
		const exposure = candidatePolicy.meteredClassification === "unknown" ? "unknown-cost" : "metered";
		if (source === "implicit-read" && !permitsImplicitRouting(candidatePolicy)) {
			if (run) raiseRunThinking(run, requestedThinking, skillName, ctx);
			const warning = `skipped ${exposure} ${candidate.model} for ${metadata.tier} because implicit skill reads do not prompt`;
			warnOnce(ctx, `${exposure}:implicit:${metadata.tier}`, warning);
			const routeDecision = recordRouteDecision(ctx, metadata.tier, candidate, "not-requested-implicit", `${exposure}-implicit-skip`, [warning], activeRestoration, currentEffectiveTier, candidatePolicy, selection);
			if (run) activateDecision(run, routeDecision, skillName);
			return;
		}

		if (requiresConsentConfirmation(candidatePolicy)) {
			if (!ctx.hasUI) {
				if (run) raiseRunThinking(run, requestedThinking, skillName, ctx);
				const warning = `skipped ${exposure} ${candidate.model} for ${metadata.tier} because no confirmation UI is available`;
				warnOnce(ctx, `${exposure}:no-ui:${metadata.tier}`, warning);
				const routeDecision = recordRouteDecision(ctx, metadata.tier, candidate, "unavailable-ui", `${exposure}-no-ui-skip`, [warning], activeRestoration, currentEffectiveTier, candidatePolicy, selection);
				if (run) activateDecision(run, routeDecision, skillName);
				return;
			}
			const policies = [
				candidatePolicy.meteredClassification === "unknown" ? "cost: unknown" : undefined,
				metadata.costPolicy,
				metadata.meteredPolicy,
			].filter(Boolean).join(", ");
			const confirmed = await ctx.ui.confirm(
				candidatePolicy.meteredClassification === "unknown" ? "Use unknown-cost model?" : "Use metered model?",
				`${skillName} requests ${metadata.tier} → ${candidate.model}${policies ? ` (${policies})` : ""}. Continue?`,
			);
			if (!confirmed) {
				if (run) raiseRunThinking(run, requestedThinking, skillName, ctx);
				const warning = `declined ${exposure} ${candidate.model} for ${metadata.tier}`;
				warnOnce(ctx, `${exposure}:declined:${metadata.tier}`, warning);
				const routeDecision = recordRouteDecision(ctx, metadata.tier, candidate, "declined", `${exposure}-declined`, [warning], activeRestoration, currentEffectiveTier, candidatePolicy, selection);
				if (run) activateDecision(run, routeDecision, skillName);
				return;
			}
		}

		const consentBasis: ConsentBasis = candidatePolicy.meteredClassification === false
			? "not-needed"
			: candidatePolicy.consentPolicy === "allow" ? "configured" : "confirmed";
		const originalModel = run?.originalModel ?? ctx.model;
		const originalThinking = run?.originalThinking ?? pi.getThinkingLevel();
		const selectedThinking = run
			? maxThinkingLevel(maxThinkingLevel(run.requestedThinking, requestedThinking), pi.getThinkingLevel())
			: requestedThinking;
		switchingModel = true;
		let switched = false;
		try {
			switched = await pi.setModel(target);
			if (switched) pi.setThinkingLevel(selectedThinking);
		} finally {
			switchingModel = false;
		}
		if (!switched) {
			if (run) raiseRunThinking(run, requestedThinking, skillName, ctx);
			const warning = `could not select ${candidate.model}; retained ${modelId(ctx.model)}`;
			warnOnce(ctx, `switch:${candidate.model}`, warning);
			const routeDecision = recordRouteDecision(ctx, metadata.tier, candidate, consentBasis, "model-switch-failed", [warning], activeRestoration, currentEffectiveTier, candidatePolicy, selection);
			if (run) activateDecision(run, routeDecision, skillName);
			return;
		}

		const activeDecision = recordRouteDecision(ctx, metadata.tier, candidate, consentBasis, "routed", [], "pending", metadata.tier, candidatePolicy, selection);
		if (!run) {
			run = {
				originalModel,
				originalThinking,
				activeTier: metadata.tier,
				activeRank: route.rank,
				activeCandidate: candidate,
				activeMeteredClassification: candidatePolicy.meteredClassification,
				activeConsentPolicy: candidatePolicy.consentPolicy,
				activeSelectionPolicy: selection.policy,
				activeSelectionPool: selection.pool,
				requestedThinking,
				activeThinking: pi.getThinkingLevel(),
				routedSkills: [skillName],
				manualModelOverride: false,
				restoreOwed: false,
				routeRunId: randomUUID(),
				responseIndex: 0,
				tierSourceSkill: skillName,
				activeDecision,
				attributionActive: true,
			};
		} else {
			run.activeTier = metadata.tier;
			run.activeRank = route.rank;
			run.activeCandidate = candidate;
			run.activeMeteredClassification = candidatePolicy.meteredClassification;
			run.activeConsentPolicy = candidatePolicy.consentPolicy;
			run.activeSelectionPolicy = selection.policy;
			run.activeSelectionPool = selection.pool;
			run.requestedThinking = selectedThinking;
			run.activeThinking = pi.getThinkingLevel();
			activateDecision(run, activeDecision, skillName);
		}
		updateStatus(ctx);
		notify(ctx, `model-tier: ${skillName} → ${metadata.tier} → ${candidate.model} (thinking:${run.activeThinking})`, "info");
	}

	async function restore(ctx: ExtensionContext, announce: boolean): Promise<void> {
		const state = run;
		if (!state) return;
		if (state.manualModelOverride) {
			updateRestoration(state, "cancelled-by-manual-override");
			run = undefined;
			updateStatus(ctx);
			return;
		}

		state.restoreOwed = true;
		updateRestoration(state, "pending");
		updateStatus(ctx);
		switchingModel = true;
		let restored = false;
		try {
			restored = state.originalModel ? await pi.setModel(state.originalModel) : true;
			if (restored) pi.setThinkingLevel(state.originalThinking);
		} finally {
			switchingModel = false;
		}
		if (restored) {
			updateRestoration(state, "restored");
			run = undefined;
			if (announce) notify(ctx, `model-tier: restored ${modelId(state.originalModel)} (thinking:${state.originalThinking})`, "info");
		} else {
			updateRestoration(state, "failed");
			notify(ctx, `model-tier: could not restore ${modelId(state.originalModel)}; will retry before the next run or when the agent settles (choose a model manually to clear)`, "warning");
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		pendingExplicitRoute = undefined;
		latestRouteDecision = undefined;
		await reloadConfig(ctx);
		updateStatus(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !isEnabled()) return { action: "continue" };
		const match = event.text.match(/^\/(skill:[^\s]+)(?:\s|$)/);
		if (!match) return { action: "continue" };
		const invocation = match[1];
		const command = pi.getCommands().find((item) => {
			const name = (item as typeof item & { invocationName?: string }).invocationName ?? item.name;
			const source = (item as typeof item & { source?: string }).source ?? item.sourceInfo.source;
			return name === invocation && source === "skill";
		});
		if (!command) return { action: "continue" };
		if (event.streamingBehavior) {
			warnOnce(ctx, `streaming:${invocation}`, `skipped routing queued /${invocation}; retained ${modelId(ctx.model)}`);
			return { action: "continue" };
		}
		pendingExplicitRoute = {
			skillName: invocation.slice("skill:".length),
			path: command.sourceInfo.path,
		};
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (run?.restoreOwed) await restore(ctx, true);
		const pending = pendingExplicitRoute;
		pendingExplicitRoute = undefined;
		if (pending && event.prompt.startsWith(`<skill name="${pending.skillName}" location="${pending.path}">\n`)) {
			await routeSkill(pending.skillName, pending.path, "explicit-command", ctx);
		}

		const entries = await Promise.all(
			(event.systemPromptOptions.skills ?? []).map(async (skill) => {
				const path = await canonicalPath(skill.filePath, ctx.cwd);
				return path ? ([path, skill] as const) : undefined;
			}),
		);
		loadedSkills = new Map(entries.filter((entry): entry is readonly [string, Skill] => entry !== undefined));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isEnabled() || !loaded?.config.routeImplicitSkillReads || !isToolCallEventType("read", event)) return;
		const path = await canonicalPath(event.input.path, ctx.cwd);
		if (!path) return;
		const skill = loadedSkills.get(path);
		if (skill) await routeSkill(skill.name, skill.filePath, "implicit-read", ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (!run || switchingModel || event.source === "restore") return;
		run.manualModelOverride = true;
		run.attributionActive = false;
		updateRestoration(run, "cancelled-by-manual-override");
		if (run.restoreOwed) {
			updateRestoration(run, "cancelled-by-manual-override");
			run = undefined;
			updateStatus(ctx);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") recordUsage(event.message, ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (run && !ctx.isIdle()) {
			run.restoreOwed = true;
			updateRestoration(run, "deferred");
			notify(ctx, `model-tier: deferred restoration of ${modelId(run.originalModel)} while another run is active`, "warning");
			updateStatus(ctx);
		} else {
			await restore(ctx, true);
		}
		pendingExplicitRoute = undefined;
		loadedSkills.clear();
		warningKeys.clear();
		unavailableWarnings.length = 0;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (run) run.attributionActive = false;
		await restore(ctx, false);
		await usageLedger?.drainWithin(50);
		pendingExplicitRoute = undefined;
		loadedSkills.clear();
	});

	pi.registerCommand("model-tier", {
		description: "Show routing state or Pi-normalized local usage; reload, enable, or disable routing",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "reload") {
				enabledOverride = undefined;
				await reloadConfig(ctx);
				notify(ctx, `model-tier: reloaded ${loaded?.loadedPaths.join(", ") || "defaults"}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				enabledOverride = action === "on";
				notify(ctx, `model-tier: ${action}`, "info");
				return;
			}
			if (action === "usage") {
				if (!usageLedger) {
					notify(ctx, "model-tier: usage ledger is disabled (set global usageLedger.enabled to true)", "info");
					return;
				}
				await usageLedger.drainWithin(50);
				const { records, skipped } = await usageLedger.readRecords();
				const groups = new Map<string, UsageTotals>();
				for (const record of records) {
					const key = `${record.tier} | ${record.provider}/${record.model}`;
					let totals = groups.get(key);
					if (!totals) {
						totals = emptyUsageTotals();
						groups.set(key, totals);
					}
					addUsageRecord(totals, record);
				}
				const health = usageLedger.health();
				notify(ctx, formatUsageSummary([...groups].map(([route, totals]) => ({ route, totals })), health, skipped), "info");
				return;
			}
			if (action !== "status") {
				notify(ctx, "Usage: /model-tier status|usage|reload|on|off", "warning");
				return;
			}
			const lines = [
				`enabled: ${isEnabled()}`,
				`active tier: ${run?.activeTier ?? "(none)"}`,
				`requested thinking: ${run?.requestedThinking ?? "(none)"}`,
				`active thinking: ${run?.activeThinking ?? "(none)"}`,
				`skills: ${run?.routedSkills.join(", ") || "(none)"}`,
				`selected model: ${modelId(ctx.model)}`,
				`original model: ${modelId(run?.originalModel)}`,
				`restoration pending: ${Boolean(run && !run.manualModelOverride)}`,
				`restoration owed: ${run?.restoreOwed ?? false}`,
				`manual model override: ${run?.manualModelOverride ?? false}`,
				`config: ${loaded?.loadedPaths.join(", ") || "defaults"}`,
				`config warnings: ${loaded?.warnings.join("; ") || "(none)"}`,
				`last route decision: ${latestRouteDecision ? JSON.stringify(latestRouteDecision) : "(none)"}`,
				`warnings: ${unavailableWarnings.join("; ") || "(none)"}`,
				`usage ledger: ${usageLedger ? JSON.stringify(usageLedger.health()) : "disabled"}`,
			];
			notify(ctx, lines.join("\n"), "info");
		},
	});
}
