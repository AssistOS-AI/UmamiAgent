import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    ADMIN_USER_ID, BootstrapError, INTERNAL_KEY_ID, INTERNAL_KEY_NAME,
    apiKeyPrefix, createPsqlQuery, describeFailure, hashApiKey, internalApiKey, loadBcrypt, main, parseSeedWebsites,
    runApiPhase, runDbPhase, sqlLiteral,
} from '../scripts/umami-bootstrap.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/umami-bootstrap.mjs', import.meta.url));
const SEED = 'a1'.repeat(32);
const OTHER_SEED = 'b2'.repeat(32);
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different long password';
const SITE = { id: 'b1ee0e11-362a-479a-be3c-c238f72aec35', name: 'Bizanso', domain: 'bizanso.com' };

// Deterministic stand-in for bcryptjs; the production module loads the real one from /app.
const bcrypt = {
    hashSync: (password, rounds) => `fakebcrypt$${rounds}$${Buffer.from(password).toString('hex')}`,
    compareSync: (password, hash) => hash === `fakebcrypt$10$${Buffer.from(password).toString('hex')}`,
};

// In-memory stand-in for the two tables the db phase touches. It answers the
// exact statements the module issues and records every one of them.
function fakeDatabase({ user = { user_id: ADMIN_USER_ID, username: 'admin', password: bcrypt.hashSync('umami', 10) }, apiKey = null } = {}) {
    const state = { user, apiKey, statements: [], writes: 0 };
    const literals = (sql) => [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
    async function query(sql) {
        state.statements.push(sql);
        if (sql.includes('FROM "user" WHERE')) return state.user ? [{ ...state.user }] : [];
        if (sql.includes('FROM api_key WHERE')) return state.apiKey ? [{ ...state.apiKey }] : [];
        if (sql.includes('UPDATE "user"')) {
            const [password] = literals(sql);
            state.user.password = password;
            state.writes += 1;
            return { changed: 1 };
        }
        if (sql.includes('INSERT INTO api_key')) {
            const [id, userId, name, keyHash, keyPrefix] = literals(sql);
            assert.equal(state.apiKey, null);
            state.apiKey = { api_key_id: id, user_id: userId, name, key_hash: keyHash, key_prefix: keyPrefix };
            state.writes += 1;
            return { changed: 1 };
        }
        if (sql.includes('UPDATE api_key')) {
            const [userId, name, keyHash, keyPrefix] = literals(sql);
            Object.assign(state.apiKey, { user_id: userId, name, key_hash: keyHash, key_prefix: keyPrefix });
            state.writes += 1;
            return { changed: 1 };
        }
        throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    }
    return { state, query };
}

function recorder() {
    const lines = [];
    return { lines, log: (line) => lines.push(line) };
}

function assertNoSecrets(texts, secrets) {
    const haystack = texts.join('\n');
    for (const secret of secrets) assert.ok(!haystack.includes(secret), 'a secret value appeared in the output');
}

const key = internalApiKey(SEED);

test('the internal key derives from the seed exactly as Umami hashes and prefixes API keys', () => {
    assert.equal(key, `umami_${SEED}`);
    assert.equal(hashApiKey(key), crypto.createHash('sha512').update(key).digest('hex'));
    assert.match(hashApiKey(key), /^[0-9a-f]{128}$/);
    assert.equal(apiKeyPrefix(key), key.slice(0, 14));
    assert.equal(apiKeyPrefix(key).length, 14);
    for (const seed of [undefined, '', 'short', 'x'.repeat(31), `${'a'.repeat(40)}!`, `${'a'.repeat(40)} `]) {
        assert.throws(() => internalApiKey(seed), BootstrapError);
    }
});

test('db phase without an admin password leaves the password alone and creates the key once', async () => {
    const { state, query } = fakeDatabase();
    const first = recorder();
    const env = { UMAMI_INTERNAL_KEY_SEED: SEED };
    assert.deepEqual(await runDbPhase({ env, query, bcrypt, log: first.log }), { writes: 1 });
    assert.equal(state.user.password, bcrypt.hashSync('umami', 10));
    assert.deepEqual(state.apiKey, {
        api_key_id: INTERNAL_KEY_ID, user_id: ADMIN_USER_ID, name: INTERNAL_KEY_NAME,
        key_hash: hashApiKey(key), key_prefix: key.slice(0, 14),
    });
    assert.ok(first.lines.some((line) => /UMAMI_ADMIN_PASSWORD is not set/.test(line)));
    assert.ok(first.lines.some((line) => /internal API key created/.test(line)));
    assert.ok(!state.statements.some((sql) => sql.includes('UPDATE "user"')));

    const second = recorder();
    state.statements.length = 0;
    assert.deepEqual(await runDbPhase({ env: { ...env, UMAMI_ADMIN_PASSWORD: '' }, query, bcrypt, log: second.log }), { writes: 0 });
    assert.ok(second.lines.at(-1).includes('no changes; made no writes'));
    assert.equal(state.writes, 1);
    assert.ok(state.statements.every((sql) => sql.startsWith('SELECT')));
});

test('db phase enforces a set admin password, repairs drift and makes no writes on the second run', async () => {
    const { state, query } = fakeDatabase();
    const env = { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD };
    const first = recorder();
    assert.deepEqual(await runDbPhase({ env, query, bcrypt, log: first.log }), { writes: 2 });
    assert.equal(state.user.password, bcrypt.hashSync(PASSWORD, 10));
    assert.ok(first.lines.some((line) => /admin password enforced \(updated\)/.test(line)));

    const second = recorder();
    const before = state.writes;
    assert.deepEqual(await runDbPhase({ env, query, bcrypt, log: second.log }), { writes: 0 });
    assert.equal(state.writes, before);
    assert.ok(second.lines.some((line) => /admin password already matches/.test(line)));
    assert.ok(second.lines.at(-1).includes('no changes; made no writes'));

    // The password was changed in the dashboard: the next start resets it.
    state.user.password = bcrypt.hashSync(OTHER_PASSWORD, 10);
    assert.deepEqual(await runDbPhase({ env, query, bcrypt, log: recorder().log }), { writes: 1 });
    assert.equal(state.user.password, bcrypt.hashSync(PASSWORD, 10));

    // The account name is not part of the enforced state: a rename is left alone.
    state.user.username = 'renamed';
    assert.deepEqual(await runDbPhase({ env, query, bcrypt, log: recorder().log }), { writes: 0 });
    assert.equal(state.user.username, 'renamed');
    assert.ok(!state.statements.some((sql) => /SET[^;]*username/.test(sql)));
});

test('db phase enforces any non-empty password, including the upstream default, and fails without the admin row', async () => {
    const short = fakeDatabase();
    // The operator chooses the password; a short one such as the upstream default is enforced like any other.
    await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: 'umami' }, query: short.query, bcrypt, log: () => {} });
    assert.ok(short.state.statements.length > 0);

    const missing = fakeDatabase({ user: null });
    await assert.rejects(
        runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD }, query: missing.query, bcrypt, log: () => {} }),
        /admin user .* does not exist/,
    );
    await assert.rejects(
        runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED }, query: missing.query, bcrypt, log: () => {} }),
        /admin user .* does not exist/,
    );
    assert.equal(missing.state.writes, 0);
    await assert.rejects(runDbPhase({ env: {}, query: short.query, bcrypt, log: () => {} }), /UMAMI_INTERNAL_KEY_SEED/);
});

