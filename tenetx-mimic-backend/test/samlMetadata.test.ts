import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSamlMetadata, isAllowedMetadataHost } from '../src/samlMetadata';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('parseSamlMetadata', () => {
  it('parses the Keycloak realm descriptor fixture', () => {
    const result = parseSamlMetadata(fixture('keycloak-metadata.xml'));
    expect(result).not.toBeNull();
    expect(result!.entity_id).toContain('tenetx-mimic');
    expect(result!.sso_url).toMatch(/^https:\/\//);
    expect(result!.slo_url).toMatch(/^https:\/\//);
    expect(result!.slo_url).toContain('tenetx-mimic');
    expect(result!.certificate).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(result!.certificate).toContain('-----END CERTIFICATE-----');
  });

  it('parses the Authentik SAML Provider metadata fixture', () => {
    const result = parseSamlMetadata(fixture('authentik-metadata.xml'));
    expect(result).not.toBeNull();
    expect(result!.entity_id).toMatch(/^https:\/\/authentik\.arifalidawood\.com/);
    expect(result!.sso_url).toContain('tenetx-mimic');
    expect(result!.slo_url).toBe('');
    expect(result!.certificate).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
  });

  it('returns null for empty input', () => {
    expect(parseSamlMetadata('')).toBeNull();
    expect(parseSamlMetadata('   ')).toBeNull();
  });

  it('returns null for malformed XML with no recognizable SAML fields', () => {
    expect(parseSamlMetadata('<not><valid</not>')).toBeNull();
    expect(parseSamlMetadata('<html><body>not saml</body></html>')).toBeNull();
  });

  it('populates slo_url from SingleLogoutService, preferring HTTP-Redirect over HTTP-POST regardless of document order', () => {
    const xml = `<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/slo/post"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/slo/redirect"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
    const result = parseSamlMetadata(xml);
    expect(result).not.toBeNull();
    expect(result!.slo_url).toBe('https://idp.example/slo/redirect');
  });

  it('falls back to the HTTP-POST SingleLogoutService when no HTTP-Redirect binding is present', () => {
    const xml = `<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/slo/post"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
    const result = parseSamlMetadata(xml);
    expect(result).not.toBeNull();
    expect(result!.slo_url).toBe('https://idp.example/slo/post');
  });

  it('sets slo_url to "" when no SingleLogoutService element is present', () => {
    const xml = `<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
    const result = parseSamlMetadata(xml);
    expect(result).not.toBeNull();
    expect(result!.slo_url).toBe('');
  });
});

describe('isAllowedMetadataHost', () => {
  it('allows the two known IdP hosts', () => {
    expect(isAllowedMetadataHost('keycloak.arifalidawood.com')).toBe(true);
    expect(isAllowedMetadataHost('authentik.arifalidawood.com')).toBe(true);
  });

  it('rejects any other host (SSRF guard)', () => {
    expect(isAllowedMetadataHost('evil.example.com')).toBe(false);
    expect(isAllowedMetadataHost('169.254.169.254')).toBe(false);
  });
});
