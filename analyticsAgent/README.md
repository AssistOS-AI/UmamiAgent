# Analytics Agent

`analyticsAgent` exposes self-hosted Umami analytics through controlled Ploinky MCP tools.

## Components

- Ploinky AgentServer serves `/mcp`.
- `mcp-config.json` exposes one tool per allowed analytics operation.
- `tools/analytics_tool.mjs` calls the internal `MadsNyl/umami-mcp` HTTP MCP server.
- `analyticsInfra` runs the self-hosted Umami application.
- `analyticsDB` runs PostgreSQL for Umami.

## Umami Stack

`analyticsAgent` depends on `analyticsInfra`, and `analyticsInfra` depends on `analyticsDB`. Ploinky starts the three agents in dependency order.

The dashboard is bound to local host by default by `analyticsInfra`:

```text
http://127.0.0.1:3000
```

Inside the `analytics` network, `analyticsAgent` calls Umami at:

```text
http://analytics-umami:3000
```

PostgreSQL data persists under `.ploinky/data/analyticsDB/postgres`. Database and app secrets are generated and shared by Ploinky through `UMAMI_POSTGRES_PASSWORD` and `UMAMI_APP_SECRET`.

Website tracking snippets should send browser events directly to the Umami app URL that is reachable by the website. They should not send tracking events to `analyticsAgent`.

## IDE Settings Plugin

`IDE-plugins/analytics-tracker/` contributes the `Analytics Tracker` settings entry in AchillesIDE. The settings modal generates an Umami browser tracking script from:

- the public Umami URL, defaulting to `http://127.0.0.1:3000`;
- the Umami website selected from the Umami MCP website list.

The plugin calls `analytics_websites_list` through `/analyticsAgent/mcp` when the modal opens and shows the returned websites in a selector when Umami credentials are configured. If a new website is added in the Umami dashboard, close and reopen the settings modal to reload the list. Errors from the MCP call are displayed in the modal and logged with `console.error`. Tracking data still goes directly from the website browser to Umami's `/script.js` endpoint, not to MCP.

## MCP Backend

`scripts/install-umami-mcp.sh` installs Bun, clones `https://github.com/MadsNyl/umami-mcp.git`, runs `bun install`, and builds the upstream MCP server. `scripts/start-analytics-agent.sh` starts that server on `127.0.0.1:${UMAMI_MCP_PORT:-7301}` before launching Ploinky AgentServer.

The wrapper authenticates to the internal MCP server with OAuth using:

- `UMAMI_BASE_URL`
- `UMAMI_USERNAME`
- `UMAMI_PASSWORD`, defaulting to Umami's first-login password `umami`
- `MCP_SECRET`
- `OAUTH_CLIENT_ID`
- `OAUTH_REDIRECT_URI`

Fresh local installs work with Umami's upstream default `admin` / `umami`. After changing the dashboard password, update `UMAMI_PASSWORD` so the read-only adapter can keep authenticating.

## Exposed Tools

- `analytics_websites_list`
- `analytics_stats_get`
- `analytics_pageviews_get`
- `analytics_metrics_get`
- `analytics_events_list`
- `analytics_active_get`
- `analytics_sessions_get`
- `analytics_report_generate`

The agent intentionally exposes no Umami write, admin, user, team, website CRUD, or event ingestion operations.
