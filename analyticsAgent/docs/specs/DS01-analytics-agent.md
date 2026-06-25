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

`MadsNyl/umami-mcp` is an internal backend adapter. Ploinky users and agents never call it directly. `analytics_tool.mjs` starts the upstream MCP process through `UMAMI_MCP_COMMAND`, lists available upstream tools, maps each public Ploinky tool to a compatible upstream tool, validates input, and returns redacted output.

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

## Decisions & Questions

### Question #1: Why keep AgentServer in front of `umami-mcp`?

Response:
AgentServer preserves the Ploinky router, MCP policy, invocation-token, and `mcp-config.json` contracts. The upstream Umami MCP server remains an implementation detail and cannot widen the public tool surface without an explicit `mcp-config.json` change.

### Question #2: Why split Umami into `analyticsInfra` and `analyticsDB` instead of a compose hook?

Response:
The split keeps all runtime pieces under Ploinky management. Restarting or enabling the analytics stack uses agent dependencies instead of host-side Compose state: `analyticsAgent` enables `analyticsInfra`, and `analyticsInfra` enables `analyticsDB`. This keeps lifecycle, secrets, networking, and local port binding visible in manifests.
