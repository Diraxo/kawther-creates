/** Thrown by repositories so screens can react without knowing the backend. */
export class AuthError extends Error {
  /** @param {'EXISTS'|'INVALID_CREDENTIALS'|'WEAK_PASSWORD'|'SAME_PASSWORD'|'CONFIRM_EMAIL'|'SESSION_EXPIRED'|'NETWORK'|'FORBIDDEN'|'UNKNOWN'} code */
  constructor(code, message) {
    super(message || code);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Normalises anything supabase-js (or fetch) can throw/return into an AuthError with a stable code,
 * so the UI can tell "you're offline" from "you're logged out" from "the server said no".
 */
export function classifyError(err) {
  if (err instanceof AuthError) return err;
  const msg = String((err && err.message) || err || '');
  const status = err && (err.status ?? err.statusCode);
  const code = err && err.code;
  if (
    (err && err.name === 'AuthRetryableFetchError') ||
    (err && err.name === 'TypeError' && /fetch|network|load failed/i.test(msg)) ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|ERR_INTERNET|ECONNREFUSED|ENOTFOUND/i.test(msg) ||
    status === 0 || status === 502 || status === 503 || status === 504
  ) return new AuthError('NETWORK', msg);
  if (
    status === 401 || code === 'PGRST301' || code === 'PGRST303' || code === '28000' || code === 'bad_jwt' ||
    /jwt expired|invalid jwt|not authenticated|not signed in|refresh token|session.*(missing|expired)|auth session missing/i.test(msg)
  ) return new AuthError('SESSION_EXPIRED', msg);
  if (status === 403 || code === '42501' || /row-level security|permission denied/i.test(msg)) return new AuthError('FORBIDDEN', msg);
  return new AuthError('UNKNOWN', msg);
}
