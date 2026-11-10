import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const BASE = '/base-agent-additional-server/umamiAgent/3000';

test('exactly the two tracker routes are public and nothing else under /api is', () => {
    const routes = manifest.routerAccess.httpRoutes;
    const publicRoutes = routes.filter((route) => route.access === 'public');
    assert.deepEqual(publicRoutes, [
        { path: `${BASE}/script.js`, access: 'public' },
        { path: `${BASE}/api/send`, access: 'public', publicProtocol: { methods: ['POST', 'OPTIONS'], allowCors: true } },
    ]);
    for (const route of routes) {
        assert.ok(!/\*/.test(route.path) || route.access === 'guest', `${route.path} may only be a wildcard when it is a guest plugin asset`);
        if (route.path.includes('/api/') && route.path !== `${BASE}/api/send`) assert.notEqual(route.access, 'public', route.path);
        if (route.access === 'public') {
            assert.ok(route.path.startsWith(`${BASE}/`));
            assert.ok(!route.path.includes('/mcp'), 'the built-in MCP endpoint is never routed publicly');
        }
    }
    assert.deepEqual(routes.filter((route) => route.access === 'guest').map((route) => route.path), [
        '/IDE-plugins/umami-settings/*', '/IDE-plugins/umami-tool-button/*',
    ]);
    assert.equal(manifest.guest, undefined);
    assert.equal(manifest.routerAccess.requiredCapability, 'explorer.access');
});

test('the environment declares the internal key, admin password and seeded websites and drops the old MCP credentials', () => {
    const env = manifest.profiles.default.env;
    assert.deepEqual(env.UMAMI_INTERNAL_KEY_SEED, { required: true, generatedSecret: true });
    assert.deepEqual(env.UMAMI_ADMIN_PASSWORD, { required: false });
    assert.deepEqual(env.UMAMI_SEED_WEBSITES, { required: false });
    for (const removed of ['MCP_SECRET', 'UMAMI_USERNAME', 'UMAMI_PASSWORD', 'UMAMI_TOKEN', 'UMAMI_MCP_PORT', 'UMAMI_MCP_SQLITE_PATH', 'OAUTH_CLIENT_ID', 'OAUTH_REDIRECT_URI']) {
        assert.equal(Object.hasOwn(env, removed), false, removed);
    }
    assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('OAUTH_')), []);
    assert.deepEqual(Object.keys(env).sort(), [
        'APP_SECRET', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER', 'UMAMI_ADMIN_PASSWORD', 'UMAMI_BASE_URL',
        'UMAMI_DEFAULT_WEBSITE_ID', 'UMAMI_INTERNAL_KEY_SEED', 'UMAMI_OUTPUT_DIR', 'UMAMI_SEED_WEBSITES', 'UMAMI_TIMEZONE',
    ]);
    // Secrets live in Ploinky variables, never as manifest defaults.
    for (const name of ['UMAMI_INTERNAL_KEY_SEED', 'UMAMI_ADMIN_PASSWORD', 'UMAMI_SEED_WEBSITES']) assert.equal(Object.hasOwn(env[name], 'default'), false);
});

test('the supervisor runs the 3.4.1 scripts and both bootstrap phases and no longer starts the old MCP server', () => {
    const script = read('scripts/start-umami-agent.sh');
    for (const gone of ['bun', 'umami-mcp', 'MCP_SECRET', 'OAUTH', 'SQLITE', 'curl', 'check-db', 'update-tracker.js']) {
        assert.ok(!script.includes(gone), `${gone} must be gone from the start script`);
    }
    assert.match(script, /^export MCP_ENABLED=1$/m);
    assert.match(script, /run check:db$/m);
    assert.match(script, /run update:tracker$/m);
    const order = ['run check:db', 'umami-bootstrap.mjs db', 'node server.js &', 'umami-ingress.mjs &', 'umami-bootstrap.mjs api', 'start_agent_server\nfi'];
    const positions = order.map((marker) => script.indexOf(marker));
    assert.ok(positions.every((position) => position > 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'db bootstrap before Next, api bootstrap after health and before AgentServer');
    // The bootstrap phases are plain commands under `set -eu`: nothing may swallow, background or chain their failure.
    assert.match(script, /^set -eu$/m);
    for (const phase of ['db', 'api']) {
        const lines = script.split('\n');
        const index = lines.findIndex((line) => line.includes(`umami-bootstrap.mjs ${phase}`));
        assert.ok(index > 0, phase);
        assert.match(lines[index], new RegExp(`^    node /code/scripts/umami-bootstrap\\.mjs ${phase}$`));
        assert.match(lines[index - 1], /^UMAMI_INTERNAL_KEY_SEED="\$\{internal_key_seed\}".* \\$/, 'a plain environment assignment prefix');
        assert.ok(!/(\|\||&|;|\|)/.test(lines[index]) && !/(\|\||&&|;)/.test(lines[index - 1].replace(/\\$/, '')), `${phase} bootstrap line is not chained`);
        assert.ok(!/^\s*(if|while|until|!)\b/.test(lines[index - 1]) && !/^\s*(if|while|until)\b/.test(lines[index]));
    }
    // The teammate's replacement lock and role sync stay in front of everything that starts PostgreSQL.
    assert.ok(script.indexOf('flock -n 9') < script.indexOf('initdb'));
    assert.ok(script.indexOf('postgres --single') < script.indexOf('-p 5432'));
    assert.match(script, /unix_socket_directories=''/);
    // The seed and password are scrubbed from the environment of every service except the bootstrap and AgentServer.
    assert.match(script, /^unset UMAMI_INTERNAL_KEY_SEED UMAMI_ADMIN_PASSWORD$/m);
    assert.match(script, /UMAMI_INTERNAL_KEY_SEED="\$\{internal_key_seed\}" PORT=.* sh \/Agent\/server\/AgentServer\.sh &/);
    assert.ok(!/echo .*(internal_key_seed|admin_password)/.test(script));
});
