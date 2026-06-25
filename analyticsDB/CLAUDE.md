# analyticsDB

`analyticsDB` runs PostgreSQL for the Umami stack.

- Runtime image: `postgres:16-alpine`
- Network alias: `analytics-db`
- Persistent data: `.ploinky/data/analyticsDB/postgres`
- Host debug port: `127.0.0.1:15432`

This agent should stay infrastructure-only and should not expose MCP tools.
