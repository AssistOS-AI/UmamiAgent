---
title: DS004-umami-agent
summary: Defines the single-container analytics tools, embedded Umami stack, and security boundaries.
---

# DS004 Umami agent

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) gives workspace callers controlled analytics and local report delivery. The upstream data boundary is read-only; local report files are an allowed output.

## Core Content

`umamiAgent` is a Ploinky MCP-first agent for read-only Umami data. The custom supervisor starts the bundled AgentServer on container port `7000` and declares every callable operation in `mcp-config.json`.

The agent does not start host-side Docker Compose and does not depend on separate Ploinky service agents. Its manifest pins an immutable `docker.io/assistos/umami-agent` image digest, which provides Node.js, PostgreSQL 18 and Umami `3.4.1` built from immutable upstream source with the Router publication path compiled in. The image carries no Bun and no separate MCP server: the analytics tools use Umami's built-in MCP endpoint.

`scripts/start-umami-agent.sh` is the single-container supervisor. It verifies the source-built Umami image, initializes PostgreSQL under `/root/postgres` when needed, starts PostgreSQL on `127.0.0.1:5432`, ensures the configured `POSTGRES_DB` exists, and runs Umami's `check:db` and `update:tracker` scripts through the image's npm. It exports `MCP_ENABLED=1`, runs `scripts/umami-bootstrap.mjs db`, starts Next.js on `127.0.0.1:3001` and the agent-owned ingress on `0.0.0.0:3000`, waits for Umami with Node fetch probes, runs `scripts/umami-bootstrap.mjs api`, and then starts Ploinky AgentServer on container port `7000`. A failing bootstrap phase stops the stack. The supervisor also stops the entire stack if either Next.js or its ingress exits. The internal key seed and the admin password are removed from the environment of PostgreSQL, Next.js and the ingress; only the bootstrap and AgentServer's tool processes receive the seed.

The Umami dashboard ingress listens inside the isolated container on port `3000`. Ploinky exposes it only through the authenticated reserved route `/base-agent-additional-server/umamiAgent/3000/`; the manifest declares no host port or additional-server field. Browser MCP calls use the canonical Router-mediated `/umamiAgent/mcp` route. The Router resolves that route to AgentServer on port `7000` and mints the per-tool secure-wire authorization AgentServer requires. The generic additional-server relay must not be used for MCP calls. The agent reaches the Umami API internally through `UMAMI_BASE_URL`, defaulting to `http://127.0.0.1:3000`.

Umami's `BASE_PATH` is compiled as `/base-agent-additional-server/umamiAgent/3000` into the image's server and browser bundles. Before any database initialization, the supervisor requires `/app/ploinky-umami-build.json` with schema `ploinky.umami-build/v1`, version `3.4.1`, an immutable source commit, and that exact `basePath`; `.next/required-server-files.json` must report the same base path. An old root-built image fails closed. Port `3000` cannot be changed independently of this publication contract.

The source build applies the recorded `login-query-cache` correction before compilation. A successful credential login cancels only the existing `['login']` verification, stores the returned user in that query cache, and then publishes the user and navigates. A cached or late pre-login verification cannot overwrite the successful authentication or trigger another login document. Build metadata distinguishes the pinned upstream source from the applied patch and its verified source hashes.

The source build also binds the layout's icon and manifest links, the web manifest's icon resources, and the browser tile configuration to that same publication prefix. Native image checks fetch these assets at their published paths and reject root-relative metadata references or HTML fallback responses.

Router strips the publication prefix and supplies a trusted `X-Forwarded-Prefix`. `scripts/umami-ingress.mjs` accepts only the exact compiled prefix when that header is present, restores it on requests, and forwards exclusively to `127.0.0.1:3001`. Headerless internal API and tracker requests use the same adapter. The root request maps to the base path without an extra slash so Next.js normalization cannot redirect it in a loop. Response bytes, relative redirects, and authentication headers remain unchanged, while hop-by-hop headers are removed. Port `3001` is a loopback-only backend and must never be published or accepted as a public listener. No generic Router asset alias or HTML/JavaScript rewriting is used.

The manifest also omits a `network` declaration. Ploinky therefore assigns its isolated per-agent default network. The embedded PostgreSQL, Umami, and AgentServer processes communicate over container loopback and require neither a shared network attachment nor a legacy named-network alias.

### Built-in MCP, internal API key and bootstrap

Umami `3.4.1` ships a read-only MCP endpoint at `<BASE_PATH>/mcp` (streamable HTTP, bearer API keys only). The supervisor enables it with `MCP_ENABLED=1`. It is internal: `scripts/umami-ingress.mjs` answers `404` to any request that carries `x-forwarded-prefix` (a Router-forwarded request) whose decoded, dot-segment-resolved path is `<prefix>/mcp` or below it, in every spelling (`/./mcp`, `/x/../mcp`, `%2e`, percent-encoded letters, case variants). Loopback calls without that header reach it, so only processes inside the container can use it.

