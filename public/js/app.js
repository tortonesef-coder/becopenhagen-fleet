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

// ── Toast + Undo ──────────────────────────────────────────────────────────
let _undoFn = null;
let _toastTimer = null;

function toast(msg, type="", undoFn=null) {
  const el = document.getElementById("toast");
  clearTimeout(_toastTimer);
  _undoFn = undoFn;
  if (undoFn) {
    el.innerHTML = `<span>${msg}</span><button class="toast-undo-btn" onclick="triggerUndo()">Undo</button>`;
  } else {
    el.textContent = msg;
  }
  el.className = "toast " + type + (undoFn ? " has-undo" : "");
  el.classList.remove("hidden");
  _toastTimer = setTimeout(() => dismissToast(), undoFn ? 5000 : 2800);
}

function dismissToast() {
  clearTimeout(_toastTimer);
  document.getElementById("toast").classList.add("hidden");
  _undoFn = null;
}

async function triggerUndo() {
  clearTimeout(_toastTimer);
  const fn = _undoFn;
  _undoFn = null;
  document.getElementById("toast").classList.add("hidden");
  try {
    await fn();
    toast("Undone ✓", "success");
  } catch(e) {
    toast("Could not undo: " + e.message, "error");
  }
}

// Swipe to dismiss toast
(function() {
  let startX = 0;
  document.addEventListener("touchstart", e => {
    if (!document.getElementById("toast").classList.contains("hidden") && e.target.closest("#toast")) startX = e.touches[0].clientX;
  }, {passive:true});
  document.addEventListener("touchend", e => {
    if (!startX) return;
    if (Math.abs(e.changedTouches[0].clientX - startX) > 60) dismissToast();
    startX = 0;
  }, {passive:true});
})();
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

// ── Identity & Auth ──────────────────────────────────────────────────────
state.pendingMemberId = null;

async function initIdentity() {
  // Check if this is the shop iPad (URL has ?shop) or shop_mode session already active
  const isShopParam = new URLSearchParams(window.location.search).has('shop');
  const sessionCheck = await api('/session/me').catch(() => ({}));

  if (isShopParam || sessionCheck.shop_mode) {
    await initShopMode();
    return;
  }

  const team = await api('/auth/team');
  team.sort((a,b)=>a.name.localeCompare(b.name));
  const n = team.length;
  let cols = (n % 4 === 0) ? 4 : 3;

  const grid = document.getElementById('identity-grid');
  grid.style.setProperty('--id-cols', cols);
  grid.innerHTML = team.map(m=>`
    <button class="identity-btn role-${m.role}" data-id="${m.id}">
      <span class="iname">${m.name}</span>
      <span class="irole">${m.role}</span>
    </button>`).join('');
  grid.querySelectorAll('.identity-btn').forEach(btn=>{
    btn.addEventListener('click',()=>selectMember(btn.dataset.id));
  });
}

async function selectMember(memberId) {
  state.pendingMemberId = memberId;
  try {
    const data = await api('/auth/login', { method:'POST', body:{ member_id: memberId } });
    if (data.needs_setup) {
      showConfirmEmailScreen(memberId, data.email_on_file);
    } else {
      showPasswordScreen(memberId);
    }
  } catch(e) {
    // "Password required" error means the account exists and has a password — just show the password screen
    showPasswordScreen(memberId);
  }
}

function showConfirmEmailScreen(memberId, emailOnFile) {
  openModal(`
    <div class="modal-title">Confirm your email</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">First time logging in. We'll send a code to verify it's you.</p>
    <div class="form-group">
      <input class="form-input" type="email" id="confirm-email" placeholder="you@example.com" value="${emailOnFile||''}" autofocus/>
    </div>
    <div id="confirm-email-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitConfirmEmail('${memberId}')">Send code</button>
    </div>
  `);
}

async function submitConfirmEmail(memberId) {
  const email = document.getElementById('confirm-email')?.value?.trim();
  const err = document.getElementById('confirm-email-error');
  if (!email || !email.includes('@')) { if(err) err.textContent = 'Enter a valid email'; return; }

  try {
    await api('/auth/send-verification', { method:'POST', body:{ member_id: memberId, email }});
    showEnterCodeScreen(memberId, email);
  } catch(e) {
    if (err) err.textContent = e.message;
  }
}

function showEnterCodeScreen(memberId, email) {
  openModal(`
    <div class="modal-title">Enter the code</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">We sent a 6-digit code to ${email}</p>
    <div class="form-group">
      <input class="form-input" type="tel" maxlength="6" id="verify-code" placeholder="123456" style="text-align:center;font-size:1.4rem;letter-spacing:0.4rem" autofocus/>
    </div>
    <div id="verify-code-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="showConfirmEmailScreen('${memberId}','${email}')">Back</button>
      <button class="btn btn-primary" onclick="submitVerifyCode('${memberId}','${email}')">Verify</button>
    </div>
    <button onclick="submitConfirmEmail('${memberId}')" style="background:none;border:none;color:var(--text3);font-size:0.78rem;margin-top:0.85rem;width:100%;cursor:pointer">Resend code</button>
  `);
  document.getElementById('verify-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitVerifyCode(memberId, email);
  });
}

async function submitVerifyCode(memberId, email) {
  const code = document.getElementById('verify-code')?.value?.trim();
  const err = document.getElementById('verify-code-error');
  try {
    await api('/auth/verify-code', { method:'POST', body:{ member_id: memberId, email, code }});
    showSetPasswordScreen(memberId, true);
  } catch(e) {
    if (err) err.textContent = e.message;
  }
}

function showPasswordScreen(memberId) {
  openModal(`
    <div class="modal-title">Enter your password</div>
    <div class="form-group">
      <input class="form-input" type="password" id="login-password" placeholder="Password" autofocus/>
    </div>
    <div id="login-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Back</button>
      <button class="btn btn-primary" onclick="submitLogin('${memberId}')">Log in</button>
    </div>
    <button onclick="closeModal();showForgotPassword('${memberId}')" style="background:none;border:none;color:var(--text3);font-size:0.78rem;margin-top:0.85rem;width:100%;cursor:pointer">Forgot password?</button>
  `);
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitLogin(memberId);
  });
}

async function submitLogin(memberId) {
  const password = document.getElementById('login-password')?.value;
  try {
    const data = await api('/auth/login', { method:'POST', body:{ member_id: memberId, password } });
    state.actor = data.actor;
    closeModal();
    showMain();
  } catch(e) {
    const err = document.getElementById('login-error');
    if (err) err.textContent = e.message;
  }
}

function showSetPasswordScreen(memberId, isFirstTime) {
  openModal(`
    <div class="modal-title">${isFirstTime ? 'Set your password' : 'Choose a new password'}</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">${isFirstTime ? "Email confirmed! Now set a password to protect your account." : ''}</p>
    <div class="form-group">
      <input class="form-input" type="password" id="setup-password" placeholder="New password (min 6 characters)" autofocus/>
    </div>
    <div class="form-group">
      <input class="form-input" type="password" id="setup-password-confirm" placeholder="Confirm password"/>
    </div>
    <div id="setup-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitSetPassword('${memberId}')">Set password</button>
    </div>
  `);
}

async function submitSetPassword(memberId) {
  const pw = document.getElementById('setup-password')?.value;
  const pwConfirm = document.getElementById('setup-password-confirm')?.value;
  const err = document.getElementById('setup-error');
  if (pw !== pwConfirm) { err.textContent = 'Passwords do not match'; return; }
  if (!pw || pw.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }

  try {
    const data = await api('/auth/set-password', { method:'POST', body:{ member_id: memberId, password: pw }});
    state.actor = data.actor;
    closeModal();
    showMain();
  } catch(e) {
    if (err) err.textContent = e.message;
  }
}

function showForgotPassword(memberId) {
  openModal(`
    <div class="modal-title">Reset password</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">We'll send a reset link to your email on file.</p>
    <div id="forgot-status" style="font-size:0.85rem;margin-bottom:0.75rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitForgotPassword('${memberId}')">Send reset link</button>
    </div>
  `);
}

