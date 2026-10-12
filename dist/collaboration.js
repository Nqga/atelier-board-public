/** Same-origin HTTP service. Access tokens stay in HttpOnly server cookies. */
export class CollaborationClient {
  constructor() { this.user = null; this.available = false; this.projects = []; }
  async request(path, { method = 'GET', body, raw = false, headers = {}, timeout = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(!raw && body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      const isJSON = response.headers.get('content-type')?.includes('application/json');
      const data = isJSON ? await response.json() : null;
      if (!response.ok || !isJSON) {
        const error = new Error(data?.message || data?.error || (response.status === 404 ? 'Le service de collaboration est indisponible sur cette adresse.' : `Cette action n’a pas pu être effectuée (${response.status}).`));
        error.status = response.status; error.code = data?.code; throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Le serveur ne répond pas. Vos modifications locales restent conservées.');
      if (error instanceof TypeError) throw new Error('Connexion au serveur interrompue. Réessayez lorsque le réseau revient.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async init() {
    const knownUser = this.user;
    try { const data = await this.request('/api/session'); this.available = data.collaboration !== false; if (this.user === knownUser) this.user = data.user || null; return this.user; }
    catch { this.available = false; return null; }
  }
  async ensureSession(name) {
    if (this.sessionPending) { await this.sessionPending; if (name && this.user?.name !== name.trim()) await this.setName(name); return this.user; }
    this.sessionPending = this._ensureSession(name);
    try { return await this.sessionPending; } finally { this.sessionPending = null; }
  }
  async _ensureSession(name) {
    if (!this.available) { await this.init(); if (!this.available) throw new Error('Le partage nécessite le serveur de collaboration. Ouvrez l’application avec son serveur V2.'); }
    if (this.user) { if (name && name.trim() !== this.user.name) await this.setName(name); return this.user; }
    const data = await this.request('/api/session', { method: 'POST', body: { name: (name || 'Vous').trim().slice(0, 80) } });
    this.user = data.user; return this.user;
  }
  async setName(name) {
    if (!this.user) return this.ensureSession(name);
    const data = await this.request('/api/session', { method: 'PATCH', body: { name: name.trim().slice(0, 80) } });
    this.user = data.user; return this.user;
  }
  async refreshProjects() {
    if (!this.user) { this.projects = []; return this.projects; }
    const data = await this.request('/api/boards');
    this.projects = (data.boards || []).map(board => ({ ...board, shared: true })); return this.projects;
  }
  async createBoard(board) { await this.ensureSession(); return this.request('/api/boards', { method: 'POST', body: { board } }); }
  getBoard(id) { return this.request(`/api/boards/${encodeURIComponent(id)}`); }
  deleteBoard(id) { return this.request(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  async createInvite(id, role = 'editor', expiresInDays = 7) {
    const data = await this.request(`/api/boards/${encodeURIComponent(id)}/invitations`, { method: 'POST', body: { role, expiresInDays } });
    return { ...data, url: `${location.origin}${location.pathname}#invite=${encodeURIComponent(data.token)}` };
  }
  async joinInvite(token, name) { await this.ensureSession(name); return this.request('/api/invitations/join', { method: 'POST', body: { token } }); }
  async getMembers(id) { return (await this.request(`/api/boards/${encodeURIComponent(id)}/members`)).members || []; }
  changeMemberRole(id, userId, role) { return this.request(`/api/boards/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } }); }
  removeMember(id, userId) { return this.request(`/api/boards/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); }
  async getInvites(id) { return (await this.request(`/api/boards/${encodeURIComponent(id)}/invitations`)).invitations || []; }
  revokeInvite(id, inviteId) { return this.request(`/api/boards/${encodeURIComponent(id)}/invitations/${encodeURIComponent(inviteId)}`, { method: 'DELETE' }); }
  uploadImage(id, file) { return this.request(`/api/boards/${encodeURIComponent(id)}/assets`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': file.type }, timeout: 30000 }); }
  projectURL(id) { return `${location.origin}${location.pathname}?board=${encodeURIComponent(id)}`; }
}
