import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
    createUmamiIngress, isMcpPath, upstreamPath, verifyUmamiBuild, trackerCorsHeaders,
    UMAMI_BASE_PATH, UMAMI_PUBLIC_PORT, UMAMI_UPSTREAM_PORT,
} from '../scripts/umami-ingress.mjs';

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

async function request(port, target, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ hostname: '127.0.0.1', port, path: target, method, headers }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
            response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

async function withIngress(handler, run) {
    const upstream = http.createServer(handler);
    const upstreamPort = await listen(upstream);
    const ingress = createUmamiIngress({ upstreamPort });
    const port = await listen(ingress);
    try {
        await run({ port, upstream, upstreamPort });
    } finally {
        await close(ingress);
        await close(upstream);
    }
}

test('only the exact source-built Router base path is admitted before startup', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-build-'));
    const metadata = { schema: 'ploinky.umami-build/v1', version: '3.4.1', sourceCommit: 'a'.repeat(40), basePath: UMAMI_BASE_PATH };
    fs.mkdirSync(path.join(app, '.next'));
    const write = (build = metadata, config = { basePath: UMAMI_BASE_PATH }) => {
        fs.writeFileSync(path.join(app, 'ploinky-umami-build.json'), JSON.stringify(build));
        fs.writeFileSync(path.join(app, '.next/required-server-files.json'), JSON.stringify({ config }));
    };
    try {
        assert.throws(() => verifyUmamiBuild(app), /ENOENT/);
        write();
        assert.deepEqual(verifyUmamiBuild(app), metadata);
        for (const override of [
            { schema: 'unknown' }, { version: '3.2.0' }, { sourceCommit: 'main' }, { basePath: '' },
        ]) {
            write({ ...metadata, ...override });
            assert.throws(() => verifyUmamiBuild(app), /required source-built Router base path/);
        }
        write(metadata, { basePath: '' });
        assert.throws(() => verifyUmamiBuild(app), /required source-built Router base path/);
    } finally {
        fs.rmSync(app, { recursive: true, force: true });
    }
});

test('the fixed public and loopback ports differ, and paths preserve encoded queries', () => {
    assert.equal(UMAMI_PUBLIC_PORT, 3000);
    assert.equal(UMAMI_UPSTREAM_PORT, 3001);
    assert.equal(upstreamPath('/'), UMAMI_BASE_PATH);
    assert.equal(upstreamPath('/?page=%2Fone%20two'), `${UMAMI_BASE_PATH}?page=%2Fone%20two`);
    assert.equal(upstreamPath('/api/websites?url=%2Ftest%3Fq%3D1'), `${UMAMI_BASE_PATH}/api/websites?url=%2Ftest%3Fq%3D1`);
    for (const target of ['http://other.invalid/', '//other.invalid/', '/a\\b', '/a#b', '/a\r\nb']) {
        assert.throws(() => upstreamPath(target), /origin-form/);
    }
});

