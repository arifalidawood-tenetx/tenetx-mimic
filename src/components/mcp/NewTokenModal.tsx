import { useState } from "react";
import { Button, Segmented } from "@/components/ui";
import { useToast } from "@/components/shell/Toast";
import {
  buildClaudeCodeInstallCommand,
  buildCodexInstallCommand,
  buildGeneralInstallCommand,
} from "@/lib/mcpConfigSnippets";

export interface NewTokenModalProps {
  /** The real, just-issued plaintext token. Never persisted — this is the ONLY place it is ever rendered. */
  token: string;
  /** Resolved public MCP URL. Empty string when `VITE_SAML_PROXY_URL` is unconfigured. */
  mcpUrl: string;
  /** Discards the token from parent state, closing the modal. There is no way back in — regenerate for a new one. */
  onDone: () => void;
}

type QuickClient = "claude-code" | "codex" | "general";

const BUILDERS: Record<QuickClient, (url: string, token: string) => string> = {
  "claude-code": buildClaudeCodeInstallCommand,
  codex: buildCodexInstallCommand,
  general: buildGeneralInstallCommand,
};

/**
 * One-time reveal modal (Task 7, `working-mcp-pat` security invariant).
 *
 * SECURITY: this is the ONE place in the app where the real plaintext PAT is
 * ever rendered or interpolated into a command. `ConfigGeneratorSection`
 * never sees it. Clicking "Done" discards it from parent state — there is no
 * way to see it again without generating a new token, matching the
 * `createToken()`/`mcpTokens.ts` invariant that the hash-only Firestore
 * record can never reproduce the plaintext.
 */
export function NewTokenModal({ token, mcpUrl, onDone }: NewTokenModalProps) {
  const { addToast } = useToast();
  const [client, setClient] = useState<QuickClient>("claude-code");

  const installCommand = mcpUrl ? BUILDERS[client](mcpUrl, token) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New MCP token"
        className="animate-scale-in relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-card shadow-lg"
      >
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Token generated</h2>
          <p className="mt-1 text-xs font-medium text-warning">
            Copy this token now — you won&apos;t see it again.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-card-2 px-3 py-2 font-mono text-xs text-ink ring-1 ring-line">
              {token}
            </code>
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(token);
                addToast("Copied to clipboard.", "info");
              }}
            >
              Copy
            </Button>
          </div>

          {installCommand && (
            <div>
              <p className="mb-2 text-xs text-ink-muted">Quick install (real token embedded):</p>
              <Segmented
                label="Quick install client"
                size="sm"
                value={client}
                onChange={setClient}
                options={[
                  { value: "claude-code", label: "Claude Code" },
                  { value: "codex", label: "Codex CLI" },
                  { value: "general", label: "General" },
                ]}
              />
              <div className="mt-2 overflow-hidden rounded-lg bg-card-2 ring-1 ring-line">
                <pre className="max-h-40 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
                  {installCommand}
                </pre>
              </div>
              <Button
                type="button"
                variant="subtle"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void navigator.clipboard?.writeText(installCommand);
                  addToast("Copied to clipboard.", "info");
                }}
              >
                Copy command
              </Button>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button type="button" variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
