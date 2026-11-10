#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Maps each declared Ploinky tool 1:1 onto a read-only tool of Umami's built-in
// MCP endpoint (`<base>/mcp`, streamable HTTP, API key as the bearer token).

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_OUTPUT_DIR = '/shared/deliverables/umami';
// Umami serves the 2026-07-28 revision plus a stateless fallback for 2025-era
// clients. This client speaks the 2025-06-18 fallback: no session, no _meta.
const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGE_SIZE = 100;
const MAX_LIMIT = 500;
const MAX_WEBSITE_PAGES = 20;

// Keys accepted inside `filters` (packages/mcp/src/lib/filters.ts at v3.4.1).
export const FILTER_KEYS = [
    'path', 'referrer', 'title', 'query', 'hostname', 'event', 'tag', 'browser', 'os', 'device',
    'country', 'region', 'city', 'language', 'distinctId', 'utmSource', 'utmMedium', 'utmCampaign',
    'utmContent', 'utmTerm', 'segment', 'cohort', 'match',
];

const TIME_UNITS = ['minute', 'hour', 'day', 'month', 'year'];
const METRIC_TYPES = [
    'path', 'entry', 'exit', 'title', 'query', 'hostname', 'referrer', 'domain', 'channel', 'event', 'tag',
    'browser', 'os', 'device', 'screen', 'language', 'country', 'region', 'city', 'distinctId',
    'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
];

// ---------------------------------------------------------------- redaction

export function redact(value, secrets = []) {
    let text = String(value ?? '');
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[REDACTED]');
    }
    return text
        .replace(/umami_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
        .replace(/(password|token|secret|authorization|api[_-]?key)(["'\s:=]+)([^"',\s]+)/gi, '$1$2[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function safeJson(text, fallback = null) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function normalizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

// ---------------------------------------------------------------- input

// Field kinds. Each validator returns the cleaned value or throws.
const KINDS = {
    string: (value, name) => {
        if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
        return value.trim();
    },
    uuid: (value, name) => {
        if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
            throw new Error(`${name} must be a UUID.`);
        }
        return value.trim();
    },
    ms: (value, name) => {
        const number = Number(value);
        if (value === '' || typeof value === 'boolean' || !Number.isFinite(number)) {
            throw new Error(`${name} must be a finite millisecond timestamp.`);
        }
        return number;
    },
    limit: (value) => Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(value)) || 100)),
    page: (value) => Math.max(1, Math.trunc(Number(value)) || 1),
    pageSize: (value) => Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(value)) || 20)),
    positiveInt: (value, name) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
        return number;
    },
    bool: (value, name) => {
        if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
        return value;
    },
    filters: (value, name) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
        const unknown = Object.keys(value).filter((key) => !FILTER_KEYS.includes(key));
        if (unknown.length) throw new Error(`Unknown ${name} key(s): ${unknown.join(', ')}`);
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined || entry === null || entry === '') continue;
            if (typeof entry !== 'string') throw new Error(`${name}.${key} must be a string.`);
            if (key === 'match' && !['all', 'any'].includes(entry)) throw new Error(`${name}.match must be all or any.`);
            out[key] = entry;
        }
        return out;
    },
    steps: (value, name) => {
        if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error(`${name} must list 2 to 8 steps.`);
        return value.map((step, index) => {
            if (!step || typeof step !== 'object' || !['path', 'event'].includes(step.type)
                || typeof step.value !== 'string' || !step.value.trim()) {
                throw new Error(`${name}[${index}] must be { type: "path" | "event", value: string }.`);
            }
            return { type: step.type, value: step.value };
        });
    },
};

