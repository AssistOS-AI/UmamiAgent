# analyticsAgent

`analyticsAgent` is the AchillesIDE read-only analytics agent. It exposes Umami analytics through Ploinky MCP tools declared in `mcp-config.json`.

## Runtime

- The Ploinky public surface is the standard AgentServer on `/mcp`.
- `analyticsAgent` depends on `analyticsInfra`, which depends on `analyticsDB`.
- `analyticsInfra` runs `docker.umami.is/umami-software/umami:postgresql-latest`.
- `analyticsDB` runs `postgres:16-alpine`.
- The Umami dashboard is host-local by default at `http://127.0.0.1:3000`.
- The internal Umami API URL is `http://analytics-umami:3000`.
- The MCP implementation calls `MadsNyl/umami-mcp` internally through `UMAMI_MCP_COMMAND`; do not expose that upstream MCP server directly to Ploinky.

## Security

- Keep all public MCP tools explicit in `mcp-config.json`.
- Do not add a generic pass-through Umami tool.
- Do not expose Umami write/admin/user/team/website-CRUD/event-ingestion tools.
- Keep Umami database passwords, app secrets, login passwords, and tokens out of tracked files.
- Use Ploinky vars or environment overrides for production credentials.
- Website tracking snippets must send events to Umami, not to `analyticsAgent`.

## Local Setup

Starting `analyticsAgent` should enable `analyticsInfra`; starting `analyticsInfra` should enable `analyticsDB`. Ploinky generates the shared PostgreSQL and Umami app secrets.

Default Umami login from upstream is `admin` / `umami`. Change it after first login, then configure `UMAMI_TOKEN` or `UMAMI_PASSWORD` for the read-only MCP adapter.
