import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

const signOutMock = vi.fn(async () => {});

/**
 * `Sidebar`, `Topbar`, and `CommandPalette` are each already individually
 * tested against real auth wiring (`Sidebar.test.tsx`, `Topbar.test.tsx`).
 * This suite is about AppShell's OWN composition/wiring job — route-title
 * derivation, the Cmd+K listener, the Ctrl+B toggle — so a direct
 * `@/lib/authState` mock (matching `Topbar.test.tsx`'s simpler pattern)
 * keeps it focused, rather than re-driving a real `AuthProvider` through
 * firebase callbacks.
 */
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({
    status: "authorized",
    user: { email: "user@tenetx.ai", displayName: null },
    retry: vi.fn(),
    signOut: signOutMock,
  }),
}));

function renderShell(initialEntry: string, children = <div>Page content</div>) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>
  );
}

beforeEach(() => {
  signOutMock.mockClear();
});

describe("AppShell", () => {
  it("renders Sidebar, Topbar, MobileNav, and children; CommandPalette stays closed", () => {
    renderShell("/", <div data-testid="page-content">Dashboard content</div>);

    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Mobile" })).toBeInTheDocument();
    expect(screen.getByTestId("page-content")).toHaveTextContent("Dashboard content");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("Cmd+K opens the command palette, Escape closes it", () => {
    renderShell("/");

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("Ctrl+K also opens the command palette", () => {
    renderShell("/");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("Ctrl+B collapses the desktop sidebar to its icon-only rail, and Cmd+B toggles it back", () => {
    renderShell("/");

    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(sidebar).toHaveAttribute("data-collapsed", "false");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar).toHaveAttribute("data-collapsed", "true");

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  it("passes the mapped title to Topbar for each of the 3 ROUTE_TITLES entries", () => {
    const { unmount: unmountRoot } = renderShell("/");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    unmountRoot();

    const { unmount: unmountMcp } = renderShell("/mcp");
    expect(screen.getByRole("heading", { level: 1, name: "MCP" })).toBeInTheDocument();
    unmountMcp();

    renderShell("/mimic/try-it-out");
    expect(screen.getByRole("heading", { level: 1, name: "Try it out" })).toBeInTheDocument();
  });

  it("falls back to the default title for an unmapped route (ticket-detail routes)", () => {
    renderShell("/mimic/TEN-1/saml-login-fix/1");

    expect(screen.getByRole("heading", { level: 1, name: "TenetX Mimic" })).toBeInTheDocument();
  });

  it("renders the Breadcrumb below Topbar on the ticket-detail route", () => {
    renderShell("/mimic/TEN-1/saml-login-fix/1");

    expect(screen.getByRole("heading", { level: 1, name: "TenetX Mimic" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
  });

  it("does not render the Breadcrumb nav on a non-matching route", () => {
    renderShell("/");

    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
  });
});