async function submitForgotPassword(memberId) {
  const status = document.getElementById('forgot-status');
  try {
    const data = await api('/auth/forgot-password', { method:'POST', body:{ member_id: memberId }});
    if (status) { status.style.color = 'var(--green)'; status.textContent = data.message; }
  } catch(e) {
    if (status) { status.style.color = '#e04040'; status.textContent = e.message; }
  }
}

async function checkSession() {
  const data = await api('/session/me');
  if (data.shop_mode) {
    if (data.actor) { state.actor = data.actor; showMain(); }
    else await initShopMode();
    return;
  }
  if (data.actor) { state.actor = data.actor; showMain(); }
  else initIdentity();
}

function switchUser() {
  if (state.shopMode) { showShopWhoAreYou(); return; }
  api('/session/logout', { method:'POST' }).then(() => {
    state.actor = null;
    document.getElementById('screen-main').classList.remove('active');
    document.getElementById('screen-main').style.display = 'none';
    document.getElementById('screen-identity').classList.add('active');
    document.getElementById('screen-identity').style.display = 'flex';
    initIdentity();
  });
}

// ── Shop Mode (shared iPad) ──────────────────────────────────────────────
state.shopMode = false;
const SHOP_ACTIONS = ['return', 'rental', 'tour', 'ticket'];

async function initShopMode() {
  state.shopMode = true;
  const status = await api('/auth/shop-pin-status');
  if (!status.configured) {
    showShopPinSetup();
  } else {
    showShopPinEntry();
  }
}

function showShopPinSetup() {
  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
        <div class="bc-sub-label">Shop Mode Setup</div>
      </div>
      <p style="font-size:0.85rem;color:var(--text2);text-align:center;margin-bottom:1rem">Set a 4-digit PIN for this shop device.</p>
      <input class="form-input" type="tel" maxlength="4" id="shop-pin-setup" placeholder="••••" style="text-align:center;font-size:1.5rem;letter-spacing:0.5rem;max-width:160px" autofocus/>
      <button class="btn btn-primary" style="margin-top:1rem;max-width:160px" onclick="submitShopPinSetup()">Set PIN</button>
    </div>`;
}

async function submitShopPinSetup() {
  const pin = document.getElementById('shop-pin-setup')?.value;
  if (!/^\d{4}$/.test(pin)) { toast('PIN must be 4 digits', 'error'); return; }
  await api('/auth/set-shop-pin', { method:'POST', body:{ pin }});
  showShopPinEntry();
}

function showShopPinEntry() {
  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
        <div class="bc-sub-label">Shop Mode</div>
      </div>
      <input class="form-input" type="tel" maxlength="4" id="shop-pin-entry" placeholder="Enter PIN" style="text-align:center;font-size:1.5rem;letter-spacing:0.5rem;max-width:160px" autofocus/>
      <div id="shop-pin-error" style="color:#e04040;font-size:0.85rem;margin-top:0.5rem"></div>
      <button class="btn btn-primary" style="margin-top:1rem;max-width:160px" onclick="submitShopPin()">Unlock</button>
    </div>`;
  document.getElementById('shop-pin-entry').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitShopPin();
  });
}

async function submitShopPin() {
  const pin = document.getElementById('shop-pin-entry')?.value;
  try {
    await api('/auth/shop-login', { method:'POST', body:{ pin }});
    showShopWhoAreYou();
  } catch(e) {
    const err = document.getElementById('shop-pin-error');
    if (err) err.textContent = e.message;
  }
}

