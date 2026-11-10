import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const UMAMI_BASE_PATH = '/base-agent-additional-server/umamiAgent/3000';
export const UMAMI_PUBLIC_PORT = 3000;
export const UMAMI_UPSTREAM_PORT = 3001;

export function verifyUmamiBuild(appDirectory = '/app') {
    const build = JSON.parse(fs.readFileSync(path.join(appDirectory, 'ploinky-umami-build.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(appDirectory, '.next/required-server-files.json'), 'utf8')).config;
    if (build.schema !== 'ploinky.umami-build/v1'
        || build.version !== '3.4.1'
        || !/^[0-9a-f]{40}$/.test(build.sourceCommit || '')
        || build.basePath !== UMAMI_BASE_PATH
        || config?.basePath !== UMAMI_BASE_PATH) {
        throw new Error('Umami image does not contain the required source-built Router base path.');
    }
    return build;
}

const hopByHopHeaders = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function relayHeaders(headers) {
    const connectionHeaders = new Set(String(headers.connection || '').toLowerCase().split(',').map((name) => name.trim()));
    return Object.fromEntries(Object.entries(headers).filter(([name]) => (
        !hopByHopHeaders.has(name.toLowerCase()) && !connectionHeaders.has(name.toLowerCase())
    )));
}

// The tracker endpoint is a public Router route that websites on other origins
// POST to. Umami answers it with a wildcard CORS policy, which the Router never
// relays, so echo the caller's exact origin with only what the tracker needs.
export const TRACKER_SEND_PATH = '/api/send';

export function isTrackerSendRequest(url) {
    return typeof url === 'string' && url.split('?')[0] === TRACKER_SEND_PATH;
}

export function trackerCorsHeaders(headers, origin) {
    let normalizedOrigin;
    try {
        const parsed = new URL(String(origin || ''));
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return headers;
        normalizedOrigin = parsed.origin;
    } catch {
        return headers;
    }
    const result = Object.fromEntries(Object.entries(headers).filter(([name]) => (
        !name.toLowerCase().startsWith('access-control-') && name.toLowerCase() !== 'vary'
    )));
    const vary = String(headers.vary || headers.Vary || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!vary.some((value) => value.toLowerCase() === 'origin')) vary.push('Origin');
    return {
        ...result,
        'access-control-allow-origin': normalizedOrigin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-umami-website-id, x-umami-hostname, x-umami-cache',
        'access-control-max-age': '600',
        vary: vary.join(', '),
    };
}

export function upstreamPath(url) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || /[\\\r\n#]/.test(url)) {
        throw new Error('Umami ingress requires an origin-form request target.');
    }
    // Next's base-path root has no trailing slash. Avoid a redirect loop when
    // Router maps both the published root and its slash form to upstream '/'.
    return UMAMI_BASE_PATH + (url === '/' ? '' : url.startsWith('/?') ? url.slice(1) : url);
}

// Umami's built-in MCP endpoint is for in-container callers only. Resolve the
// target before comparing: WHATWG URL parsing removes the query and resolves
// dot segments and %2e, then each segment is percent-decoded (repeatedly, with
// decoded separators treated as separators) and compared case-insensitively.
// The check errs toward blocking, so no spelling reaches /mcp through the
// Router.
export const UMAMI_MCP_PATH = `${UMAMI_BASE_PATH}/mcp`;

function resolvedSegments(pathname) {
    const resolved = [];
    for (const raw of pathname.split('/')) {
        let segment = raw;
        for (let pass = 0; pass < 3; pass += 1) {
            let decoded;
            try {
                decoded = decodeURIComponent(segment);
            } catch {
                break;
            }
            if (decoded === segment) break;
            segment = decoded;
        }
        for (const part of segment.split(/[\\/]/)) {
            if (part === '' || part === '.') continue;
            if (part === '..') resolved.pop();
            else resolved.push(part.toLowerCase());
        }
    }
    return resolved;
}

export function isMcpPath(url) {
    let pathname;
    try {
        pathname = new URL(upstreamPath(url), 'http://umami.invalid').pathname;
    } catch {
        return false;
    }
    const segments = resolvedSegments(pathname);
    const mcp = resolvedSegments(UMAMI_MCP_PATH);
    return mcp.every((segment, index) => segments[index] === segment) && segments.length >= mcp.length;
}

export function createUmamiIngress({ upstreamPort = UMAMI_UPSTREAM_PORT } = {}) {
    const server = http.createServer((request, response) => {
        const prefix = request.headers['x-forwarded-prefix'];
        if (prefix !== undefined && prefix !== UMAMI_BASE_PATH) {
            response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            response.end('Invalid Umami publication prefix.');
            return;
        }
        let requestPath;
        try {
            requestPath = upstreamPath(request.url);
        } catch {
            response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            response.end('Invalid Umami request target.');
            return;
        }
        if (prefix !== undefined && isMcpPath(request.url)) {
            response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            response.end('Not found.');
            return;
        }
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: upstreamPort,
            method: request.method,
            path: requestPath,
            headers: relayHeaders(request.headers),
        }, (incoming) => {
            const headers = relayHeaders(incoming.headers);
            response.writeHead(
                incoming.statusCode,
                isTrackerSendRequest(request.url) ? trackerCorsHeaders(headers, request.headers.origin) : headers,
            );
            pipeline(incoming, response, () => {});
        });
        upstream.on('error', () => {
            if (response.destroyed) return;
            if (response.headersSent) {
                response.destroy();
            } else {
                response.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
                response.end('Umami application is unavailable.');
            }
        });
        response.on('close', () => {
            if (!response.writableFinished) upstream.destroy();
        });
        request.on('aborted', () => upstream.destroy());
        request.on('error', () => upstream.destroy());
        request.pipe(upstream);
    });
    server.on('upgrade', (_request, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    return server;
}

// Ploinky stages /code through symlinks; startup clears Node's symlink options.
if (process.argv[1] && fs.existsSync(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    verifyUmamiBuild();
    if (process.argv[2] !== '--check-build') {
        if (process.argv.length !== 2) throw new Error('Unexpected Umami ingress arguments.');
        createUmamiIngress().listen(UMAMI_PUBLIC_PORT, '0.0.0.0');
    }
}
