/**
 * `@quiz/protocol/lite`: zod-free helpers for very constrained runtimes (k6 load VUs, where 500 copies of the
 * schemas would cost gigabytes). Apps, bots and the server use the full entry point, which validates views.
 */
export { applyPatch, diff } from "./patch.ts";
export { backoffDelay, checkViewSeq } from "./timing.ts";
export { PROTOCOL_VERSION } from "./version.ts";
