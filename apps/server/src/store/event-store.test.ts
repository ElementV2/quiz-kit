import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_GAME, type Event, type Session } from "@quiz/schema";
import { MemoryEventStore, type EventStore } from "./event-store.ts";
import { SqliteEventStore } from "./sqlite-event-store.ts";

const session: Session = { schemaVersion: 1, id: "ses_t", game: DEMO_GAME, seed: 1, createdAt: 1 };
const ev = (seq: number, key: string | null = null): Event => ({ seq, at: 1000 + seq, actor: { role: "control" }, action: { type: "game.start" }, idempotencyKey: key });

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "quiz-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const makers: [string, () => EventStore][] = [
  ["memory", () => new MemoryEventStore()],
  ["sqlite", () => new SqliteEventStore(join(tempDir(), "j.db"))],
];

describe.each(makers)("EventStore contract (%s)", (_name, make) => {
  it("appends and reads back events in order", () => {
    const s = make();
    s.createSession(session);
    s.append("ses_t", ev(1));
    s.append("ses_t", ev(2, "k_aaaaaaaa"));
    expect(s.events("ses_t")).toEqual([ev(1), ev(2, "k_aaaaaaaa")]);
    expect(s.getSession("ses_t")).toEqual(session);
    expect(s.latestSessionId()).toBe("ses_t");
    s.close();
  });

  it("refuses gaps and duplicate idempotency keys", () => {
    const s = make();
    s.createSession(session);
    s.append("ses_t", ev(1, "k_aaaaaaaa"));
    expect(() => s.append("ses_t", ev(3))).toThrow(/contiguous/);
    expect(() => s.append("ses_t", ev(2, "k_aaaaaaaa"))).toThrow(/duplicate|UNIQUE/i);
    expect(s.events("ses_t")).toHaveLength(1);
    s.close();
  });

  it("stores snapshots, meta and revocations", () => {
    const s = make();
    s.createSession(session);
    s.saveSnapshot("ses_t", 3, { a: 1 });
    s.saveSnapshot("ses_t", 7, { a: 2 });
    expect(s.latestSnapshot("ses_t")).toEqual({ seq: 7, state: { a: 2 } });
    s.setMeta("k", "v");
    s.setMeta("k", "w");
    expect(s.getMeta("k")).toBe("w");
    s.revoke("seat-1");
    expect([s.isRevoked("seat-1"), s.isRevoked("seat-2")]).toEqual([true, false]);
    s.close();
  });
});

describe("SqliteEventStore durability settings (ADR-0008)", () => {
  it("runs in WAL with synchronous=FULL", () => {
    const s = new SqliteEventStore(join(tempDir(), "j.db"));
    expect(s.pragmas()).toEqual({ journalMode: "wal", synchronous: 2 });
    s.close();
  });

  it("keeps everything across a reopen", () => {
    const file = join(tempDir(), "j.db");
    const a = new SqliteEventStore(file);
    a.createSession(session);
    for (let i = 1; i <= 50; i++) a.append("ses_t", ev(i, `k_${String(i).padStart(8, "0")}`));
    a.close();
    const b = new SqliteEventStore(file);
    expect(b.events("ses_t").map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    b.close();
  });
});
