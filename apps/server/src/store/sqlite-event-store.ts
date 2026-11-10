import Database from "better-sqlite3";
import { Event, Session } from "@quiz/schema";
import type { EventStore, StoredSnapshot } from "./event-store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  idem_key TEXT,
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, idem_key)
);
CREATE TABLE IF NOT EXISTS snapshots (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revoked_tokens (jti TEXT PRIMARY KEY);
`;

type EventRow = { seq: number; at: number; actor: string; action: string; idem_key: string | null };

/**
 * SQLite journal (ADR-0003, ADR-0008): WAL + synchronous=FULL, so an append that returned survives a power loss.
 * Everything read back is validated with Zod (CONVENTIONS: every boundary); corruption throws loudly.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private readonly stmts;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.stmts = {
      insertSession: this.db.prepare("INSERT INTO sessions (id, doc, created_at) VALUES (?, ?, ?)"),
      getSession: this.db.prepare<[string], { doc: string }>("SELECT doc FROM sessions WHERE id = ?"),
      latestSession: this.db.prepare<[], { id: string }>("SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1"),
      lastSeq: this.db.prepare<[string], { seq: number | null }>("SELECT MAX(seq) AS seq FROM events WHERE session_id = ?"),
      insertEvent: this.db.prepare("INSERT INTO events (session_id, seq, at, actor, action, idem_key) VALUES (?, ?, ?, ?, ?, ?)"),
      events: this.db.prepare<[string], EventRow>("SELECT seq, at, actor, action, idem_key FROM events WHERE session_id = ? ORDER BY seq"),
      insertSnap: this.db.prepare("INSERT OR REPLACE INTO snapshots (session_id, seq, state) VALUES (?, ?, ?)"),
      latestSnap: this.db.prepare<[string], { seq: number; state: string }>("SELECT seq, state FROM snapshots WHERE session_id = ? ORDER BY seq DESC LIMIT 1"),
      getMeta: this.db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      deleteMeta: this.db.prepare("DELETE FROM meta WHERE key = ?"),
      revoke: this.db.prepare("INSERT OR IGNORE INTO revoked_tokens (jti) VALUES (?)"),
      isRevoked: this.db.prepare<[string], { jti: string }>("SELECT jti FROM revoked_tokens WHERE jti = ?"),
    };
  }

  /** Effective pragmas, for the pre-show checklist and tests. */
  pragmas(): { journalMode: unknown; synchronous: unknown } {
    return { journalMode: this.db.pragma("journal_mode", { simple: true }), synchronous: this.db.pragma("synchronous", { simple: true }) };
  }

  createSession(s: Session): void {
    this.stmts.insertSession.run(s.id, JSON.stringify(s), s.createdAt);
  }

  getSession(id: string): Session | null {
    const row = this.stmts.getSession.get(id);
    return row === undefined ? null : Session.parse(JSON.parse(row.doc));
  }

  latestSessionId(): string | null {
    return this.stmts.latestSession.get()?.id ?? null;
  }

  append(sessionId: string, e: Event): void {
    const last = this.stmts.lastSeq.get(sessionId)?.seq ?? 0;
    if (e.seq !== last + 1) throw new Error(`non-contiguous seq ${e.seq} after ${last}`);
    this.stmts.insertEvent.run(sessionId, e.seq, e.at, JSON.stringify(e.actor), JSON.stringify(e.action), e.idempotencyKey);
  }

  appendMany(sessionId: string, events: readonly Event[]): void {
    this.appendTx(sessionId, events);
  }

  private readonly appendTx = (sessionId: string, events: readonly Event[]): void => {
    this.db.transaction(() => {
      for (const e of events) this.append(sessionId, e);
    })();
  };

  events(sessionId: string): Event[] {
    return this.stmts.events.all(sessionId).map((r) =>
      Event.parse({ seq: r.seq, at: r.at, actor: JSON.parse(r.actor), action: JSON.parse(r.action), idempotencyKey: r.idem_key }),
    );
  }

  saveSnapshot(sessionId: string, seq: number, state: unknown): void {
    this.stmts.insertSnap.run(sessionId, seq, JSON.stringify(state));
  }

  /** Raw state: the caller validates it with the engine's GameState schema. */
  latestSnapshot(sessionId: string): StoredSnapshot | null {
    const r = this.stmts.latestSnap.get(sessionId);
    // `unknown` on purpose: GameState.safeParse validates it in the runtime.
    return r === undefined ? null : { seq: r.seq, state: JSON.parse(r.state) as unknown };
  }

  getMeta(key: string): string | null {
    return this.stmts.getMeta.get(key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  deleteMeta(key: string): void {
    this.stmts.deleteMeta.run(key);
  }

  revoke(jti: string): void {
    this.stmts.revoke.run(jti);
  }

  revokeAndBump(jti: string, genKey: string, nextGen: string): void {
    this.db.transaction(() => {
      this.stmts.revoke.run(jti);
      this.stmts.setMeta.run(genKey, nextGen);
    })();
  }

  isRevoked(jti: string): boolean {
    return this.stmts.isRevoked.get(jti) !== undefined;
  }

  close(): void {
    this.db.close();
  }
}
