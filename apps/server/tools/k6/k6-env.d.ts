/**
 * Minimal ambient types for the k6 runtime (no official typings installed).
 * Only what tools/k6/load.k6.ts uses, checked against https://grafana.com/docs/k6/latest/javascript-api/
 * (k6/websockets WebSocket with addEventListener/send/close/readyState; k6/metrics Counter/Trend; init-context open()).
 */
declare module "k6/websockets" {
  export class WebSocket {
    constructor(url: string);
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  }
}

declare module "k6/metrics" {
  export class Counter {
    constructor(name: string);
    add(value: number): void;
  }
  export class Trend {
    constructor(name: string, isTime?: boolean);
    add(value: number): void;
  }
}

declare const __ENV: Record<string, string | undefined>;
declare const __VU: number;
declare function open(path: string): string;