const enumOf = (...values) => (value, name) => {
    if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(', ')}.`);
    return value;
};

const WEBSITE = { websiteId: { kind: KINDS.uuid } };
const RANGE = { startAt: { kind: KINDS.ms, required: true }, endAt: { kind: KINDS.ms } };
const RANGE_REQUIRED = { startAt: { kind: KINDS.ms, required: true }, endAt: { kind: KINDS.ms, required: true } };
const OPTIONAL_RANGE = { startAt: { kind: KINDS.ms }, endAt: { kind: KINDS.ms } };
const TIMEZONE = { timezone: { kind: KINDS.string } };
const FILTERS = { filters: { kind: KINDS.filters } };
const PAGING = { page: { kind: KINDS.page }, pageSize: { kind: KINDS.pageSize } };
const UNIT = { unit: { kind: enumOf(...TIME_UNITS) } };

// One entry per declared tool. `fields` is the public input; `upstream` the
// built-in tool; `build` turns the cleaned input into the upstream arguments
// (epoch milliseconds become ISO 8601 for every startAt / endAt).
export const ACTIONS = {
    // Existing tools: millisecond ranges required, schemas unchanged.
    websites_list: { upstream: 'list_websites', fields: {}, build: () => ({}) },
    stats_get: {
        upstream: 'get_website_stats',
        fields: { ...WEBSITE, ...RANGE_REQUIRED, ...UNIT, ...TIMEZONE },
        // Umami's stats tool has no bucket unit; the input stays accepted.
        build: ({ unit: _unit, ...input }) => input,
    },
    pageviews_get: {
        upstream: 'get_website_traffic',
        fields: { ...WEBSITE, ...RANGE_REQUIRED, ...UNIT, ...TIMEZONE },
        build: (input) => ({ ...input, unit: input.unit || 'day' }),
    },
    metrics_get: {
        upstream: 'get_website_metrics',
        fields: {
            ...WEBSITE, ...RANGE_REQUIRED,
            type: { kind: enumOf(...METRIC_TYPES, 'url'), required: true },
            url: { kind: KINDS.string }, referrer: { kind: KINDS.string }, title: { kind: KINDS.string },
            query: { kind: KINDS.string }, event: { kind: KINDS.string },
            limit: { kind: KINDS.limit }, ...TIMEZONE,
        },
        build: ({ url, referrer, title, query, event, type, ...input }) => {
            const filters = Object.fromEntries(Object.entries({ path: url, referrer, title, query, event })
                .filter(([, value]) => value !== undefined));
            return { ...input, type: type === 'url' ? 'path' : type, ...(Object.keys(filters).length ? { filters } : {}) };
        },
    },
    events_list: {
        upstream: 'get_events',
        fields: { ...WEBSITE, ...RANGE_REQUIRED, ...TIMEZONE },
        // Umami's events tool takes no timezone.
        build: ({ timezone: _timezone, ...input }) => ({ ...input, pageSize: MAX_PAGE_SIZE }),
    },
    active_get: { upstream: 'get_realtime', fields: { ...WEBSITE }, build: (input) => input },
    sessions_get: {
        upstream: 'get_sessions',
        fields: { ...WEBSITE, ...RANGE_REQUIRED, query: { kind: KINDS.string }, ...PAGING, ...TIMEZONE },
        build: ({ query, timezone: _timezone, ...input }) => ({ ...input, ...(query !== undefined ? { search: query } : {}) }),
    },

    // New tools, one per remaining built-in tool.
    website_daterange: { upstream: 'get_website_daterange', fields: { ...WEBSITE }, build: (input) => input },
    event_stats: {
        upstream: 'get_event_stats',
        fields: { ...WEBSITE, ...RANGE, compare: { kind: enumOf('prev', 'yoy') }, ...FILTERS },
        build: (input) => input,
    },
    event_series: {
        upstream: 'get_event_series',
        fields: { ...WEBSITE, ...RANGE, ...UNIT, ...TIMEZONE, limit: { kind: KINDS.limit }, ...FILTERS },
        build: (input) => input,
    },
    event_properties: {
        upstream: 'get_event_properties',
        fields: {
            ...WEBSITE, ...RANGE,
            propertyName: { kind: KINDS.string }, eventName: { kind: KINDS.string },
            dataType: { kind: enumOf('string', 'number', 'boolean', 'date', 'array') }, ...FILTERS,
        },
        build: (input) => input,
    },
    session_stats: {
        upstream: 'get_session_stats',
        fields: { ...WEBSITE, ...RANGE, ...FILTERS },
        build: (input) => input,
    },
    session_get: {
        upstream: 'get_session',
        fields: { ...WEBSITE, sessionId: { kind: KINDS.uuid, required: true }, includeActivity: { kind: KINDS.bool } },
        build: (input) => input,
    },
    annotations_list: {
        upstream: 'get_annotations',
        fields: { ...WEBSITE, ...OPTIONAL_RANGE, search: { kind: KINDS.string }, ...PAGING },
        build: (input) => input,
    },
    segments_list: {
        upstream: 'list_segments',
        fields: { ...WEBSITE, type: { kind: enumOf('segment', 'cohort') }, search: { kind: KINDS.string } },
        build: (input) => input,
    },
    funnels_list: {
        upstream: 'list_funnels',
        fields: { ...WEBSITE, search: { kind: KINDS.string }, ...PAGING },
        build: (input) => input,
    },
    funnel_run: {
        upstream: 'run_funnel',
        fields: {
            ...WEBSITE, ...RANGE,
            funnelId: { kind: KINDS.uuid }, steps: { kind: KINDS.steps },
            windowMinutes: { kind: KINDS.positiveInt }, ...FILTERS,
        },
        build: (input) => {
            if (Boolean(input.funnelId) === Boolean(input.steps)) throw new Error('Provide either funnelId or steps, not both.');
            return input;
        },
    },
    goals_get: {
        upstream: 'get_goals',
        fields: { ...WEBSITE, ...OPTIONAL_RANGE, goalId: { kind: KINDS.uuid }, search: { kind: KINDS.string }, ...PAGING, ...FILTERS },
        build: (input) => input,
    },
    journey_run: {
        upstream: 'run_journey',
        fields: {
            ...WEBSITE, ...RANGE,
            steps: { kind: KINDS.positiveInt }, startStep: { kind: KINDS.string }, endStep: { kind: KINDS.string }, ...FILTERS,
        },
        build: (input) => {
            if (input.steps !== undefined && (input.steps < 2 || input.steps > 7)) throw new Error('steps must be between 2 and 7.');
            return input;
        },
    },
    retention_run: {
        upstream: 'run_retention',
        fields: { ...WEBSITE, ...RANGE, ...TIMEZONE, ...FILTERS },
        build: (input) => input,
    },
    attribution_run: {
        upstream: 'run_attribution',
        fields: {
            ...WEBSITE, ...RANGE,
            model: { kind: enumOf('first-click', 'last-click') },
            conversionType: { kind: enumOf('path', 'event'), required: true },
            conversion: { kind: KINDS.string, required: true }, ...FILTERS,
        },
        build: (input) => input,
    },
    revenue_get: {
        upstream: 'get_revenue',
        fields: {
            ...WEBSITE, ...RANGE,
            currency: { kind: (value, name) => { if (typeof value !== 'string' || value.trim().length !== 3) throw new Error(`${name} must be an ISO 4217 code.`); return value.trim().toUpperCase(); } },
            ...UNIT, ...TIMEZONE, ...FILTERS,
        },
        build: (input) => input,
    },
    performance_get: {
        upstream: 'get_performance',
        fields: {
            ...WEBSITE, ...RANGE,
            metric: { kind: enumOf('lcp', 'inp', 'cls', 'fcp', 'ttfb') },
            breakdown: { kind: enumOf('path', 'title', 'device', 'browser') },
            limit: { kind: KINDS.limit }, ...UNIT, ...TIMEZONE, ...FILTERS,
        },
        build: (input) => input,
    },
};

function toIsoTimestamp(value, name) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid millisecond timestamp.`);
    return date.toISOString();
}

