import { useState } from "react";
import { Icon } from "@/components/icons";
import { Button, Segmented } from "@/components/ui";
import { useToast } from "@/components/shell/Toast";
import {
  INSTALL_COMMAND_CLIENTS,
  INSTALL_COMMAND_PLACEHOLDER_TOKEN,
  type McpClientId,
} from "@/lib/mcpConfigSnippets";

export interface ConfigGeneratorSectionProps {
  /** Resolved public MCP URL (`resolvePublicMcpUrl` output), e.g. `https://api.example.com/mcp`. Empty string when unconfigured. */
  mcpUrl: string;
  /** `false` for any non-`https://` URL — renders an insecure-URL warning instead of hiding the snippet. */
  isSecure: boolean;
}

/**
 * Persistent config-generator section (Task 7): always safe to leave
 * rendered on the page. Every snippet here uses the environment-variable
 * Bearer-token pattern (config files) or the placeholder token (install
 * commands) — the real just-issued secret only ever appears in
 * `NewTokenModal`'s one-time reveal, never here.
 */
export function ConfigGeneratorSection({ mcpUrl, isSecure }: ConfigGeneratorSectionProps) {
  const [client, setClient] = useState<McpClientId>("claude-code");
  const active = INSTALL_COMMAND_CLIENTS.find((c) => c.id === client) ?? INSTALL_COMMAND_CLIENTS[0];

  if (!mcpUrl) {
    return (
      <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm">
        <div className="flex items-start gap-3">
          <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            <h2 className="text-sm font-semibold text-ink">MCP base URL not configured</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Set <code className="rounded bg-card px-1">VITE_SAML_PROXY_URL</code> to generate
              working config snippets.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!isSecure && (
        <div className="rounded-xl bg-danger-soft p-4 ring-1 ring-danger/30">
          <div className="flex items-start gap-3">
            <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <p className="text-sm text-danger">
              This MCP URL is not served over HTTPS. Bearer tokens sent to it are not encrypted
              in transit.
            </p>
          </div>
        </div>
      )}

      <Segmented
        label="MCP client"
        value={client}
        onChange={setClient}
        options={INSTALL_COMMAND_CLIENTS.map((c) => ({ value: c.id, label: c.label }))}
      />

      {active.configFile && (
        <CopyBlock
          title={`Config file — ${active.configFile.fileName}`}
          subtitle={`Set ${"TENETX_MIMIC_MCP_TOKEN"} in your shell/agent env before use`}
          code={active.configFile.buildSnippet(mcpUrl)}
        />
      )}

      {active.buildInstallCommand && (
        <CopyBlock
          title="Install command"
          subtitle="Placeholder token shown — swap in your real PAT before running"
          code={active.buildInstallCommand(mcpUrl, INSTALL_COMMAND_PLACEHOLDER_TOKEN)}
        />
      )}
    </div>
  );
}

function CopyBlock({ title, subtitle, code }: { title: string; subtitle: string; code: string }) {
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl bg-card-2 ring-1 ring-line shadow-sm">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="text-[11px] text-ink-faint">{subtitle}</p>
        </div>
        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            addToast("Copied to clipboard.", "info");
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto bg-card p-4 font-mono text-[12px] leading-relaxed text-ink-muted">
        {code}
      </pre>
    </div>
  );
}