The agent calls it with an internal account API key. `UMAMI_INTERNAL_KEY_SEED` is a Ploinky `generatedSecret` owned by this agent (required, at least 32 characters of `[A-Za-z0-9_-]`). The key is `umami_` plus the seed, and no human ever sees it. `scripts/umami-bootstrap.mjs db` upserts the `api_key` row with the fixed id `b85ae2ea-c3b8-4a5f-b7dd-ffee2254cc88`, name `umamiAgent internal` and owner `41e2b680-648e-4b09-bcd7-3e2b10c06264` (Umami's seeded `admin` user): `key_hash` is the unsalted SHA-512 hex digest of the key and `key_prefix` its first 14 characters, as Umami computes them. A changed seed rotates the row on the next start. Umami cannot create a key through its API with a key, which is why the row is written by SQL.

`UMAMI_ADMIN_PASSWORD` is optional. When set it must be at least 16 characters, or the bootstrap fails. The `db` phase then makes user `41e2b680-648e-4b09-bcd7-3e2b10c06264` match it: if the bcrypt check of the stored hash fails, it writes a new bcrypt hash (cost 10, from the `bcryptjs` in `/app`, which is loaded only in this case). The account name is not touched. A password changed in the dashboard is therefore reset on the next start, and Umami's password fingerprint invalidates older login tokens. When the variable is unset the password is left alone, which keeps local workspaces on upstream behavior (`admin` / `umami`). A deploy can prove enforcement by running, inside the container, a login to `http://127.0.0.1:3000/api/auth/login` as `admin` with the container's own `UMAMI_ADMIN_PASSWORD` and expecting HTTP 200; it prints only a status.

`UMAMI_SEED_WEBSITES` is an optional JSON array of `{"id": uuid, "name": string, "domain": string}`. After Umami is healthy, the `api` phase reads each website with the internal key: a missing website (HTTP 404 or a `null` body, for example after deletion in the dashboard) is created with that id, a website owned by the internal user whose name or domain differ is updated, and a website whose `userId` is another user's (or none) is a conflict that exits non-zero so the supervisor stops the stack. Reads are retried; writes are not.

Both phases are idempotent. A run that changed nothing logs `no changes; made no writes`. Database access uses `psql` over `127.0.0.1:5432` with the password in `PGPASSWORD` and each statement on stdin; the password, seed, key and hashes never appear in argv or logs. The psql child receives only `PATH` and the `PG*` variables, and each session first sets `log_min_error_statement = panic` so a failing statement is not written to the server log. The module takes its query, bcrypt and fetch functions as parameters so tests can inject them.

`tools/umami_tool.mjs` is a streamable-HTTP MCP client for `${UMAMI_BASE_URL}/mcp` (default `http://127.0.0.1:3000/mcp`) using `Authorization: Bearer umami_<seed>`. It speaks protocol revision `2025-06-18`, which Umami serves through its stateless fallback: `initialize`, `notifications/initialized`, then one `tools/call`. It accepts JSON and `text/event-stream` replies, treats an `isError` result as a failure, prefers `structuredContent`, converts epoch-millisecond `startAt` and `endAt` to ISO 8601, validates every input against a fixed field table, and redacts the key from errors. Every public tool maps onto exactly one built-in upstream tool; there is no pass-through.

### Public MCP Tools

The first eight tools keep their original names, millisecond inputs and result shape `{ action, upstreamTool, result }`. `umami_websites_list` pages through every website (page size 100) and also returns the array at the top level as `websites` with `id`, `name` and `domain`, which the deploy readiness check reads. Inputs that the upstream tool does not take (`unit` on stats, `timezone` on events and sessions) are accepted and ignored. `umami_metrics_get` maps `url`, `referrer`, `title`, `query` and `event` onto the upstream `filters` and `type: "url"` onto `path`; `umami_sessions_get` maps `query` to `search`. Page sizes are capped at the upstream maximum of 100.

| Ploinky tool | Upstream built-in tool |
| --- | --- |
| `umami_websites_list` | `list_websites` |
| `umami_stats_get` | `get_website_stats` |
| `umami_pageviews_get` | `get_website_traffic` |
| `umami_metrics_get` | `get_website_metrics` |
| `umami_events_list` | `get_events` |
| `umami_active_get` | `get_realtime` |
| `umami_sessions_get` | `get_sessions` |
| `umami_report_generate` | composed from `get_website_stats`, `get_website_traffic` and three `get_website_metrics` calls |
| `umami_website_daterange` | `get_website_daterange` |
| `umami_event_stats` | `get_event_stats` |
| `umami_event_series` | `get_event_series` |
| `umami_event_properties` | `get_event_properties` |
| `umami_session_stats` | `get_session_stats` |
| `umami_session_get` | `get_session` |
| `umami_annotations_list` | `get_annotations` |
| `umami_segments_list` | `list_segments` |
| `umami_funnels_list` | `list_funnels` |
| `umami_funnel_run` | `run_funnel` |
| `umami_goals_get` | `get_goals` |
| `umami_journey_run` | `run_journey` |
| `umami_retention_run` | `run_retention` |
| `umami_attribution_run` | `run_attribution` |
| `umami_revenue_get` | `get_revenue` |
| `umami_performance_get` | `get_performance` |

The 16 added tools take `websiteId` (default `UMAMI_DEFAULT_WEBSITE_ID`), a required epoch-millisecond `startAt` and an optional `endAt` (default now) where the upstream tool has a range, and the upstream filters as one `filters` object restricted to the documented keys. The agent must not expose generic pass-through tools, write operations, Umami user/team/admin operations, website CRUD operations, tracking changes, or event ingestion.

Website tracking snippets send browser events directly to the reachable Umami app endpoint, not to `umamiAgent`. `umamiAgent` remains a read-only Umami reporting service. `umami_report_generate` writes Markdown to `UMAMI_OUTPUT_DIR` or `/shared/deliverables/umami` and returns `filePath`; a repeated sanitized label replaces that local file.

### IDE Settings Plugin

`umamiAgent` exposes static AchillesIDE plugin assets at `/IDE-plugins/umami-settings/*` with `access: "guest"` so the settings modal can load through the router. The manifest also sets `routerAccess.requiredCapability` to `explorer.access` with `capabilityDeniedRedirect` `/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/`; the Router applies it to the agent's authenticated and guest routes (not to explicit `access: "public"` routes), so the dashboard, `/umamiAgent/mcp` and the plugin assets are limited to users with `explorer.access`. Exactly two `public` routes exist, for anonymous visitors of tracked sites: `/base-agent-additional-server/umamiAgent/3000/script.js` and `/base-agent-additional-server/umamiAgent/3000/api/send` (`publicProtocol` methods `POST` and `OPTIONS`, `allowCors`). No other `/api/*` path and not `/mcp` is ever public. Umami answers `api/send` with a wildcard CORS policy that the Router never relays, so the ingress replaces it with the exact caller origin for that path only. Same-origin tracking works (for example a tracker on the Explorer's own origin). Cross-origin tracking from other websites does not yet: the Router rebuilds CORS on public routes and allows only the `authorization` and `content-type` request headers, so a preflight for the tracker's `x-umami-website-id` and `x-umami-hostname` headers fails whatever the ingress sends. It needs a Router change to the allowed headers for `allowCors` public routes, tracked as a Ploinky follow-up. Operators who do not set `UMAMI_ADMIN_PASSWORD` must change the default Umami password after first login. The manifest must not set global `guest: true` for this purpose, because the MCP surface remains policy-controlled and should not become guest-callable.

