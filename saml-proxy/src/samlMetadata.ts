import { XMLParser } from 'fast-xml-parser';

export interface SamlMetadataResult {
  entity_id: string;
  sso_url: string;
  certificate: string;
}

export const ALLOWED_METADATA_HOSTS = new Set([
  'keycloak.arifalidawood.com',
  'authentik.arifalidawood.com',
]);

export function isAllowedMetadataHost(hostname: string): boolean {
  return ALLOWED_METADATA_HOSTS.has(hostname);
}

// removeNSPrefix strips the md:/ds: namespace prefixes Keycloak and Authentik
// both emit, so lookups below can match by local name only (DOMParser/querySelector
// aren't available in Node, so this walks the parsed object tree instead).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function findAll(node: unknown, tagName: string, results: any[] = []): any[] {
  if (node === null || typeof node !== 'object') return results;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === tagName) {
      results.push(...asArray(value as any));
    }
    for (const item of asArray(value as any)) {
      findAll(item, tagName, results);
    }
  }
  return results;
}

export function parseSamlMetadata(xml: string): SamlMetadataResult | null {
  if (!xml || !xml.trim()) return null;

  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  const descriptor = findAll(doc, 'EntityDescriptor')[0];
  const entityId = descriptor?.['@_entityID'] ?? '';

  let ssoUrl = '';
  for (const svc of findAll(doc, 'SingleSignOnService')) {
    const binding = svc?.['@_Binding'] ?? '';
    if (binding.includes('HTTP-POST') || binding.includes('HTTP-Redirect')) {
      ssoUrl = svc?.['@_Location'] ?? '';
      if (ssoUrl) break;
    }
  }

  const certNode = findAll(doc, 'X509Certificate')[0];
  const rawCert = (typeof certNode === 'string' ? certNode : certNode?.['#text'] ?? '')
    .toString()
    .trim();
  const certificate = rawCert ? `-----BEGIN CERTIFICATE-----\n${rawCert}\n-----END CERTIFICATE-----` : '';

  if (!entityId && !ssoUrl && !certificate) return null;

  return { entity_id: entityId, sso_url: ssoUrl, certificate };
}
