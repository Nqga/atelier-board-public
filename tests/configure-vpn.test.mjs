import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const bash = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
const options = { skip: process.platform === 'linux' && bash ? false : 'Configuration VPN : Bash sous Linux requis.' };
const localAddress = '192.0.2.10';

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'atelier-vpn-tests-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'project with spaces');
  await mkdir(join(project, 'scripts'), { recursive: true });
  await mkdir(join(project, 'deploy'));
  await copyFile(join(repository, 'scripts/configure-vpn.sh'), join(project, 'scripts/configure-vpn.sh'));
  await copyFile(join(repository, 'deploy/compose.vpn.yml'), join(project, 'deploy/compose.vpn.yml'));
  await writeFile(join(project, 'package.json'), '{"name":"atelier-board"}\n');
  await writeFile(join(project, 'docker-compose.yml'), 'services:\n  atelier:\n    image: example\n');
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'ip'), `#!/usr/bin/env bash
[[ "$*" == "-o -4 addr show" ]] || exit 2
[[ "\${FAKE_IP_FAIL:-0}" == 0 ]] || exit 1
printf '%s\\n' '1: lo    inet 127.0.0.1/8 scope host lo' '2: tunnel0    inet ${localAddress}/24 scope global tunnel0'
`, { mode: 0o755 });
  return { scratch, project, bin };
}

function run(f, args = [localAddress], extra = {}) {
  return spawnSync('bash', [join(f.project, 'scripts/configure-vpn.sh'), ...args], {
    encoding: 'utf8', cwd: f.scratch,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, ...extra },
  });
}

async function privateArtifacts(project) {
  return (await readdir(project)).filter(name => name.startsWith('.env.vpn') || name === '.atelier-board-vpn.lock').sort();
}

test('VPN helper creates a private local-address profile without touching project identity, configuration or data', options, async t => {
  const f = await fixture(t);
  const privateFiles = { '.env': 'COMPOSE_PROJECT_NAME=existing-deployment\nMAX_TOTAL_STORAGE_MB=987\nPRIVATE_LOCAL_VALUE=unchanged\n',
    'data/atelier.sqlite': Buffer.from([1, 2, 255, 0]), '.git/marker': 'local Git state\n' };
  for (const [path, content] of Object.entries(privateFiles)) {
    await mkdir(join(f.project, path, '..'), { recursive: true });
    await writeFile(join(f.project, path), content);
  }
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.project, '.env.vpn'), 'utf8'), `VPN_BIND_ADDRESS=${localAddress}\nPORT=3000\nVPN_PUBLIC_URL=http://${localAddress}:3000\n`);
  assert.equal((await stat(join(f.project, '.env.vpn'))).mode & 0o777, 0o600);
  for (const [path, content] of Object.entries(privateFiles)) assert.deepEqual(await readFile(join(f.project, path)), Buffer.from(content));
  assert.deepEqual(await privateArtifacts(f.project), ['.env.vpn']);
  assert.match(result.stdout, /Aucun conteneur ni tunnel démarré/);
});

test('VPN --check validates a local address and port without writes, backups or permission changes', options, async t => {
  const f = await fixture(t);
  assert.equal(run(f, ['--check', localAddress, '8080']).status, 0);
  assert.deepEqual(await privateArtifacts(f.project), []);
  await writeFile(join(f.project, '.env.vpn'), '# Preserve this configuration\nPORT=9000\n', { mode: 0o644 });
  await chmod(join(f.project, '.env.vpn'), 0o644);
  const original = await readFile(join(f.project, '.env.vpn'));
  assert.equal(run(f, ['--check', localAddress]).status, 0);
  assert.deepEqual(await readFile(join(f.project, '.env.vpn')), original);
  assert.equal((await stat(join(f.project, '.env.vpn'))).mode & 0o777, 0o644);
  assert.deepEqual(await privateArtifacts(f.project), ['.env.vpn']);
});

