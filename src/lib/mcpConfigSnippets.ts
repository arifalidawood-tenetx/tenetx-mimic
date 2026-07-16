/**
 * Remote MCP Server config snippet generation (Task 6, working-mcp-pat).
 *
 * Pure, side-effect-free builders for the copy-paste config each supported
 * MCP client (Claude Code, OpenCode, Codex CLI) needs to connect to this
 * app's Streamable HTTP MCP endpoint. Kept separate from the React component
 * so the exact snippet shape can be unit-tested without rendering anything.
 *
 * SECURITY (non-negotiable):
 *  - The raw token value is NEVER inlined in `ConfigGeneratorSection`'s call path.
 *    Every snippet reachable from the persistent `ConfigGeneratorSection` component
 *    defaults to the environment-variable pattern for the Bearer token
 *    (`${MCP_TOKEN}` / `{env:MCP_TOKEN}` / `bearer_token_env_var`).
 *    This invariant holds unconditionally because no live token exists in that call path.
 *    ONE EXCEPTION: `NewTokenModal` intentionally calls these builders with the real
 *    just-issued secret during the one-time reveal; see `McpPage.tsx` module-level
 *    SECURITY comment for the modal's lifecycle.
 *  - `resolvePublicMcpUrl` flags non-`https://` URLs via `isSecure: false` so
 *    the caller can render an unmissable warning instead of silently
 *    emitting an insecure snippet.
 */

/** Name of the environment variable every snippet expects the user to set. */
export const MCP_ENV_VAR_NAME = 'TENETX_MIMIC_MCP_TOKEN';

/**
 * Confirmed Streamable HTTP endpoint path (Task 6 of working-mcp-pat):
 * the app mounts the MCP app at `/mcp`, and fastmcp's Streamable HTTP
 * transport serves at `/` under that mount, giving `/mcp`.
 */
export const MCP_ENDPOINT_PATH = '/mcp';

export type McpClientId = 'claude-code' | 'opencode' | 'codex' | 'general';

export interface McpClientDefinition {
  id: McpClientId;
  label: string;
  fileName: string;
  language: 'json' | 'toml';
  buildSnippet: (url: string) => string;
}

/** Separate from `McpClientDefinition` (not an intersection): `general` has no configFile, `opencode` has no install command, so both are optional. */
export interface InstallCommandClient {
  id: McpClientId;
  label: string;
  hasCliInstallCommand: boolean;
  buildInstallCommand?: (url: string, token: string) => string;
  configFile?: { fileName: string; language: 'json' | 'toml'; buildSnippet: (url: string) => string };
}

/**
 * Resolve the public MCP URL from the frontend's configured base URL.
 *
 * Base URL comes from `VITE_SAML_PROXY_URL` (same as SamlConfigPage.tsx:80).
 * If base is empty, returns `{url:"", isSecure:false}` so the UI can show
 * a config-missing warning instead of emitting an invalid snippet.
 *
 * There is no dedicated "public MCP URL" backend setting today — this derives
 * it from the existing base-URL config plus the confirmed Streamable HTTP
 * endpoint path. Documented as a reasonable v1 approach; a dedicated
 * backend setting can replace this derivation later without changing the
 * snippet shapes.
 */
export function resolvePublicMcpUrl(baseUrl: string): { url: string; isSecure: boolean } {
  if (!baseUrl) {
    return { url: '', isSecure: false };
  }
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const url = `${trimmedBase}${MCP_ENDPOINT_PATH}`;
  return { url, isSecure: url.startsWith('https://') };
}

/** Claude Code — `.mcp.json`, `"type": "http"`, Bearer header via env-var interpolation. */
export function buildClaudeCodeSnippet(url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'tenetx-mimic': {
          type: 'http',
          url,
          headers: { Authorization: `Bearer \${${MCP_ENV_VAR_NAME}}` },
        },
      },
    },
    null,
    2
  );
}

/** OpenCode — `opencode.json`, `"type": "remote"`, `oauth: false`, `{env:...}` interpolation. */
export function buildOpenCodeSnippet(url: string): string {
  return JSON.stringify(
    {
      mcp: {
        'tenetx-mimic': {
          type: 'remote',
          url,
          enabled: true,
          oauth: false,
          headers: { Authorization: `Bearer {env:${MCP_ENV_VAR_NAME}}` },
        },
      },
    },
    null,
    2
  );
}

/** Codex CLI — `config.toml`, `[mcp_servers.tenetx-mimic]`, `bearer_token_env_var`. */
export function buildCodexSnippet(url: string): string {
  return [
    '[mcp_servers.tenetx-mimic]',
    `url = "${url}"`,
    `bearer_token_env_var = "${MCP_ENV_VAR_NAME}"`,
    '',
  ].join('\n');
}

/** Claude Code — `claude mcp add` CLI command; `token` is caller-supplied (real or placeholder). */
export function buildClaudeCodeInstallCommand(url: string, token: string): string {
  return `claude mcp add --transport http tenetx-mimic ${url} --header "Authorization: Bearer ${token}"`;
}

/** Codex CLI — `codex mcp add`; CLI takes only an env-var NAME, so the token is exported first. */
export function buildCodexInstallCommand(url: string, token: string): string {
  return [
    `export ${MCP_ENV_VAR_NAME}="${token}"`,
    `codex mcp add tenetx-mimic --url ${url} --bearer-token-env-var ${MCP_ENV_VAR_NAME}`,
  ].join('\n');
}

/** General / Other — `mcp-remote` bridge; `${AUTH_HEADER}` is emitted literally (escaped) for the real shell to substitute, not this builder. */
export function buildGeneralInstallCommand(url: string, token: string): string {
  return [
    `export AUTH_HEADER="Bearer ${token}"`,
    `npx -y mcp-remote@latest ${url} --header "Authorization:\${AUTH_HEADER}"`,
  ].join('\n');
}

/** Ordered list driving the segmented client-picker UI. */
export const MCP_CLIENTS: McpClientDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    fileName: '.mcp.json',
    language: 'json',
    buildSnippet: buildClaudeCodeSnippet,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    fileName: 'opencode.json',
    language: 'json',
    buildSnippet: buildOpenCodeSnippet,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    fileName: 'config.toml',
    language: 'toml',
    buildSnippet: buildCodexSnippet,
  },
];

/** Human-readable placeholder passed as the token wherever no real secret is available. */
export const INSTALL_COMMAND_PLACEHOLDER_TOKEN = '<your-token-here>';

/** Ordered list driving the 4-client install-command / config picker UI. */
export const INSTALL_COMMAND_CLIENTS: InstallCommandClient[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hasCliInstallCommand: true,
    buildInstallCommand: buildClaudeCodeInstallCommand,
    configFile: { fileName: '.mcp.json', language: 'json', buildSnippet: buildClaudeCodeSnippet },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    hasCliInstallCommand: false,
    buildInstallCommand: undefined,
    configFile: { fileName: 'opencode.json', language: 'json', buildSnippet: buildOpenCodeSnippet },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    hasCliInstallCommand: true,
    buildInstallCommand: buildCodexInstallCommand,
    configFile: { fileName: 'config.toml', language: 'toml', buildSnippet: buildCodexSnippet },
  },
  {
    id: 'general',
    label: 'General / Other',
    hasCliInstallCommand: true,
    buildInstallCommand: buildGeneralInstallCommand,
    configFile: undefined,
  },
];
