/**
 * Single source of truth for the exact SAML field values a tester must enter
 * into Keycloak or Authentik to point their IdP at this mimic's ACS. Values
 * here are transcribed from (and must stay consistent with) the qa-logbook
 * runbooks — never duplicate/paraphrase these into other components; import
 * from here instead (see `TryItOutPage.tsx` and, potentially, future
 * doc-generation).
 *
 * Runbooks this file mirrors:
 * - qa-logbook/QA LogBook/knowledge-base/keycloak-tenetx-saml-sso-setup.md
 * - qa-logbook/QA LogBook/knowledge-base/authentik-tenetx-saml-sso-setup.md
 *
 * The runbooks were captured against a real `<sub>.tenetx.dev` / `.ai`
 * workspace's SP values. THIS wizard targets the mimic's own SP instead (so
 * the live-validating `/saml/acs` endpoint — see `tenetx-mimic-backend`'s
 * `/saml/acs` route — actually receives the response), so the SP-identity
 * fields (Client ID / Audience / ACS URL) below use the mimic's SP values,
 * already established in `SamlConfigPage.tsx`'s "Service Provider values"
 * card. Every OTHER field (NameID format, signing toggles, and both
 * gotchas) is transcribed byte-for-byte from the runbooks.
 *
 * SP identity = the backend's own real Coolify deployment domain
 * (`saml-proxy.195.35.23.198.sslip.io`, app `saml-proxy`), NOT the frontend's
 * `tenetx-mimic.web.app` Firebase Hosting domain — the backend stays on
 * Coolify, there is no Firebase Hosting rewrite proxying `/saml/**` to it, so
 * a `tenetx-mimic.web.app`-registered Keycloak client never matches what the
 * backend actually sends (confirmed: Keycloak 400s "invalid requester" on
 * every launch attempt while these constants pointed at the wrong domain).
 * `app/request_context.py`'s `derive_request_host`/`derive_request_scheme`
 * (X-Forwarded-Host/Proto-aware) already correctly resolve to this Coolify
 * domain when the backend is reached through its real Traefik-fronted URL —
 * no backend code change was needed, only these constants.
 *
 * Realm/application-name parametrization: the realm (Keycloak) / application
 * name (Authentik) is no longer hardcoded. Call `getIdpGuidance(idpType,
 * realm)` to interpolate the tester's chosen realm into the realm-dependent
 * fields (the first setup step's `value` and `launchLoginUrl`). `IDP_GUIDANCE`
 * stays exported as a fully-populated record built with `DEFAULT_REALM`
 * ("tenetx-mimic") baked in, so static consumers keep working unchanged.
 */

export type IdpType = "keycloak" | "authentik";

/** This mimic's own SP identity — must match `SamlConfigPage.tsx`, and must
 * match whatever is actually registered as the Keycloak client's Entity
 * ID/Redirect URI (the backend's real Coolify domain — see module docstring). */
export const MIMIC_SP_ENTITY_ID = "https://saml-proxy.195.35.23.198.sslip.io/saml/metadata";
export const MIMIC_ACS_URL = "https://saml-proxy.195.35.23.198.sslip.io/saml/acs";
/**
 * This mimic's own SAML Single-Logout Service (SLS) endpoint — where an IdP
 * POSTs its LogoutResponse back. Wired on the backend as `GET /saml/sls`
 * (see `tenetx-mimic-backend`, todo 8). Like the SP identity above, this is
 * the mimic's own fixed value and is never user-customizable.
 */
export const MIMIC_SLS_URL = "https://saml-proxy.195.35.23.198.sslip.io/saml/sls";

/**
 * The realm (Keycloak) / application name (Authentik) assumed when the tester
 * hasn't typed one yet. This was the value hardcoded throughout before
 * parametrization; it is now just the default passed to `getIdpGuidance`.
 */
export const DEFAULT_REALM = "tenetx-mimic";

