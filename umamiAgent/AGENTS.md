# umamiAgent

`umamiAgent` is the AchillesIDE read-only Umami agent. It exposes Umami data through Ploinky MCP tools declared in `mcp-config.json`.

## Runtime

Read `docs/index.html`, `docs/specs/matrix.md`, and `docs/specs/DS001-coding-style.md` before changing documented behavior. `docs/wiki.html` is the canonical terminology source. Update HTML documentation and the affected DS contracts together when runtime, tools, or operator workflows change. Specifications have exactly `title` and `summary` frontmatter fields and only `Introduction` and `Core Content` as top-level content sections.

- The custom supervisor starts AgentServer on container port `7000`; browser MCP calls use the Router-mediated `/umamiAgent/mcp` route so Ploinky can mint the per-tool secure-wire authorization required by AgentServer.
- `umamiAgent` is the only Ploinky agent in the Umami stack.
- The manifest pins an immutable `docker.io/assistos/umami-agent` image digest that has passed native runtime checks on both supported architectures.
- The image provides Node.js, PostgreSQL 18 and Umami `3.4.1` built from immutable upstream source with the Router publication path compiled in. It has no Bun and no separate MCP server.
- `scripts/start-umami-agent.sh` supervises PostgreSQL, Umami, and Ploinky AgentServer, and runs `scripts/umami-bootstrap.mjs db` before Umami starts and `api` once it is healthy.
- Ploinky replacements (reinstall, image update) start the successor while the predecessor still runs on the same storage. The start script holds an exclusive `flock` on `umami-postgres.lock` beside `PGDATA`; a successor that finds it held starts only AgentServer (so readiness passes and Ploinky retires the predecessor), waits for the lock, then starts PostgreSQL and Umami. Never start PostgreSQL before taking that lock.
- The Umami dashboard ingress stays container-local on port `3000` and authenticated browsers reach it through `/base-agent-additional-server/umamiAgent/3000/`. Next.js listens only on `127.0.0.1:3001` behind that ingress.
- The image compiles the exact Router publication prefix as its build-time `BASE_PATH`. Startup validates `/app/ploinky-umami-build.json` and the Next build configuration. Never patch compiled HTML/JavaScript or expose a root `/_next` Router alias to compensate for a mismatched image.
- The internal Umami API URL is `http://127.0.0.1:3000`.
- `script.js` and `api/send` under the Router publication are the only public routes (tracker traffic from anonymous site visitors); `manifest-contract.test.mjs` pins that. The ingress replaces Umami's wildcard CORS on `api/send` with the exact caller origin, because the Router drops wildcard CORS. Same-origin tracking works (for example a tracker on the Explorer's own origin). Cross-origin tracking from other websites does not yet: the Router rebuilds CORS on public routes and allows only the `authorization` and `content-type` request headers, so a preflight for the tracker's `x-umami-website-id` and `x-umami-hostname` headers fails whatever the ingress sends. It needs a Router change to the allowed headers for `allowCors` public routes, tracked as a Ploinky follow-up. Do not make other Umami paths public.
- The manifest omits `network` so Ploinky assigns the isolated per-agent default network; the embedded services communicate over container loopback and do not need a shared network or custom alias.
- PostgreSQL data persists in the agent root storage at `/root/postgres`, mapped by Ploinky to the workspace `.data` area.
- The MCP implementation is Umami's built-in `/mcp` endpoint (`MCP_ENABLED=1`, API keys only). `tools/umami_tool.mjs` calls it over loopback with `Bearer umami_<UMAMI_INTERNAL_KEY_SEED>`; the ingress must keep answering `404` to Router-forwarded requests for it (`x-forwarded-prefix` present), in every encoded and dot-segment spelling.
- `scripts/umami-bootstrap.mjs` is the only writer of the internal `api_key` row and of the enforced admin password (`UMAMI_ADMIN_PASSWORD`, only when set). It must stay idempotent and must never put a password, seed, key or hash in argv or logs; database access is `psql` with `PGPASSWORD` and SQL on stdin.
- `IDE-plugins/umami-tool-button/` adds the `Umami` file-explorer toolbar button, which registers `umami-settings` through the Explorer settings-component loader and opens it as a fullscreen component panel (`openExpandedModal`, mode `component`); embedded there, the component hides its own modal header. That modal's `Open Dashboard` button opens `/base-agent-additional-server/umamiAgent/3000/websites` in a new tab.
- `IDE-plugins/umami-settings/` registers the AchillesIDE `Umami Settings` settings modal and generates browser snippets for Umami's public `/script.js`.

## Security

Read-only applies to upstream Umami data. `umami_report_generate` may write a local Markdown deliverable under `UMAMI_OUTPUT_DIR` and return its path. Do not broaden the upstream tool allow-list on that basis.

- Keep all public MCP tools explicit in `mcp-config.json`, each mapped 1:1 onto one built-in Umami tool in `tools/umami_tool.mjs`.
- Do not add a generic pass-through Umami tool.
- Do not expose Umami write/admin/user/team/website-CRUD/event-ingestion tools.
- Keep Umami database passwords, app secrets, login passwords, and tokens out of tracked files.
- Use Ploinky vars or environment overrides for production credentials.
- Website tracking snippets must send events to Umami, not to `umamiAgent`.
- Do not add `guest: true` only to make the settings plugin load. Use explicit `routerAccess.httpRoutes` for static plugin assets so `/mcp` does not become guest-enabled.

## Local Setup

Starting `umamiAgent` should not enable separate Umami infrastructure agents. Ploinky generates the Umami app secret and the internal API key seed (`UMAMI_INTERNAL_KEY_SEED`) for this single agent. PostgreSQL uses fixed loopback-only credentials (`admin` / `admin` by default, overridable through `POSTGRES_USER` / `POSTGRES_PASSWORD`) that the start script re-applies to the existing data directory on every start, so the database survives a recreated workspace master key.

Default Umami login from upstream is `admin` / `umami`. Set `UMAMI_ADMIN_PASSWORD` (a Ploinky variable) to have every start enforce a password instead; the tools do not depend on it because they use the internal API key.
