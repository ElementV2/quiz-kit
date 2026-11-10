import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_GAME } from "@quiz/schema";
import { SqliteEventStore } from "./sqlite-event-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * chaos:kill-server at the storage level: a child appends events as fast as it can and prints the seq of
 * every append that RETURNED (= what the server would have acked). We kill -9 it mid-flight, then reopen:
 * the journal must be readable, contiguous, and contain every acknowledged seq.
 */
describe("journal survives a hard kill", () => {
  it("keeps every acknowledged event and stays contiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-crash-"));
    dirs.push(dir);
    const db = join(dir, "j.db");
    const script = join(dir, "writer.ts");
    const storeUrl = new URL("./sqlite-event-store.ts", import.meta.url).href;
    writeFileSync(
      script,
      `import { SqliteEventStore } from ${JSON.stringify(storeUrl)};
const s = new SqliteEventStore(${JSON.stringify(db)});
s.createSession({ schemaVersion: 1, id: "ses_crash", game: ${JSON.stringify(DEMO_GAME)}, seed: 1, createdAt: 1 });
for (let seq = 1; ; seq++) {
  s.append("ses_crash", { seq, at: seq, actor: { role: "control" }, action: { type: "score.adjust", target: { participantId: "p_1" }, delta: 1, reason: "manual" }, idempotencyKey: "k_" + String(seq).padStart(10, "0") });
  process.stdout.write(seq + "\\n");
}
`,
    );
    // Run from the server package so `@quiz/schema` resolves.
    const child = spawn(process.execPath, [script], { cwd: join(import.meta.dirname, "..", ".."), stdio: ["ignore", "pipe", "pipe"] });
    let acked = 0;
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) if (line.trim() !== "") acked = Math.max(acked, Number(line));
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((res, rej) => {
      const t = setInterval(() => {
        if (acked >= 200) {
          clearInterval(t);
          child.kill("SIGKILL");
          res();
        }
      }, 5);
      child.once("exit", (code) => {
        clearInterval(t);
        if (acked < 200) rej(new Error(`writer exited early (${code}): ${stderr}`));
      });
    });
    await new Promise((r) => child.once("exit", r));

    const s = new SqliteEventStore(db);
    const seqs = s.events("ses_crash").map((e) => e.seq);
    s.close();
    expect(seqs.length).toBeGreaterThanOrEqual(acked);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  }, 30_000);
});
