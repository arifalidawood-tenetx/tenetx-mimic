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
import { Badge, Button, Segmented } from "@/components/ui";
import { Icon } from "@/components/icons";
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

const SAML_PROXY_URL = import.meta.env.VITE_SAML_PROXY_URL ?? "";

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
          slo_url: data.slo_url,
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
      const verified: VerifiedMetadata = await response.json();
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

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Try it out</h1>
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

      <div className="space-y-2 rounded-lg bg-card-2 p-4 ring-1 ring-line">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{guidance.label} — field values</h2>
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
        className="space-y-1.5 rounded-lg bg-warning-soft p-4 ring-1 ring-line"
      >
        <div className="flex items-center gap-2">
          <Icon name="alert" className="h-4 w-4 shrink-0 text-warning" />
          <h2 className="text-sm font-semibold text-warning">{guidance.gotcha.title}</h2>
        </div>
        <p className="text-xs text-ink">{guidance.gotcha.body}</p>
      </div>

      <div className="space-y-3 rounded-lg bg-card-2 p-4 ring-1 ring-line">
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

      <div className="space-y-2 rounded-lg bg-card-2 p-4 ring-1 ring-line">
        <h2 className="text-sm font-semibold text-ink">Launch login</h2>
        <p className="text-xs text-ink-muted">
          Once {guidance.label} is configured with the values above, start a real login against
          it. This link goes straight to {guidance.label} — never to this mimic's own server.
        </p>
        <Button
          variant="primary"
          onClick={() => window.open(guidance.launchLoginUrl, "_blank", "noopener,noreferrer")}
        >
          Launch {guidance.label} login
        </Button>
        <p className="break-all text-[11px] text-ink-faint">{guidance.launchLoginUrl}</p>
      </div>

      <p className="text-[11px] text-ink-faint">
        Sourced from{" "}
        <code className="rounded bg-card-2 px-1">{guidance.runbookRef}</code> — if the runbook
        changes, update <code className="rounded bg-card-2 px-1">src/lib/idpSetupGuidance.ts</code>
        {" "}so this wizard stays in sync.
      </p>
    </div>
  );
}
