---
id: DS01
title: Umami Agent
status: implemented
owner: achilleside-team
summary: Defines the single-container read-only Umami agent, its MCP surface, embedded Umami stack, and security boundaries.
---

# DS01 - Umami Agent

## Core Content

`umamiAgent` is a Ploinky MCP-first agent for read-only Umami data. The agent uses the standard bundled AgentServer as the public `/mcp` surface and declares every callable operation in `mcp-config.json`.

The agent does not start host-side Docker Compose and does not depend on separate Ploinky service agents. It runs the custom image `docker.io/assistos/umami-agent:umami-stack`, which layers PostgreSQL, Bun, and a built `MadsNyl/umami-mcp` checkout onto `docker.umami.is/umami-software/umami:postgresql-latest`.

`scripts/start-umami-agent.sh` is the single-container supervisor. It initializes PostgreSQL under `/var/lib/postgresql/data` when needed, starts PostgreSQL on `127.0.0.1:5432`, ensures the configured `POSTGRES_DB` exists, runs Umami's database check and tracker update, starts Umami on `0.0.0.0:${UMAMI_APP_PORT:-3000}`, starts `MadsNyl/umami-mcp` on `127.0.0.1:${UMAMI_MCP_PORT:-7301}`, and then starts Ploinky AgentServer on container port `7000`.

The Umami dashboard listens inside the container on `127.0.0.1:3000` and is declared as the profile `server`, so Ploinky exposes it through the router at `http://umamiAgent.localhost:8080/` without reserving host port `3000`. Ploinky MCP is published through a dynamic localhost host port mapped to container port `7000`, so the router continues to own `/umamiAgent/mcp`. The agent reaches the Umami API through `UMAMI_BASE_URL`, defaulting to `http://127.0.0.1:3000`.

`MadsNyl/umami-mcp` is an internal backend adapter. Ploinky users and agents never call it directly. `umami_tool.mjs` authenticates to the internal MadsNyl server through its OAuth flow, lists available upstream tools, maps each public Ploinky tool to a compatible upstream tool, validates input, and returns redacted output.

The agent defaults `UMAMI_USERNAME` to `admin` and `UMAMI_PASSWORD` to Umami's first-login password `umami` so a fresh local self-hosted install works without manual environment setup. Operators configure `UMAMI_PASSWORD` after changing the dashboard password. MadsNyl's SQLite session database is ephemeral at `/tmp/umami-mcp/sessions.db`; no host volume is used for those OAuth sessions. PostgreSQL data persists under `.ploinky/data/umamiAgent/postgres`. Data from the retired `.ploinky/data/umamiDB/postgres` path is not migrated automatically.

## Public MCP Tools

- `umami_websites_list`
- `umami_stats_get`
- `umami_pageviews_get`
- `umami_metrics_get`
- `umami_events_list`
- `umami_active_get`
- `umami_sessions_get`
- `umami_report_generate`

The agent must not expose generic pass-through tools, write operations, Umami user/team/admin operations, website CRUD operations, tracking changes, or event ingestion.

Website tracking snippets send browser events directly to the reachable Umami app endpoint, not to `umamiAgent`. `umamiAgent` remains a read-only Umami reporting surface.

## IDE Settings Plugin

`umamiAgent` exposes static AchillesIDE plugin assets at `/IDE-plugins/umami-settings/*` with `access: "guest"` so the settings modal can load through the router. The manifest must not set global `guest: true` for this purpose, because the MCP surface remains policy-controlled and should not become guest-callable.

The plugin contributes the `Umami Settings` workspace settings entry through `ideSettings`. Its `umami-settings` modal lets the operator enter the browser-reachable Umami URL, select a Website UUID from `umami_websites_list` loaded on modal open, and copy the generated script snippet. The modal must not ask the operator to paste the raw UUID manually and must not expose a manual website refresh button; operators close and reopen the modal after adding websites in Umami. MCP load errors must be visible in the modal and logged to the browser console.

`mcp-config.json` uses the AgentServer property-map input schema shape, not JSON Schema's `{ type, properties }` wrapper. A no-argument tool such as `umami_websites_list` must use `inputSchema: {}`. Otherwise AgentServer/MCP treats `type` and `properties` as user arguments and rejects calls before the tool reaches the Umami MCP adapter.

The generated snippet uses Umami's browser tracker:

```html
<script
  defer
  src="http://127.0.0.1:3000/script.js"
  data-website-id="WEBSITE_ID"
></script>
```

The modal may call `umami_websites_list` through `/umamiAgent/mcp` to list known websites when read-only credentials are configured. It does not create websites and does not ingest Umami events.

## Decisions & Questions

### Question #1: Why keep AgentServer in front of `umami-mcp`?

Response:
AgentServer preserves the Ploinky router, MCP policy, invocation-token, and `mcp-config.json` contracts. The upstream Umami MCP server remains an implementation detail and cannot widen the public tool surface without an explicit `mcp-config.json` change.

### Question #2: Why consolidate Umami into `umamiAgent`?

Response:
This decision is retired. The Umami stack is now consolidated into the single `umamiAgent` container so Ploinky has one durable Umami agent identity while the container supervisor owns the internal PostgreSQL, Umami, and Umami MCP process lifecycle.

### Question #3: Why is the settings plugin static instead of a new HTTP service?

Response:
The settings surface only needs to generate a browser snippet and optionally read the existing website list through the declared MCP tool. A static IDE plugin keeps the router boundary simple, avoids a second application endpoint, and does not introduce any event ingestion path through `umamiAgent`.
