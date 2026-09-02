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
        || build.version !== '3.2.0'
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

export function upstreamPath(url) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || /[\\\r\n#]/.test(url)) {
        throw new Error('Umami ingress requires an origin-form request target.');
    }
    // Next's base-path root has no trailing slash. Avoid a redirect loop when
    // Router maps both the published root and its slash form to upstream '/'.
    return UMAMI_BASE_PATH + (url === '/' ? '' : url.startsWith('/?') ? url.slice(1) : url);
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
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: upstreamPort,
            method: request.method,
            path: requestPath,
            headers: relayHeaders(request.headers),
        }, (incoming) => {
            response.writeHead(incoming.statusCode, relayHeaders(incoming.headers));
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
