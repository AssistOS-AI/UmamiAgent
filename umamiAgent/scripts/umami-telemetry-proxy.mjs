import http from 'node:http';

const DEFAULT_UPSTREAM_ORIGIN = 'http://127.0.0.1:3000';
const UPSTREAM_BASE_PATH = '/services/umami';
const LISTEN_PORT = 3001;
const SCRIPT_PATH = '/script.js';
const INGEST_PATH = '/api/send';
const RATE_SOURCE_HEADER = 'x-ploinky-rate-source';
const RATE_SOURCE_PATTERN = /^[0-9a-f]{64}$/i;
const SANITIZATION_EVIDENCE_HEADER = 'x-umami-telemetry-sanitization';
const SANITIZATION_EVIDENCE_VALUE = [
    'client-cookie=absent',
    'client-authorization=absent',
    'client-identity=absent',
    'client-forwarding=absent',
    'client-hop-by-hop=absent',
].join('; ');

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function positiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) {
        throw new Error(`${name} must be a positive base-10 integer.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${name} must be a safe positive integer.`);
    }
    return value;
}

function parseAllowedOrigins(value) {
    const origins = new Set();
    for (const raw of String(value || '').split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const url = new URL(entry);
        if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
            throw new Error(`Invalid UMAMI_TELEMETRY_ALLOWED_ORIGINS entry: ${entry}`);
        }
        origins.add(url.origin);
    }
    if (!origins.size) {
        throw new Error('UMAMI_TELEMETRY_ALLOWED_ORIGINS requires at least one exact HTTP(S) origin.');
    }
    return origins;
}

function exactOrigin(req) {
    const raw = String(req.headers.origin || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return raw === parsed.origin ? parsed.origin : '';
    } catch (_) {
        return '';
    }
}

function exactRateSource(req) {
    const raw = req.headers[RATE_SOURCE_HEADER];
    if (typeof raw !== 'string' || !RATE_SOURCE_PATTERN.test(raw)) return '';
    return raw.toLowerCase();
}

function send(res, statusCode, body = '', headers = {}) {
    res.writeHead(statusCode, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        ...headers,
    });
    res.end(body);
}

function proxyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function readBody(req, maxBodyBytes, timeoutMs) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => {
            finish(reject, proxyError('body_timeout', 'Telemetry request body timed out.'));
            req.resume?.();
        }, timeoutMs);
        timer.unref?.();

        function cleanup() {
            clearTimeout(timer);
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('aborted', onAborted);
            req.off('error', onError);
        }
        function finish(callback, value) {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        }
        function onData(chunk) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBodyBytes) {
                finish(reject, proxyError('body_too_large', 'Telemetry request body is too large.'));
                req.resume?.();
                return;
            }
            chunks.push(buffer);
        }
        function onEnd() {
            finish(resolve, Buffer.concat(chunks));
        }
        function onAborted() {
            finish(reject, proxyError('body_aborted', 'Telemetry request body was aborted.'));
        }
        function onError(error) {
            finish(reject, error);
        }

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('aborted', onAborted);
        req.on('error', onError);
    });
}

function responseHeaders(upstreamHeaders, origin, isScript) {
    const headers = {
        'content-type': String(upstreamHeaders['content-type'] || (isScript ? 'application/javascript' : 'application/json')),
        'cache-control': isScript ? String(upstreamHeaders['cache-control'] || 'public, max-age=300') : 'no-store',
        'x-content-type-options': 'nosniff',
        [SANITIZATION_EVIDENCE_HEADER]: SANITIZATION_EVIDENCE_VALUE,
    };
    for (const name of ['etag', 'last-modified']) {
        if (upstreamHeaders[name]) headers[name] = upstreamHeaders[name];
    }
    if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
    }
    return headers;
}

function clientDerivedHeaderIsForbidden(name) {
    const lower = String(name || '').trim().toLowerCase();
    return lower === 'cookie'
        || lower === 'authorization'
        || lower === 'forwarded'
        || lower.startsWith('x-forwarded-')
        || lower.startsWith('x-ploinky-')
        || HOP_BY_HOP_HEADERS.has(lower);
}

