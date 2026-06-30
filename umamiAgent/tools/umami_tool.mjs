#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_OUTPUT_DIR = '/shared/deliverables/umami';
const DEFAULT_MCP_PORT = 7301;
const DEFAULT_OAUTH_CLIENT_ID = 'umami-agent';
const TOKEN_CACHE_PATH = '/tmp/umami-mcp-access-token.json';

const ACTIONS = {
    websites_list: {
        candidates: ['list_websites', 'get_websites', 'websites_list', 'websites'],
        required: [],
        optional: []
    },
    stats_get: {
        candidates: ['get_stats', 'website_stats', 'stats_get', 'stats'],
        required: ['startAt', 'endAt'],
        optional: ['websiteId', 'unit', 'timezone']
    },
    pageviews_get: {
        candidates: ['get_pageviews', 'website_pageviews', 'pageviews_get', 'pageviews'],
        required: ['startAt', 'endAt'],
        optional: ['websiteId', 'unit', 'timezone']
    },
    metrics_get: {
        candidates: ['get_metrics', 'website_metrics', 'metrics_get', 'metrics'],
        required: ['startAt', 'endAt', 'type'],
        optional: ['websiteId', 'url', 'referrer', 'title', 'query', 'event', 'limit', 'timezone']
    },
    events_list: {
        candidates: ['get_events', 'list_events', 'events_list', 'events'],
        required: ['startAt', 'endAt'],
        optional: ['websiteId', 'timezone']
    },
    active_get: {
        candidates: ['get_active_visitors', 'get_active', 'active_visitors', 'active_get', 'active'],
        required: [],
        optional: ['websiteId']
    },
    sessions_get: {
        candidates: ['get_sessions', 'list_sessions', 'sessions_get', 'sessions'],
        required: ['startAt', 'endAt'],
        optional: ['websiteId', 'query', 'page', 'pageSize', 'timezone']
    }
};

function redact(value) {
    return String(value || '')
        .replace(/(password|token|secret|authorization|api[_-]?key)(["'\s:=]+)([^"',\s]+)/gi, '$1$2[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function writeJson(value) {
    process.stdout.write(JSON.stringify(value, null, 2));
}

function debug(...args) {
    if (process.env.UMAMI_DEBUG === 'true') {
        console.error('[umami_tool]', ...args.map(redact));
    }
}

async function readStdin() {
    if (process.stdin.isTTY) return '';
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

function safeJson(text, fallback = null) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function normalizeInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 5; i += 1) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) break;
        if (current.input && typeof current.input === 'object') {
            current = current.input;
            continue;
        }
        if (current.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
            continue;
        }
        if (current.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
            continue;
        }
        if (current.params?.input && typeof current.params.input === 'object') {
            current = current.params.input;
            continue;
        }
        break;
    }
    return current && typeof current === 'object' && !Array.isArray(current) ? current : {};
}

function requireNumber(value, name) {
    if (!Number.isFinite(Number(value))) {
        throw new Error(`${name} must be a finite millisecond timestamp.`);
    }
    return Number(value);
}

function normalizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function defaultWebsiteId() {
    return normalizeString(process.env.UMAMI_DEFAULT_WEBSITE_ID);
}

function defaultTimezone() {
    return normalizeString(process.env.UMAMI_TIMEZONE);
}

function validateActionInput(action, rawInput) {
    const spec = ACTIONS[action];
    if (!spec) throw new Error(`Unsupported umami action: ${action}`);
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const allowed = new Set([...spec.required, ...spec.optional]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
        throw new Error(`Unknown input field(s): ${unknown.join(', ')}`);
    }
    for (const key of spec.required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
            throw new Error(`${key} is required.`);
        }
    }

    const out = {};
    for (const key of allowed) {
        if (input[key] !== undefined && input[key] !== null && input[key] !== '') out[key] = input[key];
    }
    if (allowed.has('websiteId') && !out.websiteId) {
        const fallback = defaultWebsiteId();
        if (fallback) out.websiteId = fallback;
    }
    if (allowed.has('timezone') && !out.timezone) {
        const fallback = defaultTimezone();
        if (fallback) out.timezone = fallback;
    }
    if (allowed.has('startAt')) out.startAt = requireNumber(out.startAt, 'startAt');
    if (allowed.has('endAt')) out.endAt = requireNumber(out.endAt, 'endAt');
    if (allowed.has('limit') && out.limit !== undefined) out.limit = Math.max(1, Math.min(500, Number(out.limit) || 100));
    if (allowed.has('page') && out.page !== undefined) out.page = Math.max(1, Number(out.page) || 1);
    if (allowed.has('pageSize') && out.pageSize !== undefined) out.pageSize = Math.max(1, Math.min(500, Number(out.pageSize) || 100));
    return out;
}

function base64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function parseEventStream(text) {
    const events = [];
    let data = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line) {
            if (data.length) {
                events.push(data.join('\n'));
                data = [];
            }
            continue;
        }
        if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
        }
    }
    if (data.length) events.push(data.join('\n'));
    return events.map((event) => safeJson(event, null)).filter(Boolean);
}

