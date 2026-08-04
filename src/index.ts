#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { ApiClient, KvindoApiError } from "./api-client.js";
import { buildServer } from "./server.js";

/** A small, cheap, always-present, read-only type — used to prove the token is live before
 * any tool is registered, so a bad token fails fast and loud instead of surfacing as a
 * confusing first-tool-call error deep in a conversation. */
const STARTUP_CHECK_TYPE = "folder";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    process.stderr.write(`kc-mcp-server: startup failed: ${message}\n`);
    process.exit(1);
  }

  const api = new ApiClient(config.apiUrl, config.apiToken);

  try {
    await api.listResources(STARTUP_CHECK_TYPE, undefined, undefined, 1);
  } catch (err) {
    const message =
      err instanceof KvindoApiError
        ? `token check failed (${err.errorCode ?? `HTTP ${err.status}`}): ${err.message}`
        : String(err);
    process.stderr.write(
      `kc-mcp-server: startup failed: ${api.redact(message)}\n` +
        "If the token is invalid or expired, generate a new one in console IAM → Tokens.\n"
    );
    process.exit(1);
  }

  process.stderr.write(
    `kc-mcp-server: connected to ${config.apiUrl} ` +
      `(write=${config.allowWrite}, delete=${config.allowDelete})\n`
  );

  const server = buildServer({ api, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`kc-mcp-server: fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
