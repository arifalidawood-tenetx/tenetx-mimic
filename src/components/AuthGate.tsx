import { useState, type FormEvent, type ReactNode } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
import { ALLOWED_EMAIL_DOMAIN, SUPER_ADMIN_EMAIL, isAllowedEmail } from "@/lib/auth";
import { AuthProvider, EMAIL_LINK_STORAGE_KEY, useAuthState } from "@/lib/authState";
import { cn } from "@/utils/cn";
import { Badge, Button, Segmented, Spinner } from "./ui";
import { Icon } from "./icons";

type Notice = { tone: "error" | "success"; text: string } | null;

function describeAuthError(error: unknown): string {
  const message = (error as { message?: string } | null)?.message;
  return message ?? "Something went wrong. Please try again.";
}

/* ── Shared card shell (mirrors ErrorBoundary.tsx's centered-card layout) ── */
function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm rounded-xl bg-card p-6 ring-1 ring-line shadow-[var(--shadow-md)]">
        {children}
      </div>
    </div>
  );
}

function Notice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed",
        notice.tone === "error" ? "bg-danger-soft text-danger" : "bg-success-soft text-success"
      )}
    >
      {notice.text}
    </p>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  type: "email" | "password";
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <label className="block text-xs font-medium text-ink-muted">
      {label}
      <input
        type={type}
        required
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="focus-ring mt-1 h-10 w-full rounded-lg bg-card-2 px-3 text-sm text-ink ring-1 ring-line placeholder:text-ink-faint"
      />
    </label>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3a7.42 7.42 0 0 1-4.07 1.16c-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.94 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}

/* ── Google sign-in ────────────────────────────────────────────────────── */
function GoogleSignIn() {
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setNotice(null);
    setBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      // Advisory only — narrows Google's account picker, NOT a security
      // boundary. The real check lives in authState.tsx's onAuthStateChanged.
      provider.setCustomParameters({ hd: ALLOWED_EMAIL_DOMAIN });
      await signInWithPopup(auth, provider);
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="subtle"
        size="md"
        className="w-full"
        onClick={handleClick}
        disabled={busy}
      >
        <GoogleGlyph />
        Sign in with Google
      </Button>
      <Notice notice={notice} />
    </div>
  );
}

/* ── Email/password: sign-in + create-account (tabbed) ───────────────────── */
function EmailPasswordBlock() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSignUp(e: FormEvent) {
    e.preventDefault();
    setNotice(null);

    if (password !== confirmPassword) {
      setNotice({ tone: "error", text: "Passwords do not match." });
      return;
    }
    // Client-side convenience check ONLY — never treat as security. The real
    // enforcement is authState.tsx's onAuthStateChanged backstop.
    if (!isAllowedEmail(email)) {
      setNotice({
        tone: "error",
        text: `Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.`,
      });
      return;
    }

    setBusy(true);
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(credential.user);
      setNotice({
        tone: "success",
        text: "Check your email to verify your account before you can access data.",
      });
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Segmented
        label="Email mode"
        size="sm"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setNotice(null);
        }}
        options={[
          { value: "signin", label: "Sign in" },
          { value: "signup", label: "Sign up" },
        ]}
      />

      {mode === "signin" ? (
        <form onSubmit={handleSignIn} className="mt-3 space-y-2">
          <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Button type="submit" variant="primary" size="md" className="w-full" disabled={busy}>
            Sign in
          </Button>
        </form>
      ) : (
        <form onSubmit={handleSignUp} className="mt-3 space-y-2">
          <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <Field
            label="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
          />
          <Button type="submit" variant="primary" size="md" className="w-full" disabled={busy}>
            Create account
          </Button>
        </form>
      )}
      <Notice notice={notice} />
    </div>
  );
}

/* ── Email-link (passwordless) ────────────────────────────────────────── */
function EmailLinkBlock() {
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);

    if (!isAllowedEmail(email)) {
      setNotice({
        tone: "error",
        text: `Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.`,
      });
      return;
    }

    setBusy(true);
    try {
      await sendSignInLinkToEmail(auth, email, {
        url: window.location.href,
        handleCodeInApp: true,
      });
      window.localStorage.setItem(EMAIL_LINK_STORAGE_KEY, email);
      setNotice({ tone: "success", text: "Check your email for a sign-in link." });
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Field
        label="Email for sign-in link"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Button type="submit" variant="subtle" size="md" className="w-full" disabled={busy}>
        Send me a sign-in link
      </Button>
      <Notice notice={notice} />
    </form>
  );
}

