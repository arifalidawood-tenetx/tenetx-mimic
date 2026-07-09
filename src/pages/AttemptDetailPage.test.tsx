import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AttemptDetailPage } from "./AttemptDetailPage";

const mockGetDocs = vi.fn();
const mockWhere = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }));
const mockQuery = vi.fn((...args: unknown[]) => ({ args }));
const mockCollection = vi.fn((_db: unknown, name: string) => ({ name }));

vi.mock("firebase/firestore", () => ({
  collection: (...args: [unknown, string]) => mockCollection(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  where: (...args: [string, string, unknown]) => mockWhere(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
}));

// Same pattern as SamlConfigPage.test.tsx — SamlConfigPage is mounted inside
// AttemptDetailPage for the saml-config feature, so it needs the same
// firebaseClient/authState mocks to render without hitting real Firebase.
vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({ status: "authorized", user: null, retry: () => {} }),
}));

const FIXTURE_DOC = {
  ticketId: "TEN-135",
  relatedTickets: ["TEN-121", "TEN-117", "TEN-136"],
  featureSlug: "saml-config",
  attemptNumber: 1,
  title: "Generic SAML/OIDC Config Page",
  description:
    "Reimplements the generic SAML setup flow with real Keycloak/Authentik metadata verification.",
  status: "done",
  routePath: "/mimic/TEN-135/saml-config/1",
  jiraUrl: "https://daxnai.atlassian.net/browse/TEN-135",
  sourceRefs: ["keycloak realm tenetx-mimic", "authentik provider pk 5"],
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/mimic/:ticket/:feature/:attempt" element={<AttemptDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AttemptDetailPage", () => {
  beforeEach(() => {
    mockGetDocs.mockReset();
    mockWhere.mockClear();
    mockQuery.mockClear();
    mockCollection.mockClear();
  });

  it("renders title, status, related tickets, and Jira link when the doc is found", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [{ data: () => FIXTURE_DOC }],
    });

    renderAt("/mimic/TEN-135/saml-config/1");

    await waitFor(() =>
      expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
    );
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("TEN-121")).toBeInTheDocument();
    expect(screen.getByText("View TEN-135 in Jira")).toBeInTheDocument();

    // feature === "saml-config" also mounts SamlConfigPage (todo 13, previously
    // unmounted) as part of this attempt's detail view.
    expect(screen.getByText("Configure SSO")).toBeInTheDocument();
  });

  it("shows a clear not-found state (not a crash) when the query returns zero docs", async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    renderAt("/mimic/TEN-999/does-not-exist/1");

    await waitFor(() => expect(screen.getByText("Attempt not found")).toBeInTheDocument());
    expect(
      screen.getByText((_, node) => node?.textContent === "No tracked attempt matches TEN-999/does-not-exist/1.")
    ).toBeInTheDocument();
  });

  it("shows a loading state while the query is in flight", () => {
    mockGetDocs.mockReturnValue(new Promise(() => {})); // never resolves within this test

    renderAt("/mimic/TEN-135/saml-config/1");

    expect(screen.getByText(/Loading attempt/i)).toBeInTheDocument();
  });

  it("builds the query with the exact three where() clauses matching the URL params", async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    renderAt("/mimic/TEN-135/saml-config/1");

    await waitFor(() => expect(mockGetDocs).toHaveBeenCalledTimes(1));

    expect(mockCollection).toHaveBeenCalledWith({}, "mimic_features");
    expect(mockWhere).toHaveBeenCalledTimes(3);
    expect(mockWhere).toHaveBeenNthCalledWith(1, "ticketId", "==", "TEN-135");
    expect(mockWhere).toHaveBeenNthCalledWith(2, "featureSlug", "==", "saml-config");
    expect(mockWhere).toHaveBeenNthCalledWith(3, "attemptNumber", "==", 1);
  });
});
