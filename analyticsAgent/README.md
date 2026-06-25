# Analytics Agent

`analyticsAgent` exposes self-hosted Umami analytics through controlled Ploinky MCP tools.

## Components

- Ploinky AgentServer serves `/mcp`.
- `mcp-config.json` exposes one tool per allowed analytics operation.
- `tools/analytics_tool.mjs` calls `MadsNyl/umami-mcp` internally.
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

## MCP Backend

Set `UMAMI_MCP_COMMAND` when the upstream server uses a different install/run command. The default command is:

```bash
npx -y @madsnyl/umami-mcp
```

The wrapper passes these environment variables to the internal MCP process:

- `UMAMI_BASE_URL`
- `UMAMI_API_URL`
- `UMAMI_USERNAME`
- `UMAMI_PASSWORD`
- `UMAMI_TOKEN`
- `UMAMI_API_KEY`

Set `UMAMI_TOKEN` or `UMAMI_PASSWORD` before calling analytics tools. The manifest intentionally does not hardcode the upstream default password.

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
