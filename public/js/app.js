// ── Constants ─────────────────────────────────────────────────────────────
const PROBLEM_CATEGORIES = [
  'Front tyre (flat)','Back tyre (flat)',
  'Brakes (front)','Brakes (rear)',
  'Chain (broken / slipped / worn)','Gears / derailleur',
  'Handlebars / stem','Saddle / seatpost',
  'Lights (front)','Lights (rear)',
  'Lock / key','Bell','Mudguard',
  'Basket / cargo box','Battery / motor',
  'Frame damage','Wheel (bent / broken spoke)',
  'Pedals / cranks',"Don't know",'Other',
];

const SIZE_GUIDE = {
  '48': { cm:'160–167', inch:"5'3\"–5'6\"" },
  '50': { cm:'165–172', inch:"5'5\"–5'8\"" },
  '52': { cm:'170–177', inch:"5'7\"–5'10\"" },
  '54': { cm:'175–182', inch:"5'9\"–5'11\"" },
  '56': { cm:'180–195', inch:"5'11\"–6'5\"" },
  '17"':{ cm:'165–178', inch:"5'5\"–5'10\"" },
  '19"':{ cm:'175–190', inch:"5'9\"–6'3\"" },
  'SA': { cm:'115–160', inch:"3'9\"–5'3\"" },
};

function sizeLabel(bike) {
  if (!bike) return '';
  if (bike.type_id === 'SA') { const g=SIZE_GUIDE['SA']; return `${g.cm} cm · ${g.inch}`; }
  if (bike.frame_size && SIZE_GUIDE[bike.frame_size]) {
    const g=SIZE_GUIDE[bike.frame_size];
    return `${bike.frame_size} cm · ${g.cm} cm · ${g.inch}`;
  }
  return bike.frame_size ? `Frame ${bike.frame_size}` : '';
}

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  actor: null,
  currentTab: 'today',
  bikeFilter: { type: null, status: null, search: '' },
  action: { type: null, bikes: [], searchQ: '' },
};

// ── API ───────────────────────────────────────────────────────────────────
async function api(path, opts={}) {
  const r = await fetch(path, {
    headers:{'Content-Type':'application/json'},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) { const e=await r.json().catch(()=>({error:r.statusText})); throw new Error(e.error||r.statusText); }
  return r.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type='') {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast '+type;
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),2800);
}

// ── Modal ─────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML=html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML='';
}
document.getElementById('modal-close').addEventListener('click',closeModal);
document.getElementById('modal-overlay').addEventListener('click',e=>{
  if(e.target===document.getElementById('modal-overlay')) closeModal();
});

// ── Identity ──────────────────────────────────────────────────────────────
async function initIdentity() {
  const team = await api('/api/team');
  team.sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('identity-grid').innerHTML = team.map(m=>`
    <button class="identity-btn role-${m.role}" data-id="${m.id}">
      <span class="iname">${m.name}</span>
      <span class="irole">${m.role}</span>
    </button>`).join('');
  document.getElementById('identity-grid').querySelectorAll('.identity-btn').forEach(btn=>{
    btn.addEventListener('click',()=>login(btn.dataset.id));
  });
}

async function login(actorId) {
  const data=await api('/session/login',{method:'POST',body:{actor_id:actorId}});
  state.actor=data.actor; showMain();
}

async function checkSession() {
  const data=await api('/session/me');
  if(data.actor){state.actor=data.actor;showMain();}
  else initIdentity();
}

function switchUser() {
  openModal(`<div class="modal-title">Switch user</div><div id="switch-grid" class="identity-grid" style="max-width:none;margin-top:0.5rem"></div>`);
  api('/api/team').then(team=>{
    team.sort((a,b)=>a.name.localeCompare(b.name));
    document.getElementById('switch-grid').innerHTML=team.map(m=>`
      <button class="identity-btn role-${m.role}${state.actor?.id===m.id?' active-user':''}" data-id="${m.id}">
        <span class="iname">${m.name}</span>
        <span class="irole">${m.role}</span>
      </button>`).join('');
    document.getElementById('switch-grid').querySelectorAll('.identity-btn').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        const data=await api('/session/login',{method:'POST',body:{actor_id:btn.dataset.id}});
        state.actor=data.actor;
        closeModal();
        document.getElementById('actor-badge').textContent=state.actor.name;
        buildTabbar(); renderTab('today'); checkBorrowedReminder();
      });
    });
  });
}

document.getElementById('btn-switch-user').addEventListener('click',switchUser);