test('db phase rotates the internal key when the seed changes and repairs a drifted row', async () => {
    const { state, query } = fakeDatabase();
    const env = { UMAMI_INTERNAL_KEY_SEED: SEED };
    await runDbPhase({ env, query, bcrypt, log: () => {} });
    const rotatedLog = recorder();
    assert.deepEqual(await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: OTHER_SEED }, query, bcrypt, log: rotatedLog.log }), { writes: 1 });
    const rotated = internalApiKey(OTHER_SEED);
    assert.equal(state.apiKey.api_key_id, INTERNAL_KEY_ID);
    assert.equal(state.apiKey.key_hash, hashApiKey(rotated));
    assert.equal(state.apiKey.key_prefix, rotated.slice(0, 14));
    assert.ok(rotatedLog.lines.some((line) => /internal API key updated \(rotated\)/.test(line)));
    assert.deepEqual(await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: OTHER_SEED }, query, bcrypt, log: () => {} }), { writes: 0 });

    for (const drift of [{ name: 'renamed' }, { user_id: '00000000-0000-4000-8000-000000000000' }, { key_prefix: 'umami_xxxxxxxx' }]) {
        Object.assign(state.apiKey, drift);
        assert.deepEqual(await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: OTHER_SEED }, query, bcrypt, log: () => {} }), { writes: 1 });
        assert.equal(state.apiKey.name, INTERNAL_KEY_NAME);
        assert.equal(state.apiKey.user_id, ADMIN_USER_ID);
        assert.equal(state.apiKey.key_prefix, rotated.slice(0, 14));
    }
});

