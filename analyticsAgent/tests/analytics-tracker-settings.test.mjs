import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const CONFIG = path.join(ROOT, 'IDE-plugins', 'analytics-tracker', 'config.json');
const MCP_CONFIG = path.join(ROOT, 'mcp-config.json');
const TOOL_JS = path.join(ROOT, 'tools', 'analytics_tool.mjs');
const SETTINGS_JS = path.join(ROOT, 'IDE-plugins', 'analytics-tracker', 'analytics-tracker-settings', 'analytics-tracker-settings.js');
const SETTINGS_HTML = path.join(ROOT, 'IDE-plugins', 'analytics-tracker', 'analytics-tracker-settings', 'analytics-tracker-settings.html');

test('analytics tracker settings are registered without guest-enabling MCP', async () => {
    const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

    assert.equal(manifest.guest, undefined);
    assert.equal(manifest.agent, 'sh /code/scripts/start-analytics-agent.sh');
    assert.equal(manifest.container, 'docker.io/assistos/analytics-agent:umami-stack');
    assert.equal(manifest.enable, undefined);
    assert.deepEqual(manifest.profiles.default.ports, [
        '127.0.0.1:0:7000',
        '127.0.0.1:3000:3000'
    ]);
    assert.deepEqual(manifest.volumes, {
        '.ploinky/data/analyticsAgent/postgres': '/var/lib/postgresql/data'
    });
    assert.equal(manifest.profiles.default.env.POSTGRES_PASSWORD.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.APP_SECRET.sharedGeneratedSecret, true);
    assert.equal(manifest.profiles.default.env.UMAMI_BASE_URL.default, 'http://127.0.0.1:3000');
    assert.equal(manifest.profiles.default.env.UMAMI_MCP_PORT.default, '7301');
    assert.equal(manifest.profiles.default.env.MCP_SECRET.sharedGeneratedSecret, true);
    assert.deepEqual(manifest.routerAccess.httpRoutes, [
        {
            path: '/IDE-plugins/analytics-tracker/*',
            access: 'guest'
        }
    ]);
    assert.deepEqual(manifest.ideSettings, [
        {
            key: 'analytics-tracker',
            label: 'Analytics Tracker',
            scope: 'workspace',
            pluginKey: 'analyticsAgent/analytics-tracker',
            settingsComponent: 'analytics-tracker-settings',
            adminOnly: false
        }
    ]);
    assert.equal(config.pluginCategory, 'application');
    assert.equal(config.id, 'analytics-tracker');
    assert.equal(config.settings, 'analytics-tracker-settings');
});

test('analytics tool uses local HTTP MCP and OAuth bootstrap for MadsNyl', async () => {
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
});

test('analytics MCP schemas use AgentServer property-map shape', async () => {
    const config = JSON.parse(await fs.readFile(MCP_CONFIG, 'utf8'));
    const websitesList = config.tools.find((tool) => tool.name === 'analytics_websites_list');
    const statsGet = config.tools.find((tool) => tool.name === 'analytics_stats_get');

    assert.deepEqual(websitesList.inputSchema, {});
    assert.ok(!Object.hasOwn(statsGet.inputSchema, 'type'));
    assert.ok(!Object.hasOwn(statsGet.inputSchema, 'properties'));
    assert.deepEqual(statsGet.inputSchema.startAt, { type: 'number', optional: false });
});

test('analytics tracker settings generate Umami script snippets', async () => {
    const source = await fs.readFile(SETTINGS_JS, 'utf8');
    const markup = await fs.readFile(SETTINGS_HTML, 'utf8');

    assert.match(source, /\/script\.js/);
    assert.match(source, /data-website-id/);
    assert.ok(!source.includes('data-domains'));
    assert.ok(!source.includes('data-auto-track'));
    assert.ok(!markup.includes('Allowed Domains'));
    assert.ok(!markup.includes('Script Mode'));
    assert.match(source, /UUID_PATTERN/);
    assert.match(source, /website_id/);
    assert.match(source, /result\?\.data/);
    assert.match(source, /analyticsWebsiteSelect/);
    assert.match(source, /decodeToolPayload/);
    assert.match(source, /MCP error/);
    assert.match(source, /console\.error/);
    assert.match(source, /createAgentClient\('\/analyticsAgent\/mcp'\)/);
    assert.match(source, /analytics_websites_list/);
    assert.ok(!source.includes('/analyticsAgent/mcp/script'));
    assert.match(markup, /id="analyticsWebsiteSelect"/);
    assert.ok(!source.includes('analyticsLoadWebsitesButton'));
    assert.ok(!markup.includes('Refresh Websites'));
    assert.ok(!markup.includes('analyticsLoadWebsitesButton'));
    assert.ok(!markup.includes('Website UUID fallback'));
    assert.match(markup, /data-local-action="copyScriptCode"/);
});
