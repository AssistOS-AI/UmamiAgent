---
title: DS002-runtime-boundary
summary: Defines ownership of the embedded services, fixed publication prefix, public tracker routes, and authenticated routing.
---

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) runs its embedded services under one supervisor while Ploinky controls external access. The detailed runtime contract is in [DS004](specsLoader.html?spec=DS004-umami-agent.md).

## Core Content

The dashboard publication prefix must remain `/base-agent-additional-server/umamiAgent/3000/`. The image must compile the matching `BASE_PATH`, and startup must validate both build metadata and Next.js configuration before database initialization. A runtime environment override cannot repair a differently built image.

The agent-owned [ingress](wiki.html#definition-publication-ingress) listens on container port 3000 and forwards only to loopback port 3001. It must reject any supplied forwarding prefix that differs from the compiled prefix. Neither an additional host port nor a Router-root `/_next` alias may bypass this contract.

Browser MCP calls must use `/umamiAgent/mcp` so the Router supplies per-tool authorization to [AgentServer](wiki.html#definition-agentserver). Static settings assets may have their explicit guest route without guest-enabling MCP. PostgreSQL persists at `/root/postgres`.

Umami's built-in MCP endpoint (`/mcp` under the publication prefix, enabled by `MCP_ENABLED=1`) is internal. The ingress must answer `404` to every Router-forwarded request, recognised by `x-forwarded-prefix`, whose decoded and dot-segment-resolved path is the prefix plus `/mcp` or below it. Only loopback calls from inside the container, which carry no forwarding header, may reach it, and the agent's tools authenticate there with an internal API key that no human holds.

Exactly two Router routes are `public`: `script.js` (GET) and `api/send` (`publicProtocol` POST and OPTIONS with CORS) under the publication prefix. They serve anonymous visitors of tracked sites. No other `/api/*` path, the dashboard or `/mcp` may become public. Tracking works from the Explorer's own origin and from other websites: the route also declares `publicProtocol.allowHeaders` with `content-type`, `x-umami-website-id`, `x-umami-hostname` and `x-umami-cache`, the request headers the tracker sends and the ingress advertises for that path. The Router admits only names both lists contain, so `manifest-contract.test.mjs` keeps them equal. A Ploinky Router without `allowHeaders` support rejects this manifest.
