---
id: DS01
title: Analytics DB
status: implemented
owner: achilleside-team
summary: Defines the Ploinky-managed PostgreSQL service used by the Umami analytics stack.
---

# DS01 - Analytics DB

## Core Content

`analyticsDB` is a Ploinky service agent that runs `postgres:16-alpine` for the Umami analytics stack.

The agent joins the shared `analytics` network as `analytics-db`. It exposes PostgreSQL only on the host-local debug binding `127.0.0.1:15432:5432` and persists database files under `.ploinky/data/analyticsDB/postgres`.

`POSTGRES_PASSWORD` is sourced from the Ploinky-generated shared secret `UMAMI_POSTGRES_PASSWORD`. The same secret is consumed by `analyticsInfra`.

## Decisions & Questions

### Question #1: Why make PostgreSQL a separate Ploinky agent?

Response:
Keeping PostgreSQL as `analyticsDB` makes database lifecycle, persistence, networking, and secret sharing explicit in Ploinky instead of hiding them inside a host-side compose process.
