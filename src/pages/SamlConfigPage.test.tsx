import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { addDoc } from "firebase/firestore";
import { SamlConfigPage } from "./SamlConfigPage";

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({ status: "authorized", user: null, retry: () => {} }),
}));
vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  collection: vi.fn(() => "MIMIC_IDP_CONNECTIONS_REF"),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP_SENTINEL"),
}));

const KEYCLOAK_METADATA_URL =
  "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/descriptor";

const XML_WITH_SLO = `<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/slo/post"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/slo/redirect"/>
    <X509Certificate>ABCDEF</X509Certificate>
  </IDPSSODescriptor>
</EntityDescriptor>`;

const XML_WITHOUT_SLO = `<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <X509Certificate>ABCDEF</X509Certificate>
  </IDPSSODescriptor>
</EntityDescriptor>`;

// jsdom v23's File does not implement Blob.text(), which the Upload-XML flow
// awaits — define it so the client-side parser can be exercised from a test.
function makeXmlFile(xml: string): File {
  const file = new File([xml], "idp-metadata.xml", { type: "text/xml" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(xml), configurable: true });
  return file;
}

function mockSuccessfulTestConnection() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entity_id: "https://keycloak.arifalidawood.com/realms/tenetx-mimic",
        sso_url: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml",
        slo_url: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/slo",
        certificate: "FAKE_CERT_BASE64",
      }),
    })
  );
}

describe("SamlConfigPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders both the Metadata URL and Upload XML tabs", () => {
    render(<SamlConfigPage />);
    expect(screen.getByRole("button", { name: "Metadata URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload XML" })).toBeInTheDocument();
  });

  it("accepts text in the metadata URL input", () => {
    render(<SamlConfigPage />);
    const input = screen.getByLabelText("Metadata URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/descriptor" } });
    expect(input.value).toBe("https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/descriptor");
  });

  it("shows a validation error when testing an empty metadata URL", () => {
    render(<SamlConfigPage />);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    expect(screen.getByText("Enter a metadata URL first.")).toBeInTheDocument();
  });

  it("switches to the Upload XML tab and shows the file input", () => {
    render(<SamlConfigPage />);
    fireEvent.click(screen.getByRole("button", { name: "Upload XML" }));
    expect(screen.getByLabelText("Upload IdP metadata XML")).toBeInTheDocument();
  });

  it("saves the verified metadata to Firestore and shows a success state on Save", async () => {
    mockSuccessfulTestConnection();
    vi.mocked(addDoc).mockResolvedValueOnce({ id: "doc123" } as never);

    render(<SamlConfigPage />);
    const input = screen.getByLabelText("Metadata URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: KEYCLOAK_METADATA_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Verified");

    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await screen.findByText(/doc123/);

    expect(addDoc).toHaveBeenCalledTimes(1);
    const [collectionRef, payload] = vi.mocked(addDoc).mock.calls[0];
    expect(collectionRef).toBe("MIMIC_IDP_CONNECTIONS_REF");
    expect(payload).toMatchObject({
      provider: "saml",
      idpType: "keycloak",
      entity_id: "https://keycloak.arifalidawood.com/realms/tenetx-mimic",
      sso_url: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml",
      slo_url: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/slo",
      certificate: "FAKE_CERT_BASE64",
      metadataUrl: KEYCLOAK_METADATA_URL,
      verifiedAt: "SERVER_TIMESTAMP_SENTINEL",
      createdAt: "SERVER_TIMESTAMP_SENTINEL",
    });
  });

  it("shows a clear error message (not a crash) when the Firestore write is rejected", async () => {
    mockSuccessfulTestConnection();
    vi.mocked(addDoc).mockRejectedValueOnce(
      Object.assign(new Error("Missing or insufficient permissions."), {
        code: "permission-denied",
      })
    );

    render(<SamlConfigPage />);
    const input = screen.getByLabelText("Metadata URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: KEYCLOAK_METADATA_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Verified");

    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Missing or insufficient permissions.");
    // No crash: the Save button remains present and re-enabled for a retry.
    expect(screen.getByRole("button", { name: "Save Configuration" })).toBeInTheDocument();
  });

  it("parses SingleLogoutService from an uploaded XML and threads slo_url into the Firestore payload (client parser)", async () => {
    vi.mocked(addDoc).mockResolvedValueOnce({ id: "docSlo" } as never);

    render(<SamlConfigPage />);
    fireEvent.click(screen.getByRole("button", { name: "Upload XML" }));
    const fileInput = screen.getByLabelText("Upload IdP metadata XML");
    const file = makeXmlFile(XML_WITH_SLO);
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByText("Verified");

    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await screen.findByText(/docSlo/);

    expect(addDoc).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(addDoc).mock.calls[0];
    expect(payload).toMatchObject({
      provider: "saml",
      entity_id: "https://idp.example/entity",
      sso_url: "https://idp.example/sso",
      slo_url: "https://idp.example/slo/redirect",
    });
  });

  it('sets slo_url to "" when an uploaded XML has no SingleLogoutService (client parser)', async () => {
    vi.mocked(addDoc).mockResolvedValueOnce({ id: "docNoSlo" } as never);

    render(<SamlConfigPage />);
    fireEvent.click(screen.getByRole("button", { name: "Upload XML" }));
    const fileInput = screen.getByLabelText("Upload IdP metadata XML");
    const file = makeXmlFile(XML_WITHOUT_SLO);
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByText("Verified");

    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await screen.findByText(/docNoSlo/);

    const [, payload] = vi.mocked(addDoc).mock.calls[0];
    expect(payload).toMatchObject({ slo_url: "" });
  });
});