test('db phase output and SQL never expose the password, seed, key or prefix beyond the stored hash columns', async () => {
    const { state, query } = fakeDatabase();
    const { lines, log } = recorder();
    const env = { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD };
    await runDbPhase({ env, query, bcrypt, log });
    await runDbPhase({ env, query, bcrypt, log });
    assertNoSecrets(lines, [PASSWORD, SEED, key, key.slice(0, 14), hashApiKey(key), bcrypt.hashSync(PASSWORD, 10)]);
    // The statements do carry the stored derivatives, but never the plaintext password, seed or key.
    assertNoSecrets(state.statements, [PASSWORD, Buffer.from(PASSWORD).toString('base64'), SEED, key]);
});

test('SQL literals double quotes and refuse control characters and backslashes', () => {
    assert.equal(sqlLiteral("o'brien"), "'o''brien'");
    for (const value of ['a\\b', 'a\nb', 'a\u0000b', 5, null]) assert.throws(() => sqlLiteral(value), BootstrapError);
});

function fakeSpawn({ stdout = '[]\n', stderr = '', code = 0 } = {}) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        const input = [];
        child.stdin.on('data', (chunk) => input.push(chunk));
        child.stdin.on('end', () => {
            calls.push({ command, args, options, stdin: Buffer.concat(input).toString('utf8') });
            child.stdout.end(stdout);
            child.stderr.end(stderr);
            setImmediate(() => child.emit('close', code));
        });
        return child;
    };
    return { calls, spawnImpl };
}

test('psql runs over loopback with the password in PGPASSWORD and the statement on stdin only', async () => {
    const { calls, spawnImpl } = fakeSpawn({ stdout: '[{"user_id":"x"}]\n' });
    const env = {
        POSTGRES_USER: 'dbadmin', POSTGRES_DB: 'umamidb', PGPASSWORD: 'database-password', PATH: '/bin',
        UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD, APP_SECRET: 'app-secret',
    };
    const query = createPsqlQuery({ env, spawnImpl });
    const hash = hashApiKey(key);
    const sql = `SELECT '${hash}'`;
    assert.deepEqual(await query(sql), [{ user_id: 'x' }]);
    const [call] = calls;
    assert.equal(call.command, 'psql');
    assert.deepEqual(Object.keys(call.options.env).sort(), ['PATH', 'PGPASSWORD'], 'only PG* and PATH reach psql');
    assert.deepEqual(call.args, ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432', '-U', 'dbadmin', '-d', 'umamidb']);
    assert.equal(call.options.env.PGPASSWORD, 'database-password');
    assert.equal(call.stdin, `SET log_min_error_statement = panic;\n${sql};\n`);
    assertNoSecrets(call.args, ['database-password', hash, SEED]);
});

test('psql failures surface one line without echoing the statement', async () => {
    const secretSql = `SELECT '${SEED}'`;
    const { spawnImpl } = fakeSpawn({ code: 3, stderr: `psql: error: connection to server failed\nSTATEMENT: ${secretSql}\n` });
    const query = createPsqlQuery({ env: {}, spawnImpl });
    await assert.rejects(query(secretSql), (error) => /exited with status 3: psql: error: connection/.test(error.message) && !error.message.includes(SEED));
    const garbage = fakeSpawn({ stdout: 'not json\n' });
    await assert.rejects(createPsqlQuery({ env: {}, spawnImpl: garbage.spawnImpl })('SELECT 1'), /not JSON/);
    const missing = createPsqlQuery({ env: {}, psqlPath: '/nonexistent/psql' });
    await assert.rejects(missing('SELECT 1'), /psql could not run: ENOENT/);
});

test('bcryptjs is only loaded when an admin password must be enforced', async () => {
    let loads = 0;
    const loadBcryptImpl = () => { loads += 1; return bcrypt; };
    const { query } = fakeDatabase();
    await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED }, query, loadBcryptImpl, log: () => {} });
    assert.equal(loads, 0, 'a missing bcryptjs must not matter without a password');
    await runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD }, query, loadBcryptImpl, log: () => {} });
    assert.equal(loads, 1);
    const failing = () => { throw Object.assign(new Error("Cannot find module 'bcryptjs'"), { code: 'MODULE_NOT_FOUND' }); };
    await assert.rejects(
        runDbPhase({ env: { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: OTHER_PASSWORD }, query, loadBcryptImpl: failing, log: () => {} }),
        (error) => error.code === 'MODULE_NOT_FOUND',
    );
});