async function showShopWhoAreYou() {
  const team = await api('/auth/team');
  team.sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-main').style.display = 'none';
  document.getElementById('screen-identity').classList.add('active');
  document.getElementById('screen-identity').style.display = 'flex';

  const n = team.length;
  const cols = (n % 4 === 0) ? 4 : 3;

  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
      </div>
      <p class="identity-prompt">Who are you?</p>
      <div class="identity-grid" id="shop-who-grid" style="--id-cols:${cols}"></div>
    </div>`;

  const grid = document.getElementById('shop-who-grid');
  grid.innerHTML = team.map(m=>`
    <button class="identity-btn role-${m.role}" data-id="${m.id}">
      <span class="iname">${m.name}</span>
      <span class="irole">${m.role}</span>
    </button>`).join('');
  grid.querySelectorAll('.identity-btn').forEach(btn=>{
    btn.addEventListener('click', async () => {
      const data = await api('/auth/shop-set-actor', { method:'POST', body:{ member_id: btn.dataset.id }});
      state.actor = data.actor;
      showMain();
    });
  });
}

function showMain() {
  document.getElementById('screen-identity').classList.remove('active');
  document.getElementById('screen-identity').style.display='none';
  document.getElementById('screen-main').classList.add('active');
  document.getElementById('screen-main').style.display='flex';
  document.getElementById('actor-badge').textContent = state.shopMode ? ('🏪 ' + state.actor.name) : state.actor.name;
  buildTabbar();
  renderTab(state.shopMode ? 'action' : landingTab());
  if (!state.shopMode) checkBorrowedReminder();
}

function buildTabbar() {
  if (state.shopMode) {
    const tabs = [{id:'action',label:'Action',icon:iconAction()},{id:'bikes',label:'Bikes',icon:iconBike()}];
    document.getElementById('tabbar').innerHTML=tabs.map(t=>`
      <button class="tab-btn${t.id===state.currentTab?' active':''}" data-tab="${t.id}">
        ${t.icon}<span>${t.label}</span>
      </button>`).join('');
    document.getElementById('tabbar').querySelectorAll('.tab-btn').forEach(btn=>{
      btn.addEventListener('click',()=>renderTab(btn.dataset.tab));
    });
    return;
  }
  const role=state.actor?.role;
  const tabs = role==='mechanic'
    ? [{id:'today',label:'Today',icon:iconHome()},{id:'tickets',label:'Tickets',icon:iconTicket()},{id:'bikes',label:'Bikes',icon:iconBike()},{id:'log',label:'Log',icon:iconLog()}]
    : role==='admin'
    ? [{id:'today',label:'Today',icon:iconHome()},{id:'tours',label:'Tours',icon:iconTours()},{id:'action',label:'Action',icon:iconAction()},{id:'tickets',label:'Tickets',icon:iconTicket()},{id:'admin',label:'Admin',icon:iconAdmin()}]
    : [{id:'tours',label:'Tours',icon:iconTours()},{id:'today',label:'Today',icon:iconHome()},{id:'action',label:'Action',icon:iconAction()},{id:'log',label:'Log',icon:iconLog()}];
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
  const titles={today:'Today',bikes:'All bikes',action:'Action',log:'Log',tickets:'Tickets',admin:'Admin',tours:'Tours & Rentals'};
  document.getElementById('view-title').textContent=titles[id]||id;
  const c=document.getElementById('content');
  if(id==='today') await renderToday(c);
  else if(id==='bikes') await renderBikes(c);
  else if(id==='action') renderAction(c);
  else if(id==='log') await renderLog(c);
  else if(id==='tickets') await renderTickets(c);
  else if(id==='admin') await renderAdmin(c);
  else if(id==='tours') await renderTours(c);
}

// ── TODAY ─────────────────────────────────────────────────────────────────
async function renderToday(c) {
  const [avail,today]=await Promise.all([api('/api/availability'),api('/api/today')]);
  const {types}=avail;
  const scarce=new Set(['CC','E','SA','AC','AT']);

  const cards=types.map(t=>{
    const avl=t.available||0,total=t.total||0,pct=total?avl/total:0;
    const cls=pct===0?'red':pct<=0.4?'amber':'green';
    const onclick = 'drillType(\''+t.type_id+'\')'
    return '<div class="type-card'+(scarce.has(t.type_id)&&pct<=0.5?' scarce':'')+(pct===0?' empty':'')+'" onclick="'+onclick+'">'
      +'<div class="tc-label">'+t.label+'</div>'
      +'<div class="tc-nums"><span class="tc-avail '+cls+'">'+avl+'</span><span class="tc-total">/ '+total+'</span></div>'
      +'<div class="tc-pips">'
      +(t.out>0?'<span class="tc-pip out">'+t.out+' out</span>':'')
      +(t.repair>0?'<span class="tc-pip repair">'+t.repair+' repair</span>':'')
      +((t.missing||0)>0?'<span class="tc-pip repair">'+t.missing+' missing</span>':'')
      +'</div></div>';
  }).join('');

  const pending=today.pending||[];
  const activity=today.checkouts||[];

  let pendingHtml = '';
  if (pending.length > 0) {
    pendingHtml = '<div class="section-title">Incoming bookings — assign bikes</div>'
      + pending.map(p => {
          const emailBtn = p.customer_email ? '<a href="mailto:'+p.customer_email+'" class="btn btn-sm btn-secondary">Email</a>' : '';
          return '<div class="pending-card">'
            +'<div class="pc-ref">#'+(p.fareharbor_booking_ref||'No ref')+'</div>'
            +'<div class="pc-name">'+(p.customer_name||'Unknown')+'</div>'
            +'<div class="pc-time">'+(p.booking_date||'')+(p.start_time?' · '+p.start_time:'')+(p.end_time?'–'+p.end_time:'')+'</div>'
            +'<div class="pc-bikes">'+(p.bikes_needed||'Bikes TBD')+'</div>'
            +'<div style="display:flex;gap:0.5rem;margin-top:0.6rem;flex-wrap:wrap">'
            +emailBtn
            +'<button class="btn btn-sm btn-primary" onclick="openAssignModal('+p.id+')">Assign bikes</button>'
            +'<button class="btn btn-sm btn-secondary" onclick="dismissAssignment('+p.id+')">Dismiss</button>'
            +'</div></div>';
        }).join('');
  }

  let activityHtml = '';
  if (activity.length === 0) {
    activityHtml = '<div style="text-align:center;padding:1.5rem 0;color:var(--text3);font-size:0.88rem">No activity yet today</div>';
  } else {
    activityHtml = activity.slice(0,25).map(a => {
      const d = JSON.parse(a.details||'{}');
      const who = d.customer_name||d.assigned_to||'';
      const ic = a.action==='checkout'?'out':a.action==='repair_ticket'?'issue':a.action==='city'?'city':'ret';
      const lb = a.action==='checkout'?'OUT':a.action==='repair_ticket'?'FIX':a.action==='city'?'PIN':'RTN';
      return '<div class="activity-row">'
        +'<div class="ar-icon '+ic+'">'+lb+'</div>'
        +'<div class="ar-body">'
        +'<div class="ar-main">'+(a.bike_id||'')+' '+(who?'· '+who:'')+'</div>'
        +'<div class="ar-sub">'+a.actor+' · '+fmtTime(a.created_at)+'</div>'
        +'</div></div>';
    }).join('');
  }

  c.innerHTML = '<div class="type-grid">'+cards+'</div>'
    + pendingHtml
    + '<div class="section-title">Today\'s activity</div>'
    + activityHtml;
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
      b.status==='city'?`Left in city${b.location_address?' · '+b.location_address:''}${b.note?'<br><small>'+b.note+'</small>':''}${b.location_lat&&b.location_lng?'<br><a href="https://www.openstreetmap.org/?mlat='+b.location_lat+'&mlon='+b.location_lng+'&zoom=17" target="_blank" style="font-size:0.78rem;color:#1a5fa8">📍 View on map</a>':'<br><small style="color:#a8a49f">No GPS recorded</small>'}`:b.status}
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
  { id:'tour',         emoji:'🗺️', label:'Tour',          sub:'Guide or private, any group', multi:true  },
  { id:'borrowed',     emoji:'🤝', label:'Borrowed',      sub:'Staff personal use',         multi:false },
  { id:'city',         emoji:'📍', label:'Left in city',  sub:'Broke down on tour',         multi:false },
  { id:'ticket',       emoji:'🔧', label:'Report issue',  sub:'Repair ticket',              multi:false },
  { id:'missing',      emoji:'❓', label:'Missing',       sub:"Can't find it",              multi:false },
];

function renderAction(c) {
  // Preserve selected bikes and preloaded bike when going back
  const preservedBikes = state.action.bikes || [];
  const preservedPreloaded = state.action.preloaded || null;
  state.action = { type: null, bikes: preservedBikes, searchQ: '', preloaded: preservedPreloaded };

  const visibleActions = state.shopMode
    ? ACTION_TYPES.filter(a => SHOP_ACTIONS.includes(a.id))
    : ACTION_TYPES;

  c.innerHTML = `
    ${state.action.bikes.length>0?`<div class="selected-bikes-bar">
      <span class="sbb-label">Selected:</span>
      ${state.action.bikes.map(id=>`<span class="return-tag">${id}<span class="return-tag-remove" onclick="toggleBike('${id}','','');renderAction(document.getElementById('content'))">&times;</span></span>`).join('')}
    </div>`:''}
  <div class="section-title" style="margin-top:0">What are you doing?</div>
    <div class="action-type-list" id="action-type-list">
      ${visibleActions.map(a=>`
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
  // Apply preloaded bike if not already selected
  if (state.action.preloaded && !state.action.bikes.includes(state.action.preloaded)) {
    state.action.bikes.push(state.action.preloaded);
  }
  state.action.preloaded = null;
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

    <div class="section-title">${def.multi?'Which bikes? (add as many as needed)':'Which bike?'}</div>
    <div class="bike-adder">
      <div class="bike-adder-input-row">
        <input class="form-input" id="bike-adder-input" placeholder="Type bike ID..." autocapitalize="characters" autocomplete="off"/>
        <button class="btn btn-secondary btn-sm" onclick="addBikeById()">Add</button>
      </div>
      <button class="voice-btn" id="voice-btn" onclick="startVoiceRecording(state.action.type)">
        🎤 <span>Tap to speak bike IDs</span>
      </button>
      <div class="voice-transcript" id="voice-transcript"></div>
      <div class="voice-result" id="voice-result"></div>
      <div class="bike-adder-tags" id="bike-adder-tags"></div>
    </div>

    <div id="action-submit-area" style="padding:0.5rem 0 0.75rem">
      <button class="btn btn-primary btn-full" onclick="submitActionNew()" id="action-submit-btn">
        ${submitLabel(actionId, 0)}
      </button>
    </div>

    <details style="margin-bottom:1rem">
      <summary style="font-size:0.8rem;color:var(--text2);cursor:pointer;padding:0.5rem 0;list-style:none;display:flex;align-items:center;gap:0.4rem">
        <span>▶</span> Browse all bikes
      </summary>
      <div class="bike-quick-list" id="bike-quick-list" style="margin-top:0.5rem">
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
    </details>`;

  const input = document.getElementById('bike-adder-input');
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter'||e.key===','){e.preventDefault();addBikeById();}
  });

  // If bikes were preloaded, show them immediately
  if (state.action.bikes.length > 0) {
    refreshBikeAdder();
    updateSubmitBtn();
    updateQuickListSelection();
  }

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
        <label class="form-label">Guide / customer name</label>
        <input class="form-input" id="af-name" value="${state.actor?.name||''}" placeholder="Name"/>
      </div>
      <div class="form-group">
        <label class="form-label">Tour type (optional)</label>
        <select class="form-select" id="af-tour-type">
          <option value="">— select —</option>
          <option>A3 Architecture</option>
          <option>L3 History</option>
          <option>F3 Food</option>
          <option>H3 New History</option>
          <option>Private</option>
          <option>Other</option>
        </select>
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
        <label class="form-label">Location / address <span style="color:var(--red)">*</span></label>
        <input class="form-input" id="af-address" placeholder="e.g. Nørreport Station — required"/>
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
    borrowed:`Mark borrowed${n}`,
    city:'Mark left in city', ticket:'Create repair ticket', missing:'Mark missing',
  };
  return labels[actionId]||'Submit';
}