/* ── Sign-in screen (status: "signed-out") ───────────────────────────────── */
function SignInScreen() {
  return (
    <AuthCard>
      <div className="mb-5 text-center">
        <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="shield" className="h-5 w-5" />
        </span>
        <h1 className="text-base font-semibold text-ink">Sign in to QA Score</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Access is restricted to @{ALLOWED_EMAIL_DOMAIN} accounts.
        </p>
      </div>

      <div className="space-y-4">
        <GoogleSignIn />

        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>

        <EmailPasswordBlock />

        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>

        <EmailLinkBlock />
      </div>
    </AuthCard>
  );
}

/* ── Unauthorized screen (status: "unauthorized") ────────────────────────── */
function UnauthorizedScreen() {
  const { retry } = useAuthState();
  return (
    <AuthCard>
      <div className="text-center">
        <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger">
          <Icon name="alert" className="h-5 w-5" />
        </span>
        <h1 className="text-base font-semibold text-ink">Not authorized</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Only @{ALLOWED_EMAIL_DOMAIN} accounts can access this dashboard.
        </p>
        <Button
          type="button"
          variant="subtle"
          size="md"
          className="mt-4 w-full"
          onClick={retry}
        >
          Try a different account
        </Button>
      </div>
    </AuthCard>
  );
}

/* ── Verify-email screen (status: "unverified") ──────────────────────────── */
function VerifyEmailScreen() {
  const { user } = useAuthState();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function handleResend() {
    if (!user) return;
    setNotice(null);
    setBusy(true);
    try {
      await sendEmailVerification(user);
      setNotice({ tone: "success", text: "Verification email sent." });
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRecheck() {
    if (!user) return;
    setBusy(true);
    try {
      await user.reload();
    } finally {
      window.location.reload();
    }
  }

  return (
    <AuthCard>
      <div className="text-center">
        <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="shield" className="h-5 w-5" />
        </span>
        <h1 className="text-base font-semibold text-ink">Verify your email</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Check your inbox at {user?.email ?? "your email"} for a verification link before
          you can access the dashboard.
        </p>
        <div className="mt-4 space-y-2">
          <Button
            type="button"
            variant="primary"
            size="md"
            className="w-full"
            onClick={handleRecheck}
            disabled={busy}
          >
            I&apos;ve verified — reload
          </Button>
          <Button
            type="button"
            variant="subtle"
            size="md"
            className="w-full"
            onClick={handleResend}
            disabled={busy}
          >
            Resend verification email
          </Button>
        </div>
        <Notice notice={notice} />
      </div>
    </AuthCard>
  );
}

/* ── Loading screen (status: "loading") ──────────────────────────────────── */
function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <Spinner className="h-6 w-6 text-ink-faint" />
    </div>
  );
}

/* ── Authorized top bar + gate ────────────────────────────────────────────── */
function AuthorizedTopBar({ email }: { email: string }) {
  const isSuperAdmin = email === SUPER_ADMIN_EMAIL;
  return (
    <div className="flex items-center justify-end gap-2 border-b border-line bg-card px-4 py-1.5 text-xs text-ink-muted">
      {isSuperAdmin && <Badge tone="accent">Super Admin</Badge>}
      <span>{email}</span>
    </div>
  );
}

function AuthGateInner({ children }: { children: ReactNode }) {
  const { status, user } = useAuthState();

  if (status === "loading") return <LoadingScreen />;
  if (status === "unauthorized") return <UnauthorizedScreen />;
  if (status === "unverified") return <VerifyEmailScreen />;
  if (status === "signed-out" || !user) return <SignInScreen />;

  return (
    <div className="flex min-h-screen flex-col">
      <AuthorizedTopBar email={user.email ?? ""} />
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * Self-contained domain gate: wraps `AuthProvider` internally so callers just
 * do `<AuthGate>{dashboard}</AuthGate>` — nothing renders until the user
 * signs in with an @tenetx.ai account via Google, Email/Password, or
 * Email-link. See `authState.tsx` for the actual enforcement.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthGateInner>{children}</AuthGateInner>
    </AuthProvider>
  );
}
