/**
 * MCP server health probe (Task 7, frontend McpPage live state).
 *
 * Hits `GET {base}/health` — the FastAPI backend's plain liveness endpoint
 * (`tenetx-mimic-backend/app/main.py:118`) — NEVER the MCP JSON-RPC endpoint
 * itself. The Streamable HTTP `/mcp` mount requires session initialization
 * plus a `text/event-stream` Accept header; issuing a JSON-RPC call just to
 * check liveness would be slow, stateful, and wrong. `/health` is a plain
 * unauthenticated `GET` returning 200 `{"status": "ok"}`, mounted on the
 * same FastAPI app that owns `/mcp` (`main.py:65` mounts `/mcp` on the same
 * `app` that registers `/health` at `main.py:118`), so a healthy `/health`
 * response is a reliable proxy for "the process serving /mcp is up".
 */

/**
 * Probes `{baseUrl}/health`. Returns `true` only on an HTTP 2xx response;
 * `false` for a missing/empty `baseUrl`, a network failure, or any non-2xx
 * status. Never throws — callers can await this directly without a
 * try/catch, matching the "honest empty state, never crash the page"
 * convention already used by `getMcpCounts` in `mcpTokens.ts`.
 */
export async function checkMcpHealth(baseUrl: string): Promise<boolean> {
  if (!baseUrl) return false;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${trimmedBase}/health`, { method: "GET" });
    return response.ok;
  } catch (err) {
    console.error("checkMcpHealth failed:", err);
    return false;
  }
}
