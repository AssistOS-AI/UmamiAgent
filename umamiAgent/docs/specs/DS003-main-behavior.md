---
title: DS003-main-behavior
summary: Defines analytics retrieval and local reports, embedded service availability, and tracker settings.
---

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) lets workspace users inspect self-hosted traffic and receive local reports through a controlled MCP tool set.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Analytics and local reports | Authorized callers retrieve analytics or receive a Markdown report path without changing upstream Umami data. |
| Embedded stack and authenticated ingress | One supervised container runs the analytics stack behind the fixed Router publication prefix. |
| Tracker settings | Operators select an existing website and copy a browser tracking snippet from workspace settings. |

### Analytics and local reports

An MCP caller initiates one of the eight declared tools with a website and applicable time range. The adapter must validate input, authenticate to the internal upstream MCP server, map the declared operation, and redact its returned data. `umami_report_generate` must collect summary, pageviews, top pages, referrers, and countries, write a Markdown file under `UMAMI_OUTPUT_DIR` or `/shared/deliverables/umami`, and return `filePath`. Reusing the same sanitized label replaces that local report file. The [read-only boundary](wiki.html#definition-read-only-reporting) must prohibit upstream data mutation without prohibiting this local deliverable.

### Embedded stack and authenticated ingress

Ploinky activation starts the agent supervisor. It must validate the source-built publication contract, initialize and start PostgreSQL, start Umami and its ingress, start the internal MCP server, and start AgentServer. Operators reach the dashboard through `/base-agent-additional-server/umamiAgent/3000/` and invoke tools through `/umamiAgent/mcp`. The loopback services must not become independent public MCP endpoints. A Next.js or ingress process failure must stop the supervised stack. Persistent PostgreSQL storage preserves analytics across restarts; ephemeral OAuth sessions require fresh authentication.

### Tracker settings

A workspace operator opens [Umami Settings](wiki.html#definition-tracker-settings). The plugin must load the existing website list through `umami_websites_list`, let the operator select a website and browser-reachable Umami URL, and produce a snippet using that URL's `/script.js`. The plugin must show MCP errors and must not create websites. Browser events must go directly to the selected Umami endpoint rather than through the reporting agent. Reopening the modal reloads websites added in the dashboard.
