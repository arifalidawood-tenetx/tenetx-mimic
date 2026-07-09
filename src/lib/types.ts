/**
 * TenetX Mimic Feature Tracker
 * TypeScript schema for mimic_features collection in Firestore.
 */

export interface MimicFeature {
  id: string;
  ticketId: string;
  relatedTickets: string[];
  featureSlug: string;
  attemptNumber: number;
  title: string;
  description: string;
  idpType?: "keycloak" | "authentik" | "both";
  status: "planned" | "in-progress" | "done";
  routePath: string;
  idpConnectionRef?: string;
  evidenceRef?: string;
  notes?: string;
  jiraUrl: string;
  sourceRefs: string[];
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
  rootCause?: string; // root-cause classification writeup
  diffSummary?: string; // short summary of the diff/fix applied
  solutionMarkdown?: string; // rendered raw (no markdown renderer), copy-to-clipboard
}