async function readJsonResponse(response, label) {
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const parsed = contentType.includes('text/event-stream')
        ? parseEventStream(text).at(-1)
        : safeJson(text, null);
    if (!response.ok) {
        throw new Error(`${label} failed (${response.status}): ${redact(text)}`);
    }
    if (!parsed) {
        throw new Error(`${label} returned non-JSON response: ${redact(text)}`);
    }
    return parsed;
}

function compactHttpText(text) {
    const stripped = String(text || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped || String(text || '').trim();
}

function mcpEndpoint() {
    const port = Number(process.env.UMAMI_MCP_PORT || DEFAULT_MCP_PORT);
    return `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_MCP_PORT}/mcp`;
}

function oauthBaseUrl() {
    const port = Number(process.env.UMAMI_MCP_PORT || DEFAULT_MCP_PORT);
    return `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_MCP_PORT}`;
}

async function readTokenCache() {
    const parsed = safeJson(await fs.readFile(TOKEN_CACHE_PATH, 'utf8').catch(() => ''), null);
    if (!parsed || typeof parsed.accessToken !== 'string') return '';
    if (Number(parsed.expiresAt || 0) <= Date.now() + 60000) return '';
    return parsed.accessToken;
}

async function writeTokenCache(accessToken, expiresIn) {
    await fs.mkdir(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
    await fs.writeFile(TOKEN_CACHE_PATH, JSON.stringify({
        accessToken,
        expiresAt: Date.now() + Math.max(1, Number(expiresIn) || 3600) * 1000
    }), { mode: 0o600 });
}

async function bootstrapOAuthToken({ force = false } = {}) {
    if (!force) {
        const cached = await readTokenCache();
        if (cached) return cached;
    }

    const username = normalizeString(process.env.UMAMI_USERNAME) || 'admin';
    const password = normalizeString(process.env.UMAMI_PASSWORD) || 'umami';

    const baseUrl = oauthBaseUrl();
    const clientId = normalizeString(process.env.OAUTH_CLIENT_ID) || DEFAULT_OAUTH_CLIENT_ID;
    const redirectUri = normalizeString(process.env.OAUTH_REDIRECT_URI) || `${baseUrl}/oauth/callback`;
    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(16));

    const authorizeBody = new URLSearchParams({
        username,
        password,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_challenge: codeChallenge,
        state
    });
    const authorizeResponse = await fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: authorizeBody
    });
    if (![302, 303].includes(authorizeResponse.status)) {
        const text = await authorizeResponse.text().catch(() => '');
        throw new Error(`umami-mcp OAuth authorize failed (${authorizeResponse.status}): ${redact(compactHttpText(text))}`);
    }
    const location = authorizeResponse.headers.get('location');
    if (!location) {
        throw new Error('umami-mcp OAuth authorize did not return a redirect location.');
    }
    const redirect = new URL(location);
    if (redirect.searchParams.get('state') !== state) {
        throw new Error('umami-mcp OAuth state mismatch.');
    }
    const code = redirect.searchParams.get('code');
    if (!code) {
        throw new Error('umami-mcp OAuth redirect did not include an authorization code.');
    }

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: codeVerifier,
            client_id: clientId
        })
    });
    const token = await readJsonResponse(tokenResponse, 'umami-mcp OAuth token');
    const accessToken = normalizeString(token.access_token);
    if (!accessToken) {
        throw new Error('umami-mcp OAuth token response did not include access_token.');
    }
    await writeTokenCache(accessToken, token.expires_in);
    return accessToken;
}

