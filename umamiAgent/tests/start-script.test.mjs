import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/start-umami-agent.sh', import.meta.url));
const SEED = 'f7'.repeat(32);
const PASSWORD = 'a long enough admin password';

// Runs the real start script with its absolute image paths redirected into a
// scratch tree and every external program replaced by a recording stub.
function stage(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-start-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    const files = {
        app: path.join(root, 'app'), code: path.join(root, 'code'), agent: path.join(root, 'Agent/server'),
        data: path.join(root, 'data/postgres'), log: path.join(root, 'calls.log'), pids: path.join(root, 'pids.log'),
    };
    for (const dir of [bin, files.app, path.join(files.code, 'scripts'), files.agent, files.data]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(files.app, 'server.js'), '');
    fs.writeFileSync(path.join(files.data, 'PG_VERSION'), '18\n');
    const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // Records only whether the secrets are present in a process's environment, never their values.
    const presence = 'P="seed=${UMAMI_INTERNAL_KEY_SEED:+set} password=${UMAMI_ADMIN_PASSWORD:+set}"';
    stub('node', [
        presence,
        'case "$*" in',
        '  *--check-build*) exit 0 ;;',
        '  *umami-bootstrap.mjs\\ db) echo "bootstrap-db $P" >> "$LOG"; [ "$FAIL_PHASE" = db ] && exit 1; exit 0 ;;',
        '  *umami-bootstrap.mjs\\ api) echo "bootstrap-api $P" >> "$LOG"; [ "$FAIL_PHASE" = api ] && exit 1; exit 0 ;;',
        '  *server.js) echo "next $P" >> "$LOG"; echo $$ >> "$PIDS"; exec sleep 60 ;;',
        '  *umami-ingress.mjs) echo "ingress $P" >> "$LOG"; echo $$ >> "$PIDS"; exec sleep 60 ;;',
        '  *npm-cli.js*) echo "npm $*" | sed "s#.*npm-cli.js#npm#" >> "$LOG"; exit 0 ;;',
        // Health probe: succeed once Next.js and the ingress have both started.
        '  *fetch*) for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do grep -q "^next" "$LOG" && grep -q "^ingress" "$LOG" && exit 0; sleep 0.25; done; exit 1 ;;',
        'esac',
        'echo "unexpected node $*" >> "$LOG"; exit 9',
    ].join('\n'));
    stub('flock', 'exit 0');
    stub('chown', 'exit 0');
    stub('pg_isready', 'exit 0');
    stub('createdb', 'exit 0');
    stub('psql', 'echo 1');
    stub('su-exec', 'case "$*" in *--single*) cat >/dev/null; exit 0 ;; *initdb*) exit 0 ;; esac\necho $$ >> "$PIDS"; exec sleep 60');
    fs.writeFileSync(path.join(files.agent, 'AgentServer.sh'), `${presence}\necho "agent-server $P" >> "$LOG"\necho $$ >> "$PIDS"\nif [ "$AGENT_EXITS" = 1 ]; then sleep 1; exit 0; fi\nexec sleep 60\n`);

    const source = fs.readFileSync(SCRIPT, 'utf8')
        .replaceAll('/app/server.js', `${files.app}/server.js`)
        .replace('cd /app\n', `cd ${files.app}\n`)
        .replaceAll('/code/scripts/', `${files.code}/scripts/`)
        .replace('/usr/local/lib/node_modules/npm/bin/npm-cli.js', `${root}/npm-cli.js`)
        .replace('/Agent/server/AgentServer.sh', `${files.agent}/AgentServer.sh`);
    assert.ok(!/(^|[\s'"=])\/(app|code|Agent|usr)\//.test(source), 'every image path was redirected');
    const script = path.join(root, 'start.sh');
    fs.writeFileSync(script, source);

    const env = {
        PATH: `${bin}:/usr/bin:/bin`, LOG: files.log, PIDS: files.pids, PGDATA: files.data, UMAMI_DATA_LOCK: path.join(root, 'lock'),
        APP_SECRET: 'app-secret-value', UMAMI_INTERNAL_KEY_SEED: SEED, UMAMI_ADMIN_PASSWORD: PASSWORD, FAIL_PHASE: '',
    };
    const run = (extra = {}) => new Promise((resolve, reject) => {
        const child = spawn('sh', [script], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdout.resume();
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('start script did not finish')); }, 40_000);
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
        child.on('error', reject);
    });
    const calls = () => (fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8').trim().split('\n') : []);
    const pids = () => (fs.existsSync(files.pids) ? fs.readFileSync(files.pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
    return { run, calls, pids };
}

// Next.js and the ingress start in the background, so their log lines may interleave.
const inOrder = (lines) => [...lines.slice(0, 3), ...lines.slice(3, 5).sort(), ...lines.slice(5)];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function settled(pids) {
    for (let attempt = 0; attempt < 50 && pids.some(alive); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return pids.filter(alive);
}

test('a failing db bootstrap stops the stack before Next.js starts and cleans up', { timeout: 60_000 }, async (t) => {
    const { run, calls, pids } = stage(t);
    const result = await run({ FAIL_PHASE: 'db' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(inOrder(calls()), ['npm run check:db', 'npm run update:tracker', 'bootstrap-db seed=set password=set']);
    assert.deepEqual(await settled(pids()), [], 'PostgreSQL stub was stopped');
});

test('a failing api bootstrap stops Next.js and the ingress and never starts AgentServer', { timeout: 60_000 }, async (t) => {
    const { run, calls, pids } = stage(t);
    const result = await run({ FAIL_PHASE: 'api' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(inOrder(calls()), [
        'npm run check:db', 'npm run update:tracker', 'bootstrap-db seed=set password=set',
        'ingress seed= password=', 'next seed= password=', 'bootstrap-api seed=set password=',
    ]);
    assert.equal(pids().length, 3, 'PostgreSQL, Next.js and the ingress were started');
    assert.deepEqual(await settled(pids()), [], 'every started process was stopped');
});

test('a clean start runs the phases in order and hands the seed only to the bootstrap and AgentServer', { timeout: 60_000 }, async (t) => {
    const { run, calls, pids } = stage(t);
    const result = await run({ AGENT_EXITS: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(inOrder(calls()), [
        'npm run check:db', 'npm run update:tracker', 'bootstrap-db seed=set password=set',
        'ingress seed= password=', 'next seed= password=', 'bootstrap-api seed=set password=',
        'agent-server seed=set password=',
    ]);
    assert.deepEqual(await settled(pids()), []);
    assert.ok(!result.stderr.includes(SEED) && !result.stderr.includes(PASSWORD));
});
