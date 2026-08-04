# kc-mcp-server

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for [Kvindo Cloud](https://cloud.kvindo.com) — lets any MCP-compatible AI client (Claude Desktop, Claude Code, etc.) list, inspect, create, update, and delete your Kvindo Cloud resources (VMs, Volumes, S3 buckets, Kubernetes, Load Balancers, VPNs, PostgreSQL, and more) conversationally.

It's a thin wrapper over Kvindo Cloud's own [REST API](https://cloud-api.kvindo.ru/swagger/index.html) — the same API the [`kc` CLI](https://github.com/Kvindo/kc-cli), [Terraform provider](https://github.com/Kvindo/terraform-provider-kvindo), and [Python SDK](https://github.com/Kvindo/kc-sdk-python) already use.

**Read-only by default.** Creating, updating, or deleting resources requires explicitly opting in via environment variables — see [Write access](#write-access) below.

---

## 1. Install & configure

Requires an MCP client (e.g. [Claude Desktop](https://claude.ai/download) or Claude Code) and a Kvindo Cloud **Personal Access Token**: console → IAM → Tokens → Create token.

Add to your MCP client's config (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kvindo-cloud": {
      "command": "npx",
      "args": ["-y", "kc-mcp-server"],
      "env": {
        "KVINDO_API_TOKEN": "<your token>"
      }
    }
  }
}
```

Restart your client. The server validates the token at startup (one cheap authenticated call) and fails fast with a clear message if it's invalid or expired.

### Multiple accounts / environments

Run multiple named server instances, each with its own `env` block:

```json
{
  "mcpServers": {
    "kvindo-cloud-prod": {
      "command": "npx",
      "args": ["-y", "kc-mcp-server"],
      "env": { "KVINDO_API_TOKEN": "<prod token>" }
    },
    "kvindo-cloud-dev": {
      "command": "npx",
      "args": ["-y", "kc-mcp-server"],
      "env": {
        "KVINDO_API_TOKEN": "<dev token>",
        "KVINDO_API_URL": "https://dev-cloud-api.avant-it.ru"
      }
    }
  }
}
```

There's no built-in multi-profile switching within a single server instance — one process is one account.

---

## 2. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `KVINDO_API_TOKEN` | yes | — | Personal Access Token from console → IAM → Tokens. |
| `KVINDO_API_URL` | no | `https://cloud-api.kvindo.ru` | Point at a different environment (e.g. dev). |
| `KVINDO_MCP_ALLOW_WRITE` | no | `false` | Must be exactly `"true"` or `"false"`. Enables `create_or_update_resource`. |
| `KVINDO_MCP_ALLOW_DELETE` | no | `false` | Must be exactly `"true"` or `"false"`. Enables `delete_resource`. Independent of `ALLOW_WRITE` — you can allow create/update without exposing delete. |

Any other value for the two `ALLOW_*` flags (e.g. `"1"`, `"yes"`) fails startup rather than silently falling back to read-only or write-enabled — a typo shouldn't silently change your safety posture in either direction.

---

## 3. Write access

Set these per-invocation in your MCP client config, not left permanently on in a shared profile:

```json
"env": {
  "KVINDO_API_TOKEN": "...",
  "KVINDO_MCP_ALLOW_WRITE": "true",
  "KVINDO_MCP_ALLOW_DELETE": "true"
}
```

When a gate is off, its tool is **absent from the tool list entirely** — the model can't discover or attempt it, not just get an error when it tries. `delete_resource` additionally requires a `confirm: true` argument on every call, on top of the env-var gate.

**Known limitation:** these gates are process-wide, not per-call or per-conversation. Enabling delete for one task leaves it enabled until you restart the server with different env vars. Every write/delete call is logged to stderr with a timestamp as a local audit trail.

All writes (create, update, delete) are **asynchronous** — the response carries a `requestId`; poll `get_request_status` until `succeeded: true` rather than assuming the change applied immediately.

---

## 4. Available tools

| Tool | Gate | Description |
|---|---|---|
| `list_resource_types` | always | List every resource type this server can manage. |
| `describe_resource_type` | always | Get the JSON Schema for a type's manifest (`spec`/`status`). |
| `list_resources` | always | List resources of a type, filtered by label, auto-paginated (capped at 5 pages / 100 per page — narrow your filter if truncated). |
| `get_resource` | always | Fetch one resource by id. |
| `get_request_status` | always | Poll an async change request. |
| `create_or_update_resource` | `KVINDO_MCP_ALLOW_WRITE` | Create or update (idempotent on `manifest.metadata.id`). Validated against the type's schema client-side before sending. |
| `delete_resource` | `KVINDO_MCP_ALLOW_DELETE` + `confirm: true` | Delete by id. Usually irreversible. |

There's no `folderId` filter at the API level — filter by label if your resources carry a folder-identifying label.

---

## 5. Example

> "List my running VMs, then create a new SSH key called `laptop` with this public key: ..."

The model calls `list_resources({ type: "vm" })`, then — if writes are enabled — `describe_resource_type({ type: "ssh-key" })` to see the manifest shape, then `create_or_update_resource({ type: "ssh-key", manifest: {...} })`, then polls `get_request_status` until it succeeds.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server fails to start: `KVINDO_API_TOKEN is required` | Set the env var — see [Install & configure](#1-install--configure). |
| Server fails to start: `token check failed (Unauthorized...)` | Token is invalid or expired — generate a new one in console → IAM → Tokens. |
| A write/delete tool doesn't show up | Its `KVINDO_MCP_ALLOW_*` gate isn't set to exactly `"true"` — see [Write access](#3-write-access). |
| `create_or_update_resource` fails with "failed schema validation" | The manifest doesn't match the type's schema — call `describe_resource_type` first. This is a client-side convenience check; the API remains the authority. |
| `list_resources` result says `truncated: true` | Hit the 5-page auto-pagination cap. Narrow the `labels` filter, or pass the returned `enumeratorId` to continue. |
| A resource type is missing from `list_resource_types` | The backend added it after this server's release — see [Resource-type drift](#7-resource-type-drift). |

---

## 7. Resource-type drift

The list of resource types and their schemas is generated from Kvindo Cloud's OpenAPI spec at release time, not fetched live — a genuinely new backend resource type won't appear until the next release of this package (same as `kc`/the Python SDK until *their* next release). A daily CI check compares against the live spec and files a tracking issue on drift; see `CHANGELOG.md` for what's shipped.

---

## Development

```sh
npm install
npm run generate     # regenerate src/resource-types.generated.ts from the dev API's swagger.json
npm run typecheck
npm run lint
npm test
npm run build
```

---

## Related projects

Part of the Kvindo Cloud developer toolchain:

- **[kc CLI](https://github.com/Kvindo/kc-cli)** — kubectl-style command-line client for Kvindo Cloud.
- **[kc-sdk-python](https://github.com/Kvindo/kc-sdk-python)** — Python SDK for the Kvindo Cloud API ([PyPI](https://pypi.org/project/kc-sdk-python/)).
- **[terraform-provider-kvindo](https://github.com/Kvindo/terraform-provider-kvindo)** — Terraform provider ([Registry](https://registry.terraform.io/providers/kvindo/kvindo/latest)).
- **[Kvindo Cloud console](https://cloud.kvindo.com)** — web UI and API.

## License

MIT
