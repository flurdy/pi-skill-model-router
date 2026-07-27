import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./routing.ts";

export const USAGE_SCHEMA_VERSION = 1;

export type UsageField = "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "output" | "reasoning";

export interface ObservedUsage {
	input: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	cacheWrite1h: number | null;
	output: number | null;
	reasoning: number | null;
}

export interface UsageRecordV1 {
	schemaVersion: typeof USAGE_SCHEMA_VERSION;
	recordId: string;
	timestamp: string;
	sessionId: string;
	routeRunId: string;
	responseIndex: number;
	tier: string;
	tierSourceSkill: string;
	routedSkills: string[];
	provider: string;
	model: string;
	responseModel: string | null;
	thinking: ThinkingLevel;
	stopReason: AssistantMessage["stopReason"];
	usage: ObservedUsage;
	unknownUsageFields: UsageField[];
	providerReportedCost: null;
}

export interface UsageTotals {
	responses: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	output: number;
	reasoning: number;
	unknown: Record<UsageField, number>;
}

export interface UsageSummaryRow {
	route: string;
	totals: UsageTotals;
}

export interface UsageLedgerHealth {
	pending: number;
	dropped: number;
	writeErrors: number;
}

/** Pi's core usage counters are numeric; zero means a known zero, while omitted fields remain unavailable. */
function observed(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeUsage(message: AssistantMessage): { usage: ObservedUsage; unknownUsageFields: UsageField[] } {
	const usage: ObservedUsage = {
		input: observed(message.usage.input),
		cacheRead: observed(message.usage.cacheRead),
		cacheWrite: observed(message.usage.cacheWrite),
		cacheWrite1h: observed(message.usage.cacheWrite1h),
		output: observed(message.usage.output),
		reasoning: observed(message.usage.reasoning),
	};
	const unknownUsageFields = (Object.keys(usage) as UsageField[]).filter((field) => usage[field] === null);
	return { usage, unknownUsageFields };
}

const USAGE_FIELDS: UsageField[] = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "reasoning"];
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STOP_REASONS = new Set<AssistantMessage["stopReason"]>(["stop", "length", "toolUse", "error", "aborted"]);

export function isUsageRecordV1(value: unknown): value is UsageRecordV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<UsageRecordV1>;
	if (
		record.schemaVersion !== USAGE_SCHEMA_VERSION ||
		typeof record.recordId !== "string" || !record.recordId ||
		typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp)) ||
		typeof record.sessionId !== "string" || !record.sessionId ||
		typeof record.routeRunId !== "string" || !record.routeRunId ||
		!Number.isInteger(record.responseIndex) || (record.responseIndex ?? 0) < 1 ||
		typeof record.tier !== "string" || !record.tier ||
		typeof record.tierSourceSkill !== "string" || !record.tierSourceSkill ||
		!Array.isArray(record.routedSkills) || !record.routedSkills.every((skill) => typeof skill === "string" && Boolean(skill)) ||
		typeof record.provider !== "string" || !record.provider ||
		typeof record.model !== "string" || !record.model ||
		(record.responseModel !== null && typeof record.responseModel !== "string") ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.has(record.thinking as ThinkingLevel) ||
		typeof record.stopReason !== "string" || !STOP_REASONS.has(record.stopReason as AssistantMessage["stopReason"]) ||
		!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage) ||
		!Array.isArray(record.unknownUsageFields) ||
		record.providerReportedCost !== null
	) return false;
	const usageKeys = Object.keys(record.usage).sort();
	if (usageKeys.length !== USAGE_FIELDS.length || !USAGE_FIELDS.every((field) => usageKeys.includes(field))) return false;
	const unknownFields = new Set(record.unknownUsageFields);
	if (unknownFields.size !== record.unknownUsageFields.length || !record.unknownUsageFields.every((field) => USAGE_FIELDS.includes(field))) return false;
	return USAGE_FIELDS.every((field) => {
		const usageValue = (record.usage as ObservedUsage)[field];
		const validValue = usageValue === null || (typeof usageValue === "number" && Number.isFinite(usageValue) && usageValue >= 0);
		return validValue && unknownFields.has(field) === (usageValue === null);
	});
}

