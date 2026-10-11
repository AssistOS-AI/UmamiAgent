---
title: DS002-runtime-boundary
summary: Defines ownership of the embedded services, fixed publication prefix, and authenticated routing.
---

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) runs its embedded services under one supervisor while Ploinky controls external access. The detailed runtime contract is in [DS004](specsLoader.html?spec=DS004-umami-agent.md).

## Core Content

The dashboard publication prefix must remain `/base-agent-additional-server/umamiAgent/3000/`. The image must compile the matching `BASE_PATH`, and startup must validate both build metadata and Next.js configuration before database initialization. A runtime environment override cannot repair a differently built image.

The agent-owned [ingress](wiki.html#definition-publication-ingress) listens on container port 3000 and forwards only to loopback port 3001. It must reject any supplied forwarding prefix that differs from the compiled prefix. Neither an additional host port nor a Router-root `/_next` alias may bypass this contract.

Browser MCP calls must use `/umamiAgent/mcp` so the Router supplies per-tool authorization to [AgentServer](wiki.html#definition-agentserver). Static settings assets may have their explicit guest route without guest-enabling MCP. The upstream MCP server remains an internal loopback service. PostgreSQL persists at `/root/postgres`; OAuth sessions remain ephemeral.