export function normalizeInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 5; i += 1) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) break;
        if (current.input && typeof current.input === 'object') { current = current.input; continue; }
        if (current.arguments && typeof current.arguments === 'object') { current = current.arguments; continue; }
        if (current.params?.arguments && typeof current.params.arguments === 'object') { current = current.params.arguments; continue; }
        if (current.params?.input && typeof current.params.input === 'object') { current = current.params.input; continue; }
        break;
    }
    return current && typeof current === 'object' && !Array.isArray(current) ? current : {};
}

// Validates the public input for `action` and returns the upstream call.
export function buildUpstreamCall(action, rawInput, env = process.env) {
    const spec = ACTIONS[action];
    if (!spec) throw new Error(`Unsupported umami action: ${action}`);
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const unknown = Object.keys(input).filter((key) => !Object.hasOwn(spec.fields, key));
    if (unknown.length) throw new Error(`Unknown input field(s): ${unknown.join(', ')}`);

    const cleaned = {};
    for (const [name, field] of Object.entries(spec.fields)) {
        const value = input[name];
        if (value === undefined || value === null || value === '') {
            if (field.required) throw new Error(`${name} is required.`);
            continue;
        }
        cleaned[name] = field.kind(value, name);
    }
    if (Object.hasOwn(spec.fields, 'websiteId') && !cleaned.websiteId) {
        const fallback = normalizeString(env.UMAMI_DEFAULT_WEBSITE_ID);
        if (!fallback) throw new Error('websiteId is required when UMAMI_DEFAULT_WEBSITE_ID is not set.');
        cleaned.websiteId = KINDS.uuid(fallback, 'UMAMI_DEFAULT_WEBSITE_ID');
    }
    if (Object.hasOwn(spec.fields, 'timezone') && !cleaned.timezone) {
        const fallback = normalizeString(env.UMAMI_TIMEZONE);
        if (fallback) cleaned.timezone = fallback;
    }
    if (cleaned.startAt !== undefined && cleaned.endAt !== undefined && cleaned.endAt <= cleaned.startAt) {
        throw new Error('endAt must be after startAt.');
    }

    const args = spec.build(cleaned);
    if (args.startAt !== undefined) args.startAt = toIsoTimestamp(args.startAt, 'startAt');
    if (args.endAt !== undefined) args.endAt = toIsoTimestamp(args.endAt, 'endAt');
    return { upstream: spec.upstream, arguments: args, input: cleaned };
}

