import { ApiError } from './security.mjs';

export const DEFAULT_CAPACITY = Object.freeze({
  maxConnections: 500,
  maxConnectionsPerBoard: 50,
  maxConnectionsPerUser: 12,
  maxActiveBoards: 100,
  maxIdleBoards: 100,
  sessionCreationsPerMinute: 120,
  invitationJoinsPerMinute: 300,
  websocketConnectionsPerMinute: 300,
});

export function normalizeCapacity(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Les limites de connexion doivent être un objet.');
  const limits = { ...DEFAULT_CAPACITY };
  for (const name of Object.keys(limits)) {
    const value = options[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} doit être un entier strictement positif.`);
    limits[name] = value;
  }
  return Object.freeze(limits);
}

export function serverBusy(message = 'Le serveur est momentanément occupé. Votre brouillon reste conservé. Réessayez dans quelques instants.') {
  return new ApiError(503, 'SERVER_BUSY', message);
}
