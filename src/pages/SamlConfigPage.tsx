import { useRef, useState } from "react";
import { Badge, Button, Segmented } from "@/components/ui";
import { useAuthState } from "@/lib/authState";

type Tab = "url" | "upload";

interface VerifiedMetadata {
  entity_id: string;
  sso_url: string;
  certificate: string;
}

// Client-side reimplementation of the metadata-XML parse used by the
// Upload-XML tab (no server round-trip needed for a local file). DOMParser
// is only available here in the browser context — the saml-proxy's Node
// service (todo 9) has its own namespace-aware parser since DOMParser
// doesn't exist in Node.
function parseMetadataXmlClient(xmlString: string): VerifiedMetadata | null {
  try {
    const doc = new DOMParser().parseFromString(xmlString, "text/xml");
    if (doc.querySelector("parsererror")) return null;

    const entityId = doc.querySelector("EntityDescriptor")?.getAttribute("entityID") ?? "";

    let ssoUrl = "";
    doc.querySelectorAll("SingleSignOnService").forEach((svc) => {
      const binding = svc.getAttribute("Binding") ?? "";
      if (!ssoUrl && (binding.includes("HTTP-POST") || binding.includes("HTTP-Redirect"))) {
        ssoUrl = svc.getAttribute("Location") ?? "";
      }
    });

    const rawCert = doc.querySelector("X509Certificate")?.textContent?.trim() ?? "";
    const certificate = rawCert ? `-----BEGIN CERTIFICATE-----\n${rawCert}\n-----END CERTIFICATE-----` : "";

    if (!entityId && !ssoUrl && !certificate) return null;
    return { entity_id: entityId, sso_url: ssoUrl, certificate };
  } catch {
    return null;
  }
}

const SAML_PROXY_URL = import.meta.env.VITE_SAML_PROXY_URL ?? "";

export function SamlConfigPage() {
  const { user } = useAuthState();
  const [tab, setTab] = useState<Tab>("url");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<VerifiedMetadata | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleTestConnection() {
    if (!metadataUrl.trim()) {
      setUrlError("Enter a metadata URL first.");
      return;
    }
    setUrlError(null);
    setTestError(null);
    setResult(null);
    setTesting(true);
    try {
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
        setTestError(body.error ?? `Verification failed (HTTP ${response.status})`);
        return;
      }
      setResult(await response.json());
    } catch {
      setTestError("Could not reach the saml-proxy service.");
    } finally {
      setTesting(false);
    }
  }

  async function handleFileUpload(file: File) {
    setTestError(null);
    setResult(null);
    const xml = await file.text();
    const parsed = parseMetadataXmlClient(xml);
    if (!parsed) {
      setTestError("Could not parse this file as SAML metadata.");
      return;
    }
    setResult(parsed);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Configure SSO</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Connect a SAML identity provider. This pass verifies IdP metadata only — it does not
          complete a signature-validated login (v2 candidate) and does not cover SCIM/group
          provisioning (see TEN-183).
        </p>
      </div>

      <Segmented
        label="SAML setup method"
        value={tab}
        onChange={setTab}
        options={[
          { value: "url", label: "Metadata URL" },
          { value: "upload", label: "Upload XML" },
        ]}
      />

      {tab === "url" && (
        <div className="space-y-3 rounded-lg bg-card-2 p-4 ring-1 ring-line">
          <label htmlFor="metadata-url" className="text-sm font-medium text-ink">
            Metadata URL
          </label>
          <input
            id="metadata-url"
            type="text"
            value={metadataUrl}
            onChange={(e) => setMetadataUrl(e.target.value)}
            placeholder="https://your-idp.example.com/saml/metadata"
            className="focus-ring h-10 w-full rounded-lg bg-card px-3 text-sm text-ink ring-1 ring-line"
          />
          {urlError && <p className="text-xs text-danger">{urlError}</p>}
          <Button variant="primary" onClick={handleTestConnection} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
        </div>
      )}

      {tab === "upload" && (
        <div className="space-y-3 rounded-lg bg-card-2 p-4 ring-1 ring-line">
          <label htmlFor="metadata-file" className="text-sm font-medium text-ink">
            Upload IdP metadata XML
          </label>
          <input
            id="metadata-file"
            ref={fileInputRef}
            type="file"
            accept=".xml"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileUpload(file);
            }}
            className="block text-sm text-ink-muted"
          />
          <p className="text-xs text-ink-faint">
            Parsed entirely in your browser — the file never leaves this device.
          </p>
        </div>
      )}

      {testError && (
        <p role="alert" className="text-sm text-danger">
          {testError}
        </p>
      )}

      {result && (
        <div className="space-y-2 rounded-lg bg-card-2 p-4 ring-1 ring-line">
          <div className="flex items-center gap-2">
            <Badge tone="success">Verified</Badge>
            <span className="text-sm font-medium text-ink">Identity provider metadata</span>
          </div>
          <dl className="space-y-1 text-xs">
            <div>
              <dt className="text-ink-faint">Entity ID</dt>
              <dd className="break-all text-ink">{result.entity_id}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">SSO URL</dt>
              <dd className="break-all text-ink">{result.sso_url}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Certificate</dt>
              <dd className="break-all font-mono text-ink">
                {result.certificate.slice(0, 60)}…
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="space-y-2 rounded-lg bg-card-2 p-4 ring-1 ring-line">
        <h2 className="text-sm font-semibold text-ink">Service Provider values</h2>
        <p className="text-xs text-ink-muted">
          Enter these into your identity provider when creating the SAML application.
        </p>
        <dl className="space-y-1 text-xs">
          <div>
            <dt className="text-ink-faint">SP Entity ID</dt>
            <dd className="break-all text-ink">https://tenetx-mimic.web.app/saml/metadata</dd>
          </div>
          <div>
            <dt className="text-ink-faint">ACS URL</dt>
            <dd className="break-all text-ink">https://tenetx-mimic.web.app/saml/acs</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-3 rounded-lg bg-card-2 p-4 ring-1 ring-line text-xs text-ink-muted">
        <h2 className="text-sm font-semibold text-ink">Setup guidance</h2>
        <div>
          <p className="font-medium text-ink">Keycloak</p>
          <p>
            Open the realm you want to connect, then fetch its SAML descriptor at{" "}
            <code className="rounded bg-card px-1">
              /realms/&lt;realm&gt;/protocol/saml/descriptor
            </code>
            . No client is required to publish the realm-wide IdP metadata.
          </p>
        </div>
        <div>
          <p className="font-medium text-ink">Authentik</p>
          <p>
            Create a SAML Provider (plus a bound Application) and use its metadata download link,
            e.g. <code className="rounded bg-card px-1">/api/v3/providers/saml/&lt;id&gt;/metadata/?download</code>.
          </p>
        </div>
        <p>SAML setup only — SCIM/group provisioning is out of scope for this pass (TEN-183).</p>
      </div>
    </div>
  );
}
