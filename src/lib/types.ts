/**
 * TenetX Mimic Feature Tracker
 * TypeScript schema for mimic_features collection in Firestore.
 */

import type { Tone } from "@/components/ui";

/* ── Feature Status Types & Maps ────────────────────────────────────────── */

export type FeatureStatus = "planned" | "in-progress" | "done";

export const STATUS_TONE: Record<FeatureStatus, Tone> = {
  planned: "neutral",
  "in-progress": "warning",
  done: "success",
};

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  planned: "Planned",
  "in-progress": "In progress",
  done: "Done",
};

export function isFeatureStatus(value: unknown): value is FeatureStatus {
  return value === "planned" || value === "in-progress" || value === "done";
}

/**
 * Narrower feature interface for dashboard display components.
 * Contains only the fields required by `FeatureRegistryList` and `StatCard`.
 * Structural subset of `MimicFeature` — use when the full interface is overkill.
 */
export interface DashboardFeatureSummary {
  id: string;
  ticketId: string;
  title: string;
  status: FeatureStatus;
  routePath: string;
}

/* ── MimicFeature Interface ─────────────────────────────────────────────── */

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

/* ── MCP Token & Tool Call Types ────────────────────────────────────────── */

/**
 * MCP authentication token document.
 * Firestore shape for mcp_tokens Postgres table.
 */
export interface McpToken {
  id: string; // Firestore document ID
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string; // ISO 8601 timestamp
  lastUsedAt: string | null; // ISO 8601 timestamp, null until first use
  revoked: boolean;
  createdAt: string; // ISO 8601 timestamp
}

/**
 * MCP tool call audit log document.
 * Firestore shape for mcp_tool_calls Postgres table.
 */
export interface McpToolCall {
  id: string; // Firestore document ID
  tool: string;
  client: string;
  statusCode: number;
  durationMs: number;
  tokenId: string | null; // Reference to McpToken id, null if unauthenticated
  requestSummary: string | null;
  createdAt: string; // ISO 8601 timestamp
}
