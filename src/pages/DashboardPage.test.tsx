import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getDocs } from "firebase/firestore";
import { DashboardPage } from "./DashboardPage";
import * as mcpTokens from "@/lib/mcpTokens";
import * as mcpHealth from "@/lib/mcpHealth";

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  getDocs: vi.fn(),
}));

vi.mock("@/lib/mcpTokens", () => ({
  getMcpCounts: vi.fn(),
}));

vi.mock("@/lib/mcpHealth", () => ({
  checkMcpHealth: vi.fn(),
}));

function mockDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(getDocs).mockReset();
  vi.mocked(mcpTokens.getMcpCounts).mockReset();
  vi.mocked(mcpHealth.checkMcpHealth).mockReset();
  // Default: return real counts for most tests
  vi.mocked(mcpTokens.getMcpCounts).mockResolvedValue({
    tokenCount: 5,
    toolCallCount: 12,
  });
  // Default: health probe reports unreachable (matches unconfigured VITE_SAML_PROXY_URL in tests)
  vi.mocked(mcpHealth.checkMcpHealth).mockResolvedValue(false);
});

describe("DashboardPage", () => {
  it("composes StatCard + McpStatusCard + FeatureRegistryList for a populated fixture", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [
        mockDoc("doc1", {
          ticketId: "TEN-135",
          featureSlug: "saml-config",
          attemptNumber: 1,
          title: "SAML SSO configuration",
          status: "done",
          routePath: "/mimic/TEN-135/saml-config/1",
        }),
        mockDoc("doc2", {
          ticketId: "TEN-140",
          featureSlug: "scim-sync",
          attemptNumber: 1,
          title: "SCIM group sync",
          status: "in-progress",
          routePath: "/mimic/TEN-140/scim-sync/1",
        }),
        mockDoc("doc3", {
          ticketId: "TEN-144",
          featureSlug: "audit-log",
          attemptNumber: 2,
          title: "Audit log export",
          status: "planned",
          routePath: "/mimic/TEN-144/audit-log/2",
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderDashboard();

    // StatCard: completion rate (1 of 3 done = 33.3%)
    expect(await screen.findByText("33.3%")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 features done")).toBeInTheDocument();

    // McpStatusCard: real counts from getMcpCounts (default: 5 tokens, 12 calls), not deployed
    expect(screen.getByText("Not yet deployed")).toBeInTheDocument();
    expect(screen.getByText("5 tokens issued")).toBeInTheDocument();
    expect(screen.getByText("12 calls logged")).toBeInTheDocument();

    // FeatureRegistryList: each doc's title/ticketId/status renders
    expect(screen.getByText("SAML SSO configuration")).toBeInTheDocument();
    expect(screen.getByText("TEN-135")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    expect(screen.getByText("SCIM group sync")).toBeInTheDocument();
    expect(screen.getByText("TEN-140")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();

    expect(screen.getByText("Audit log export")).toBeInTheDocument();
    expect(screen.getByText("TEN-144")).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();

    // ticketId links to Jira
    const jiraLink = screen.getByText("TEN-135").closest("a");
    expect(jiraLink).toHaveAttribute("href", "https://daxnai.atlassian.net/browse/TEN-135");

    // link to routePath
    const attemptLinks = screen.getAllByText("View attempt");
    expect(attemptLinks[0]).toHaveAttribute("href", "/mimic/TEN-135/saml-config/1");
  });

  it("shows a clear empty-state message (not an error, not a blank page) for zero docs", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderDashboard();

    await waitFor(() => expect(screen.getByText("No data yet")).toBeInTheDocument());
    expect(screen.getByText("0 of 0 features done")).toBeInTheDocument();
    expect(screen.getByText("No features tracked yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders McpStatusCard with real counts from getMcpCounts on success", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [
        mockDoc("doc1", {
          ticketId: "TEN-135",
          featureSlug: "saml-config",
          attemptNumber: 1,
          title: "SAML SSO configuration",
          status: "done",
          routePath: "/mimic/TEN-135/saml-config/1",
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(mcpTokens.getMcpCounts).mockResolvedValue({
      tokenCount: 7,
      toolCallCount: 23,
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("7 tokens issued")).toBeInTheDocument());
    expect(screen.getByText("23 calls logged")).toBeInTheDocument();
    expect(screen.getByText("Not yet deployed")).toBeInTheDocument();
  });

  it("renders McpStatusCard with fallback 0/0 if getMcpCounts rejects, without crashing the page", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [
        mockDoc("doc1", {
          ticketId: "TEN-135",
          featureSlug: "saml-config",
          attemptNumber: 1,
          title: "SAML SSO configuration",
          status: "done",
          routePath: "/mimic/TEN-135/saml-config/1",
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(mcpTokens.getMcpCounts).mockRejectedValue(
      new Error("Firestore error")
    );

    renderDashboard();

    // Features still load and render despite getMcpCounts rejection
    await waitFor(() =>
      expect(screen.getByText("SAML SSO configuration")).toBeInTheDocument()
    );

    // McpStatusCard falls back to 0/0 instead of crashing the page
    expect(screen.getByText("0 tokens issued")).toBeInTheDocument();
    expect(screen.getByText("0 calls logged")).toBeInTheDocument();
    expect(screen.getByText("Not yet deployed")).toBeInTheDocument();

    // No error alert for the MCP failure (it's silently handled)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders McpStatusCard as 'Deployed' when checkMcpHealth resolves true", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(mcpHealth.checkMcpHealth).mockResolvedValue(true);

    renderDashboard();

    expect(await screen.findByText("Deployed")).toBeInTheDocument();
    expect(screen.queryByText("Not yet deployed")).not.toBeInTheDocument();
  });

  it("renders McpStatusCard as 'Not yet deployed' when checkMcpHealth resolves false", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(mcpHealth.checkMcpHealth).mockResolvedValue(false);

    renderDashboard();

    expect(await screen.findByText("Not yet deployed")).toBeInTheDocument();
  });
});