test('unexpected failures log a class, code and missing module name without secrets', () => {
    const missing = Object.assign(new Error(`Cannot find module 'bcryptjs' for ${PASSWORD}`), { code: 'MODULE_NOT_FOUND' });
    const env = { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD };
    assert.equal(describeFailure(missing, env), 'unexpected failure (Error, MODULE_NOT_FOUND, module bcryptjs)');
    assert.equal(describeFailure(new TypeError(`bad ${SEED}`), env), 'unexpected failure (TypeError)');
    assert.equal(describeFailure(new BootstrapError('plain message'), env), 'plain message');
    assertNoSecrets([describeFailure(missing, env), describeFailure(Object.assign(new Error('x'), { name: SEED }), env)], [PASSWORD, SEED]);
});

test('bcryptjs is resolved from the /app package, not from the agent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-bcrypt-'));
    try {
        fs.mkdirSync(path.join(root, 'node_modules/bcryptjs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        fs.writeFileSync(path.join(root, 'node_modules/bcryptjs/package.json'), '{"name":"bcryptjs","main":"index.cjs"}');
        fs.writeFileSync(path.join(root, 'node_modules/bcryptjs/index.cjs'), 'module.exports = { marker: "app-bcryptjs" };');
        assert.equal(loadBcrypt(path.join(root, 'package.json')).marker, 'app-bcryptjs');
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-nobcrypt-'));
        try {
            assert.throws(() => loadBcrypt(path.join(empty, 'package.json')), /Cannot find module 'bcryptjs'/);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('seeded website list parsing is strict', () => {
    assert.deepEqual(parseSeedWebsites(undefined), []);
    assert.deepEqual(parseSeedWebsites('  '), []);
    assert.deepEqual(parseSeedWebsites(JSON.stringify([{ ...SITE, id: SITE.id.toUpperCase() }])), [SITE]);
    for (const raw of [
        '{', '{}', '[1]', '[null]', JSON.stringify([{ ...SITE, id: 'nope' }]), JSON.stringify([{ ...SITE, name: ' ' }]),
        JSON.stringify([{ ...SITE, domain: 3 }]), JSON.stringify([SITE, SITE]),
    ]) assert.throws(() => parseSeedWebsites(raw), BootstrapError, raw);
});

// A minimal Umami: websites keyed by id with the owning user, served through the same paths the module calls.
function fakeUmami({ websites = new Map(), validKey = key } = {}) {
    const state = { websites, requests: [] };
    const fetchImpl = async (url, init = {}) => {
        const { pathname } = new URL(url);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        state.requests.push({ method, pathname, authorization: init.headers.authorization, body, redirect: init.redirect });
        const reply = (status, payload) => new Response(payload === undefined ? '' : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
        if (init.headers.authorization !== `Bearer ${validKey}`) return reply(401, { error: 'Unauthorized' });
        const single = pathname.match(/^\/api\/websites\/([0-9a-f-]{36})$/);
        if (method === 'GET' && single) return reply(200, state.websites.get(single[1]) ?? null);
        if (method === 'POST' && pathname === '/api/websites') {
            state.websites.set(body.id, { id: body.id, name: body.name, domain: body.domain, userId: ADMIN_USER_ID });
            return reply(200, state.websites.get(body.id));
        }
        if (method === 'POST' && single) {
            Object.assign(state.websites.get(single[1]), body);
            return reply(200, state.websites.get(single[1]));
        }
        return reply(404, {});
    };
    return { state, fetchImpl };
}

const apiEnv = { UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_SEED_WEBSITES: JSON.stringify([SITE]), UMAMI_BASE_URL: 'http://127.0.0.1:3000/' };
const writesOf = (state) => state.requests.filter((entry) => entry.method === 'POST');

test('api phase creates a missing website, then is a no-op, and recreates one deleted in the dashboard', async () => {
    const { state, fetchImpl } = fakeUmami();
    const first = recorder();
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl, log: first.log }), { writes: 1 });
    assert.deepEqual(state.websites.get(SITE.id), { ...SITE, userId: ADMIN_USER_ID });
    assert.deepEqual(writesOf(state).map((entry) => [entry.pathname, entry.body]), [['/api/websites', SITE]]);
    assert.ok(state.requests.every((entry) => entry.authorization === `Bearer ${key}` && entry.redirect === 'manual'));
    assert.ok(first.lines.some((line) => line.includes(`website ${SITE.id} created`)));

    const second = recorder();
    state.requests.length = 0;
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl, log: second.log }), { writes: 0 });
    assert.equal(writesOf(state).length, 0);
    assert.ok(second.lines.some((line) => line.includes('already configured')));
    assert.ok(second.lines.at(-1).includes('no changes; made no writes'));

    state.websites.delete(SITE.id);
    state.requests.length = 0;
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl, log: () => {} }), { writes: 1 });
    assert.equal(state.websites.get(SITE.id).userId, ADMIN_USER_ID);
});

