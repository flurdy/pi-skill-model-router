import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isUsageRecordV1, type UsageRecordV1 } from "./usage.ts";

export interface UsageLedgerOptions {
	baseDir: string;
	retentionDays: number;
	maxBytes: number;
	maxQueue: number;
	maxBatchRecords: number;
	maxBatchBytes: number;
}

export interface UsageLedgerHealth {
	pending: number;
	dropped: number;
	writeErrors: number;
}

const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_MAX_BATCH_RECORDS = 64;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;
const CANONICAL_LEDGER_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayFor(timestamp: string): string {
	return timestamp.slice(0, 10);
}

function fileFor(baseDir: string, timestamp: string): string {
	return join(baseDir, `${dayFor(timestamp)}.jsonl`);
}

export class UsageLedger {
	private readonly options: UsageLedgerOptions;
	private readonly queue: UsageRecordV1[] = [];
	private draining = false;
	private drainPromise: Promise<void> | undefined;
	private scheduled = false;
	private initialized = false;
	private dropped = 0;
	private writeErrors = 0;

	constructor(options: UsageLedgerOptions) {
		this.options = options;
	}

	static defaults(baseDir: string, retentionDays: number, maxBytes: number): UsageLedgerOptions {
		return {
			baseDir,
			retentionDays,
			maxBytes,
			maxQueue: DEFAULT_MAX_QUEUE,
			maxBatchRecords: DEFAULT_MAX_BATCH_RECORDS,
			maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
		};
	}

	health(): UsageLedgerHealth {
		return { pending: this.queue.length, dropped: this.dropped, writeErrors: this.writeErrors };
	}

	enqueue(record: UsageRecordV1): void {
		if (this.queue.length >= this.options.maxQueue) {
			this.dropped++;
			return;
		}
		this.queue.push(record);
		this.scheduleDrain();
	}

	private scheduleDrain(): void {
		if (this.scheduled || this.draining) return;
		this.scheduled = true;
		const scheduled = setImmediate(() => {
			this.scheduled = false;
			void this.drain();
		});
		scheduled.unref();
	}

	start(): void {
		void this.initialize().catch(() => {
			this.writeErrors++;
		});
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		await mkdir(this.options.baseDir, { recursive: true, mode: 0o700 });
		await chmod(this.options.baseDir, 0o700);
		this.initialized = true;
		await this.prune();
	}

	private takeBatch(): UsageRecordV1[] {
		const batch: UsageRecordV1[] = [];
		let bytes = 0;
		while (this.queue.length > 0 && batch.length < this.options.maxBatchRecords) {
			const record = this.queue[0]!;
			const size = Buffer.byteLength(JSON.stringify(record)) + 1;
			if (batch.length > 0 && bytes + size > this.options.maxBatchBytes) break;
			this.queue.shift();
			batch.push(record);
			bytes += size;
		}
		return batch;
	}

	private async appendByDay(records: UsageRecordV1[]): Promise<void> {
		const byFile = new Map<string, string[]>();
		for (const record of records) {
			const file = fileFor(this.options.baseDir, record.timestamp);
			const lines = byFile.get(file) ?? [];
			lines.push(JSON.stringify(record));
			byFile.set(file, lines);
		}
		for (const [file, lines] of byFile) {
			await appendFile(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
			await chmod(file, 0o600);
		}
	}

	async drain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = this.performDrain();
		try {
			await this.drainPromise;
		} finally {
			this.drainPromise = undefined;
		}
	}

	private async performDrain(): Promise<void> {
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const batch = this.takeBatch();
				try {
					await this.initialize();
					await this.appendByDay(batch);
					await this.prune();
				} catch {
					this.writeErrors++;
					this.dropped += batch.length;
				}
			}
		} finally {
			this.draining = false;
			if (this.queue.length > 0) this.scheduleDrain();
		}
	}

	async drainWithin(timeoutMs: number): Promise<void> {
		await Promise.race([
			this.drain(),
			new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, timeoutMs);
				timeout.unref();
			}),
		]);
	}

	private async canonicalFileNames(): Promise<string[]> {
		try {
			return (await readdir(this.options.baseDir, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && CANONICAL_LEDGER_FILE.test(entry.name))
				.map((entry) => entry.name)
				.sort();
		} catch {
			return [];
		}
	}

	private async prune(): Promise<void> {
		const entries = await this.canonicalFileNames();
		const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000;
		const retained: Array<{ name: string; size: number }> = [];
		for (const name of entries) {
			const file = join(this.options.baseDir, name);
			await chmod(file, 0o600).catch(() => undefined);
			const modified = await stat(file).catch(() => undefined);
			if (!modified) continue;
			if (modified.mtimeMs < cutoff) {
				try {
					await rm(file, { force: true });
				} catch {
					this.writeErrors++;
				}
			} else {
				retained.push({ name, size: modified.size });
			}
		}
		let bytes = retained.reduce((total, entry) => total + entry.size, 0);
		for (const entry of retained) {
			if (bytes <= this.options.maxBytes) break;
			try {
				await rm(join(this.options.baseDir, entry.name), { force: true });
				bytes -= entry.size;
			} catch {
				this.writeErrors++;
			}
		}
	}

	async readRecords(): Promise<{ records: UsageRecordV1[]; skipped: number }> {
		await this.initialize().catch(() => undefined);
		await this.prune();
		const entries = await this.canonicalFileNames();
		const records: UsageRecordV1[] = [];
		let skipped = 0;
		for (const entry of entries) {
			const text = await readFile(join(this.options.baseDir, entry), "utf8").catch(() => "");
			for (const line of text.split("\n")) {
				if (!line) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					if (!isUsageRecordV1(parsed)) skipped++;
					else records.push(parsed);
				} catch {
					skipped++;
				}
			}
		}
		return { records, skipped };
	}
}
