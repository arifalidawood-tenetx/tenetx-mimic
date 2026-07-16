import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/shell/Toast";
import { createToken, listTokens, revokeToken } from "@/lib/mcpTokens";
import { checkMcpHealth } from "@/lib/mcpHealth";
import type { McpToken } from "@/lib/types";
import { McpPage } from "./McpPage";

vi.mock("@/lib/mcpTokens", () => ({
  createToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/mcpHealth", () => ({
  checkMcpHealth: vi.fn(),
}));

function renderPage(initialEntry = "/mcp") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <McpPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function makeToken(overrides: Partial<McpToken> = {}): McpToken {
  return {
    id: "tok-1",
    name: "claude-desktop-01",
    tokenHash: "hash",
    tokenPrefix: "ttx_pat_abcd",
    scopes: ["simenv:read"],
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    lastUsedAt: null,
    revoked: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("McpPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: unreachable, matching an unconfigured VITE_SAML_PROXY_URL in tests.
    vi.mocked(checkMcpHealth).mockResolvedValue(false);
  });

  it('shows "Not yet deployed" in the health section with no fabricated uptime/latency numbers', async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("Not yet deployed")).toBeInTheDocument();
    // Honest copy may explain *why* uptime/latency aren't shown, but no
    // fabricated numeric values (percentages, millisecond figures) may appear.
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+\s?ms\b/)).not.toBeInTheDocument();
  });

  it('shows "Deployed" in the health section when checkMcpHealth resolves true', async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    vi.mocked(checkMcpHealth).mockResolvedValue(true);
    renderPage();

    expect(await screen.findByText("Deployed")).toBeInTheDocument();
  });

  it("shows the honest empty state for Recent Tool Calls (no fabricated history)", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("No tool calls recorded yet.")).toBeInTheDocument();
  });

  it("auto-focuses the generate-token name input when ?action=generate is present", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage("/mcp?action=generate");

    const nameInput = await screen.findByPlaceholderText("claude-desktop-01");
    await waitFor(() => expect(nameInput).toHaveFocus());
  });

  it("blocks submit client-side on an empty name with zero createToken calls", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Generate New Token" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate PAT" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required.");
    expect(createToken).not.toHaveBeenCalled();
  });

  it("generate flow: shows the plaintext token exactly once, then it's gone on next render/re-fetch", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    vi.mocked(createToken).mockResolvedValue({
      id: "tok-new",
      token: "ttx_pat_supersecretplaintext0000",
    });

    const { unmount } = renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Generate New Token" }));
    fireEvent.change(screen.getByPlaceholderText("claude-desktop-01"), {
      target: { value: "my-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate PAT" }));

    expect(await screen.findByText("ttx_pat_supersecretplaintext0000")).toBeInTheDocument();
    expect(createToken).toHaveBeenCalledWith({
      name: "my-agent",
      scopes: expect.any(Array),
      expiresInDays: 90,
    });

    // Simulate leaving and returning to the page (a fresh mount + re-fetch).
    // Firestore never stored the plaintext, so the next fetch can only ever
    // return the masked prefix.
    unmount();
    vi.mocked(listTokens).mockResolvedValue([
      makeToken({ id: "tok-new", name: "my-agent", tokenPrefix: "ttx_pat_supe" }),
    ]);
    renderPage();

    expect(await screen.findByText("ttx_pat_supe")).toBeInTheDocument();
    expect(screen.queryByText("ttx_pat_supersecretplaintext0000")).not.toBeInTheDocument();
  });

  it("revoke flow: updates the token list and fires a success toast", async () => {
    vi.mocked(listTokens).mockResolvedValue([makeToken({ id: "tok-1", revoked: false })]);
    vi.mocked(revokeToken).mockResolvedValue(undefined);

    renderPage();

    await screen.findByText("claude-desktop-01");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(revokeToken).toHaveBeenCalledWith("tok-1");
    expect(await screen.findByText("Token revoked.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("revoke flow: fires an error toast when revokeToken rejects", async () => {
    vi.mocked(listTokens).mockResolvedValue([makeToken({ id: "tok-1", revoked: false })]);
    vi.mocked(revokeToken).mockRejectedValue(new Error("permission-denied"));

    renderPage();

    await screen.findByText("claude-desktop-01");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("Failed to revoke token.")).toBeInTheDocument();
  });

  it("shows the v1 scopes-not-enforced note in the generate form", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Generate New Token" }));

    expect(
      await screen.findByText(
        "Scopes are recorded on the token for audit purposes but are not yet enforced by the MCP server (v1)."
      )
    ).toBeInTheDocument();
  });

  it("Install Commands tab renders the persistent config generator with the env-var placeholder (never a real token)", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Install Commands" }));

    // .env.local's VITE_SAML_PROXY_URL is configured for local dev, so the
    // generator renders real snippets — always with the env-var / placeholder
    // pattern, never a live secret.
    expect(await screen.findByText("Config file — .mcp.json")).toBeInTheDocument();
    expect(screen.getByText(/Set TENETX_MIMIC_MCP_TOKEN/)).toBeInTheDocument();
    expect(screen.getByText(/<your-token-here>/)).toBeInTheDocument();
  });

  it("one-time reveal modal shows the real token and never leaks it into the persistent config generator", async () => {
    vi.mocked(listTokens).mockResolvedValue([]);
    vi.mocked(createToken).mockResolvedValue({
      id: "tok-new",
      token: "ttx_pat_supersecretplaintext0000",
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Generate New Token" }));
    fireEvent.change(screen.getByPlaceholderText("claude-desktop-01"), {
      target: { value: "my-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate PAT" }));

    expect(await screen.findByRole("dialog", { name: "New MCP token" })).toBeInTheDocument();
    expect(screen.getByText("ttx_pat_supersecretplaintext0000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog", { name: "New MCP token" })).not.toBeInTheDocument();
    expect(screen.queryByText("ttx_pat_supersecretplaintext0000")).not.toBeInTheDocument();
  });
});
