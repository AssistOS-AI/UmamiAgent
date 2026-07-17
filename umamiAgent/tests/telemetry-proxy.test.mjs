import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { _test, createTelemetryHandler } from '../scripts/umami-telemetry-proxy.mjs';

const RATE_SOURCE_A = 'a'.repeat(64);
const RATE_SOURCE_B = 'b'.repeat(64);
const RATE_SOURCE_C = 'c'.repeat(64);

function ingestionHeaders({
    origin = 'https://site.example',
    rateSource = RATE_SOURCE_A,
    contentType = 'application/json',
} = {}) {
    return {
        origin,
        'content-type': contentType,
        [_test.RATE_SOURCE_HEADER]: rateSource,
    };
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function request(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function withProxy(run, options = {}) {
    const { upstreamHandler, ...handlerOptions } = options;
    const seen = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            if (upstreamHandler) {
                upstreamHandler(req, res);
                return;
            }
            res.writeHead(200, { 'content-type': req.url.endsWith('script.js') ? 'application/javascript' : 'application/json' });
            res.end(req.url.endsWith('script.js') ? 'console.log("umami")' : '{"ok":true}');
        });
    });
    const upstreamPort = await listen(upstream);
    const handler = createTelemetryHandler({
        allowedOrigins: 'https://site.example',
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        ...handlerOptions,
    });
    const proxy = http.createServer(handler);
    const proxyPort = await listen(proxy);
    try {
        await run({ proxyPort, seen, handler });
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

test('telemetry proxy exposes only script and ingestion paths under the verified Umami base path', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const script = await request(proxyPort, { path: '/script.js' });
        assert.equal(script.status, 200);
        const ingest = await request(proxyPort, {
            method: 'POST',
            path: '/api/send',
            headers: { ...ingestionHeaders(), cookie: 'browser=secret', authorization: 'Bearer secret' },
            body: '{"type":"event"}',
        });
        assert.equal(ingest.status, 200);
        assert.equal(ingest.headers[_test.SANITIZATION_EVIDENCE_HEADER], _test.SANITIZATION_EVIDENCE_VALUE);
        assert.deepEqual(seen.map((entry) => entry.url), [
            '/services/umami/script.js',
            '/services/umami/api/send',
        ]);
        assert.equal(seen[1].headers.cookie, undefined);
        assert.equal(seen[1].headers.authorization, undefined);
        assert.equal(seen[1].headers['x-ploinky-auth-info'], undefined);
        assert.equal(seen[1].headers[_test.RATE_SOURCE_HEADER], undefined);
        assert.equal(seen[1].headers.origin, 'https://site.example');
    });
});

test('telemetry sanitation evidence cannot be spoofed by client or upstream headers', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const response = await request(proxyPort, {
            method: 'POST',
            path: '/api/send',
            headers: {
                origin: 'https://site.example',
                'content-type': 'application/json',
                [_test.RATE_SOURCE_HEADER]: RATE_SOURCE_A,
                cookie: 'browser-cookie=attacker-value',
                authorization: 'Bearer attacker-value',
                forwarded: 'for=attacker;host=evil.example;proto=http',
                'x-forwarded-for': '198.51.100.99',
                'x-forwarded-host': 'evil.example',
                'x-forwarded-proto': 'http',
                'x-ploinky-auth-info': 'attacker-identity',
                'x-ploinky-caller': 'attacker-caller',
                [_test.SANITIZATION_EVIDENCE_HEADER]: 'client-cookie=present; attacker-controlled=true',
                'proxy-authorization': 'Basic attacker-value',
                'keep-alive': 'timeout=999',
                te: 'trailers',
            },
            body: '{"type":"event"}',
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers[_test.SANITIZATION_EVIDENCE_HEADER], _test.SANITIZATION_EVIDENCE_VALUE);
        assert.equal(seen.length, 1);
        for (const name of [
            'cookie',
            'authorization',
            'forwarded',
            'x-forwarded-for',
            'x-forwarded-host',
            'x-forwarded-proto',
            'x-ploinky-auth-info',
            'x-ploinky-caller',
            _test.RATE_SOURCE_HEADER,
            _test.SANITIZATION_EVIDENCE_HEADER,
            'proxy-authorization',
            'keep-alive',
            'te',
        ]) {
            assert.equal(seen[0].headers[name], undefined, `${name} reached the real upstream request`);
        }
    }, {
        upstreamHandler(_req, res) {
            res.writeHead(200, {
                'content-type': 'application/json',
                [_test.SANITIZATION_EVIDENCE_HEADER]: 'client-cookie=present; attacker-controlled=true',
            });
            res.end('{"ok":true}');
        },
    });
});

