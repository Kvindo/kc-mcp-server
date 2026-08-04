const DEFAULT_API_URL = "https://cloud-api.kvindo.ru";

export interface Config {
  apiToken: string;
  apiUrl: string;
  allowWrite: boolean;
  allowDelete: boolean;
}

class ConfigError extends Error {}

function readBooleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(
    `${name} must be exactly "true" or "false" (got ${JSON.stringify(raw)}). Refusing to start rather than guess.`
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.KVINDO_API_TOKEN;
  if (!apiToken) {
    throw new ConfigError(
      "KVINDO_API_TOKEN is required. Generate a Personal Access Token in the Kvindo Cloud console " +
        "(IAM → Tokens → Create token) and set it as this environment variable."
    );
  }

  const apiUrl = env.KVINDO_API_URL || DEFAULT_API_URL;
  try {
    new URL(apiUrl);
  } catch {
    throw new ConfigError(`KVINDO_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`);
  }

  const allowWrite = readBooleanFlag(env, "KVINDO_MCP_ALLOW_WRITE");
  const allowDelete = readBooleanFlag(env, "KVINDO_MCP_ALLOW_DELETE");

  return { apiToken, apiUrl, allowWrite, allowDelete };
}

export { ConfigError };
