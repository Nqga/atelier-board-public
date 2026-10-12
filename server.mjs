import { createAtelierServer } from './server/atelier-server.mjs';
import { pathToFileURL } from 'node:url';

export { createAtelierServer };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createAtelierServer({
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    dataDir: process.env.DATA_DIR || './data',
    publicUrl: process.env.PUBLIC_URL,
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  });
  const address = await app.start();
  console.log(`Atelier v2: ${address.url}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
