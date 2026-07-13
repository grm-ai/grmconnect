/**
 * Thin API client that switches between real backend and mock data.
 * Set NEXT_PUBLIC_USE_MOCK=true to force mock mode (default when backend is unreachable).
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': KEY,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? json?.detail ?? `HTTP ${res.status}`)
  return json as T
}

/** Check if backend is reachable. Returns true if healthy. */
export async function checkBackend(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}
