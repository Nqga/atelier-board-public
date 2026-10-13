#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerPath = 'releases/atelier-board-v2-to-v2.2.sh';
const manifestName = '__atelier_update_manifest.tsv';
const templatePath = fileURLToPath(new URL('./offline-update.template.sh', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function safeSource(path) {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Chemin source non pris en charge : ${path}`);
  }
  if (path === manifestName) throw new Error(`Nom réservé : ${path}`);
  const parts = path.split('/');
  if (parts.some(part => ['.git', 'node_modules', 'data', 'test-results', '.openai', '.npmrc', '.netrc',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].includes(part)) ||
      /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:sqlite(?:-(?:shm|wal))?|db|pem|key|p12|pfx))$/i.test(path) &&
      !['.env.example', '.env.production.example', '.env.vpn.example'].includes(path)) {
    throw new Error(`Fichier privé interdit dans la mise à jour : ${path}`);
  }
}

async function safeOutput(path) {
  let current = resolve('/');
  const parts = resolve(path).split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Sortie non régulière ou lien symbolique interdit : ${path}`);
    }
  }
}

export async function buildOfflineUpdate(root, output) {
  root = resolve(root);
  output = resolve(root, output ?? installerPath);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'atelier-board' || !/^2\.2\.\d+$/.test(pkg.version)) {
    throw new Error('Le générateur attend Atelier Board en version 2.2.x.');
  }
  // New release sources must be staged first. Arbitrary untracked local files are never published.
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const outputRelative = relative(root, output).split('\\').join('/');
  for (const path of [outputRelative, `${outputRelative}.sha256`]) {
    if (files.includes(path) && ![installerPath, `${installerPath}.sha256`].includes(path)) {
      throw new Error(`La sortie remplacerait une source versionnée : ${path}`);
    }
  }
  await safeOutput(output);
  await safeOutput(`${output}.sha256`);
  // Generated distribution artifacts are not managed sources. Including an older
  // embedded installer would recursively bundle its previous release payload.
  const generatedInstaller = /^releases\/atelier-board-v2-to-v\d+(?:\.\d+)*\.sh(?:\.sha256)?$/;
  const selected = files.filter(path => !generatedInstaller.test(path) &&
    path !== outputRelative && path !== `${outputRelative}.sha256`);
  if (!selected.includes('package.json') || !selected.includes('server.mjs')) {
    throw new Error('Les sources Atelier Board sont incomplètes.');
  }
  const staging = await mkdtemp(join(tmpdir(), 'atelier-offline-build-'));
  try {
    const payload = join(staging, 'files');
    await mkdir(payload);
    const manifest = [];
    for (const path of selected) {
      safeSource(path);
      // Checking every ancestor also rejects an untracked directory symlink.
      let current = root;
      for (const part of path.split('/')) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Lien symbolique source interdit : ${path}`);
      }
      const stat = await lstat(join(root, path));
      if (!stat.isFile()) throw new Error(`Source non régulière : ${path}`);
      const bytes = await readFile(join(root, path));
      const mode = path.endsWith('.sh') || stat.mode & 0o111 ? '755' : '644';
      await mkdir(dirname(join(payload, path)), { recursive: true });
      await writeFile(join(payload, path), bytes, { mode: parseInt(mode, 8) });
      manifest.push(`${hash(bytes)}\t${mode}\t${path}`);
    }
    await writeFile(join(payload, manifestName), `${manifest.join('\n')}\n`, { mode: 0o644 });
    const listing = join(staging, 'archive-files');
    await writeFile(listing, [...selected, manifestName].sort().join('\n') + '\n');
    const archive = join(staging, 'payload.tar.gz');
    execFileSync('tar', ['--format=ustar', '--mtime=2026-01-01T00:00:00Z', '--owner=0', '--group=0',
      '--numeric-owner', '--no-recursion', '--verbatim-files-from', '-czf', archive, '-C', payload, '-T', listing]);
    const bytes = await readFile(archive);
    const template = await readFile(templatePath, 'utf8');
    for (const marker of ['@@TARGET_VERSION@@', '@@ARCHIVE_SHA256@@', '@@PAYLOAD_BASE64@@']) {
      if (!template.includes(marker)) throw new Error(`Marqueur absent du modèle : ${marker}`);
    }
    const script = template.replaceAll('@@TARGET_VERSION@@', pkg.version)
      .replaceAll('@@ARCHIVE_SHA256@@', hash(bytes))
      .replaceAll('@@PAYLOAD_BASE64@@', bytes.toString('base64').match(/.{1,76}/g).join('\n'));
    await mkdir(dirname(output), { recursive: true });
    await safeOutput(output);
    await safeOutput(`${output}.sha256`);
    await writeFile(output, script, { mode: 0o755 });
    await chmod(output, 0o755);
    await writeFile(`${output}.sha256`, `${hash(script)}  ${output.split('/').at(-1)}\n`, { mode: 0o644 });
    return { output, fileCount: selected.length + 1, sha256: hash(script), version: pkg.version };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || ['-h', '--help'].includes(process.argv[2])) {
    console.log('Usage : node scripts/build-offline-update.mjs [fichier-de-sortie.sh]');
    process.exit(process.argv.length > 3 ? 2 : 0);
  }
  try {
    const result = await buildOfflineUpdate(process.cwd(), process.argv[2]);
    console.log(`Mise à jour ${result.version} créée : ${result.output} (${result.fileCount} fichiers sources).`);
    console.log(`SHA-256 : ${result.sha256}`);
  } catch (error) {
    console.error(`Création impossible : ${error.message}`);
    process.exitCode = 1;
  }
}