function toggleBike(id, name, currentStatus) {
  const def = ACTION_TYPES.find(a=>a.id===state.action.type);
  if(!def) return;

  // Warn if already out and checking out again
  const isCheckout = ['rental','tour','borrowed','city'].includes(state.action.type);
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
  // Auto-add whatever is typed in the input field before submitting
  const input = document.getElementById('bike-adder-input');
  if (input?.value?.trim()) addBikeById();

  const {type, bikes} = state.action;
  if(!type){toast('Select an action type first','error');return;}
  if(bikes.length===0){toast('No bike selected — type a bike ID and tap Add','error');return;}
  const actor = state.actor?.id||'unknown';

  try {
    for(const bikeId of bikes) {
      if(type==='return') {
        const newStatus = document.getElementById('af-ret-status')?.value||'available';
        await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:newStatus}});

      } else if(['rental','tour'].includes(type)) {
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
        if (!address && !loc) {
          toast('Please enter a location or use GPS', 'error');
          return;
        }
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
        const repRes = await api('/api/repairs',{method:'POST',body:{
          bike_id:bikeId, problem, problem_categories:cats, can_rent:canRent
        }});
        if(!canRent) await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:'repair',note:problem}});
        // Store ticket ID for undo
        if (repRes?.ticket_id) state.action._lastTicketId = repRes.ticket_id;

      } else if(type==='missing') {
        const note = document.getElementById('af-note')?.value?.trim();
        await api(`/api/bikes/${bikeId}/return`,{method:'POST',body:{new_status:'missing',note}});
      }
    }

    const label = submitLabel(type, bikes.length);

    // Build undo function based on action type
    let undoFn = null;
    if (type === 'return') {
      const prevStatuses = bikes.map(id => {
        const b = null; // we don't have prev status here, best we can do is re-checkout
        return id;
      });
      // Undo return = mark as out again (approximate)
      undoFn = async () => {
        for (const id of bikes) {
          await api(`/api/bikes/${id}/checkout`, {method:'POST', body:{assignment_type:'rental', assigned_to:'(undone return)', force:true}});
        }
        renderAction(document.getElementById('content'));
      };
    } else if (['rental','tour','borrowed'].includes(type)) {
      undoFn = async () => {
        for (const id of bikes) {
          await api(`/api/bikes/${id}/return`, {method:'POST', body:{new_status:'available', note:'Undone'}});
          await api(`/api/log/undo`, {method:'POST', body:{bike_id:id, actions:['checkout','return'], limit:2}});
        }
        renderAction(document.getElementById('content'));
      };
    } else if (type === 'missing') {
      undoFn = async () => {
        for (const id of bikes) {
          await api(`/api/bikes/${id}/return`, {method:'POST', body:{new_status:'available', note:'Undone'}});
          await api(`/api/log/undo`, {method:'POST', body:{bike_id:id, actions:['return','missing'], limit:2}});
        }
        renderAction(document.getElementById('content'));
      };
    } else if (type === 'city') {
      undoFn = async () => {
        for (const id of bikes) {
          await api(`/api/bikes/${id}/return`, {method:'POST', body:{new_status:'available', note:'Undone'}});
          await api(`/api/log/undo`, {method:'POST', body:{bike_id:id, actions:['city','return'], limit:2}});
        }
        renderAction(document.getElementById('content'));
      };
    }
    // Undo for ticket creation
    if (type === 'ticket' && state.action._lastTicketId) {
      const tid = state.action._lastTicketId;
      undoFn = async () => {
        await api(`/api/repairs/${tid}/delete`, {method:'DELETE'});
        for (const id of bikes) {
          const bs = await api(`/api/bikes/${id}`);
          if (bs.status === 'repair') await api(`/api/bikes/${id}/return`,{method:'POST',body:{new_status:'available'}});
        }
        await renderTab('action');
      };
    }

    toast(`Done — ${label.toLowerCase()}`, 'success', undoFn);

    if (state.shopMode) {
      // Shop mode: clear actor and go straight back to "who are you" after every action
      state.action = { type: null, bikes: [], searchQ: '', preloaded: null };
      await api('/session/shop-logout-actor', { method:'POST' });
      setTimeout(() => showShopWhoAreYou(), 900); // small delay so the success toast is visible
      return;
    }

    // After return actions, clear selection and go to Today
    if (['return', 'missing', 'city'].includes(type)) {
      state.action = { type: null, bikes: [], searchQ: '', preloaded: null };
      await renderTab('today');
    } else {
      // For checkouts, clear selection but stay on action tab ready for next
      state.action = { type: null, bikes: [], searchQ: '', preloaded: null };
      renderAction(document.getElementById('content'));
    }

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
  // Store preloaded bike — will be added when action type is selected
  state.action.preloaded = id;
  // Also show it in the adder input so user sees it
  const input = document.getElementById('bike-adder-input');
  if (input) { input.value = id; }
}

// ── TICKETS ───────────────────────────────────────────────────────────────
async function renderTickets(c) {
  const [tickets, stats] = await Promise.all([
    api('/api/repairs?status=open'),
    api('/api/repairs/stats'),
  ]);

  const subtabs = ['queue', 'analytics'];
  if (!window._ticketTab) window._ticketTab = 'queue';

  c.innerHTML = `
    <div class="subtab-row">
      <button class="subtab${window._ticketTab==='queue'?' active':''}" onclick="switchTicketTab('queue')">Queue (${tickets.length})</button>
      <button class="subtab${window._ticketTab==='analytics'?' active':''}" onclick="switchTicketTab('analytics')">Analytics</button>
    </div>
    <div id="ticket-tab-content"></div>`;

  renderTicketTab(tickets, stats);
}

function switchTicketTab(tab) {
  window._ticketTab = tab;
  document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.textContent.startsWith(tab==='queue'?'Queue':'Analytics')));
  api('/api/repairs?status=open').then(tickets => {
    api('/api/repairs/stats').then(stats => renderTicketTab(tickets, stats));
  });
}

function renderTicketTab(tickets, stats) {
  const el = document.getElementById('ticket-tab-content');
  if (!el) return;
  if (window._ticketTab === 'queue') {
    el.innerHTML = renderTicketQueue(tickets);
  } else {
    el.innerHTML = renderTicketAnalytics(stats);
  }
}

function renderTicketQueue(tickets) {
  if (tickets.length === 0) return '<div class="empty-state"><p>No open repair tickets 🎉</p></div>';

  return tickets.map(t => {
    const cats = JSON.parse(t.problem_categories || '[]');
    const hours = t.hours_waiting || 0;
    const days = Math.floor(hours / 24);
    const ageLabel = days > 0 ? `${days}d ${Math.floor(hours % 24)}h` : `${Math.floor(hours)}h`;
    const priorityClass = t.priority_score > 500 ? 'priority-high' : t.priority_score > 150 ? 'priority-mid' : 'priority-low';
    const complexLabels = {1:'Quick fix',2:'Simple',3:'Medium',4:'Complex',5:'Major'};

    return `<div class="ticket-card ${priorityClass}">
      <div class="tk-header">
        <div>
          <span class="tk-bike">${t.bike_id}</span>
          <span class="tk-type-label">${t.type_label||''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem">
          <span class="tk-rentable ${t.can_rent?'yes':'no'}">${t.can_rent?'Can rent':'Off fleet'}</span>
          <span class="tk-score" title="Priority score">${Math.round(t.priority_score)}</span>
        </div>
      </div>
      ${cats.length>0?`<div class="tk-cats">${cats.map(c=>`<span class="tk-cat">${c}</span>`).join('')}</div>`:''}
      ${t.problem&&t.problem!==cats.join(', ')?`<div class="tk-problem">${t.problem}</div>`:''}
      <div class="tk-meta">
        <span>⏱ ${ageLabel} waiting</span>
        <span>· ${t.reported_by}</span>
        ${(()=>{
          if(!t.rental_value_dkk||t.hours_waiting<1) return '';
          // Only meaningful if bike is off fleet (can_rent=0)
          if(t.can_rent) return '';
          const daysWaiting = t.hours_waiting / 24;
          // We don't have scarcity here so just show raw opportunity cost with a note
          const lost = Math.round(t.rental_value_dkk * daysWaiting);
          return lost > 0 ? `<span>· ~${lost} DKK opportunity cost</span>` : '';
        })()}
      </div>
      <div class="tk-complexity-row">
        <span style="font-size:0.75rem;color:var(--text3)">Complexity</span>
        <div class="complexity-picker" data-ticket="${t.id}" data-current="${t.complexity||3}">
          ${[1,2,3,4,5].map(n=>`<button class="complexity-dot${(t.complexity||3)>=n?' filled':''}" onclick="setComplexity(${t.id},${n})" title="${complexLabels[n]}">${n}</button>`).join('')}
        </div>
        <span style="font-size:0.72rem;color:var(--text3)">${complexLabels[t.complexity||3]}</span>
      </div>
      <div style="margin-top:0.6rem;display:flex;gap:0.5rem">
        <button class="btn btn-sm btn-success" onclick="resolveTicket(${t.id},'${t.bike_id}')">✓ Resolved</button>
        <button class="btn btn-sm btn-secondary" onclick="showBike('${t.bike_id}')">View bike</button>
        ${t.can_rent?'':`<button class="btn btn-sm btn-secondary" onclick="toggleCanRent(${t.id},1)">Can rent now</button>`}
      </div>
    </div>`;
  }).join('');
}

