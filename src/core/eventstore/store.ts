// ── Event store ─────────────────────────────────────────────────
// Ported from internal/core/eventstore/store.go

import { eq, and, gt, desc, max } from "drizzle-orm";
import type { DbType } from "../database/pool.js";
import { events } from "../database/schema.js";
import type { Event, EventType } from "../model/types.js";

type Watcher = (event: Event) => void;

export class EventStore {
	private db: DbType;
	private watchers: Map<string, Set<Watcher>> = new Map();

	constructor(db: DbType) {
		this.db = db;
	}

	/** Append an event with auto-incremented seq within session. */
	async append(
		sessionId: string,
		type: EventType | string,
		data: Record<string, unknown>,
	): Promise<Event> {
		// Get next seq in transaction
		const result = await this.db
			.select({ maxSeq: max(events.seq) })
			.from(events)
			.where(eq(events.sessionId, sessionId));

		const nextSeq = (result[0]?.maxSeq ?? 0) + 1;

		const inserted = await this.db
			.insert(events)
			.values({
				sessionId,
				seq: nextSeq,
				type,
				data,
			})
			.returning();

		const event = {
			...inserted[0],
			sessionId: inserted[0].sessionId,
			sourceId: "",
			createdAt: inserted[0].createdAt,
		} as Event;

		// Notify watchers
		this.notifyWatchers(sessionId, event);

		return event;
	}

	/** Get events after given seq number. */
	async getEvents(
		sessionId: string,
		afterSeq = 0,
		limit = 100,
	): Promise<Event[]> {
		const rows = await this.db
			.select()
			.from(events)
			.where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
			.orderBy(events.seq)
			.limit(limit);

		return rows as Event[];
	}

	/** Get the most recent event for a session. */
	async getLatest(sessionId: string): Promise<Event | null> {
		const rows = await this.db
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId))
			.orderBy(desc(events.seq))
			.limit(1);

		return rows.length > 0 ? (rows[0] as Event) : null;
	}

	/** Get events of specific type, newest first. */
	async getEventsByType(
		sessionId: string,
		type: string,
		limit = 50,
	): Promise<Event[]> {
		const rows = await this.db
			.select()
			.from(events)
			.where(and(eq(events.sessionId, sessionId), eq(events.type, type)))
			.orderBy(desc(events.seq))
			.limit(limit);

		return rows as Event[];
	}

	/** Stream events — yields existing then live via watcher. */
	async *streamEvents(sessionId: string, afterSeq = 0): AsyncGenerator<Event> {
		// Yield existing events first
		const existing = await this.getEvents(sessionId, afterSeq);
		for (const e of existing) {
			yield e;
		}

		// Set up live watcher
		const queue: Event[] = [];
		let resolve: ((value?: unknown) => void) | null = null;

		const watcher: Watcher = (event: Event) => {
			queue.push(event);
			if (resolve) {
				resolve();
				resolve = null;
			}
		};

		this.addWatcher(sessionId, watcher);

		try {
			while (true) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise((r) => {
						resolve = r;
					});
				}
			}
		} finally {
			this.removeWatcher(sessionId, watcher);
		}
	}

	private addWatcher(sessionId: string, watcher: Watcher): void {
		if (!this.watchers.has(sessionId)) {
			this.watchers.set(sessionId, new Set());
		}
		this.watchers.get(sessionId)!.add(watcher);
	}

	private removeWatcher(sessionId: string, watcher: Watcher): void {
		this.watchers.get(sessionId)?.delete(watcher);
		if (this.watchers.get(sessionId)?.size === 0) {
			this.watchers.delete(sessionId);
		}
	}

	private notifyWatchers(sessionId: string, event: Event): void {
		this.watchers.get(sessionId)?.forEach((w) => w(event));
	}
}
