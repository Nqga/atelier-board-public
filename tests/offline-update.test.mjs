import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfflineUpdate } from '../scripts/build-offline-update.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
const supported = gitAvailable && bashAvailable;
const options = { skip: supported ? false : 'Tests du générateur : Git et Bash sont nécessaires.' };
let scratch, source, installer;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function put(root, path, contents, mode = 0o600) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents, { mode });
  await chmod(join(root, path), mode);
}

before(async () => {
  if (!supported) return;
  scratch = await mkdtemp(join(tmpdir(), 'atelier-offline-tests-'));
  source = join(scratch, 'sources');
  await mkdir(source);
  await put(source, 'package.json', JSON.stringify({ name: 'atelier-board', version: '2.1.0' }, null, 2) + '\n');
  await put(source, 'server.mjs', 'export const version = "2.1.0";\n');
  await put(source, 'dist/app.js', 'export const newCode = true;\n');
  await put(source, 'scripts/demo.sh', '#!/usr/bin/env bash\nprintf "v2.1\\n"\n');
  await put(source, 'deploy/Caddyfile', 'example.invalid {\n reverse_proxy app:3000\n}\n');
  await put(source, '.env.example', 'PORT=3000\n');
  await put(source, '.env.production.example', 'APP_DOMAIN=example.invalid\n');
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['add', '--all'], { cwd: source });
  installer = join(scratch, 'atelier-board-v2-to-v2.1.sh');
  await buildOfflineUpdate(source, installer);
});

after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function destination(name) {
  const root = join(scratch, name);
  await mkdir(root);
  await put(root, 'package.json', JSON.stringify({ name: 'atelier-board', version: '2.0.0' }, null, 2) + '\n');
  await put(root, 'server.mjs', '// old server, with a local source customization\n');
  await put(root, 'dist/app.js', '// old application\n');
  await put(root, 'dist/local-private.txt', 'local file outside the source manifest\n');
  await put(root, '.env', 'PRIVATE_SETTING=keep-this-local\n');
  await put(root, '.env.production', 'PRIVATE_SETTING=also-local\n');
  await put(root, 'data/atelier.sqlite', Buffer.from([0, 1, 2, 255, 3]));
  await put(root, 'data/assets/image.png', Buffer.from([137, 80, 78, 71, 8, 9]));
  await put(root, '.git/local-marker', 'local Git state\n');
  const dependencies = join(scratch, `${name}-dependencies`);
  await mkdir(dependencies);
  await symlink(dependencies, join(root, 'node_modules'));
  return root;
}

function run(target, args = [], env = {}, script = installer) {
  return spawnSync('bash', [script, ...args, target], { encoding: 'utf8', env: { ...process.env, ...env } });
}

async function privateSnapshot(target) {
  const paths = ['.env', '.env.production', 'data/atelier.sqlite', 'data/assets/image.png',
    '.git/local-marker', 'dist/local-private.txt'];
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(target, path)))])));
}

async function sourceSnapshot(target) {
  const result = {};
  async function visit(directory, relative = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(target, path));
      if (info.isDirectory()) await visit(join(target, path), path);
      else if (info.isSymbolicLink()) result[path] = 'symlink';
      else result[path] = `${info.mode & 0o777}:${sha(await readFile(join(target, path)))}`;
    }
  }
  await visit(target);
  return result;
}

