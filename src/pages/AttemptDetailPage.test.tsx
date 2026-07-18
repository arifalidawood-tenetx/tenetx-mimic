import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AttemptDetailPage, TRY_IT_OUT_ROUTE } from "./AttemptDetailPage";

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

  it("wraps the nested SamlConfigPage in a max-w-3xl container and renders exactly one page-title <h1>", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [{ data: () => FIXTURE_DOC }],
    });

    renderAt("/mimic/TEN-135/saml-config/1");

    await waitFor(() =>
      expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
    );

    // F1 fix: the nested SamlConfigPage renders at the same 768px width as
    // TryItOutPage, not AttemptDetailPage's own 1152px PageContainer.
    const nestedWrapper = screen.getByText("Configure SSO").closest(".max-w-3xl");
    expect(nestedWrapper).not.toBeNull();
    expect(nestedWrapper).toHaveClass("mx-auto", "max-w-3xl");

    // F2 fix: "Configure SSO" is demoted to a SectionHeader (<h2>), so only
    // AttemptDetailPage's own title renders at page-title scale.
    const pageTitleHeadings = document.querySelectorAll(
      "h1.text-2xl.sm\\:text-3xl.font-bold"
    );
    expect(pageTitleHeadings).toHaveLength(1);
    expect(pageTitleHeadings[0]).toHaveTextContent("Generic SAML/OIDC Config Page");

    const configureSsoHeading = screen.getByText("Configure SSO").closest("h2");
    expect(configureSsoHeading).not.toBeNull();
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

  it("renders root cause, diff summary, and the full solution in a <pre> with a copy button when solutionMarkdown is present", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "saml-login-fix",
            rootCause: "Message-level signature required but Response was unsigned.",
            diffSummary: "Set saml.server.signature=true on the Keycloak SAML client.",
            solutionMarkdown: "## Fix\n\n```\nsaml.server.signature: true\n```",
          }),
        },
      ],
    });

    renderAt("/mimic/TEN-141/saml-login-fix/1");

    await waitFor(() => expect(screen.getByText("Root cause")).toBeInTheDocument());
    expect(
      screen.getByText("Message-level signature required but Response was unsigned.")
    ).toBeInTheDocument();
    expect(screen.getByText("Diff summary")).toBeInTheDocument();
    expect(
      screen.getByText("Set saml.server.signature=true on the Keycloak SAML client.")
    ).toBeInTheDocument();

    expect(screen.getByText("Full solution")).toBeInTheDocument();
    const pre = screen.getByText((_, node) => node?.tagName.toLowerCase() === "pre");
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain("saml.server.signature: true");

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("does not render the solution block (and does not crash) when solutionMarkdown is absent", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "saml-login-fix",
            rootCause: undefined,
            diffSummary: undefined,
            solutionMarkdown: undefined,
          }),
        },
      ],
    });

    renderAt("/mimic/TEN-141/saml-login-fix/1");

    await waitFor(() =>
      expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
    );
    expect(screen.queryByText("Root cause")).not.toBeInTheDocument();
    expect(screen.queryByText("Diff summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Full solution")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
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

  it("renders root cause, diff summary, and full solution when feature is saml-login-fix", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "saml-login-fix",
            rootCause: "Keycloak SAML assertion signature was not validated.",
            diffSummary: "Added signature verification before session creation.",
            solutionMarkdown: "--- a/auth.ts\n+++ b/auth.ts\n+verifySignature(assertion);",
          }),
        },
      ],
    });

    renderAt("/mimic/TEN-135/saml-login-fix/1");

    await waitFor(() => expect(screen.getByText("Root cause")).toBeInTheDocument());
    expect(
      screen.getByText("Keycloak SAML assertion signature was not validated.")
    ).toBeInTheDocument();
    expect(screen.getByText("Diff summary")).toBeInTheDocument();
    expect(
      screen.getByText("Added signature verification before session creation.")
    ).toBeInTheDocument();
    expect(screen.getByText("Full solution")).toBeInTheDocument();

    // solutionMarkdown is a raw unified diff, so it now routes through
    // DiffView (colored per-line divs) instead of the plain <pre> — no
    // <pre> should be present for this diff-shaped content.
    expect(
      screen.queryByText((_, node) => node?.tagName.toLowerCase() === "pre")
    ).not.toBeInTheDocument();
    const addedLine = screen.getByText("+verifySignature(assertion);");
    expect(addedLine).toHaveClass("bg-success-soft", "text-success");
    const headerLine = screen.getByText("--- a/auth.ts");
    expect(headerLine).not.toHaveClass("bg-success-soft");
    expect(headerLine).not.toHaveClass("bg-danger-soft");

    const copyButton = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(
      "--- a/auth.ts\n+++ b/auth.ts\n+verifySignature(assertion);"
    );
    await screen.findByRole("button", { name: "Copied!" });
  });

  it("renders root cause, diff summary, and the full solution when feature is windows-server-managed-hook-fix", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "windows-server-managed-hook-fix",
            rootCause:
              "server_hook_command builds a POSIX-only invocation with zero platform branching.",
            diffSummary:
              "Added server_hook_command_by_platform with a Windows-native PowerShell variant.",
            solutionMarkdown: "## Fix\n\n```\nserver_hook_command_by_platform[\"windows\"]\n```",
          }),
        },
      ],
    });

    renderAt("/mimic/TENQA-17/windows-server-managed-hook-fix/1");

    await waitFor(() => expect(screen.getByText("Root cause")).toBeInTheDocument());
    expect(
      screen.getByText(
        "server_hook_command builds a POSIX-only invocation with zero platform branching."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Diff summary")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Added server_hook_command_by_platform with a Windows-native PowerShell variant."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Full solution")).toBeInTheDocument();
    const pre = screen.getByText((_, node) => node?.tagName.toLowerCase() === "pre");
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain('server_hook_command_by_platform["windows"]');
  });

  it("renders root cause, diff summary, and the full solution when feature is windows-installer-idempotent-reinstall-fix", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "windows-installer-idempotent-reinstall-fix",
            rootCause:
              "Expand-Archive -Force deletes then re-extracts tenetx.exe, which fails Access Denied on an Administrators-owned file.",
            diffSummary:
              "Extract to a staging dir and Copy-Item each file in place instead of delete-then-extract.",
            solutionMarkdown: '## Fix\n\n```\nCopy-Item -Path $_.FullName -Destination $target -Force\n```',
          }),
        },
      ],
    });

    renderAt("/mimic/TENQA-29/windows-installer-idempotent-reinstall-fix/1");

    await waitFor(() => expect(screen.getByText("Root cause")).toBeInTheDocument());
    // "tenetx.exe" is highlighted as an inline code chip (see TechnicalCopy /
    // renderCodeRefs in AttemptDetailPage.tsx), splitting this sentence
    // across sibling text nodes — match on the paragraph's full textContent
    // instead of a single exact text node.
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName.toLowerCase() === "p" &&
          node.textContent ===
            "Expand-Archive -Force deletes then re-extracts tenetx.exe, which fails Access Denied on an Administrators-owned file."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("tenetx.exe")).toHaveClass("font-mono", "bg-card-3");
    expect(screen.getByText("Diff summary")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Extract to a staging dir and Copy-Item each file in place instead of delete-then-extract."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Full solution")).toBeInTheDocument();
    const pre = screen.getByText((_, node) => node?.tagName.toLowerCase() === "pre");
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain("Copy-Item -Path $_.FullName -Destination $target -Force");
  });

  it("shows a prominent 'Try it out' link pointing at the ticket-nested try-it-out route for saml-login-fix", async () => {
     mockGetDocs.mockResolvedValue({
       empty: false,
       docs: [{ data: () => ({ ...FIXTURE_DOC, featureSlug: "saml-login-fix" }) }],
     });
 
     renderAt("/mimic/TEN-141/saml-login-fix/1");
 
     await waitFor(() =>
       expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
     );
     const tryItOutLink = screen.getByRole("link", { name: /try it out/i });
     expect(tryItOutLink).toHaveAttribute("href", "/mimic/TEN-141/try-it-out");
     // TRY_IT_OUT_ROUTE is still exported as a general fallback constant, but not used by this CTA.
     expect(TRY_IT_OUT_ROUTE).toBe("/mimic/try-it-out");
   });

  it("does not show the 'Try it out' link for features other than saml-login-fix", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [{ data: () => FIXTURE_DOC }], // featureSlug: "saml-config"
    });

    renderAt("/mimic/TEN-135/saml-config/1");

    await waitFor(() =>
      expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
    );
    expect(screen.queryByRole("link", { name: /try it out/i })).not.toBeInTheDocument();
  });

  it("does not crash and renders no saml-login-fix fields when they are undefined", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            ...FIXTURE_DOC,
            featureSlug: "saml-login-fix",
            rootCause: undefined,
            diffSummary: undefined,
            solutionMarkdown: undefined,
          }),
        },
      ],
    });

    renderAt("/mimic/TEN-135/saml-login-fix/1");

    await waitFor(() =>
      expect(screen.getByText("Generic SAML/OIDC Config Page")).toBeInTheDocument()
    );
    expect(screen.queryByText("Root cause")).not.toBeInTheDocument();
    expect(screen.queryByText("Diff summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Full solution")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });
});
