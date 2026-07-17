# umamiAgent

`umamiAgent` is the AchillesIDE read-only Umami agent. It exposes Umami data through Ploinky MCP tools declared in `mcp-config.json`.

## Runtime

- The Ploinky public surface is the standard AgentServer on `/mcp`.
- `umamiAgent` is the only Ploinky agent in the Umami stack.
- The manifest pins `docker.io/assistos/umami-agent` by immutable image digest.
- The image build has no source override: its embedded source lock pins the
  Umami amd64/arm64 OCI index, verifies the architecture-specific Bun archive,
  and checks out and verifies one exact `MadsNyl/umami-mcp` commit before a
  frozen-lockfile build.
- `scripts/start-umami-agent.sh` supervises PostgreSQL, Umami, the internal Umami MCP server, the narrow telemetry proxy, and Ploinky AgentServer.
- Umami listens on private TCP `3000` with `BASE_PATH=/services/umami`; the authenticated Router service, never a fabricated `.localhost` or physical-host port, is the browser dashboard locator.
- The telemetry proxy listens on private TCP `3001` and exposes only tracker and ingestion operations through the scoped-guest `umami-telemetry` Router service.
- The internal Umami API URL is `http://127.0.0.1:3000/services/umami`.
- The manifest explicitly selects Ploinky `network.mode: "default"`. The stack is isolated from sibling agents, has no shared attachments, and declares no DNS aliases.
- PostgreSQL data persists in the agent root storage at `/root/postgres`, mapped by Ploinky to the workspace `.data` area.
- The MCP implementation runs `MadsNyl/umami-mcp` internally as an HTTP MCP server on `127.0.0.1:${UMAMI_MCP_PORT:-7301}`; do not expose that upstream MCP server directly to Ploinky.
- `IDE-plugins/umami-settings/` registers the AchillesIDE `Umami Settings` modal. It resolves the current dashboard and telemetry locators from Ploinky's authenticated no-store topology projection and generates snippets against the telemetry locator.

## Security

- Keep all public MCP tools explicit in `mcp-config.json`.
- Do not add a generic pass-through Umami tool.
- Do not expose Umami write/admin/user/team/website-CRUD/event-ingestion tools.
- Keep Umami database passwords, app secrets, login passwords, and tokens out of tracked files.
- Use Ploinky vars or environment overrides for production credentials.
- Website tracking snippets must use the narrow `umami-telemetry` Router service. They must never call dashboard TCP `3000`, MCP, or an invented local hostname directly.
- Ingestion requires Router-owned `x-ploinky-rate-source`: one case-insensitive 64-hex route-scoped partition derived from trusted canonical transport source. Use it only for the per-source bucket, strip it with every `x-ploinky-*` header before Umami, and never substitute socket peer, Origin, guest session, or user identity.
- The abuse-control settings are `UMAMI_TELEMETRY_PER_SOURCE_PER_MINUTE` and `UMAMI_TELEMETRY_GLOBAL_PER_MINUTE`. Do not restore the retired per-Origin name or a compatibility alias.
- Do not add `guest: true` only to make the settings plugin load. Use explicit `routerAccess.httpRoutes` for static plugin assets so `/mcp` does not become guest-enabled.

## Local Setup

Starting `umamiAgent` should not enable separate Umami infrastructure agents. Ploinky generates the PostgreSQL and Umami app secrets for this single agent.

`UMAMI_PASSWORD` and exact `UMAMI_TELEMETRY_ALLOWED_ORIGINS` are required. No upstream demonstration-password or inferred-origin fallback is permitted.
