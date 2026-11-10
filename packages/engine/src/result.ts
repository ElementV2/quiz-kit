/** Business errors are values (CONVENTIONS): no exceptions for rejections. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type RejectionCode =
  | "forbidden"
  | "wrong-phase"
  | "not-found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "stale";

export type Rejection = { readonly code: RejectionCode; readonly message: string };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (code: RejectionCode, message: string): Result<never, Rejection> => ({ ok: false, error: { code, message } });

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
