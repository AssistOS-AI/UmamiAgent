---
id: DS01
title: Umami Agent
status: implemented
owner: umami-team
summary: Defines the pinned dashboard, narrow telemetry proxy, private MCP bind, source-partitioned abuse controls, base path, and topology projection.
---

# DS01 - Umami Agent

## Core Content

### Runtime

The agent uses a pinned multi-architecture image digest and supervises:

- Umami dashboard/API on private TCP `3000` with
  `BASE_PATH=/services/umami`;
- a dedicated narrow telemetry proxy on private TCP `3001`;
- MCP on an explicit loopback/private bind; and
- process-local PostgreSQL.

The image definition itself is immutable: it uses the reviewed Umami `3.2.0`
amd64/arm64 OCI index digest, verifies the architecture-specific Bun `1.3.14`
musl archive by SHA-256, fetches and verifies exact `MadsNyl/umami-mcp` commit
`3ab73beda2db0ebffb0b07439b218ef562107520`, verifies that commit's `bun.lock`
digest, and installs with the frozen lock. The build has no source override,
floating ref, shallow clone, or installer-script execution path. A read-only
source-lock record and matching labels are present in the image; the
publication workflow verifies both native platform entries and reports the
resulting immutable image index separately from consumer-manifest pinning.

Readiness must prove both HTTP targets and MCP before Router activation. The
manifest declares authenticated dashboard service `umami-dashboard` on `3000`
and guest telemetry service `umami-telemetry` on `3001`. These are private
target mappings, not physical-host publications.

### Dashboard and base path

Dashboard access requires Ploinky authentication and retains Umami's own
defense-in-depth authentication. Assets, redirects, API calls, navigation,
tracker loading, ingestion, and any WebSocket must remain under the configured
base path.

The Explorer settings plugin requests only its current authenticated locator
from the no-store topology projection. It never fabricates a hostname or caches
a startup URL.

### Telemetry proxy

The proxy allows only:

- `GET`/`HEAD` for the tracker script;
- `POST` for the ingestion endpoint; and
- bounded `OPTIONS` preflight for those operations.

It enforces exact configured Origins, JSON and body-size constraints, bounded
request-body and upstream deadlines, a bounded fully-buffered upstream response
before any guest-visible headers are sent, and value-free audit counters. An
audit observer failure cannot change admission or availability. Dashboard,
user, admin, arbitrary API, and unsupported method/path requests fail at the
proxy.

Every ingestion `POST` requires the Router-owned
`x-ploinky-rate-source` header. RoutingServer strips every client-supplied
`x-ploinky-*` value and synthesizes this route-scoped partition from trusted
canonical transport-source material only after listener, host, route, and
policy validation. The value is not a user, session, or authorization identity.
The proxy accepts exactly one case-insensitive 64-hex value, canonicalizes it to
lowercase, and applies both a per-source fixed-window bucket and the global
fixed-window bucket before dialing Umami. A missing, malformed, duplicated, or
otherwise non-canonical source fails closed before the upstream request.

The proxy removes `Cookie`, `Authorization`, forwarding headers, hop-by-hop
headers, and every `x-ploinky-*` header—including the consumed rate source—
before forwarding to process-local Umami `3000`. It does not inject or forward
Ploinky authentication, invocation, caller, or delegation metadata.

`UMAMI_TELEMETRY_ALLOWED_ORIGINS` is an explicit required, non-secret operator
setting containing exact HTTP(S) origins. Origin is an independent admission
check and is never the rate-source key. Per-source and global limits are set by
`UMAMI_TELEMETRY_PER_SOURCE_PER_MINUTE` and
`UMAMI_TELEMETRY_GLOBAL_PER_MINUTE`; the retired per-Origin setting is rejected
as absent from the manifest and has no runtime alias or fallback.

`UMAMI_PASSWORD` is a required generated/operator secret. Startup and the local
MCP OAuth bootstrap fail before admission when it is absent; neither path
substitutes Umami's demonstration password.

### Security and failure

Guest telemetry receives only service-scoped guest policy. It cannot reach the
dashboard or MCP and receives no authenticated identity forwarding. Invalid
base path, missing target, missing topology locator, malformed Origin, missing
or malformed rate source, excess body, rate-limit breach, or unhealthy proxy
fails before route activation or upstream dial as appropriate.

### Verification

Unit tests cover manifest contracts, topology-based settings, base path, method
and path allowlists, credential sanitation, strict rate-source parsing,
same-source exhaustion, distinct-source independence, global exhaustion,
Origin/body/rate bounds, and upstream behavior. The release lane loads
dashboard and telemetry with a real browser through Router.

## Decisions & Questions

### Question #1: Why is telemetry a separate service on private port 3001?

Response:
The authenticated dashboard cannot safely serve as the guest ingestion surface.
The narrow proxy gives tracker and ingestion requests an explicit method/path
allowlist, bounded request handling, credential sanitation, and independent
abuse controls while leaving Umami's administrative surface behind both
Ploinky and Umami authentication.

### Question #2: Why does the proxy consume a Router-derived rate source?

Response:
All public requests reach the proxy from the Router peer, so the proxy socket's
remote address cannot distinguish external callers. User, guest-session, or
cookie values would turn the limiter into an identity-dependent contract and
would fail when browser cookie persistence is blocked. RoutingServer therefore
derives a route-scoped, one-way partition from trusted canonical transport
source material after policy admission. The proxy validates that partition,
uses it only as an in-memory bucket key, and strips it before upstream dial.

### Question #3: Why was the per-Origin limit removed rather than retained as another bucket?

Response:
Origin is already an exact allowlist admission boundary, but one allowed site
origin is shared by all of that site's visitors. Treating it as the source
bucket permits one client to exhaust every other client's allocation and does
not satisfy the approved per-source control. The hard cut keeps only the
Router-derived per-source bucket plus the box-wide global bucket; no legacy
environment alias or dual-accounting path remains.

### Question #4: Why keep AgentServer in front of the internal Umami MCP adapter?

Response:
AgentServer preserves Ploinky's MCP routing, policy, invocation, and explicit
`mcp-config.json` contracts. The internal adapter remains a process-local
implementation detail and cannot widen the public tool surface without a
manifested tool change.

### Question #5: Why is the Umami stack consolidated into one agent container?

Response:
The single agent identity keeps PostgreSQL, Umami, telemetry sanitation, and the
internal MCP adapter inside one isolated runtime. Their support listeners stay
process-private while Ploinky maps only the two declared HTTP service targets
and the normal AgentServer target inside the box.