function renderTicketAnalytics(stats) {
  const freq = stats.problem_frequency || [];
  const byType = stats.resolution_by_type || [];
  const worst = stats.worst_bikes || [];
  const counts = stats.ticket_counts || [];
  const totalOpen = counts.find(c=>c.status==='open')?.count || 0;
  const totalDone = counts.find(c=>c.status==='done')?.count || 0;

  const maxFreq = freq[0]?.count || 1;
  const freqBars = freq.slice(0,10).map(f => `
    <div class="stat-bar-row">
      <div class="stat-bar-label">${f.category}</div>
      <div class="stat-bar-track">
        <div class="stat-bar-fill" style="width:${Math.round(f.count/maxFreq*100)}%"></div>
      </div>
      <div class="stat-bar-val">${f.count}${f.avg_hours?` · ${f.avg_hours}h avg`:''}</div>
    </div>`).join('');

  const typeBars = byType.filter(t=>t.ticket_count>0).map(t=>`
    <div class="stat-bar-row">
      <div class="stat-bar-label">${t.label}</div>
      <div class="stat-bar-track">
        <div class="stat-bar-fill amber" style="width:${Math.min(100,Math.round((t.avg_hours||0)/48*100))}%"></div>
      </div>
      <div class="stat-bar-val">${t.ticket_count} tickets${t.avg_hours?' · '+t.avg_hours+'h':''}</div>
    </div>`).join('');

  const worstList = worst.map(b=>`
    <div class="detail-row">
      <span class="dr-key"><strong style="color:var(--red)">${b.bike_id}</strong> ${b.bike_name||''}</span>
      <span class="dr-val">${b.ticket_count} tickets${b.open_tickets>0?' · <span style="color:var(--red)">'+b.open_tickets+' open</span>':''}</span>
    </div>`).join('');

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-num red">${totalOpen}</div>
        <div class="stat-card-label">Open tickets</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-num green">${totalDone}</div>
        <div class="stat-card-label">Resolved all time</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-num amber">${stats.resolution_overall?.avg_hours||'—'}</div>
        <div class="stat-card-label">Avg hours to fix</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-num red">${stats.daily_revenue_lost>0?stats.daily_revenue_lost+' DKK':'0'}</div>
        <div class="stat-card-label">Est. revenue lost</div>
      </div>
    </div>

    ${freq.length>0?`
    <div class="section-title" style="margin-top:1rem">Most common problems</div>
    <div class="stats-section">${freqBars}</div>`:''}

    ${byType.length>0?`
    <div class="section-title">By bike type</div>
    <div class="stats-section">${typeBars}</div>`:''}

    ${worst.length>0?`
    <div class="section-title">Bikes with most tickets</div>
    <div class="stats-section detail-section" style="padding-top:0;border-top:none">${worstList}</div>`:''}

    ${totalOpen===0&&totalDone===0?'<div class="empty-state"><p>No repair data yet — tickets will appear here once you start logging issues.</p></div>':''}
  `;
}

async function setComplexity(ticketId, complexity) {
  try {
    // Find previous complexity from DOM before updating
    const picker = document.querySelector(`.complexity-picker[data-ticket="${ticketId}"]`);
    const prev = parseInt(picker?.dataset.current) || 3;
    await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ complexity } });
    const [tickets, stats] = await Promise.all([api('/api/repairs?status=open'), api('/api/repairs/stats')]);
    renderTicketTab(tickets, stats);
    toast('Complexity updated', 'success', async () => {
      await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ complexity: prev } });
      const [t2, s2] = await Promise.all([api('/api/repairs?status=open'), api('/api/repairs/stats')]);
      renderTicketTab(t2, s2);
    });
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleCanRent(ticketId, canRent) {
  try {
    await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ can_rent: canRent } });
    const [tickets, stats] = await Promise.all([api('/api/repairs?status=open'), api('/api/repairs/stats')]);
    renderTicketTab(tickets, stats);
    const prev = canRent ? 0 : 1;
    toast(canRent ? 'Marked: can rent' : 'Marked: off fleet', 'success', async () => {
      await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ can_rent: prev } });
      const [t2, s2] = await Promise.all([api('/api/repairs?status=open'), api('/api/repairs/stats')]);
      renderTicketTab(t2, s2);
    });
  } catch(e) { toast(e.message, 'error'); }
}

async function resolveTicket(ticketId, bikeId) {
  openModal(`
    <div class="modal-title">Resolve ticket</div>
    <div class="form-group">
      <label class="form-label">What did you fix?</label>
      <textarea class="form-textarea" id="res-note" placeholder="Describe what was done..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">How long did it take?</label>
      <div style="display:flex;gap:0.5rem;align-items:center">
        <input class="form-input" id="res-hours" type="number" min="0" step="0.5" placeholder="0" style="width:80px"/>
        <span style="font-size:0.88rem;color:var(--text2)">hours</span>
        <input class="form-input" id="res-minutes" type="number" min="0" max="59" step="5" placeholder="0" style="width:80px"/>
        <span style="font-size:0.88rem;color:var(--text2)">minutes</span>
      </div>
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

async function submitResolve(ticketId, bikeId) {
  const note = document.getElementById('res-note')?.value?.trim();
  const status = document.getElementById('res-status')?.value;
  const hours = parseFloat(document.getElementById('res-hours')?.value || 0);
  const minutes = parseFloat(document.getElementById('res-minutes')?.value || 0);
  const actual_hours = hours + (minutes / 60) || null;
  try {
    await api(`/api/repairs/${ticketId}/resolve`, { method:'POST', body:{ resolution_note:note, new_bike_status:status, actual_hours }});
    closeModal();
    await renderTab('tickets');
    toast('Ticket resolved ✓', 'success', async () => {
      await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ status:'open' }});
      if (bikeId) await api(`/api/bikes/${bikeId}/return`, {method:'POST', body:{new_status:'repair', note:'Undo resolve'}});
      await renderTab('tickets');
    });
  } catch(e) { toast(e.message, 'error'); }
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
document.getElementById('btn-switch-user').addEventListener('click', switchUser);

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
    // Manual stop only — user taps again to stop
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

    const found = result.bike_ids || [];
    const notFound = result.not_found || [];

    // Update transcript display
    if (transcript && result.transcript) {
      transcript.innerHTML = '“' + result.transcript + '”';
    }

    // Build persistent result line
    const resultEl = document.getElementById('voice-result');
    if (found.length > 0) {
      found.forEach(id => { if (!state.action.bikes.includes(id)) state.action.bikes.push(id); });
      refreshBikeAdder();
      updateQuickListSelection();
      updateSubmitBtn();
      let toastMsg = 'Added: ' + found.join(', ');
      let resultMsg = '<span style="color:var(--green)">✓ Added: ' + found.join(', ') + '</span>';
      if (notFound.length > 0) {
        toastMsg += ' · not in fleet: ' + notFound.join(', ');
        resultMsg += '<br><span style="color:var(--red)">✗ Not in fleet: ' + notFound.join(', ') + '</span>';
      }
      toast(toastMsg, notFound.length > 0 ? '' : 'success');
      if (resultEl) resultEl.innerHTML = resultMsg;
    } else if (notFound.length > 0) {
      toast('Not found in fleet: ' + notFound.join(', '), 'error');
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">✗ Not in fleet: ' + notFound.join(', ') + '</span>';
    } else {
      toast(result.transcript ? 'Nothing recognised' : 'Nothing heard, try again', 'error');
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--text3)">Nothing recognised</span>';
    }

    if (btn) { btn.innerHTML = '🎤 Tap to speak'; btn.disabled = false; }
  } catch(e) {
    toast('Voice error: ' + e.message, 'error');
    const btn = document.getElementById('voice-btn');
    if (btn) { btn.innerHTML = '🎤 Tap to speak'; btn.disabled = false; }
  }
}