export interface IdpFieldStep {
  /** The exact field/label name as it appears in the IdP's admin console. */
  field: string;
  /** The exact value to paste into that field. */
  value: string;
  /** Optional clarifying note (still sourced from the runbook). */
  note?: string;
}

export interface IdpGotcha {
  title: string;
  body: string;
}

/**
 * Where to point the IdP so it can reach this mimic's Single-Logout Service.
 * The `value` is always `MIMIC_SLS_URL` (the mimic's own fixed SLS endpoint);
 * `field` names the IdP-console field this URL belongs in.
 */
export interface IdpSlsGuidance {
  /** The exact field/label name in the IdP's admin console. */
  field: string;
  /** The value to paste — always the mimic's `MIMIC_SLS_URL`. */
  value: string;
  /** Optional clarifying note (e.g. IdP-side vs SP-side semantics). */
  note?: string;
}

export interface IdpGuidance {
  id: IdpType;
  label: string;
  /** Where in the IdP's admin console these steps live. */
  location: string;
  steps: IdpFieldStep[];
  gotcha: IdpGotcha;
  /** Repo-relative path to the runbook this guidance is sourced from. */
  runbookRef: string;
  /**
   * A real, working URL that starts this IdP's own login flow, so clicking
   * "Launch login" hands off to the IdP — never to any server this repo
   * runs. Built from the `realm` argument to `getIdpGuidance`, so it always
   * matches the realm/application name entered in the first step below.
   */
  launchLoginUrl: string;
  /**
   * Guidance for pointing this IdP at the mimic's SLS endpoint so real
   * Single-Logout round-trips (backend `/saml/sls`) reach this mimic.
   */
  slsGuidance: IdpSlsGuidance;
}

/**
 * Per-IdP builders. Each returns the FULL guidance object for a given
 * realm/application name; the realm-dependent fields (the first step's `value`
 * and `launchLoginUrl`) interpolate `realm`, everything else is static and
 * mirrors the runbooks byte-for-byte.
 */
