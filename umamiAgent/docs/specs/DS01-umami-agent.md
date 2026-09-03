---
id: DS01
title: Umami Agent
status: implemented
owner: achilleside-team
summary: Defines the single-container read-only Umami agent, its MCP surface, embedded Umami stack, and security boundaries.
---

# DS01 - Umami Agent

## Core Content

`umamiAgent` is a Ploinky MCP-first agent for read-only Umami data. The custom supervisor starts the bundled AgentServer on container port `7000` and declares every callable operation in `mcp-config.json`.

The agent does not start host-side Docker Compose and does not depend on separate Ploinky service agents. Its manifest pins an immutable `docker.io/assistos/umami-agent` image digest, which preserves the pinned PostgreSQL, Bun, and built `MadsNyl/umami-mcp` runtime and builds Umami `3.2.0` from immutable upstream source with the Router publication path compiled in.

`scripts/start-umami-agent.sh` is the single-container supervisor. It verifies the source-built Umami image, initializes PostgreSQL under `/root/postgres` when needed, starts PostgreSQL on `127.0.0.1:5432`, ensures the configured `POSTGRES_DB` exists, runs Umami's database check and tracker update, starts Next.js on `127.0.0.1:3001` and the agent-owned ingress on `0.0.0.0:3000`, starts `MadsNyl/umami-mcp` on `127.0.0.1:${UMAMI_MCP_PORT:-7301}`, and then starts Ploinky AgentServer on container port `7000`. The supervisor stops the entire stack if either Next.js or its ingress exits.

The Umami dashboard ingress listens inside the isolated container on port `3000`. Ploinky exposes it only through the authenticated reserved route `/base-agent-additional-server/umamiAgent/3000/`; the manifest declares no host port or additional-server field. Browser MCP calls use the canonical Router-mediated `/umamiAgent/mcp` route. The Router resolves that route to AgentServer on port `7000` and mints the per-tool secure-wire authorization AgentServer requires. The generic additional-server relay must not be used for MCP calls. The agent reaches the Umami API internally through `UMAMI_BASE_URL`, defaulting to `http://127.0.0.1:3000`.

Umami's `BASE_PATH` is compiled as `/base-agent-additional-server/umamiAgent/3000` into the image's server and browser bundles. Before any database initialization, the supervisor requires `/app/ploinky-umami-build.json` with schema `ploinky.umami-build/v1`, version `3.2.0`, an immutable source commit, and that exact `basePath`; `.next/required-server-files.json` must report the same base path. An old root-built image fails closed. Port `3000` cannot be changed independently of this publication contract.

The source build applies the recorded `login-query-cache` correction before compilation. A successful credential login cancels only the existing `['login']` verification, stores the returned user in that query cache, and then publishes the user and navigates. A cached or late pre-login verification cannot overwrite the successful authentication or trigger another login document. Build metadata distinguishes the pinned upstream source from the applied patch and its verified source hashes.

The source build also binds the layout's icon and manifest links, the web manifest's icon resources, and the browser tile configuration to that same publication prefix. Native image checks fetch these assets at their published paths and reject root-relative metadata references or HTML fallback responses.

Router strips the publication prefix and supplies a trusted `X-Forwarded-Prefix`. `scripts/umami-ingress.mjs` accepts only the exact compiled prefix when that header is present, restores it on requests, and forwards exclusively to `127.0.0.1:3001`. Headerless internal API and tracker requests use the same adapter. The root request maps to the base path without an extra slash so Next.js normalization cannot redirect it in a loop. Response bytes, relative redirects, and authentication headers remain unchanged, while hop-by-hop headers are removed. Port `3001` is a loopback-only backend and must never be published or accepted as a public listener. No generic Router asset alias or HTML/JavaScript rewriting is used.

The manifest also omits a `network` declaration. Ploinky therefore assigns its isolated per-agent default network. The embedded PostgreSQL, Umami, MCP adapter, and AgentServer processes communicate over container loopback and require neither a shared network attachment nor a legacy named-network alias.

`MadsNyl/umami-mcp` is an internal backend adapter. Ploinky users and agents never call it directly. `umami_tool.mjs` authenticates to the internal MadsNyl server through its OAuth flow, lists available upstream tools, maps each public Ploinky tool to a compatible upstream tool, validates input, and returns redacted output.

The agent defaults `UMAMI_USERNAME` to `admin` and `UMAMI_PASSWORD` to Umami's first-login password `umami` so a fresh local self-hosted install works without manual environment setup. Operators configure `UMAMI_PASSWORD` after changing the dashboard password. MadsNyl's SQLite session database is ephemeral at `/tmp/umami-mcp/sessions.db`; no host volume is used for those OAuth sessions. PostgreSQL data persists in the agent root storage at `/root/postgres`, mapped by Ploinky to the workspace `.data` area.

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
