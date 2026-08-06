# Changelog

## 0.1.1

- Switch npm publishing from a token to [Trusted Publishing](https://gh.io/npm-docs-trusted-publishers) (OIDC) — no npm token stored as a secret.
- SEO: GitHub topics/homepage, README badges, expanded npm keywords.
- Mirrored to GitFlic, GitVerse, and GitLab.com.

## 0.1.0

Initial release.

- `list_resource_types`, `describe_resource_type`, `list_resources`, `get_resource`, `get_request_status` — always-on read tools.
- `create_or_update_resource`, `delete_resource` — gated behind `KVINDO_MCP_ALLOW_WRITE` / `KVINDO_MCP_ALLOW_DELETE`.
- Resource types and schemas generated from the Kvindo Cloud OpenAPI spec (62 types at release time).
