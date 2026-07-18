import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { AuthProvider, useAuthState } from "./authState";

type AuthStateCallback = (user: User | null) => void;
let authStateCallback: AuthStateCallback = () => {};

const firebaseSignOutMock = vi.fn(async () => {
  authStateCallback(null);
});
const signInWithEmailLinkMock = vi.fn();

vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: AuthStateCallback) => {
    authStateCallback = cb;
    return () => {};
  },
  signOut: () => firebaseSignOutMock(),
  isSignInWithEmailLink: () => false,
  signInWithEmailLink: () => signInWithEmailLinkMock(),
}));

vi.mock("@/lib/auth", () => ({
  isAllowedEmail: (email: string) => email.endsWith("@tenetx.ai"),
}));

function TestConsumer() {
  const { signOut, status } = useAuthState();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <button data-testid="signout-button" onClick={() => signOut()}>
        Sign Out
      </button>
    </div>
  );
}

beforeEach(() => {
  authStateCallback = () => {};
  firebaseSignOutMock.mockClear();
  signInWithEmailLinkMock.mockClear();
});

describe("authState — signOut context method", () => {
  it("invokes firebase signOut when calling useAuthState().signOut()", async () => {
    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    // Simulate an authorized user
    await waitFor(() => {
      expect(getByTestId("status")).toHaveTextContent("loading");
    });

    // Fire the button click to call signOut
    const button = getByTestId("signout-button");
    button.click();

    // Verify the firebase signOut was invoked
    await waitFor(() => {
      expect(firebaseSignOutMock).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a Promise from signOut", async () => {
    let signOutFn: (() => Promise<void>) | null = null;

    function TestConsumerCapture() {
      const { signOut } = useAuthState();
      signOutFn = signOut;
      return <div>Test</div>;
    }

    render(
      <AuthProvider>
        <TestConsumerCapture />
      </AuthProvider>
    );

    expect(signOutFn).toBeDefined();
    expect(typeof signOutFn).toBe("function");

    const result = signOutFn!();
    expect(result).toBeInstanceOf(Promise);
  });
});
