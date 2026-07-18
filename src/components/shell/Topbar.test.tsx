import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { User } from "firebase/auth";
import { Topbar } from "./Topbar";
import { useAuthState } from "@/lib/authState";

// Topbar only needs `useAuthState().user` — mocking the whole module (per
// task instructions) is simpler and more direct than driving a real
// AuthProvider through firebase/auth callbacks, and lets each test set
// exactly the `user` shape it needs (including `null`).
vi.mock("@/lib/authState", () => ({
  useAuthState: vi.fn(),
}));

const mockedUseAuthState = vi.mocked(useAuthState);

function fakeUser(email: string): User {
  return { email } as unknown as User;
}

function mockAuthUser(email: string | null) {
  mockedUseAuthState.mockReturnValue({
    status: email ? "authorized" : "loading",
    user: email ? fakeUser(email) : null,
    retry: vi.fn(),
    signOut: vi.fn(async () => {}),
  });
}

function renderTopbar({
  title = "Dashboard",
  onOpenCommandPalette = vi.fn(),
  initialPath = "/",
}: {
  title?: string;
  onOpenCommandPalette?: () => void;
  initialPath?: string;
} = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Topbar title={title} onOpenCommandPalette={onOpenCommandPalette} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockAuthUser("jane.doe@tenetx.ai");
});

describe("Topbar", () => {
  it("renders the title prop as an h1", () => {
    renderTopbar({ title: "Dashboard" });
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
  });

  it("renders whatever title prop it's given (e.g. on the MCP route)", () => {
    renderTopbar({ title: "MCP" });
    expect(screen.getByRole("heading", { level: 1, name: "MCP" })).toBeInTheDocument();
  });

  it("clicking the search trigger calls onOpenCommandPalette", () => {
    const onOpenCommandPalette = vi.fn();
    renderTopbar({ onOpenCommandPalette });

    const searchButtons = screen.getAllByRole("button", { name: /search/i });
    fireEvent.click(searchButtons[0]);

    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("shows the search placeholder text and the ⌘K kbd badge", () => {
    renderTopbar();
    expect(screen.getByText("Search pages, actions…")).toBeInTheDocument();
    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });

  it("bell dropdown is closed by default and shows the real empty state once opened", () => {
    renderTopbar();
    expect(screen.queryByTestId("notifications-panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));

    expect(screen.getByTestId("notifications-panel")).toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("clicking the bell again closes the dropdown (toggle)", () => {
    renderTopbar();
    const bellButton = screen.getByRole("button", { name: /notifications/i });

    fireEvent.click(bellButton);
    expect(screen.getByTestId("notifications-panel")).toBeInTheDocument();

    fireEvent.click(bellButton);
    expect(screen.queryByTestId("notifications-panel")).not.toBeInTheDocument();
  });

  it("avatar chip shows initials derived from the mocked user's email (dotted local part)", () => {
    mockAuthUser("jane.doe@tenetx.ai");
    renderTopbar();

    expect(screen.getByTestId("topbar-avatar")).toHaveTextContent("JD");
  });

  it("avatar chip shows a single-letter initial for a no-separator local part", () => {
    mockAuthUser("jane@tenetx.ai");
    renderTopbar();

    expect(screen.getByTestId("topbar-avatar")).toHaveTextContent("J");
  });

  it("does not throw and falls back to '?' when user is null (pre-AuthGate window)", () => {
    mockAuthUser(null);

    expect(() => renderTopbar()).not.toThrow();
    expect(screen.getByTestId("topbar-avatar")).toHaveTextContent("?");
  });

  it("does not render a Breadcrumb nav itself — it now lives below Topbar in AppShell", () => {
    renderTopbar({ title: "Dashboard", initialPath: "/mimic/TENQA-17/some-feature/1" });

    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
  });
});
