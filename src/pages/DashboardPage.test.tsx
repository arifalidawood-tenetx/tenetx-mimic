import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getDocs } from "firebase/firestore";
import { DashboardPage } from "./DashboardPage";

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  getDocs: vi.fn(),
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
});

describe("DashboardPage", () => {
  it("renders the total-count card and one card per doc for a populated fixture", async () => {
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

    // total-count card
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("features replicated")).toBeInTheDocument();

    // each doc's title/ticketId/status renders
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

    await waitFor(() => expect(screen.getByText("0")).toBeInTheDocument());
    expect(screen.getByText("No features tracked yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
