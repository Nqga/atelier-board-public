/** Same-origin HTTP service. Access tokens stay in HttpOnly server cookies. */
export class CollaborationClient {
  constructor() { this.user = null; this.available = false; this.projects = []; this.lastError = null; this.sessionVersion = 0; this.initVersion = 0; this.sessionPending = null; }
  _clearSession() { this.user = null; this.projects = []; this.sessionVersion++; }
  _acceptSession(user) { this.user = user || null; if (!this.user) this.projects = []; this.sessionVersion++; return this.user; }
  async request(path, { method = 'GET', body, raw = false, headers = {}, timeout = 15000 } = {}) {
    const sessionVersion = this.sessionVersion;
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
        error.status = response.status; error.code = data?.code;
        if (response.status === 401 && error.code === 'SESSION_REQUIRED' && sessionVersion === this.sessionVersion) { this._clearSession(); error.sessionInvalidatedVersion = this.sessionVersion; }
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Le serveur ne répond pas. Vos modifications locales restent conservées.');
      if (error instanceof TypeError) throw new Error('Connexion au serveur interrompue. Réessayez lorsque le réseau revient.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async init() {
    const sessionVersion = this.sessionVersion, initVersion = ++this.initVersion;
    try {
      const data = await this.request('/api/session');
      if (initVersion === this.initVersion && sessionVersion === this.sessionVersion) { this.available = data.collaboration !== false; this.lastError = null; this._acceptSession(data.user); }
      return this.user;
    } catch (error) {
      if (initVersion === this.initVersion && (sessionVersion === this.sessionVersion || error.sessionInvalidatedVersion === this.sessionVersion)) { this.available = false; this.lastError = error; if (sessionVersion === this.sessionVersion) this._clearSession(); }
      return this.user;
    }
  }
  _sessionTask(action) {
    // A failed operation releases the queue without replaying it. The next
    // explicit action can create a fresh guest, with no old memberships.
    const task = (this.sessionPending || Promise.resolve()).catch(() => {}).then(action);
    const pending = task.finally(() => { if (this.sessionPending === pending) this.sessionPending = null; });
    this.sessionPending = pending;
    return pending;
  }
  ensureSession(name) { return this._sessionTask(() => this._ensureSession(name)); }
  async _ensureSession(name) {
    if (!this.available) { await this.init(); if (!this.available) throw this.lastError || new Error('Le partage nécessite le serveur de collaboration. Ouvrez l’application avec son serveur V2.'); }
    if (this.user) { if (name && name.trim() !== this.user.name) return this._setName(name); return this.user; }
    const data = await this.request('/api/session', { method: 'POST', body: { name: (name || 'Vous').trim().slice(0, 80) } });
    // A Secure cookie over HTTP, blocked cookies or a changed server address
    // can make POST succeed while every protected request still returns 401.
    // Verify once before allowing a project write; never loop creating guests.
    const verified = await this.request('/api/session');
    if (!data.user?.id || verified.user?.id !== data.user.id) {
      this._clearSession();
      const error = new Error('Votre session n’a pas été conservée. Autorisez les cookies pour cette adresse et ouvrez le lien avec la même adresse et le même protocole que le serveur.');
      error.code = 'SESSION_COOKIE_MISSING'; throw error;
    }
    this._acceptSession(verified.user); this.lastError = null; return this.user;
  }
  setName(name) { return this._sessionTask(() => this._setName(name)); }
  async _setName(name) {
    if (!this.user) return this._ensureSession(name);
    try {
      const data = await this.request('/api/session', { method: 'PATCH', body: { name: name.trim().slice(0, 80) } });
      this._acceptSession(data.user); return this.user;
    } catch (error) {
      if (error.status === 401 && error.code === 'SESSION_REQUIRED') return this._ensureSession(name);
      throw error;
    }
  }
  async refreshProjects() {
    if (!this.user) { this.projects = []; return this.projects; }
    const sessionVersion = this.sessionVersion;
    const data = await this.request('/api/boards');
    if (sessionVersion === this.sessionVersion) this.projects = (data.boards || []).map(board => ({ ...board, shared: true })); return this.projects;
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
