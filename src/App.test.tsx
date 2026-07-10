import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "./App";

// AuthGate + its underlying AuthProvider pull in real firebase/auth wiring;
// bypassing both here keeps this test focused on route resolution (the
// thing App.tsx itself owns) rather than re-testing auth, which already has
// its own dedicated test suites (AuthGate.test.tsx, authState.test.tsx).
vi.mock("@/components/AuthGate", () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/authState", () => ({
  useAuthState: () => ({
    status: "authorized",
    user: null,
    retry: () => {},
    signOut: async () => {},
  }),
}));

describe("App routing", () => {
  afterEach(() => {
    cleanup();
  });

  it("resolves /mimic/try-it-out to TryItOutPage", () => {
    window.history.pushState({}, "", "/mimic/try-it-out");

    render(<App />);

    expect(screen.getByRole("heading", { name: "Try it out" })).toBeInTheDocument();
  });

  it("resolves /mimic/:ticket/try-it-out to TryItOutPage", () => {
    window.history.pushState({}, "", "/mimic/TEN-1/try-it-out");

    render(<App />);

    expect(screen.getByRole("heading", { name: "Try it out" })).toBeInTheDocument();
  });

  it("resolves /mimic/:ticket/:feature/:attempt to AttemptDetailPage (regression — no collision with /mimic/:ticket/try-it-out)", () => {
    window.history.pushState({}, "", "/mimic/TEN-1/saml-login-fix/1");

    render(<App />);

    expect(screen.getByText("saml-login-fix")).toBeInTheDocument();
  });
});
