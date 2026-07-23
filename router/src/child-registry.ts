import * as fs from "node:fs";
import * as path from "node:path";
import { DECK_HOME } from "@deck/core";
import { z } from "zod";
import { isProcessGroupAlive, killProcessGroup } from "./process-group";

export const childRecordSchema = z.object({
	pid: z.number().int().positive(),
	pgid: z.number().int().positive(),
	kind: z.enum(["poll", "owner", "dispatch"]),
	effort_id: z.string().min(1).nullable(),
	dispatch_id: z.string().min(1).nullable(),
	session_id: z.string().min(1).nullable(),
	command: z.string().min(1),
	started_at: z.number().int().nonnegative(),
});
export type ChildRecord = z.infer<typeof childRecordSchema>;

const registrySchema = z.object({
	v: z.literal(1),
	children: z.array(childRecordSchema),
});

export class ChildRegistry {
	readonly directory: string;
	readonly file: string;
	private records: ChildRecord[];

	constructor() {
		this.directory = path.join(DECK_HOME, "router");
		this.file = path.join(this.directory, "children.json");
		fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.directory, 0o700);
		this.records = this.read();
	}

	list(): ChildRecord[] {
		return this.records.map((record) => ({ ...record }));
	}

	add(input: ChildRecord): void {
		const record = childRecordSchema.parse(input);
		this.records = [...this.records.filter((candidate) => candidate.pgid !== record.pgid), record];
		this.persist();
	}

	update(pgid: number, patch: Partial<Pick<ChildRecord, "session_id" | "dispatch_id" | "effort_id">>): void {
		this.records = this.records.map((record) => record.pgid === pgid
			? childRecordSchema.parse({ ...record, ...patch })
			: record);
		this.persist();
	}

	remove(pgid: number): void {
		const next = this.records.filter((record) => record.pgid !== pgid);
		if (next.length === this.records.length) {
			return;
		}
		this.records = next;
		this.persist();
	}

	/** Router cannot regain RPC stdin after a crash, so v1 reaps every stale group (D-C). */
	async reapStale(graceMs = 5_000): Promise<ChildRecord[]> {
		const reaped: ChildRecord[] = [];
		for (const record of this.records) {
			if (isProcessGroupAlive(record.pgid)) {
				await killProcessGroup(record.pgid, undefined, graceMs);
				reaped.push(record);
			}
		}
		this.records = [];
		this.persist();
		return reaped;
	}

	private read(): ChildRecord[] {
		if (!fs.existsSync(this.file)) {
			return [];
		}
		const raw = fs.readFileSync(this.file, "utf8");
		const decoded: unknown = JSON.parse(raw);
		return registrySchema.parse(decoded).children;
	}

	private persist(): void {
		const value = registrySchema.parse({ v: 1, children: this.records });
		const temporary = `${this.file}.tmp.${process.pid}`;
		fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, this.file);
		fs.chmodSync(this.file, 0o600);
	}
}
