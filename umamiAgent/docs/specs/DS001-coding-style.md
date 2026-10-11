---
title: DS001-coding-style
summary: Defines Node.js modules, script boundaries, source organization, and focused regression tests.
---

## Introduction

This specification governs executable maintenance in `umamiAgent`. Runtime adapters and ingress code use Node.js ES modules and built-in APIs.

## Core Content

New Node.js executable modules must use `.mjs`, explicit relative import extensions, `node:` built-ins, and async/await. Existing browser `.js` files remain browser scripts. New dependencies require a concrete need and an owning dependency record; the existing source-built Umami, PostgreSQL, Bun, and upstream MCP runtime remain image dependencies rather than npm dependencies added by the agent package.

`tools/umami_tool.mjs` owns analytics input validation, upstream MCP calls, redaction, and report files. `scripts/start-umami-agent.sh` owns process supervision. `scripts/umami-ingress.mjs` owns fixed-prefix relay and build validation. `IDE-plugins/umami-settings/` owns settings presentation and snippet generation. JSON uses two-space indentation; JavaScript follows the neighboring file's established style.

Tests use `node:test` and `node:assert/strict` under `tests/`. Run `npm test` from `umamiAgent/` for settings, ingress, and supervisor contracts. Local checks cannot establish native image or deployed Router behavior. Secrets, login tokens, and analytics payloads must not be printed in test evidence.
