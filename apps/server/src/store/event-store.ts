import type { Event, Session } from "@quiz/schema";

export type StoredSnapshot = { readonly seq: number; readonly state: unknown };

/**
 * Persistence port (CONVENTIONS "D"). Implementations: SQLite (show) and memory (tests).
 * `append` is synchronous and durable when it returns (SQLite: WAL + synchronous=FULL, ADR-0008);
 * it throws on I/O failure — the caller then refuses the action instead of broadcasting it.
 */
export interface EventStore {
  createSession(session: Session): void;
  getSession(id: string): Session | null;
  latestSessionId(): string | null;
  append(sessionId: string, event: Event): void;
  events(sessionId: string): Event[];
  saveSnapshot(sessionId: string, seq: number, state: unknown): void;
  latestSnapshot(sessionId: string): StoredSnapshot | null;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  revoke(jti: string): void;
  isRevoked(jti: string): boolean;
  close(): void;
}

export class MemoryEventStore implements EventStore {
  private readonly sessions = new Map<string, Session>();
  private readonly log = new Map<string, Event[]>();
  private readonly snaps = new Map<string, StoredSnapshot>();
  private readonly meta = new Map<string, string>();
  private readonly revoked = new Set<string>();
  /** Test hook: make the next append fail like a full disk. */
  failNextAppend = false;

  createSession(s: Session): void {
    if (this.sessions.has(s.id)) throw new Error(`session exists: ${s.id}`);
    this.sessions.set(s.id, s);
    this.log.set(s.id, []);
  }
  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }
  latestSessionId(): string | null {
    return [...this.sessions.keys()].at(-1) ?? null;
  }
  append(sessionId: string, e: Event): void {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("disk full (simulated)");
    }
    const events = this.log.get(sessionId);
    if (events === undefined) throw new Error(`unknown session ${sessionId}`);
    const last = events.at(-1)?.seq ?? 0;
    if (e.seq !== last + 1) throw new Error(`non-contiguous seq ${e.seq} after ${last}`);
    if (e.idempotencyKey !== null && events.some((x) => x.idempotencyKey === e.idempotencyKey)) throw new Error("duplicate idempotency key");
    events.push(structuredClone(e));
  }
  events(sessionId: string): Event[] {
    return structuredClone(this.log.get(sessionId) ?? []);
  }
  saveSnapshot(sessionId: string, seq: number, state: unknown): void {
    this.snaps.set(sessionId, { seq, state: structuredClone(state) });
  }
  latestSnapshot(sessionId: string): StoredSnapshot | null {
    const s = this.snaps.get(sessionId);
    return s === undefined ? null : structuredClone(s);
  }
  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }
  revoke(jti: string): void {
    this.revoked.add(jti);
  }
  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }
  close(): void {}
}