// ── Borrowed reminder ─────────────────────────────────────────────────────
async function checkBorrowedReminder() {
  if(!state.actor) return;
  const todayKey=`bc_borrowed_${state.actor.id}_${new Date().toISOString().substring(0,10)}`;
  if(localStorage.getItem(todayKey)) return;
  const bikes=await api('/api/bikes?status=out');
  const borrowed=bikes.filter(b=>b.assignment_type==='borrowed'&&(b.assigned_to===state.actor.id||b.assigned_to===state.actor.name));
  if(borrowed.length===0) return;
  localStorage.setItem(todayKey,'1');
  const list=borrowed.map(b=>`<strong>${b.id}</strong>${b.name?' ('+b.name+')':''}`).join(', ');
  openModal(`
    <div style="text-align:center;padding:0.5rem 0 0">
      <div style="font-size:2.5rem;margin-bottom:0.5rem">🚲</div>
      <div class="modal-title" style="text-align:center">Did you return ${borrowed.length>1?'these bikes':'this bike'}?</div>
      <p style="font-size:0.88rem;color:var(--text2);margin-bottom:1.25rem">You have ${list} marked as borrowed.</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Not yet</button>
      <button class="btn btn-success" onclick="returnBorrowedBikes(${JSON.stringify(borrowed.map(b=>b.id))})">Yes, returned</button>
    </div>`);
}

async function returnBorrowedBikes(ids) {
  closeModal();
  for(const id of ids) await api(`/api/bikes/${id}/return`,{method:'POST',body:{new_status:'available',note:'Returned by borrower'}});
  toast(`${ids.length} bike${ids.length>1?'s':''} returned`,'success');
  renderTab(state.currentTab);
}

// ── Main ──────────────────────────────────────────────────────────────────
function showMain() {
  document.getElementById('screen-identity').classList.remove('active');
  document.getElementById('screen-identity').style.display='none';
  document.getElementById('screen-main').classList.add('active');
  document.getElementById('screen-main').style.display='flex';
  document.getElementById('actor-badge').textContent=state.actor.name;
  buildTabbar(); renderTab('today'); checkBorrowedReminder();
}

function buildTabbar() {
  const role=state.actor?.role;
  const tabs = role==='mechanic'
    ? [{id:'today',label:'Today',icon:iconHome()},{id:'tickets',label:'Tickets',icon:iconTicket()},{id:'bikes',label:'Bikes',icon:iconBike()},{id:'log',label:'Log',icon:iconLog()}]
    : [{id:'today',label:'Today',icon:iconHome()},{id:'bikes',label:'Bikes',icon:iconBike()},{id:'action',label:'Action',icon:iconAction()},{id:'log',label:'Log',icon:iconLog()}];
  document.getElementById('tabbar').innerHTML=tabs.map(t=>`
    <button class="tab-btn${t.id===state.currentTab?' active':''}" data-tab="${t.id}">
      ${t.icon}<span>${t.label}</span>
    </button>`).join('');
  document.getElementById('tabbar').querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>renderTab(btn.dataset.tab));
  });
}

function setActiveTab(id) {
  state.currentTab=id;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
}

async function renderTab(id) {
  setActiveTab(id);
  const titles={today:'Today',bikes:'All bikes',action:'Action',log:'Log',tickets:'Tickets'};
  document.getElementById('view-title').textContent=titles[id]||id;
  const c=document.getElementById('content');
  if(id==='today') await renderToday(c);
  else if(id==='bikes') await renderBikes(c);
  else if(id==='action') renderAction(c);
  else if(id==='log') await renderLog(c);
  else if(id==='tickets') await renderTickets(c);
}

// ── TODAY ─────────────────────────────────────────────────────────────────
async function renderToday(c) {
  const [avail,today]=await Promise.all([api('/api/availability'),api('/api/today')]);
  const {types}=avail;
  const scarce=new Set(['CC','E','SA','AC','AT']);
  const cards=types.map(t=>{
    const avl=t.available||0,total=t.total||0,pct=total?avl/total:0;
    const cls=pct===0?'red':pct<=0.4?'amber':'green';
    return `<div class="type-card${scarce.has(t.type_id)&&pct<=0.5?' scarce':''}${pct===0?' empty':''}" onclick="drillType('${t.type_id}')">
      <div class="tc-label">${t.label}</div>
      <div class="tc-nums"><span class="tc-avail ${cls}">${avl}</span><span class="tc-total">/ ${total}</span></div>
      <div class="tc-pips">
        ${t.out>0?`<span class="tc-pip out">${t.out} out</span>`:''}
        ${t.repair>0?`<span class="tc-pip repair">${t.repair} repair</span>`:''}
        ${(t.missing||0)>0?`<span class="tc-pip repair">${t.missing} missing</span>`:''}
      </div>
    </div>`;
  }).join('');
  const pending=today.pending||[];
  const activity=today.checkouts||[];
  c.innerHTML=`
    <div class="type-grid">${cards}</div>
    ${pending.length>0?`
      <div class="section-title">Pending assignments</div>
      ${pending.map(p=>`<div class="pending-card">
        <div class="pc-ref">#${p.fareharbor_booking_ref||'No ref'}</div>
        <div class="pc-name">${p.customer_name||'Unknown'}</div>
        <div class="pc-time">${p.booking_date||''} ${p.start_time||''}</div>
        <div class="pc-action"><button class="btn btn-sm btn-primary" onclick="renderTab('action')">Assign bikes</button></div>
      </div>`).join('')}`:''}
    <div class="section-title">Today's activity</div>
    ${activity.length===0
      ?'<div style="text-align:center;padding:1.5rem 0;color:var(--text3);font-size:0.88rem">No activity yet today</div>'
      :activity.slice(0,25).map(a=>{
        const d=JSON.parse(a.details||'{}');
        const who=d.customer_name||d.assigned_to||'';
        const ic=a.action==='checkout'?'out':a.action==='repair_ticket'?'issue':a.action==='city'?'city':'ret';
        const lb=a.action==='checkout'?'OUT':a.action==='repair_ticket'?'FIX':a.action==='city'?'PIN':'RTN';
        return `<div class="activity-row">
          <div class="ar-icon ${ic}">${lb}</div>
          <div class="ar-body">
            <div class="ar-main">${a.bike_id||''} ${who?'· '+who:''}</div>
            <div class="ar-sub">${a.actor} · ${fmtTime(a.created_at)}</div>
          </div>
        </div>`;
      }).join('')}`;
}