// ── ADMIN ─────────────────────────────────────────────────────────────────
async function renderAdmin(c) {
  if (!window._adminTab) window._adminTab = 'bikes';
  c.innerHTML = `
    <div class="subtab-row">
      <button class="subtab${window._adminTab==='bikes'?' active':''}" onclick="switchAdminTab('bikes')">Fleet</button>
      <button class="subtab${window._adminTab==='log'?' active':''}" onclick="switchAdminTab('log')">Log</button>
    </div>
    <div id="admin-tab-content"></div>`;
  renderAdminTab(c);
}

async function switchAdminTab(tab) {
  window._adminTab = tab;
  document.querySelectorAll('.subtab').forEach(b =>
    b.classList.toggle('active', b.textContent === (tab==='bikes'?'Fleet':'Log')));
  renderAdminTab(document.getElementById('content'));
}

async function renderAdminTab(c) {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  if (window._adminTab === 'bikes') await renderAdminBikes(el);
  else await renderAdminLog(el);
}

async function renderAdminBikes(el) {
  const [bikes, types] = await Promise.all([
    api('/api/fleet/bikes'),
    api('/api/fleet/types'),
  ]);

  const typeMap = {};
  types.forEach(t => typeMap[t.id] = t);

  // Group by type
  const grouped = {};
  bikes.forEach(b => {
    if (!grouped[b.type_id]) grouped[b.type_id] = [];
    grouped[b.type_id].push(b);
  });

  el.innerHTML = `
    <button class="btn btn-primary btn-full" style="margin-bottom:1rem" onclick="openAddBikeModal()">
      + Add new bike
    </button>
    ${types.map(t => {
      const typeBikes = grouped[t.id] || [];
      const active = typeBikes.filter(b=>b.active);
      const retired = typeBikes.filter(b=>!b.active);
      return `
        <div class="section-title">${t.label} <span style="color:var(--text3);font-weight:400">${active.length} active${retired.length>0?' · '+retired.length+' retired':''}</span></div>
        <div class="bike-list" style="margin-bottom:0.75rem">
          ${typeBikes.map(b=>`
            <div class="bike-row${!b.active?' retired-bike':''}">
              <span class="br-id" style="${!b.active?'color:var(--text3)':''}">${b.id}</span>
              <div class="br-info">
                <div class="br-name">${b.name||''} ${b.key_number?'<span style="font-size:0.72rem;color:var(--text3)">🔑'+b.key_number+'</span>':''}</div>
                <div class="br-detail">${[b.frame_size?b.frame_size+'cm':'', b.model||''].filter(Boolean).join(' · ')}</div>
              </div>
              <div class="br-status">
                ${!b.active?'<span class="badge" style="background:var(--bg3);color:var(--text3)">Retired</span>':statusBadge(b.status)}
                <button class="btn btn-sm btn-secondary" style="margin-left:0.4rem;padding:2px 8px;font-size:0.72rem" onclick="openEditBikeModal('${b.id}')">Edit</button>
              </div>
            </div>`).join('')}
        </div>`;
    }).join('')}
  `;
}

async function renderAdminLog(el) {
  const log = await api('/api/log?limit=100');
  const iconMap={checkout:'out',return:'ret',bulk_return:'ret',repair_ticket:'issue',city:'city',bike_added:'ret',bike_retired:'issue',bike_edited:'ret'};
  const labelMap={checkout:'OUT',return:'RTN',bulk_return:'RTN',repair_ticket:'FIX',city:'PIN',bike_added:'NEW',bike_retired:'RET',bike_edited:'EDT'};
  el.innerHTML = `
    <div class="bike-list">
      ${log.map(l=>{
        const d=JSON.parse(l.details||'{}');
        const who=d.customer_name||d.assigned_to||'';
        return `<div class="activity-row">
          <div class="ar-icon ${iconMap[l.action]||'ret'}">${labelMap[l.action]||'···'}</div>
          <div class="ar-body">
            <div class="ar-main">${l.bike_id||''} ${who?'· '+who:''} <span style="color:var(--text3);font-size:0.78rem">${l.action}</span></div>
            <div class="ar-sub">${l.actor} · ${fmtTime(l.created_at)}</div>
          </div>
        </div>`;
      }).join('')||'<div class="empty-state"><p>No activity yet</p></div>'}
    </div>`;
}

