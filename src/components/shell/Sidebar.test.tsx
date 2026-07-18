import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { User } from "firebase/auth";
import { Sidebar } from "./Sidebar";
import { AuthProvider } from "@/lib/authState";
import { ToastProvider } from "./Toast";

type AuthStateCallback = (user: User | null) => void;
let authStateCallback: AuthStateCallback = () => {};

const signOutMock = vi.fn(async () => {
  authStateCallback(null);
});

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb;
    return () => {};
  },
  signOut: () => signOutMock(),
  signInWithPopup: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendSignInLinkToEmail: vi.fn(),
  isSignInWithEmailLink: () => false,
  signInWithEmailLink: () => Promise.resolve(),
  GoogleAuthProvider: class {
    setCustomParameters = vi.fn();
  },
}));

function fakeUser(email: string, emailVerified = true): User {
  return { email, emailVerified } as unknown as User;
}

function fire(user: User | null) {
  act(() => {
    authStateCallback(user);
  });
}

/** Renders the current route's pathname so tests can assert "did not navigate". */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

function renderSidebar(initialPath = "/mimic/try-it-out", collapsed = false) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <ToastProvider>
          <Sidebar collapsed={collapsed} />
          <LocationProbe />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  authStateCallback = () => {};
  signOutMock.mockClear();
});

describe("Sidebar", () => {
  it("renders nothing when useAuthState() reports status: unauthorized", async () => {
    const { container } = renderSidebar();

    // A disallowed-domain email flows through the REAL authState.tsx
    // rejection path and lands on status: "unauthorized" — not just
    // "signed-out" — exactly the state this guard must handle.
    fire(fakeUser("jane@not-tenetx.example"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.querySelector("aside")).not.toBeInTheDocument();
  });

  it("renders exactly 3 flat nav items when authorized", async () => {
    renderSidebar();
    fire(fakeUser("jane.doe@tenetx.ai"));

    expect(await screen.findByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Try it out/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^MCP$/i })).toBeInTheDocument();
  });

  it("applies active accent styling to the current route's nav item only", async () => {
    renderSidebar("/mimic/try-it-out");
    fire(fakeUser("jane.doe@tenetx.ai"));

    const tryItOutLink = await screen.findByRole("link", { name: /Try it out/i });
    expect(tryItOutLink.className).toContain("bg-accent/10");
    expect(tryItOutLink.className).toContain("text-accent");

    const dashboardLink = screen.getByRole("link", { name: /Dashboard/i });
    expect(dashboardLink.className).not.toContain("bg-accent/10");
  });

  it("Preferences click fires a toast instead of navigating", async () => {
    renderSidebar("/mimic/try-it-out");
    fire(fakeUser("jane.doe@tenetx.ai"));

    const preferencesButton = await screen.findByRole("button", { name: /Preferences/i });
    expect(preferencesButton.tagName).toBe("BUTTON");

    await act(async () => {
      fireEvent.click(preferencesButton);
    });

    expect(await screen.findByText("Settings coming soon")).toBeInTheDocument();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/mimic/try-it-out");
  });

  it("footer shows derived initials and full email", async () => {
    renderSidebar();
    fire(fakeUser("jane.doe@tenetx.ai"));

    expect(await screen.findByText("JD")).toBeInTheDocument();
    expect(screen.getByText("jane.doe@tenetx.ai")).toBeInTheDocument();
  });

  it("Sign out button calls the real signOut from useAuthState", async () => {
    renderSidebar();
    fire(fakeUser("jane.doe@tenetx.ai"));

    const signOutButton = await screen.findByRole("button", { name: /Sign out/i });

    await act(async () => {
      fireEvent.click(signOutButton);
    });

    expect(signOutMock).toHaveBeenCalled();
  });

  it("renders Super Admin badge only for SUPER_ADMIN_EMAIL", async () => {
    renderSidebar();
    fire(fakeUser("arif.dawood@tenetx.ai"));

    expect(await screen.findByText("Super Admin")).toBeInTheDocument();
  });

  it("does not render Super Admin badge for a regular user", async () => {
    renderSidebar();
    fire(fakeUser("jane.doe@tenetx.ai"));

    await screen.findByText("jane.doe@tenetx.ai");
    expect(screen.queryByText("Super Admin")).not.toBeInTheDocument();
  });

  it("collapsed: hides nav labels and the aside reports data-collapsed=true", async () => {
    const { container } = renderSidebar("/mimic/try-it-out", true);
    fire(fakeUser("jane.doe@tenetx.ai"));

    await screen.findByRole("link", { name: /Try it out/i });

    expect(container.querySelector("aside")).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Preferences")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("title", "Dashboard");
  });

  it("collapsed: renders the Collapsed Rail profile (avatar + icon-only Sign out, no name/email)", async () => {
    renderSidebar("/mimic/try-it-out", true);
    fire(fakeUser("jane.doe@tenetx.ai"));

    expect(await screen.findByText("JD")).toBeInTheDocument();
    expect(screen.queryByText("jane.doe@tenetx.ai")).not.toBeInTheDocument();

    const signOutButton = screen.getByRole("button", { name: "Sign out" });
    await act(async () => {
      fireEvent.click(signOutButton);
    });
    expect(signOutMock).toHaveBeenCalled();
  });
});
