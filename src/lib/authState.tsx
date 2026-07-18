import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  signInWithEmailLink,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { auth } from "./firebaseClient";
import { isAllowedEmail } from "./auth";

export type AuthStatus =
  | "loading"
  | "signed-out"
  | "unauthorized"
  | "unverified"
  | "authorized";

export const EMAIL_LINK_STORAGE_KEY = "emailForSignIn";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Clears the "unauthorized" state so the sign-in forms show again. */
  retry: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  // Tracks "we just force-signed-out a disallowed account" so the follow-up
  // onAuthStateChanged(null) call (fired asynchronously by signOut) doesn't
  // clobber the "unauthorized" status back to "signed-out".
  const rejectedRef = useRef(false);

  // THE REAL SECURITY BACKSTOP. Runs identically no matter which provider
  // (Google popup, email/password, email-link) produced the sign-in — all
  // three funnel through this same onAuthStateChanged callback. Anything
  // provider-specific (Google's `hd` param, the signup form's client-side
  // domain check) is UX convenience only and is NOT relied on here.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser && isAllowedEmail(firebaseUser.email)) {
        rejectedRef.current = false;

        if (!firebaseUser.emailVerified) {
          // Right domain, unverified: keep signed in (unlike wrong-domain
          // below) so the UI can offer resend/recheck instead of forcing
          // sign-out.
          setUser(firebaseUser);
          setStatus("unverified");
          return;
        }

        setUser(firebaseUser);
        setStatus("authorized");
        return;
      }

      if (firebaseUser) {
        // Disallowed domain — reject regardless of provider or verification.
        rejectedRef.current = true;
        setUser(null);
        setStatus("unauthorized");
        void firebaseSignOut(auth);
        return;
      }

      // No user. Preserve "unauthorized" if this null-fire is the fallout of
      // the signOut() call above; otherwise it's a genuine signed-out state.
      setUser(null);
      setStatus(rejectedRef.current ? "unauthorized" : "signed-out");
    });
    return unsubscribe;
  }, []);

  // Email-link (passwordless) completion. If the current URL is a sign-in
  // link, finish the flow using the email stashed in localStorage before the
  // link was sent (or prompt for it if opened on a different device).
  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) return;

    let email = window.localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
    if (!email) {
      email = window.prompt("Confirm your email to complete sign-in") ?? "";
    }
    if (!email) return;

    signInWithEmailLink(auth, email, window.location.href)
      .then(() => {
        window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error("Email-link sign-in failed:", error);
      });
  }, []);

  const retry = () => {
    rejectedRef.current = false;
    setStatus("signed-out");
  };

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, retry, signOut: () => firebaseSignOut(auth) }),
    [status, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthState(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthState must be used within AuthProvider");
  return ctx;
}
