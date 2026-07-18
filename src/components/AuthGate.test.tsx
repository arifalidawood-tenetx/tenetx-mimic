import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { User } from "firebase/auth";
import { AuthGate } from "./AuthGate";

type AuthStateCallback = (user: User | null) => void;
let authStateCallback: AuthStateCallback = () => {};

const signOutMock = vi.fn(async () => {
  authStateCallback(null);
});
const signInWithPopupMock = vi.fn();
const signInWithEmailAndPasswordMock = vi.fn();
const createUserWithEmailAndPasswordMock = vi.fn();
const sendEmailVerificationMock = vi.fn();
const sendSignInLinkToEmailMock = vi.fn();
const signInWithEmailLinkMock = vi.fn();

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

// Wrapper closures (not direct references) are required here: vi.mock
// factories are hoisted above these top-level const declarations, so a
// direct reference would hit the TDZ. Deferring the lookup inside a
// function body is safe since it only runs after the module has loaded.
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb;
    return () => {};
  },
  signOut: () => signOutMock(),
  signInWithPopup: () => signInWithPopupMock(),
  signInWithEmailAndPassword: () => signInWithEmailAndPasswordMock(),
  createUserWithEmailAndPassword: () => createUserWithEmailAndPasswordMock(),
  sendEmailVerification: () => sendEmailVerificationMock(),
  sendSignInLinkToEmail: () => sendSignInLinkToEmailMock(),
  isSignInWithEmailLink: () => false,
  signInWithEmailLink: () => signInWithEmailLinkMock(),
  GoogleAuthProvider: class {
    setCustomParameters = vi.fn();
  },
}));

function fakeUser(email: string, providerId: string, emailVerified = true): User {
  return { email, providerId, emailVerified } as unknown as User;
}

function fire(user: User | null) {
  act(() => {
    authStateCallback(user);
  });
}

beforeEach(() => {
  authStateCallback = () => {};
  signOutMock.mockClear();
  signInWithPopupMock.mockClear();
  signInWithEmailAndPasswordMock.mockClear();
  createUserWithEmailAndPasswordMock.mockClear();
  sendEmailVerificationMock.mockClear();
  sendSignInLinkToEmailMock.mockClear();
  signInWithEmailLinkMock.mockClear();
});

describe("AuthGate — provider-agnostic domain backstop (scenario a)", () => {
  it.each([
    ["Google-shaped user", fakeUser("attacker@gmail.com", "google.com")],
    ["Email/Password-shaped user", fakeUser("attacker@gmail.com", "password")],
    ["Email-link-shaped user", fakeUser("attacker@gmail.com", "emailLink")],
  ])("rejects a disallowed-domain %s regardless of provider", async (_label, user) => {
    render(
      <AuthGate>
        <div>Dashboard</div>
      </AuthGate>
    );

    fire(user);

    expect(signOutMock).toHaveBeenCalled();
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
  });
});

describe("AuthGate — domain-allow (scenarios b, c)", () => {
  it("(b) renders dashboard + Super Admin badge for the super-admin email", async () => {
    render(
      <AuthGate>
        <div>Dashboard content</div>
      </AuthGate>
    );

    fire(fakeUser("arif.dawood@tenetx.ai", "password"));

    expect(await screen.findByText("Dashboard content")).toBeInTheDocument();
  });

  it("(c) renders dashboard without Super Admin badge for a non-admin @tenetx.ai email", async () => {
    render(
      <AuthGate>
        <div>Dashboard content</div>
      </AuthGate>
    );

    fire(fakeUser("someone.else@tenetx.ai", "password"));

    expect(await screen.findByText("Dashboard content")).toBeInTheDocument();
  });
});

describe("AuthGate — allowed domain, unverified email (regression: 3 distinct states)", () => {
  it("shows the verify-email screen, not the dashboard nor the unauthorized screen", async () => {
    render(
      <AuthGate>
        <div>Dashboard content</div>
      </AuthGate>
    );

    fire(fakeUser("someone.else@tenetx.ai", "password", false));

    expect(await screen.findByText(/verify your email/i)).toBeInTheDocument();
    expect(screen.queryByText("Dashboard content")).not.toBeInTheDocument();
    expect(screen.queryByText(/not authorized/i)).not.toBeInTheDocument();
    expect(signOutMock).not.toHaveBeenCalled();
  });
});

describe("AuthGate — signup form validation (scenario d)", () => {
  it("blocks account creation for a non-@tenetx.ai email and shows inline error", async () => {
    render(
      <AuthGate>
        <div>Dashboard</div>
      </AuthGate>
    );

    fire(null); // signed-out: show sign-in forms

    fireEvent.click(await screen.findByRole("button", { name: /^sign up$/i }));

    const emailInput = screen.getByLabelText(/^email$/i);
    const passwordInput = screen.getByLabelText(/^password$/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);

    fireEvent.change(emailInput, { target: { value: "someone@gmail.com" } });
    fireEvent.change(passwordInput, { target: { value: "Sup3rSecret!" } });
    fireEvent.change(confirmInput, { target: { value: "Sup3rSecret!" } });

    fireEvent.click(screen.getByRole("button", { name: /^create account$/i }));

    expect(createUserWithEmailAndPasswordMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/only @tenetx\.ai emails are allowed/i)
    ).toBeInTheDocument();
  });
});