async function openAddBikeModal() {
  const types = await api('/api/fleet/types');
  openModal(`
    <div class="modal-title">Add new bike</div>
    <div class="form-group">
      <label class="form-label">Bike ID</label>
      <input class="form-input" id="ab-id" placeholder="e.g. A38, CC6, E12" autocapitalize="characters"/>
    </div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <select class="form-select" id="ab-type">
        ${types.map(t=>`<option value="${t.id}">${t.label}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Celebrity name (optional)</label>
      <input class="form-input" id="ab-name" placeholder="e.g. Birgitte Hjort Sørensen"/>
    </div>
    <div class="form-group">
      <label class="form-label">Frame size (cm)</label>
      <input class="form-input" id="ab-size" placeholder="e.g. 50"/>
    </div>
    <div class="form-group">
      <label class="form-label">Key number</label>
      <input class="form-input" id="ab-key" placeholder="e.g. 4521"/>
    </div>
    <div class="form-group">
      <label class="form-label">Frame number</label>
      <input class="form-input" id="ab-frame" placeholder="e.g. WAV22374U"/>
    </div>
    <div class="form-group">
      <label class="form-label">Model</label>
      <input class="form-input" id="ab-model" placeholder="e.g. Winther 4"/>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label">Notes</label>
      <input class="form-input" id="ab-notes" placeholder="Any notes..."/>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddBike()">Add bike</button>
    </div>`);
}

async function submitAddBike() {
  const id = document.getElementById('ab-id')?.value?.trim().toUpperCase();
  const type_id = document.getElementById('ab-type')?.value;
  if (!id) { toast('Bike ID required', 'error'); return; }
  try {
    await api('/api/fleet/bikes', { method:'POST', body:{
      id, type_id,
      name: document.getElementById('ab-name')?.value?.trim()||null,
      frame_size: document.getElementById('ab-size')?.value?.trim()||null,
      key_number: document.getElementById('ab-key')?.value?.trim()||null,
      frame_number: document.getElementById('ab-frame')?.value?.trim()||null,
      model: document.getElementById('ab-model')?.value?.trim()||null,
      notes: document.getElementById('ab-notes')?.value?.trim()||null,
    }});
    closeModal();
    toast(`${id} added`, 'success', async () => {
      await api(`/api/fleet/bikes/${id}`, {method:'PATCH', body:{active:false}});
      renderAdminTab(document.getElementById('content'));
    });
    renderAdminTab(document.getElementById('content'));
  } catch(e) { toast(e.message, 'error'); }
}

async function openEditBikeModal(id) {
  const [b, types] = await Promise.all([api(`/api/bikes/${id}`), api('/api/fleet/types')]);
  openModal(`
    <div class="modal-title">Edit ${id}</div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <select class="form-select" id="eb-type">
        ${types.map(t=>`<option value="${t.id}"${b.type_id===t.id?' selected':''}>${t.label}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Celebrity name</label>
      <input class="form-input" id="eb-name" value="${b.name||''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Frame size (cm)</label>
      <input class="form-input" id="eb-size" value="${b.frame_size||''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Key number</label>
      <input class="form-input" id="eb-key" value="${b.key_number||''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Frame number</label>
      <input class="form-input" id="eb-frame" value="${b.frame_number||''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Model</label>
      <input class="form-input" id="eb-model" value="${b.model||''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input class="form-input" id="eb-notes" value="${b.notes||''}"/>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" onclick="retireBike('${id}',${!b.active})">${b.active?'Retire bike':'Reactivate'}</button>
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitEditBike('${id}')">Save</button>
    </div>`);
}

async function submitEditBike(id) {
  try {
    await api(`/api/fleet/bikes/${id}`, { method:'PATCH', body:{
      type_id: document.getElementById('eb-type')?.value,
      name: document.getElementById('eb-name')?.value?.trim()||null,
      frame_size: document.getElementById('eb-size')?.value?.trim()||null,
      key_number: document.getElementById('eb-key')?.value?.trim()||null,
      frame_number: document.getElementById('eb-frame')?.value?.trim()||null,
      model: document.getElementById('eb-model')?.value?.trim()||null,
      notes: document.getElementById('eb-notes')?.value?.trim()||null,
    }});
    // Snapshot previous values for undo
    const _prevBike = await api(`/api/bikes/${id}`);
    closeModal();
    toast(`${id} updated`, 'success', async () => {
      await api(`/api/fleet/bikes/${id}`, {method:'PATCH', body:{
        type_id:_prevBike.type_id, name:_prevBike.name, frame_size:_prevBike.frame_size,
        key_number:_prevBike.key_number, frame_number:_prevBike.frame_number,
        model:_prevBike.model, notes:_prevBike.notes
      }});
      renderAdminTab(document.getElementById('content'));
    });
    renderAdminTab(document.getElementById('content'));
  } catch(e) { toast(e.message, 'error'); }
}

async function retireBike(id, reactivate) {
  if (!reactivate && !window.confirm(`Retire ${id}? It will be hidden from the fleet.`)) return;
  try {
    await api(`/api/fleet/bikes/${id}`, { method:'PATCH', body:{ active: reactivate }});
    closeModal();
    toast(`${id} ${reactivate?'reactivated':'retired'}`, 'success', async () => {
      await api(`/api/fleet/bikes/${id}`, {method:'PATCH', body:{active: reactivate ? false : true}});
      renderAdminTab(document.getElementById('content'));
    });
    renderAdminTab(document.getElementById('content'));
  } catch(e) { toast(e.message, 'error'); }
}

function iconTours(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;}
function iconAdmin(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/><path d="M12 12v9"/><path d="m15 15-3 3-3-3"/></svg>`;}

// ── PENDING ASSIGNMENTS ───────────────────────────────────────────────────
async function openAssignModal(assignmentId) {
  const assignments = await api('/api/today');
  const p = (assignments.pending || []).find(x => x.id === assignmentId);
  if (!p) { toast('Assignment not found', 'error'); return; }

  openModal(`
    <div class="modal-title">Assign bikes</div>
    <div style="margin-bottom:0.85rem">
      <div style="font-size:0.95rem;font-weight:600">${p.customer_name||'Unknown'}</div>
      <div style="font-size:0.82rem;color:var(--text2)">#${p.fareharbor_booking_ref||''} · ${p.booking_date||''} ${p.start_time||''}</div>
      <div style="font-size:0.82rem;color:var(--red);margin-top:3px">Needs: ${p.bikes_needed||'TBD'}</div>
    </div>
    <div class="form-label">Assign specific bikes</div>
    <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem">
      <input class="form-input" id="assign-input" placeholder="Type bike ID..." autocapitalize="characters"/>
      <button class="btn btn-secondary btn-sm" onclick="addAssignBike()">Add</button>
    </div>
    <div id="assign-tags" class="return-tags" style="margin-bottom:0.75rem"></div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input class="form-input" id="assign-note" placeholder="Any notes for this booking..."/>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAssignment(${assignmentId}, '${p.fareharbor_booking_ref||''}', '${p.start_time||''}', '${p.end_time||''}', '${p.booking_date||''}')">Confirm assignment</button>
    </div>`);

  window._assignBikes = [];
  document.getElementById('assign-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addAssignBike(); }
  });
}

function addAssignBike() {
  const input = document.getElementById('assign-input');
  const id = input.value.trim().toUpperCase().replace(/,/g,'');
  if (!id || window._assignBikes.includes(id)) { input.value=''; return; }
  window._assignBikes.push(id);
  input.value = '';
  const tags = document.getElementById('assign-tags');
  if (tags) tags.innerHTML = window._assignBikes.map(b =>
    `<span class="return-tag">${b}<span class="return-tag-remove" onclick="removeAssignBike('${b}')">&times;</span></span>`
  ).join('');
  input.focus();
}

function removeAssignBike(id) {
  window._assignBikes = (window._assignBikes||[]).filter(x=>x!==id);
  const tags = document.getElementById('assign-tags');
  if (tags) tags.innerHTML = window._assignBikes.map(b =>
    `<span class="return-tag">${b}<span class="return-tag-remove" onclick="removeAssignBike('${b}')">&times;</span></span>`
  ).join('');
}

async function submitAssignment(assignmentId, bookingRef, startTime, endTime, bookingDate) {
  const bikes = window._assignBikes || [];
  const note = document.getElementById('assign-note')?.value?.trim();
  if (bikes.length === 0) { toast('Add at least one bike', 'error'); return; }

  try {
    // Check out all assigned bikes
    for (const bikeId of bikes) {
      await api(`/api/bikes/${bikeId}/checkout`, { method:'POST', body:{
        assignment_type: 'rental',
        fareharbor_booking_ref: bookingRef,
        assigned_to: 'FareHarbor booking',
        note: note || null,
        return_due: bookingDate && endTime ? `${bookingDate}T${endTime}` : null,
        force: true,
      }});
    }

    // Mark assignment as assigned
    await api(`/api/assignments/${assignmentId}/assign`, { method:'POST', body:{ bike_ids: bikes, note }});

    closeModal();
    toast(`${bikes.length} bike${bikes.length>1?'s':''} assigned to #${bookingRef}`, 'success');
    await renderTab('today');
  } catch(e) { toast(e.message, 'error'); }
}

async function dismissAssignment(assignmentId) {
  await api(`/api/assignments/${assignmentId}/assign`, { method:'POST', body:{ bike_ids:[], dismissed:true }});
  toast('Dismissed', 'success');
  await renderTab('today');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d+'T00:00:00Z').toLocaleDateString('da-DK', {day:'numeric',month:'short'});
  } catch { return d; }
}

// ── TOURS TAB ─────────────────────────────────────────────────────────────
async function renderTours(c) {
  if (!window._toursTab) window._toursTab = 'tours';

  c.innerHTML = `
    <div class="subtab-row">
      <button class="subtab${window._toursTab==='tours'?' active':''}" onclick="switchToursTab('tours')">Tours</button>
      <button class="subtab${window._toursTab==='rentals'?' active':''}" onclick="switchToursTab('rentals')">Rentals</button>
    </div>
    <div id="tours-tab-content"><div class="empty-state"><p>Loading...</p></div></div>`;

  loadToursTab();
}

function switchToursTab(tab) {
  window._toursTab = tab;
  document.querySelectorAll('.subtab').forEach(b =>
    b.classList.toggle('active', b.textContent === (tab==='tours'?'Tours':'Rentals')));
  loadToursTab();
}

async function loadToursTab() {
  const el = document.getElementById('tours-tab-content');
  if (!el) return;

  if (window._toursTab === 'tours') {
    // Filter by guide if current user is a guide
    const role = state.actor?.role;
    const name = state.actor?.name;
    const isGuide = role === 'guide';
    const tours = await api('/api/ical/tours' + (isGuide ? `?guide=${encodeURIComponent(name)}` : ''));
    renderToursList(el, tours, isGuide);
  } else {
    const rentals = await api('/api/ical/rentals');
    renderRentalsList(el, rentals);
  }
}