async function drillType(typeId) {
  const bikes=await api(`/api/bikes?type=${typeId}`);
  openModal(`
    <div class="modal-title">${bikes[0]?.type_label||typeId}</div>
    <div class="bike-list">
      ${bikes.map(b=>`
        <div class="bike-row status-${b.status}" onclick="closeModal();showBike('${b.id}')">
          <span class="br-id">${b.id}</span>
          <div class="br-info">
            <div class="br-name">${b.name||''}</div>
            <div class="br-detail">${sizeLabel(b)}</div>
          </div>
          <div class="br-status">${statusBadge(b.status)}</div>
        </div>`).join('')||'<div style="text-align:center;padding:1rem;color:var(--text3)">No bikes</div>'}
    </div>`);
}

// ── BIKES ─────────────────────────────────────────────────────────────────
async function renderBikes(c) {
  const types=await api('/api/availability').then(d=>d.types);
  c.innerHTML=`
    <div class="search-bar">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="bike-search" placeholder="Search ID, name, customer..." value="${state.bikeFilter.search}"/>
    </div>
    <div class="chip-row" id="type-chips">
      <span class="chip${!state.bikeFilter.type?' active':''}" data-type="">All</span>
      ${types.map(t=>`<span class="chip${state.bikeFilter.type===t.type_id?' active':''}" data-type="${t.type_id}">${t.type_id}</span>`).join('')}
    </div>
    <div class="chip-row" id="status-chips">
      <span class="chip${!state.bikeFilter.status?' active':''}" data-status="">All</span>
      <span class="chip${state.bikeFilter.status==='available'?' active':''}" data-status="available">Available</span>
      <span class="chip${state.bikeFilter.status==='out'?' active':''}" data-status="out">Out</span>
      <span class="chip${state.bikeFilter.status==='repair'?' active':''}" data-status="repair">Repair</span>
      <span class="chip${state.bikeFilter.status==='missing'?' active':''}" data-status="missing">Missing</span>
    </div>
    <div id="bike-results"><div class="empty-state"><p>Loading...</p></div></div>`;
  const load=async()=>{
    const p=new URLSearchParams();
    if(state.bikeFilter.type) p.set('type',state.bikeFilter.type);
    if(state.bikeFilter.status) p.set('status',state.bikeFilter.status);
    if(state.bikeFilter.search) p.set('search',state.bikeFilter.search);
    const bikes=await api('/api/bikes?'+p);
    const el=document.getElementById('bike-results');
    if(!el) return;
    el.innerHTML=bikes.length===0
      ?'<div class="empty-state"><p>No bikes match</p></div>'
      :`<div class="bike-list">${bikes.map(b=>`
        <div class="bike-row status-${b.status}" onclick="showBike('${b.id}')">
          <span class="br-id">${b.id}</span>
          <div class="br-info">
            <div class="br-name">${b.name||b.type_label||''}</div>
            <div class="br-detail">${b.customer_name?'With: '+b.customer_name:sizeLabel(b)}</div>
          </div>
          <div class="br-status">${statusBadge(b.status)}${b.open_tickets>0?` <span class="badge badge-repair">${b.open_tickets} issue</span>`:''}</div>
        </div>`).join('')}</div>`;
  };
  c.querySelectorAll('#type-chips .chip').forEach(ch=>ch.addEventListener('click',()=>{
    state.bikeFilter.type=ch.dataset.type;
    c.querySelectorAll('#type-chips .chip').forEach(x=>x.classList.toggle('active',x===ch)); load();
  }));
  c.querySelectorAll('#status-chips .chip').forEach(ch=>ch.addEventListener('click',()=>{
    state.bikeFilter.status=ch.dataset.status;
    c.querySelectorAll('#status-chips .chip').forEach(x=>x.classList.toggle('active',x===ch)); load();
  }));
  let t;
  c.querySelector('#bike-search').addEventListener('input',e=>{
    state.bikeFilter.search=e.target.value; clearTimeout(t); t=setTimeout(load,280);
  });
  load();
}