function sanitizedUpstreamHeaders(req, target, origin, body) {
    const headers = {
        accept: String(req.headers.accept || '*/*'),
        'user-agent': String(req.headers['user-agent'] || ''),
        host: target.host,
    };
    if (origin) headers.origin = origin;
    if (body.length) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
    }
    const forbidden = Object.keys(headers).filter(clientDerivedHeaderIsForbidden);
    if (forbidden.length) {
        throw proxyError('unsafe_upstream_headers', 'Telemetry upstream headers failed sanitization.');
    }
    return headers;
}

function forward({
    req,
    res,
    pathname,
    body,
    origin,
    upstreamOrigin,
    requestImpl,
    upstreamTimeoutMs,
    maxResponseBytes,
}) {
    const target = new URL(`${UPSTREAM_BASE_PATH}${pathname}`, upstreamOrigin);
    const headers = sanitizedUpstreamHeaders(req, target, origin, body);
    return new Promise((resolve, reject) => {
        let settled = false;
        function finish(callback, value) {
            if (settled) return;
            settled = true;
            callback(value);
        }
        const upstream = requestImpl(target, { method: req.method, headers }, (upstreamResponse) => {
            const chunks = [];
            let bytes = 0;
            upstreamResponse.setTimeout?.(upstreamTimeoutMs, () => {
                upstreamResponse.destroy(proxyError('upstream_timeout', 'Telemetry upstream response timed out.'));
            });
            upstreamResponse.on('data', (chunk) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > maxResponseBytes) {
                    upstreamResponse.destroy(proxyError('response_too_large', 'Telemetry upstream response is too large.'));
                    return;
                }
                chunks.push(buffer);
            });
            upstreamResponse.once('end', () => {
                if (settled) return;
                const responseBody = req.method === 'HEAD' ? Buffer.alloc(0) : Buffer.concat(chunks);
                res.writeHead(
                    upstreamResponse.statusCode || 502,
                    responseHeaders(upstreamResponse.headers, origin, pathname === SCRIPT_PATH),
                );
                res.end(responseBody);
                finish(resolve);
            });
            upstreamResponse.once('error', (error) => finish(reject, error));
            upstreamResponse.once('aborted', () => {
                finish(reject, proxyError('upstream_aborted', 'Telemetry upstream response was aborted.'));
            });
        });
        upstream.setTimeout?.(upstreamTimeoutMs, () => {
            upstream.destroy(proxyError('upstream_timeout', 'Telemetry upstream request timed out.'));
        });
        upstream.once('error', (error) => finish(reject, error));
        if (body.length) upstream.write(body);
        upstream.end();
    });
}

