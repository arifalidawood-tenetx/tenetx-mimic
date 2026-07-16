import { addDoc, collection, doc, getDocs, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import type { McpToken } from "@/lib/types";

/**
 * Client-side Firestore helpers for the MCP tab's personal-access tokens
 * (`mcp_tokens`) and tool-call audit log (`mcp_tool_calls`).
 *
 * This module writes DIRECTLY to Firestore from the browser — no backend route
 * — mirroring the exact pattern `src/pages/SamlConfigPage.tsx` uses for the
 * `mimic_idp_connections` collection (`addDoc(collection(db, ...), payload)`).
 * Access is gated by the `firestore.rules` authored in todo 4.0 (verified
 * `@tenetx.ai` Firebase user), which must be deployed for production writes to
 * succeed; unit tests mock the Firestore SDK and do not depend on that deploy.
 *
 * SECURITY INVARIANT: the plaintext token is NEVER persisted. Only its SHA-256
 * hash (`tokenHash`) and a short display prefix (`tokenPrefix`) are stored. The
 * plaintext is returned exactly once from `createToken()` for the caller to
 * show the user, after which it is unrecoverable.
 */

const MCP_TOKENS_COLLECTION = "mcp_tokens";
const MCP_TOOL_CALLS_COLLECTION = "mcp_tool_calls";

/**
 * Generates a personal-access token: the `ttx_pat_` prefix followed by 20
 * cryptographically-random bytes rendered as lowercase hex (40 hex chars, so
 * the full token is 48 chars). Ported verbatim from grokv1's
 * `src/lib/utils.ts` (lines 41-48) — Web Crypto `getRandomValues`, directly
 * portable to a browser client.
 */
export function generatePatToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ttx_pat_${hex}`;
}

/**
 * SHA-256 hashes a string, returning lowercase hex (64 chars). Ported verbatim
 * from grokv1's `src/lib/utils.ts` (lines 32-39) — Web Crypto
 * `crypto.subtle.digest`, directly portable to a browser client.
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mints a new MCP token: generates the plaintext, hashes it, and writes the
 * hash + metadata to `mcp_tokens` (never the plaintext). Returns the new doc id
 * and the PLAINTEXT token — the only time the plaintext is ever exposed.
 */
export async function createToken({
  name,
  scopes,
  expiresInDays,
}: {
  name: string;
  scopes: string[];
  expiresInDays: number;
}): Promise<{ id: string; token: string }> {
  const token = generatePatToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

  const docRef = await addDoc(collection(db, MCP_TOKENS_COLLECTION), {
    name,
    tokenHash,
    tokenPrefix: token.slice(0, 12),
    scopes,
    expiresAt: expiresAt.toISOString(),
    lastUsedAt: null,
    revoked: false,
    createdAt: now.toISOString(),
  });

  return { id: docRef.id, token };
}

/**
 * Fetches every `mcp_tokens` doc and maps each to `McpToken`, threading the
 * Firestore document id in as `id`.
 */
export async function listTokens(): Promise<McpToken[]> {
  const snapshot = await getDocs(collection(db, MCP_TOKENS_COLLECTION));
  return snapshot.docs.map((snap) => {
    const data = snap.data();
    return {
      id: snap.id,
      name: data.name,
      tokenHash: data.tokenHash,
      tokenPrefix: data.tokenPrefix,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
      lastUsedAt: data.lastUsedAt,
      revoked: data.revoked,
      createdAt: data.createdAt,
    };
  });
}

/**
 * Revokes a token by setting `revoked: true` on `mcp_tokens/{id}`. The doc is
 * NOT deleted — the audit trail is preserved. Firestore's `updateDoc` rejects
 * with "No document to update" if the id does not exist, so a bad id surfaces
 * as a rejection here rather than silently no-opping (that rejection is
 * intentionally propagated, not swallowed).
 */
export async function revokeToken(id: string): Promise<void> {
  await updateDoc(doc(db, MCP_TOKENS_COLLECTION, id), { revoked: true });
}

/**
 * Returns the number of docs in `mcp_tokens` and `mcp_tool_calls`. Uses
 * `getDocs(...).size` (rather than `getCountFromServer`) for consistency with
 * `listTokens` and simpler test mocking; these collections are small in this
 * dashboard so downloading the snapshots to count is acceptable.
 */
export async function getMcpCounts(): Promise<{
  tokenCount: number;
  toolCallCount: number;
}> {
  const [tokensSnap, toolCallsSnap] = await Promise.all([
    getDocs(collection(db, MCP_TOKENS_COLLECTION)),
    getDocs(collection(db, MCP_TOOL_CALLS_COLLECTION)),
  ]);
  return { tokenCount: tokensSnap.size, toolCallCount: toolCallsSnap.size };
}