// ── BIKE DETAIL ───────────────────────────────────────────────────────────
async function showBike(id) {
  const b=await api(`/api/bikes/${id}`);
  const sl=sizeLabel(b);
  const banner=b.status!=='available'?`<div class="status-banner ${b.status}">
    ${b.status==='out'?`Out with ${b.customer_name||b.assigned_to||'unknown'} · ${b.assignment_type||''}${b.out_since?' · since '+fmtTime(b.out_since):''}${b.fareharbor_booking_ref?' · #'+b.fareharbor_booking_ref:''}`:
      b.status==='repair'?`In repair${b.note?': '+b.note:''}`:
      b.status==='missing'?`Missing${b.note?': '+b.note:''}`:
      b.status==='city'?`Left in city${b.note?': '+b.note:''}${b.location_address?' · '+b.location_address:''}`:b.status}
  </div>`:'';
  const log=(b.log||[]).slice(0,5).map(l=>`
    <div class="detail-row">
      <span class="dr-key" style="font-size:0.72rem">${fmtTime(l.created_at)} · ${l.actor}</span>
      <span class="dr-val" style="font-size:0.72rem">${l.action}</span>
    </div>`).join('')||'<div class="detail-row"><span class="dr-key">No history</span></div>';
  openModal(`
    <div class="bike-detail-header">
      <div>
        <div class="bike-detail-id">${b.id}</div>
        <div class="bike-detail-name">${b.name||''}</div>
        <div class="bike-detail-meta">${b.type_label||''}</div>
        ${sl?`<div style="font-size:0.78rem;color:var(--red);font-weight:500;margin-top:3px">${sl}</div>`:''}
      </div>
      <div style="margin-left:auto;padding-top:4px">${statusBadge(b.status)}</div>
    </div>
    ${banner}
    <div class="detail-section" style="padding-top:0;border-top:none">
      ${b.frame_number?`<div class="detail-row"><span class="dr-key">Frame</span><span class="dr-val">${b.frame_number}</span></div>`:''}
      ${b.model?`<div class="detail-row"><span class="dr-key">Model</span><span class="dr-val">${b.model}</span></div>`:''}
      ${b.key_number?`<div class="detail-row"><span class="dr-key">Key</span><span class="dr-val">${b.key_number}</span></div>`:''}
      ${b.notes?`<div class="detail-row"><span class="dr-key">Notes</span><span class="dr-val" style="max-width:60%;text-align:right;font-size:0.8rem">${b.notes}</span></div>`:''}
    </div>
    <div class="detail-section"><div class="detail-section-title">Recent activity</div>${log}</div>
    <div class="detail-section" style="border-top:none">
      <button class="btn btn-primary btn-full" onclick="closeModal();renderTab('action');setTimeout(()=>preloadActionBike('${b.id}'),80)">
        Do something with this bike
      </button>
    </div>`);
}

// ── ACTION TAB ────────────────────────────────────────────────────────────
// New flow: action first → bikes → details → submit

const ACTION_TYPES = [
  { id:'return',       emoji:'✅', label:'Return',        sub:'Mark bikes back in shop',   multi:true  },
  { id:'rental',       emoji:'🚲', label:'Rental',        sub:'Customer walk-in or online', multi:true  },
  { id:'tour',         emoji:'🗺️', label:'Group tour',    sub:'Guide takes the fleet out',  multi:true  },
  { id:'private_tour', emoji:'⭐', label:'Private tour',  sub:'Assigned bikes for a group', multi:true  },
  { id:'borrowed',     emoji:'🤝', label:'Borrowed',      sub:'Staff personal use',         multi:false },
  { id:'city',         emoji:'📍', label:'Left in city',  sub:'Broke down on tour',         multi:false },
  { id:'ticket',       emoji:'🔧', label:'Report issue',  sub:'Repair ticket',              multi:false },
  { id:'missing',      emoji:'❓', label:'Missing',       sub:"Can't find it",              multi:false },
];