test('telemetry proxy rejects unknown paths, suffix-confusable origins, and non-JSON before dialing', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        assert.equal((await request(proxyPort, { path: '/api/websites' })).status, 404);
        assert.equal((await request(proxyPort, {
            method: 'POST', path: '/api/send', headers: ingestionHeaders({ origin: 'https://site.example.evil' }), body: '{}',
        })).status, 403);
        assert.equal((await request(proxyPort, {
            method: 'POST', path: '/api/send', headers: ingestionHeaders({ origin: 'https://site.example/path' }), body: '{}',
        })).status, 403);
        assert.equal((await request(proxyPort, {
            method: 'POST', path: '/api/send', headers: ingestionHeaders({ contentType: 'text/plain' }), body: '{}',
        })).status, 415);
        assert.equal(seen.length, 0);
    });
});

test('telemetry browser preflight echoes only an exact configured external origin', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const allowed = await request(proxyPort, {
            method: 'OPTIONS',
            path: '/api/send',
            headers: {
                origin: 'https://site.example',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type',
            },
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers['access-control-allow-origin'], 'https://site.example');
        assert.equal(allowed.headers.vary, 'Origin');
        assert.equal(seen.length, 0);
    });
});

test('telemetry proxy rejects missing and malformed Router rate sources before dialing', async () => {
    await withProxy(async ({ proxyPort, seen, handler }) => {
        const invalidSources = [
            undefined,
            '',
            'a'.repeat(63),
            'a'.repeat(65),
            'g'.repeat(64),
            `${RATE_SOURCE_A},${RATE_SOURCE_B}`,
        ];
        for (const rateSource of invalidSources) {
            const headers = ingestionHeaders();
            if (rateSource === undefined) delete headers[_test.RATE_SOURCE_HEADER];
            else headers[_test.RATE_SOURCE_HEADER] = rateSource;
            const response = await request(proxyPort, {
                method: 'POST', path: '/api/send', headers, body: '{}',
            });
            assert.equal(response.status, 400);
        }
        assert.equal(seen.length, 0);
        assert.equal(handler.snapshotAuditCounters().rejected.rate_source_denied, invalidSources.length);
    });
});

test('telemetry proxy rejects malformed explicit rate configuration instead of falling back', () => {
    const name = 'UMAMI_TELEMETRY_PER_SOURCE_PER_MINUTE';
    const previous = process.env[name];
    try {
        for (const invalid of ['0', '-1', '1.5', '120junk', ' 120', '9007199254740992']) {
            process.env[name] = invalid;
            assert.throws(() => _test.positiveInt(name, 120), /must be a (?:safe )?positive/);
        }
        delete process.env[name];
        assert.equal(_test.positiveInt(name, 120), 120);
        process.env[name] = '240';
        assert.equal(_test.positiveInt(name, 120), 240);
    } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    }
});

test('telemetry per-source limiter canonicalizes hex case and keeps distinct sources independent', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const ingest = (rateSource) => request(proxyPort, {
            method: 'POST',
            path: '/api/send',
            headers: ingestionHeaders({ rateSource }),
            body: '{}',
        });
        assert.equal((await ingest(RATE_SOURCE_A)).status, 200);
        assert.equal((await ingest(RATE_SOURCE_A.toUpperCase())).status, 429);
        assert.equal((await ingest(RATE_SOURCE_B)).status, 200);
        assert.equal(seen.length, 2);
    }, { perSourceLimit: 1, globalLimit: 10, now: () => 60_000 });
});

