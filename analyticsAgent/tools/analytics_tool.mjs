#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MCP_COMMAND = 'node /usr/local/lib/node_modules/npm/bin/npx-cli.js -y @madsnyl/umami-mcp';
const DEFAULT_BASE_URL = 'http://analytics-umami:3000';
const DEFAULT_OUTPUT_DIR = '/shared/deliverables/analytics';

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
        candidates: ['get_active', 'active_visitors', 'active_get', 'active'],
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
    if (process.env.ANALYTICS_DEBUG === 'true') {
        console.error('[analytics_tool]', ...args.map(redact));
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
    if (!spec) throw new Error(`Unsupported analytics action: ${action}`);
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

function analyticsEnv() {
    const baseUrl = normalizeString(process.env.UMAMI_BASE_URL) || DEFAULT_BASE_URL;
    const token = normalizeString(process.env.UMAMI_TOKEN);
    const username = normalizeString(process.env.UMAMI_USERNAME) || 'admin';
    const password = normalizeString(process.env.UMAMI_PASSWORD);
    return {
        ...process.env,
        UMAMI_BASE_URL: baseUrl,
        UMAMI_URL: baseUrl,
        UMAMI_API_URL: `${baseUrl.replace(/\/+$/, '')}/api`,
        UMAMI_TOKEN: token,
        UMAMI_API_KEY: token,
        UMAMI_USERNAME: username,
        UMAMI_USER: username,
        UMAMI_PASSWORD: password,
        UMAMI_PASS: password
    };
}

function splitCommand(command) {
    const parts = [];
    let current = '';
    let quote = '';
    let escaping = false;
    for (const ch of String(command || '')) {
        if (escaping) {
            current += ch;
            escaping = false;
            continue;
        }
        if (ch === '\\') {
            escaping = true;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = '';
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                parts.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (escaping) current += '\\';
    if (quote) throw new Error('UMAMI_MCP_COMMAND has an unterminated quote.');
    if (current) parts.push(current);
    if (!parts.length) throw new Error('UMAMI_MCP_COMMAND is empty.');
    return parts;
}

function parseMcpOutputLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    return safeJson(trimmed, null);
}

class StdioMcpClient {
    constructor(command) {
        this.command = command;
    }

    async start() {
        return;
    }

    async batch(requests) {
        const [program, ...args] = splitCommand(this.command);
        debug('starting umami-mcp batch:', program, args.join(' '));
        let id = 1;
        const messages = [
            {
                jsonrpc: '2.0',
                id: id++,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: {
                        name: 'achilles-analytics-agent',
                        version: '0.1.0'
                    }
                }
            },
            {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            }
        ];
        const responseIds = [];
        for (const request of requests) {
            const requestId = id++;
            responseIds.push(requestId);
            messages.push({
                jsonrpc: '2.0',
                id: requestId,
                method: request.method,
                params: request.params || {}
            });
        }

        const tempDir = process.env.TMPDIR || '/tmp';
        const tempPath = path.join(tempDir, `analytics-umami-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
        fsSync.writeFileSync(tempPath, messages.map((message) => JSON.stringify(message)).join('\n') + '\n', {
            mode: 0o600
        });
        const inputFd = fsSync.openSync(tempPath, 'r');
        const child = spawn(program, args, {
            cwd: fsSync.existsSync('/code') ? '/code' : process.cwd(),
            env: analyticsEnv(),
            stdio: [inputFd, 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        const byId = new Map();
        let settled = false;
        let resolveDone;
        let rejectDone;
        const done = new Promise((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        const tryResolveResponses = () => {
            if (settled) return;
            if (!responseIds.every((responseId) => byId.has(responseId))) return;
            settled = true;
            try { child.kill('SIGTERM'); } catch {}
            resolveDone();
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            for (;;) {
                const idx = stdout.indexOf('\n');
                if (idx < 0) break;
                const line = stdout.slice(0, idx);
                stdout = stdout.slice(idx + 1);
                const msg = parseMcpOutputLine(line);
                if (!msg || msg.id === undefined) continue;
                byId.set(msg.id, msg);
            }
            tryResolveResponses();
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        const exit = new Promise((resolve, reject) => {
            child.on('error', (error) => {
                const err = new Error(`Failed to start umami-mcp command '${redact(this.command)}': ${error.message}`);
                reject(err);
                if (!settled) {
                    settled = true;
                    rejectDone(err);
                }
            });
            child.on('exit', (code, signal) => {
                debug('umami-mcp batch exit:', code ?? '', signal ?? '');
                try { fsSync.closeSync(inputFd); } catch {}
                try { fsSync.unlinkSync(tempPath); } catch {}
                if (code && code !== 0) {
                    const err = new Error(`umami-mcp exited (${code ?? signal ?? 'unknown'}): ${redact(stderr)}`);
                    reject(err);
                    if (!settled) {
                        settled = true;
                        rejectDone(err);
                    }
                } else {
                    resolve();
                    if (!settled) {
                        settled = true;
                        rejectDone(new Error(`umami-mcp exited before returning all responses. stderr: ${redact(stderr)}`));
                    }
                }
            });
        });

        await Promise.race([
            done,
            new Promise((_, reject) => setTimeout(() => {
                if (!settled) settled = true;
                try { child.kill('SIGTERM'); } catch {}
                reject(new Error(`Timed out waiting for umami-mcp batch. stderr: ${redact(stderr)}`));
            }, Number(process.env.UMAMI_MCP_TIMEOUT_MS || 30000)))
        ]);
        await Promise.race([exit.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]);

        return responseIds.map((requestId) => {
            const msg = byId.get(requestId);
            if (!msg) {
                throw new Error(`umami-mcp did not return response id ${requestId}. stderr: ${redact(stderr)}`);
            }
            if (msg.error) {
                throw new Error(msg.error.message || JSON.stringify(msg.error));
            }
            return msg.result;
        });
    }

    async listTools() {
        const [result] = await this.batch([{ method: 'tools/list' }]);
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    async callTool(name, args) {
        const [result] = await this.batch([{
            method: 'tools/call',
            params: {
                name,
                arguments: args
            }
        }]);
        return result;
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
    const result = await client.callTool(toolName, input);
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
    const topPages = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'url', limit: 25 });
    const referrers = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'referrer', limit: 25 });
    const countries = await callUmamiMcp(client, 'metrics_get', { ...input, type: 'country', limit: 25 });

    const lines = [
        `# Analytics Report - ${label}`,
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

    const outputDir = normalizeString(process.env.ANALYTICS_OUTPUT_DIR) || DEFAULT_OUTPUT_DIR;
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
    const action = normalizeString(process.env.ANALYTICS_ACTION || process.env.TOOL_NAME);
    const command = normalizeString(process.env.UMAMI_MCP_COMMAND) || DEFAULT_MCP_COMMAND;
    const client = new StdioMcpClient(command);
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
