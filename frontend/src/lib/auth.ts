// Simple client-side auth: store the JWT + user, and inject the token on every API request.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const TOKEN_KEY = 'leadpilot-token'
const USER_KEY = 'leadpilot-user'

export type AuthUser = { id: number; email: string; name?: string | null }

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

export function getUser(): AuthUser | null {
  if (typeof window === 'undefined') return null
  try { return JSON.parse(window.localStorage.getItem(USER_KEY) || 'null') } catch { return null }
}

export function setAuth(token: string, user: AuthUser) {
  window.localStorage.setItem(TOKEN_KEY, token)
  window.localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearAuth() {
  window.localStorage.removeItem(TOKEN_KEY)
  window.localStorage.removeItem(USER_KEY)
}

export function isAuthed(): boolean {
  return !!getToken()
}

// Patch window.fetch once so every request to our API carries the logged-in user's JWT.
// This avoids touching each of the ~10 data hooks individually.
let _patched = false
export function installFetchAuth() {
  if (_patched || typeof window === 'undefined') return
  _patched = true
  const orig = window.fetch.bind(window)
  window.fetch = async (input: any, init: any = {}) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (typeof url === 'string' && url.startsWith(API_BASE)) {
        const token = getToken()
        if (token) {
          const headers = new Headers((init && init.headers) || (input && input.headers) || {})
          headers.set('Authorization', `Bearer ${token}`)
          // Rely SOLELY on the logged-in user's token — drop the shared X-API-Key so requests
          // can never fall back to the owner account and leak another user's data.
          headers.delete('X-API-Key')
          init = { ...init, headers }
        }
      }
    } catch { /* fall through with original request */ }
    return orig(input, init)
  }
}

// Auth API calls
export async function apiSignup(email: string, password: string, name?: string) {
  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? 'Signup failed')
  return json.data as { token: string; user: AuthUser }
}

export async function apiLogin(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? 'Login failed')
  return json.data as { token: string; user: AuthUser }
}
