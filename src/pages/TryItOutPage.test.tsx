import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TryItOutPage } from "./TryItOutPage";
import { IDP_GUIDANCE, MIMIC_ACS_URL, MIMIC_SP_ENTITY_ID, DEFAULT_REALM } from "@/lib/idpSetupGuidance";

const mockGetDocs = vi.fn();
const mockWhere = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }));
const mockQuery = vi.fn((...args: unknown[]) => ({ args }));
const mockCollection = vi.fn((_db: unknown, name: string) => ({ name }));
const mockSetDoc = vi.fn();
const mockDoc = vi.fn((_db: unknown, collectionName: string, id: string) => ({
  collectionName,
  id,
}));

vi.mock("firebase/firestore", () => ({
  collection: (...args: [unknown, string]) => mockCollection(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  where: (...args: [string, string, unknown]) => mockWhere(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  doc: (...args: [unknown, string, string]) => mockDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP_SENTINEL"),
}));

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({ status: "authorized", user: null, retry: () => {} }),
}));

function renderPage(path = "/mimic/try-it-out") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/mimic/try-it-out" element={<TryItOutPage />} />
        <Route path="/mimic/:ticket/try-it-out" element={<TryItOutPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function mockSuccessfulVerify() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entity_id: "https://keycloak.arifalidawood.com/realms/custom-realm",
        sso_url: "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml",
        slo_url: "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml/slo",
        certificate: "FAKE_CERT_BASE64",
      }),
    })
  );
}

