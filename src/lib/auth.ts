/**
 * Domain-gate constants and helper. This is the SINGLE source of truth for
 * "who is allowed to use this dashboard" — no roles table, no custom claims.
 *
 * Enforcement lives in `authState.tsx`'s `onAuthStateChanged` listener (the
 * real backstop, provider-agnostic and unbypassable by any client-side UI
 * path). Anything else that references these constants (the Google `hd`
 * custom param, the signup form's client-side check in `AuthGate.tsx`) is
 * UX convenience only — never treat those as security.
 */
export const ALLOWED_EMAIL_DOMAIN = "tenetx.ai";
export const SUPER_ADMIN_EMAIL = "arif.dawood@tenetx.ai";

export function isAllowedEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith("@" + ALLOWED_EMAIL_DOMAIN);
}
