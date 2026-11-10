# umamiAgent

`umamiAgent` is the AchillesIDE read-only Umami agent. It exposes Umami data through Ploinky MCP tools declared in `mcp-config.json`.

## Runtime

Read `docs/index.html`, `docs/specs/matrix.md`, and `docs/specs/DS001-coding-style.md` before changing documented behavior. `docs/wiki.html` is the canonical terminology source. Update HTML documentation and the affected DS contracts together when runtime, tools, or operator workflows change. Specifications have exactly `title` and `summary` frontmatter fields and only `Introduction` and `Core Content` as top-level content sections.

- The custom supervisor starts AgentServer on container port `7000`; browser MCP calls use the Router-mediated `/umamiAgent/mcp` route so Ploinky can mint the per-tool secure-wire authorization required by AgentServer.
- `umamiAgent` is the only Ploinky agent in the Umami stack.
- The manifest pins an immutable `docker.io/assistos/umami-agent` image digest that has passed native runtime checks on both supported architectures.
- The image preserves the pinned PostgreSQL, Bun, and built `MadsNyl/umami-mcp` runtime and builds Umami `3.2.0` from immutable upstream source with the Router publication path compiled in.
- `scripts/start-umami-agent.sh` supervises PostgreSQL, Umami, the internal Umami MCP server, and Ploinky AgentServer.
- Ploinky replacements (reinstall, image update) start the successor while the predecessor still runs on the same storage. The start script holds an exclusive `flock` on `umami-postgres.lock` beside `PGDATA`; a successor that finds it held starts only AgentServer (so readiness passes and Ploinky retires the predecessor), waits for the lock, then starts PostgreSQL and Umami. Never start PostgreSQL before taking that lock.
- The Umami dashboard ingress stays container-local on port `3000` and authenticated browsers reach it through `/base-agent-additional-server/umamiAgent/3000/`. Next.js listens only on `127.0.0.1:3001` behind that ingress.
- The image compiles the exact Router publication prefix as its build-time `BASE_PATH`. Startup validates `/app/ploinky-umami-build.json` and the Next build configuration. Never patch compiled HTML/JavaScript or expose a root `/_next` Router alias to compensate for a mismatched image.
- The internal Umami API URL is `http://127.0.0.1:3000`.
- `script.js` and `api/send` under the Router publication are the only public routes (tracker traffic from anonymous site visitors). The ingress replaces Umami's wildcard CORS on `api/send` with the exact caller origin, because the Router drops wildcard CORS. Do not make other Umami paths public.
- The manifest omits `network` so Ploinky assigns the isolated per-agent default network; the embedded services communicate over container loopback and do not need a shared network or custom alias.
- PostgreSQL data persists in the agent root storage at `/root/postgres`, mapped by Ploinky to the workspace `.data` area.
- The MCP implementation runs `MadsNyl/umami-mcp` internally as an HTTP MCP server on `127.0.0.1:${UMAMI_MCP_PORT:-7301}`; do not expose that upstream MCP server directly to Ploinky.
- `IDE-plugins/umami-tool-button/` adds the `Umami` file-explorer toolbar button, which registers `umami-settings` through the Explorer settings-component loader and opens it as a fullscreen component panel (`openExpandedModal`, mode `component`); embedded there, the component hides its own modal header. That modal's `Open Dashboard` button opens `/base-agent-additional-server/umamiAgent/3000/websites` in a new tab.
- `IDE-plugins/umami-settings/` registers the AchillesIDE `Umami Settings` settings modal and generates browser snippets for Umami's public `/script.js`.

## Security

Read-only applies to upstream Umami data. `umami_report_generate` may write a local Markdown deliverable under `UMAMI_OUTPUT_DIR` and return its path. Do not broaden the upstream tool allow-list on that basis.

- Keep all public MCP tools explicit in `mcp-config.json`.
- Do not add a generic pass-through Umami tool.
- Do not expose Umami write/admin/user/team/website-CRUD/event-ingestion tools.
- Keep Umami database passwords, app secrets, login passwords, and tokens out of tracked files.
- Use Ploinky vars or environment overrides for production credentials.
- Website tracking snippets must send events to Umami, not to `umamiAgent`.
- Do not add `guest: true` only to make the settings plugin load. Use explicit `routerAccess.httpRoutes` for static plugin assets so `/mcp` does not become guest-enabled.

## Local Setup

Starting `umamiAgent` should not enable separate Umami infrastructure agents. Ploinky generates the Umami app and MCP secrets for this single agent. PostgreSQL uses fixed loopback-only credentials (`admin` / `admin` by default, overridable through `POSTGRES_USER` / `POSTGRES_PASSWORD`) that the start script re-applies to the existing data directory on every start, so the database survives a recreated workspace master key.

Default Umami login from upstream is `admin` / `umami`. Change it after first login, then configure `UMAMI_PASSWORD` for the read-only MCP adapter OAuth bootstrap.