class HttpMcpClient {
    constructor() {
        this.endpoint = mcpEndpoint();
        this.messageId = 0;
        this.protocolVersion = '2025-06-18';
        this.sessionId = '';
        this.accessToken = '';
        this.initialized = false;
    }

    nextId() {
        this.messageId += 1;
        return `umami-${this.messageId}`;
    }

    async start() {
        this.accessToken = await bootstrapOAuthToken();
        await this.initialize();
    }

    async send(method, params = {}, { notification = false, retryAuth = true } = {}) {
        const id = notification ? undefined : this.nextId();
        const headers = {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            authorization: `Bearer ${this.accessToken}`
        };
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
        if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                ...(id ? { id } : {}),
                method,
                params
            })
        });
        if (response.status === 401 && retryAuth) {
            this.accessToken = await bootstrapOAuthToken({ force: true });
            return this.send(method, params, { notification, retryAuth: false });
        }
        const nextSessionId = response.headers.get('mcp-session-id');
        if (nextSessionId) this.sessionId = nextSessionId;
        if (notification) {
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`MCP notification ${method} failed (${response.status}): ${redact(text)}`);
            }
            return null;
        }
        const payload = await readJsonResponse(response, `MCP ${method}`);
        if (payload.error) {
            throw new Error(payload.error.message || JSON.stringify(payload.error));
        }
        return payload.result;
    }

    async initialize() {
        if (this.initialized) return;
        const result = await this.send('initialize', {
            protocolVersion: this.protocolVersion,
            capabilities: {},
            clientInfo: {
                name: 'achilles-umami-agent',
                version: '0.1.0'
            }
        });
        this.protocolVersion = normalizeString(result?.protocolVersion, this.protocolVersion);
        await this.send('notifications/initialized', {}, { notification: true });
        this.initialized = true;
    }

    async listTools() {
        const result = await this.send('tools/list', {});
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    async callTool(name, args) {
        return this.send('tools/call', {
            name,
            arguments: args || {}
        });
    }

    async close() {
        return;
    }
}

function chooseTool(tools, candidates) {
    const names = tools.map((tool) => tool?.name).filter(Boolean);
    for (const candidate of candidates) {
        if (names.includes(candidate)) return candidate;
    }
    for (const candidate of candidates) {
        const loose = names.find((name) => name.toLowerCase() === candidate.toLowerCase());
        if (loose) return loose;
    }
    for (const candidate of candidates) {
        const needle = candidate.replace(/^(get|list)_/, '').replace(/_/g, '').toLowerCase();
        const loose = names.find((name) => name.replace(/_/g, '').toLowerCase().includes(needle));
        if (loose) return loose;
    }
    throw new Error(`No compatible umami-mcp tool found. Wanted one of: ${candidates.join(', ')}. Available: ${names.join(', ') || '(none)'}`);
}

function toIsoTimestamp(value, name) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) {
        throw new Error(`${name} must be a valid millisecond timestamp.`);
    }
    return date.toISOString();
}

function adaptUpstreamInput(action, input) {
    const out = { ...(input || {}) };
    if (out.startAt !== undefined) out.startAt = toIsoTimestamp(out.startAt, 'startAt');
    if (out.endAt !== undefined) out.endAt = toIsoTimestamp(out.endAt, 'endAt');
    if (action === 'pageviews_get' && !out.unit) out.unit = 'day';
    if (action === 'metrics_get' && out.type === 'url') out.type = 'path';
    return out;
}