test('api phase updates a website whose name or domain drifted and treats HTTP 404 as missing', async () => {
    const { state, fetchImpl } = fakeUmami({ websites: new Map([[SITE.id, { id: SITE.id, name: 'Old', domain: 'old.example', userId: ADMIN_USER_ID }]]) });
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl, log: () => {} }), { writes: 1 });
    assert.deepEqual(writesOf(state).map((entry) => [entry.pathname, entry.body]), [[`/api/websites/${SITE.id}`, { name: SITE.name, domain: SITE.domain }]]);
    assert.equal(state.websites.get(SITE.id).domain, SITE.domain);

    const notFound = fakeUmami();
    const wrapped = async (url, init) => ((init?.method || 'GET') === 'GET'
        ? new Response('{}', { status: 404 })
        : notFound.fetchImpl(url, init));
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl: wrapped, log: () => {} }), { writes: 1 });
});

test('api phase exits with an error when the id belongs to another user, without any write', async () => {
    for (const owner of ['00000000-0000-4000-8000-000000000001', null]) {
        const { state, fetchImpl } = fakeUmami({ websites: new Map([[SITE.id, { id: SITE.id, name: SITE.name, domain: SITE.domain, userId: owner, teamId: owner ? null : 'team' }]]) });
        await assert.rejects(runApiPhase({ env: apiEnv, fetchImpl, log: () => {} }), (error) => (
            error instanceof BootstrapError && error.message.includes('owned by another user') && error.message.includes(SITE.id)));
        assert.equal(writesOf(state).length, 0);
    }
});

test('api phase fails on a rejected key, bad responses and malformed configuration', async () => {
    const wrongKey = fakeUmami({ validKey: internalApiKey(OTHER_SEED) });
    await assert.rejects(runApiPhase({ env: apiEnv, fetchImpl: wrongKey.fetchImpl, log: () => {} }), /refused the internal API key .*HTTP 401/);
    await assert.rejects(runApiPhase({ env: { ...apiEnv, UMAMI_INTERNAL_KEY_SEED: 'short' }, fetchImpl: wrongKey.fetchImpl, log: () => {} }), /UMAMI_INTERNAL_KEY_SEED/);
    await assert.rejects(runApiPhase({ env: { ...apiEnv, UMAMI_SEED_WEBSITES: 'nope' }, fetchImpl: wrongKey.fetchImpl, log: () => {} }), /not valid JSON/);
    await assert.rejects(runApiPhase({ env: { ...apiEnv, UMAMI_BASE_URL: 'https://umami.example' }, fetchImpl: wrongKey.fetchImpl, log: () => {} }), /container loopback/);
    const refused = async () => new Response('{}', { status: 400 });
    await assert.rejects(runApiPhase({ env: apiEnv, fetchImpl: refused, log: () => {} }), /Reading website .* failed \(HTTP 400\)/);
    const failingCreate = async (url, init) => ((init?.method || 'GET') === 'GET' ? new Response('null', { status: 200 }) : new Response('{}', { status: 400 }));
    await assert.rejects(runApiPhase({ env: apiEnv, fetchImpl: failingCreate, log: () => {} }), /Creating website .* failed \(HTTP 400\)/);

    const nothing = fakeUmami();
    const quiet = recorder();
    assert.deepEqual(await runApiPhase({ env: { ...apiEnv, UMAMI_SEED_WEBSITES: undefined }, fetchImpl: nothing.fetchImpl, log: quiet.log }), { writes: 0 });
    assert.deepEqual(nothing.state.requests, []);
    assert.ok(quiet.lines[0].includes('no websites to seed'));
});

