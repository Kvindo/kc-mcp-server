import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../../src/config.js";

const baseEnv = { KVINDO_API_TOKEN: "test-token" };

describe("loadConfig", () => {
  it("throws when the token is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("defaults apiUrl and both write/delete gates to off", () => {
    const config = loadConfig(baseEnv);
    expect(config.apiUrl).toBe("https://cloud-api.kvindo.ru");
    expect(config.allowWrite).toBe(false);
    expect(config.allowDelete).toBe(false);
  });

  it("rejects a malformed apiUrl", () => {
    expect(() => loadConfig({ ...baseEnv, KVINDO_API_URL: "not-a-url" })).toThrow(ConfigError);
  });

  it("accepts exactly \"true\"/\"false\" for the write/delete gates", () => {
    const config = loadConfig({
      ...baseEnv,
      KVINDO_MCP_ALLOW_WRITE: "true",
      KVINDO_MCP_ALLOW_DELETE: "false",
    });
    expect(config.allowWrite).toBe(true);
    expect(config.allowDelete).toBe(false);
  });

  it("refuses to start on a malformed boolean rather than silently falling back", () => {
    expect(() => loadConfig({ ...baseEnv, KVINDO_MCP_ALLOW_WRITE: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, KVINDO_MCP_ALLOW_DELETE: "1" })).toThrow(ConfigError);
  });
});