function renderAction(c) {
  state.action = { type: null, bikes: [], searchQ: '' };
  c.innerHTML = `
    <div class="section-title" style="margin-top:0">What are you doing?</div>
    <div class="action-type-list" id="action-type-list">
      ${ACTION_TYPES.map(a=>`
        <button class="action-type-btn" data-action="${a.id}" onclick="selectActionType('${a.id}')">
          <span class="atb-emoji">${a.emoji}</span>
          <div class="atb-text">
            <span class="atb-label">${a.label}</span>
            <span class="atb-sub">${a.sub}</span>
          </div>
          <svg class="atb-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`).join('')}
    </div>`;
}

async function selectActionType(actionId) {
  state.action.type = actionId;
  state.action.bikes = [];
  const def = ACTION_TYPES.find(a=>a.id===actionId);
  const c = document.getElementById('content');

  // Load bikes for the picker
  let bikes = await api('/api/bikes');

  c.innerHTML = `
    <button class="back-btn" onclick="renderAction(document.getElementById('content'))">
      ← Back
    </button>
    <div class="action-header">
      <span class="action-header-emoji">${def.emoji}</span>
      <div>
        <div class="action-header-label">${def.label}</div>
        <div class="action-header-sub">${def.sub}</div>
      </div>
    </div>

    ${renderActionDetails(actionId)}

    <div class="section-title">Bikes${def.multi?' (add as many as needed)':''}</div>
    <div class="bike-adder">
      <div class="bike-adder-input-row">
        <input class="form-input" id="bike-adder-input" placeholder="Type bike ID..." autocapitalize="characters" autocomplete="off"/>
        <button class="btn btn-secondary btn-sm" onclick="addBikeById()">Add</button>
      </div>
      <button class="voice-btn" id="voice-btn" onclick="startVoiceRecording(state.action.type)">
        🎤 <span>Tap to speak bike IDs</span>
      </button>
      <div class="voice-transcript" id="voice-transcript"></div>
      <div class="bike-adder-tags" id="bike-adder-tags"></div>
    </div>

    <div class="bike-quick-list" id="bike-quick-list">
      ${bikes.map(b=>`
        <div class="bql-item${state.action.bikes.includes(b.id)?' selected':''}" id="bql-${b.id}" onclick="toggleBike('${b.id}','${b.name||''}','${b.status}')">
          <span class="bql-id">${b.id}</span>
          <div class="bql-info">
            <span class="bql-name">${b.name||b.type_label||''}</span>
            <span class="bql-size">${sizeLabel(b)}</span>
          </div>
          <span class="bql-status">${statusBadge(b.status)}</span>
        </div>`).join('')}
    </div>

    <div id="action-submit-area" style="padding:1rem 0 0.5rem">
      <button class="btn btn-primary btn-full" onclick="submitActionNew()" id="action-submit-btn" disabled>
        ${submitLabel(actionId, 0)}
      </button>
    </div>`;

  const input = document.getElementById('bike-adder-input');
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter'||e.key===','){e.preventDefault();addBikeById();}
  });

  // Filter quick list on input
  let t;
  input.addEventListener('input', e=>{
    state.action.searchQ = e.target.value;
    clearTimeout(t); t=setTimeout(()=>filterQuickList(e.target.value, bikes),150);
  });
}

function renderActionDetails(actionId) {
  if(actionId==='return') return `
    <div class="action-details-card">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Condition</label>
        <select class="form-select" id="af-ret-status">
          <option value="available">All good — available</option>
          <option value="repair">Needs repair</option>
        </select>
      </div>
    </div>`;

  if(actionId==='rental') return `
    <div class="action-details-card">
      <div class="form-group">
        <label class="form-label">Customer name</label>
        <input class="form-input" id="af-name" placeholder="Name"/>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Return due (optional)</label>
        <input class="form-input" id="af-due" type="datetime-local"/>
      </div>
    </div>`;

  if(actionId==='tour') return `
    <div class="action-details-card">
      <div class="form-group">
        <label class="form-label">Guide</label>
        <input class="form-input" id="af-name" value="${state.actor?.name||''}" placeholder="Guide name"/>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Tour (optional)</label>
        <select class="form-select" id="af-tour-type">
          <option value="">— select —</option>
          <option>A3 Architecture</option>
          <option>L3 History</option>
          <option>F3 Food</option>
          <option>H3 New History</option>
          <option>Other</option>
        </select>
      </div>
    </div>`;

  if(actionId==='private_tour') return `
    <div class="action-details-card">
      <div class="form-group">
        <label class="form-label">Customer name</label>
        <input class="form-input" id="af-name" placeholder="Name"/>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">FareHarbor booking ref (optional)</label>
        <input class="form-input" id="af-ref" placeholder="#355712615"/>
      </div>
    </div>`;

  if(actionId==='borrowed') return `
    <div class="action-details-card">
      <div class="form-group">
        <label class="form-label">Borrowed by</label>
        <input class="form-input" id="af-name" value="${state.actor?.name||''}" placeholder="Name"/>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Reason (optional)</label>
        <input class="form-input" id="af-note" placeholder="Own bike broken, tour, etc."/>
      </div>
    </div>`;

  if(actionId==='city') return `
    <div class="action-details-card">
      <div class="form-group">
        <label class="form-label">Location / address</label>
        <input class="form-input" id="af-address" placeholder="e.g. Nørreport Station"/>
        <button class="btn btn-secondary btn-sm btn-full" style="margin-top:0.4rem" onclick="useMyLocation()">📍 Use my GPS location</button>
        <div id="af-coords" style="font-size:0.72rem;color:var(--text3);margin-top:4px;text-align:center"></div>
      </div>
      <div class="form-group" style="margin-bottom:0">
        ${problemCategoryCheckboxes()}
      </div>
    </div>`;

  if(actionId==='ticket') return `
    <div class="action-details-card">
      ${problemCategoryCheckboxes()}
      <div class="form-group" style="margin-top:0.5rem;margin-bottom:0.25rem">
        <label class="form-label">Extra details</label>
        <textarea class="form-textarea" id="af-note" placeholder="Optional extra info..." style="min-height:60px"></textarea>
      </div>
      <div class="toggle-row" style="padding:0.4rem 0 0">
        <span class="toggle-label">Can still be rented out?</span>
        <label class="toggle"><input type="checkbox" id="af-can-rent"/><span class="toggle-track"></span></label>
      </div>
    </div>`;

  if(actionId==='missing') return `
    <div class="action-details-card">
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Details (optional)</label>
        <input class="form-input" id="af-note" placeholder="Who last had it, when..."/>
      </div>
    </div>`;

  return '';
}

function submitLabel(actionId, count) {
  const n = count > 0 ? ` ${count} bike${count>1?'s':''}` : '';
  const labels = {
    return:`Return${n}`, rental:`Check out${n}`, tour:`Start tour${n}`,
    private_tour:`Assign${n}`, borrowed:`Mark borrowed${n}`,
    city:'Mark left in city', ticket:'Create repair ticket', missing:'Mark missing',
  };
  return labels[actionId]||'Submit';
}

function toggleBike(id, name, currentStatus) {
  const def = ACTION_TYPES.find(a=>a.id===state.action.type);
  if(!def) return;

  // Warn if already out and checking out again
  const isCheckout = ['rental','tour','private_tour','borrowed','city'].includes(state.action.type);
  if(isCheckout && currentStatus==='out' && !state.action.bikes.includes(id)) {
    if(!confirm(`${id} is already marked as out. Add anyway?`)) return;
  }

  if(state.action.bikes.includes(id)) {
    state.action.bikes = state.action.bikes.filter(x=>x!==id);
  } else {
    if(!def.multi) state.action.bikes = []; // single-bike actions replace
    state.action.bikes.push(id);
  }
  refreshBikeAdder();
  updateQuickListSelection();
  updateSubmitBtn();
}

function addBikeById() {
  const input = document.getElementById('bike-adder-input');
  const raw = input.value.trim().toUpperCase().replace(/,/g,'');
  if(!raw) return;
  toggleBike(raw, '', '');
  input.value = '';
  input.focus();
  filterQuickList('', null);
}

function filterQuickList(q, bikes) {
  const items = document.querySelectorAll('.bql-item');
  items.forEach(el=>{
    const id = el.querySelector('.bql-id').textContent;
    const name = el.querySelector('.bql-name').textContent.toLowerCase();
    const match = !q || id.toLowerCase().includes(q.toLowerCase()) || name.includes(q.toLowerCase());
    el.style.display = match ? '' : 'none';
  });
}

function updateQuickListSelection() {
  document.querySelectorAll('.bql-item').forEach(el=>{
    const id = el.querySelector('.bql-id').textContent;
    el.classList.toggle('selected', state.action.bikes.includes(id));
  });
}

function refreshBikeAdder() {
  const tags = document.getElementById('bike-adder-tags');
  if(!tags) return;
  tags.innerHTML = state.action.bikes.map(id=>`
    <span class="return-tag">${id}
      <span class="return-tag-remove" onclick="toggleBike('${id}','','')">&times;</span>
    </span>`).join('');
}

function updateSubmitBtn() {
  const btn = document.getElementById('action-submit-btn');
  if(!btn) return;
  const count = state.action.bikes.length;
  const def = ACTION_TYPES.find(a=>a.id===state.action.type);
  const needsBikes = true; // all actions need at least one bike
  btn.disabled = count === 0;
  btn.textContent = submitLabel(state.action.type, count);
}

function useMyLocation() {
  if(!navigator.geolocation){toast('Geolocation not supported','error');return;}
  navigator.geolocation.getCurrentPosition(pos=>{
    const {latitude:lat,longitude:lng}=pos.coords;
    const el=document.getElementById('af-coords');
    if(el) el.textContent=`${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    state.action.location={lat,lng};
  },()=>toast('Could not get location','error'));
}

