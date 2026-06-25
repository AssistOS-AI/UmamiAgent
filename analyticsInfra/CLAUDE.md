# analyticsInfra

`analyticsInfra` runs the self-hosted Umami app used by `analyticsAgent`.

- Runtime image: `docker.umami.is/umami-software/umami:postgresql-latest`
- Dependency: `analyticsDB`
- Network alias: `analytics-umami`
- Host dashboard: `http://127.0.0.1:3000`
- Internal API URL: `http://analytics-umami:3000`

This agent should stay infrastructure-only and should not expose MCP tools.
