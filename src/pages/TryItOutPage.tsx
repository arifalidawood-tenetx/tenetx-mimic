import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { Badge, Button, Segmented, SectionHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { PageContainer } from "@/components/PageContainer";
import { useAuthState } from "@/lib/authState";
import { db } from "@/lib/firebaseClient";
import {
  DEFAULT_REALM,
  getIdpGuidance,
  IDP_ORDER,
  type IdpType,
} from "@/lib/idpSetupGuidance";

/**
 * A verified SAML IdP metadata result — mirrors `SamlConfigPage.tsx`'s
 * `VerifiedMetadata` shape exactly (todo 3's Firestore field contract:
 * `slo_url` is always a string, never undefined).
 */
interface VerifiedMetadata {
  entity_id: string;
  sso_url: string;
  slo_url: string;
  certificate: string;
}

/** Shape of a `mimic_idp_connections` doc, as hydrated from Firestore. */
interface StoredConnection extends VerifiedMetadata {
  realm: string;
}

/**
 * Client-side-decoded view of the `samlStatus` token's payload (todo 7's
 * `signStatus` shape: `{status, email, reason, iat}`). Only the fields the
 * banner needs are kept; `status` is narrowed to the two "happy path"
 * values the banner distinguishes — everything else (config_error,
 * inconclusive, or a decode failure) collapses to the neutral `"unknown"`
 * banner kind.
 */
type LoginBanner =
  | { kind: "validated"; email: string | null }
  | { kind: "rejected"; reason: string | null }
  | { kind: "unknown" };

/**
 * Client-side-decoded view of the `samlLogoutStatus` token's payload (todo
 * 8's `signStatus` shape: `{status, message, iat}` where `status` is
 * `"logged_out"` or `"error"`). Anything else (a decode failure, or a
 * status value neither of those two) collapses to the neutral `"unknown"`
 * banner kind — mirrors `LoginBanner`'s fallback discipline exactly.
 */
type LogoutBanner =
  | { kind: "logged_out" }
  | { kind: "error"; message: string | null }
  | { kind: "unknown" };

const SAML_PROXY_URL = import.meta.env.VITE_SAML_PROXY_URL ?? "";

/**
 * Decodes (NEVER re-verifies — the HMAC signature was already checked
 * server-side before the `/saml/acs` or `/saml/sls` redirect was issued)
 * the payload half of a status token (`base64url(JSON).hmacHex`). Todo 7's
 * `samlStatus` and todo 8's `samlLogoutStatus` tokens share this identical
 * shape, so this ONE decoder backs both — only the field-shape narrowing
 * below (`decodeSamlStatusPayload` / `decodeSamlLogoutStatusPayload`)
 * differs per token kind, instead of duplicating the split/base64url/JSON
 * parsing twice. Returns the raw parsed payload object when it decodes to
 * a JSON object with a string `status` field, or `null` for anything
 * malformed/tampered/unparsable so callers can fall back to a neutral
 * banner instead of crashing or showing a false "confirmed" state.
 */
function decodeStatusToken(token: string): Record<string, unknown> | null {
  try {
    const [payloadPart] = token.split(".");
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).status !== "string"
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Narrows a decoded token payload to `samlStatus`'s shape (todo 7:
 * `{status, email, reason, iat}`). */
function decodeSamlStatusPayload(
  token: string
): { status: string; email: string | null; reason: string | null } | null {
  const record = decodeStatusToken(token);
  if (!record) return null;
  return {
    status: record.status as string,
    email: typeof record.email === "string" ? record.email : null,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

/** Narrows a decoded token payload to `samlLogoutStatus`'s shape (todo 8:
 * `{status, message, iat}`; `status` is `"logged_out"` or `"error"`). */
function decodeSamlLogoutStatusPayload(
  token: string
): { status: string; message: string | null } | null {
  const record = decodeStatusToken(token);
  if (!record) return null;
  return {
    status: record.status as string,
    message: typeof record.message === "string" ? record.message : null,
  };
}

/**
 * Lowercase-alphanumeric-plus-hyphens only — matches what's safe to
 * interpolate into a URL path segment (Keycloak's realm segment, Authentik's
 * launch-URL slug). Live-normalizes on every keystroke (chosen over a
 * reject-and-show-error UX) so the input can never hold an invalid
 * character in the first place.
 */
function sanitizeRealm(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Deterministic `mimic_idp_connections` doc ID so re-verifying the same
 * realm/IdP (same ticket, or the general no-ticket route) UPDATES the
 * existing doc via `setDoc(..., {merge:true})` instead of creating a new
 * doc every time. On the general route (no ticket) this collapses to one
 * shared doc per IdP type — acceptable for this internal testing tool.
 */
function connectionDocId(ticket: string | undefined, idpType: IdpType): string {
  return `${ticket ?? "general"}_${idpType}`;
}

/**
 * Guided "Try It Out" wizard: pick an IdP, enter the realm/application name
 * you configured it under, follow its exact field values (sourced from
 * `src/lib/idpSetupGuidance.ts`, parametrized by that realm), verify the
 * realm's real SAML metadata, then launch a real login against it. No
 * credentials/secrets live here — only field guidance; the tester
 * configures and authenticates against their own IdP.
 */
export function TryItOutPage() {
  const { ticket } = useParams();
  const { user } = useAuthState();

  const [idpType, setIdpType] = useState<IdpType>("keycloak");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [realm, setRealm] = useState(DEFAULT_REALM);
  const [authentikMetadataUrl, setAuthentikMetadataUrl] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifiedMetadata, setVerifiedMetadata] = useState<VerifiedMetadata | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loginBanner, setLoginBanner] = useState<LoginBanner | null>(null);
  const [logoutBanner, setLogoutBanner] = useState<LogoutBanner | null>(null);

  const effectiveRealm = realm || DEFAULT_REALM;
  const guidance = getIdpGuidance(idpType, effectiveRealm);
  const realmLabel = idpType === "keycloak" ? "Realm name" : "Application name";
  const keycloakDescriptorUrl = `https://keycloak.arifalidawood.com/realms/${effectiveRealm}/protocol/saml/descriptor`;

  // On mount (and whenever the ticket or selected IdP changes), hydrate any
  // previously-verified `mimic_idp_connections` doc for this exact
  // {ticketId, idpType} pair. Only queries when a `ticket` param is present
  // (the general `/mimic/try-it-out` route has none, so this is a no-op
  // there, per the plan).
  useEffect(() => {
    if (!ticket) return;
    let active = true;

    async function hydrate() {
      try {
        const q = query(
          collection(db, "mimic_idp_connections"),
          where("ticketId", "==", ticket),
          where("idpType", "==", idpType)
        );
        const snapshot = await getDocs(q);
        if (!active || snapshot.empty) return;
        const data = snapshot.docs[0].data() as StoredConnection;
        setRealm(data.realm);
        setVerifiedMetadata({
          entity_id: data.entity_id,
          sso_url: data.sso_url,
          slo_url: data.slo_url ?? "",
          certificate: data.certificate,
        });
      } catch (err) {
        console.error("mimic_idp_connections hydrate query failed:", err);
      }
    }

    void hydrate();
    return () => {
      active = false;
    };
  }, [ticket, idpType]);

  // On mount, read (never re-verify) any `samlStatus` token the backend's
  // `/saml/acs` redirect attached to `returnUrl` (todo 7's contract), render
  // the matching banner, then strip the param via `replaceState` so a
  // refresh doesn't re-show stale status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("samlStatus");
    if (!token) return;

    const decoded = decodeSamlStatusPayload(token);
    if (decoded?.status === "validated") {
      setLoginBanner({ kind: "validated", email: decoded.email });
    } else if (decoded?.status === "rejected") {
      setLoginBanner({ kind: "rejected", reason: decoded.reason });
    } else {
      setLoginBanner({ kind: "unknown" });
    }

    params.delete("samlStatus");
    const search = params.toString();
    const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, []);

  // On mount, independently check (separate from the `samlStatus` effect
  // above — both can coexist though never simultaneously in practice) for a
  // `samlLogoutStatus` token the backend's `/saml/sls` redirect attached to
  // `returnUrl` (todo 8's contract), render the matching banner, then strip
  // the param via `replaceState` the same way.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("samlLogoutStatus");
    if (!token) return;

    const decoded = decodeSamlLogoutStatusPayload(token);
    if (decoded?.status === "logged_out") {
      setLogoutBanner({ kind: "logged_out" });
    } else if (decoded?.status === "error") {
      setLogoutBanner({ kind: "error", message: decoded.message });
    } else {
      setLogoutBanner({ kind: "unknown" });
    }

    params.delete("samlLogoutStatus");
    const search = params.toString();
    const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, []);

  function handleCopy(field: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1500);
  }

  /**
   * Verifies the entered realm's real SAML metadata against the existing
   * authenticated `/verify-metadata` backend route (mirrors
   * `SamlConfigPage.tsx`'s `handleTestConnection`), then — on success —
   * writes/updates a `mimic_idp_connections` doc (mirrors `handleSave`).
   * Combined into one action per the plan: "Verify realm" builds the
   * descriptor URL, POSTs it, and persists on success — no separate manual
   * save step.
   */
  async function handleVerifyRealm() {
    if (!realm) {
      setVerifyError("Enter a realm name first.");
      return;
    }
    if (idpType === "authentik" && !authentikMetadataUrl.trim()) {
      setVerifyError("Enter a metadata URL first.");
      return;
    }
    setVerifyError(null);
    setSaveError(null);
    setVerifiedMetadata(null);
    setVerifying(true);
    try {
      const metadataUrl =
        idpType === "keycloak"
          ? `https://keycloak.arifalidawood.com/realms/${realm}/protocol/saml/descriptor`
          : authentikMetadataUrl.trim();

      const idToken = await user?.getIdToken();
      const response = await fetch(`${SAML_PROXY_URL}/verify-metadata`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken ?? ""}`,
        },
        body: JSON.stringify({ metadataUrl }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setVerifyError(body.error ?? `Verification failed (HTTP ${response.status})`);
        return;
      }
      const rawVerified: VerifiedMetadata = await response.json();
      // Guard against a backend that predates the slo_url field (or omits it
      // for any other reason) — Firestore's setDoc() rejects `undefined`
      // outright, and the invariant documented above is that slo_url is
      // always a string here, never undefined.
      const verified: VerifiedMetadata = { ...rawVerified, slo_url: rawVerified.slo_url ?? "" };
      setVerifiedMetadata(verified);

      try {
        await setDoc(
          doc(db, "mimic_idp_connections", connectionDocId(ticket, idpType)),
          {
            provider: "saml",
            realm,
            idpType,
            ticketId: ticket ?? null,
            entity_id: verified.entity_id,
            sso_url: verified.sso_url,
            slo_url: verified.slo_url,
            certificate: verified.certificate,
            verifiedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save configuration.");
      }
    } catch (err) {
      console.error("verify-metadata request failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      setVerifyError(`Could not reach the tenetx-mimic-backend service: ${message}`);
    } finally {
      setVerifying(false);
    }
  }

  /**
   * Same-tab SP-initiated launch through the backend's `/saml/login` route
   * (todo 6's contract), sourced from the just-verified `verifiedMetadata`
   * rather than the static `guidance.launchLoginUrl`. Disabled by the caller
   * until a verification has succeeded, so `verifiedMetadata` is always
   * non-null here.
   */
  function handleLaunchLogin() {
    if (!verifiedMetadata) return;
    const params = new URLSearchParams({
      idpEntityId: verifiedMetadata.entity_id,
      idpSsoUrl: verifiedMetadata.sso_url,
      idpCert: verifiedMetadata.certificate,
      returnUrl: window.location.href,
      connectionDocId: connectionDocId(ticket, idpType),
    });
    window.location.assign(`${SAML_PROXY_URL}/saml/login?${params.toString()}`);
  }

  /**
   * Same-tab real SAML SLO initiation through the backend's `/saml/logout`
   * route (todo 8's contract), mirroring `handleLaunchLogin` exactly.
   * Enabled whenever `verifiedMetadata` exists — see the notepad for the
   * documented enable/disable rationale (the plan's "executor's choice").
   * `nameId` is included only when a validated `loginBanner` carried an
   * email; omitted entirely otherwise (never sent as an empty string).
   */
  function handleLogout() {
    if (!verifiedMetadata) return;
    const params = new URLSearchParams({
      idpSloUrl: verifiedMetadata.slo_url,
      idpEntityId: verifiedMetadata.entity_id,
      idpCert: verifiedMetadata.certificate,
      returnUrl: window.location.href,
      connectionDocId: connectionDocId(ticket, idpType),
    });
    if (loginBanner?.kind === "validated" && loginBanner.email) {
      params.set("nameId", loginBanner.email);
    }
    window.location.assign(`${SAML_PROXY_URL}/saml/logout?${params.toString()}`);
  }

  return (
    <PageContainer size="narrow" className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">Try it out</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Pick your identity provider, follow its exact field values below, then launch a real
          login against it. Nothing here is invented — every value mirrors the qa-logbook
          runbook for that IdP.
        </p>
      </div>

      <Segmented
        label="Identity provider"
        value={idpType}
        onChange={setIdpType}
        options={IDP_ORDER.map((id) => ({
          value: id,
          label: getIdpGuidance(id, DEFAULT_REALM).label,
        }))}
      />

      <div className="space-y-2 rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between">
          <SectionHeader icon="sliders">{guidance.label} — field values</SectionHeader>
          <Badge tone="neutral">{guidance.location}</Badge>
        </div>

        <ol className="space-y-3">
          {guidance.steps.map((step, index) => (
            <li key={step.field} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-card-3 text-[11px] font-medium text-ink-muted">
                  {index + 1}
                </span>
                <span className="font-medium text-ink">{step.field}</span>
              </div>
              <div className="ml-7 flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-card px-2 py-1 text-xs text-ink ring-1 ring-line">
                  {step.value}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(step.field, step.value)}
                >
                  {copiedField === step.field ? "Copied!" : "Copy"}
                </Button>
              </div>
              {step.note && <p className="ml-7 text-[11px] text-ink-faint">{step.note}</p>}
            </li>
          ))}
        </ol>
      </div>

      <div
        role="alert"
        className="space-y-1.5 rounded-xl bg-warning-soft p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow"
      >
        <div className="flex items-center gap-2">
          <Icon name="alert" className="h-4 w-4 shrink-0 text-warning" />
          <h2 className="text-sm font-semibold text-warning">{guidance.gotcha.title}</h2>
        </div>
        <p className="text-xs text-ink">{guidance.gotcha.body}</p>
      </div>

      <div className="space-y-3 rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
        <h2 className="text-sm font-semibold text-ink">Verify your {guidance.label} setup</h2>
        <p className="text-xs text-ink-muted">
          Enter the {realmLabel.toLowerCase()} you configured above, then verify it against{" "}
          {guidance.label}&apos;s real SAML metadata.
        </p>

        <div className="space-y-1">
          <label htmlFor="realm-input" className="text-sm font-medium text-ink">
            {realmLabel}
          </label>
          <input
            id="realm-input"
            type="text"
            value={realm}
            onChange={(e) => setRealm(sanitizeRealm(e.target.value))}
            placeholder={DEFAULT_REALM}
            className="focus-ring h-10 w-full rounded-lg bg-card px-3 text-sm text-ink ring-1 ring-line"
          />
        </div>

        {idpType === "keycloak" ? (
          <p className="break-all text-[11px] text-ink-faint">
            Descriptor URL: {keycloakDescriptorUrl}
          </p>
        ) : (
          <div className="space-y-1">
            <label htmlFor="authentik-metadata-url" className="text-sm font-medium text-ink">
              Metadata URL
            </label>
            <input
              id="authentik-metadata-url"
              type="text"
              value={authentikMetadataUrl}
              onChange={(e) => setAuthentikMetadataUrl(e.target.value)}
              placeholder="https://authentik.arifalidawood.com/api/v3/providers/saml/<id>/metadata/?download"
              className="focus-ring h-10 w-full rounded-lg bg-card px-3 text-sm text-ink ring-1 ring-line"
            />
          </div>
        )}

        <Button variant="primary" onClick={handleVerifyRealm} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify realm"}
        </Button>

        {verifyError && <p className="text-sm text-danger">{verifyError}</p>}

        {verifiedMetadata && (
          <div className="space-y-2 rounded-lg bg-card p-3 ring-1 ring-line">
            <div className="flex items-center gap-2">
              <Badge tone="success">Verified</Badge>
              <span className="text-sm font-medium text-ink">Identity provider metadata</span>
            </div>
            <dl className="space-y-1 text-xs">
              <div>
                <dt className="text-ink-faint">Entity ID</dt>
                <dd className="break-all text-ink">{verifiedMetadata.entity_id}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">SSO URL</dt>
                <dd className="break-all text-ink">{verifiedMetadata.sso_url}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">SLO URL</dt>
                <dd className="break-all text-ink">{verifiedMetadata.slo_url || "—"}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">Certificate</dt>
                <dd className="break-all font-mono text-ink">
                  {verifiedMetadata.certificate.slice(0, 60)}…
                </dd>
              </div>
            </dl>
            {saveError && <p className="text-sm text-danger">{saveError}</p>}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
        <SectionHeader icon="zap">Launch login</SectionHeader>
        <p className="text-xs text-ink-muted">
          Once {guidance.label} is configured with the values above, start a real login against
          it. This link goes straight to {guidance.label} — never to this mimic's own server.
        </p>
        <Button
          variant="primary"
          onClick={handleLaunchLogin}
          disabled={!verifiedMetadata}
          title={verifiedMetadata ? undefined : "Verify your realm first"}
        >
          Launch {guidance.label} login
        </Button>
        {!verifiedMetadata && (
          <p className="text-xs text-ink-faint">Verify your realm first to enable this button.</p>
        )}
        <p className="break-all text-[11px] text-ink-faint">{guidance.launchLoginUrl}</p>

        {loginBanner?.kind === "validated" && (
          <p role="status" className="text-sm font-medium text-success">
            ✅ Confirmed — signed in as {loginBanner.email ?? "unknown"}
          </p>
        )}
        {loginBanner?.kind === "rejected" && (
          <p role="status" className="text-sm font-medium text-danger">
            ❌ Rejected — {loginBanner.reason ?? "unknown reason"}
          </p>
        )}
        {loginBanner?.kind === "unknown" && (
          <p role="status" className="text-sm text-ink-muted">
            Couldn&apos;t read login status.
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
        <SectionHeader icon="shield">Logout</SectionHeader>
        <p className="text-xs text-ink-muted">
          Trigger a real SAML Single Logout (SLO) against {guidance.label}, ending the session
          you just launched above.
        </p>
        <Button
          variant="primary"
          onClick={handleLogout}
          disabled={!verifiedMetadata}
          title={verifiedMetadata ? undefined : "Verify your realm first"}
        >
          Logout
        </Button>
        {!verifiedMetadata && (
          <p className="text-xs text-ink-faint">Verify your realm first to enable this button.</p>
        )}

        {logoutBanner?.kind === "logged_out" && (
          <p role="status" className="text-sm font-medium text-success">
            🚪 Logged out of {effectiveRealm}
          </p>
        )}
        {logoutBanner?.kind === "error" && (
          <p role="status" className="text-sm font-medium text-danger">
            ⚠️ Logout error — {logoutBanner.message ?? "unknown reason"}
          </p>
        )}
        {logoutBanner?.kind === "unknown" && (
          <p role="status" className="text-sm text-ink-muted">
            Couldn&apos;t read logout status.
          </p>
        )}
      </div>

      <p className="text-[11px] text-ink-faint">
        Sourced from{" "}
        <code className="rounded bg-card-2 px-1">{guidance.runbookRef}</code> — if the runbook
        changes, update <code className="rounded bg-card-2 px-1">src/lib/idpSetupGuidance.ts</code>
        {" "}so this wizard stays in sync.
      </p>
    </PageContainer>
  );
}