async function submitActionNew() {
  const {type, bikes} = state.action;
  if(!type||bikes.length===0){toast('Pick at least one bike','error');return;}
  const actor = state.actor?.id||'unknown';

  try {
    for(const bikeId of bikes) {
      if(type==='return') {
        const newStatus = document.getElementById('af-ret-status')?.value||'available';
        await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:newStatus}});

      } else if(['rental','tour','private_tour'].includes(type)) {
        const name = document.getElementById('af-name')?.value?.trim();
        const due = document.getElementById('af-due')?.value;
        const ref = document.getElementById('af-ref')?.value?.trim();
        const tourType = document.getElementById('af-tour-type')?.value;
        const note = tourType||'';
        await api(`/api/bikes/${bikeId}/checkout`,{method:'POST',body:{
          assignment_type: type, customer_name: name, assigned_to: name||actor,
          return_due: due, fareharbor_booking_ref: ref, note, force:true
        }});

      } else if(type==='borrowed') {
        const name = document.getElementById('af-name')?.value?.trim();
        const note = document.getElementById('af-note')?.value?.trim();
        await api(`/api/bikes/${bikeId}/checkout`,{method:'POST',body:{
          assignment_type:'borrowed', customer_name:name, assigned_to:name||actor, note, force:true
        }});

      } else if(type==='city') {
        const address = document.getElementById('af-address')?.value?.trim();
        const cats = getSelectedProblems();
        const loc = state.action.location;
        const note = cats.join(', ');
        await api(`/api/bikes/${bikeId}/city`,{method:'POST',body:{
          note, location_address:address,
          location_lat:loc?.lat||null, location_lng:loc?.lng||null,
          problem_categories:cats, create_ticket:true, force:true
        }});

      } else if(type==='ticket') {
        const cats = getSelectedProblems();
        const note = document.getElementById('af-note')?.value?.trim();
        const canRent = document.getElementById('af-can-rent')?.checked?1:0;
        const problem=[cats.join(', '),note].filter(Boolean).join(' — ')||'Issue reported';
        await api('/api/repairs',{method:'POST',body:{
          bike_id:bikeId, problem, problem_categories:JSON.stringify(cats), can_rent:canRent
        }});
        if(!canRent) await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:'repair',note:problem}});

      } else if(type==='missing') {
        const note = document.getElementById('af-note')?.value?.trim();
        await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:'missing',note}});
      }
    }

    const label = submitLabel(type, bikes.length);
    toast(`Done — ${label.toLowerCase()}`, 'success');
    renderAction(document.getElementById('content'));

  } catch(e) { toast(e.message,'error'); }
}