// ---------------------------------------------------------------- MCP client

function parseEventStream(text) {
    const messages = [];
    let data = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line) {
            if (data.length) { messages.push(data.join('\n')); data = []; }
            continue;
        }
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) messages.push(data.join('\n'));
    return messages.map((message) => safeJson(message, null)).filter(Boolean);
}

export class McpHttpClient {
    constructor({ baseUrl = DEFAULT_BASE_URL, key, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        if (!key || !key.startsWith('umami_')) throw new Error('The internal Umami API key is not configured.');
        // The key is an admin-owned credential: only ever send it to this container.
        let host;
        try {
            host = new URL(baseUrl).hostname;
        } catch {
            host = '';
        }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('UMAMI_BASE_URL must point at the container loopback.');
        this.endpoint = `${String(baseUrl).replace(/\/+$/, '')}/mcp`;
        this.key = key;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.messageId = 0;
        this.sessionId = '';
        this.initialized = false;
    }

    async send(method, params = {}, { notification = false } = {}) {
        const id = notification ? undefined : ++this.messageId;
        const headers = {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            authorization: `Bearer ${this.key}`,
        };
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
        if (this.initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (error) {
            throw new Error(`Umami MCP request failed: ${error?.cause?.code || error?.name || 'network error'}`);
        }
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId) this.sessionId = sessionId;
        const text = await response.text();
        if (response.status === 401) throw new Error('Umami rejected the internal API key (HTTP 401).');
        if (response.status === 404) throw new Error('Umami MCP endpoint is not available (HTTP 404); is MCP_ENABLED set?');
        if (!response.ok) throw new Error(`Umami MCP ${method} failed (HTTP ${response.status}): ${redact(text).slice(0, 300)}`);
        if (notification) return null;

        const contentType = response.headers.get('content-type') || '';
        const messages = contentType.includes('text/event-stream') ? parseEventStream(text) : [safeJson(text, null)].filter(Boolean);
        const reply = messages.find((message) => message?.id === id && ('result' in message || 'error' in message));
        if (!reply) throw new Error(`Umami MCP ${method} returned no JSON-RPC reply.`);
        if (reply.error) throw new Error(`Umami MCP ${method} error: ${reply.error.message || JSON.stringify(reply.error)}`);
        return reply.result;
    }

    async initialize() {
        if (this.initialized) return;
        await this.send('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'achilles-umami-agent', version: '0.2.0' },
        });
        this.initialized = true;
        await this.send('notifications/initialized', {}, { notification: true });
    }

    async callTool(name, args) {
        await this.initialize();
        const result = await this.send('tools/call', { name, arguments: args || {} });
        if (result?.isError) {
            const message = (result.content || []).filter((item) => item?.type === 'text').map((item) => item.text).join(' ');
            throw new Error(`Umami tool ${name} failed: ${message || 'unknown error'}`);
        }
        return extractContent(result);
    }
}

export function extractContent(result) {
    if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    if (Array.isArray(result?.content)) {
        const textItems = result.content
            .filter((item) => item?.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text);
        if (textItems.length === 1) return safeJson(textItems[0], textItems[0]);
        if (textItems.length) return textItems;
    }
    return result;
}

// ---------------------------------------------------------------- actions

async function callAction(client, action, rawInput, env) {
    const call = buildUpstreamCall(action, rawInput, env);
    if (action === 'websites_list') {
        // Page through every website so the caller gets the full list.
        const websites = [];
        for (let page = 1; page <= MAX_WEBSITE_PAGES; page += 1) {
            const result = await client.callTool(call.upstream, { page, pageSize: MAX_PAGE_SIZE });
            websites.push(...(Array.isArray(result?.websites) ? result.websites : []));
            if (!result?.hasMore) break;
        }
        return { action, upstreamTool: call.upstream, websites, result: { websites, count: websites.length } };
    }
    const result = await client.callTool(call.upstream, call.arguments);
    return { action, upstreamTool: call.upstream, result };
}