The plugin contributes the `Umami Settings` workspace settings entry through `ideSettings`. Its `umami-settings` modal lets the operator enter the browser-reachable Umami URL, select a Website UUID from `umami_websites_list` loaded on modal open, and copy the generated script snippet. The modal must not ask the operator to paste the raw UUID manually and must not expose a manual website refresh button; operators close and reopen the modal after adding websites in Umami. MCP load errors must be visible in the modal and logged to the browser console.

`mcp-config.json` uses the AgentServer property-map input schema shape, not JSON Schema's `{ type, properties }` wrapper. A no-argument tool such as `umami_websites_list` must use `inputSchema: {}`. Otherwise AgentServer/MCP treats `type` and `properties` as user arguments and rejects calls before the tool reaches the Umami tool adapter.

The modal's Umami URL defaults to `<origin>/base-agent-additional-server/umamiAgent/3000` on the Explorer's origin, the public Router publication. The generated snippet uses Umami's browser tracker:

```html
<script
  defer
  src="https://explorer.example/base-agent-additional-server/umamiAgent/3000/script.js"
  data-website-id="WEBSITE_ID"
></script>
```

The modal calls `umami_websites_list` through `/umamiAgent/mcp` to list known websites. It does not create websites and does not ingest Umami events.

### Runtime rationale

#### AgentServer public tool boundary

AgentServer preserves the Ploinky router, MCP policy, invocation-token, and `mcp-config.json` contracts. Umami's built-in MCP endpoint remains an implementation detail and cannot widen the public tool surface without an explicit `mcp-config.json` change.

#### Single-container lifecycle ownership

The Umami stack is consolidated into the single `umamiAgent` container so Ploinky has one durable Umami agent identity while the container supervisor owns the internal PostgreSQL and Umami process lifecycle.

Readiness is the MCP handshake (`readiness.protocol: "mcp"`). The manifest's script-less `health.readiness` block (interval 2 s, timeout 2 s, failure threshold 75) sizes that wait to 300 s. Without it a targeted `ploinky restart` waits only 15 s, while the stack needs about 40 s to start PostgreSQL, Umami and AgentServer; the restart then fails and leaves the agent down. The block declares no script, so it adds no readiness probe and no probe broker. Because a `health` key is now present, the Ploinky watchdog starts its container-state worker every five minutes; that worker only checks that the container is running, as it already does for `roboTeamAgent` and `promotionScout`.

#### Static tracker settings

The settings surface only needs to generate a browser snippet and read the existing website list through the declared MCP tool. A static IDE plugin keeps the router boundary simple, avoids a second application endpoint, and does not introduce any event ingestion path through `umamiAgent`.
