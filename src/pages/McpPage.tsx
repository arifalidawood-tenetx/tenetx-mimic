import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { PageContainer } from "@/components/PageContainer";
import { Badge, Button, SectionHeader, Segmented } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/shell/Toast";
import { createToken, listTokens, revokeToken } from "@/lib/mcpTokens";
import { checkMcpHealth } from "@/lib/mcpHealth";
import { resolvePublicMcpUrl } from "@/lib/mcpConfigSnippets";
import { ConfigGeneratorSection } from "@/components/mcp/ConfigGeneratorSection";
import { NewTokenModal } from "@/components/mcp/NewTokenModal";
import type { McpToken } from "@/lib/types";

/**
 * Scopes selectable when generating a new MCP personal-access token. Ported
 * verbatim from grokv1's `src/lib/utils.ts` `MCP_SCOPES` (lines 123-129).
 *
 * v1 SCOPE NOTE: scopes are recorded on the issued token (`McpToken.scopes`)
 * for audit/documentation purposes only. The MCP server does not yet gate
 * any tool call on scope membership — see `NOT_ENFORCED_NOTE` below.
 */
const MCP_SCOPES = [
  "simenv:read",
  "simenv:write",
  "diffs:read",
  "guard:read",
  "jira:read",
] as const;

const NOT_ENFORCED_NOTE =
  "Scopes are recorded on the token for audit purposes but are not yet enforced by the MCP server (v1).";

const EXPIRY_OPTIONS = [30, 90, 180, 365] as const;

/**
 * Planned MCP tool surface — static reference cards only. The Streamable
 * HTTP transport itself is live (see health probe above), but the backend
 * (`tenetx-mimic-backend/app/mcp/server.py`) has not registered any
 * `@mcp.tool` handlers yet, so none of these tools can actually be invoked
 * today. Ported verbatim from grokv1's `src/lib/utils.ts` `MCP_TOOLS`
 * (lines 131-173) purely as forward-looking documentation.
 */
const MCP_TOOLS = [
  {
    name: "simenv/create",
    description: "Provision a test environment with specified OS, arch, proxy, TLS, EDR",
  },
  { name: "simenv/status", description: "Check status of a running simulation" },
  { name: "simenv/teardown", description: "Destroy a test environment" },
  { name: "simenv/list", description: "List all available environment templates" },
  { name: "diffs/get", description: "Retrieve code diff for a specific issue ID" },
  {
    name: "diffs/search",
    description: "Search diffs by keyword, file path, or error message",
  },
  { name: "guard/test", description: "Execute a guard hook test with given parameters" },
  { name: "guard/coverage", description: "Get current coverage report" },
  { name: "jira/link", description: "Link a JIRA issue to a simulation" },
  { name: "jira/status", description: "Get JIRA issue status" },
] as const;

type ViewTab = "overview" | "install";
type HealthState = "checking" | "healthy" | "unreachable";

const SAML_PROXY_URL = import.meta.env.VITE_SAML_PROXY_URL ?? "";

function statusLabelFor(token: McpToken): { label: string; tone: "success" | "warning" | "danger" } {
  if (token.revoked) return { label: "Revoked", tone: "danger" };
  const daysLeft = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) return { label: "Expired", tone: "danger" };
  if (daysLeft <= 14) return { label: "Expiring", tone: "warning" };
  return { label: "Active", tone: "success" };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function healthBadgeFor(health: HealthState): { label: string; tone: "success" | "neutral" } {
  if (health === "healthy") return { label: "Deployed", tone: "success" };
  if (health === "checking") return { label: "Checking…", tone: "neutral" };
  return { label: "Not yet deployed", tone: "neutral" };
}

