// What this page is permitted to do, per server (GET /api/access, see AccessInfo). Read before connecting and on
// each reconnection (app.ts): HABBLAUD_REMOTE_ALLOW can change when server restarts while mobile page remains open.
// Without response (legacy server, network error), falls back to prior rule: only local machine page can act, and
// New Agent is never available (server opt-in). Expired login on remote port (401): returns to sign-in screen.
import type { AccessInfo } from '../../../shared/types';

let current: AccessInfo | null = null;
const listeners = new Set<() => void>();

/** Notifies when permissions change (UI re-renders buttons). Returns unsubscribe function. */
export function onAccessChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function sameAccess(a: AccessInfo | null, b: AccessInfo | null): boolean {
  return !!a && !!b && (Object.keys(a) as (keyof AccessInfo)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
}

/** Local machine hostname (localhost, *.localhost, 127.x, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

export function fallbackAccess(hostname: string): AccessInfo {
  const local = isLoopbackHostname(hostname);
  return { remote: false, local, permissions: local, messages: local, terminal: local, spawn: false };
}

/** Timeout for GET /api/access (page does not block connecting). */
export const ACCESS_TIMEOUT_MS = 5_000;

function isAccessInfo(v: unknown): v is AccessInfo {
  const a = v as Partial<AccessInfo> | null;
  return !!a && ['remote', 'local', 'permissions', 'messages', 'terminal'].every((k) => typeof a[k as keyof AccessInfo] === 'boolean');
}

/** Permissions of this page (from server, once loaded). */
export function access(): AccessInfo {
  return current ?? fallbackAccess(typeof location === 'undefined' ? '' : location.hostname);
}

export async function loadAccess(fetchImpl: typeof fetch = fetch, go: (url: string) => void = (u) => location.assign(u)): Promise<AccessInfo> {
  try {
    const res = await fetchImpl('/api/access', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS) });
    if (res.status === 401) {
      go('/login');
      return access();
    }
    if (res.ok) {
      const body: unknown = await res.json();
      if (isAccessInfo(body)) {
        const next = { ...body, spawn: (body as { spawn?: unknown }).spawn === true };
        const changed = !sameAccess(current, next);
        current = next;
        if (changed) listeners.forEach((cb) => cb());
      }
    }
  } catch {
    // uses legacy rule (fallbackAccess)
  }
  return access();
}

/** Logs out this device session (remote port) and returns to login. Returns false if server failed to respond. */
export async function remoteLogout(fetchImpl: typeof fetch = fetch, go: (url: string) => void = (u) => location.assign(u)): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/remote/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  go('/login');
  return true;
}

/** Test only. */
export function setAccess(a: AccessInfo | null): void {
  current = a;
}
