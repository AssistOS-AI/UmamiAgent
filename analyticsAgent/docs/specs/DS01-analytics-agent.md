---
id: DS01
title: Analytics Agent
status: implemented
owner: achilleside-team
summary: Defines the read-only Umami analytics agent, its Ploinky-managed Umami dependencies, MCP surface, and security boundaries.
---

# DS01 - Analytics Agent

## Core Content

`analyticsAgent` is a Ploinky MCP-first agent for read-only Umami analytics. The agent uses the standard bundled AgentServer as the public `/mcp` surface and declares every callable operation in `mcp-config.json`.

The agent does not start host-side Docker Compose. It depends on two Ploinky-managed service agents:

- `analyticsInfra` runs the official Umami PostgreSQL image `docker.umami.is/umami-software/umami:postgresql-latest` and joins the `analytics` network as `analytics-umami`.
- `analyticsDB` runs `postgres:16-alpine`, joins the `analytics` network as `analytics-db`, and persists PostgreSQL data under `.ploinky/data/analyticsDB/postgres`.

The Umami dashboard is local-only by default through `127.0.0.1:3000`, exposed by `analyticsInfra`. The agent container reaches the API through `UMAMI_BASE_URL`, defaulting to `http://analytics-umami:3000`.

`MadsNyl/umami-mcp` is an internal backend adapter. Ploinky users and agents never call it directly. `analytics_tool.mjs` starts the upstream MCP process through `UMAMI_MCP_COMMAND`, lists available upstream tools, maps each public Ploinky tool to a compatible upstream tool, validates input, and returns redacted output. The default `UMAMI_MCP_COMMAND` uses `node /usr/local/lib/node_modules/npm/bin/npx-cli.js -y @madsnyl/umami-mcp` because the current Ploinky node image has broken `/usr/local/bin/npm` and `/usr/local/bin/npx` shims.

The agent manifest must not hardcode the upstream default Umami password. Operators configure `UMAMI_TOKEN` or `UMAMI_PASSWORD` after changing the first-login credentials.

## Public MCP Tools

- `analytics_websites_list`
- `analytics_stats_get`
- `analytics_pageviews_get`
- `analytics_metrics_get`
- `analytics_events_list`
- `analytics_active_get`
- `analytics_sessions_get`
- `analytics_report_generate`

The agent must not expose generic pass-through tools, write operations, Umami user/team/admin operations, website CRUD operations, tracking changes, or event ingestion.

Website tracking snippets send browser events directly to the reachable Umami app endpoint, not to `analyticsAgent`. `analyticsAgent` remains a read-only analytics and reporting surface.

## IDE Settings Plugin

`analyticsAgent` exposes static AchillesIDE plugin assets at `/IDE-plugins/analytics-tracker/*` with `access: "guest"` so the settings modal can load through the router. The manifest must not set global `guest: true` for this purpose, because the MCP surface remains policy-controlled and should not become guest-callable.

The plugin contributes the `Analytics Tracker` workspace settings entry through `ideSettings`. Its `analytics-tracker-settings` modal lets the operator enter the browser-reachable Umami URL, select a Website UUID from `analytics_websites_list`, optionally set allowed domains, and copy the generated script snippet. The modal must not ask the operator to paste the raw UUID manually. MCP load errors must be visible in the modal and logged to the browser console.

`mcp-config.json` uses the AgentServer property-map input schema shape, not JSON Schema's `{ type, properties }` wrapper. A no-argument tool such as `analytics_websites_list` must use `inputSchema: {}`. Otherwise AgentServer/MCP treats `type` and `properties` as user arguments and rejects calls before the tool reaches the Umami MCP adapter.

The generated snippet uses Umami's browser tracker:

```html
<script
  defer
  src="http://127.0.0.1:3000/script.js"
  data-website-id="WEBSITE_ID"
  data-domains="localhost,127.0.0.1"
></script>
```

The modal may call `analytics_websites_list` through `/analyticsAgent/mcp` to list known websites when read-only credentials are configured. It does not create websites and does not ingest analytics events.

## Decisions & Questions

### Question #1: Why keep AgentServer in front of `umami-mcp`?

Response:
AgentServer preserves the Ploinky router, MCP policy, invocation-token, and `mcp-config.json` contracts. The upstream Umami MCP server remains an implementation detail and cannot widen the public tool surface without an explicit `mcp-config.json` change.

### Question #2: Why split Umami into `analyticsInfra` and `analyticsDB` instead of a compose hook?

Response:
The split keeps all runtime pieces under Ploinky management. Restarting or enabling the analytics stack uses agent dependencies instead of host-side Compose state: `analyticsAgent` enables `analyticsInfra`, and `analyticsInfra` enables `analyticsDB`. This keeps lifecycle, secrets, networking, and local port binding visible in manifests.

### Question #3: Why is the settings plugin static instead of a new HTTP service?

Response:
The settings surface only needs to generate a browser snippet and optionally read the existing website list through the declared MCP tool. A static IDE plugin keeps the router boundary simple, avoids a second application endpoint, and does not introduce any event ingestion path through `analyticsAgent`.
