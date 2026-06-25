---
id: DS01
title: Analytics Infra
status: implemented
owner: achilleside-team
summary: Defines the Ploinky-managed Umami application service used by analyticsAgent.
---

# DS01 - Analytics Infra

## Core Content

`analyticsInfra` is a Ploinky service agent that runs the official Umami image `docker.umami.is/umami-software/umami:postgresql-latest`.

The agent depends on `analyticsDB`, joins the shared `analytics` network as `analytics-umami`, and binds the Umami dashboard to `127.0.0.1:3000:3000` for local browser access.

`scripts/startUmami.sh` constructs `DATABASE_URL` from Ploinky-provided environment values and starts Umami with `pnpm start-docker`. `POSTGRES_PASSWORD` comes from the shared generated secret `UMAMI_POSTGRES_PASSWORD`; `APP_SECRET` comes from the shared generated secret `UMAMI_APP_SECRET`.

## Decisions & Questions

### Question #1: Why expose the dashboard on a host-local port?

Response:
The Umami dashboard is an application UI, not a Ploinky MCP surface. Binding it to `127.0.0.1:3000` lets a local operator configure websites and copy tracking snippets while keeping the public Ploinky MCP boundary unchanged.
