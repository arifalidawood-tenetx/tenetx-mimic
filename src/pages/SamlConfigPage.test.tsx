import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SamlConfigPage } from "./SamlConfigPage";

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({ status: "authorized", user: null, retry: () => {} }),
}));

describe("SamlConfigPage", () => {
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
});