test('offline update installs sources with normalized modes and preserves private files', options, async () => {
  const target = await destination('project with spaces');
  const original = await privateSnapshot(target);
  const oldServer = await readFile(join(target, 'server.mjs'));
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, '2.1.0');
  assert.deepEqual(await privateSnapshot(target), original);
  assert.equal((await lstat(join(target, 'node_modules'))).isSymbolicLink(), true);
  assert.equal((await stat(join(target, 'deploy/Caddyfile'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(target, 'scripts/demo.sh'))).mode & 0o777, 0o755);
  assert.equal((await stat(join(target, 'releases/atelier-board-v2-to-v2.1.sh'))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(join(target, 'releases/atelier-board-v2-to-v2.1.sh')), await readFile(installer));
  const backups = (await readdir(scratch)).filter(name => name.startsWith('.atelier-board-v2.1-backup-'));
  assert.equal(backups.length, 1);
  const backup = join(scratch, backups[0]);
  assert.equal((await stat(backup)).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(join(backup, 'files/server.mjs')), oldServer);
  assert.equal((await stat(join(backup, 'files/server.mjs'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(backup, 'new-files.list'), 'utf8'), /releases\/atelier-board-v2-to-v2.1\.sh/);
  assert.equal(run(target).status, 0);
  assert.equal(run(target, [], {}, join(target, 'releases/atelier-board-v2-to-v2.1.sh')).status, 0);
  assert.equal((await readdir(scratch)).filter(name => name.startsWith('.atelier-board-v2.1-backup-')).length, 1);
});

test('--check validates without changing the target or creating a backup', options, async () => {
  const target = await destination('check only');
  const before = await sourceSnapshot(target);
  const backupsBefore = (await readdir(scratch)).filter(name => name.startsWith('.atelier-board-v2.1-backup-')).length;
  const result = run(target, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await sourceSnapshot(target), before);
  assert.equal((await readdir(scratch)).filter(name => name.startsWith('.atelier-board-v2.1-backup-')).length, backupsBefore);
});

test('wrong project and incompatible versions are rejected before writing source files', options, async () => {
  for (const [index, name, version] of [[0, 'other-project', '2.0.0'], [1, 'atelier-board', '1.9.0'],
    [2, 'atelier-board', '2.2.0'], [3, 'atelier-board', '2.1.1']]) {
    const target = await destination(`invalid-version-${index}`);
    await put(target, 'package.json', JSON.stringify({ name, version }, null, 2));
    const before = await sourceSnapshot(target);
    const result = run(target);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await sourceSnapshot(target), before);
    assert.match(result.stderr, /v2\.0\.x ou v2\.1\.0/);
  }
});

test('corrupted embedded archive is rejected without modifying the target', options, async () => {
  const target = await destination('corrupted-payload');
  const before = await sourceSnapshot(target);
  const corrupt = join(scratch, 'corrupted-installer.sh');
  const text = await readFile(installer, 'utf8');
  await writeFile(corrupt, text.replace(/(<<'ATELIER_PAYLOAD_BASE64'\n)[A-Za-z0-9+/]/, '$1A'));
  const result = run(target, [], {}, corrupt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /corrompu|Base64|archive/i);
  assert.deepEqual(await sourceSnapshot(target), before);
});

test('source symlinks including dangling links and directory collisions are rejected', options, async () => {
  const external = join(scratch, 'external-app.js');
  await writeFile(external, 'outside the project\n');
  for (const scenario of ['linked-parent', 'dangling-file', 'directory-file', 'file-parent']) {
    const target = await destination(scenario);
    if (scenario === 'linked-parent') {
      await rm(join(target, 'dist'), { recursive: true });
      await symlink(scratch, join(target, 'dist'));
    } else if (scenario === 'dangling-file') {
      await rm(join(target, 'dist/app.js'));
      await symlink(join(scratch, 'does-not-exist'), join(target, 'dist/app.js'));
    } else if (scenario === 'directory-file') {
      await rm(join(target, 'dist/app.js'));
      await mkdir(join(target, 'dist/app.js'));
    } else await writeFile(join(target, 'deploy'), 'not a directory');
    const before = await sourceSnapshot(target);
    const result = run(target);
    assert.notEqual(result.status, 0, scenario);
    assert.deepEqual(await sourceSnapshot(target), before);
  }
  assert.equal(await readFile(external, 'utf8'), 'outside the project\n');
});

test('a failed atomic replacement rolls back every changed source and removes only new files', options, async () => {
  const wrappers = join(scratch, 'failure-wrappers');
  await mkdir(wrappers);
  const realMv = execFileSync('bash', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
  await put(wrappers, 'mv', `#!/usr/bin/env bash\ncount=$(cat "$ATELIER_TEST_COUNTER" 2>/dev/null || printf '0')\ncount=$((count + 1))\nprintf '%s' "$count" > "$ATELIER_TEST_COUNTER"\nif ((count == ATELIER_TEST_FAIL_AT)); then exit 44; fi\nexec "${realMv}" "$@"\n`, 0o755);
  for (const failAt of [3, 4, 6]) {
    const target = await destination(`rollback-${failAt}`);
    const before = await sourceSnapshot(target);
    const result = run(target, [], { PATH: `${wrappers}:${process.env.PATH}`, ATELIER_TEST_FAIL_AT: `${failAt}`,
      ATELIER_TEST_COUNTER: join(scratch, `mv-counter-${failAt}`) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /annulées/);
    assert.deepEqual(await sourceSnapshot(target), before);
  }
});

test('a termination signal during replacement restores source files and keeps private data', options, async () => {
  const target = await destination('signal-rollback');
  const before = await sourceSnapshot(target);
  const wrappers = join(scratch, 'signal-wrappers');
  await mkdir(wrappers);
  const realMv = execFileSync('bash', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
  await put(wrappers, 'mv', `#!/usr/bin/env bash\nif [[ ! -f "$ATELIER_TEST_SIGNAL_MARKER" ]]; then\n  : > "$ATELIER_TEST_SIGNAL_MARKER"\n  "${realMv}" "$@"\n  kill -TERM "$PPID"\n  exit 0\nfi\nexec "${realMv}" "$@"\n`, 0o755);
  const result = run(target, [], { PATH: `${wrappers}:${process.env.PATH}`, ATELIER_TEST_SIGNAL_MARKER: join(scratch, 'signal-marker') });
  assert.equal(result.status, 143, result.stderr);
  assert.deepEqual(await sourceSnapshot(target), before);
});

test('an existing update lock is preserved and refuses concurrent updates', options, async () => {
  const target = await destination('locked-project');
  await put(target, '.atelier-board-update.lock/marker', 'another update\n');
  const before = await sourceSnapshot(target);
  const result = run(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /déjà en cours/);
  assert.deepEqual(await sourceSnapshot(target), before);
});

test('the builder excludes untracked private files and refuses staged secrets and symlinks', options, async () => {
  const privateRoot = join(scratch, 'private-build');
  await mkdir(privateRoot);
  await put(privateRoot, 'package.json', JSON.stringify({ name: 'atelier-board', version: '2.1.0' }));
  await put(privateRoot, 'server.mjs', '// public\n');
  execFileSync('git', ['init', '-q'], { cwd: privateRoot });
  execFileSync('git', ['add', 'package.json', 'server.mjs'], { cwd: privateRoot });
  await put(privateRoot, '.npmrc', '//registry.example/:_authToken=fake-test-sentinel\n');
  await put(privateRoot, 'secrets.txt', 'fake-private-sentinel\n');
  const output = join(scratch, 'private-safe.sh');
  const result = await buildOfflineUpdate(privateRoot, output);
  assert.equal(result.fileCount, 3, 'two public files plus the installer itself');
  execFileSync('git', ['add', '.npmrc'], { cwd: privateRoot });
  await assert.rejects(buildOfflineUpdate(privateRoot, output), /Fichier privé interdit/);
  execFileSync('git', ['rm', '--cached', '.npmrc'], { cwd: privateRoot });
  await symlink(join(privateRoot, 'server.mjs'), join(privateRoot, 'linked.mjs'));
  execFileSync('git', ['add', 'linked.mjs'], { cwd: privateRoot });
  await assert.rejects(buildOfflineUpdate(privateRoot, output), /Lien symbolique source interdit/);
});

test('the builder refuses linked outputs and overwriting another tracked source', options, async () => {
  const sentinel = join(scratch, 'output-sentinel');
  await writeFile(sentinel, 'never overwrite this local file\n');
  const linked = join(scratch, 'linked-output.sh');
  await symlink(sentinel, linked);
  await assert.rejects(buildOfflineUpdate(source, linked), /Sortie non régulière|lien symbolique/);
  const checksumLinked = join(scratch, 'linked-checksum-output.sh');
  await symlink(sentinel, `${checksumLinked}.sha256`);
  await assert.rejects(buildOfflineUpdate(source, checksumLinked), /Sortie non régulière|lien symbolique/);
  await assert.rejects(stat(checksumLinked), { code: 'ENOENT' });
  const linkedDirectory = join(scratch, 'linked-output-parent');
  await symlink(source, linkedDirectory);
  await assert.rejects(buildOfflineUpdate(source, join(linkedDirectory, 'output.sh')), /Sortie non régulière|lien symbolique/);
  const server = await readFile(join(source, 'server.mjs'));
  await assert.rejects(buildOfflineUpdate(source, 'server.mjs'), /source versionnée/);
  assert.deepEqual(await readFile(join(source, 'server.mjs')), server);
  assert.equal(await readFile(sentinel, 'utf8'), 'never overwrite this local file\n');
});

test('a destination without Git, Node or Docker in PATH accepts the update', options, async () => {
  const target = await destination('minimal-host');
  const minimalPath = join(scratch, 'offline-tools');
  await mkdir(minimalPath);
  for (const name of ['bash', 'tar', 'gzip', 'base64', 'mktemp', 'awk', 'sed', 'sort', 'cmp', 'cp', 'mv',
    'chmod', 'stat', 'mkdir', 'rmdir', 'rm', 'dirname', 'sha256sum', 'cat']) {
    const executable = execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    await symlink(executable, join(minimalPath, name));
  }
  const result = run(target, [], { PATH: minimalPath });
  assert.equal(result.status, 0, result.stderr);
});

test('the updater applies to actual initial and latest V2 archives without Git metadata', options, async t => {
  for (const revision of ['eb140cf', '4aadce0']) {
    if (spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: repository }).status !== 0) {
      t.diagnostic(`Archive ${revision} absente dans cette copie ; scénario historique non exécuté.`);
      continue;
    }
    const target = join(scratch, `real-v2-${revision}`);
    await mkdir(target);
    const archive = join(scratch, `v2-${revision}.tar`);
    await writeFile(archive, execFileSync('git', ['archive', revision], { cwd: repository, maxBuffer: 8 * 1024 * 1024 }));
    execFileSync('tar', ['-xf', archive, '-C', target]);
    await put(target, '.env', 'KEEP_LOCAL_CONFIG=yes\n');
    await put(target, 'data/atelier.sqlite', Buffer.from('SQLite fixture bytes to retain exactly'));
    await put(target, 'data/assets/existing.png', Buffer.from([137, 80, 78, 71]));
    const result = run(target);
    assert.equal(result.status, 0, `${revision}: ${result.stderr}`);
    assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, '2.1.0');
    assert.equal(await readFile(join(target, '.env'), 'utf8'), 'KEEP_LOCAL_CONFIG=yes\n');
    assert.equal(await readFile(join(target, 'data/atelier.sqlite'), 'utf8'), 'SQLite fixture bytes to retain exactly');
    assert.deepEqual(await readFile(join(target, 'data/assets/existing.png')), Buffer.from([137, 80, 78, 71]));
    await assert.rejects(stat(join(target, '.git')), { code: 'ENOENT' });
  }
});
