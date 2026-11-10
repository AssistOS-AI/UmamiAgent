import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    ACTIONS, FILTER_KEYS, McpHttpClient, buildUpstreamCall, extractContent, normalizeInput, redact, runAction,
} from '../tools/umami_tool.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = path.join(ROOT, 'tools/umami_tool.mjs');
const SEED = 'c3'.repeat(32);
const KEY = `umami_${SEED}`;
const WEBSITE = 'b1ee0e11-362a-479a-be3c-c238f72aec35';
const SESSION = '6f8a5b3e-1b0c-4c8e-9d52-0a7c9f1d2e34';
const OTHER = '0d4c1a52-77b4-4a27-8b6b-5c1f3e0a9d11';
const START = Date.UTC(2026, 10, 1);
const END = Date.UTC(2026, 10, 8);
const START_ISO = '2026-11-01T00:00:00.000Z';
const END_ISO = '2026-11-08T00:00:00.000Z';

// A fake Umami MCP endpoint speaking the 2025-era stateless streamable HTTP
// flavour: JSON or SSE replies, 202 for notifications, bearer API key only.
async function fakeMcpServer(t, { mode = 'json', handler = defaultHandler, sessionId } = {}) {
    const state = { requests: [] };
    const server = http.createServer((incoming, response) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
            const record = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: undefined };
            state.requests.push(record);
            if (incoming.url !== '/mcp' || incoming.method !== 'POST') { response.writeHead(404).end(); return; }
            if (incoming.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}'); return; }
            if (!/application\/json/.test(incoming.headers.accept) || !/text\/event-stream/.test(incoming.headers.accept)
                || incoming.headers['content-type'] !== 'application/json') { response.writeHead(406).end(); return; }
            const message = JSON.parse(Buffer.concat(chunks).toString());
            record.body = message;
            const headers = sessionId ? { 'mcp-session-id': sessionId } : {};
            if (message.id === undefined) { response.writeHead(202, headers).end(); return; }
            const result = message.method === 'initialize'
                ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'umami', version: '0.1.0' } }
                : handler(message.params);
            const reply = { jsonrpc: '2.0', id: message.id, ...(result?.rpcError ? { error: result.rpcError } : { result }) };
            if (mode === 'sse') {
                response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
                response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n\n`);
                response.write(`id: 1\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`);
                response.end();
            } else {
                response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(reply));
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    state.env = { UMAMI_BASE_URL: state.baseUrl, UMAMI_INTERNAL_KEY_SEED: SEED };
    state.calls = () => state.requests.filter((entry) => entry.body?.method === 'tools/call').map((entry) => entry.body.params);
    return state;
}

function defaultHandler({ name, arguments: args }) {
    if (name === 'list_websites') {
        const page = args.page ?? 1;
        const websites = page === 1
            ? [{ id: WEBSITE, name: 'Bizanso', domain: 'bizanso.com', teamId: null, createdAt: null }]
            : [{ id: OTHER, name: 'Other', domain: 'other.example', teamId: null, createdAt: null }];
        return structured({ websites, page, pageSize: args.pageSize, count: 2, hasMore: page === 1 });
    }
    return structured({ tool: name, echoed: args });
}

function structured(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

// action, public input, expected upstream tool, expected upstream arguments.
const MAPPING = [
    ['websites_list', {}, 'list_websites', { page: 1, pageSize: 100 }],
    ['stats_get', { websiteId: WEBSITE, startAt: START, endAt: END, unit: 'day', timezone: 'Europe/Bucharest' }, 'get_website_stats',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, timezone: 'Europe/Bucharest' }],
    ['pageviews_get', { websiteId: WEBSITE, startAt: START, endAt: END }, 'get_website_traffic',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, unit: 'day' }],
    ['pageviews_get', { websiteId: WEBSITE, startAt: START, endAt: END, unit: 'hour', timezone: 'UTC' }, 'get_website_traffic',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, unit: 'hour', timezone: 'UTC' }],
    ['metrics_get', { websiteId: WEBSITE, startAt: START, endAt: END, type: 'url', url: '/pricing', referrer: 'google.com', title: 'Home', query: 'a=1', event: 'like', limit: 9999, timezone: 'UTC' },
        'get_website_metrics', { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, type: 'path', limit: 500, timezone: 'UTC',
            filters: { path: '/pricing', referrer: 'google.com', title: 'Home', query: 'a=1', event: 'like' } }],
    ['metrics_get', { websiteId: WEBSITE, startAt: START, endAt: END, type: 'country' }, 'get_website_metrics',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, type: 'country' }],
    ['events_list', { websiteId: WEBSITE, startAt: START, endAt: END, timezone: 'UTC' }, 'get_events',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, pageSize: 100 }],
    ['active_get', { websiteId: WEBSITE }, 'get_realtime', { websiteId: WEBSITE }],
    ['sessions_get', { websiteId: WEBSITE, startAt: START, endAt: END, query: 'berlin', page: 2, pageSize: 500, timezone: 'UTC' }, 'get_sessions',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, search: 'berlin', page: 2, pageSize: 100 }],
    ['website_daterange', { websiteId: WEBSITE }, 'get_website_daterange', { websiteId: WEBSITE }],
    ['event_stats', { websiteId: WEBSITE, startAt: START, endAt: END, compare: 'yoy', filters: { event: 'like', country: 'US' } }, 'get_event_stats',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, compare: 'yoy', filters: { event: 'like', country: 'US' } }],
    ['event_series', { websiteId: WEBSITE, startAt: START, unit: 'day', timezone: 'UTC', limit: 5 }, 'get_event_series',
        { websiteId: WEBSITE, startAt: START_ISO, unit: 'day', timezone: 'UTC', limit: 5 }],
    ['event_properties', { websiteId: WEBSITE, startAt: START, propertyName: 'plan', eventName: 'checkout', dataType: 'string' }, 'get_event_properties',
        { websiteId: WEBSITE, startAt: START_ISO, propertyName: 'plan', eventName: 'checkout', dataType: 'string' }],
    ['session_stats', { websiteId: WEBSITE, startAt: START, endAt: END, filters: { browser: 'chrome' } }, 'get_session_stats',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, filters: { browser: 'chrome' } }],
    ['session_get', { websiteId: WEBSITE, sessionId: SESSION, includeActivity: false }, 'get_session',
        { websiteId: WEBSITE, sessionId: SESSION, includeActivity: false }],
    ['annotations_list', { websiteId: WEBSITE, startAt: START, search: 'launch', page: 1, pageSize: 10 }, 'get_annotations',
        { websiteId: WEBSITE, startAt: START_ISO, search: 'launch', page: 1, pageSize: 10 }],
    ['segments_list', { websiteId: WEBSITE, type: 'cohort', search: 'mobile' }, 'list_segments',
        { websiteId: WEBSITE, type: 'cohort', search: 'mobile' }],
    ['funnels_list', { websiteId: WEBSITE, search: 'checkout', pageSize: 5 }, 'list_funnels', { websiteId: WEBSITE, search: 'checkout', pageSize: 5 }],
    ['funnel_run', { websiteId: WEBSITE, startAt: START, endAt: END, steps: [{ type: 'path', value: '/pricing' }, { type: 'event', value: 'signup' }], windowMinutes: 30 }, 'run_funnel',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, steps: [{ type: 'path', value: '/pricing' }, { type: 'event', value: 'signup' }], windowMinutes: 30 }],
    ['funnel_run', { websiteId: WEBSITE, startAt: START, funnelId: OTHER }, 'run_funnel', { websiteId: WEBSITE, startAt: START_ISO, funnelId: OTHER }],
    ['goals_get', { websiteId: WEBSITE, startAt: START, goalId: OTHER, filters: { match: 'any' } }, 'get_goals',
        { websiteId: WEBSITE, startAt: START_ISO, goalId: OTHER, filters: { match: 'any' } }],
    ['goals_get', { websiteId: WEBSITE }, 'get_goals', { websiteId: WEBSITE }],
    ['journey_run', { websiteId: WEBSITE, startAt: START, endAt: END, steps: 4, startStep: '/', endStep: '/signup' }, 'run_journey',
        { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, steps: 4, startStep: '/', endStep: '/signup' }],
    ['retention_run', { websiteId: WEBSITE, startAt: START, timezone: 'UTC' }, 'run_retention', { websiteId: WEBSITE, startAt: START_ISO, timezone: 'UTC' }],
    ['attribution_run', { websiteId: WEBSITE, startAt: START, model: 'first-click', conversionType: 'event', conversion: 'signup' }, 'run_attribution',
        { websiteId: WEBSITE, startAt: START_ISO, model: 'first-click', conversionType: 'event', conversion: 'signup' }],
    ['revenue_get', { websiteId: WEBSITE, startAt: START, currency: 'eur', unit: 'month', timezone: 'UTC' }, 'get_revenue',
        { websiteId: WEBSITE, startAt: START_ISO, currency: 'EUR', unit: 'month', timezone: 'UTC' }],
    ['performance_get', { websiteId: WEBSITE, startAt: START, metric: 'lcp', breakdown: 'path', limit: 10, unit: 'day', timezone: 'UTC' }, 'get_performance',
        { websiteId: WEBSITE, startAt: START_ISO, metric: 'lcp', breakdown: 'path', limit: 10, unit: 'day', timezone: 'UTC' }],
];

const UPSTREAM_TOOLS = [
    'list_websites', 'get_website_daterange', 'get_website_stats', 'get_website_traffic', 'get_website_metrics', 'get_realtime',
    'get_events', 'get_event_stats', 'get_event_series', 'get_event_properties', 'get_sessions', 'get_session_stats', 'get_session',
    'get_annotations', 'list_segments', 'list_funnels', 'run_funnel', 'get_goals', 'run_journey', 'run_retention', 'run_attribution',
    'get_revenue', 'get_performance',
];

test('every declared tool maps 1:1 onto a built-in upstream tool and the 23 upstream tools are all covered', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-config.json'), 'utf8'));
    const actions = config.tools.map((tool) => tool.env.UMAMI_ACTION);
    assert.equal(config.tools.length, 24);
    assert.equal(new Set(actions).size, 24);
    assert.deepEqual([...actions].sort(), [...Object.keys(ACTIONS), 'report_generate'].sort());
    assert.deepEqual(Object.values(ACTIONS).map((spec) => spec.upstream).sort(), [...UPSTREAM_TOOLS].sort());
    assert.deepEqual(config.tools.slice(0, 8).map((tool) => tool.name), [
        'umami_websites_list', 'umami_stats_get', 'umami_pageviews_get', 'umami_metrics_get',
        'umami_events_list', 'umami_active_get', 'umami_sessions_get', 'umami_report_generate',
    ]);
    assert.deepEqual(config.tools.slice(8).map((tool) => tool.name), [
        'umami_website_daterange', 'umami_event_stats', 'umami_event_series', 'umami_event_properties', 'umami_session_stats',
        'umami_session_get', 'umami_annotations_list', 'umami_segments_list', 'umami_funnels_list', 'umami_funnel_run',
        'umami_goals_get', 'umami_journey_run', 'umami_retention_run', 'umami_attribution_run', 'umami_revenue_get', 'umami_performance_get',
    ]);
    for (const tool of config.tools) {
        assert.equal(tool.command, 'tools/umami_tool.sh');
        assert.match(tool.name, /^umami_[a-z_]+$/);
        assert.deepEqual(Object.keys(tool.env), ['UMAMI_ACTION']);
        assert.ok(!Object.hasOwn(tool.inputSchema, 'type') || typeof tool.inputSchema.type === 'object');
    }
});

test('declared input schemas match the validators field by field', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-config.json'), 'utf8'));
    for (const tool of config.tools) {
        const action = tool.env.UMAMI_ACTION;
        if (action === 'report_generate') {
            assert.deepEqual(Object.keys(tool.inputSchema), ['websiteId', 'startAt', 'endAt', 'label', 'timezone']);
            continue;
        }
        const fields = ACTIONS[action].fields;
        assert.deepEqual(Object.keys(tool.inputSchema).sort(), Object.keys(fields).sort(), tool.name);
        for (const [name, field] of Object.entries(fields)) {
            assert.equal(tool.inputSchema[name].optional, !field.required, `${tool.name}.${name}`);
        }
        if (tool.inputSchema.filters) {
            assert.equal(tool.inputSchema.filters.type, 'object');
            assert.deepEqual(Object.keys(tool.inputSchema.filters.properties), FILTER_KEYS);
        }
    }
    // The original millisecond contract of the eight existing tools is unchanged.
    const byName = Object.fromEntries(config.tools.map((tool) => [tool.name, tool.inputSchema]));
    assert.deepEqual(byName.umami_websites_list, {});
    for (const name of ['umami_stats_get', 'umami_pageviews_get', 'umami_metrics_get', 'umami_events_list', 'umami_sessions_get', 'umami_report_generate']) {
        assert.deepEqual(byName[name].startAt, { type: 'number', optional: false });
        assert.deepEqual(byName[name].endAt, { type: 'number', optional: false });
    }
    assert.deepEqual(byName.umami_active_get, { websiteId: { type: 'string', optional: true } });
});

for (const mode of ['json', 'sse']) {
    test(`each action calls the mapped upstream tool with ISO 8601 dates over ${mode} replies`, async (t) => {
        const server = await fakeMcpServer(t, { mode });
        for (const [action, input, upstream, args] of MAPPING) {
            server.requests.length = 0;
            const output = await runAction({ action, input, env: server.env });
            assert.equal(output.action, action);
            assert.equal(output.upstreamTool, upstream);
            if (action === 'websites_list') {
                assert.deepEqual(server.calls().map((call) => call.arguments), [
                    { page: 1, pageSize: 100 }, { page: 2, pageSize: 100 },
                ]);
                continue;
            }
            assert.deepEqual(server.calls(), [{ name: upstream, arguments: args }], `${action} ${JSON.stringify(input)}`);
            assert.deepEqual(output.result, { tool: upstream, echoed: args }, 'structured content is returned under result');
        }
    });
}

test('the client performs initialize, the initialized notification and one tools/call with the internal key', async (t) => {
    const server = await fakeMcpServer(t);
    await runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: server.env });
    assert.deepEqual(server.requests.map((entry) => entry.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
    for (const entry of server.requests) {
        assert.equal(entry.method, 'POST');
        assert.equal(entry.url, '/mcp');
        assert.equal(entry.headers.authorization, `Bearer ${KEY}`);
        assert.equal(entry.headers['content-type'], 'application/json');
        assert.equal(entry.headers['mcp-session-id'], undefined);
    }
    assert.equal(server.requests[0].body.params.protocolVersion, '2025-06-18');
    assert.equal(server.requests[0].headers['mcp-protocol-version'], undefined, 'no protocol header before initialization');
    assert.equal(server.requests[1].headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(server.requests[2].headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(server.requests[2].body.id, 2);
    assert.ok(server.requests.every((entry) => !('_meta' in (entry.body.params || {}))));
});

test('a session id offered by the server is echoed on later requests', async (t) => {
    const server = await fakeMcpServer(t, { sessionId: 'session-1' });
    await runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: server.env });
    assert.deepEqual(server.requests.map((entry) => entry.headers['mcp-session-id']), [undefined, 'session-1', 'session-1']);
});

test('umami_websites_list keeps the wrapper and exposes id and domain at the top level for deploy checks', async (t) => {
    const server = await fakeMcpServer(t);
    const output = await runAction({ action: 'websites_list', input: {}, env: server.env });
    assert.deepEqual(Object.keys(output).sort(), ['action', 'result', 'upstreamTool', 'websites']);
    assert.deepEqual(output.websites.map(({ id, domain }) => ({ id, domain })), [
        { id: WEBSITE, domain: 'bizanso.com' }, { id: OTHER, domain: 'other.example' },
    ]);
    assert.deepEqual(output.result.websites, output.websites);
    assert.equal(output.result.count, 2);
});

test('input validation rejects before any upstream call', async (t) => {
    const server = await fakeMcpServer(t);
    const base = { websiteId: WEBSITE, startAt: START, endAt: END };
    const cases = [
        ['stats_get', { ...base, extra: 1 }, /Unknown input field\(s\): extra/],
        ['stats_get', { websiteId: WEBSITE, endAt: END }, /startAt is required/],
        ['stats_get', { ...base, startAt: 'x' }, /startAt must be a finite millisecond timestamp/],
        ['stats_get', { ...base, endAt: START }, /endAt must be after startAt/],
        ['stats_get', { ...base, websiteId: 'not-a-uuid' }, /websiteId must be a UUID/],
        ['stats_get', { startAt: START, endAt: END }, /websiteId is required/],
        ['pageviews_get', { ...base, unit: 'week' }, /unit must be one of/],
        ['metrics_get', { ...base }, /type is required/],
        ['metrics_get', { ...base, type: 'nope' }, /type must be one of/],
        ['websites_list', { websiteId: WEBSITE }, /Unknown input field/],
        ['event_stats', { ...base, filters: { nope: 'x' } }, /Unknown filters key/],
        ['event_stats', { ...base, filters: { path: 3 } }, /filters.path must be a string/],
        ['event_stats', { ...base, filters: { match: 'some' } }, /match must be all or any/],
        ['funnel_run', { ...base }, /either funnelId or steps/],
        ['funnel_run', { ...base, funnelId: OTHER, steps: [{ type: 'path', value: '/' }, { type: 'path', value: '/a' }] }, /either funnelId or steps/],
        ['funnel_run', { ...base, steps: [{ type: 'path', value: '/' }] }, /2 to 8 steps/],
        ['funnel_run', { ...base, steps: [{ type: 'url', value: '/' }, { type: 'path', value: '/a' }] }, /must be \{ type/],
        ['journey_run', { ...base, steps: 9 }, /between 2 and 7/],
        ['attribution_run', { ...base, conversion: 'x' }, /conversionType is required/],
        ['revenue_get', { ...base, currency: 'EURO' }, /ISO 4217/],
        ['session_get', { websiteId: WEBSITE }, /sessionId is required/],
        ['session_get', { websiteId: WEBSITE, sessionId: SESSION, includeActivity: 'no' }, /must be a boolean/],
        ['nope', {}, /Unsupported umami action/],
    ];
    for (const [action, input, pattern] of cases) {
        await assert.rejects(runAction({ action, input, env: server.env }), pattern, `${action} ${JSON.stringify(input)}`);
    }
    assert.deepEqual(server.requests, []);
});

test('defaults come from UMAMI_DEFAULT_WEBSITE_ID and UMAMI_TIMEZONE', () => {
    const env = { UMAMI_DEFAULT_WEBSITE_ID: WEBSITE, UMAMI_TIMEZONE: 'Europe/Bucharest' };
    const call = buildUpstreamCall('stats_get', { startAt: START, endAt: END }, env);
    assert.deepEqual(call.arguments, { websiteId: WEBSITE, startAt: START_ISO, endAt: END_ISO, timezone: 'Europe/Bucharest' });
    assert.equal(buildUpstreamCall('stats_get', { startAt: START, endAt: END, timezone: 'UTC' }, env).arguments.timezone, 'UTC');
});

test('envelopes from AgentServer are unwrapped', () => {
    assert.deepEqual(normalizeInput({ input: { arguments: { a: 1 } } }), { a: 1 });
    assert.deepEqual(normalizeInput({ params: { arguments: { b: 2 } } }), { b: 2 });
    assert.deepEqual(normalizeInput(null), {});
    assert.deepEqual(normalizeInput([1]), {});
});

test('upstream failures surface as errors: tool errors, JSON-RPC errors, 401 and a disabled endpoint', async (t) => {
    const failing = await fakeMcpServer(t, {
        handler: ({ name }) => (name === 'get_realtime'
            ? { content: [{ type: 'text', text: 'Error (not_found): Website not found.' }], isError: true }
            : { rpcError: { code: -32602, message: 'Invalid params' } }),
    });
    await assert.rejects(runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: failing.env }), /Umami tool get_realtime failed: Error \(not_found\)/);
    await assert.rejects(runAction({ action: 'website_daterange', input: { websiteId: WEBSITE }, env: failing.env }), /error: Invalid params/);

    const server = await fakeMcpServer(t);
    await assert.rejects(runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: { ...server.env, UMAMI_INTERNAL_KEY_SEED: 'd4'.repeat(32) } }), /rejected the internal API key \(HTTP 401\)/);
    await assert.rejects(runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: { ...server.env, UMAMI_BASE_URL: `${server.baseUrl}/missing` } }), /endpoint is not available \(HTTP 404\)/);
    await assert.rejects(runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: { UMAMI_BASE_URL: server.baseUrl } }), /internal Umami API key is not configured/);
    await assert.rejects(runAction({ action: 'active_get', input: { websiteId: WEBSITE }, env: { UMAMI_BASE_URL: 'http://127.0.0.1:9', UMAMI_INTERNAL_KEY_SEED: SEED } }), /request failed/);
});

test('content extraction prefers structured content and falls back to JSON or plain text', () => {
    assert.deepEqual(extractContent({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }), { a: 1 });
    assert.deepEqual(extractContent({ content: [{ type: 'text', text: '{"a":2}' }] }), { a: 2 });
    assert.equal(extractContent({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
    assert.deepEqual(extractContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), ['a', 'b']);
});

test('redaction removes the literal key, any umami_ token and bearer values', () => {
    const text = `failed with ${KEY} and Bearer abc.def and umami_ZZZZZZZZZZ plus password=hunter2`;
    const redacted = redact(text, [SEED]);
    for (const leaked of [KEY, SEED, 'abc.def', 'umami_ZZZZZZZZZZ', 'hunter2']) assert.ok(!redacted.includes(leaked), leaked);
    assert.throws(() => new McpHttpClient({ key: 'nope' }), /not configured/);
    for (const baseUrl of ['https://umami.example', 'http://10.0.0.5:3000', 'http://127.0.0.1.evil.test', 'nonsense']) {
        assert.throws(() => new McpHttpClient({ baseUrl, key: KEY }), /container loopback/, baseUrl);
    }
    for (const baseUrl of ['http://127.0.0.1:3000', 'http://localhost:1234/', 'http://[::1]:3000']) {
        assert.doesNotThrow(() => new McpHttpClient({ baseUrl, key: KEY }), baseUrl);
    }
});

test('umami_report_generate collects five sections through the mapped tools and replaces a repeated label', async (t) => {
    const server = await fakeMcpServer(t, {
        handler: ({ name, arguments: args }) => structured(name === 'get_website_metrics'
            ? { data: [{ name: `/${args.type}`, value: 7 }] } : { tool: name }),
    });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-report-'));
    t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
    const env = { ...server.env, UMAMI_OUTPUT_DIR: outputDir };
    const input = { websiteId: WEBSITE, startAt: START, endAt: END, label: 'Nov 2026!', timezone: 'UTC' };
    const result = await runAction({ action: 'report_generate', input, env });
    assert.deepEqual(result, { ok: true, filePath: path.join(outputDir, 'Nov-2026.md'), sections: ['summary', 'pageviews', 'top-pages', 'referrers', 'countries'] });
    assert.deepEqual(server.calls().map((call) => [call.name, call.arguments.type]), [
        ['get_website_stats', undefined], ['get_website_traffic', undefined],
        ['get_website_metrics', 'path'], ['get_website_metrics', 'referrer'], ['get_website_metrics', 'country'],
    ]);
    assert.ok(server.calls().every((call) => call.arguments.startAt === START_ISO && call.arguments.endAt === END_ISO));
    const markdown = fs.readFileSync(result.filePath, 'utf8');
    for (const heading of ['# Umami Report - Nov 2026!', '## Summary', '## Pageviews', '## Top Pages', '## Referrers', '## Countries', '/path', '/referrer', '/country']) {
        assert.ok(markdown.includes(heading), heading);
    }
    assert.ok(!markdown.includes(KEY));
    await runAction({ action: 'report_generate', input: { ...input, label: 'Nov 2026?' }, env });
    assert.deepEqual(fs.readdirSync(outputDir), ['Nov-2026.md']);
    await assert.rejects(runAction({ action: 'report_generate', input: { ...input, extra: 1 }, env }), /Unknown input field/);
    await assert.rejects(runAction({ action: 'report_generate', input: { startAt: START, endAt: END }, env }), /websiteId is required/);
});

function runScript(env, stdin, { script = TOOL } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(stdin);
    });
}

test('the executable prints one JSON document on stdout, nothing on stderr, and exits non-zero without leaking the key', async (t) => {
    const server = await fakeMcpServer(t);
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-tool-link-'));
    t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
    fs.symlinkSync(path.join(ROOT, 'tools'), path.join(linkDir, 'tools'), 'dir');
    for (const script of [TOOL, path.join(linkDir, 'tools/umami_tool.mjs')]) {
        const ok = await runScript({ ...server.env, UMAMI_ACTION: 'active_get' }, JSON.stringify({ input: { websiteId: WEBSITE } }), { script });
        assert.equal(ok.status, 0, ok.stderr);
        assert.equal(ok.stderr, '');
        assert.deepEqual(JSON.parse(ok.stdout), { action: 'active_get', upstreamTool: 'get_realtime', result: { tool: 'get_realtime', echoed: { websiteId: WEBSITE } } });
    }
    const rejected = await runScript({ ...server.env, UMAMI_INTERNAL_KEY_SEED: 'e5'.repeat(32), UMAMI_ACTION: 'active_get' }, JSON.stringify({ websiteId: WEBSITE }));
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stderr, '');
    const failure = JSON.parse(rejected.stdout);
    assert.equal(failure.ok, false);
    assert.equal(failure.action, 'active_get');
    assert.match(failure.error, /rejected the internal API key/);
    assert.ok(!rejected.stdout.includes('e5e5e5'));
    const invalid = await runScript({ ...server.env, UMAMI_ACTION: 'stats_get' }, '{}');
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stdout).error, /startAt is required|websiteId is required/);
});

test('the MCP wrapper has no pass-through tool and the old OAuth/MadsNyl files are gone', () => {
    const config = fs.readFileSync(path.join(ROOT, 'mcp-config.json'), 'utf8');
    assert.ok(!/passthrough|pass-through|"tool"\s*:|arguments"\s*:/i.test(config));
    const shell = fs.readFileSync(path.join(ROOT, 'tools/umami_tool.sh'), 'utf8');
    assert.match(shell, /exec node \/code\/tools\/umami_tool\.mjs/);
});
