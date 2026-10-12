import { templates as templateOptions } from './templates.js';

/** Accessible project and guest invitation dialogs; application actions stay in api. */
export function createDialogs(api) {
  const dialog = document.getElementById('dialog');
  const content = document.getElementById('dialogContent');
  const esc = value => api.escape(String(value ?? ''));
  const icon = name => api.icon(name);
  let refreshInterval = null;
  let generation = 0;

  const clearRefresh = () => {
    if (refreshInterval !== null) clearInterval(refreshInterval);
    refreshInterval = null;
  };
  const close = () => { clearRefresh(); generation += 1; dialog.close(); };
  const run = async (action, scope) => {
    if (scope?.getAttribute('aria-busy') === 'true') return;
    const startedAt = generation;
    const controls = scope ? [...scope.querySelectorAll('button, input, select')].map(control => [control, control.disabled]) : [];
    scope?.setAttribute('aria-busy', 'true');
    controls.forEach(([control]) => { control.disabled = true; });
    const errorBox = content.querySelector('#dialogError');
    if (errorBox) errorBox.textContent = '';
    try { return await action(() => startedAt === generation && dialog.open); }
    catch (error) {
      const message = error?.message || 'Cette action n’a pas pu être effectuée.';
      api.toast(message);
      if (startedAt === generation && dialog.open) {
        const currentError = content.querySelector('#dialogError');
        if (currentError) currentError.textContent = message;
      }
    } finally {
      controls.forEach(([control, disabled]) => { control.disabled = disabled; });
      scope?.removeAttribute('aria-busy');
    }
  };
  const on = (selector, event, handler) => {
    content.querySelector(selector)?.addEventListener(event, handler);
  };
  const actionButton = (id, label, name, primary = false) => `<button type="button" id="${id}" class="button ${primary ? 'primary' : 'subtle'}">${name ? icon(name) : ''}${esc(label)}</button>`;
  const empty = label => `<p class="empty-message">${esc(label)}</p>`;
  const safeColor = value => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(String(value || '')) ? value : '#F5DBE4';
  const voteCount = object => Object.values(object.votes || {}).reduce((sum, count) => sum + (Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0), 0);
  const roleName = role => ({ owner: 'Propriétaire', editor: 'Modification', viewer: 'Lecture' })[role] || 'Modification';
  const connection = () => api.getConnection?.() || { shared: false };
  const isReadOnly = () => {
    const state = connection();
    return state.shared && (state.canEdit === false || state.role === 'viewer' || state.status === 'denied');
  };
  const recoveryNotice = () => connection().hasRecoveryDraft ? `<div class="info-box recovery-notice"><strong>Une copie locale attend votre attention.</strong><p>Certains changements n’ont pas été acceptés sur le projet partagé. Conservez-les dans un fichier avant de poursuivre.</p>${actionButton('recoverLocalDraft', 'Récupérer ma copie locale', 'download')}</div>` : '';
  const initials = name => String(name || '?').trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'date inconnue';
  const exports = prefix => `<div class="export-grid"><button type="button" id="${prefix}Json">${icon('download')}Exporter une copie JSON</button><button type="button" id="${prefix}Svg">${icon('image')}Exporter l’image SVG</button></div>`;
  const bindExports = prefix => {
    on(`#${prefix}Json`, 'click', event => run(() => api.exportBoard('json'), event.currentTarget.parentElement));
    on(`#${prefix}Svg`, 'click', event => run(() => api.exportBoard('svg'), event.currentTarget.parentElement));
  };

  async function copyUrl(url, inputId) {
    try { await navigator.clipboard.writeText(url); api.toast('Lien copié.'); }
    catch { content.querySelector(`#${inputId}`)?.select(); api.toast('Le lien est sélectionné : utilisez Copier dans le menu de votre appareil.'); }
  }

  function validateName(input) {
    const name = input.value.trim();
    if (!name) { input.setCustomValidity('Indiquez votre prénom ou votre nom.'); input.reportValidity(); return null; }
    return name;
  }

  function show(title, subtitle, body, focusSelector) {
    clearRefresh();
    generation += 1;
    content.innerHTML = `<div class="dialog-head"><div><h2 id="dialogTitle">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button type="button" id="closeDialog" class="icon-button" aria-label="Fermer">${icon('close')}</button></div><div class="dialog-body">${body}<p id="dialogError" class="dialog-error" role="alert"></p></div>`;
    dialog.setAttribute('aria-labelledby', 'dialogTitle');
    if (!dialog.open) dialog.showModal();
    on('#closeDialog', 'click', close);
    requestAnimationFrame(() => {
      if (!dialog.open) return;
      const target = content.querySelector(focusSelector || '#closeDialog');
      target?.focus();
      if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    });
  }

  dialog.addEventListener('close', () => { clearRefresh(); generation += 1; });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });

  function boards() {
    let projects = api.getProjects() || [];
    const rows = () => projects.map(project => {
      const currentId = api.getBoard()?.id;
      const count = Number.isFinite(Number(project.objectCount)) ? Number(project.objectCount) : Array.isArray(project.objects) ? project.objects.length : 0;
      let date = '';
      if (project.updatedAt && Number.isFinite(Date.parse(project.updatedAt))) date = new Date(project.updatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      const storage = project.shared ? `Partagé · ${roleName(project.role)}` : 'Dans ce navigateur';
      const canDelete = !project.shared || project.role === 'owner';
      return `<div class="project-row${project.id === currentId ? ' current' : ''}"><span class="project-icon">${icon('boards')}</span><button type="button" class="project-info" data-open="${esc(project.id)}"><strong>${esc(project.title || 'Tableau sans titre')}</strong><small>${esc(storage)}</small><small>${count} élément${count > 1 ? 's' : ''}${date ? ` · Modifié le ${esc(date)}` : ''}</small></button>${project.id === currentId ? '<span class="current-tag">Ouvert</span>' : ''}${canDelete ? `<button type="button" class="icon-button danger" data-delete="${esc(project.id)}" aria-label="Supprimer ${esc(project.title || 'ce tableau')}">${icon('trash')}</button>` : ''}</div>`;
    }).join('');
    show('Mes tableaux', 'Retrouvez vos tableaux sur cet appareil et les projets partagés que vous avez rejoints.', `<div class="board-list">${rows() || empty('Votre prochain projet commence par un tableau.')}</div><div id="deleteConfirmation" aria-live="polite"></div><div class="dialog-actions collaboration-actions">${api.refreshProjects ? actionButton('refreshProjects', 'Actualiser') : ''}${actionButton('newProject', 'Créer un tableau', 'plus', true)}</div>`);
    on('#newProject', 'click', templates);
    const refresh = scope => run(async isCurrent => {
      await api.refreshProjects();
      if (!isCurrent()) return;
      projects = api.getProjects() || [];
      const list = content.querySelector('.board-list');
      if (list.getAttribute('aria-busy') !== 'true') list.innerHTML = rows() || empty('Votre prochain projet commence par un tableau.');
    }, scope);
    on('#refreshProjects', 'click', event => refresh(event.currentTarget.parentElement));
    on('.board-list', 'click', event => {
      const openButton = event.target.closest('[data-open]');
      if (openButton) return run(async isCurrent => { await api.openProject(openButton.dataset.open); if (isCurrent()) close(); }, openButton.closest('.board-list'));
      const deleteButton = event.target.closest('[data-delete]');
      if (!deleteButton) return;
      const project = projects.find(item => item.id === deleteButton.dataset.delete);
      if (!project) return;
      const confirmation = content.querySelector('#deleteConfirmation');
      confirmation.innerHTML = `<div class="info-box"><strong>Supprimer « ${esc(project.title)} » ?</strong><br>${project.shared ? 'Le projet partagé et ses invitations seront supprimés du serveur pour toute l’équipe.' : 'Le tableau sera supprimé de ce navigateur.'} Exportez une copie si vous souhaitez le conserver.<div class="dialog-actions">${actionButton('cancelDelete', 'Garder le tableau')}${actionButton('confirmDelete', 'Supprimer', 'trash')}</div></div>`;
      on('#cancelDelete', 'click', () => { confirmation.innerHTML = ''; });
      on('#confirmDelete', 'click', () => run(async isCurrent => { await api.deleteProject(project.id); if (isCurrent()) boards(); }, confirmation));
      content.querySelector('#cancelDelete').focus();
    });
    if (api.refreshProjects && api.getSession?.()) refresh();
  }

  function templates() {
    const cards = templateOptions.map(template => `<button type="button" class="template-card ${esc(template.key)}" data-template="${esc(template.key)}"><div class="template-preview">${template.key === 'blank' ? icon('plus') : '<i></i><i></i><i></i>'}</div><strong>${esc(template.title)}</strong><p>${esc(template.description)}</p></button>`).join('');
    show('Les bonnes idées ont un début.', 'Choisissez un modèle et faites-en votre espace de travail.', `<div class="template-grid">${cards}</div>`);
    on('.template-grid', 'click', event => {
      const card = event.target.closest('[data-template]');
      if (card) run(async isCurrent => { await api.createProject(card.dataset.template); if (isCurrent()) close(); }, card.closest('.template-grid'));
    });
  }

  function share() {
    const state = connection();
    const session = api.getSession?.();
    if (!state.shared) {
      const profileName = session?.name || api.getProfile()?.name || '';
      show('Invitez votre équipe', 'Un lien, un prénom, et vos idées avancent ensemble.', `<div class="sharing-intro">${icon('userPlus')}<div><strong>Transformez ce tableau en projet partagé</strong><p>Les participants verront les mêmes post-it, dessins et votes, synchronisés en direct. Aucun compte à créer.</p></div></div><form id="publishForm"><label for="publishName">Votre prénom ou votre nom</label><input id="publishName" class="input" type="text" value="${esc(profileName === 'Vous' ? '' : profileName)}" maxlength="80" autocomplete="given-name" required><div class="info-box">Une copie de ce tableau sera enregistrée sur le serveur. La version locale reste disponible dans ce navigateur.</div><div class="dialog-actions"><button type="submit" class="button primary">${icon('share')}Activer le partage</button></div></form><div class="collaboration-divider"></div>${exports('share')}`, '#publishName');
      on('#publishName', 'input', event => event.currentTarget.setCustomValidity(''));
      on('#publishForm', 'submit', event => {
        event.preventDefault();
        const name = validateName(content.querySelector('#publishName'));
        if (!name) return;
        run(async isCurrent => { await api.publishCurrentBoard(name); if (isCurrent()) share(); }, event.currentTarget);
      });
      bindExports('share');
      return;
    }

    const owner = state.role === 'owner';
    const status = ({ synced: 'Synchronisé', readonly: 'Lecture seule', syncing: 'Synchronisation…', connecting: 'Connexion…', offline: 'Hors ligne', quota: 'Stockage limité', denied: 'Accès retiré', error: 'Connexion interrompue' })[state.status] || 'Connexion…';
    const canonical = new URL(location.href);
    canonical.hash = '';
    canonical.searchParams.set('board', api.getBoard().id);
    const invitationBody = owner ? `<form id="inviteForm" class="invitation-form"><div class="invitation-options"><div><label for="inviteRole">Accès des invités</label><select id="inviteRole" class="input"><option value="editor">Modification · créer et modifier les idées</option><option value="viewer">Lecture · consulter le tableau</option></select></div><div><label for="inviteExpiry">Validité du lien</label><select id="inviteExpiry" class="input"><option value="7">7 jours</option><option value="1">1 jour</option><option value="30">30 jours</option></select></div></div><div class="dialog-actions"><button type="submit" class="button primary">${icon('userPlus')}Créer un lien d’invitation</button></div></form><div id="generatedInvite" aria-live="polite"></div>` : `<div class="info-box">Vous avez un accès ${state.role === 'viewer' ? 'en lecture' : 'en modification'}. Pour inviter une nouvelle personne, demandez un lien d’invitation au propriétaire du projet.</div><label for="shareLink">Lien du projet pour les participants déjà invités</label><div class="share-row"><input class="input" id="shareLink" type="text" readonly value="${esc(canonical.href)}">${actionButton('copyLink', 'Copier', 'copy')}</div>`;
    show('Partager votre tableau', 'Toute personne disposant d’une invitation peut rejoindre le projet avec son prénom.', `<div class="sharing-status"><span class="access-tag">${esc(roleName(state.role))}</span><span class="muted">${esc(status)}${state.hasPending ? ' · Modifications en attente' : ''}</span></div>${recoveryNotice()}${invitationBody}<section class="collaboration-section"><h3>Les participants</h3><div id="shareMembers" class="member-list" aria-live="polite">${empty('Chargement des participants…')}</div></section>${owner ? `<section class="collaboration-section"><h3>Les invitations actives</h3><p class="section-description">Désactiver un lien empêche de nouvelles personnes de l’utiliser. Les participants déjà présents conservent leur accès.</p><div id="shareInvites" class="invite-list" aria-live="polite">${empty('Chargement des invitations…')}</div></section><details class="recovery-details"><summary>Retrouver la gestion du projet sur un autre appareil</summary><p>Votre accès est lié à ce navigateur. Ce lien privé donne les droits de propriétaire : gérer les participants, les invitations et le projet. Gardez-le pour vos propres appareils.</p>${actionButton('createRecovery', 'Créer mon lien de gestion')}<div id="recoveryInvite" aria-live="polite"></div></details>` : ''}<div class="collaboration-divider"></div>${exports('share')}`);
    bindExports('share');
    on('#recoverLocalDraft', 'click', recovery);
    on('#shareLink', 'click', event => event.currentTarget.select());
    on('#copyLink', 'click', () => copyUrl(canonical.href, 'shareLink'));

    let generatedId = null;
    let recoveryId = null;
    function displayInvite(invitation, selector, recovery = false) {
      const target = content.querySelector(selector);
      if (!target) return;
      const inputId = recovery ? 'recoveryLink' : 'invitationLink';
      const copyId = recovery ? 'copyRecovery' : 'copyInvitation';
      target.innerHTML = `<div class="generated-invite${recovery ? ' recovery-link' : ''}"><label for="${inputId}">${recovery ? 'Votre lien privé de gestion' : `Lien d’invitation · ${esc(roleName(invitation.role))}`}</label><div class="share-row"><input class="input" id="${inputId}" type="text" readonly value="${esc(invitation.url)}">${actionButton(copyId, 'Copier', 'copy')}</div><p class="section-description">Valable jusqu’au ${esc(dateLabel(invitation.expiresAt))}.${recovery ? ' Ce lien permet de gérer et supprimer le projet ; conservez-le en privé.' : ' Envoyez ce lien aux personnes que vous souhaitez inviter.'}</p></div>`;
      on(`#${inputId}`, 'click', event => event.currentTarget.select());
      on(`#${copyId}`, 'click', () => copyUrl(invitation.url, inputId));
      content.querySelector(`#${inputId}`)?.select();
    }
    function memberRows(members) {
      return members.map(member => {
        const isYou = member.isYou || member.id === session?.id;
        const editable = owner && !isYou && member.role !== 'owner';
        return `<div class="member-row" data-member-row="${esc(member.id)}"><span class="member-avatar" style="--peer-color:${safeColor(member.color)}">${esc(initials(member.name))}</span><div class="member-info"><strong>${esc(member.name || 'Participant')}${isYou ? ' <span class="muted">(vous)</span>' : ''}</strong>${!editable ? `<small>${esc(roleName(member.role))}</small>` : ''}</div>${editable ? `<select class="member-role input" data-member-role="${esc(member.id)}" aria-label="Accès de ${esc(member.name)}"><option value="editor"${member.role === 'editor' ? ' selected' : ''}>Modification</option><option value="viewer"${member.role === 'viewer' ? ' selected' : ''}>Lecture</option></select><button type="button" class="icon-button danger" data-remove-member="${esc(member.id)}" aria-label="Retirer l’accès de ${esc(member.name)}">${icon('close')}</button>` : ''}</div>`;
      }).join('') || empty('Aucun participant pour le moment.');
    }
    let members = [];
    const loadMembers = () => run(async isCurrent => {
      let updated;
      try { updated = await api.getMembers(); }
      catch (error) {
        if (isCurrent()) content.querySelector('#shareMembers').innerHTML = empty('Les participants sont indisponibles. Réouvrez le partage pour réessayer.');
        throw error;
      }
      if (!isCurrent()) return;
      members = updated;
      content.querySelector('#shareMembers').innerHTML = memberRows(members);
    });
    const loadInvites = () => run(async isCurrent => {
      let invites;
      try { invites = await api.getInvites(); }
      catch (error) {
        if (isCurrent()) content.querySelector('#shareInvites').innerHTML = empty('Les invitations sont indisponibles. Réouvrez le partage pour réessayer.');
        throw error;
      }
      if (!isCurrent()) return;
      const active = invites.filter(invitation => !invitation.revokedAt && !invitation.expired && Date.parse(invitation.expiresAt) > Date.now());
      content.querySelector('#shareInvites').innerHTML = active.map(invitation => `<div class="invite-row" data-invite-row="${esc(invitation.id)}"><div><strong>${esc(roleName(invitation.role))}${invitation.role === 'owner' ? ' · Lien privé' : ''}</strong><small>Expire le ${esc(dateLabel(invitation.expiresAt))}</small></div><button type="button" class="button subtle danger" data-revoke-invite="${esc(invitation.id)}">Désactiver</button></div>`).join('') || empty('Créez un lien pour inviter votre équipe.');
    });
    on('#inviteForm', 'submit', event => {
      event.preventDefault();
      const role = content.querySelector('#inviteRole').value;
      const days = Number(content.querySelector('#inviteExpiry').value);
      run(async isCurrent => {
        const invitation = await api.createInvite(role, days);
        if (!isCurrent()) return;
        generatedId = invitation.id;
        displayInvite(invitation, '#generatedInvite');
        await loadInvites();
      }, event.currentTarget);
    });
    on('#createRecovery', 'click', event => run(async isCurrent => {
      const invitation = await api.createInvite('owner', 30);
      if (!isCurrent()) return;
      recoveryId = invitation.id;
      displayInvite(invitation, '#recoveryInvite', true);
      await loadInvites();
    }, event.currentTarget.parentElement));
    on('#shareMembers', 'change', event => {
      const select = event.target.closest('[data-member-role]');
      if (!select) return;
      const oldRole = members.find(member => member.id === select.dataset.memberRole)?.role;
      run(async isCurrent => {
        try { await api.changeMemberRole(select.dataset.memberRole, select.value); }
        catch (error) { select.value = oldRole || 'editor'; throw error; }
        if (isCurrent()) await loadMembers();
      }, select.closest('.member-row'));
    });
    on('#shareMembers', 'click', event => {
      const remove = event.target.closest('[data-remove-member]');
      const confirm = event.target.closest('[data-confirm-member]');
      const cancel = event.target.closest('[data-cancel-member]');
      if (cancel) { cancel.closest('.member-confirm').remove(); return; }
      if (confirm) {
        return run(async isCurrent => { await api.removeMember(confirm.dataset.confirmMember); if (isCurrent()) await loadMembers(); }, confirm.closest('.member-row'));
      }
      if (!remove) return;
      const row = remove.closest('.member-row');
      if (row.querySelector('.member-confirm')) return;
      const member = members.find(item => item.id === remove.dataset.removeMember);
      const confirmation = document.createElement('div');
      confirmation.className = 'member-confirm';
      confirmation.innerHTML = `<p>Retirer l’accès de ${esc(member?.name || 'ce participant')} ? Un lien d’invitation actif lui permettra de rejoindre à nouveau.</p><div class="dialog-actions"><button type="button" class="button subtle" data-cancel-member>Annuler</button><button type="button" class="button subtle danger" data-confirm-member="${esc(remove.dataset.removeMember)}">Retirer l’accès</button></div>`;
      row.append(confirmation);
      confirmation.querySelector('[data-cancel-member]').focus();
    });
    on('#shareInvites', 'click', event => {
      const button = event.target.closest('[data-revoke-invite]');
      if (!button) return;
      run(async isCurrent => {
        await api.revokeInvite(button.dataset.revokeInvite);
        if (!isCurrent()) return;
        if (button.dataset.revokeInvite === generatedId) content.querySelector('#generatedInvite').innerHTML = empty('Ce lien a été désactivé.');
        if (button.dataset.revokeInvite === recoveryId) content.querySelector('#recoveryInvite').innerHTML = empty('Ce lien de gestion a été désactivé.');
        await loadInvites();
      }, button.closest('.invite-row'));
    });
    loadMembers();
    if (owner) loadInvites();
  }

  function invite(token) {
    const name = api.getSession?.()?.name || '';
    show('Votre équipe vous attend', 'Rejoignez le tableau avec votre prénom. Aucun compte ni mot de passe.', `<form id="joinInviteForm"><div class="sharing-intro">${icon('userPlus')}<div><strong>Un atelier, toutes vos idées.</strong><p>Une fois l’invitation acceptée, les changements du tableau seront synchronisés avec les autres participants.</p></div></div><label for="guestName">Votre prénom ou votre nom</label><input id="guestName" class="input" type="text" value="${esc(name)}" maxlength="80" autocomplete="given-name" required><p class="section-description">Votre nom sera visible par les autres participants. Votre accès sera conservé dans ce navigateur.</p><div class="dialog-actions"><button type="submit" class="button primary">Rejoindre le tableau</button></div></form>`, '#guestName');
    on('#guestName', 'input', event => event.currentTarget.setCustomValidity(''));
    on('#joinInviteForm', 'submit', event => {
      event.preventDefault();
      const name = validateName(content.querySelector('#guestName'));
      if (!name) return;
      run(async isCurrent => { await api.joinInvite(token, name); if (isCurrent()) close(); }, event.currentTarget);
    });
  }

  function participants() {
    if (!connection().shared) return share();
    const state = connection();
    const users = [...new Map((state.users || []).map(user => [user.userId || user.id || user.connectionId, user])).values()];
    show('L’équipe de ce tableau', 'Les personnes connectées travaillent sur le même projet.', `<div class="member-list">${users.map(user => {
      const isYou = (user.userId || user.id) === api.getSession?.()?.id;
      const role = user.role || (isYou ? state.role : null);
      return `<div class="member-row"><span class="member-avatar" style="--peer-color:${safeColor(user.color)}">${esc(initials(user.name))}</span><div class="member-info"><strong>${esc(user.name || 'Participant')}${isYou ? ' <span class="muted">(vous)</span>' : ''}</strong>${role ? `<small>${esc(roleName(role))}</small>` : ''}</div><span class="online-tag">En ligne</span></div>`;
    }).join('') || empty('La liste des personnes connectées apparaîtra dès que la connexion sera établie.')}</div><div class="dialog-actions">${actionButton('manageSharing', state.role === 'owner' ? 'Gérer le partage' : 'Voir le partage', 'share', true)}</div>`);
    on('#manageSharing', 'click', share);
  }

  function help() {
    const shortcuts = [
      ['Sélectionner', 'V'], ['Déplacer le tableau', 'H'],
      ['Ajouter un post-it', 'N'], ['Ajouter du texte', 'T'],
      ['Ajouter une forme', 'S'], ['Relier deux éléments', 'L'],
      ['Dessiner', 'D'], ['Ajouter une image', 'I'],
      ['Créer une zone', 'F'], ['Déplacer temporairement', 'Espace'],
      ['Annuler', 'Ctrl/Cmd + Z'], ['Rétablir', 'Ctrl/Cmd + Maj + Z'],
      ['Supprimer la sélection', 'Suppr.'], ['Voir tout le tableau', 'Maj + 1'],
      ['Déplacer la vue', 'Molette'], ['Zoomer / dézoomer', 'Ctrl/Cmd + molette'],
    ];
    show('Un peu d’aide, beaucoup d’idées.', 'Les raccourcis vous laissent plus de temps pour réfléchir.', `<div class="shortcuts">${shortcuts.map(([label, key]) => `<div class="shortcut"><span>${esc(label)}</span><kbd>${esc(key)}</kbd></div>`).join('')}</div><div class="info-box"><strong>Double-cliquez pour écrire.</strong><br>Double-cliquez sur une note pour modifier son texte. Sur un espace vide, un double-clic crée une nouvelle idée.<br><br>Pour relier deux éléments, choisissez l’outil L puis cliquez sur chacun d’eux. Déplacez les éléments pour organiser vos idées.</div>`);
  }

  function rename() {
    if (isReadOnly()) { api.toast('Vous consultez ce tableau en lecture seule.'); return; }
    show('Un nom pour vos idées', 'Retrouvez facilement votre tableau dans votre espace.', `<form id="renameForm"><label for="boardName">Nom du tableau</label><input id="boardName" class="input" type="text" value="${esc(api.getBoard()?.title || '')}" maxlength="200" required><div class="dialog-actions">${actionButton('cancelRename', 'Annuler')}<button type="submit" class="button primary">Enregistrer</button></div></form>`, '#boardName');
    on('#cancelRename', 'click', close);
    on('#renameForm', 'submit', event => {
      event.preventDefault();
      const input = content.querySelector('#boardName');
      const title = input.value.trim();
      if (!title) { input.setCustomValidity('Donnez un nom à votre tableau.'); input.reportValidity(); return; }
      run(async isCurrent => { await api.renameBoard(title); if (isCurrent()) close(); }, event.currentTarget);
    });
    on('#boardName', 'input', event => event.currentTarget.setCustomValidity(''));
  }

  function votes() {
    const notes = (api.getBoard()?.objects || []).filter(object => object.type === 'note').sort((a, b) => voteCount(b) - voteCount(a));
    const total = notes.reduce((sum, note) => sum + voteCount(note), 0);
    const active = api.isVoting();
    const results = notes.map(note => `<div class="vote-result"><span class="vote-score">${voteCount(note)}</span><button type="button" data-result="${esc(note.id)}" style="flex:1;text-align:left;padding:0"><p>${esc(note.text || 'Post-it sans texte')}</p>${Number(note.votes?.[api.getActorId()] || 0) > 0 ? '<small>Vous avez voté pour cette idée</small>' : ''}</button></div>`).join('');
    show('Les idées qui font l’unanimité', `${total} vote${total > 1 ? 's' : ''} sur ${notes.length} idée${notes.length > 1 ? 's' : ''}.`, `<div class="vote-results">${results || empty('Ajoutez des post-it pour lancer votre premier vote.')}</div><div class="info-box">${isReadOnly() ? 'Votre accès en lecture permet de consulter les résultats. Un accès en modification est nécessaire pour voter.' : active ? 'Le mode vote est actif. Cliquez sur une note du tableau pour lui donner ou retirer votre vote.' : 'Activez le mode vote, puis cliquez sur les notes que vous souhaitez soutenir.'}</div>${isReadOnly() ? '' : `<div class="dialog-actions">${actionButton('toggleVotes', active ? 'Terminer le vote' : 'Voter sur le tableau', 'thumbsUp', true)}</div>`}`);
    on('#toggleVotes', 'click', () => run(() => {
      const enabled = api.toggleVoting();
      close();
      api.toast(enabled ? 'Cliquez sur les notes pour voter.' : 'Le mode vote est terminé.');
    }));
    on('.vote-results', 'click', event => {
      const result = event.target.closest('[data-result]');
      if (result) { close(); api.focusObject(result.dataset.result); }
    });
  }

  function search() {
    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR');
    const names = { note: 'Post-it', frame: 'Zone', text: 'Texte', shape: 'Forme', connector: 'Connexion', image: 'Image', draw: 'Dessin', link: 'Lien' };
    show('Retrouver une idée', 'Cherchez dans les notes, les textes et les zones de votre tableau.', '<label for="searchQuery">Rechercher dans ce tableau</label><input id="searchQuery" class="input" type="search" placeholder="Une idée, un mot, une zone…" autocomplete="off"><div class="search-results" id="searchResults" aria-live="polite"></div>', '#searchQuery');
    const update = () => {
      const query = normalize(content.querySelector('#searchQuery').value.trim());
      const matches = (api.getBoard()?.objects || []).filter(object => object.text && (!query || normalize(object.text).includes(query))).slice(0, 60);
      content.querySelector('#searchResults').innerHTML = matches.map(object => `<button type="button" class="search-result" data-focus="${esc(object.id)}"><span class="outline-dot" style="background:${safeColor(object.color)}"></span><span>${esc(object.text)}<br><small class="muted">${esc(names[object.type] || 'Élément')}</small></span></button>`).join('') || empty(query ? 'Aucun résultat. Essayez un autre mot.' : 'Aucun texte dans ce tableau pour le moment.');
    };
    update();
    on('#searchQuery', 'input', update);
    on('#searchResults', 'click', event => {
      const result = event.target.closest('[data-focus]');
      if (result) { close(); api.focusObject(result.dataset.focus); }
    });
  }

  function timer() {
    const format = seconds => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
    const remaining = Number(api.getTimerSeconds()) || 0;
    show('Un temps pour faire émerger les idées', 'Donnez un rythme à votre atelier avec un minuteur.', `<form id="timerForm"><div class="export-grid">${[5, 10, 15].map(minutes => `<button type="button" data-minutes="${minutes}">${icon('timer')}${minutes} minutes</button>`).join('')}</div><label for="timerMinutes">Durée personnalisée</label><div class="timer-input"><input class="input" id="timerMinutes" type="number" min="1" max="120" step="1" value="5" required><span>minutes</span></div><div id="timerStatus" class="muted" aria-live="off">${remaining > 0 ? `Minuteur en cours : ${format(remaining)}` : 'Prêt quand vous l’êtes.'}</div><div class="dialog-actions">${remaining > 0 ? actionButton('stopTimer', 'Arrêter le minuteur') : ''}<button type="submit" class="button primary">${icon('play')}${remaining > 0 ? 'Relancer' : 'Démarrer'}</button></div></form>`, '#timerMinutes');
    on('.export-grid', 'click', event => {
      const preset = event.target.closest('[data-minutes]');
      if (preset) content.querySelector('#timerMinutes').value = preset.dataset.minutes;
    });
    on('#timerForm', 'submit', event => {
      event.preventDefault();
      const input = content.querySelector('#timerMinutes');
      if (!input.reportValidity()) return;
      const minutes = Number(input.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) return;
      run(() => { api.startTimer(minutes); close(); });
    });
    on('#stopTimer', 'click', () => run(() => { api.stopTimer(); close(); }));
    if (remaining > 0) refreshInterval = setInterval(() => {
      const status = content.querySelector('#timerStatus');
      if (!status) return clearRefresh();
      const seconds = Number(api.getTimerSeconds()) || 0;
      status.textContent = seconds > 0 ? `Minuteur en cours : ${format(seconds)}` : 'Le temps est écoulé.';
      if (seconds <= 0) clearRefresh();
    }, 1000);
  }

  function profile() {
    const current = api.getSession?.() || api.getProfile() || { name: '', initials: '' };
    show('Votre place dans l’atelier', 'Votre nom permet à l’équipe de reconnaître vos idées et votre curseur.', `<form id="profileForm"><label for="profileName">Votre prénom ou votre nom</label><input class="input" id="profileName" type="text" value="${esc(current.name)}" maxlength="80" required autocomplete="given-name"><div class="info-box">Aucun compte ni mot de passe. Votre identité est conservée dans ce navigateur. Votre nom est visible par les autres participants des projets partagés.</div><div class="dialog-actions">${actionButton('cancelProfile', 'Annuler')}<button type="submit" class="button primary">Enregistrer</button></div></form>`, '#profileName');
    on('#cancelProfile', 'click', close);
    on('#profileName', 'input', event => event.currentTarget.setCustomValidity(''));
    on('#profileForm', 'submit', event => {
      event.preventDefault();
      const input = content.querySelector('#profileName');
      const name = validateName(input);
      if (!name) return;
      run(async isCurrent => { await api.setProfile(name); if (isCurrent()) close(); api.toast('Votre nom a été enregistré.'); }, event.currentTarget);
    });
  }

  function more() {
    show('Les options du tableau', api.getBoard()?.title || '', `${recoveryNotice()}${exports('more')}<div class="dialog-actions" style="justify-content:flex-start;flex-wrap:wrap">${isReadOnly() ? '' : actionButton('moreRename', 'Renommer', 'text')}${actionButton('moreImport', 'Importer un tableau', 'upload')}</div><div class="info-box">${connection().shared ? 'Ce projet est enregistré sur le serveur et synchronisé avec les participants. Le statut en haut du tableau indique si des modifications attendent encore leur envoi.' : 'Les modifications s’enregistrent automatiquement dans ce navigateur.'} Exportez un fichier JSON pour conserver une copie portable de votre tableau.</div>`);
    bindExports('more');
    on('#recoverLocalDraft', 'click', recovery);
    on('#moreRename', 'click', rename);
    on('#moreImport', 'click', () => run(() => { close(); api.importBoard(); }));
  }

  function recovery() {
    const state = connection();
    if (!state.hasRecoveryDraft) return more();
    const retryNotice = state.canRetry ? '<p>La limite de stockage a été atteinte. Après avoir libéré de l’espace, vous pouvez réessayer de synchroniser ces changements. Ils restent en attente jusqu’à la confirmation du serveur.</p>' : '';
    const localNotice = state.cacheSaved ? '<strong>Votre copie est conservée sur cet appareil.</strong>' : '<strong>Votre copie reste dans cet onglet.</strong><p>Sa conservation dans le navigateur n’est pas confirmée. Exportez-la avant de fermer cet onglet.</p>';
    show('Conservez vos changements locaux', api.getBoard()?.title || '', `<div class="info-box recovery-notice">${localNotice}<p>Elle contient des changements en attente ou refusés par le serveur. Leur synchronisation avec l’équipe n’est pas confirmée.</p>${retryNotice}<p>Exportez cette copie en JSON pour conserver votre travail. Vous pourrez l’importer comme un nouveau tableau.</p><p>Les images accessibles sont intégrées au fichier. Une image devenue inaccessible est signalée comme à réajouter ; sa référence est conservée dans le fichier.</p></div><div class="dialog-actions" id="recoveryActions"><button type="button" id="exportRecovery" class="button primary">${icon('download')}Exporter ma copie locale</button>${state.canRetry ? actionButton('retrySynchronization', 'Réessayer la synchronisation') : ''}</div>`);
    on('#exportRecovery', 'click', event => run(() => api.exportRecoveryDraft(), event.currentTarget.parentElement));
    on('#retrySynchronization', 'click', event => run(async isCurrent => {
      if (!await api.retryPending()) throw new Error('Le réessai n’est plus disponible. Votre copie locale reste accessible à l’export.');
      if (isCurrent()) { close(); api.toast('Nouvel essai de synchronisation en cours.'); }
    }, event.currentTarget.parentElement));
  }

  return { boards, templates, share, invite, participants, recovery, help, rename, votes, search, timer, profile, more };
}
