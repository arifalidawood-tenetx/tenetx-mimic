import { describe, it, expect } from 'vitest';
import {
  MCP_ENV_VAR_NAME,
  MCP_ENDPOINT_PATH,
  resolvePublicMcpUrl,
  buildClaudeCodeSnippet,
  buildOpenCodeSnippet,
  buildCodexSnippet,
  buildClaudeCodeInstallCommand,
  buildCodexInstallCommand,
  buildGeneralInstallCommand,
  INSTALL_COMMAND_PLACEHOLDER_TOKEN,
  MCP_CLIENTS,
  INSTALL_COMMAND_CLIENTS,
} from './mcpConfigSnippets';

describe('mcpConfigSnippets', () => {
  describe('constants', () => {
    it('MCP_ENV_VAR_NAME is TENETX_MIMIC_MCP_TOKEN', () => {
      expect(MCP_ENV_VAR_NAME).toBe('TENETX_MIMIC_MCP_TOKEN');
    });

    it('MCP_ENDPOINT_PATH is /mcp (never /mcp/mcp)', () => {
      expect(MCP_ENDPOINT_PATH).toBe('/mcp');
      expect(MCP_ENDPOINT_PATH).not.toBe('/mcp/mcp');
    });
  });

  describe('resolvePublicMcpUrl', () => {
    it('returns empty url and isSecure false when base is empty', () => {
      const result = resolvePublicMcpUrl('');
      expect(result).toEqual({ url: '', isSecure: false });
    });

    it('appends /mcp to https base', () => {
      const result = resolvePublicMcpUrl('https://api.example.com');
      expect(result).toEqual({ url: 'https://api.example.com/mcp', isSecure: true });
    });

    it('appends /mcp to http base', () => {
      const result = resolvePublicMcpUrl('http://localhost:8000');
      expect(result).toEqual({ url: 'http://localhost:8000/mcp', isSecure: false });
    });

    it('strips trailing slashes before appending /mcp', () => {
      const result = resolvePublicMcpUrl('https://api.example.com/');
      expect(result).toEqual({ url: 'https://api.example.com/mcp', isSecure: true });
    });

    it('strips multiple trailing slashes', () => {
      const result = resolvePublicMcpUrl('https://api.example.com///');
      expect(result).toEqual({ url: 'https://api.example.com/mcp', isSecure: true });
    });

    it('appends /mcp to base without /mcp suffix', () => {
      const result = resolvePublicMcpUrl('https://api.example.com');
      expect(result.url).toBe('https://api.example.com/mcp');
    });
  });

  describe('buildClaudeCodeSnippet', () => {
    it('produces valid JSON with tenetx-mimic server name', () => {
      const snippet = buildClaudeCodeSnippet('https://api.example.com/mcp');
      const parsed = JSON.parse(snippet);
      expect(parsed.mcpServers).toHaveProperty('tenetx-mimic');
    });

    it('contains /mcp path', () => {
      const snippet = buildClaudeCodeSnippet('https://api.example.com/mcp');
      expect(snippet).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const snippet = buildClaudeCodeSnippet('https://api.example.com/mcp');
      expect(snippet).not.toContain('/mcp/mcp');
    });

    it('uses env var interpolation for Bearer token', () => {
      const snippet = buildClaudeCodeSnippet('https://api.example.com/mcp');
      expect(snippet).toContain(`Bearer \${${MCP_ENV_VAR_NAME}}`);
    });

    it('sets type to http', () => {
      const snippet = buildClaudeCodeSnippet('https://api.example.com/mcp');
      const parsed = JSON.parse(snippet);
      expect(parsed.mcpServers['tenetx-mimic'].type).toBe('http');
    });
  });

  describe('buildOpenCodeSnippet', () => {
    it('produces valid JSON with tenetx-mimic server name', () => {
      const snippet = buildOpenCodeSnippet('https://api.example.com/mcp');
      const parsed = JSON.parse(snippet);
      expect(parsed.mcp).toHaveProperty('tenetx-mimic');
    });

    it('contains /mcp path', () => {
      const snippet = buildOpenCodeSnippet('https://api.example.com/mcp');
      expect(snippet).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const snippet = buildOpenCodeSnippet('https://api.example.com/mcp');
      expect(snippet).not.toContain('/mcp/mcp');
    });

    it('uses env var interpolation with {env:...} syntax', () => {
      const snippet = buildOpenCodeSnippet('https://api.example.com/mcp');
      expect(snippet).toContain(`Bearer {env:${MCP_ENV_VAR_NAME}}`);
    });

    it('sets type to remote and oauth to false', () => {
      const snippet = buildOpenCodeSnippet('https://api.example.com/mcp');
      const parsed = JSON.parse(snippet);
      expect(parsed.mcp['tenetx-mimic'].type).toBe('remote');
      expect(parsed.mcp['tenetx-mimic'].oauth).toBe(false);
    });
  });

  describe('buildCodexSnippet', () => {
    it('produces TOML format', () => {
      const snippet = buildCodexSnippet('https://api.example.com/mcp');
      expect(snippet).toContain('[mcp_servers.tenetx-mimic]');
    });

    it('contains /mcp path', () => {
      const snippet = buildCodexSnippet('https://api.example.com/mcp');
      expect(snippet).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const snippet = buildCodexSnippet('https://api.example.com/mcp');
      expect(snippet).not.toContain('/mcp/mcp');
    });

    it('uses bearer_token_env_var', () => {
      const snippet = buildCodexSnippet('https://api.example.com/mcp');
      expect(snippet).toContain(`bearer_token_env_var = "${MCP_ENV_VAR_NAME}"`);
    });
  });

  describe('buildClaudeCodeInstallCommand', () => {
    it('contains /mcp path', () => {
      const cmd = buildClaudeCodeInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const cmd = buildClaudeCodeInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).not.toContain('/mcp/mcp');
    });

    it('includes tenetx-mimic server name', () => {
      const cmd = buildClaudeCodeInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('tenetx-mimic');
    });

    it('includes the provided token', () => {
      const cmd = buildClaudeCodeInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('token123');
    });
  });

  describe('buildCodexInstallCommand', () => {
    it('contains /mcp path', () => {
      const cmd = buildCodexInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const cmd = buildCodexInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).not.toContain('/mcp/mcp');
    });

    it('includes tenetx-mimic server name', () => {
      const cmd = buildCodexInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('tenetx-mimic');
    });

    it('exports env var with token', () => {
      const cmd = buildCodexInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain(`export ${MCP_ENV_VAR_NAME}="token123"`);
    });
  });

  describe('buildGeneralInstallCommand', () => {
    it('contains /mcp path', () => {
      const cmd = buildGeneralInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('/mcp');
    });

    it('never contains /mcp/mcp', () => {
      const cmd = buildGeneralInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).not.toContain('/mcp/mcp');
    });

    it('includes the provided token', () => {
      const cmd = buildGeneralInstallCommand('https://api.example.com/mcp', 'token123');
      expect(cmd).toContain('token123');
    });
  });

  describe('MCP_CLIENTS list', () => {
    it('contains exactly 3 clients', () => {
      expect(MCP_CLIENTS).toHaveLength(3);
    });

    it('all snippets contain /mcp and never /mcp/mcp', () => {
      const testUrl = 'https://api.example.com/mcp';
      MCP_CLIENTS.forEach((client) => {
        const snippet = client.buildSnippet(testUrl);
        expect(snippet).toContain('/mcp');
        expect(snippet).not.toContain('/mcp/mcp');
      });
    });
  });

  describe('INSTALL_COMMAND_CLIENTS list', () => {
    it('contains exactly 4 clients', () => {
      expect(INSTALL_COMMAND_CLIENTS).toHaveLength(4);
    });

    it('all config file snippets contain /mcp and never /mcp/mcp', () => {
      const testUrl = 'https://api.example.com/mcp';
      INSTALL_COMMAND_CLIENTS.forEach((client) => {
        if (client.configFile) {
          const snippet = client.configFile.buildSnippet(testUrl);
          expect(snippet).toContain('/mcp');
          expect(snippet).not.toContain('/mcp/mcp');
        }
      });
    });

    it('all install commands contain /mcp and never /mcp/mcp', () => {
      const testUrl = 'https://api.example.com/mcp';
      INSTALL_COMMAND_CLIENTS.forEach((client) => {
        if (client.buildInstallCommand) {
          const cmd = client.buildInstallCommand(testUrl, 'token123');
          expect(cmd).toContain('/mcp');
          expect(cmd).not.toContain('/mcp/mcp');
        }
      });
    });
  });

  describe('placeholder token', () => {
    it('is defined and non-empty', () => {
      expect(INSTALL_COMMAND_PLACEHOLDER_TOKEN).toBeTruthy();
    });
  });
});
