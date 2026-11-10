import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Declarative state that Umami itself cannot be told about: the enforced admin
// password and the agent's internal API key. Phase `db` runs after the schema
// check and before Next.js starts; phase `api` runs once Umami answers.

export const ADMIN_USER_ID = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
export const INTERNAL_KEY_ID = 'b85ae2ea-c3b8-4a5f-b7dd-ffee2254cc88';
export const INTERNAL_KEY_NAME = 'umamiAgent internal';
export const API_KEY_PREFIX = 'umami_';
// Umami's API_KEY_DISPLAY_LENGTH: the prefix plus the first eight key characters.
export const API_KEY_DISPLAY_LENGTH = API_KEY_PREFIX.length + 8;
export const MIN_ADMIN_PASSWORD_LENGTH = 16;
export const BCRYPT_ROUNDS = 10;
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEED_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export class BootstrapError extends Error {}

function fail(message) {
    throw new BootstrapError(message);
}

// ---------------------------------------------------------------- values

export function internalApiKey(seed) {
    if (typeof seed !== 'string' || !SEED_PATTERN.test(seed)) {
        fail('UMAMI_INTERNAL_KEY_SEED must be at least 32 characters of [A-Za-z0-9_-].');
    }
    return `${API_KEY_PREFIX}${seed}`;
}

// Same digest as Umami's hashApiKey(): unsalted SHA-512, hex.
export function hashApiKey(key) {
    return crypto.createHash('sha512').update(key).digest('hex');
}

export function apiKeyPrefix(key) {
    return key.slice(0, API_KEY_DISPLAY_LENGTH);
}

export function parseSeedWebsites(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        fail('UMAMI_SEED_WEBSITES is not valid JSON.');
    }
    if (!Array.isArray(parsed)) fail('UMAMI_SEED_WEBSITES must be a JSON array.');
    const seen = new Set();
    return parsed.map((entry, index) => {
        const label = `UMAMI_SEED_WEBSITES[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} must be an object.`);
        const { id, name, domain } = entry;
        if (typeof id !== 'string' || !UUID_PATTERN.test(id)) fail(`${label}.id must be a UUID.`);
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) fail(`${label}.name must be 1-100 characters.`);
        if (typeof domain !== 'string' || !domain.trim() || domain.trim().length > 500) fail(`${label}.domain must be 1-500 characters.`);
        const normalizedId = id.toLowerCase();
        if (seen.has(normalizedId)) fail(`${label}.id is listed twice.`);
        seen.add(normalizedId);
        return { id: normalizedId, name: name.trim(), domain: domain.trim() };
    });
}

// ---------------------------------------------------------------- SQL

// Values reach psql on stdin as quoted literals. Every value here is a UUID, a
// hex digest, a bcrypt hash, an API key or a fixed name, so reject anything
// that would need escaping beyond doubled quotes (psql runs with
// standard_conforming_strings on, which treats backslashes literally).
export function sqlLiteral(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f\\]/.test(value)) {
        fail('Refusing to embed a value with control characters or backslashes in SQL.');
    }
    return `'${value.replace(/'/g, "''")}'`;
}

const asJson = (inner) => `SELECT coalesce(json_agg(t), '[]'::json) FROM (${inner}) t`;
const countJson = (cte) => `${cte} SELECT json_build_object('changed', (SELECT count(*) FROM changed))`;

export function selectAdminSql() {
    return asJson(`SELECT user_id, password FROM "user" WHERE user_id = ${sqlLiteral(ADMIN_USER_ID)}::uuid`);
}

export function updateAdminSql(passwordHash) {
    return countJson(`WITH changed AS (UPDATE "user" SET password = ${sqlLiteral(passwordHash)}, updated_at = now() WHERE user_id = ${sqlLiteral(ADMIN_USER_ID)}::uuid RETURNING user_id)`);
}

export function selectApiKeySql() {
    return asJson(`SELECT api_key_id, user_id, name, key_hash, key_prefix FROM api_key WHERE api_key_id = ${sqlLiteral(INTERNAL_KEY_ID)}::uuid`);
}

export function insertApiKeySql(keyHash, keyPrefix) {
    return countJson(`WITH changed AS (INSERT INTO api_key (api_key_id, user_id, name, key_hash, key_prefix) VALUES (${sqlLiteral(INTERNAL_KEY_ID)}::uuid, ${sqlLiteral(ADMIN_USER_ID)}::uuid, ${sqlLiteral(INTERNAL_KEY_NAME)}, ${sqlLiteral(keyHash)}, ${sqlLiteral(keyPrefix)}) RETURNING api_key_id)`);
}

export function updateApiKeySql(keyHash, keyPrefix) {
    return countJson(`WITH changed AS (UPDATE api_key SET user_id = ${sqlLiteral(ADMIN_USER_ID)}::uuid, name = ${sqlLiteral(INTERNAL_KEY_NAME)}, key_hash = ${sqlLiteral(keyHash)}, key_prefix = ${sqlLiteral(keyPrefix)} WHERE api_key_id = ${sqlLiteral(INTERNAL_KEY_ID)}::uuid RETURNING api_key_id)`);
}