test('telemetry per-source limiter does not split one source bucket by allowed Origin', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const first = await request(proxyPort, {
            method: 'POST',
            path: '/api/send',
            headers: ingestionHeaders({ origin: 'https://site.example', rateSource: RATE_SOURCE_A }),
            body: '{}',
        });
        const second = await request(proxyPort, {
            method: 'POST',
            path: '/api/send',
            headers: ingestionHeaders({ origin: 'https://other.example', rateSource: RATE_SOURCE_A }),
            body: '{}',
        });
        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal(seen.length, 1);
    }, {
        allowedOrigins: 'https://site.example,https://other.example',
        perSourceLimit: 1,
        globalLimit: 10,
        now: () => 60_000,
    });
});

test('telemetry global limiter applies across distinct valid rate sources', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const ingest = (rateSource) => request(proxyPort, {
            method: 'POST', path: '/api/send', headers: ingestionHeaders({ rateSource }), body: '{}',
        });
        assert.equal((await ingest(RATE_SOURCE_A)).status, 200);
        assert.equal((await ingest(RATE_SOURCE_B)).status, 200);
        assert.equal((await ingest(RATE_SOURCE_C)).status, 429);
        assert.equal(seen.length, 2);
    }, { perSourceLimit: 10, globalLimit: 2, now: () => 60_000 });
});

test('telemetry proxy bounds bodies and applies the per-source rate bucket', async () => {
    await withProxy(async ({ proxyPort, seen }) => {
        const headers = ingestionHeaders();
        assert.equal((await request(proxyPort, { method: 'POST', path: '/api/send', headers, body: '123456789' })).status, 413);
        assert.equal((await request(proxyPort, { method: 'POST', path: '/api/send', headers, body: '{}' })).status, 200);
        assert.equal((await request(proxyPort, { method: 'POST', path: '/api/send', headers, body: '{}' })).status, 429);
        assert.equal(seen.length, 1);
    }, { maxBodyBytes: 8, perSourceLimit: 2, globalLimit: 2, now: () => 60_000 });
});

test('telemetry proxy bounds upstream time and response bytes without forwarding partial output', async () => {
    await withProxy(async ({ proxyPort }) => {
        const delayed = await request(proxyPort, { path: '/script.js' });
        assert.equal(delayed.status, 502);
        assert.equal(delayed.body, 'Telemetry upstream unavailable.');
    }, {
        upstreamTimeoutMs: 20,
        upstreamHandler(_req, res) {
            setTimeout(() => res.end('late'), 100).unref?.();
        },
    });

    await withProxy(async ({ proxyPort }) => {
        const oversized = await request(proxyPort, { path: '/script.js' });
        assert.equal(oversized.status, 502);
        assert.equal(oversized.body, 'Telemetry upstream unavailable.');
    }, {
        maxResponseBytes: 8,
        upstreamHandler(_req, res) {
            res.end('123456789');
        },
    });
});

test('telemetry proxy exposes value-free audit counters for accepted and rejected requests', async () => {
    await withProxy(async ({ proxyPort, handler }) => {
        await request(proxyPort, { path: '/script.js' });
        await request(proxyPort, {
            method: 'POST', path: '/api/send', headers: ingestionHeaders(), body: '{}',
        });
        await request(proxyPort, { path: '/admin' });
        const counters = handler.snapshotAuditCounters();
        assert.deepEqual(counters, {
            requests: 3,
            forwarded: 2,
            upstreamFailures: 0,
            rejected: { unknown_path: 1 },
        });
        assert.equal(JSON.stringify(counters).includes('site.example'), false);
        assert.equal(JSON.stringify(counters).includes(RATE_SOURCE_A), false);
    });
});

test('telemetry proxy ignores observer failures instead of weakening admission', async () => {
    await withProxy(async ({ proxyPort, handler }) => {
        assert.equal((await request(proxyPort, { path: '/script.js' })).status, 200);
        assert.equal(handler.snapshotAuditCounters().forwarded, 1);
    }, {
        onAudit() {
            throw new Error('observer unavailable');
        },
    });
});
