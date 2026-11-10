---
title: DS003-main-behavior
summary: Defines analytics retrieval and local reports, embedded service availability and bootstrap, and tracker settings.
---

## Introduction

[umamiAgent](wiki.html#definition-umami-agent) lets workspace users inspect self-hosted traffic and receive local reports through a controlled MCP tool set.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Analytics and local reports | Authorized callers retrieve analytics or receive a Markdown report path without changing upstream Umami data. |
| Embedded stack and authenticated ingress | One supervised container runs the analytics stack behind the fixed Router publication prefix and enforces its declared credentials and websites at start. |
| Tracker settings | Operators select an existing website and copy a browser tracking snippet from workspace settings. |

### Analytics and local reports

An MCP caller initiates one of the 24 declared tools (the original eight and 16 more, each mapped 1:1 onto a read-only built-in tool of Umami's MCP endpoint) with a website and applicable time range. The adapter must validate input, convert epoch-millisecond times to ISO 8601, authenticate to the loopback `/mcp` endpoint with the internal API key, call the one mapped upstream tool, and redact its returned data. An upstream error result is a tool failure. `umami_websites_list` returns every website with its `id` and `domain`. `umami_report_generate` must collect summary, pageviews, top pages, referrers, and countries, write a Markdown file under `UMAMI_OUTPUT_DIR` or `/shared/deliverables/umami`, and return `filePath`. Reusing the same sanitized label replaces that local report file. The [read-only boundary](wiki.html#definition-read-only-reporting) must prohibit upstream data mutation without prohibiting this local deliverable.

### Embedded stack and authenticated ingress

Ploinky activation starts the agent supervisor. It must validate the source-built publication contract, initialize and start PostgreSQL, run Umami's database check and tracker update, run the `db` bootstrap phase, start Umami and its ingress, run the `api` bootstrap phase once Umami is healthy, and start AgentServer. Operators reach the dashboard through `/base-agent-additional-server/umamiAgent/3000/` and invoke tools through `/umamiAgent/mcp`. Umami's built-in MCP endpoint must not become a public endpoint. A Next.js or ingress process failure, or a failed bootstrap phase, must stop the supervised stack. Persistent PostgreSQL storage preserves analytics across restarts.

The `db` bootstrap phase upserts the internal API key row from `UMAMI_INTERNAL_KEY_SEED` and, only when `UMAMI_ADMIN_PASSWORD` is set (at least 16 characters), resets the `admin` account to that password. The `api` phase creates, updates or verifies each website in `UMAMI_SEED_WEBSITES` through Umami's API and fails when an id belongs to another user. Repeating either phase with unchanged input must make no writes and must say so.

### Tracker settings

A workspace operator opens [Umami Settings](wiki.html#definition-tracker-settings). The plugin must load the existing website list through `umami_websites_list`, let the operator select a website and browser-reachable Umami URL (defaulting to the public Router publication on the Explorer's origin), and produce a snippet using that URL's `/script.js`. The plugin must show MCP errors and must not create websites. Browser events must go directly to the selected Umami endpoint rather than through the reporting agent. Reopening the modal reloads websites added in the dashboard.