function problemCategoryCheckboxes() {
  return `
    <div class="form-label" style="margin-bottom:0.5rem">What's wrong?</div>
    <div class="problem-grid">
      ${PROBLEM_CATEGORIES.map(p=>`
        <label class="problem-chip">
          <input type="checkbox" name="problem_cat" value="${p}"/>
          <span>${p}</span>
        </label>`).join('')}
    </div>`;
}

function getSelectedProblems() {
  return Array.from(document.querySelectorAll('input[name="problem_cat"]:checked')).map(el=>el.value);
}

function preloadActionBike(id) {
  toggleBike(id,'','');
}

// ── TICKETS ───────────────────────────────────────────────────────────────
async function renderTickets(c) {
  const tickets=await api('/api/repairs?status=open');
  c.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.85rem">
      <div class="section-title" style="margin:0">${tickets.length} open ticket${tickets.length!==1?'s':''}</div>
    </div>
    ${tickets.length===0
      ?'<div class="empty-state"><p>No open repair tickets 🎉</p></div>'
      :tickets.map(t=>{
        const cats=JSON.parse(t.problem_categories||'[]');
        const age=Math.floor((Date.now()-new Date(t.created_at+'Z').getTime())/3600000);
        const pc=age>48?'priority-high':age>24?'priority-mid':'priority-low';
        return `<div class="ticket-card ${pc}">
          <div class="tk-header">
            <span class="tk-bike">${t.bike_id}</span>
            <span class="tk-rentable ${t.can_rent?'yes':'no'}">${t.can_rent?'Can rent':'Off fleet'}</span>
          </div>
          ${cats.length>0?`<div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.35rem">
            ${cats.map(c=>`<span style="font-size:0.7rem;background:var(--red-light);color:var(--red);border-radius:20px;padding:1px 8px;font-weight:500">${c}</span>`).join('')}
          </div>`:''}
          <div class="tk-problem">${t.problem}</div>
          <div class="tk-meta">Reported by ${t.reported_by} · ${fmtTime(t.created_at)} · ${age}h ago</div>
          <div style="margin-top:0.6rem;display:flex;gap:0.5rem">
            <button class="btn btn-sm btn-success" onclick="resolveTicket(${t.id},'${t.bike_id}')">Mark resolved</button>
            <button class="btn btn-sm btn-secondary" onclick="showBike('${t.bike_id}')">View bike</button>
          </div>
        </div>`;
      }).join('')}`;
}

async function resolveTicket(ticketId,bikeId) {
  openModal(`
    <div class="modal-title">Resolve ticket</div>
    <div class="form-group">
      <label class="form-label">What did you fix?</label>
      <textarea class="form-textarea" id="res-note" placeholder="Describe what was done..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Set bike status to</label>
      <select class="form-select" id="res-status">
        <option value="available">Available</option>
        <option value="repair">Still in repair</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-success" onclick="submitResolve(${ticketId},'${bikeId}')">Resolve</button>
    </div>`);
}

async function submitResolve(ticketId,bikeId) {
  const note=document.getElementById('res-note')?.value?.trim();
  const status=document.getElementById('res-status')?.value;
  try {
    await api(`/api/repairs/${ticketId}/resolve`,{method:'POST',body:{resolution_note:note,new_bike_status:status}});
    closeModal(); toast('Ticket resolved','success'); await renderTab('tickets');
  } catch(e){toast(e.message,'error');}
}

// ── LOG ───────────────────────────────────────────────────────────────────
async function renderLog(c) {
  const log=await api('/api/log?limit=80');
  const iconMap={checkout:'out',return:'ret',bulk_return:'ret',repair_ticket:'issue',city:'city'};
  const labelMap={checkout:'OUT',return:'RTN',bulk_return:'RTN',repair_ticket:'FIX',city:'PIN'};
  c.innerHTML=`
    <div class="section-title">Recent activity</div>
    <div class="bike-list">
      ${log.map(l=>{
        const d=JSON.parse(l.details||'{}');
        const who=d.customer_name||d.assigned_to||'';
        return `<div class="activity-row">
          <div class="ar-icon ${iconMap[l.action]||'ret'}">${labelMap[l.action]||'···'}</div>
          <div class="ar-body">
            <div class="ar-main">${l.bike_id||''} ${who?'· '+who:''}</div>
            <div class="ar-sub">${l.actor} · ${fmtTime(l.created_at)}</div>
          </div>
        </div>`;
      }).join('')||'<div class="empty-state"><p>No activity yet</p></div>'}
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function statusBadge(s) {
  const map={available:'Available',out:'Out',reserved:'Reserved',repair:'Repair',missing:'Missing',city:'In city'};
  return `<span class="badge badge-${s||'available'}">${map[s]||s||'Available'}</span>`;
}
function fmtTime(dt) {
  if(!dt) return '';
  try { return new Date(dt.endsWith('Z')?dt:dt+'Z').toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'}); }
  catch{return dt;}
}

// ── Icons ─────────────────────────────────────────────────────────────────
function iconHome(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;}
function iconBike(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 0 0-1-1h-1V4a1 1 0 0 0-2 0v1H9l3 6h3l1.6-3.2A1 1 0 0 0 15 6z"/><path d="m5.5 17.5 4-8.5"/></svg>`;}
function iconAction(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;}
function iconLog(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;}
function iconTicket(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;}

// ── Boot ──────────────────────────────────────────────────────────────────
checkSession();

// ── VOICE ─────────────────────────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

async function startVoiceRecording(actionType) {
  if (isRecording) { stopVoiceRecording(actionType); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/ogg';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => processVoiceRecording(actionType, mimeType, stream);
    mediaRecorder.start();
    isRecording = true;
    const btn = document.getElementById('voice-btn');
    if (btn) { btn.classList.add('recording'); btn.innerHTML = '<span class="voice-dot"></span> Recording... tap to stop'; }
    setTimeout(() => { if (isRecording) stopVoiceRecording(actionType); }, 15000);
  } catch(e) {
    toast('Microphone access denied', 'error');
  }
}

function stopVoiceRecording(actionType) {
  if (!mediaRecorder || !isRecording) return;
  isRecording = false;
  mediaRecorder.stop();
  const btn = document.getElementById('voice-btn');
  if (btn) { btn.classList.remove('recording'); btn.innerHTML = '🎤 Processing...'; btn.disabled = true; }
}

async function processVoiceRecording(actionType, mimeType, stream) {
  stream.getTracks().forEach(t => t.stop());
  try {
    const blob = new Blob(audioChunks, { type: mimeType });
    const reader = new FileReader();
    const base64 = await new Promise((res,rej)=>{ reader.onloadend=()=>res(reader.result.split(',')[1]); reader.onerror=rej; reader.readAsDataURL(blob); });

    const result = await api('/api/voice/transcribe', {
      method: 'POST',
      body: { audio_base64: base64, audio_type: mimeType, action_type: actionType }
    });

    const btn = document.getElementById('voice-btn');
    const transcript = document.getElementById('voice-transcript');

    if (result.bike_ids && result.bike_ids.length > 0) {
      result.bike_ids.forEach(id => { if (!state.action.bikes.includes(id)) state.action.bikes.push(id); });
      refreshBikeAdder();
      updateQuickListSelection();
      updateSubmitBtn();
      toast('Heard: ' + result.bike_ids.join(', '), 'success');
      if (transcript) transcript.textContent = '\u201c' + result.transcript + '\u201d';
    } else {
      toast(result.transcript ? 'No bike IDs found in: "' + result.transcript + '"' : 'Nothing heard, try again', 'error');
      if (transcript && result.transcript) transcript.textContent = '\u201c' + result.transcript + '\u201d';
    }

    if (btn) { btn.innerHTML = '🎤 Tap to speak'; btn.disabled = false; }
  } catch(e) {
    toast('Voice error: ' + e.message, 'error');
    const btn = document.getElementById('voice-btn');
    if (btn) { btn.innerHTML = '🎤 Tap to speak'; btn.disabled = false; }
  }
}
