import type { PatchOp } from "./messages.ts";

/**
 * RFC 6902 subset (add / remove / replace) over JSON values, ADR-0009.
 * `diff` favours simplicity: objects are diffed by key, arrays element-wise when lengths match,
 * otherwise replaced whole. `apply` never mutates its input.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const escape = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (k: string): string => k.replaceAll("~1", "/").replaceAll("~0", "~");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

export function diff(before: unknown, after: unknown, path = ""): PatchOp[] {
  if (equal(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    const ops: PatchOp[] = [];
    for (const k of Object.keys(before)) {
      if (!Object.hasOwn(after, k)) ops.push({ op: "remove", path: `${path}/${escape(k)}` });
    }
    for (const k of Object.keys(after)) {
      const p = `${path}/${escape(k)}`;
      if (!Object.hasOwn(before, k)) ops.push({ op: "add", path: p, value: after[k] });
      else ops.push(...diff(before[k], after[k], p));
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((x, i) => diff(x, after[i], `${path}/${i}`));
  }
  return [{ op: "replace", path: path, value: after }];
}

export type ApplyError = { readonly path: string; readonly message: string };

/** Applies ops to a deep copy. Any invalid op fails the whole patch (client then resyncs). */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): { ok: true; value: T } | { ok: false; error: ApplyError } {
  let root: unknown = structuredCloneJson(doc);
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") return { ok: false, error: { path: "", message: "cannot remove root" } };
      root = structuredCloneJson(op.value);
      continue;
    }
    const parts = op.path.split("/").slice(1).map(unescape);
    const last = parts.pop();
    if (last === undefined || !op.path.startsWith("/")) return { ok: false, error: { path: op.path, message: "invalid pointer" } };
    let parent: unknown = root;
    for (const p of parts) {
      if (Array.isArray(parent)) parent = parent[Number(p)];
      else if (isObject(parent) && Object.hasOwn(parent, p)) parent = parent[p];
      else return { ok: false, error: { path: op.path, message: `missing ${p}` } };
    }
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > parent.length) return { ok: false, error: { path: op.path, message: "index out of range" } };
      if (op.op === "add") parent.splice(i, 0, structuredCloneJson(op.value));
      else if (i >= parent.length) return { ok: false, error: { path: op.path, message: "index out of range" } };
      else if (op.op === "replace") parent[i] = structuredCloneJson(op.value);
      else parent.splice(i, 1);
    } else if (isObject(parent)) {
      const exists = Object.hasOwn(parent, last);
      if (op.op === "add") parent[last] = structuredCloneJson(op.value);
      else if (!exists) return { ok: false, error: { path: op.path, message: `missing ${last}` } };
      else if (op.op === "replace") parent[last] = structuredCloneJson(op.value);
      else delete parent[last];
    } else {
      return { ok: false, error: { path: op.path, message: "parent is not a container" } };
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is re-validated by the client against the View schema after patching
  return { ok: true, value: root as T };
}

function structuredCloneJson(v: unknown): Json {
  // JSON round-trip: views are plain JSON (no Date / Map), and this runs in k6 where structuredClone may not exist.
  return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as Json); // oxlint-disable-line typescript/no-unsafe-type-assertion -- JSON.parse of JSON.stringify output is Json
}
