import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('../scripts/', import.meta.url));
const basePath = '/base-agent-additional-server/umamiAgent/3000';
const nodeModes = [[], ['--preserve-symlinks', '--preserve-symlinks-main']];

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umami-entrypoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, '.next'), { recursive: true });
    const metadataFile = path.join(app, 'ploinky-umami-build.json');
    const configFile = path.join(app, '.next/required-server-files.json');
    fs.writeFileSync(metadataFile, JSON.stringify({
        schema: 'ploinky.umami-build/v1', version: '3.2.0', sourceCommit: 'a'.repeat(40), basePath,
    }));
    fs.writeFileSync(configFile, JSON.stringify({ config: { basePath } }));
    const code = path.join(root, 'code');
    fs.mkdirSync(code);
    fs.symlinkSync(sourceDirectory, path.join(code, 'scripts'), 'dir');
    const entry = path.join(code, 'scripts/umami-ingress.mjs');

    // Keep the production module unchanged: supply its image files from the
    // fixture and bind its real HTTP server to a private ephemeral test port.
    const preload = path.join(root, 'preload.mjs');
    fs.writeFileSync(preload, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
const paths = new Map(${JSON.stringify([
        ['/app/ploinky-umami-build.json', metadataFile],
        ['/app/.next/required-server-files.json', configFile],
    ])});
const read = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
    if (paths.has(file)) {
        process.stdout.write(JSON.stringify({ read: file }) + '\\n');
        file = paths.get(file);
    }
    return read.call(this, file, ...args);
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, host, ...args) {
    assert.equal(port, 3000);
    assert.equal(host, '0.0.0.0');
    this.once('listening', () => {
        const request = http.get({
            hostname: '127.0.0.1', port: this.address().port, path: '/api/heartbeat',
            headers: { 'x-forwarded-prefix': '/foreign-publication' },
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                assert.equal(response.statusCode, 400);
                assert.equal(body, 'Invalid Umami publication prefix.');
                this.closeAllConnections();
                this.close(() => process.stdout.write(JSON.stringify({ listener: true, status: response.statusCode }) + '\\n'));
            });
            response.on('error', (error) => { throw error; });
        });
        request.on('error', (error) => { throw error; });
    });
    return listen.call(this, 0, '127.0.0.1', ...args);
};
`);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const run = (mode, args, input) => spawnSync(process.execPath, [...mode, '--import', preload, ...args], {
        env, encoding: 'utf8', input, timeout: 5_000,
    });
    return { entry, root, metadataFile, configFile, run };
}

function successfulEvents(result) {
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('staged symlink --check-build validates the actual image files with or without Node symlink options', (t) => {
    const { entry, metadataFile, configFile, run } = fixture(t);
    for (const mode of nodeModes) {
        assert.deepEqual(successfulEvents(run(mode, [entry, '--check-build'])), [
            { read: '/app/ploinky-umami-build.json' },
            { read: '/app/.next/required-server-files.json' },
        ]);
    }
    fs.writeFileSync(configFile, JSON.stringify({ config: { basePath: '/wrong' } }));
    for (const mode of nodeModes) {
        const rejected = run(mode, [entry, '--check-build']);
        assert.ifError(rejected.error);
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /required source-built Router base path/);
    }
    fs.rmSync(metadataFile);
    const missing = run([], [entry, '--check-build']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
});

test('staged symlink normal launch opens the real ingress and handles HTTP before exiting', (t) => {
    const { entry, run } = fixture(t);
    for (const mode of nodeModes) {
        const events = successfulEvents(run(mode, [entry]));
        assert.deepEqual(events, [
            { read: '/app/ploinky-umami-build.json' },
            { read: '/app/.next/required-server-files.json' },
            { listener: true, status: 400 },
        ]);
    }
});

test('importing the staged module from a file or stdin does not validate or open a listener', (t) => {
    const { entry, root, metadataFile, run } = fixture(t);
    fs.rmSync(metadataFile);
    const source = `await import(${JSON.stringify(pathToFileURL(entry).href)});`;
    const importer = path.join(root, 'importer.mjs');
    fs.writeFileSync(importer, source);
    for (const mode of nodeModes) {
        assert.deepEqual(successfulEvents(run(mode, [importer])), []);
        assert.deepEqual(successfulEvents(run(mode, ['--input-type=module', '-'], source)), []);
    }
});