// Real database access: one psql process per statement over loopback TCP. The
// password travels in PGPASSWORD and the statement on stdin, so no secret
// appears in argv. Statements return one JSON value on one line.
export function createPsqlQuery({
    env = process.env,
    spawnImpl = spawn,
    psqlPath = 'psql',
} = {}) {
    const user = env.POSTGRES_USER || 'admin';
    const database = env.POSTGRES_DB || 'umami';
    // Only what psql needs: no seed, admin password or app secret.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name === 'PATH' || name.startsWith('PG')));
    const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432', '-U', user, '-d', database];
    return function query(sql) {
        return new Promise((resolve, reject) => {
            const child = spawnImpl(psqlPath, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
            const stdout = [];
            const stderr = [];
            child.stdout.on('data', (chunk) => stdout.push(chunk));
            child.stderr.on('data', (chunk) => stderr.push(chunk));
            child.on('error', (error) => reject(new BootstrapError(`psql could not run: ${error.code || error.message}`)));
            child.on('close', (code) => {
                if (code !== 0) {
                    // psql echoes the failing statement; keep it out of the error.
                    const firstLine = Buffer.concat(stderr).toString('utf8').split('\n')[0] || '';
                    reject(new BootstrapError(`psql exited with status ${code}: ${firstLine.replace(/\s+/g, ' ').slice(0, 160)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(stdout).toString('utf8').trim()));
                } catch {
                    reject(new BootstrapError('psql returned a result that is not JSON.'));
                }
            });
            child.stdin.on('error', () => {});
            // A failing statement must never write its text (a hash) to the server log.
            child.stdin.end(`SET log_min_error_statement = panic;\n${sql};\n`);
        });
    };
}

export function loadBcrypt(appPackage = '/app/package.json') {
    const loaded = createRequire(appPackage)('bcryptjs');
    return loaded.default || loaded;
}

// ---------------------------------------------------------------- phase db

export async function runDbPhase({ env = process.env, query, bcrypt, loadBcryptImpl = loadBcrypt, log = console.log }) {
    let writes = 0;

    const password = env.UMAMI_ADMIN_PASSWORD;
    if (password === undefined || password === '') {
        log('umami-bootstrap[db]: UMAMI_ADMIN_PASSWORD is not set; the admin password is left unchanged.');
    } else {
        if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
            fail(`UMAMI_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
        }
        const rows = await query(selectAdminSql());
        if (!Array.isArray(rows) || rows.length !== 1) {
            fail(`The Umami admin user ${ADMIN_USER_ID} does not exist; cannot enforce its password.`);
        }
        const [admin] = rows;
        // bcryptjs is only needed (and only required to exist) when a password is enforced.
        bcrypt = bcrypt || loadBcryptImpl();
        if (bcrypt.compareSync(password, admin.password)) {
            log('umami-bootstrap[db]: admin password already matches UMAMI_ADMIN_PASSWORD.');
        } else {
            const result = await query(updateAdminSql(bcrypt.hashSync(password, BCRYPT_ROUNDS)));
            if (result?.changed !== 1) fail('Updating the admin password changed no row.');
            writes += 1;
            log('umami-bootstrap[db]: admin password enforced (updated).');
        }
    }

    const key = internalApiKey(env.UMAMI_INTERNAL_KEY_SEED);
    const keyHash = hashApiKey(key);
    const keyPrefix = apiKeyPrefix(key);
    const rows = await query(selectApiKeySql());
    if (!Array.isArray(rows) || rows.length > 1) fail('The internal API key lookup returned an unexpected result.');
    if (rows.length === 0) {
        const adminRows = await query(selectAdminSql());
        if (!Array.isArray(adminRows) || adminRows.length !== 1) {
            fail(`The Umami admin user ${ADMIN_USER_ID} does not exist; cannot create the internal API key.`);
        }
        const result = await query(insertApiKeySql(keyHash, keyPrefix));
        if (result?.changed !== 1) fail('Creating the internal API key changed no row.');
        writes += 1;
        log('umami-bootstrap[db]: internal API key created.');
    } else {
        const [row] = rows;
        if (row.user_id === ADMIN_USER_ID && row.name === INTERNAL_KEY_NAME
            && row.key_hash === keyHash && row.key_prefix === keyPrefix) {
            log('umami-bootstrap[db]: internal API key already current.');
        } else {
            const result = await query(updateApiKeySql(keyHash, keyPrefix));
            if (result?.changed !== 1) fail('Rotating the internal API key changed no row.');
            writes += 1;
            log('umami-bootstrap[db]: internal API key updated (rotated).');
        }
    }

    log(writes === 0
        ? 'umami-bootstrap[db]: no changes; made no writes.'
        : `umami-bootstrap[db]: done; ${writes} write(s).`);
    return { writes };
}

// ---------------------------------------------------------------- phase api

async function request(fetchImpl, sleep, url, init, { retry }) {
    const attempts = retry ? 5 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
            if (response.status >= 500 && attempt < attempts) {
                lastError = new BootstrapError(`Umami answered HTTP ${response.status}.`);
            } else {
                const text = await response.text();
                let body = null;
                try {
                    body = text ? JSON.parse(text) : null;
                } catch {
                    body = null;
                }
                return { status: response.status, body };
            }
        } catch (error) {
            lastError = error instanceof BootstrapError ? error : new BootstrapError(`Umami API request failed: ${error?.cause?.code || error?.name || 'error'}`);
        }
        if (attempt < attempts) await sleep(1000);
    }
    throw lastError;
}

export async function runApiPhase({
    env = process.env,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
}) {
    const websites = parseSeedWebsites(env.UMAMI_SEED_WEBSITES);
    if (websites.length === 0) {
        log('umami-bootstrap[api]: UMAMI_SEED_WEBSITES is not set; no websites to seed.');
        return { writes: 0 };
    }
    const key = internalApiKey(env.UMAMI_INTERNAL_KEY_SEED);
    const baseUrl = (env.UMAMI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    let host;
    try {
        host = new URL(baseUrl).hostname;
    } catch {
        host = '';
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) fail('UMAMI_BASE_URL must point at the container loopback.');
    const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
    const call = (method, path, payload, retry) => request(fetchImpl, sleep, `${baseUrl}${path}`, {
        method,
        headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }, { retry });

    let writes = 0;
    for (const website of websites) {
        const found = await call('GET', `/api/websites/${website.id}`, undefined, true);
        if (found.status === 401 || found.status === 403) {
            fail(`Umami refused the internal API key for website ${website.id} (HTTP ${found.status}).`);
        }
        const missing = found.status === 404 || (found.status === 200 && found.body === null);
        if (!missing && found.status !== 200) fail(`Reading website ${website.id} failed (HTTP ${found.status}).`);

        if (missing) {
            const created = await call('POST', '/api/websites', { id: website.id, name: website.name, domain: website.domain }, false);
            if (created.status !== 200 || created.body?.id !== website.id) {
                fail(`Creating website ${website.id} failed (HTTP ${created.status}).`);
            }
            writes += 1;
            log(`umami-bootstrap[api]: website ${website.id} created.`);
            continue;
        }

        const existing = found.body;
        if (!existing || typeof existing !== 'object' || existing.id !== website.id) {
            fail(`Reading website ${website.id} returned an unexpected result.`);
        }
        if (existing.userId !== ADMIN_USER_ID) {
            fail(`Website id ${website.id} is owned by another user; refusing to take it over.`);
        }
        if (existing.name === website.name && existing.domain === website.domain) {
            log(`umami-bootstrap[api]: website ${website.id} already configured.`);
            continue;
        }
        const updated = await call('POST', `/api/websites/${website.id}`, { name: website.name, domain: website.domain }, false);
        if (updated.status !== 200 || updated.body?.id !== website.id) {
            fail(`Updating website ${website.id} failed (HTTP ${updated.status}).`);
        }
        writes += 1;
        log(`umami-bootstrap[api]: website ${website.id} updated.`);
    }
    log(writes === 0
        ? 'umami-bootstrap[api]: no changes; made no writes.'
        : `umami-bootstrap[api]: done; ${writes} write(s).`);
    return { writes };
}

// ---------------------------------------------------------------- entry

// A message for the log that is safe to print: BootstrapError text is already
// secret-free; anything else shows only its class, code and a missing module.
export function describeFailure(error, env = process.env) {
    if (error instanceof BootstrapError) return error.message;
    const parts = [error?.name || 'Error'];
    if (error?.code) parts.push(String(error.code));
    const missing = error?.code === 'MODULE_NOT_FOUND' ? /Cannot find module '([^']+)'/.exec(String(error.message))?.[1] : undefined;
    if (missing) parts.push(`module ${missing}`);
    let text = `unexpected failure (${parts.join(', ')})`;
    for (const secret of [env.UMAMI_INTERNAL_KEY_SEED, env.UMAMI_ADMIN_PASSWORD]) {
        if (secret) text = text.split(secret).join('[REDACTED]');
    }
    return text;
}

export async function main(argv = process.argv.slice(2), options = {}) {
    if (argv.length !== 1 || !['db', 'api'].includes(argv[0])) {
        fail('Usage: umami-bootstrap.mjs db|api');
    }
    if (argv[0] === 'db') {
        const env = options.env || process.env;
        return runDbPhase({
            env,
            query: options.query || createPsqlQuery({ env }),
            bcrypt: options.bcrypt,
            log: options.log,
        });
    }
    return runApiPhase({ env: options.env || process.env, fetchImpl: options.fetchImpl, sleep: options.sleep, log: options.log });
}

// Ploinky stages /code through symlinks; compare real paths like the ingress.
if (process.argv[1] && fs.existsSync(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    main().catch((error) => {
        console.error(`umami-bootstrap: ${describeFailure(error)}`);
        process.exit(1);
    });
}