function extractContent(result) {
    if (Array.isArray(result?.content)) {
        const textItems = result.content
            .filter((item) => item?.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text);
        if (textItems.length === 1) {
            const parsed = safeJson(textItems[0], null);
            return parsed ?? textItems[0];
        }
        if (textItems.length) return textItems;
    }
    return result;
}

async function callUmamiMcp(client, action, input) {
    const spec = ACTIONS[action];
    const tools = await client.listTools();
    const toolName = chooseTool(tools, spec.candidates);
    const result = await client.callTool(toolName, adaptUpstreamInput(action, input));
    return {
        action,
        upstreamTool: toolName,
        result: extractContent(result)
    };
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

async function generateReport(client, rawInput) {
    const unknown = Object.keys(rawInput || {}).filter((key) => !['websiteId', 'startAt', 'endAt', 'label', 'timezone'].includes(key));
    if (unknown.length) {
        throw new Error(`Unknown input field(s): ${unknown.join(', ')}`);
    }
    const { label: _label, ...statsInput } = rawInput || {};
    const input = validateActionInput('stats_get', statsInput);
    const websiteId = input.websiteId;
    if (!websiteId) {
        throw new Error('websiteId is required for report generation when UMAMI_DEFAULT_WEBSITE_ID is not set.');
    }
    const label = normalizeString(rawInput.label) || `${dateSlug(input.startAt)}-to-${dateSlug(input.endAt)}`;
    const stats = await callUmamiMcp(client, 'stats_get', input);
    const pageviews = await callUmamiMcp(client, 'pageviews_get', input);
    const topPages = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'path', limit: 25 });
    const referrers = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'referrer', limit: 25 });
    const countries = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'country', limit: 25 });

    const lines = [
        `# Umami Report - ${label}`,
        '',
        `- Website: ${websiteId}`,
        `- Start: ${new Date(input.startAt).toISOString()}`,
        `- End: ${new Date(input.endAt).toISOString()}`,
        `- Timezone: ${input.timezone || 'default'}`,
        '',
        '## Summary',
        '',
        '```json',
        JSON.stringify(stats.result, null, 2),
        '```',
        '',
        '## Pageviews',
        '',
        '```json',
        JSON.stringify(pageviews.result, null, 2),
        '```',
        '',
        '## Top Pages',
        '',
        summarizeRows(topPages.result),
        '',
        '## Referrers',
        '',
        summarizeRows(referrers.result),
        '',
        '## Countries',
        '',
        summarizeRows(countries.result),
        ''
    ];

    const outputDir = normalizeString(process.env.UMAMI_OUTPUT_DIR) || DEFAULT_OUTPUT_DIR;
    await fs.mkdir(outputDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
    const filePath = path.join(outputDir, `${safeLabel}.md`);
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    return {
        ok: true,
        filePath,
        sections: ['summary', 'pageviews', 'top-pages', 'referrers', 'countries']
    };
}

async function main() {
    const action = normalizeString(process.env.UMAMI_ACTION || process.env.TOOL_NAME);
    const client = new HttpMcpClient();
    const clientStart = client.start();
    const envelope = safeJson(await readStdin(), {});
    const input = normalizeInput(envelope);
    try {
        await clientStart;
        if (action === 'report_generate') {
            writeJson(await generateReport(client, input));
            return;
        }
        const normalized = validateActionInput(action, input);
        if (ACTIONS[action]?.optional.includes('websiteId') && !normalized.websiteId && action !== 'websites_list') {
            throw new Error('websiteId is required when UMAMI_DEFAULT_WEBSITE_ID is not set.');
        }
        writeJson(await callUmamiMcp(client, action, normalized));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson({
            ok: false,
            error: redact(message),
            action
        });
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

main();
