// HTTP helpers. The client is always served by the server (Vite proxies in dev). It never talks
// to the media server: posters and everything else come through this app.

import { bgUrl } from "@bargames/sdk/client";
import type { AdminState, Card, ItemDetail, Library, NowPlaying, Page, ServerStatus, StaffState, TestResult, TrackChoice } from "@movies/shared";

const TOKEN_KEY = "movies.adminToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: signed in until reload */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(bgUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    throw new ApiError("Can't reach the app. Check the connection and try again.", 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(json?.error ?? `The app answered ${res.status}.`, res.status);
  return json as T;
}

const v = <T>(p: Promise<{ value: T }>) => p.then((r) => r.value);

export interface AuthStatus {
  setupNeeded: boolean;
  configured: boolean;
  broken: boolean;
  authenticated: boolean;
  minPasswordLength: number;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

export type ItemWithFit = ItemDetail & { fit: Record<string, { direct: boolean; reasons: string[] }> };
export type ControlAction = "pause" | "resume" | "stop" | "forward" | "back";

export const api = {
  status: () => request<AuthStatus>("GET", "/api/admin/status"),
  setup: (password: string) => request<{ token: string }>("POST", "/api/admin/setup", { password }),
  login: (password: string) => request<{ token: string }>("POST", "/api/admin/login", { password }),
  logout: () => request("POST", "/api/admin/logout", {}),
  state: () => request<AdminState>("GET", "/api/admin/state"),
  staffState: () => request<StaffState>("GET", "/api/admin/state"),

  libraries: () => v(request<{ value: Library[] }>("GET", "/api/admin/libraries")),
  browse: (library: string, page: number) => v(request<{ value: Page<Card> }>("GET", `/api/admin/browse?library=${encodeURIComponent(library)}&page=${page}`)),
  search: (q: string) => v(request<{ value: Card[] }>("GET", `/api/admin/search?q=${encodeURIComponent(q)}`)),
  item: (id: string) => v(request<{ value: ItemWithFit }>("GET", `/api/admin/items/${encodeURIComponent(id)}`)),
  play: (displayId: string, itemId: string, resume: boolean, tracks: TrackChoice = {}) => v(request<{ value: { title: string; method: "direct" | "transcode"; reasons: string[] } }>("POST", "/api/admin/play", { displayId, itemId, resume, ...tracks })),
  tracks: (displayId: string, choice: TrackChoice) => request<{ value: NowPlaying | null; inPlace: boolean }>("POST", `/api/admin/tvs/${encodeURIComponent(displayId)}/tracks`, choice),
  control: (displayId: string, action: ControlAction) => request("POST", `/api/admin/tvs/${encodeURIComponent(displayId)}/control`, { action }),

  setServer: (url: string) => v(request<{ value: { notes: string[]; test: TestResult; server: ServerStatus } }>("PUT", "/api/admin/server", { url })),
  testServer: () => v(request<{ value: { test: TestResult; server: ServerStatus } }>("POST", "/api/admin/server/test", {})),
  trust: (fingerprint: string) => v(request<{ value: { test: TestResult; server: ServerStatus } }>("POST", "/api/admin/server/trust", { fingerprint })),
  untrust: () => request("DELETE", "/api/admin/server/trust"),
  signIn: (username: string, password: string) => v(request<{ value: { server: ServerStatus } }>("POST", "/api/admin/server/signin", { username, password })),
  signOut: () => request("POST", "/api/admin/server/signout", {}),
  saveTv: (id: string, patch: Record<string, unknown>) => request("PUT", `/api/admin/tvs/${encodeURIComponent(id)}`, patch),
  saveSettings: (patch: Record<string, unknown>) => request("PUT", "/api/admin/settings", patch),
};

/** A poster path from the server, with the app's path prefix. */
export const img = (p?: string) => (p ? bgUrl(p) : undefined);