function dateSlug(ms) {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toISOString().slice(0, 10);
}

function markdownValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return `\`${JSON.stringify(value)}\``;
}

function summarizeRows(value, max = 20) {
    const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
    if (!rows.length) return '_No rows returned._';
    const keys = Array.from(new Set(rows.slice(0, max).flatMap((row) => Object.keys(row || {}).slice(0, 8)))).slice(0, 8);
    if (!keys.length) return '```json\n' + JSON.stringify(rows.slice(0, max), null, 2) + '\n```';
    const header = `| ${keys.join(' | ')} |`;
    const sep = `| ${keys.map(() => '---').join(' | ')} |`;
    const body = rows.slice(0, max).map((row) => `| ${keys.map((key) => markdownValue(row?.[key])).join(' | ')} |`);
    return [header, sep, ...body].join('\n');
}

export async function generateReport(client, rawInput, env = process.env) {
    const unknown = Object.keys(rawInput || {}).filter((key) => !['websiteId', 'startAt', 'endAt', 'label', 'timezone'].includes(key));
    if (unknown.length) throw new Error(`Unknown input field(s): ${unknown.join(', ')}`);
    const { label: _label, ...statsInput } = rawInput || {};
    const { input } = buildUpstreamCall('stats_get', statsInput, env);
    const label = normalizeString(rawInput?.label) || `${dateSlug(input.startAt)}-to-${dateSlug(input.endAt)}`;
    const stats = await callAction(client, 'stats_get', input, env);
    const pageviews = await callAction(client, 'pageviews_get', input, env);
    const topPages = await callAction(client, 'metrics_get', { ...input, type: 'path', limit: 25 }, env);
    const referrers = await callAction(client, 'metrics_get', { ...input, type: 'referrer', limit: 25 }, env);
    const countries = await callAction(client, 'metrics_get', { ...input, type: 'country', limit: 25 }, env);

    const lines = [
        `# Umami Report - ${label}`,
        '',
        `- Website: ${input.websiteId}`,
        `- Start: ${new Date(input.startAt).toISOString()}`,
        `- End: ${new Date(input.endAt).toISOString()}`,
        `- Timezone: ${input.timezone || 'default'}`,
        '',
        '## Summary', '', '```json', JSON.stringify(stats.result, null, 2), '```', '',
        '## Pageviews', '', '```json', JSON.stringify(pageviews.result, null, 2), '```', '',
        '## Top Pages', '', summarizeRows(topPages.result), '',
        '## Referrers', '', summarizeRows(referrers.result), '',
        '## Countries', '', summarizeRows(countries.result), '',
    ];

    const outputDir = normalizeString(env.UMAMI_OUTPUT_DIR) || DEFAULT_OUTPUT_DIR;
    await fs.mkdir(outputDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
    const filePath = path.join(outputDir, `${safeLabel}.md`);
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    return { ok: true, filePath, sections: ['summary', 'pageviews', 'top-pages', 'referrers', 'countries'] };
}

// Runs one declared action and returns the JSON value to print.
export async function runAction({ action, input, env = process.env, fetchImpl = fetch }) {
    const key = `umami_${normalizeString(env.UMAMI_INTERNAL_KEY_SEED)}`;
    const client = new McpHttpClient({
        baseUrl: normalizeString(env.UMAMI_BASE_URL) || DEFAULT_BASE_URL,
        key: key === 'umami_' ? '' : key,
        fetchImpl,
    });
    if (action === 'report_generate') return generateReport(client, input, env);
    return callAction(client, action, input, env);
}

async function readStdin() {
    if (process.stdin.isTTY) return '';
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

export async function main() {
    const action = normalizeString(process.env.UMAMI_ACTION || process.env.TOOL_NAME);
    const seed = normalizeString(process.env.UMAMI_INTERNAL_KEY_SEED);
    const secrets = seed ? [seed, `umami_${seed}`] : [];
    try {
        const input = normalizeInput(safeJson(await readStdin(), {}));
        const output = await runAction({ action, input });
        process.stdout.write(JSON.stringify(output, null, 2));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(JSON.stringify({ ok: false, error: redact(message, secrets), action }, null, 2));
        process.exitCode = 1;
    }
}

// Run only when executed (tools are launched through symlinked /code paths).
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main();
}
