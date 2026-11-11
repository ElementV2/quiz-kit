import { tokenFromUrl } from "@quiz/ui";

/** Control token of this page and the server API helpers (own endpoints, control token in `?t=`). */
export const token = tokenFromUrl();
export const withToken = (path: string): string => `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
export const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(withToken(path), init);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoints
};

export const hex = (n: number): string => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b); // works over plain HTTP (ADR-0012)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

/** `/api/links` (+ `title` once the server sends it). */
export type LinksResponse = { origins: string[]; entries: { label: string; id: string; path: string }[]; joinCode: string; title?: string };
export type StatusResponse = { journal?: { ok?: boolean; journalMode?: unknown; synchronous?: unknown; lastError?: string | null }; presence?: { total: number; byRole: Record<string, number>; seats: number[]; players: string[] } };

/** The address other machines use (never localhost when a LAN address exists). */
export const lanOrigin = (l: LinksResponse | null | undefined): string => l?.origins.find((o) => !o.includes("localhost")) ?? l?.origins[0] ?? location.origin;