test('Router and internal requests reach the prefixed HTML, asset, API, tracker and redirect without rewriting payloads', { timeout: 10_000 }, async () => {
    const observed = [];
    const compressedAsset = gzipSync('export const prefix = "/literal/unchanged";');
    await withIngress(async (incoming, response) => {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        observed.push({ path: incoming.url, method: incoming.method, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
        if (incoming.url.endsWith('/_next/static/app.js')) {
            response.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': compressedAsset.length });
            response.end(compressedAsset);
        } else if (incoming.url.endsWith('/redirect')) {
            response.writeHead(307, { location: `${UMAMI_BASE_PATH}/login`, 'set-cookie': 'service-session=fixture; HttpOnly; Path=/' });
            response.end();
        } else {
            response.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive, x-private-hop', 'x-private-hop': 'remove' });
            response.end(JSON.stringify({ path: incoming.url }));
        }
    }, async ({ port }) => {
        const headers = { 'x-forwarded-prefix': UMAMI_BASE_PATH, host: 'router.example', 'x-forwarded-host': 'router.example' };
        const html = await request(port, '/', { headers });
        assert.equal(html.status, 200);
        assert.equal(JSON.parse(html.body).path, UMAMI_BASE_PATH);
        assert.equal(html.headers['x-private-hop'], undefined);
        const asset = await request(port, '/_next/static/app.js', { headers });
        assert.equal(asset.headers['content-encoding'], 'gzip');
        assert.deepEqual(asset.body, compressedAsset);
        await request(port, '/api/auth/login', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', cookie: 'service=fixture' }, body: '{"credential":"fixture"}' });
        const internal = await request(port, '/api/heartbeat');
        assert.equal(internal.status, 200);
        await request(port, '/script.js', { headers });
        const redirect = await request(port, '/redirect', { headers });
        assert.equal(redirect.status, 307);
        assert.equal(redirect.headers.location, `${UMAMI_BASE_PATH}/login`);
        assert.deepEqual(redirect.headers['set-cookie'], ['service-session=fixture; HttpOnly; Path=/']);
        assert.deepEqual(observed.map((entry) => entry.path), [
            UMAMI_BASE_PATH, `${UMAMI_BASE_PATH}/_next/static/app.js`, `${UMAMI_BASE_PATH}/api/auth/login`,
            `${UMAMI_BASE_PATH}/api/heartbeat`, `${UMAMI_BASE_PATH}/script.js`, `${UMAMI_BASE_PATH}/redirect`,
        ]);
        assert.equal(observed[2].method, 'POST');
        assert.equal(observed[2].body, '{"credential":"fixture"}');
        assert.equal(observed[2].headers.cookie, 'service=fixture');
        assert.equal(observed[0].headers.host, 'router.example');
        assert.equal(observed[0].headers['x-forwarded-host'], 'router.example');
    });
});

test('foreign, duplicate and malformed publication paths fail without contacting upstream', { timeout: 10_000 }, async () => {
    let calls = 0;
    await withIngress((_incoming, response) => { calls += 1; response.end('unexpected'); }, async ({ port }) => {
        for (const prefix of ['', '/', `${UMAMI_BASE_PATH}/`, '/other/3000', [UMAMI_BASE_PATH, '/other']]) {
            assert.equal((await request(port, '/api/heartbeat', { headers: { 'x-forwarded-prefix': prefix } })).status, 400);
        }
        assert.equal((await request(port, 'http://other.invalid/')).status, 400);
        assert.equal((await request(port, '//other.invalid/')).status, 400);
        assert.equal(calls, 0);
    });
});

test('upstream connection failure stays a visible HTTP failure', { timeout: 10_000 }, async () => {
    const upstream = http.createServer();
    const unusedPort = await listen(upstream);
    await close(upstream);
    const ingress = createUmamiIngress({ upstreamPort: unusedPort });
    const port = await listen(ingress);
    try {
        const result = await request(port, '/api/heartbeat');
        assert.equal(result.status, 502);
        assert.equal(result.body.toString(), 'Umami application is unavailable.');
    } finally {
        await close(ingress);
    }
});

test('the tracker endpoint echoes the exact caller origin instead of Umami\'s wildcard CORS policy', { timeout: 10_000 }, async () => {
    const umamiCors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, DELETE, POST, PUT',
        'access-control-max-age': '86400',
    };
    await withIngress((incoming, response) => {
        response.writeHead(incoming.method === 'OPTIONS' ? 204 : 200, { ...umamiCors, 'content-type': 'application/json' });
        response.end(incoming.method === 'OPTIONS' ? undefined : '{}');
    }, async ({ port }) => {
        const origin = 'https://site.example';
        const preflight = await request(port, '/api/send', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers['access-control-allow-origin'], origin);
        assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');
        assert.equal(preflight.headers['access-control-allow-headers'], 'content-type, x-umami-website-id, x-umami-hostname, x-umami-cache');
        assert.equal(preflight.headers['access-control-max-age'], '600');
        assert.equal(preflight.headers.vary, 'Origin');
        const send = await request(port, '/api/send', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(send.headers['access-control-allow-origin'], origin);
        const other = await request(port, '/api/websites', { headers: { origin } });
        assert.equal(other.headers['access-control-allow-origin'], '*');
        const noOrigin = await request(port, '/api/send', { method: 'POST', body: '{}' });
        assert.equal(noOrigin.headers['access-control-allow-origin'], '*');
    });
});

test('tracker CORS ignores opaque or non-HTTP origins', () => {
    const headers = { 'access-control-allow-origin': '*' };
    assert.equal(trackerCorsHeaders(headers, 'null'), headers);
    assert.equal(trackerCorsHeaders(headers, 'file:///tmp/x'), headers);
    assert.equal(trackerCorsHeaders(headers, 'https://site.example/path'), headers);
});

test('Router-forwarded requests for the built-in MCP endpoint get 404 in every spelling without contacting upstream', { timeout: 10_000 }, async () => {
    const observed = [];
    await withIngress((incoming, response) => { observed.push(`${incoming.method} ${incoming.url}`); response.end('upstream'); }, async ({ port }) => {
        const headers = { 'x-forwarded-prefix': UMAMI_BASE_PATH };
        const blocked = [
            '/mcp', '/mcp/', '/mcp?a=1', '/mcp/sub', '/mcp/sub/deeper?x=%2e', '/./mcp', '/x/../mcp', '/x/%2e%2e/mcp',
            '/x/%2E%2E/mcp', '/%2e/mcp', '/%6Dcp', '/%6dCP', '/MCP', '/Mcp/', '/mcp/%zz', '/x%2f..%2fmcp', '/.//mcp',
        ];
        for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
            for (const target of blocked) {
                const result = await request(port, target, { method, headers });
                assert.equal(result.status, 404, `${method} ${target}`);
                assert.equal(result.body.toString(), 'Not found.');
                assert.equal(result.headers['cache-control'], 'no-store');
            }
        }
        assert.deepEqual(observed, []);

        // Only the exact segment is blocked; neighbours still pass through.
        for (const target of ['/mcpx', '/mc', '/api/mcp', '/_next/mcp', '/api/heartbeat?next=/mcp']) {
            assert.equal((await request(port, target, { headers })).status, 200, target);
        }
        assert.deepEqual(observed, [
            `GET ${UMAMI_BASE_PATH}/mcpx`, `GET ${UMAMI_BASE_PATH}/mc`, `GET ${UMAMI_BASE_PATH}/api/mcp`,
            `GET ${UMAMI_BASE_PATH}/_next/mcp`, `GET ${UMAMI_BASE_PATH}/api/heartbeat?next=/mcp`,
        ]);
    });
});

test('in-container loopback calls without a forwarding prefix still reach the built-in MCP endpoint', { timeout: 10_000 }, async () => {
    const observed = [];
    await withIngress((incoming, response) => {
        observed.push({ method: incoming.method, path: incoming.url, authorization: incoming.headers.authorization });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0"}');
    }, async ({ port }) => {
        const result = await request(port, '/mcp', { method: 'POST', headers: { authorization: 'Bearer umami_fixture', 'content-type': 'application/json' }, body: '{}' });
        assert.equal(result.status, 200);
        assert.deepEqual(observed, [{ method: 'POST', path: `${UMAMI_BASE_PATH}/mcp`, authorization: 'Bearer umami_fixture' }]);
        assert.equal((await request(port, '/x/../mcp', { method: 'POST' })).status, 200);
    });
});

test('isMcpPath resolves the same target the application would route', () => {
    for (const target of ['/mcp', '/mcp/', '/mcp?x=1', '/a/../mcp', '/%6dcp/tools']) assert.equal(isMcpPath(target), true, target);
    for (const target of ['/', '/mcpx', '/xmcp', '/api/mcp', '/mcp-config', '/api/heartbeat']) assert.equal(isMcpPath(target), false, target);
    assert.equal(isMcpPath('http://other.invalid/mcp'), false);
});
