# Changelog

## 0.1.0 — Unreleased

Initial release.

- `list_resource_types`, `describe_resource_type`, `list_resources`, `get_resource`, `get_request_status` — always-on read tools.
- `create_or_update_resource`, `delete_resource` — gated behind `KVINDO_MCP_ALLOW_WRITE` / `KVINDO_MCP_ALLOW_DELETE`.
- Resource types and schemas generated from the Kvindo Cloud OpenAPI spec (62 types at release time).
