import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const CONFIG = path.join(ROOT, 'IDE-plugins', 'umami-settings', 'config.json');
const MCP_CONFIG = path.join(ROOT, 'mcp-config.json');
const TOOL_JS = path.join(ROOT, 'tools', 'umami_tool.mjs');
const SETTINGS_JS = path.join(ROOT, 'IDE-plugins', 'umami-settings', 'umami-settings.js');
const SETTINGS_HTML = path.join(ROOT, 'IDE-plugins', 'umami-settings', 'umami-settings.html');
const START_SCRIPT = path.join(ROOT, 'scripts', 'start-umami-agent.sh');

test('umami settings are registered without guest-enabling MCP', async () => {
    const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

    assert.equal(manifest.guest, undefined);
    assert.equal(manifest.agent, 'sh /code/scripts/start-umami-agent.sh');
    assert.equal(manifest.container, 'docker.io/assistos/umami-agent@sha256:0d38f97dbe4407f80418d05c9ab6cdc4452f9b62dbaa462d6c84884bb551c566');
    assert.deepEqual(manifest.network, { mode: 'default' });
    assert.equal(JSON.stringify(manifest.network).includes('aliases'), false);
    assert.equal(manifest.enable, undefined);
    assert.equal(Object.hasOwn(manifest.profiles.default, ['additional', 'Server', 'Port'].join('')), false);
    assert.equal(Object.hasOwn(manifest.profiles.default, 'openPorts'), false);
    assert.equal(manifest.volumes, undefined);
    assert.equal(manifest.profiles.default.env.POSTGRES_PASSWORD.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.APP_SECRET.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.UMAMI_PASSWORD.required, true);
    assert.equal(manifest.profiles.default.env.UMAMI_PASSWORD.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.UMAMI_PASSWORD.default, undefined);
    assert.equal(manifest.profiles.default.env.UMAMI_TELEMETRY_ALLOWED_ORIGINS.required, true);
    assert.equal(manifest.profiles.default.env.UMAMI_TELEMETRY_ALLOWED_ORIGINS.default, undefined);
    assert.equal(manifest.profiles.default.env.UMAMI_TELEMETRY_PER_SOURCE_PER_MINUTE.default, '120');
    assert.equal(Object.hasOwn(manifest.profiles.default.env, 'UMAMI_TELEMETRY_PER_ORIGIN_PER_MINUTE'), false);
    assert.deepEqual(manifest.httpServices, [
        {
            slug: 'umami-dashboard',
            port: 3000,
            externalPrefix: '/services/umami/',
            internalPrefix: '/services/umami/',
            access: 'authenticated'
        },
        {
            slug: 'umami-telemetry',
            port: 3001,
            externalPrefix: '/public-services/umami-telemetry/',
            internalPrefix: '/',
            access: 'guest',
            invocation: false,
            includeAuthInfo: false
        }
    ]);
    assert.equal(manifest.profiles.default.env.UMAMI_MCP_PORT.default, '7301');
    assert.equal(manifest.profiles.default.env.MCP_SECRET.sharedGeneratedSecret, true);
    assert.deepEqual(manifest.routerAccess.httpRoutes, [
        {
            path: '/IDE-plugins/umami-settings/*',
            access: 'guest'
        }
    ]);
    assert.deepEqual(manifest.ideSettings, [
        {
            key: 'umami-settings',
            label: 'Umami Settings',
            scope: 'workspace',
            pluginKey: 'umamiAgent/umami-settings',
            settingsComponent: 'umami-settings',
            adminOnly: false
        }
    ]);
    assert.equal(config.pluginCategory, 'application');
    assert.equal(config.id, 'umami-settings');
    assert.equal(config.settings, 'umami-settings');
});

test('umami tool uses local HTTP MCP and OAuth bootstrap for MadsNyl', async () => {
    const source = await fs.readFile(TOOL_JS, 'utf8');
    assert.match(source, /class HttpMcpClient/);
    assert.match(source, /bootstrapOAuthToken/);
    assert.match(source, /\/oauth\/authorize/);
    assert.match(source, /\/oauth\/token/);
    assert.match(source, /\/mcp/);
    assert.match(source, /get_active_visitors/);
    assert.match(source, /toIsoTimestamp/);
    assert.ok(!source.includes('@madsnyl/umami-mcp'));
    assert.ok(!source.includes('StdioMcpClient'));
    assert.ok(!source.includes("process.env.UMAMI_PASSWORD) || 'umami'"));
    assert.match(source, /UMAMI_PASSWORD is required/);
});