export function emptyUsageTotals(): UsageTotals {
	return {
		responses: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		output: 0,
		reasoning: 0,
		unknown: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
	};
}

export function addUsageRecord(totals: UsageTotals, record: UsageRecordV1): UsageTotals {
	totals.responses++;
	for (const field of Object.keys(record.usage) as UsageField[]) {
		const value = record.usage[field];
		if (value === null) totals.unknown[field]++;
	}
	totals.input += record.usage.input ?? 0;
	totals.cacheRead += record.usage.cacheRead ?? 0;
	totals.cacheWrite += record.usage.cacheWrite ?? 0;
	totals.cacheWrite1h += record.usage.cacheWrite1h ?? 0;
	totals.output += record.usage.output ?? 0;
	totals.reasoning += record.usage.reasoning ?? 0;
	return totals;
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0+$/, "")}K`;
	return String(value);
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
	return align === "left" ? value.padEnd(width) : value.padStart(width);
}

/** Formats the command's local, observed usage without implying billing precision. */
export function formatUsageSummary(rows: UsageSummaryRow[], health: UsageLedgerHealth, skipped: number): string {
	const lines = ["Pi-normalized observed responses — not subscription quota or provider billing."];
	if (rows.length === 0) {
		lines.push("No routed assistant responses recorded.");
	} else {
		const rendered = rows.map(({ route, totals }) => ({
			route,
			responses: String(totals.responses),
			input: formatTokenCount(totals.input),
			cacheRead: formatTokenCount(totals.cacheRead),
			cacheWrite: `${formatTokenCount(totals.cacheWrite)}/${formatTokenCount(totals.cacheWrite1h)}`,
			output: formatTokenCount(totals.output),
			reasoning: formatTokenCount(totals.reasoning),
		}));
		const widths = {
			route: Math.max("Route".length, ...rendered.map((row) => row.route.length)),
			responses: Math.max("Resp".length, ...rendered.map((row) => row.responses.length)),
			input: Math.max("Input".length, ...rendered.map((row) => row.input.length)),
			cacheRead: Math.max("Cache read".length, ...rendered.map((row) => row.cacheRead.length)),
			cacheWrite: Math.max("Cache write/1h".length, ...rendered.map((row) => row.cacheWrite.length)),
			output: Math.max("Output".length, ...rendered.map((row) => row.output.length)),
			reasoning: Math.max("Reasoning".length, ...rendered.map((row) => row.reasoning.length)),
		};
		const line = (row: typeof rendered[number] | { route: string; responses: string; input: string; cacheRead: string; cacheWrite: string; output: string; reasoning: string }) => [
			pad(row.route, widths.route),
			pad(row.responses, widths.responses, "right"),
			pad(row.input, widths.input, "right"),
			pad(row.cacheRead, widths.cacheRead, "right"),
			pad(row.cacheWrite, widths.cacheWrite, "right"),
			pad(row.output, widths.output, "right"),
			pad(row.reasoning, widths.reasoning, "right"),
		].join("  ");
		lines.push(line({ route: "Route", responses: "Resp", input: "Input", cacheRead: "Cache read", cacheWrite: "Cache write/1h", output: "Output", reasoning: "Reasoning" }));
		lines.push("-".repeat(line({ route: "", responses: "", input: "", cacheRead: "", cacheWrite: "", output: "", reasoning: "" }).length));
		lines.push(...rendered.map(line));

		const unknown = rows.flatMap(({ route, totals }) => {
			const fields = (Object.entries(totals.unknown) as [UsageField, number][])
				.filter(([, count]) => count > 0)
				.map(([field, count]) => `${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${count}`);
			return fields.length > 0 ? [`${route}: ${fields.join(", ")}`] : [];
		});
		if (unknown.length > 0) {
			lines.push("", "Unknown token fields (response count):", ...unknown);
		}
	}
	lines.push("Cost: unavailable; Pi exposes configured-price calculations only.");
	lines.push(`Ledger health: pending ${health.pending}; dropped ${health.dropped}; write errors ${health.writeErrors}; skipped records ${skipped}`);
	return lines.join("\n");
}