function renderToursList(el, tours, isGuideView) {
  if (tours.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>' + (isGuideView ? 'No upcoming tours assigned to you' : 'No upcoming tours') + '</p></div>';
    return;
  }

  // Group by date
  const byDate = {};
  tours.forEach(t => {
    const d = t.start_date || t.start_at?.substring(0,10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  });

  el.innerHTML = Object.entries(byDate).map(([date, avails]) => `
    <div class="section-title">${fmtDateFull(date)}</div>
    ${avails.map(a => {
      const bikes = a.bikes_needed || {};
      const bikeStr = Object.entries(bikes)
        .filter(([,n])=>n>0)
        .map(([t,n])=>n+'× '+t)
        .join(', ');
      const needsBikes = a.total_bikes > 0;

      return `<div class="tour-card" onclick="openTourDetail('${a.availability_id}')">
        <div class="tour-card-header">
          <div>
            <span class="tour-badge">${a.feed_id}</span>
            <span class="tour-time">${a.start_time}–${a.end_time}</span>
          </div>
          <div class="tour-pax">${a.booking_count} booking${a.booking_count!==1?'s':''} · ${a.total_bikes > 0 ? a.total_bikes + ' bike' + (a.total_bikes!==1?'s':'') : 'own bikes'}</div>
        </div>
        ${a.guide ? `<div class="tour-guide">👤 ${a.guide}</div>` : '<div class="tour-no-guide">⚠️ No guide assigned yet</div>'}
        ${needsBikes ? `<div class="tour-bikes">${bikeStr}</div>` : ''}
      </div>`;
    }).join('')}
  `).join('');
}

function renderRentalsList(el, rentals) {
  if (rentals.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No upcoming rentals</p></div>';
    return;
  }

  const byDate = {};
  rentals.forEach(r => {
    const d = r.start_date || r.start_at?.substring(0,10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  });

  el.innerHTML = Object.entries(byDate).map(([date, items]) => `
    <div class="section-title">${fmtDateFull(date)}</div>
    ${items.map(r => {
      const bookings = r.bookings || [];
      return `<div class="tour-card" onclick="openRentalDetail('${r.availability_id}')">
        <div class="tour-card-header">
          <div>
            <span class="tour-badge" style="background:var(--blue-bg);color:var(--blue)">${r.feed_id}</span>
            <span class="tour-time">${r.start_time || ''}${r.end_time?'–'+r.end_time:''}</span>
          </div>
          <div class="tour-pax">${bookings.length} booking${bookings.length!==1?'s':''}</div>
        </div>
        ${bookings.slice(0,2).map(b=>`<div style="font-size:0.8rem;color:var(--text2);margin-top:2px">${b.name||''}</div>`).join('')}
        ${bookings.length > 2 ? `<div style="font-size:0.75rem;color:var(--text3)">+${bookings.length-2} more</div>` : ''}
      </div>`;
    }).join('')}
  `).join('');
}

async function openTourDetail(availId) {
  // Fetch with extended window to ensure we find it
  const tours = await api('/api/ical/tours?days=60');
  const t = tours.find(x=>String(x.availability_id)===String(availId));
  if (!t) { toast('Tour not found — try refreshing', 'error'); return; }

  const bikes = t.bikes_needed || {};
  const bikeStr = Object.entries(bikes).filter(([,n])=>n>0).map(([type,n])=>n+'× '+type).join(', ');
  const bookings = t.bookings || [];

  openModal(`
    <div class="modal-title">${t.feed_id} · ${fmtDateFull(t.start_date)}</div>
    <div style="font-size:0.88rem;color:var(--text2);margin-bottom:0.75rem">${t.start_time}–${t.end_time}</div>

    ${t.guide ? `<div class="detail-row"><span class="dr-key">Guide</span><span class="dr-val">${t.guide}</span></div>` : ''}
    ${bikeStr ? `<div class="detail-row"><span class="dr-key">Bikes needed</span><span class="dr-val" style="color:var(--red)">${bikeStr}</span></div>` : ''}
    <div class="detail-row"><span class="dr-key">Bookings</span><span class="dr-val">${bookings.length}</span></div>

    <div class="detail-section">
      <div class="detail-section-title">Bookings</div>
      ${bookings.map(b=>{
        const sourceColors = {
          'GetYourGuide': { bg:'#FFE8E2', fg:'#CC3D1F' },
          'TripAdvisor':  { bg:'#D6F5EC', fg:'#00754A' },
          'Viator':       { bg:'#D6F5EC', fg:'#00754A' },
          'Airbnb':       { bg:'#FFE2E3', fg:'#D9363E' },
        };
        const sc = sourceColors[b.source];
        const src = (b.source && b.source !== "direct" && sc)
          ? "<span style='font-size:0.68rem;font-weight:600;background:"+sc.bg+";color:"+sc.fg+";padding:2px 8px;border-radius:10px;margin-left:5px'>"+b.source+"</span>"
          : (b.source && b.source !== "direct"
              ? "<span style='font-size:0.68rem;background:var(--blue-bg);color:var(--blue);padding:1px 6px;border-radius:10px;margin-left:5px'>"+b.source+"</span>"
              : "");
        const unpaid = b.due && b.due !== "DKK0.00"
          ? "<span style='font-size:0.68rem;background:#fdecea;color:#e04040;padding:1px 6px;border-radius:10px;margin-left:4px'>Due: "+b.due+"</span>"
          : "";
        return "<div style='padding:0.65rem 0;border-bottom:1px solid var(--border)'>"
          + "<div style='display:flex;align-items:center;flex-wrap:wrap;gap:3px'>"
          + "<span style='font-weight:700;font-size:0.9rem'>"+(b.name||"Unknown")+"</span>"
          + src + unpaid
          + "</div>"
          + ((!b.created_at || new Date(b.created_at) < new Date('2026-07-01T00:00:00+02:00'))
              ? '<span style="font-size:0.7rem;font-weight:700;background:#fff4d6;color:#8a6500;padding:2px 8px;border-radius:10px;margin-left:4px;border:1px solid #e8c468">⚠️ Booked before Jul 1</span>'
              : '')
          + (b.phone ? "<div style='font-size:0.78rem;color:var(--text2);margin-top:3px'>📞 "+b.phone+"</div>" : "")
          + (b.email ? "<div style='font-size:0.72rem;color:var(--text3)'>"+b.email+"</div>" : "")
          + "<div style='font-size:0.75rem;color:var(--text3);margin-top:2px'>#"+b.ref+" · "+(b.total||"")+"</div>"
          + (b.what ? "<div style='font-size:0.8rem;color:var(--text2);margin-top:4px;font-weight:500'>"+b.what+"</div>" : "")
          + (b.heights ? "<div style='font-size:0.75rem;color:var(--blue);margin-top:3px'>📏 "+b.heights+"</div>" : "")
          + (b.comments ? "<div style='font-size:0.75rem;color:var(--amber);margin-top:3px;font-style:italic'>💬 "+b.comments+"</div>" : "")
          + (b.language ? "<div style='font-size:0.72rem;color:var(--text3)'>🌐 "+b.language+"</div>" : "")
          + "</div>";
      }).join("")}
    </div>

    ${t.url ? `<a href="${t.url}" target="_blank" class="btn btn-secondary btn-full" style="margin-top:0.5rem;text-decoration:none">Open in FareHarbor</a>` : ''}
    <button class="btn btn-primary btn-full" style="margin-top:0.5rem" onclick="closeModal();goCheckoutForTour('${t.feed_id}','${t.guide||''}')">Record bikes for this tour</button>
  `);
}

async function openRentalDetail(availId) {
  const rentals = await api('/api/ical/rentals');
  const r = rentals.find(x=>x.availability_id===availId);
  if (!r) return;
  const bookings = r.bookings || [];

  openModal(`
    <div class="modal-title">${r.feed_label} · ${fmtDateFull(r.start_date)}</div>
    <div class="detail-section" style="border-top:none;padding-top:0">
      ${bookings.map(b=>`
        <div class="detail-row" style="flex-direction:column;align-items:flex-start;gap:1px;padding:0.4rem 0">
          <span style="font-weight:600;font-size:0.88rem">${b.name||'Unknown'}</span>
          <span style="font-size:0.75rem;color:var(--text3)">#${b.ref}${b.phone?' · '+b.phone:''}</span>
          ${b.email?`<span style="font-size:0.72rem;color:var(--text3)">${b.email}</span>`:''}
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-full" style="margin-top:0.5rem" onclick="closeModal();renderTab('action')">Check out bikes</button>
  `);
}

function goCheckoutForTour(tourId, guide) {
  // Pre-set action to tour with guide name
  state.action = { type: 'tour', bikes: [], searchQ: '', preloaded: null };
  renderTab('action');
  setTimeout(() => selectActionType('tour'), 100);
}

function fmtDateFull(d) {
  if (!d) return '';
  try {
    return new Date(d+'T12:00:00Z').toLocaleDateString('en-DK', {weekday:'short',day:'numeric',month:'short'});
  } catch { return d; }
}
