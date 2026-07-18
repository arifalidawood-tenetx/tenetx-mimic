import { describe, it, expect } from "vitest";
import {
  getIdpGuidance,
  IDP_GUIDANCE,
  IDP_ORDER,
  DEFAULT_REALM,
  MIMIC_SLS_URL,
  MIMIC_SP_ENTITY_ID,
  MIMIC_ACS_URL,
  type IdpType,
} from "./idpSetupGuidance";

/** The realm/app-name step is index 0 for both IdPs (see GUIDANCE_BUILDERS). */
function realmStepValue(idpType: IdpType, realm: string): string {
  const step = getIdpGuidance(idpType, realm).steps.find((s) =>
    idpType === "keycloak" ? s.field === "Realm" : s.field === "Application / Provider name",
  );
  if (!step) throw new Error(`no realm step for ${idpType}`);
  return step.value;
}

describe("getIdpGuidance — realm/app-name interpolation", () => {
  it("interpolates a custom realm into Keycloak's Realm step + launch URL", () => {
    const g = getIdpGuidance("keycloak", "my-custom-realm");
    expect(realmStepValue("keycloak", "my-custom-realm")).toBe("my-custom-realm");
    expect(g.launchLoginUrl).toBe(
      "https://keycloak.arifalidawood.com/realms/my-custom-realm/account/",
    );
  });

  it("interpolates a custom app name into Authentik's name step + launch URL", () => {
    const g = getIdpGuidance("authentik", "my-custom-realm");
    expect(realmStepValue("authentik", "my-custom-realm")).toBe("my-custom-realm");
    expect(g.launchLoginUrl).toBe(
      "https://authentik.arifalidawood.com/application/launch/my-custom-realm/",
    );
  });

  it("leaves the SP-identity fields untouched regardless of realm", () => {
    const g = getIdpGuidance("keycloak", "anything-goes");
    // Realm parametrization must NOT bleed into the mimic's fixed SP identity.
    expect(g.steps.find((s) => s.field === "Client ID")?.value).toBe(MIMIC_SP_ENTITY_ID);
    expect(g.steps.find((s) => s.field === "Valid redirect URIs")?.value).toBe(MIMIC_ACS_URL);
    expect(MIMIC_SP_ENTITY_ID).toBe("https://saml-proxy.195.35.23.198.sslip.io/saml/metadata");
    expect(MIMIC_ACS_URL).toBe("https://saml-proxy.195.35.23.198.sslip.io/saml/acs");
  });
});

describe("getIdpGuidance — default-case regression (zero drift for tenetx-mimic)", () => {
  it("DEFAULT_REALM is the historical hardcoded value", () => {
    expect(DEFAULT_REALM).toBe("tenetx-mimic");
  });

  it("Keycloak default output reproduces the exported IDP_GUIDANCE record", () => {
    expect(getIdpGuidance("keycloak", DEFAULT_REALM)).toEqual(IDP_GUIDANCE.keycloak);
  });

  it("Authentik default output reproduces the exported IDP_GUIDANCE record", () => {
    expect(getIdpGuidance("authentik", DEFAULT_REALM)).toEqual(IDP_GUIDANCE.authentik);
  });

  it("Keycloak default keeps the exact pre-parametrization realm value + launch URL", () => {
    expect(realmStepValue("keycloak", DEFAULT_REALM)).toBe("tenetx-mimic");
    expect(IDP_GUIDANCE.keycloak.launchLoginUrl).toBe(
      "https://keycloak.arifalidawood.com/realms/tenetx-mimic/account/",
    );
  });

  it("Authentik default keeps the exact pre-parametrization name value + launch URL", () => {
    expect(realmStepValue("authentik", DEFAULT_REALM)).toBe("tenetx-mimic");
    expect(IDP_GUIDANCE.authentik.launchLoginUrl).toBe(
      "https://authentik.arifalidawood.com/application/launch/tenetx-mimic/",
    );
  });

  it("keeps IDP_ORDER + gotcha titles + step counts unchanged", () => {
    expect(IDP_ORDER).toEqual(["keycloak", "authentik"]);
    expect(IDP_GUIDANCE.keycloak.gotcha.title).toBe("Client signature required must be Off");
    expect(IDP_GUIDANCE.authentik.gotcha.title).toBe(
      "SP Entity ID goes in Audience, not Issuer",
    );
    expect(IDP_GUIDANCE.keycloak.steps).toHaveLength(7);
    expect(IDP_GUIDANCE.authentik.steps).toHaveLength(7);
  });
});

describe("getIdpGuidance — SLS guidance field", () => {
  it("exposes MIMIC_SLS_URL as the mimic's fixed SLS endpoint", () => {
    expect(MIMIC_SLS_URL).toBe("https://saml-proxy.195.35.23.198.sslip.io/saml/sls");
  });

  it("Keycloak slsGuidance points at MIMIC_SLS_URL with the POST-binding field", () => {
    const { slsGuidance } = getIdpGuidance("keycloak", "irrelevant-realm");
    expect(slsGuidance.field).toBe("Logout Service POST Binding URL");
    expect(slsGuidance.value).toBe(MIMIC_SLS_URL);
  });

  it("Authentik slsGuidance points at MIMIC_SLS_URL and notes the IdP-side endpoint", () => {
    const { slsGuidance } = getIdpGuidance("authentik", "irrelevant-realm");
    expect(slsGuidance.field).toBe("Single Logout (SLO) Endpoint / Binding");
    expect(slsGuidance.value).toBe(MIMIC_SLS_URL);
    expect(slsGuidance.note).toBeTruthy();
    expect(slsGuidance.note).toMatch(/IdP-side/i);
  });

  it("slsGuidance value is realm-independent (mimic's own fixed endpoint)", () => {
    expect(getIdpGuidance("keycloak", "realm-a").slsGuidance.value).toBe(
      getIdpGuidance("keycloak", "realm-b").slsGuidance.value,
    );
  });
});