export function createTelemetryHandler({
    allowedOrigins: configuredOrigins = process.env.UMAMI_TELEMETRY_ALLOWED_ORIGINS,
    upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
    maxBodyBytes = positiveInt('UMAMI_TELEMETRY_MAX_BODY_BYTES', 65_536),
    perSourceLimit = positiveInt('UMAMI_TELEMETRY_PER_SOURCE_PER_MINUTE', 120),
    globalLimit = positiveInt('UMAMI_TELEMETRY_GLOBAL_PER_MINUTE', 1_200),
    bodyTimeoutMs = positiveInt('UMAMI_TELEMETRY_BODY_TIMEOUT_MS', 5_000),
    upstreamTimeoutMs = positiveInt('UMAMI_TELEMETRY_UPSTREAM_TIMEOUT_MS', 5_000),
    maxResponseBytes = positiveInt('UMAMI_TELEMETRY_MAX_RESPONSE_BYTES', 2 * 1024 * 1024),
    now = () => Date.now(),
    requestImpl = http.request,
    onAudit = () => {},
} = {}) {
    const allowedOrigins = configuredOrigins instanceof Set
        ? new Set(configuredOrigins)
        : parseAllowedOrigins(configuredOrigins);
    const parsedUpstream = new URL(upstreamOrigin);
    if (parsedUpstream.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsedUpstream.hostname)) {
        throw new Error('Umami telemetry upstream must be process-local HTTP.');
    }
    const counters = new Map();
    let globalCounter = { window: 0, count: 0 };
    const auditCounters = {
        requests: 0,
        forwarded: 0,
        upstreamFailures: 0,
        rejected: Object.create(null),
    };

    function audit(event) {
        if (event === 'request') auditCounters.requests += 1;
        else if (event === 'forwarded') auditCounters.forwarded += 1;
        else if (event === 'upstream_failure') auditCounters.upstreamFailures += 1;
        else auditCounters.rejected[event] = (auditCounters.rejected[event] || 0) + 1;
        try {
            onAudit({ event, at: new Date(Number(now())).toISOString() });
        } catch (_) {
            // Observability must never widen or break the telemetry boundary.
        }
    }

    function rateLimitAllows(source) {
        const window = Math.floor(Number(now()) / 60_000);
        if (globalCounter.window !== window) {
            globalCounter = { window, count: 0 };
            counters.clear();
        }
        const current = counters.get(source);
        const bucket = current?.window === window ? current : { window, count: 0 };
        if (globalCounter.count >= globalLimit || bucket.count >= perSourceLimit) return false;
        globalCounter.count += 1;
        bucket.count += 1;
        counters.set(source, bucket);
        return true;
    }

    async function handle(req, res) {
        audit('request');
        const url = new URL(req.url, 'http://127.0.0.1');
        const origin = exactOrigin(req);
        const isScript = url.pathname === SCRIPT_PATH && !url.search && ['GET', 'HEAD'].includes(req.method);
        const isIngest = url.pathname === INGEST_PATH && !url.search && req.method === 'POST';
        const isPreflight = url.pathname === INGEST_PATH && !url.search && req.method === 'OPTIONS';

        if (!isScript && !isIngest && !isPreflight) {
            audit('unknown_path');
            send(res, 404, 'Not found.');
            return;
        }
        if ((isIngest || isPreflight) && (!origin || !allowedOrigins.has(origin))) {
            audit('origin_denied');
            send(res, 403, 'Origin denied.');
            return;
        }
        if (isPreflight) {
            const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
            const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase();
            if (requestedMethod !== 'POST' || (requestedHeaders && requestedHeaders !== 'content-type')) {
                audit('preflight_denied');
                send(res, 403, 'Preflight denied.');
                return;
            }
            audit('preflight');
            send(res, 204, '', {
                'access-control-allow-origin': origin,
                'access-control-allow-methods': 'POST, OPTIONS',
                'access-control-allow-headers': 'content-type',
                'access-control-max-age': '300',
                vary: 'Origin',
            });
            return;
        }
        if (isIngest) {
            const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
            if (type !== 'application/json') {
                audit('content_type_denied');
                send(res, 415, 'JSON required.');
                return;
            }
            const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
            if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
                audit('body_too_large');
                send(res, 413, 'Request body too large.');
                req.resume?.();
                return;
            }
            const source = exactRateSource(req);
            if (!source) {
                audit('rate_source_denied');
                send(res, 400, 'Rate source required.');
                req.resume?.();
                return;
            }
            if (!rateLimitAllows(source)) {
                audit('rate_limited');
                send(res, 429, 'Rate limit exceeded.', { 'retry-after': '60' });
                return;
            }
        }
        try {
            const body = isIngest ? await readBody(req, maxBodyBytes, bodyTimeoutMs) : Buffer.alloc(0);
            await forward({
                req,
                res,
                pathname: url.pathname,
                body,
                origin: origin && allowedOrigins.has(origin) ? origin : '',
                upstreamOrigin: parsedUpstream.origin,
                requestImpl,
                upstreamTimeoutMs,
                maxResponseBytes,
            });
            audit('forwarded');
        } catch (error) {
            if (res.headersSent || res.writableEnded) {
                res.destroy();
                return;
            }
            if (error?.code === 'body_too_large') {
                audit('body_too_large');
                send(res, 413, 'Request body too large.');
                return;
            }
            if (error?.code === 'body_timeout' || error?.code === 'body_aborted') {
                audit('body_timeout');
                send(res, 408, 'Request body timed out.');
                return;
            }
            audit('upstream_failure');
            send(res, 502, 'Telemetry upstream unavailable.');
        }
    }
    handle.snapshotAuditCounters = () => JSON.parse(JSON.stringify(auditCounters));
    return handle;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
    const server = http.createServer(createTelemetryHandler());
    server.listen(LISTEN_PORT, '0.0.0.0');
}

export const _test = Object.freeze({
    INGEST_PATH,
    RATE_SOURCE_HEADER,
    RATE_SOURCE_PATTERN,
    SANITIZATION_EVIDENCE_HEADER,
    SANITIZATION_EVIDENCE_VALUE,
    SCRIPT_PATH,
    UPSTREAM_BASE_PATH,
    clientDerivedHeaderIsForbidden,
    exactRateSource,
    parseAllowedOrigins,
    positiveInt,
});
