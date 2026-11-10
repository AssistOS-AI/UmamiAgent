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

test('umami settings are registered without guest-enabling MCP', async () => {
    const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

    assert.equal(manifest.guest, undefined);
    assert.equal(manifest.agent, 'sh /code/scripts/start-umami-agent.sh');
    assert.equal(manifest.container, 'docker.io/assistos/umami-agent@sha256:346a68283a88129f10c56ac940929dafbbf12f9b7cece3169d11d6a9f359ec93');
    assert.equal(manifest.enable, undefined);
    assert.equal(manifest.profiles.default.additionalServerPort, undefined);
    assert.equal(manifest.openPorts, undefined);
    assert.equal(manifest.ports, undefined);
    assert.equal(manifest.volumes, undefined);
    assert.equal(manifest.network, undefined);
    assert.equal(manifest.profiles.default.env.POSTGRES_PASSWORD.sharedGeneratedSecret, undefined);
    assert.equal(manifest.profiles.default.env.POSTGRES_USER.default, 'admin');
    assert.equal(manifest.profiles.default.env.POSTGRES_PASSWORD.default, 'admin');
    assert.equal(manifest.profiles.default.env.APP_SECRET.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.UMAMI_BASE_URL.default, 'http://127.0.0.1:3000');
    assert.equal(manifest.profiles.default.env.UMAMI_INTERNAL_KEY_SEED.generatedSecret, true);
    assert.equal(manifest.profiles.default.env.UMAMI_INTERNAL_KEY_SEED.required, true);
    assert.equal(manifest.profiles.default.env.UMAMI_ADMIN_PASSWORD.required, false);
    assert.equal(manifest.profiles.default.env.UMAMI_SEED_WEBSITES.required, false);
    assert.deepEqual(manifest.readiness, { protocol: 'mcp' });
    // No script: the block only sizes the MCP wait (2 + 2 s x 75 = 300 s) for restarts too.
    assert.deepEqual(manifest.health, { readiness: { interval: 2, timeout: 2, failureThreshold: 75, successThreshold: 1 } });
    assert.equal(manifest.routerAccess.requiredCapability, 'explorer.access');
    assert.equal(
        manifest.routerAccess.capabilityDeniedRedirect,
        '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/'
    );
    assert.deepEqual(manifest.routerAccess.httpRoutes, [
        {
            path: '/IDE-plugins/umami-settings/*',
            access: 'guest'
        },
        {
            path: '/IDE-plugins/umami-tool-button/*',
            access: 'guest'
        },
        {
            path: '/base-agent-additional-server/umamiAgent/3000/script.js',
            access: 'public'
        },
        {
            path: '/base-agent-additional-server/umamiAgent/3000/api/send',
            access: 'public',
            publicProtocol: {
                methods: ['POST', 'OPTIONS'],
                allowCors: true,
                allowHeaders: ['content-type', 'x-umami-website-id', 'x-umami-hostname', 'x-umami-cache']
            }
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

test('umami tool calls Umami\'s built-in MCP endpoint with the internal API key', async () => {
    const source = await fs.readFile(TOOL_JS, 'utf8');
    assert.match(source, /class McpHttpClient/);
    assert.match(source, /\/mcp/);
    assert.match(source, /UMAMI_INTERNAL_KEY_SEED/);
    assert.match(source, /toIsoTimestamp/);
    for (const removed of ['bootstrapOAuthToken', '/oauth/authorize', '/oauth/token', 'get_active_visitors', 'UMAMI_PASSWORD', 'MadsNyl', 'StdioMcpClient']) {
        assert.ok(!source.includes(removed), `${removed} must be gone`);
    }
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
    assert.match(source, /base-agent-additional-server/);
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
    assert.match(source, /const UMAMI_MCP_PATH = '\/umamiAgent\/mcp';/);
    assert.match(source, /createAgentClient\(UMAMI_MCP_PATH\)/);
    assert.ok(!source.includes('UMAMI_AGENT_SERVER_PORT'));
    assert.match(source, /umami_websites_list/);
    assert.ok(!source.includes('/umamiAgent/mcp/script'));
    assert.match(markup, /id="umamiWebsiteSelect"/);
    assert.ok(!source.includes('umamiLoadWebsitesButton'));
    assert.ok(!markup.includes('Refresh Websites'));
    assert.ok(!markup.includes('umamiLoadWebsitesButton'));
    assert.ok(!markup.includes('Website UUID fallback'));
    assert.match(markup, /data-local-action="copyScriptCode"/);
});

test('umami toolbar button opens the Umami Settings popup', async () => {
    const config = JSON.parse(await fs.readFile(path.join(ROOT, 'IDE-plugins', 'umami-tool-button', 'config.json'), 'utf8'));
    assert.equal(config.component, 'umami-tool-button');
    assert.equal(config.presenter, 'UmamiToolButton');
    assert.deepEqual(config.location, ['file-exp:toolbar']);
    assert.equal(config.toolbarModal, undefined);
    const source = await fs.readFile(path.join(ROOT, 'IDE-plugins', 'umami-tool-button', 'umami-tool-button.js'), 'utf8');
    assert.match(source, /export class UmamiToolButton/);
    assert.match(source, /ensureSettingsComponentRegistered/);
    assert.match(source, /openExpandedModal\(\{\s*mode: 'component',\s*component: UMAMI_SETTINGS_COMPONENT/);
    assert.ok(source.includes("'/base-agent-additional-server/umamiAgent/3000/websites'"));
});

test('Open Dashboard targets the Umami websites page', async () => {
    const source = await fs.readFile(SETTINGS_JS, 'utf8');
    assert.ok(source.includes('/${UMAMI_APP_PORT}/websites`'));
});
