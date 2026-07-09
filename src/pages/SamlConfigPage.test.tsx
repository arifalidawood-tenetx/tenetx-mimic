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

function mockSuccessfulTestConnection() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entity_id: "https://keycloak.arifalidawood.com/realms/tenetx-mimic",
        sso_url: "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml",
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
});
