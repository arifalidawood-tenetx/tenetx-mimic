/**
 * Derives short avatar-chip initials from an email address.
 *
 * Rule (single, consistent, documented — see plan todo 2.2):
 * - Local part (the part before `@`) contains a `.` or `_` separator
 *   (e.g. `"jane.doe@tenetx.ai"`, `"jane_doe@tenetx.ai"`) → first letter of
 *   the local part + first letter immediately after the FIRST such
 *   separator, both uppercased. `"jane.doe@tenetx.ai"` → `"JD"`.
 * - No separator in the local part (e.g. `"jane@tenetx.ai"`) → just the
 *   first letter of the local part, uppercased. `"jane@tenetx.ai"` → `"J"`.
 *   (Chose a single letter over a two-letter prefix here so the
 *   "two-part name" visual meaning of a 2-char chip stays reserved for
 *   local parts that actually encode two name segments.)
 * - Empty string / `null` / `undefined` → `"?"` (no identity to derive
 *   initials from).
 * - Any other input (non-email garbage with no `@`) is treated as its own
 *   "local part" and resolves through the same two rules above — always
 *   returns a 1-2 char uppercase result, never throws.
 */
export function getInitials(email: string | null | undefined): string {
  if (!email) return "?";

  const trimmed = email.trim();
  if (!trimmed) return "?";

  const localPart = trimmed.split("@")[0] ?? "";
  if (!localPart) return "?";

  const separatorIndex = localPart.search(/[._]/);
  if (separatorIndex === -1) {
    return localPart.charAt(0).toUpperCase();
  }

  const first = localPart.charAt(0);
  const second = localPart.charAt(separatorIndex + 1);
  if (!second) {
    return first.toUpperCase();
  }

  return (first + second).toUpperCase();
}