test('api phase retries transient reads but never repeats a write', async () => {
    const { state, fetchImpl } = fakeUmami();
    let reads = 0;
    const sleeps = [];
    const flaky = async (url, init) => {
        if ((init?.method || 'GET') === 'GET' && reads++ < 2) {
            if (reads === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
            return new Response('unavailable', { status: 503 });
        }
        return fetchImpl(url, init);
    };
    assert.deepEqual(await runApiPhase({ env: apiEnv, fetchImpl: flaky, sleep: async (ms) => { sleeps.push(ms); }, log: () => {} }), { writes: 1 });
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.equal(writesOf(state).length, 1);

    const writeFails = async (url, init) => ((init?.method || 'GET') === 'GET'
        ? new Response('null', { status: 200 }) : new Response('boom', { status: 503 }));
    await assert.rejects(runApiPhase({ env: apiEnv, fetchImpl: writeFails, sleep: async () => {}, log: () => {} }), /Creating website .* failed \(HTTP 503\)/);
});

test('api phase output carries no key, seed or authorization value', async () => {
    const { fetchImpl } = fakeUmami();
    const { lines, log } = recorder();
    await runApiPhase({ env: apiEnv, fetchImpl, log });
    await runApiPhase({ env: apiEnv, fetchImpl, log });
    assertNoSecrets(lines, [SEED, key, 'Bearer']);
    const wrong = fakeUmami({ validKey: internalApiKey(OTHER_SEED) });
    try {
        await runApiPhase({ env: apiEnv, fetchImpl: wrong.fetchImpl, log });
        assert.fail('expected a rejection');
    } catch (error) {
        assertNoSecrets([error.message], [SEED, key]);
    }
});

test('main routes the phases and rejects other arguments', async () => {
    const { state, query } = fakeDatabase();
    const { lines, log } = recorder();
    assert.deepEqual(await main(['db'], { env: { UMAMI_INTERNAL_KEY_SEED: SEED }, query, bcrypt, log }), { writes: 1 });
    const { fetchImpl } = fakeUmami();
    assert.deepEqual(await main(['api'], { env: apiEnv, fetchImpl, log }), { writes: 1 });
    assert.ok(lines.length > 2);
    assert.equal(state.writes, 1);
    for (const argv of [[], ['x'], ['db', 'api'], ['DB']]) await assert.rejects(main(argv), /Usage: umami-bootstrap\.mjs db\|api/);
});

test('the script entrypoint seeds through the real HTTP stack, logs without secrets and exits non-zero on a conflict', async (t) => {
    const websites = new Map();
    const seen = [];
    const server = http.createServer((incoming, response) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
            seen.push(`${incoming.method} ${incoming.url}`);
            const send = (payload) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
            if (incoming.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end('{}'); return; }
            if (incoming.method === 'GET') return send(websites.get(SITE.id) ?? null);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            websites.set(body.id, { ...body, userId: ADMIN_USER_ID });
            return send(websites.get(body.id));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { port } = server.address();
    const env = { PATH: process.env.PATH, UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_SEED_WEBSITES: JSON.stringify([SITE]), UMAMI_BASE_URL: `http://127.0.0.1:${port}` };
    // Asynchronous spawn: the fixture server lives in this process.
    const run = (extra = {}) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, 'api'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const created = await run();
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /created/);
    const repeated = await run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /no changes; made no writes/);
    assert.deepEqual(seen, [`GET /api/websites/${SITE.id}`, 'POST /api/websites', `GET /api/websites/${SITE.id}`]);

    websites.set(SITE.id, { ...websites.get(SITE.id), userId: '00000000-0000-4000-8000-000000000002' });
    const conflict = await run();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /owned by another user/);
    assertNoSecrets([created.stdout, created.stderr, repeated.stdout, repeated.stderr, conflict.stdout, conflict.stderr], [SEED, key]);
    assert.equal((await run({ UMAMI_INTERNAL_KEY_SEED: OTHER_SEED })).status, 1);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }).status, 1);
});