const GUIDANCE_BUILDERS: Record<IdpType, (realm: string) => IdpGuidance> = {
  keycloak: (realm) => ({
    id: "keycloak",
    label: "Keycloak",
    location: "Clients → Create client (Client type: SAML)",
    steps: [
      {
        field: "Realm",
        value: realm,
        note: "Any realm name works — the Launch link below follows whatever you enter here (defaults to tenetx-mimic). Don't reuse the master realm.",
      },
      {
        field: "Client type",
        value: "SAML",
      },
      {
        field: "Client ID",
        value: MIMIC_SP_ENTITY_ID,
        note: "Must be the exact SP Entity ID, including the path — this is the audience TenetX validates.",
      },
      {
        field: "Valid redirect URIs",
        value: MIMIC_ACS_URL,
      },
      {
        field: "Master SAML Processing URL",
        value: MIMIC_ACS_URL,
      },
      {
        field: "Name ID format",
        value: "email",
      },
      {
        field: "Sign documents (saml.server.signature)",
        value: "On",
        note: "Keycloak default — leaves the signature + cert in the realm descriptor.",
      },
    ],
    gotcha: {
      title: "Client signature required must be Off",
      body:
        "On the client's Keys tab, disable \u201cClient signature required\u201d (confirm Yes). Keycloak defaults this On, which demands a signed AuthnRequest — but TenetX (and this mimic) sends an unsigned one, so Keycloak rejects the very first hop with \u201cWe are sorry\u2026 Invalid requester\u201d and the login form never renders.",
    },
    runbookRef: "qa-logbook/QA LogBook/knowledge-base/keycloak-tenetx-saml-sso-setup.md",
    launchLoginUrl: `https://keycloak.arifalidawood.com/realms/${realm}/account/`,
    slsGuidance: {
      field: "Logout Service POST Binding URL",
      value: MIMIC_SLS_URL,
    },
  }),
  authentik: (realm) => ({
    id: "authentik",
    label: "Authentik",
    location: "Applications → Providers → [your provider] → Edit → general settings",
    steps: [
      {
        field: "Application / Provider name",
        value: realm,
        note: "Any name works — the Launch link below follows whatever you enter here (defaults to tenetx-mimic).",
      },
      {
        field: "ACS URL",
        value: MIMIC_ACS_URL,
        note: "Must match this EXACTLY. Authentik compares it against the AuthnRequest's AssertionConsumerServiceURL and returns a 400 (Events → Logs shows configuration_error: \u201cACS URL … doesn't match Provider ACS URL\u201d) on any mismatch — e.g. if you use the tenetx-mimic.web.app frontend origin instead of this saml-proxy backend URL.",
      },
      {
        field: "Service Provider Binding",
        value: "Post",
        note: "MUST be Post, not Redirect. On Redirect, authentik sends the SAML Response as a DEFLATE-compressed GET redirect (…/saml/acs?SAMLResponse=…) even though the request asks for HTTP-POST — the POST-only ACS then returns 405 Method Not Allowed, or fails with \u201cInvalid SAML Response. Not match the saml-schema-protocol-2.0.xsd\u201d (compressed bytes aren't valid XML until inflated).",
      },
      {
        field: "Issuer",
        value: "authentik",
        note: "The IdP's OWN entity ID. Do NOT paste TenetX's SP Entity ID here.",
      },
      {
        field: "Audience",
        value: MIMIC_SP_ENTITY_ID,
        note: "This is the <AudienceRestriction> TenetX validates; leaving it blank causes rejection.",
      },
      {
        field: "Signing Certificate",
        value: "authentik Self-signed Certificate",
      },
      {
        field: "Sign response (sign_response)",
        value: "Enabled",
        note: "Required — TenetX needs the Response (message level) signed, not just the assertion. Without a signing keypair + Sign response, authentik's metadata has no <X509Certificate> and TenetX fails validation.",
      },
    ],
    gotcha: {
      title: "SP Entity ID goes in Audience, not Issuer",
      body:
        "The #1 mistake: pasting TenetX's SP Entity ID into authentik's Issuer field. Issuer must stay \u201cauthentik\u201d (the IdP's own identity); the SP Entity ID belongs in Audience — leaving Audience blank causes TenetX to reject the login.",
    },
    runbookRef: "qa-logbook/QA LogBook/knowledge-base/authentik-tenetx-saml-sso-setup.md",
    launchLoginUrl: `https://authentik.arifalidawood.com/application/launch/${realm}/`,
    slsGuidance: {
      field: "Single Logout (SLO) Endpoint / Binding",
      value: MIMIC_SLS_URL,
      note: "Authentik's SLO endpoint is configured IdP-side — this mimic SLS URL is where authentik POSTs its LogoutResponse back.",
    },
  }),
};

/**
 * Build the full IdP setup guidance for a given realm/application name.
 *
 * The realm-dependent fields — the first step's `value` (Keycloak "Realm" /
 * Authentik "Application / Provider name") and `launchLoginUrl` — are
 * interpolated from `realm`; every other field is static and mirrors the
 * runbooks. Pass `DEFAULT_REALM` for the pre-parametrization behavior
 * (identical to `IDP_GUIDANCE[idpType]`).
 */
export function getIdpGuidance(idpType: IdpType, realm: string): IdpGuidance {
  return GUIDANCE_BUILDERS[idpType](realm);
}

/**
 * Fully-populated guidance record with `DEFAULT_REALM` baked in. Kept exported
 * for backward compat with consumers that read guidance statically (today's
 * `TryItOutPage.tsx`); each entry equals `getIdpGuidance(id, DEFAULT_REALM)`.
 */
export const IDP_GUIDANCE: Record<IdpType, IdpGuidance> = {
  keycloak: getIdpGuidance("keycloak", DEFAULT_REALM),
  authentik: getIdpGuidance("authentik", DEFAULT_REALM),
};

export const IDP_ORDER: IdpType[] = ["keycloak", "authentik"];
