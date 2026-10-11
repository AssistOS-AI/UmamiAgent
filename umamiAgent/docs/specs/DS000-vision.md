---
title: DS000-vision
summary: Defines controlled analytics access, local report delivery, and the upstream read-only boundary.
---

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) gives workspace users and agents controlled access to self-hosted analytics without exposing Umami administration through MCP.

## Core Content

The agent must expose only the operations declared in `mcp-config.json`. Analytics retrieval must preserve the authenticated user's upstream access restrictions. Report generation may write a local Markdown deliverable and return its path; read-only refers to Umami data rather than the agent's filesystem. Website creation, user and team administration, and event ingestion must remain outside the public MCP tools.

The agent owns one container containing PostgreSQL, Umami, the internal MCP adapter, and AgentServer. Ploinky owns public routing and persistent agent storage. The static settings plugin generates browser tracking snippets; website events go to Umami rather than to the reporting MCP endpoint.
