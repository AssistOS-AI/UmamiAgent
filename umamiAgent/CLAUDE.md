# umamiAgent

`umamiAgent` is the AchillesIDE read-only Umami agent. It exposes Umami data through Ploinky MCP tools declared in `mcp-config.json`.

## Runtime

- The Ploinky public surface is the standard AgentServer on `/mcp`.
- `umamiAgent` is the only Ploinky agent in the Umami stack.
- The runtime image is `docker.io/assistos/umami-agent:umami-stack`.
- The image layers PostgreSQL and built `MadsNyl/umami-mcp` onto `docker.umami.is/umami-software/umami:postgresql-latest`.
- `scripts/start-umami-agent.sh` supervises PostgreSQL, Umami, the internal Umami MCP server, and Ploinky AgentServer.
- The Umami dashboard is host-local by default at `http://127.0.0.1:3000`.
- The internal Umami API URL is `http://127.0.0.1:3000`.
- PostgreSQL data persists in the agent root storage at `/root/postgres`, mapped by Ploinky to the workspace `.data` area.
- The MCP implementation runs `MadsNyl/umami-mcp` internally as an HTTP MCP server on `127.0.0.1:${UMAMI_MCP_PORT:-7301}`; do not expose that upstream MCP server directly to Ploinky.
- `IDE-plugins/umami-settings/` registers the AchillesIDE `Umami Settings` settings modal and generates browser snippets for Umami's public `/script.js`.

## Security

- Keep all public MCP tools explicit in `mcp-config.json`.
- Do not add a generic pass-through Umami tool.
- Do not expose Umami write/admin/user/team/website-CRUD/event-ingestion tools.
- Keep Umami database passwords, app secrets, login passwords, and tokens out of tracked files.
- Use Ploinky vars or environment overrides for production credentials.
- Website tracking snippets must send events to Umami, not to `umamiAgent`.
- Do not add `guest: true` only to make the settings plugin load. Use explicit `routerAccess.httpRoutes` for static plugin assets so `/mcp` does not become guest-enabled.

## Local Setup

Starting `umamiAgent` should not enable separate Umami infrastructure agents. Ploinky generates the PostgreSQL and Umami app secrets for this single agent.

Default Umami login from upstream is `admin` / `umami`. Change it after first login, then configure `UMAMI_PASSWORD` for the read-only MCP adapter OAuth bootstrap.
