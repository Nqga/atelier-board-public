import { BoardStore, LocalBoardRepository, validateBoard } from './store.js';
import { createTemplate } from './templates.js';
import { boardToSvg, downloadFile } from './export.js';
import { createDialogs } from './dialogs.js';
import { CollaborativeBoardStore } from './collab-store.js';
import { CollaborationClient } from './collaboration.js';
import { Y, boardFromDoc, decodeBase64 } from './shared-model.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localId = () => globalThis.crypto?.randomUUID?.() || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const iconPaths = {
  plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
  chevronDown:'<path d="m7 10 5 5 5-5"/>',cursor:'<path d="m5 3 15 10-7 1-3 7-5-18Z"/>',
  hand:'<path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v9c0 4-2 7-6 7h-2c-2 0-3-1-5-3l-4-5a2 2 0 0 1 3-3l2 2Z"/>',
  note:'<path d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M15 21v-6h6M7 8h10M7 12h6"/>',
  text:'<path d="M4 4h16M12 4v16M8 20h8"/>',shapes:'<circle cx="16" cy="16" r="5"/><path d="M3 3h11v11H3z"/>',
  connector:'<path d="M3 18h5V6h13m-4-4 4 4-4 4"/><circle cx="3" cy="18" r="2"/>',pen:'<path d="m15 4 5 5M4 20l4-1L21 6a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L4 21"/>',frame:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  undo:'<path d="M3 9h12a6 6 0 0 1 0 12M7 5 3 9l4 4"/>',redo:'<path d="M21 9H9a6 6 0 0 0 0 12m8-16 4 4-4 4"/>',
  boards:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  upload:'<path d="M12 16V3m-4 4 4-4 4 4M3 15v5h18v-5"/>',download:'<path d="M12 3v13m-4-4 4 4 4-4M3 15v6h18v-6"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',thumbsUp:'<path d="M7 10h-4v11h4M7 20h11a2 2 0 0 0 2-1l2-8a2 2 0 0 0-2-2h-6l1-5a2 2 0 0 0-4-1l-4 8v9Z"/>',
  timer:'<circle cx="12" cy="14" r="8"/><path d="M12 10v4l2 2M9 2h6M12 2v4m6-1 2 2"/>',sparkles:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM21 2v4m-2-2h4"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.1"/>',panel:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',fit:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 8h8v8H8z"/>',
  mouse:'<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v7M6 9h12"/>',play:'<path d="m8 4 12 8-12 8V4Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
  share:'<path d="M12 16V3m-4 4 4-4 4 4M5 10H3v11h18V10h-2"/>',userPlus:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M19 8v6m-3-3h6"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',check:'<path d="m5 12 4 4 10-10"/>',
  link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2"/>',edit:'<path d="m15 3 6 6M3 21l5-1L21 7a3 3 0 0 0-4-4L4 16l-1 5Z"/>',
  'rotate-ccw':'<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/>','columns-3':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>'
};
function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.note}</svg>`;}
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const area=$('boardArea'), world=$('world'), objectsEl=$('objects');
const colors=['#FFE79A','#F8CDE0','#CFECD8','#C9E9F5','#DFD4F4','#FFFFFF'];
const repo=new LocalBoardRepository();
const collaboration=new CollaborationClient();
const actorId=readLocal('atelier:actor-id',null)||localId();writeLocal('atelier:actor-id',actorId);
let store, selection=new Set(), tool='select', color=colors[0], shape='rectangle', editing=null, gesture=null, connectorFrom=null;
let view={x:0,y:0,scale:1}, voting=false, spaceHeld=false, clipboard=[], timerSeconds=0, timerPaused=false, timerInterval=null, minimapBounds;
let toastTimeout, storageWarned=false, profile=readLocal('atelier:profile',{name:'Vous',initials:'VO'});
let sharedStatus=null, remoteUsers=[], loadVersion=0, lastPresence=0, lastError=null, lastPointerObject=null;
const pointers=new Map();
function readLocal(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('toast').classList.remove('show'),3300);}
function getBoard(){return store.board;}
function isShared(){return store instanceof CollaborativeBoardStore;}
function canEdit(){return !isShared()||store.canEdit;}
function editable(){if(canEdit())return true;toast('Ce projet est en lecture seule.');return false;}
function getProjects(){return [...repo.list().map(b=>({...b,shared:false})),...collaboration.projects];}
function initials(name){return String(name||'Vous').trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();}
function getConnection(){return {shared:isShared(),role:isShared()?store.role:'owner',status:sharedStatus?.status,canEdit:canEdit(),hasPending:!!store?.hasPending,hasRecoveryDraft:!!store?.recoveryDraft,users:remoteUsers.map(u=>({...u,id:u.userId}))};}
function syncProfile(){if(collaboration.user)profile={name:collaboration.user.name,initials:initials(collaboration.user.name)};writeLocal('atelier:profile',profile);$('profileButton').textContent=profile.initials;$('profileButton').title=profile.name;}
function boardObjects(){return getBoard().objects;}
function selectedObjects(){return boardObjects().filter(o=>selection.has(o.id));}
function screenToWorld(x,y){const r=area.getBoundingClientRect();return{x:(x-r.left-view.x)/view.scale,y:(y-r.top-view.y)/view.scale};}
function centerPoint(){return{x:(area.clientWidth/2-view.x)/view.scale,y:(area.clientHeight/2-view.y)/view.scale};}
function getBounds(items=boardObjects()){
 const list=items.filter(o=>o.type!=='connector');if(!list.length)return{x:0,y:0,width:1200,height:800};
 const minX=Math.min(...list.map(o=>o.x||0)),minY=Math.min(...list.map(o=>(o.y||0)-(o.type==='frame'?42:0)));
 const maxX=Math.max(...list.map(o=>(o.x||0)+(o.width||200))),maxY=Math.max(...list.map(o=>(o.y||0)+(o.height||170)));
 return{x:minX,y:minY,width:Math.max(1,maxX-minX),height:Math.max(1,maxY-minY)};
}
function applyView(){
 world.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.scale})`;
 const grid=Math.max(8,20*view.scale);area.style.backgroundSize=`${grid}px ${grid}px`;area.style.backgroundPosition=`${view.x}px ${view.y}px`;
 $('zoomValue').textContent=`${Math.round(view.scale*100)} %`;drawMinimap();if(isShared())renderPresence();
}
function fit(items=boardObjects()){
 const b=getBounds(items),padding=items.length===1?130:160;
 view.scale=Math.min(1.3,Math.max(.04,Math.min((area.clientWidth-padding)/b.width,(area.clientHeight-120)/b.height)));
 view.x=area.clientWidth/2-(b.x+b.width/2)*view.scale+10;view.y=area.clientHeight/2-(b.y+b.height/2)*view.scale-5;applyView();
}
function zoom(factor,x=area.getBoundingClientRect().left+area.clientWidth/2,y=area.getBoundingClientRect().top+area.clientHeight/2){
 const point=screenToWorld(x,y),r=area.getBoundingClientRect();view.scale=Math.min(12,Math.max(.025,view.scale*factor));
 view.x=x-r.left-point.x*view.scale;view.y=y-r.top-point.y*view.scale;applyView();
}
function loadProject(board,{restore=true}={}){
 loadVersion++;if(editing)finishEditing();store?.destroy();store=new BoardStore(board,{restore,actorId});activateStore();
 writeLocal('atelier:last-board',board.id);history.replaceState(null,'',location.pathname);
}
async function loadSharedProject(meta,{version=++loadVersion}={}){
 if(version!==loadVersion)return;const next=await CollaborativeBoardStore.open(meta,{user:collaboration.user});
 if(version!==loadVersion){next.destroy();return;}
 if(editing)finishEditing();store?.destroy();store=next;activateStore();
 history.replaceState(null,'',`?board=${encodeURIComponent(store.id)}`);
}
function activateStore(){
 selection.clear();gesture=null;editing=null;sharedStatus=null;remoteUsers=[];lastError=null;
 store.subscribe((snapshot,meta)=>{if(isShared()||!(editing&&meta.source==='remote')){syncEditor(meta);renderBoard();}updateStatus();});
 if(isShared()){
   store.onBeforeRemote(captureEditorSelection);
   store.onStatus(info=>{sharedStatus=info;if(!info.canEdit&&editing)finishEditing();updateStatus();if(info.error&&info.error!==lastError){lastError=info.error;toast(info.error);}});
   store.onPresence(users=>{remoteUsers=users;renderPresence();});
 }
 if(innerWidth<=760)document.body.classList.remove('sidebar-collapsed');renderBoard();renderPresence();updateStatus();
 requestAnimationFrame(()=>{const firstFrame=boardObjects().find(o=>o.type==='frame');fit(innerWidth<=760&&firstFrame?[firstFrame]:boardObjects());});
}
function updateStatus(){
 if(!store)return;
 if(isShared()){
   const s=sharedStatus||{status:'connecting'},pending=s.hasPending;
   const labels={connecting:'Connexion…',syncing:'Synchronisation…',synced:'Synchronisé',offline:pending?'Hors ligne · en attente':'Hors ligne',readonly:'Lecture seule',denied:'Accès retiré',error:'À récupérer'};
   $('saveStatus').innerHTML=`<span style="background:${s.status==='synced'?'#60b898':s.status==='readonly'?'#9393aa':'#e99e46'}"></span>${labels[s.status]||'Connexion…'}`;
   $('saveStatus').title=s.error||(s.status==='synced'?'Modifications enregistrées sur le serveur':s.status==='readonly'?'Les modifications des autres participants apparaissent en direct':pending?(s.cacheSaved?'Copie de travail conservée dans ce navigateur ; confirmation du serveur en attente':'Confirmation du serveur en attente ; gardez cet onglet ouvert'):'Connexion au serveur en cours');
   $('saveStatus').style.cursor=store.recoveryDraft?'pointer':'';
 }else{
 const saved=store.lastSaved;
 $('saveStatus').innerHTML=`<span style="background:${saved?'#60b898':'#e99e46'}"></span>${saved?'Enregistré':'Non sauvegardé'}`;
 $('saveStatus').title=saved?'Enregistré dans ce navigateur':'Le stockage de ce navigateur est plein ou indisponible. Exportez votre tableau.';
 if(saved===false&&!storageWarned){storageWarned=true;toast('Stockage indisponible : exportez votre tableau pour le conserver.');}
 }
 document.body.classList.toggle('readonly-board',!canEdit());
 $('projectMode').textContent=isShared()?(store.role==='viewer'?'Lecture seule':'Partagé'):'Local';$('projectMode').className=`project-mode${isShared()?' shared':''}${!canEdit()?' viewer':''}`;
 $('boardTitle').disabled=!canEdit();
 document.querySelectorAll('.tool').forEach(el=>el.disabled=!canEdit()&&!['select','hand'].includes(el.dataset.tool));
 document.querySelectorAll('.note-vote').forEach(el=>el.disabled=!canEdit());
 $('undoButton').disabled=!store.canUndo;$('redoButton').disabled=!store.canRedo;
 $('boardCount').textContent=getProjects().length||1;
}
function renderPresence(){
 const users=[...new Map(remoteUsers.map(u=>[u.userId,u])).values()];$('participants').hidden=!isShared()||!users.length;
 $('participants').innerHTML=users.slice(0,4).map(u=>`<button class="presence-avatar" style="--peer-color:${/^#[0-9a-f]{6}$/i.test(u.color)?u.color:'#ed3269'}" title="${escape(u.name)}${u.userId===collaboration.user?.id?' (vous)':''}">${escape(initials(u.name))}</button>`).join('')+(users.length>4?`<button class="presence-count" title="Voir les participants">+${users.length-4}</button>`:'');
 $('remoteCursors').innerHTML=remoteUsers.filter(u=>u.userId!==collaboration.user?.id&&u.cursor&&Number.isFinite(u.cursor.x)&&Number.isFinite(u.cursor.y)).map(u=>`<div class="remote-cursor" style="transform:translate(${u.cursor.x}px,${u.cursor.y}px) scale(${1/view.scale});--peer-color:${/^#[0-9a-f]{6}$/i.test(u.color)?u.color:'#ed3269'}">${icon('cursor')}<span class="cursor-name">${escape(u.name)}</span></div>`).join('');
}
function publishPresence(cursor){if(isShared())store.updatePresence({...(cursor!==undefined?{cursor}:{}),selection:[...selection],editing:editing?.id||null});}
function renderBoard(){
 const board=getBoard();$('boardTitle').textContent=board.title;document.title=`${board.title} — Atelier`;
 let retained=editing?.el.closest('.board-object');if(editing&&!board.objects.some(o=>o.id===editing.id)){editing=null;retained=null;toast('Cet élément a été supprimé par un participant.');publishPresence();}
 for(const child of [...objectsEl.children])if(child!==retained)child.remove();let frameIndex=0;
 const sorted=[...board.objects].sort((a,b)=>(a.type==='frame'?-100:0)-(b.type==='frame'?-100:0)||(a.zIndex||0)-(b.zIndex||0));
 for(const o of sorted){
   if(o.type==='connector')continue;
   if(retained&&o.id===editing.id){retained.style.left=`${o.x}px`;retained.style.top=`${o.y}px`;retained.style.width=`${o.width}px`;retained.style.height=`${o.height}px`;if(['note','shape','frame'].includes(o.type))retained.style.background=o.color;continue;}
   const el=document.createElement('div');el.className=`board-object ${o.type} ${o.type==='shape'?escape(o.shape||'rectangle'):''}`;el.dataset.objectId=o.id;
   el.style.left=`${o.x||0}px`;el.style.top=`${o.y||0}px`;el.style.width=`${o.width||200}px`;el.style.height=`${o.height||170}px`;
   if(o.rotation)el.style.transform=`rotate(${o.rotation}deg)`;
   if(o.type==='frame'){
     frameIndex++;const accents=['#d1af6d','#b3a4c7','#88b99b'];el.style.background=o.color||'#fff';el.style.borderColor='#cbc3be';el.style.setProperty('--frame-color',accents[(frameIndex-1)%3]);
     const label=(o.text||'Nouvelle zone').replace(/^\d{2}\s+/,'');
     el.innerHTML=`<div class="frame-label"><span>${String(frameIndex).padStart(2,'0')}</span><div class="object-text">${escape(label)}</div></div>`;
   }else if(o.type==='note'){
     el.style.background=o.color||colors[0];const votes=Object.values(o.votes||{}).reduce((a,b)=>a+b,0);const voted=(o.votes||{})[store.actorId]>0;
     el.innerHTML=`<div class="object-text">${escape(o.text)}</div><div class="note-footer"><span class="note-author">${escape(o.author||profile.initials)}</span><button class="note-vote ${voted?'voted':''}" data-vote="${escape(o.id)}" title="${voted?'Retirer votre vote':'Voter pour cette idée'}" aria-label="${voted?'Retirer votre vote':'Voter pour cette idée'}">${icon('thumbsUp')}<span>${votes||''}</span></button></div>`;
   }else if(o.type==='text'||o.type==='shape'){
     if(o.type==='shape')el.style.background=o.color||colors[3];
     el.innerHTML=`<div class="object-text">${escape(o.text)}</div>`;
     const text=el.firstChild;if(o.type==='text')text.style.color=o.color||'#38313e';if(o.fontSize)text.style.fontSize=`${o.fontSize}px`;if(o.fontWeight)text.style.fontWeight=o.fontWeight;
   }else if(o.type==='image'){
     const img=document.createElement('img');img.src=o.src;img.alt=o.text||'Image du tableau';el.append(img);
   }else if(o.type==='draw'){
     const d=(o.points||[]).map((p,i)=>`${i?'L':'M'}${p.x-(o.x||0)} ${p.y-(o.y||0)}`).join(' ');
     el.innerHTML=`<svg viewBox="0 0 ${o.width||1} ${o.height||1}"><path d="${d}" fill="none" stroke="${escape(o.color||'#ed3269')}" stroke-width="${o.strokeWidth||3}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
   }else if(o.type==='link')el.innerHTML=`<div class="object-text">${icon('link')}${escape(o.text||o.url)}</div>`;
   if(selection.has(o.id)){el.classList.add('selected');if(o.type!=='draw'&&canEdit())el.insertAdjacentHTML('beforeend','<div class="resize-handle" aria-label="Redimensionner"></div>');}
   objectsEl.append(el);
   if(o.type==='note'){const text=el.querySelector('.object-text');let size=17;while(text.scrollHeight>text.clientHeight+1&&size>11){size-=.5;text.style.fontSize=`${size}px`;}}
 }
 renderConnections();renderOutline();renderInspector();drawMinimap();
 $('voteCount').textContent=board.objects.reduce((sum,o)=>sum+Object.values(o.votes||{}).reduce((a,b)=>a+b,0),0);
 updateStatus();
}
function renderConnections(){
 const list=boardObjects();const html=[];
 for(const o of list.filter(o=>o.type==='connector')){
  const from=list.find(x=>x.id===o.from),to=list.find(x=>x.id===o.to);if(!from||!to)continue;
  const a={x:from.x+from.width/2,y:from.y+from.height/2},b={x:to.x+to.width/2,y:to.y+to.height/2};
  const dx=b.x-a.x,dy=b.y-a.y;const edge=(obj,p,sign)=>{const t=Math.min((obj.width/2+7)/Math.max(.01,Math.abs(dx)),(obj.height/2+7)/Math.max(.01,Math.abs(dy)));return{x:p.x+dx*t*sign,y:p.y+dy*t*sign};};
  const start=edge(from,a,1),end=edge(to,b,-1),d=`M${start.x} ${start.y} L${end.x} ${end.y}`;
  html.push(`<path class="connection-hit" data-object-id="${escape(o.id)}" d="${d}" fill="none" stroke="transparent" stroke-width="18"/><path d="${d}" fill="none" stroke="${selection.has(o.id)?'#ed3269':'#8e8894'}" stroke-width="2" marker-end="url(#arrow)"/>`);
 }
 $('paths').innerHTML=html.join('');
}
function renderOutline(){
 const frames=boardObjects().filter(o=>o.type==='frame');
 $('boardOutline').innerHTML=frames.length?frames.map((o,i)=>`<button class="outline-item" data-focus="${escape(o.id)}"><span class="outline-dot" style="background:${['#d7bc8c','#bbaed3','#a5c4b0'][i%3]}"></span>${escape((o.text||'Zone').replace(/^\d{2}\s+/,''))}<small>${String(i+1).padStart(2,'0')}</small></button>`).join(''):'<button class="outline-item" data-action="addFrame"><span class="outline-dot" style="background:#dfd6e2"></span>Ajouter une zone</button>';
}
function renderInspector(){
 const el=$('inspector'),selected=selectedObjects();el.hidden=!selected.length||!canEdit();if(!selected.length||!canEdit())return;
 const o=selected[0];const allowColor=selected.some(x=>!['image','connector','frame'].includes(x.type));
 el.innerHTML=`${allowColor?colors.map(c=>`<button class="color-swatch ${o.color===c?'active':''}" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join('')+'<span class="inspector-divider"></span>':''}${o.type==='shape'?`<select id="shapeSelect" aria-label="Type de forme"><option value="rectangle">Rectangle</option><option value="ellipse">Cercle</option><option value="diamond">Losange</option></select>`:''}${['note','text','shape','frame'].includes(o.type)?`<button class="icon-button" data-action="edit" aria-label="Modifier le texte" title="Modifier le texte">${icon('edit')}</button>`:''}${o.type==='note'?`<button class="icon-button" data-action="vote" aria-label="Voter" title="Voter pour cette idée">${icon('thumbsUp')}</button>`:''}<button class="icon-button" data-action="duplicate" aria-label="Dupliquer" title="Dupliquer · Ctrl+D">${icon('copy')}</button><button class="icon-button danger" data-action="delete" aria-label="Supprimer" title="Supprimer · Suppr">${icon('trash')}</button>`;
 if($('shapeSelect'))$('shapeSelect').value=o.shape||'rectangle';
}
function setSelection(ids){selection=new Set(ids);renderBoard();publishPresence();}
function refreshSelection(){for(const el of objectsEl.children){const selected=selection.has(el.dataset.objectId);el.classList.toggle('selected',selected);if(!selected||!canEdit())el.querySelector('.resize-handle')?.remove();else if(!el.classList.contains('draw')&&!el.querySelector('.resize-handle'))el.insertAdjacentHTML('beforeend','<div class="resize-handle" aria-label="Redimensionner"></div>');}renderInspector();renderConnections();publishPresence();}
function setTool(next){if(!canEdit()&&!['select','hand'].includes(next)){editable();return;}if(editing)finishEditing();tool=next;connectorFrom=null;document.querySelectorAll('.tool').forEach(el=>el.classList.toggle('active',el.dataset.tool===tool));area.dataset.tool=tool;
 const hints={note:'Cliquez sur le tableau pour déposer un post-it',text:'Cliquez pour ajouter du texte',shape:'Cliquez pour ajouter une forme',connector:'Cliquez sur une première idée, puis sur une seconde',draw:'Dessinez librement sur le tableau',frame:'Cliquez pour ajouter une zone'};
 $('modeBanner').hidden=!hints[tool];$('modeBanner').textContent=hints[tool]||'';
 if(next==='image'){$('imageInput').click();setTool('select');}
}
function createObject(type,p=centerPoint()){
 if(!editable())return;
 const dimensions={note:[200,170],text:[300,70],shape:[180,140],frame:[520,400]};const [width,height]=dimensions[type]||[200,170];
 let id;try{id=store.addObject({type,x:Math.round(p.x-width/2),y:Math.round(p.y-height/2),width,height,text:type==='frame'?'Nouvelle zone':type==='note'?'Votre idée…':type==='text'?'Votre texte':'',color:type==='text'?'#38313e':type==='frame'?'#F5F1EA':color,author:profile.initials,...(type==='shape'?{shape}:{}),...(type==='note'?{votes:{}}:{})});}catch(error){toast(error.message);return;}
 selection=new Set([id]);setTool('select');renderBoard();if(type!=='shape')requestAnimationFrame(()=>beginEditing(id));return id;
}
function beginEditing(id){
 if(!editable())return;
 const obj=boardObjects().find(o=>o.id===id);if(!obj||!['note','text','shape','frame'].includes(obj.type))return;
 if(editing)finishEditing();selection=new Set([id]);renderBoard();const el=objectsEl.querySelector(`[data-object-id="${id}"] .object-text`);if(!el)return;
 let editor=el;
 if(isShared()){
   const style=getComputedStyle(el);editor=document.createElement('textarea');editor.className='object-text editor-textarea';editor.value=obj.text||'';editor.maxLength=20000;editor.setAttribute('aria-label','Texte du post-it ou de la forme');
   for(const key of ['fontFamily','fontSize','fontWeight','lineHeight','color','textAlign'])editor.style[key]=style[key];
   el.replaceWith(editor);editing={id,el:editor,shared:true,original:obj.text||''};
   editor.addEventListener('input',()=>{if(!editing||editing.el!==editor)return;try{store.replaceText(id,editor.value);}catch(error){toast(error.message);syncEditor({source:'remote'});}});
   editor.addEventListener('compositionstart',()=>{if(editing?.el===editor){editing.composing=true;store.pauseRemote();}});
   editor.addEventListener('compositionend',()=>{if(editing?.el!==editor)return;editing.composing=false;try{if(store.canEdit)store.replaceText(id,editor.value);}catch(error){toast(error.message);}finally{store.resumeRemote();}});
   editor.focus();editor.select();
 }else{
   editing={id,el,original:obj.text||''};el.contentEditable='true';el.style.cursor='text';el.focus();
   const range=document.createRange();range.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(range);
 }
 publishPresence();editor.addEventListener('blur',finishEditing,{once:true});editor.addEventListener('keydown',e=>{if(editing?.shared&&(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();captureEditorSelection();if(e.key.toLowerCase()==='y'||e.shiftKey)store.redo();else store.undo();syncEditor({source:'remote'});return;}if(e.key==='Escape'||((e.ctrlKey||e.metaKey)&&e.key==='Enter')){e.preventDefault();e.stopPropagation();finishEditing();area.focus();}});
}
function captureEditorSelection(){if(!editing?.shared)return;const text=store.getText(editing.id);if(!text)return;editing.anchor=Y.createRelativePositionFromTypeIndex(text,editing.el.selectionStart);editing.head=Y.createRelativePositionFromTypeIndex(text,editing.el.selectionEnd);editing.direction=editing.el.selectionDirection;}
function syncEditor(meta){if(!editing?.shared||meta.source!=='remote')return;const text=store.getText(editing.id);if(!text)return;const {el,anchor,head,direction}=editing;el.value=text.toString();const a=anchor&&Y.createAbsolutePositionFromRelativePosition(anchor,store.doc),b=head&&Y.createAbsolutePositionFromRelativePosition(head,store.doc);if(a&&b)el.setSelectionRange(a.index,b.index,direction||'none');}
function finishEditing(){if(!editing)return;const {id,el,original,shared}=editing;editing=null;if(shared){store.resumeRemote();store.endTextEdit();renderBoard();publishPresence();return;}const text=el.innerText.replace(/\n$/,'').slice(0,20000);el.contentEditable='false';getSelection()?.removeAllRanges();try{if(text!==original)store.updateObject(id,{text});else renderBoard();}catch(error){renderBoard();toast(error.message);}}
function vote(id){if(!editable())return;const o=boardObjects().find(o=>o.id===id);if(!o)return;const votes={...(o.votes||{})};votes[store.actorId]=votes[store.actorId]?0:1;try{store.updateObject(id,{votes});}catch(error){toast(error.message);}}
function deleteSelection(){
 if(!editable())return;
 if(!selection.size)return;const ids=new Set(selection);boardObjects().filter(o=>o.type==='connector'&&(ids.has(o.from)||ids.has(o.to))).forEach(o=>ids.add(o.id));
 selection.clear();store.batch('Supprimer',()=>ids.forEach(id=>store.removeObject(id)));renderBoard();
}
function duplicate(items=selectedObjects()){
 if(!editable())return;
 if(!items.length)return;if(boardObjects().length+items.length>3000){toast('Le tableau accepte au maximum 3 000 éléments.');return;}const mapping=new Map();const newIds=[];
 try{
 store.batch('Dupliquer',()=>{for(const o of items.filter(o=>o.type!=='connector')){const copy={...o,x:o.x+30,y:o.y+30,votes:{}};delete copy.id;if(o.type==='draw')copy.points=o.points.map(p=>({x:p.x+30,y:p.y+30}));const id=store.addObject(copy);mapping.set(o.id,id);newIds.push(id);}for(const o of items.filter(o=>o.type==='connector')){const copy={...o,from:mapping.get(o.from)||o.from,to:mapping.get(o.to)||o.to};delete copy.id;newIds.push(store.addObject(copy));}});
 selection=new Set(newIds);renderBoard();
 }catch(error){renderBoard();toast(error.message);}
}
function focusObject(id){const object=boardObjects().find(o=>o.id===id);if(!object)return;selection=new Set([id]);renderBoard();fit([object]);}
function drawMinimap(){
 const canvas=$('minimapCanvas'),ctx=canvas.getContext('2d');if(!ctx||!store)return;ctx.clearRect(0,0,360,200);
 const b=getBounds(),pad=90;const viewport={x:-view.x/view.scale,y:-view.y/view.scale,w:area.clientWidth/view.scale,h:area.clientHeight/view.scale};
 const left=Math.min(b.x-pad,viewport.x),top=Math.min(b.y-pad,viewport.y),right=Math.max(b.x+b.width+pad,viewport.x+viewport.w),bottom=Math.max(b.y+b.height+pad,viewport.y+viewport.h);
 const scale=Math.min(344/(right-left),174/(bottom-top)),ox=(360-(right-left)*scale)/2,oy=(182-(bottom-top)*scale)/2;minimapBounds={left,top,scale,ox,oy};
 for(const o of boardObjects().filter(o=>o.type!=='connector')){ctx.fillStyle=o.type==='frame'?'#f0ece8':o.type==='text'?'#d7ccd4':o.color||'#d6c4ce';ctx.fillRect(ox+(o.x-left)*scale,oy+(o.y-top)*scale,Math.max(2,o.width*scale),Math.max(2,o.height*scale));}
 ctx.fillStyle='#ed326905';ctx.strokeStyle='#ed32696b';ctx.lineWidth=1.5;const box=[ox+(viewport.x-left)*scale,oy+(viewport.y-top)*scale,viewport.w*scale,viewport.h*scale];ctx.fillRect(...box);ctx.strokeRect(...box);
}
function pointerDown(e){
 if(e.target.closest('button,input,textarea,select,[contenteditable=true],.floating-toolbar,.inspector,.canvas-top,.canvas-bottom-left,.canvas-bottom-right,.timer-widget,.exit-present'))return;
 e.preventDefault();
 if(editing)finishEditing();area.focus();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(pointers.size===2){const [a,b]=[...pointers.values()];gesture={type:'pinch',distance:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};area.setPointerCapture(e.pointerId);return;}
 const p=screenToWorld(e.clientX,e.clientY),id=e.target.closest('[data-object-id]')?.dataset.objectId,o=boardObjects().find(x=>x.id===id);
 lastPointerObject=id||null;
 area.setPointerCapture(e.pointerId);
 if(tool==='hand'||spaceHeld||e.button===1){gesture={type:'pan',sx:e.clientX,sy:e.clientY,x:view.x,y:view.y};area.classList.add('panning');return;}
 if(!canEdit()){if(o)setSelection([o.id]);else setSelection([]);gesture={type:'pan',sx:e.clientX,sy:e.clientY,x:view.x,y:view.y};return;}
 if(tool==='connector'){
   if(!o||['connector','draw'].includes(o.type))return;
   if(!connectorFrom){connectorFrom=o.id;setSelection([o.id]);$('modeBanner').textContent='Choisissez maintenant l’idée à relier';}
   else if(connectorFrom!==o.id){const source=connectorFrom;try{store.addObject({type:'connector',from:source,to:o.id,x:0,y:0,width:1,height:1,color:'#8e8894'});}catch(error){toast(error.message);}setTool('select');selection.clear();renderBoard();}return;
 }
 if(tool==='draw'){gesture={type:'draw',points:[p],color:'#b64370'};return;}
 if(['note','text','shape','frame'].includes(tool)){createObject(tool,p);return;}
 if(o){
   if(voting&&o.type==='note'){vote(o.id);return;}
   if(e.shiftKey){selection.has(id)?selection.delete(id):selection.add(id);}else if(!selection.has(id))selection=new Set([id]);
   const resize=e.target.classList.contains('resize-handle');
   let originals=selectedObjects().filter(x=>x.type!=='connector');
   if(o.type==='frame'&&!resize){const inside=boardObjects().filter(x=>x.type!=='frame'&&x.type!=='connector'&&x.x>=o.x&&x.y>=o.y&&x.x+x.width<=o.x+o.width&&x.y+x.height<=o.y+o.height);originals=[...new Map([...originals,...inside].map(x=>[x.id,x])).values()];}
   gesture={type:resize?'resize':'move',p,originals,object:o,changed:false};refreshSelection();
 }else{selection.clear();refreshSelection();gesture={type:'pan',sx:e.clientX,sy:e.clientY,x:view.x,y:view.y};area.classList.add('panning');}
}
function pointerMove(e){
 if(isShared()&&performance.now()-lastPresence>60){lastPresence=performance.now();publishPresence(screenToWorld(e.clientX,e.clientY));}
 if(pointers.has(e.pointerId))pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(!gesture)return;
 if(gesture.type==='pinch'&&pointers.size===2){const[a,b]=[...pointers.values()],dist=Math.hypot(a.x-b.x,a.y-b.y),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(gesture.distance>0)zoom(dist/gesture.distance,gesture.mid.x,gesture.mid.y);view.x+=mid.x-gesture.mid.x;view.y+=mid.y-gesture.mid.y;gesture.distance=dist;gesture.mid=mid;applyView();return;}
 if(gesture.type==='pan'){view.x=gesture.x+e.clientX-gesture.sx;view.y=gesture.y+e.clientY-gesture.sy;applyView();return;}
 const p=screenToWorld(e.clientX,e.clientY);
 if(gesture.type==='draw'){
   const previous=gesture.points.at(-1);if(Math.hypot(p.x-previous.x,p.y-previous.y)<2/view.scale)return;
   if(gesture.points.length>=10000)return;gesture.points.push(p);let path=$('liveDraw');if(!path){path=document.createElementNS('http://www.w3.org/2000/svg','path');path.id='liveDraw';path.setAttribute('fill','none');path.setAttribute('stroke',gesture.color);path.setAttribute('stroke-width','3');path.setAttribute('stroke-linecap','round');$('paths').append(path);}path.setAttribute('d',gesture.points.map((q,i)=>`${i?'L':'M'}${q.x} ${q.y}`).join(' '));return;
 }
 const dx=p.x-gesture.p.x,dy=p.y-gesture.p.y;gesture.dx=dx;gesture.dy=dy;gesture.changed=Math.abs(dx)+Math.abs(dy)>2;
 for(const o of gesture.originals){const el=objectsEl.querySelector(`[data-object-id="${o.id}"]`);if(!el)continue;
   if(gesture.type==='move'){el.style.left=`${o.x+dx}px`;el.style.top=`${o.y+dy}px`;}
   else if(o.id===gesture.object.id){el.style.width=`${Math.max(60,o.width+dx)}px`;el.style.height=`${Math.max(45,o.height+dy)}px`;}
 }
}
function pointerUp(e){
 pointers.delete(e.pointerId);area.classList.remove('panning');if(!gesture)return;const g=gesture;gesture=null;
 if(g.type==='pinch'){pointers.clear();return;}
 if(!canEdit()&&g.type!=='pan'){renderBoard();return;}
 try{
 if(g.type==='move'&&g.changed){store.batch('Déplacer',()=>g.originals.forEach(o=>store.updateObject(o.id,{x:Math.round(o.x+g.dx),y:Math.round(o.y+g.dy),...(o.type==='draw'?{points:o.points.map(p=>({x:p.x+g.dx,y:p.y+g.dy}))}:{})})));}
 else if(g.type==='resize'&&g.changed){store.updateObject(g.object.id,{width:Math.max(60,Math.round(g.object.width+g.dx)),height:Math.max(45,Math.round(g.object.height+g.dy))});}
 else if(g.type==='draw'&&g.points.length>1){const xs=g.points.map(p=>p.x),ys=g.points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);store.addObject({type:'draw',x,y,width:Math.max(1,Math.max(...xs)-x),height:Math.max(1,Math.max(...ys)-y),points:g.points,color:g.color,strokeWidth:3});renderBoard();}
 else if(g.type==='move'||g.type==='resize')refreshSelection();
 }catch(error){renderBoard();toast(error.message);}
 $('liveDraw')?.remove();
}
area.addEventListener('pointerdown',pointerDown);area.addEventListener('pointermove',pointerMove);area.addEventListener('pointerup',pointerUp);area.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);gesture=null;area.classList.remove('panning');renderBoard();});
area.addEventListener('wheel',e=>{if(e.target.closest('.inspector,.timer-widget'))return;e.preventDefault();if(e.ctrlKey||e.metaKey)zoom(Math.exp(-e.deltaY*.006),e.clientX,e.clientY);else{view.x-=e.deltaX;view.y-=e.deltaY;applyView();}},{passive:false});
area.addEventListener('pointerleave',()=>publishPresence(null));
area.addEventListener('dblclick',e=>{if(e.target.closest('button,textarea,[contenteditable=true],.floating-toolbar,.inspector,.canvas-bottom-right'))return;const id=e.target.closest('[data-object-id]')?.dataset.objectId||lastPointerObject;if(id)beginEditing(id);else createObject('note',screenToWorld(e.clientX,e.clientY));});
area.addEventListener('click',e=>{const id=e.target.closest('[data-vote]')?.dataset.vote;if(id)vote(id);});
document.querySelectorAll('.tool').forEach(el=>el.addEventListener('click',()=>setTool(el.dataset.tool)));
$('boardOutline').addEventListener('click',e=>{const id=e.target.closest('[data-focus]')?.dataset.focus;if(id)focusObject(id);else if(e.target.closest('[data-action=addFrame]'))setTool('frame');});
$('inspector').addEventListener('click',e=>{if(!editable())return;const c=e.target.closest('[data-color]')?.dataset.color;if(c){color=c;store.batch('Changer la couleur',()=>selectedObjects().forEach(o=>store.updateObject(o.id,{color:c})));return;}const action=e.target.closest('[data-action]')?.dataset.action;if(action==='edit')beginEditing([...selection][0]);if(action==='delete')deleteSelection();if(action==='duplicate')duplicate();if(action==='vote')vote([...selection][0]);});
$('inspector').addEventListener('change',e=>{if(!editable())return;if(e.target.id==='shapeSelect'){shape=e.target.value;store.updateObject([...selection][0],{shape});}});
$('minimap').addEventListener('pointerdown',e=>{if(!minimapBounds)return;e.stopPropagation();const r=$('minimapCanvas').getBoundingClientRect(),m=minimapBounds;const x=m.left+((e.clientX-r.left)*360/r.width-m.ox)/m.scale,y=m.top+((e.clientY-r.top)*200/r.height-m.oy)/m.scale;view.x=area.clientWidth/2-x*view.scale;view.y=area.clientHeight/2-y*view.scale;applyView();});
$('zoomIn').onclick=()=>zoom(1.25);$('zoomOut').onclick=()=>zoom(.8);$('zoomValue').onclick=()=>zoom(1/view.scale);$('fitButton').onclick=()=>fit();
$('undoButton').onclick=()=>{if(!editable())return;selection.clear();store.undo();};$('redoButton').onclick=()=>{if(!editable())return;selection.clear();store.redo();};
$('sidebarToggle').onclick=()=>{document.body.classList.toggle('sidebar-collapsed');setTimeout(applyView,220);};
function present(active){document.body.classList.toggle('presentation',active);$('exitPresent').hidden=!active;selection.clear();renderBoard();requestAnimationFrame(()=>fit());}
$('presentButton').onclick=()=>present(true);$('exitPresent').onclick=()=>present(false);
async function refreshProjects(){await collaboration.refreshProjects();updateStatus();return getProjects();}
async function createProject(templateKey,title){const board=createTemplate(templateKey,title);if(collaboration.available){await collaboration.ensureSession(profile.name);syncProfile();const meta=await collaboration.createBoard(board);await loadSharedProject(meta);await refreshProjects();}else{repo.save(board);loadProject(board,{restore:false});}toast('Votre nouveau tableau est prêt.');}
async function openProject(id){const local=repo.load(id);if(local){loadProject(local);return;}const version=++loadVersion;const meta=await collaboration.getBoard(id);await loadSharedProject(meta,{version});}
async function deleteProject(id){const current=getBoard().id===id;if(repo.load(id))repo.delete(id);else{await collaboration.deleteBoard(id);collaboration.projects=collaboration.projects.filter(b=>b.id!==id);}if(current){if(editing)finishEditing();const first=getProjects()[0];if(first)await openProject(first.id);else{const blank=createTemplate('blank');repo.save(blank);loadProject(blank,{restore:false});}}updateStatus();}
function blobToData(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Impossible de lire cette image.'));reader.readAsDataURL(blob);});}
async function portableBoard(input){const board=structuredClone(input);for(const o of board.objects){if(o.type==='image'&&o.src?.startsWith('/api/boards/')){const response=await fetch(o.src,{credentials:'same-origin'});if(!response.ok)throw new Error('Une image du projet est inaccessible. Reconnectez-vous avant de l’exporter.');o.src=await blobToData(await response.blob());}}return board;}
async function exportBoard(type){if(editing)finishEditing();const board=await portableBoard(getBoard()),name=board.title.replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s+/g,'-')||'atelier';if(type==='json')downloadFile(`${name}.json`,JSON.stringify({...board,schemaVersion:1},null,2),'application/json');else downloadFile(`${name}.svg`,boardToSvg(board),'image/svg+xml');toast(type==='json'?'Projet exporté : vous pourrez le réimporter.':'Votre tableau a été exporté en SVG.');}
async function exportRecoveryDraft(){
 const draft=store.recoveryDraft;if(!draft)throw new Error('Aucune copie à récupérer.');let board=draft.board;
 if(!board){const doc=new Y.Doc();try{Y.applyUpdate(doc,decodeBase64(draft.state));board=boardFromDoc(doc,store.id,{updatedAt:draft.updatedAt});}finally{doc.destroy();}}
 board=structuredClone(board);let missing=0;
 for(const object of board.objects){if(object.type==='image'&&object.src?.startsWith('/api/boards/')){
   try{const response=await fetch(object.src,{credentials:'same-origin'});if(!response.ok)throw new Error('Image indisponible');object.src=await blobToData(await response.blob());}
   catch{object.recoveryImageSource=object.src;delete object.src;object.type='text';object.text=`Image à réajouter : ${object.text||'image du projet'}`;object.color='#84738a';missing++;}
 }}
 downloadFile('atelier-copie-a-recuperer.json',JSON.stringify({...board,schemaVersion:1},null,2),'application/json');
 toast(missing?`Copie exportée. ${missing} image${missing>1?'s sont':' est'} à réajouter ; leurs emplacements sont conservés.`:'Copie de récupération exportée.');
}
async function publishCurrentBoard(name){if(editing)finishEditing();await collaboration.ensureSession(name||profile.name);syncProfile();const meta=await collaboration.createBoard(await portableBoard(getBoard()));await loadSharedProject(meta);await refreshProjects();return meta;}
function toggleVoting(){voting=!voting;$('votesButton').classList.toggle('active',voting);$('modeBanner').hidden=!voting;$('modeBanner').textContent=voting?'Mode vote : cliquez sur les idées que vous préférez':'';if(voting)setTool('select');if(voting){$('modeBanner').hidden=false;$('modeBanner').textContent='Mode vote : cliquez sur les idées que vous préférez';}return voting;}
function timerString(){return`${Math.floor(timerSeconds/60).toString().padStart(2,'0')}:${(timerSeconds%60).toString().padStart(2,'0')}`;}
function renderTimer(){const widget=$('timerWidget');widget.hidden=!timerInterval;if(!timerInterval){$('sidebarTimer').textContent='';return;}widget.innerHTML=`${icon('timer')}<strong>${timerString()}</strong><button class="icon-button" id="pauseTimer" aria-label="${timerPaused?'Reprendre':'Pause'}">${icon(timerPaused?'play':'pause')}</button><button class="icon-button" id="stopTimer" aria-label="Arrêter le minuteur">${icon('close')}</button>`;$('sidebarTimer').textContent=timerString();$('pauseTimer').onclick=()=>{timerPaused=!timerPaused;renderTimer();};$('stopTimer').onclick=stopTimer;}
function startTimer(minutes){stopTimer();timerSeconds=Math.round(minutes*60);timerPaused=false;let end=Date.now()+timerSeconds*1000,last=Date.now();timerInterval=setInterval(()=>{const now=Date.now();if(timerPaused)end+=now-last;else timerSeconds=Math.max(0,Math.ceil((end-now)/1000));last=now;if(timerSeconds<=0){stopTimer();toast('Le temps est écoulé. Place aux échanges !');}else renderTimer();},250);renderTimer();}
function stopTimer(){clearInterval(timerInterval);timerInterval=null;timerSeconds=0;renderTimer();}
const dialogs=createDialogs({getBoard,getProjects,getActorId:()=>store.actorId,icon,escape,toast,createProject,openProject,deleteProject,exportBoard,exportRecoveryDraft,importBoard:()=>$('fileInput').click(),renameBoard:title=>store.setTitle(title),focusObject,startTimer,toggleVoting,isVoting:()=>voting,getTimerSeconds:()=>timerSeconds,stopTimer,getProfile:()=>profile,
 getSession:()=>collaboration.user,getConnection,refreshProjects,publishCurrentBoard,
 ensureSession:async name=>{const user=await collaboration.ensureSession(name);syncProfile();return user;},
 createInvite:(role,days)=>collaboration.createInvite(store.id,role,days),getMembers:()=>collaboration.getMembers(store.id),
 changeMemberRole:(userId,role)=>collaboration.changeMemberRole(store.id,userId,role),removeMember:userId=>collaboration.removeMember(store.id,userId),
 getInvites:()=>collaboration.getInvites(store.id),revokeInvite:id=>collaboration.revokeInvite(store.id,id),
 joinInvite:async(token,name)=>{const meta=await collaboration.joinInvite(token,name);syncProfile();await loadSharedProject(meta);await refreshProjects();return meta;},
 setProfile:async name=>{if(collaboration.available)await collaboration.ensureSession(name);profile={name,initials:initials(name)};syncProfile();},
 copyLink:async()=>{try{await navigator.clipboard.writeText(isShared()?collaboration.projectURL(store.id):location.origin+location.pathname);return true;}catch{return false;}}
});
$('participants').onclick=()=>dialogs.participants();
$('saveStatus').onclick=()=>{if(store.recoveryDraft)dialogs.recovery();};
for(const [id,method]of Object.entries({homeButton:'boards',boardsButton:'boards',newBoardButton:'templates',templatesButton:'templates',shareButton:'share',inviteButton:'share',helpButton:'help',tipsButton:'help',hintButton:'help',boardTitle:'rename',votesButton:'votes',timerButton:'timer',profileButton:'profile',searchButton:'search',moreButton:'more'}))$(id).onclick=()=>dialogs[method]();
$('importButton').onclick=()=>$('fileInput').click();
$('fileInput').addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>20*1024*1024)throw new Error('Fichier trop volumineux (20 Mo maximum).');const board=validateBoard(JSON.parse(await file.text()));board.id=localId();board.title=`${board.title.slice(0,190)} · import`;if(collaboration.available){await collaboration.ensureSession(profile.name);syncProfile();const meta=await collaboration.createBoard(board);await loadSharedProject(meta);await refreshProjects();}else{repo.save(board);loadProject(board,{restore:false});}toast('Tableau importé dans votre espace.');$('dialog').close();}catch(error){toast(`Import impossible : ${error.message}`);}});
$('imageInput').addEventListener('change',async e=>{
 const file=e.target.files[0];e.target.value='';if(!file||!editable())return;
 if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)||file.size>5*1024*1024){toast('Choisissez une image PNG, JPEG, WebP ou GIF de moins de 5 Mo.');return;}
 const target=store;
 try{const data=await blobToData(file);const img=new Image();img.src=data;await img.decode();const ratio=Math.min(1,420/img.naturalWidth,360/img.naturalHeight),width=Math.max(1,img.naturalWidth*ratio),height=Math.max(1,img.naturalHeight*ratio),p=centerPoint();const src=isShared()?(await collaboration.uploadImage(store.id,file)).src:data;
 if(store!==target)throw new Error('Le tableau a changé pendant l’ajout. Réessayez sur le tableau souhaité.');
 const id=store.addObject({type:'image',x:p.x-width/2,y:p.y-height/2,width,height,src,text:file.name});setSelection([id]);toast('Image ajoutée au tableau.');}catch(error){toast(error.message||'Impossible de lire cette image.');}
});
document.addEventListener('keydown',e=>{
 if($('dialog').open||e.target.closest('input,textarea,select,[contenteditable=true]'))return;
 const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
 if(key===' '){e.preventDefault();spaceHeld=true;area.style.cursor='grab';return;}
 if(mod&&key==='z'){e.preventDefault();if(!editable())return;selection.clear();e.shiftKey?store.redo():store.undo();return;}
 if(mod&&key==='y'){e.preventDefault();if(editable())store.redo();return;}
 if(mod&&key==='a'){e.preventDefault();setSelection(boardObjects().map(o=>o.id));return;}
 if(mod&&key==='d'){e.preventDefault();duplicate();return;}
 if(mod&&key==='c'){if(selection.size){e.preventDefault();clipboard=structuredClone(selectedObjects());toast('Éléments copiés.');}return;}
 if(mod&&key==='v'){if(clipboard.length){e.preventDefault();duplicate(clipboard);}return;}
 if(mod&&key==='s'){e.preventDefault();exportBoard('json').catch(error=>toast(error.message));return;}
 if(key==='delete'||key==='backspace'){e.preventDefault();deleteSelection();return;}
 if(key==='escape'){selection.clear();setTool('select');present(false);renderBoard();return;}
 if(e.shiftKey&&key==='!'){e.preventDefault();fit();return;}if(e.shiftKey&&e.code==='Digit1'){e.preventDefault();fit();return;}
 if(!mod&&key==='enter'&&selection.size===1){e.preventDefault();beginEditing([...selection][0]);return;}
 if(!mod){const mapping={v:'select',h:'hand',n:'note',t:'text',s:'shape',l:'connector',d:'draw',i:'image',f:'frame'};if(mapping[key]){e.preventDefault();setTool(mapping[key]);}}
});
document.addEventListener('keyup',e=>{if(e.key===' '){spaceHeld=false;area.style.cursor='';}});window.addEventListener('blur',()=>{spaceHeld=false;gesture=null;pointers.clear();});
new ResizeObserver(()=>{applyView();}).observe(area);
window.addEventListener('beforeunload',()=>{if(editing)finishEditing();store?.save();});
$('profileButton').textContent=profile.initials;$('profileButton').title=profile.name;
const initialURL=new URL(location.href);
const last=readLocal('atelier:last-board',null);let initial=last?repo.load(last):null;if(!initial){const first=repo.list()[0];initial=first?repo.load(first.id):createTemplate('brainstorm');}loadProject(initial);setTool('select');
document.fonts.ready.then(()=>{if(!editing)renderBoard();});
async function bootCollaboration(){
 await collaboration.init();syncProfile();
 if(collaboration.user){try{await refreshProjects();}catch(error){toast(error.message);}}
 const token=new URLSearchParams(initialURL.hash.slice(1)).get('invite');
 if(token){history.replaceState(null,'',initialURL.pathname+initialURL.hash);dialogs.invite(token);return;}
 const id=initialURL.searchParams.get('board');
 if(id){if(!collaboration.user){toast('Pour rejoindre ce projet, utilisez le lien d’invitation du propriétaire.');return;}try{await openProject(id);}catch(error){toast(error.message);}}
}
bootCollaboration().catch(error=>toast(error.message));
window.atelier={getBoard,focusObject,fit,exportBoard,getConnection};
