import { createAtelierServer } from './server/atelier-server.mjs';
import { pathToFileURL } from 'node:url';

export { createAtelierServer };

function positiveEnvironment(name, multiplier = 1) {
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
      maxBoardsPerGuest: positiveEnvironment('MAX_BOARDS_PER_GUEST'),
      maxBoardBytes: positiveEnvironment('MAX_BOARD_STORAGE_MB', 1024 * 1024),
      maxStorageBytes: positiveEnvironment('MAX_TOTAL_STORAGE_MB', 1024 * 1024),
    },
    capacity: {
      maxConnections: positiveEnvironment('MAX_CONNECTIONS'),
      maxConnectionsPerBoard: positiveEnvironment('MAX_CONNECTIONS_PER_BOARD'),
      maxConnectionsPerUser: positiveEnvironment('MAX_CONNECTIONS_PER_USER'),
      maxActiveBoards: positiveEnvironment('MAX_ACTIVE_BOARDS'),
      maxIdleBoards: positiveEnvironment('MAX_IDLE_BOARDS'),
      sessionCreationsPerMinute: positiveEnvironment('SESSION_CREATIONS_PER_MINUTE'),
      invitationJoinsPerMinute: positiveEnvironment('INVITATION_JOINS_PER_MINUTE'),
      websocketConnectionsPerMinute: positiveEnvironment('WEBSOCKET_CONNECTIONS_PER_MINUTE'),
    },
  });
  const address = await app.start();
  console.log(`Atelier v2.2: ${address.url}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