export function McpPage() {
  const [searchParams] = useSearchParams();
  const { addToast } = useToast();
  const [view, setView] = useState<ViewTab>("overview");

  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);

  const [health, setHealth] = useState<HealthState>("checking");

  const wantsGenerate = searchParams.get("action") === "generate";
  const [showGenerate, setShowGenerate] = useState(wantsGenerate);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  const [scopes, setScopes] = useState<string[]>([...MCP_SCOPES]);
  const [generating, setGenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);

  const { url: mcpUrl, isSecure: mcpUrlIsSecure } = resolvePublicMcpUrl(SAML_PROXY_URL);
  const trimmedBase = SAML_PROXY_URL.replace(/\/+$/, "");
  const healthUrl = trimmedBase ? `${trimmedBase}/health` : "";

  useEffect(() => {
    let cancelled = false;
    listTokens()
      .then((fetched) => {
        if (!cancelled) setTokens(fetched);
      })
      .catch((err) => {
        console.error("listTokens failed:", err);
        if (!cancelled) addToast("Failed to load tokens.", "error");
      })
      .finally(() => {
        if (!cancelled) setLoadingTokens(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHealth("checking");
    checkMcpHealth(SAML_PROXY_URL).then((ok) => {
      if (!cancelled) setHealth(ok ? "healthy" : "unreachable");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (wantsGenerate) {
      nameInputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsGenerate]);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Name is required.");
      return;
    }
    setNameError(null);
    setGenerating(true);
    try {
      const result = await createToken({ name: trimmed, scopes, expiresInDays });
      setNewToken(result.token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
      setTokens((prev) => [
        {
          id: result.id,
          name: trimmed,
          tokenHash: "",
          tokenPrefix: result.token.slice(0, 12),
          scopes,
          expiresAt: expiresAt.toISOString(),
          lastUsedAt: null,
          revoked: false,
          createdAt: now.toISOString(),
        },
        ...prev,
      ]);
      setName("");
      addToast("Token generated.", "success");
    } catch (err) {
      console.error("createToken failed:", err);
      addToast("Failed to generate token.", "error");
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await revokeToken(id);
      setTokens((prev) => prev.map((t) => (t.id === id ? { ...t, revoked: true } : t)));
      addToast("Token revoked.", "success");
    } catch (err) {
      console.error("revokeToken failed:", err);
      addToast("Failed to revoke token.", "error");
    }
  }

  const healthBadge = healthBadgeFor(health);

  return (
    <PageContainer size="wide">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">MCP</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Model Context Protocol server access — token management and planned tool surface.
          </p>
        </div>
        <Segmented
          label="MCP view"
          value={view}
          onChange={setView}
          options={[
            { value: "overview", label: "Overview" },
            { value: "install", label: "Install Commands" },
          ]}
        />
      </div>

      {view === "overview" && (
        <div className="mt-6 space-y-6">
          {/* Health + Endpoint */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <Icon name="pulse" className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold text-ink">Health</h2>
                <Badge tone={healthBadge.tone}>{healthBadge.label}</Badge>
              </div>
              <p className="text-sm text-ink-muted">
                {!trimmedBase
                  ? "No MCP base URL is configured (VITE_SAML_PROXY_URL is unset), so there is no live endpoint to check."
                  : health === "healthy"
                    ? "The MCP process responded to a live health check just now."
                    : "The MCP process did not respond to a live health check."}
              </p>
            </div>

            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-ink">Endpoint</h2>
              <div className="space-y-1.5 font-mono text-xs text-ink-muted">
                <p>
                  <span>POST </span>
                  <span className="text-accent">{mcpUrl || "— not configured —"}</span>
                </p>
                <p>Transport: Streamable HTTP</p>
                {healthUrl && (
                  <p>
                    <span>GET </span>
                    <span className="text-ink-faint">{healthUrl}</span>
                    <span> (health check)</span>
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Tokens */}
          <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <SectionHeader icon="shield">Personal Access Tokens</SectionHeader>
              <Button
                variant="primary"
                size="sm"
                icon="check"
                onClick={() => {
                  setShowGenerate(true);
                  setNewToken(null);
                }}
              >
                Generate New Token
              </Button>
            </div>

            {showGenerate && (
              <form
                onSubmit={handleGenerate}
                className="mb-4 space-y-3 rounded-lg bg-card p-4 ring-1 ring-line"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs">
                    <span className="text-ink-muted">Name</span>
                    <input
                      ref={nameInputRef}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (nameError) setNameError(null);
                      }}
                      placeholder="claude-desktop-01"
                      className="focus-ring mt-1 h-10 w-full rounded-lg bg-card-2 px-3 text-sm text-ink ring-1 ring-line"
                    />
                    {nameError && (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        {nameError}
                      </p>
                    )}
                  </label>
                  <label className="block text-xs">
                    <span className="text-ink-muted">Expiry</span>
                    <select
                      value={expiresInDays}
                      onChange={(e) => setExpiresInDays(Number(e.target.value))}
                      className="focus-ring mt-1 h-10 w-full rounded-lg bg-card-2 px-3 text-sm text-ink ring-1 ring-line"
                    >
                      {EXPIRY_OPTIONS.map((days) => (
                        <option key={days} value={days}>
                          {days === 365 ? "1 year (max)" : days === 180 ? "6 months" : `${days} days`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div>
                  <p className="mb-1.5 text-xs text-ink-muted">Scopes</p>
                  <div className="flex flex-wrap gap-2">
                    {MCP_SCOPES.map((s) => (
                      <label
                        key={s}
                        className={
                          "cursor-pointer rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 transition " +
                          (scopes.includes(s)
                            ? "bg-accent-soft text-accent ring-accent/40"
                            : "text-ink-muted ring-line")
                        }
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={scopes.includes(s)}
                          onChange={() => toggleScope(s)}
                        />
                        {s}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-faint">{NOT_ENFORCED_NOTE}</p>
                </div>

                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={generating}>
                    {generating ? "Generating…" : "Generate PAT"}
                  </Button>
                  <Button
                    type="button"
                    variant="subtle"
                    onClick={() => {
                      setShowGenerate(false);
                      setNameError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {loadingTokens ? (
              <p className="text-sm text-ink-muted">Loading tokens…</p>
            ) : tokens.length === 0 ? (
              <div className="rounded-lg bg-card p-6 text-center ring-1 ring-line">
                <p className="text-sm text-ink-muted">No tokens yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-[11px] uppercase tracking-wider text-ink-faint">
                    <tr>
                      <th className="px-2 py-2 font-medium">Name</th>
                      <th className="px-2 py-2 font-medium">Prefix</th>
                      <th className="px-2 py-2 font-medium">Scopes</th>
                      <th className="px-2 py-2 font-medium">Created</th>
                      <th className="px-2 py-2 font-medium">Expires</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t) => {
                      const status = statusLabelFor(t);
                      return (
                        <tr key={t.id} className="border-b border-line/50 text-ink-muted">
                          <td className="px-2 py-2.5 text-ink">{t.name}</td>
                          <td className="px-2 py-2.5 font-mono text-xs">{t.tokenPrefix}</td>
                          <td className="px-2 py-2.5 font-mono text-[11px]">{t.scopes.join(", ")}</td>
                          <td className="px-2 py-2.5 text-xs">{formatDate(t.createdAt)}</td>
                          <td className="px-2 py-2.5 text-xs">{formatDate(t.expiresAt)}</td>
                          <td className="px-2 py-2.5">
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </td>
                          <td className="px-2 py-2.5">
                            {!t.revoked && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRevoke(t.id)}
                              >
                                Revoke
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent Tool Calls + Planned Tool Surface */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
              <SectionHeader icon="clock">Recent Tool Calls</SectionHeader>
              <div className="mt-3 rounded-lg bg-card p-6 text-center ring-1 ring-line">
                <p className="text-sm text-ink-muted">No tool calls recorded yet.</p>
              </div>
            </div>

            <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
              <SectionHeader icon="layers">Planned Tool Surface</SectionHeader>
              <ul className="mt-3 space-y-2">
                {MCP_TOOLS.map((t) => (
                  <li key={t.name} className="rounded-lg bg-card px-3 py-2 ring-1 ring-line">
                    <p className="font-mono text-xs text-accent">{t.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">{t.description}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-ink-faint">
                      Not yet registered on the MCP server
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {view === "install" && (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl bg-accent-soft p-4 ring-1 ring-accent/20">
            <div className="flex items-start gap-3">
              <Icon name="code" className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="text-sm font-semibold text-ink">Install tenetx-mimic MCP</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Config snippets use an environment-variable placeholder for the Bearer token —
                  generate a PAT above, export it as{" "}
                  <code className="rounded bg-card px-1">TENETX_MIMIC_MCP_TOKEN</code>, then paste
                  the snippet below into your agent config.
                </p>
              </div>
            </div>
          </div>

          <ConfigGeneratorSection mcpUrl={mcpUrl} isSecure={mcpUrlIsSecure} />
        </div>
      )}

      {newToken && <NewTokenModal token={newToken} mcpUrl={mcpUrl} onDone={() => setNewToken(null)} />}
    </PageContainer>
  );
}