// Builds a `samlStatus`-shaped token (`base64url(JSON).signature`) the same
// way todo 7's backend `signStatus` does, so tests can drive the frontend's
// decode-only read path without needing the real HMAC secret.
function encodeStatusToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const base64url = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url}.FAKE_SIGNATURE`;
}

describe("TryItOutPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });
    mockSetDoc.mockResolvedValue(undefined);
    window.history.pushState({}, "", "/mimic/try-it-out");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Keycloak/Authentik IdP selector", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Keycloak" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Authentik" })).toBeInTheDocument();
  });

  it("defaults to Keycloak: shows its gotcha and exact field values, hides Authentik's", () => {
    renderPage();

    expect(screen.getByText(IDP_GUIDANCE.keycloak.gotcha.title)).toBeInTheDocument();
    expect(screen.queryByText(IDP_GUIDANCE.authentik.gotcha.title)).not.toBeInTheDocument();

    // Keycloak's exact field values from the constants source of truth.
    expect(screen.getAllByText(MIMIC_SP_ENTITY_ID).length).toBeGreaterThan(0);
    expect(screen.getAllByText(MIMIC_ACS_URL).length).toBeGreaterThan(0);
    expect(screen.getByText("email")).toBeInTheDocument();

    // Authentik-only field shouldn't be visible while Keycloak is selected.
    expect(screen.queryByText("authentik Self-signed Certificate")).not.toBeInTheDocument();
  });

  it("switching to Authentik shows its gotcha + field values, hides Keycloak's", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Authentik" }));

    expect(screen.getByText(IDP_GUIDANCE.authentik.gotcha.title)).toBeInTheDocument();
    expect(screen.queryByText(IDP_GUIDANCE.keycloak.gotcha.title)).not.toBeInTheDocument();

    expect(screen.getByText("authentik Self-signed Certificate")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    // Keycloak-only field shouldn't be visible while Authentik is selected.
    expect(screen.queryByText("Client signature required must be Off")).not.toBeInTheDocument();
  });

  it("changes the Launch login target when the IdP selection changes", () => {
    renderPage();

    expect(screen.getByText(IDP_GUIDANCE.keycloak.launchLoginUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Authentik" }));

    expect(screen.getByText(IDP_GUIDANCE.authentik.launchLoginUrl)).toBeInTheDocument();
    expect(screen.queryByText(IDP_GUIDANCE.keycloak.launchLoginUrl)).not.toBeInTheDocument();
  });

  // --- Realm input: rendering, label switching, sanitization ---

  it("renders a realm input defaulting to DEFAULT_REALM, labeled 'Realm name' for Keycloak", () => {
    renderPage();
    const input = screen.getByLabelText("Realm name") as HTMLInputElement;
    expect(input.value).toBe(DEFAULT_REALM);
  });

  it("switches the realm input label to 'Application name' for Authentik", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Authentik" }));
    expect(screen.getByLabelText("Application name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Realm name")).not.toBeInTheDocument();
  });

  it("sanitizes the realm input to lowercase-alphanumeric-plus-hyphens as the user types", () => {
    renderPage();
    const input = screen.getByLabelText("Realm name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Realm/Test?123" } });
    expect(input.value).toBe("myrealmtest123");
  });

  it("updates the Keycloak descriptor URL and launch-login target when the realm changes", () => {
    renderPage();
    const input = screen.getByLabelText("Realm name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "custom-realm" } });

    const expectedDescriptor =
      "Descriptor URL: https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml/descriptor";
    expect(
      screen.getByText((_, node) => node?.textContent === expectedDescriptor)
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://keycloak.arifalidawood.com/realms/custom-realm/account/")
    ).toBeInTheDocument();
  });

  it("surfaces a Metadata URL input for Authentik instead of an auto-derived descriptor URL", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Authentik" }));
    expect(screen.getByLabelText("Metadata URL")).toBeInTheDocument();
    expect(screen.queryByText(/Descriptor URL:/)).not.toBeInTheDocument();
  });

  it("rejects verifying Authentik without a metadata URL", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Authentik" }));
    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));
    expect(screen.getByText("Enter a metadata URL first.")).toBeInTheDocument();
  });

  // --- Verify + save (mocked Firestore) ---

  it("verifies the realm and writes a mimic_idp_connections doc on success (general route, no ticket)", async () => {
    mockSuccessfulVerify();

    renderPage();
    const input = screen.getByLabelText("Realm name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "custom-realm" } });

    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));

    await screen.findByText("Verified");

    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [docRef, payload, options] = mockSetDoc.mock.calls[0];
    expect(docRef).toEqual({ collectionName: "mimic_idp_connections", id: "general_keycloak" });
    expect(payload).toMatchObject({
      provider: "saml",
      realm: "custom-realm",
      idpType: "keycloak",
      ticketId: null,
      entity_id: "https://keycloak.arifalidawood.com/realms/custom-realm",
      sso_url: "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml",
      slo_url: "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml/slo",
      certificate: "FAKE_CERT_BASE64",
      verifiedAt: "SERVER_TIMESTAMP_SENTINEL",
      createdAt: "SERVER_TIMESTAMP_SENTINEL",
    });
    expect(options).toEqual({ merge: true });
  });

  it("uses the ticket-scoped doc ID and ticketId when a ticket param is present", async () => {
    mockSuccessfulVerify();

    renderPage("/mimic/TEN-1/try-it-out");
    await waitFor(() => expect(mockGetDocs).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));
    await screen.findByText("Verified");

    const [docRef, payload] = mockSetDoc.mock.calls[0];
    expect(docRef).toEqual({ collectionName: "mimic_idp_connections", id: "TEN-1_keycloak" });
    expect(payload).toMatchObject({ ticketId: "TEN-1" });
  });

  it("shows a clear error (not a crash) when the verify-metadata request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "Could not fetch metadata." }),
      })
    );

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));

    expect(await screen.findByText("Could not fetch metadata.")).toBeInTheDocument();
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  // --- Hydrate from an existing doc (mocked Firestore) ---

  it("hydrates the realm input and verified metadata from an existing mimic_idp_connections doc on mount (ticket route)", async () => {
    mockGetDocs.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            provider: "saml",
            realm: "hydrated-realm",
            idpType: "keycloak",
            ticketId: "TEN-1",
            entity_id: "https://keycloak.arifalidawood.com/realms/hydrated-realm",
            sso_url: "https://keycloak.arifalidawood.com/realms/hydrated-realm/protocol/saml",
            slo_url: "https://keycloak.arifalidawood.com/realms/hydrated-realm/protocol/saml/slo",
            certificate: "HYDRATED_CERT",
          }),
        },
      ],
    });

    renderPage("/mimic/TEN-1/try-it-out");

    await screen.findByText("Verified");
    const input = screen.getByLabelText("Realm name") as HTMLInputElement;
    expect(input.value).toBe("hydrated-realm");
    expect(screen.getByText("HYDRATED_CERT…")).toBeInTheDocument();

    expect(mockCollection).toHaveBeenCalledWith({}, "mimic_idp_connections");
    expect(mockWhere).toHaveBeenNthCalledWith(1, "ticketId", "==", "TEN-1");
    expect(mockWhere).toHaveBeenNthCalledWith(2, "idpType", "==", "keycloak");
  });

  it("does not query Firestore on the general route (no ticket)", () => {
    renderPage("/mimic/try-it-out");
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  // --- Launch login: disabled-until-verified + same-tab navigation ---

  it("disables Launch login until the realm is verified, then same-tab-navigates to /saml/login with the verified metadata", async () => {
    mockSuccessfulVerify();
    renderPage();

    const launchButton = screen.getByRole("button", { name: "Launch Keycloak login" });
    expect(launchButton).toBeDisabled();
    // Logout (todo 14) shares this exact hint text for its own disabled
    // state, so both Launch's and Logout's copies are present pre-verify.
    expect(
      screen.getAllByText("Verify your realm first to enable this button.").length
    ).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));
    await screen.findByText("Verified");

    expect(launchButton).not.toBeDisabled();
    expect(
      screen.queryByText("Verify your realm first to enable this button.")
    ).not.toBeInTheDocument();

    // jsdom's `Location.prototype.assign` is non-configurable, so `vi.spyOn`
    // can't shadow it directly — swap the whole `window.location` object for
    // a plain-object stand-in (same current values, `assign` replaced) and
    // restore the original afterward.
    const originalLocation = window.location;
    const currentHref = originalLocation.href;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      fireEvent.click(launchButton);

      expect(assignSpy).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(assignSpy.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe("/saml/login");
      expect(calledUrl.searchParams.get("idpEntityId")).toBe(
        "https://keycloak.arifalidawood.com/realms/custom-realm"
      );
      expect(calledUrl.searchParams.get("idpSsoUrl")).toBe(
        "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml"
      );
      expect(calledUrl.searchParams.get("idpCert")).toBe("FAKE_CERT_BASE64");
      expect(calledUrl.searchParams.get("returnUrl")).toBe(currentHref);
      // Todo 6: the same deterministic doc ID `handleVerifyRealm`'s `setDoc`
      // used — general route (no ticket) + Keycloak default → "general_keycloak"
      // — so the ACS callback can resolve this tester's own IdP identity.
      expect(calledUrl.searchParams.get("connectionDocId")).toBe("general_keycloak");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  // --- samlStatus banner (mount-time decode, no re-verification) ---

  it("renders a confirmation banner for a validated samlStatus token and strips it from the URL", async () => {
    const token = encodeStatusToken({
      status: "validated",
      email: "tester@example.com",
      reason: null,
      iat: Date.now(),
    });
    window.history.pushState({}, "", `/mimic/try-it-out?samlStatus=${token}&kept=1`);

    renderPage();

    expect(
      await screen.findByText(
        (_, node) => node?.textContent === "✅ Confirmed — signed in as tester@example.com"
      )
    ).toBeInTheDocument();

    // samlStatus stripped, sibling params preserved.
    expect(window.location.search).toBe("?kept=1");
  });

  it("renders a rejection banner with the payload's reason for a rejected samlStatus token", async () => {
    const token = encodeStatusToken({
      status: "rejected",
      email: null,
      reason: "signature invalid",
      iat: Date.now(),
    });
    window.history.pushState({}, "", `/mimic/try-it-out?samlStatus=${token}`);

    renderPage();

    expect(
      await screen.findByText((_, node) => node?.textContent === "❌ Rejected — signature invalid")
    ).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("falls back to a neutral note for a malformed samlStatus token — never crashes, never shows confirmed", async () => {
    window.history.pushState({}, "", "/mimic/try-it-out?samlStatus=not-a-valid-token!!!");

    expect(() => renderPage()).not.toThrow();

    expect(await screen.findByText("Couldn't read login status.")).toBeInTheDocument();
    expect(screen.queryByText(/Confirmed —/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rejected —/)).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  // --- Logout: disabled-until-verified + same-tab navigation ---

  it("disables Logout until the realm is verified, then same-tab-navigates to /saml/logout with the verified metadata (no nameId when no login banner)", async () => {
    mockSuccessfulVerify();
    renderPage();

    const logoutButton = screen.getByRole("button", { name: "Logout" });
    expect(logoutButton).toBeDisabled();
    expect(
      screen.getAllByText("Verify your realm first to enable this button.").length
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));
    await screen.findByText("Verified");

    expect(logoutButton).not.toBeDisabled();

    const originalLocation = window.location;
    const currentHref = originalLocation.href;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      fireEvent.click(logoutButton);

      expect(assignSpy).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(assignSpy.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe("/saml/logout");
      expect(calledUrl.searchParams.get("idpSloUrl")).toBe(
        "https://keycloak.arifalidawood.com/realms/custom-realm/protocol/saml/slo"
      );
      expect(calledUrl.searchParams.get("idpEntityId")).toBe(
        "https://keycloak.arifalidawood.com/realms/custom-realm"
      );
      expect(calledUrl.searchParams.get("idpCert")).toBe("FAKE_CERT_BASE64");
      expect(calledUrl.searchParams.get("returnUrl")).toBe(currentHref);
      // Todo 7: the same deterministic doc ID as todo 6's login case —
      // general route (no ticket) + Keycloak default → "general_keycloak" —
      // so the SLS callback can resolve this tester's own IdP identity.
      expect(calledUrl.searchParams.get("connectionDocId")).toBe("general_keycloak");
      expect(calledUrl.searchParams.has("nameId")).toBe(false);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("includes nameId when a validated samlStatus login banner provided an email", async () => {
    const token = encodeStatusToken({
      status: "validated",
      email: "tester@example.com",
      reason: null,
      iat: Date.now(),
    });
    window.history.pushState({}, "", `/mimic/try-it-out?samlStatus=${token}`);

    mockSuccessfulVerify();
    renderPage();
    await screen.findByText(
      (_, node) => node?.textContent === "✅ Confirmed — signed in as tester@example.com"
    );

    fireEvent.click(screen.getByRole("button", { name: "Verify realm" }));
    await screen.findByText("Verified");

    const originalLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      fireEvent.click(screen.getByRole("button", { name: "Logout" }));
      const calledUrl = new URL(assignSpy.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.get("nameId")).toBe("tester@example.com");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  // --- samlLogoutStatus banner (mount-time decode, no re-verification) ---

  it("renders a confirmation banner for a logged_out samlLogoutStatus token and strips it from the URL", async () => {
    const token = encodeStatusToken({ status: "logged_out", iat: Date.now() });
    window.history.pushState({}, "", `/mimic/try-it-out?samlLogoutStatus=${token}&kept=1`);

    renderPage();

    expect(
      await screen.findByText(
        (_, node) => node?.textContent === `🚪 Logged out of ${DEFAULT_REALM}`
      )
    ).toBeInTheDocument();

    // samlLogoutStatus stripped, sibling params preserved.
    expect(window.location.search).toBe("?kept=1");
  });

  it("renders an error banner with the payload's message for an error samlLogoutStatus token", async () => {
    const token = encodeStatusToken({
      status: "error",
      message: "IdP unreachable",
      iat: Date.now(),
    });
    window.history.pushState({}, "", `/mimic/try-it-out?samlLogoutStatus=${token}`);

    renderPage();

    expect(
      await screen.findByText(
        (_, node) => node?.textContent === "⚠️ Logout error — IdP unreachable"
      )
    ).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("falls back to a neutral note for a malformed samlLogoutStatus token — never crashes, never shows logged out", async () => {
    window.history.pushState({}, "", "/mimic/try-it-out?samlLogoutStatus=not-a-valid-token!!!");

    expect(() => renderPage()).not.toThrow();

    expect(await screen.findByText("Couldn't read logout status.")).toBeInTheDocument();
    expect(screen.queryByText(/Logged out of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Logout error —/)).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
