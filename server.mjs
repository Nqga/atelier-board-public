import { createAtelierServer } from './server/atelier-server.mjs';
import { pathToFileURL } from 'node:url';

export { createAtelierServer };

function quotaEnvironment(name, multiplier = 1) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name} doit être un entier strictement positif.`);
  const result = Number(raw.trim()) * multiplier;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} dépasse la valeur maximale autorisée.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createAtelierServer({
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    dataDir: process.env.DATA_DIR || './data',
    publicUrl: process.env.PUBLIC_URL,
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
    quotas: {
      maxBoardsPerGuest: quotaEnvironment('MAX_BOARDS_PER_GUEST'),
      maxBoardBytes: quotaEnvironment('MAX_BOARD_STORAGE_MB', 1024 * 1024),
      maxStorageBytes: quotaEnvironment('MAX_TOTAL_STORAGE_MB', 1024 * 1024),
    },
  });
  const address = await app.start();
  console.log(`Atelier v2.1: ${address.url}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