test('umami startup fails before launching dependencies without explicit password and telemetry origins', async () => {
    const source = await fs.readFile(START_SCRIPT, 'utf8');
    assert.match(source, /UMAMI_PASSWORD:\?UMAMI_PASSWORD is required/);
    assert.match(source, /UMAMI_TELEMETRY_ALLOWED_ORIGINS:\?UMAMI_TELEMETRY_ALLOWED_ORIGINS is required/);
    assert.ok(source.indexOf('UMAMI_TELEMETRY_ALLOWED_ORIGINS:?') < source.indexOf('postgres -D'));
});

test('umami MCP schemas use AgentServer property-map shape', async () => {
    const config = JSON.parse(await fs.readFile(MCP_CONFIG, 'utf8'));
    const websitesList = config.tools.find((tool) => tool.name === 'umami_websites_list');
    const statsGet = config.tools.find((tool) => tool.name === 'umami_stats_get');

    assert.deepEqual(websitesList.inputSchema, {});
    assert.ok(!Object.hasOwn(statsGet.inputSchema, 'type'));
    assert.ok(!Object.hasOwn(statsGet.inputSchema, 'properties'));
    assert.deepEqual(statsGet.inputSchema.startAt, { type: 'number', optional: false });
});

test('umami settings generate Umami script snippets', async () => {
    const source = await fs.readFile(SETTINGS_JS, 'utf8');
    const markup = await fs.readFile(SETTINGS_HTML, 'utf8');

    assert.match(source, /\/script\.js/);
    assert.match(source, /\/api\/edge\/topology/);
    assert.match(source, /cache: 'no-store'/);
    assert.ok(!source.includes('.localhost'));
    assert.ok(!source.includes('const dashboardUrl = normalizeUrl(this.state.umamiUrl'));
    assert.match(source, /data-website-id/);
    assert.ok(!source.includes('data-domains'));
    assert.ok(!source.includes('data-auto-track'));
    assert.ok(!markup.includes('Allowed Domains'));
    assert.ok(!markup.includes('Script Mode'));
    assert.match(source, /UUID_PATTERN/);
    assert.match(source, /website_id/);
    assert.match(source, /result\?\.data/);
    assert.match(source, /umamiWebsiteSelect/);
    assert.match(source, /decodeToolPayload/);
    assert.match(source, /MCP error/);
    assert.match(source, /console\.error/);
    assert.match(source, /createAgentClient\('\/umamiAgent\/mcp'\)/);
    assert.match(source, /umami_websites_list/);
    assert.ok(!source.includes('/umamiAgent/mcp/script'));
    assert.match(markup, /id="umamiWebsiteSelect"/);
    assert.ok(!source.includes('umamiLoadWebsitesButton'));
    assert.ok(!markup.includes('Refresh Websites'));
    assert.ok(!markup.includes('umamiLoadWebsitesButton'));
    assert.ok(!markup.includes('Website UUID fallback'));
    assert.match(markup, /data-local-action="copyScriptCode"/);
});

test('umami topology locator consumes the canonical Router browserUrl response', async () => {
    const { resolveTopologyLocator } = await import(`${new URL('../IDE-plugins/umami-settings/umami-settings.js', import.meta.url).href}?topology=${Date.now()}`);
    const requests = [];
    const result = await resolveTopologyLocator('umami-dashboard', async (url, options) => {
        requests.push({ url: String(url), options });
        return {
            ok: true,
            async json() {
                return { browserUrl: 'https://analytics.example.test/services/umami/' };
            }
        };
    });

    assert.equal(result, 'https://analytics.example.test/services/umami');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^\/api\/edge\/topology\?/);
    assert.equal(requests[0].options.cache, 'no-store');

    await assert.rejects(
        () => resolveTopologyLocator('umami-dashboard', async () => ({
            ok: true,
            async json() {
                return { activeBrowserUrl: 'https://legacy.example.test/' };
            }
        })),
        /no active browser URL/,
    );
});