test('VPN reconfiguration preserves other text without executing values, backs up changes and is idempotent', options, async t => {
  const f = await fixture(t);
  const sentinel = join(f.scratch, 'must-not-exist');
  const original = `# Keep this comment\nCOMPOSE_PROJECT_NAME=existing-deployment\nOTHER=$(touch '${sentinel}')\nexport VPN_BIND_ADDRESS = 192.0.2.22\nVPN_BIND_ADDRESS=192.0.2.23\n PORT = 4000\nVPN_PUBLIC_URL=http://old.invalid:4000\n# Keep another comment\n`;
  await writeFile(join(f.project, '.env.vpn'), original, { mode: 0o644 });
  await chmod(join(f.project, '.env.vpn'), 0o644);
  const result = run(f, [localAddress, '8080']);
  assert.equal(result.status, 0, result.stderr);
  const actual = await readFile(join(f.project, '.env.vpn'), 'utf8');
  assert.match(actual, /^# Keep this comment\nCOMPOSE_PROJECT_NAME=existing-deployment\nOTHER=\$\(touch /);
  assert.match(actual, /# Keep another comment/);
  assert.match(actual, new RegExp(`^VPN_BIND_ADDRESS=${localAddress.replaceAll('.', '\\.')}\\nPORT=8080\\nVPN_PUBLIC_URL=http://${localAddress.replaceAll('.', '\\.')}:8080$`, 'm'));
  assert.equal((actual.match(/^VPN_BIND_ADDRESS=/gm) || []).length, 1);
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  const backups = (await privateArtifacts(f.project)).filter(name => name.startsWith('.env.vpn.backup.'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.project, backups[0]), 'utf8'), original);
  assert.equal((await stat(join(f.project, backups[0]))).mode & 0o777, 0o600);
  const before = await privateArtifacts(f.project);
  assert.equal(run(f, [localAddress, '8080']).status, 0);
  assert.deepEqual(await privateArtifacts(f.project), before);
  assert.equal((await stat(join(f.project, '.env.vpn'))).mode & 0o777, 0o600);
});

test('VPN helper rejects malformed, wildcard, multicast and nonlocal addresses before any write', options, async t => {
  const f = await fixture(t);
  for (const address of ['0.0.0.0', '224.0.0.1', '255.255.255.255', '256.0.0.1', '192.0.2.010', '192.0.2.11',
    '192.0.2', 'http://192.0.2.10:3000', '192.0.2.10:3000', '::1', '192.0.2.10; touch unexpected']) {
    const result = run(f, [address]);
    assert.notEqual(result.status, 0, address);
    assert.deepEqual(await privateArtifacts(f.project), [], address);
  }
  for (const port of ['0', '-1', '65536', '03000', '3000x', '']) {
    assert.notEqual(run(f, [localAddress, port]).status, 0, port);
    assert.deepEqual(await privateArtifacts(f.project), [], port);
  }
  assert.notEqual(run(f, [localAddress], { FAKE_IP_FAIL: '1' }).status, 0);
  assert.deepEqual(await privateArtifacts(f.project), []);
});

test('VPN helper rejects symlinks for output, lock, source file, script and script parent', options, async t => {
  for (const kind of ['output', 'lock', 'source', 'script', 'parent']) {
    const f = await fixture(t);
    const sentinel = join(f.scratch, `outside-${kind}`);
    await writeFile(sentinel, 'Do not change this file\n');
    let argsScript = join(f.project, 'scripts/configure-vpn.sh');
    if (kind === 'output') await symlink(sentinel, join(f.project, '.env.vpn'));
    if (kind === 'lock') await symlink(sentinel, join(f.project, '.atelier-board-vpn.lock'));
    if (kind === 'source') {
      await rm(join(f.project, 'package.json'));
      await symlink(sentinel, join(f.project, 'package.json'));
    }
    if (kind === 'script') {
      const actual = join(f.scratch, 'actual-script.sh');
      await copyFile(argsScript, actual);
      await rm(argsScript);
      await symlink(actual, argsScript);
    }
    if (kind === 'parent') {
      await symlink(f.project, join(f.scratch, 'linked-project'));
      argsScript = join(f.scratch, 'linked-project/scripts/configure-vpn.sh');
    }
    const result = spawnSync('bash', [argsScript, localAddress], {
      encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /lien symbolique/, kind);
    assert.equal(await readFile(sentinel, 'utf8'), 'Do not change this file\n');
  }
});

test('VPN helper refuses an existing lock or nonregular output without changes', options, async t => {
  const f = await fixture(t);
  const content = `VPN_BIND_ADDRESS=${localAddress}\nPORT=3000\nVPN_PUBLIC_URL=http://${localAddress}:3000\n`;
  await writeFile(join(f.project, '.env.vpn'), content);
  await mkdir(join(f.project, '.atelier-board-vpn.lock'));
  assert.notEqual(run(f).status, 0);
  assert.notEqual(run(f, ['--check', localAddress]).status, 0);
  assert.equal(await readFile(join(f.project, '.env.vpn'), 'utf8'), content);
  assert.equal((await lstat(join(f.project, '.atelier-board-vpn.lock'))).isDirectory(), true);
  await rm(join(f.project, '.atelier-board-vpn.lock'), { recursive: true });
  await rm(join(f.project, '.env.vpn'));
  await mkdir(join(f.project, '.env.vpn'));
  assert.notEqual(run(f).status, 0);
  assert.equal((await lstat(join(f.project, '.env.vpn'))).isDirectory(), true);
});

test('VPN helper detects an IPv4 really assigned on Linux with iproute2', options, async t => {
  const addresses = spawnSync('ip', ['-o', '-4', 'addr', 'show'], { encoding: 'utf8' });
  if (addresses.status !== 0) return t.skip('iproute2 absent dans cet environnement.');
  const address = addresses.stdout.match(/\binet ([1-9][0-9]{0,2}(?:\.[0-9]{1,3}){3})\//)?.[1];
  if (!address) return t.skip('Aucune IPv4 locale disponible.');
  const f = await fixture(t);
  const result = run(f, ['--check', address], { PATH: process.env.PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await privateArtifacts(f.project), []);
});
