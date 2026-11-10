import { describe, expect, it } from "vitest";
import { checkDeps } from "./dep-graph.ts";

describe("checkDeps", () => {
  it("accepts the allowed graph", () => {
    expect(
      checkDeps([
        { name: "@quiz/engine", dependencies: { "@quiz/schema": "workspace:*", zod: "4" } },
        { name: "@quiz/server", dependencies: { "@quiz/engine": "workspace:*", "@quiz/protocol": "workspace:*" } },
      ]),
    ).toEqual([]);
  });

  it("rejects protocol depending on engine", () => {
    expect(checkDeps([{ name: "@quiz/protocol", dependencies: { "@quiz/engine": "workspace:*" } }])).toHaveLength(1);
  });

  it("rejects a front app depending on engine, even as devDependency", () => {
    expect(checkDeps([{ name: "@quiz/player", devDependencies: { "@quiz/engine": "workspace:*" } }])).toHaveLength(1);
  });

  it("allows studio to depend on engine", () => {
    expect(checkDeps([{ name: "@quiz/studio", dependencies: { "@quiz/engine": "workspace:*" } }])).toEqual([]);
  });

  it("rejects unknown packages", () => {
    expect(checkDeps([{ name: "@quiz/mystery" }])).toHaveLength(1);
  });
});
