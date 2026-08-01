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
  const headers = {'Content-Type':'application/json'};
  if (state.viewingAs && state.actor?.id) headers['X-View-As'] = state.actor.id;
  const r = await fetch(path, {
    headers,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) { const e=await r.json().catch(()=>({error:r.statusText})); throw new Error(e.error||r.statusText); }
  return r.json();
}

// Fire-and-forget page view logging — never blocks or throws into the caller
function logPageView(tab) {
  if (!tab) return;
  api('/api/page-view', { method: 'POST', body: { tab } }).catch(() => {});
}

// ── Toast + Undo ──────────────────────────────────────────────────────────
function toast(msg, type="", opts = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  clearTimeout(toast._timer);
  const check = type.includes('success')
    ? '<svg class="toast-check" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>'
    : '';
  const undoBtn = opts.undo ? '<button class="toast-undo-btn" id="toast-undo">Undo</button>' : '';
  el.innerHTML = check + `<span>${msg}</span>` + undoBtn;
  el.className = "toast " + type;
  el.classList.remove("hidden");
  if (opts.undo) {
    document.getElementById('toast-undo')?.addEventListener('click', () => { dismissToast(); triggerUndo(); });
  }
  // Give the user longer to reach an Undo button than a plain toast
  toast._timer = setTimeout(dismissToast, opts.undo ? 6000 : 1800);
}

function dismissToast() {
  clearTimeout(toast._timer);
  const el = document.getElementById("toast");
  if (el) el.classList.add("hidden");
}

document.getElementById("toast")?.addEventListener("click", dismissToast);

// ── Undo stack ────────────────────────────────────────────────────────────
// Fixed-depth stack of compensating actions. Each record: {label, fn}
// fn is an async function that reverses the action when popped.
const UNDO_STACK_MAX = 25;
let undoStack = [];

function pushUndo(label, fn) {
  undoStack.push({ label, fn });
  if (undoStack.length > UNDO_STACK_MAX) undoStack.shift();
  updateUndoButton();
}

function updateUndoButton() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  const hasUndo = undoStack.length > 0;
  btn.classList.toggle('live', hasUndo);
  btn.disabled = !hasUndo;
  btn.title = hasUndo ? `Undo: ${undoStack[undoStack.length-1].label}` : 'Nothing to undo';
}

async function triggerUndo() {
  const action = undoStack.pop();
  updateUndoButton();
  if (!action) return;
  try {
    await action.fn();
    toast('Undone: ' + action.label, 'success');
  } catch(e) {
    toast('Could not undo: ' + e.message, 'error');
  }
}

document.getElementById('btn-undo')?.addEventListener('click', triggerUndo);
// ── Modal ─────────────────────────────────────────────────────────────────
function openModal(html) {
  clearTimeout(closeModal._clearTimer); // reopening fast? cancel pending content wipe
  document.getElementById('modal-content').innerHTML=html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  // Let the slide-out (240ms) finish before emptying, so it doesn't visibly blank
  closeModal._clearTimer = setTimeout(() => {
    document.getElementById('modal-content').innerHTML='';
  }, 260);
}
document.getElementById('modal-close').addEventListener('click',closeModal);
document.getElementById('modal-overlay').addEventListener('click',e=>{
  if(e.target===document.getElementById('modal-overlay')) closeModal();
});

// ── Identity & Auth ──────────────────────────────────────────────────────
state.pendingMemberId = null;
const GUIDE_EMOJIS = ['🧑\u200d🦱','👩\u200d🦰','🧑\u200d🦳','👨\u200d🦲','👩\u200d🦱','🧑\u200d🦰','👨\u200d🦳','👩\u200d🦲','🧑','👩','👨','🧑\u200d🎓'];

function roleEmoji(role) {
  const map = { admin: '⭐', mechanic: '🔧', guide: '🧑' };
  return map[role] || '👤';
}

function guideEmoji(memberId) {
  // Deterministic "random" based on ID so it stays consistent across renders
  let hash = 0;
  for (let i = 0; i < memberId.length; i++) hash = (hash * 31 + memberId.charCodeAt(i)) >>> 0;
  return GUIDE_EMOJIS[hash % GUIDE_EMOJIS.length];
}

function guideEmojiByName(name) {
  // Same deterministic approach but keyed by the display name string (used on Tours cards)
  let hash = 0;
  const s = (name || '').toLowerCase();
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return GUIDE_EMOJIS[hash % GUIDE_EMOJIS.length];
}



async function initIdentity() {
  // Resume an active shop_mode session if one exists
  const sessionCheck = await api('/session/me').catch(() => ({}));
  if (sessionCheck.shop_mode) {
    state.shopMode = true;
    state.actor = { id: 'shop', name: 'Shop', role: 'shop' };
    showMain();
    return;
  }
  await showTeamPicker();
}

async function showTeamPicker() {
  // Login is email + password. We deliberately no longer list the team here:
  // an unauthenticated visitor shouldn't see who works here or who is an admin.
  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
      </div>
      <p class="identity-prompt">Sign in</p>
      <div class="login-form">
        <div class="form-group">
          <input class="form-input" type="email" id="login-email" placeholder="Email" autocomplete="username" autocapitalize="none" spellcheck="false"/>
        </div>
        <div class="form-group">
          <input class="form-input" type="password" id="login-password" placeholder="Password" autocomplete="current-password"/>
        </div>
        <div id="login-error" style="color:#e04040;font-size:0.85rem;min-height:1.1rem;margin-bottom:0.4rem"></div>
        <button class="btn btn-primary btn-full" id="login-submit">Sign in</button>
        <button class="btn-link" id="login-forgot" type="button">Set up / forgot password</button>
      </div>
    </div>`;

  const submit = () => submitEmailLogin();
  document.getElementById('login-submit').addEventListener('click', submit);
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });
  document.getElementById('login-forgot').addEventListener('click', showForgotByEmail);

  // Counter Mode entry point (shared device — no personal login)
  const wrap = document.querySelector('.identity-wrap');
  const shopBtn = document.createElement('button');
  shopBtn.id = 'shop-mode-entry-btn';
  shopBtn.className = 'shop-mode-entry';
  shopBtn.innerHTML = '🏪 Counter Mode (shared device)';
  shopBtn.onclick = () => initShopMode();
  wrap.appendChild(shopBtn);
}

async function submitEmailLogin() {
  const email = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-password')?.value;
  const err = document.getElementById('login-error');
  const btn = document.getElementById('login-submit');
  if (err) err.textContent = '';
  if (!email || !password) { if (err) err.textContent = 'Enter your email and password'; return; }

  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const data = await api('/auth/login-email', { method:'POST', body:{ email, password } });
    state.actor = data.actor;
    showMain();
  } catch(e) {
    if (err) err.textContent = e.message || 'Incorrect email or password';
    const pw = document.getElementById('login-password');
    if (pw) { pw.value = ''; pw.focus(); }
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

function showForgotByEmail() {
  const prefill = document.getElementById('login-email')?.value?.trim() || '';
  openModal(`
    <div class="modal-title">Set up / reset password</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">Enter your work email and we'll send you a link to set a new password.</p>
    <div class="form-group">
      <input class="form-input" type="email" id="forgot-email" placeholder="you@example.com" value="${prefill}" autocapitalize="none" spellcheck="false" autofocus/>
    </div>
    <div id="forgot-status" style="font-size:0.85rem;margin-bottom:0.75rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="forgot-send">Send link</button>
    </div>
  `);
  document.getElementById('forgot-send').addEventListener('click', async () => {
    const email = document.getElementById('forgot-email')?.value?.trim();
    const status = document.getElementById('forgot-status');
    const btn = document.getElementById('forgot-send');
    if (!email) { if (status) { status.style.color = '#e04040'; status.textContent = 'Enter your email'; } return; }
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const data = await api('/auth/forgot-password-email', { method:'POST', body:{ email }});
      if (status) { status.style.color = 'var(--text2)'; status.textContent = data.message || 'Check your inbox.'; }
    } catch(e) {
      if (status) { status.style.color = '#e04040'; status.textContent = e.message; }
    } finally {
      btn.disabled = false; btn.textContent = 'Send link';
    }
  });
}

async function selectMember(memberId) {
  state.pendingMemberId = memberId;
  try {
    const data = await api('/auth/check-member', { method:'POST', body:{ member_id: memberId } });
    if (data.needs_setup) {
      showConfirmEmailScreen(memberId, data.email_on_file);
    } else {
      showPasswordScreen(memberId);
    }
  } catch(e) {
    toast('Could not check account: ' + e.message, 'error');
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
  const err = document.getElementById('login-error');
  if (!password) {
    if (err) err.textContent = 'Password required';
    return;
  }
  try {
    const data = await api('/auth/login', { method:'POST', body:{ member_id: memberId, password } });
    if (!data?.actor?.id) {
      // Defensive: never treat a response without a real actor as a successful login
      if (err) err.textContent = 'Login failed — please try again';
      return;
    }
    state.actor = data.actor;
    closeModal();
    showMain();
  } catch(e) {
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

// Password reset via the emailed link (/reset-password?token=...). The SPA
// otherwise ignores the token and falls through to the login screen (see Boot).
// Renders the sign-in screen as a backdrop, then prompts for a new password and
// posts it with the token to /auth/reset-password.
async function showResetPasswordScreen(token) {
  document.getElementById('screen-identity').classList.add('active');
  document.getElementById('screen-identity').style.display = 'flex';
  await showTeamPicker();
  openModal(`
    <div class="modal-title">Choose a new password</div>
    <div class="form-group">
      <input class="form-input" type="password" id="reset-password" placeholder="New password (min 6 characters)" autocomplete="new-password" autofocus/>
    </div>
    <div class="form-group">
      <input class="form-input" type="password" id="reset-password-confirm" placeholder="Confirm new password" autocomplete="new-password"/>
    </div>
    <div id="reset-error" style="color:#e04040;font-size:0.85rem;min-height:1.1rem;margin-bottom:0.4rem"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="submitResetPassword('${token}')">Set new password</button>
    </div>
  `);
}

async function submitResetPassword(token) {
  const pw = document.getElementById('reset-password')?.value;
  const pwConfirm = document.getElementById('reset-password-confirm')?.value;
  const err = document.getElementById('reset-error');
  if (pw !== pwConfirm) { if (err) err.textContent = 'Passwords do not match'; return; }
  if (!pw || pw.length < 6) { if (err) err.textContent = 'Password must be at least 6 characters'; return; }

  try {
    await api('/auth/reset-password', { method:'POST', body:{ token, password: pw }});
    // Strip the now-used token from the URL so a refresh can't replay a spent link.
    history.replaceState({}, '', '/');
    closeModal();
    await showTeamPicker();
    const loginErr = document.getElementById('login-error');
    if (loginErr) { loginErr.style.color = 'var(--text2)'; loginErr.textContent = 'Password updated — please sign in.'; }
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
  if (state.shopMode) {
    openModal(`
      <div class="modal-title">Exit Counter Mode?</div>
      <p style="font-size:0.9rem;color:var(--text2);margin-bottom:1.25rem">This will log out of the shared shop device and return to normal login. Use this on personal phones, not the shop iPad.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="closeModal();exitShopMode()">Exit Counter Mode</button>
      </div>
    `);
    return;
  }
  api('/session/logout', { method:'POST' }).then(() => {
    state.actor = null;
    document.getElementById('screen-main').classList.remove('active');
    document.getElementById('screen-main').style.display = 'none';
    document.getElementById('screen-identity').classList.add('active');
    document.getElementById('screen-identity').style.display = 'flex';
    initIdentity();
  });
}

async function exitShopMode() {
  await api('/session/logout', { method:'POST' });
  state.shopMode = false;
  state.actor = null;
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-main').style.display = 'none';
  document.getElementById('screen-identity').classList.add('active');
  document.getElementById('screen-identity').style.display = 'flex';
  // Force the normal team picker directly rather than re-checking session
  // state, since immediately re-querying /session/me right after logout
  // can occasionally race with cookie clearing.
  await showTeamPicker();
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

function pinDotsHtml(id) {
  return `<div class="pin-dots" id="${id}-dots">
    <span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span><span class="pin-dot"></span>
  </div>`;
}

function pinKeypadHtml(id) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return `<div class="pin-keypad">
    ${keys.map(k => k === '' ? '<div></div>' :
      `<button type="button" class="pin-key" onclick="pinKeyPress('${id}','${k}')">${k}</button>`
    ).join('')}
  </div>`;
}

function pinKeyPress(id, key) {
  const input = document.getElementById(id);
  let val = input.value;
  if (key === '⌫') val = val.slice(0, -1);
  else if (val.length < 4) val += key;
  input.value = val;
  updatePinDots(id);
  if (val.length === 4) {
    if (id === 'shop-pin-setup') submitShopPinSetup();
    else submitShopPin();
  }
}

function updatePinDots(id) {
  const val = document.getElementById(id)?.value || '';
  const dots = document.querySelectorAll(`#${id}-dots .pin-dot`);
  dots.forEach((d, i) => d.classList.toggle('filled', i < val.length));
}

function showShopPinSetup() {
  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
        <div class="bc-sub-label">Counter Mode Setup</div>
      </div>
      <p style="font-size:0.85rem;color:var(--text2);text-align:center;margin-bottom:1rem">Set a 4-digit PIN for this shop device.</p>
      <input type="hidden" id="shop-pin-setup" value=""/>
      ${pinDotsHtml('shop-pin-setup')}
      ${pinKeypadHtml('shop-pin-setup')}
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
        <div class="bc-sub-label">Counter Mode</div>
      </div>
      <input type="hidden" id="shop-pin-entry" value=""/>
      ${pinDotsHtml('shop-pin-entry')}
      <div id="shop-pin-error" style="color:#e04040;font-size:0.85rem;margin:0.5rem 0;text-align:center"></div>
      ${pinKeypadHtml('shop-pin-entry')}
      <button class="btn-link" id="leave-counter-mode" type="button">Not the shop iPad? Sign in with email</button>
    </div>`;
  // Escape hatch: without this, a device whose session has shop_mode set is
  // stuck on this PIN screen forever, with no route back to the normal login.
  document.getElementById('leave-counter-mode')?.addEventListener('click', exitShopMode);
}

async function submitShopPin() {
  const pin = document.getElementById('shop-pin-entry')?.value;
  try {
    await api('/auth/shop-login', { method:'POST', body:{ pin }});
    state.shopMode = true;
    state.actor = { id: 'shop', name: 'Shop', role: 'shop' };
    showMain();
  } catch(e) {
    const err = document.getElementById('shop-pin-error');
    if (err) err.textContent = e.message || 'Something went wrong';
    const input = document.getElementById('shop-pin-entry');
    if (input) { input.value = ''; updatePinDots('shop-pin-entry'); }
    console.error('Shop PIN error:', e);
  }
}

async function showShopWhoAreYou() {
  state.shopMode = true;
  let team;
  try {
    team = await api('/auth/team');
  } catch(e) {
    console.error('Failed to load team for shop mode:', e);
    toast('Could not load team list', 'error');
    return;
  }
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
    <button class="identity-btn" data-id="${m.id}">
      <span class="iname">${m.name}</span>
    </button>`).join('');
  grid.querySelectorAll('.identity-btn').forEach(btn=>{
    btn.addEventListener('click', async () => {
      const data = await api('/auth/shop-set-actor', { method:'POST', body:{ member_id: btn.dataset.id }});
      state.actor = data.actor;
      showMain();
    });
  });
}

function landingTab() {
  if (state.shopMode) return 'today';   // counter opens on the day's board too
  const v = activeView();
  if (v === 'admin') return 'operations';
  if (v === 'shop') return 'today';
  return 'action'; // guide
}

function showMain() {
  document.getElementById('screen-identity').classList.remove('active');
  document.getElementById('screen-identity').style.display='none';
  document.getElementById('screen-main').classList.add('active');
  document.getElementById('screen-main').style.display='flex';
  document.getElementById('actor-badge').textContent = state.shopMode ? ('🏪 ' + state.actor.name) : state.actor.name;
  buildTabbar();
  renderTab(landingTab());
  if (!state.shopMode) { checkBorrowedReminder(); refreshReturnAllBanner(); }
  if (state.actor?.role === 'admin') startNotifPolling();
}

// Which views a person can work in, from their CAPABILITIES. `role` remains a
// pure permission (server-enforced); what you SEE now comes from capabilities.
function availableViews() {
  const a = state.actor || {};
  const views = [];
  if (a.can_shop || a.role === 'mechanic' || a.role === 'admin') views.push('shop');
  if (a.is_guide || a.role === 'guide') views.push('guide');
  if (a.role === 'admin') views.push('admin');
  return views.length ? views : ['guide'];
}

// The hat you're wearing right now. Remembered per person.
function activeView() {
  const views = availableViews();
  // While previewing someone else, ignore the saved hat — show THEIR default.
  const saved = state.viewingAs ? state.activeView
    : (state.activeView || (() => { try { return localStorage.getItem('bcf_view_' + (state.actor?.id||'')); } catch { return null; } })());
  if (saved && views.includes(saved)) return saved;
  if (views.includes('admin')) return 'admin';   // admins land in admin, as today
  if (views.includes('guide') && views.length === 1) return 'guide';
  return views[0];
}

function setActiveView(v) {
  if (!availableViews().includes(v)) return;
  state.activeView = v;
  if (!state.viewingAs) { try { localStorage.setItem('bcf_view_' + (state.actor?.id||''), v); } catch {} }
  buildTabbar();
  renderTab(landingTab());
}

function buildTabbar() {
  if (state.shopMode) {
    document.getElementById('btn-more-menu')?.classList.add('hidden');
    // Counter (shared iPad) sees the same operational picture as a logged-in
    // shopkeeper — today's board, checkouts, repairs, tours, rentals, bikes —
    // so whoever is on the floor has the full picture. Fleet is deliberately
    // left out: it edits the bike CATALOGUE (add/retire/recode), which is a
    // rare, destructive, accountable action that shouldn't sit on an unlocked
    // shared device. Same reason the counter keeps its restricted action set.
    const tabs = [
      {id:'today',label:'Today',icon:iconToday()},
      {id:'action',label:'Action',icon:iconAction()},
      {id:'tickets',label:'Repairs',icon:iconTicket()},
      {id:'tours',label:'Tours',icon:iconTours()},
      {id:'rentals',label:'Rentals',icon:iconRentals()},
      {id:'bikes',label:'Bikes',icon:iconBike()},
    ];
    document.getElementById('tabbar').innerHTML=tabs.map(t=>`
      <button class="tab-btn${t.id===state.currentTab?' active':''}" data-tab="${t.id}">
        ${t.icon}<span>${t.label}</span>
      </button>`).join('');
    document.getElementById('tabbar').querySelectorAll('.tab-btn').forEach(btn=>{
      btn.addEventListener('click',()=>renderTab(btn.dataset.tab));
    });
    return;
  }
  const view = activeView();
  document.getElementById('btn-more-menu')?.classList.toggle('hidden', view !== 'guide');
  // SHOP = mechanic + shopkeeper merged. Includes Tours (so the shop can see
  // which customers are coming when, and prep the right bikes) and Repairs.
  const tabs = view==='shop'
    ? [{id:'today',label:'Today',icon:iconToday()},{id:'action',label:'Action',icon:iconAction()},{id:'tickets',label:'Repairs',icon:iconTicket()},{id:'tours',label:'Tours',icon:iconTours()},{id:'rentals',label:'Rentals',icon:iconRentals()},{id:'bikes',label:'Bikes',icon:iconBike()},{id:'log',label:'Log',icon:iconLog()}]
    : view==='admin'
    ? [{id:'operations',label:'Operations',icon:iconOperations()},{id:'bikes',label:'Bikes',icon:iconBike()},{id:'guides-admin',label:'Guides',icon:iconGuidesTab()},{id:'log',label:'Log',icon:iconLog()},{id:'app-admin',label:'App',icon:iconApp()},{id:'notifs-admin',label:'Alerts',icon:iconNotifs()}]
    : [{id:'action',label:'Action',icon:iconAction()},{id:'tours',label:'Tours',icon:iconTours()},{id:'profile',label:'Profile',icon:iconProfile()},{id:'log',label:'Log',icon:iconLog()}];
  document.getElementById('tabbar').innerHTML=tabs.map(t=>`
    <button class="tab-btn${t.id===state.currentTab?' active':''}" data-tab="${t.id}">
      ${t.icon}<span>${t.label}</span>
    </button>`).join('');
  document.getElementById('tabbar').querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>renderTab(btn.dataset.tab));
  });
  renderViewSwitcher();
}

// Shown only to people who can work in more than one view (Fede, Hassan).
// Single-capability people see nothing — their experience is unchanged.
function renderViewSwitcher() {
  const host = document.getElementById('view-switcher');
  if (!host) return;
  const views = availableViews();
  if (views.length < 2) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  const labels = { shop:'Shop', guide:'Guide', admin:'Admin' };
  const cur = activeView();
  host.classList.remove('hidden');
  host.innerHTML = views.map(v => `<button class="vs-btn${v===cur?' active':''}" data-view="${v}">${labels[v]||v}</button>`).join('');
  host.querySelectorAll('.vs-btn').forEach(b => b.addEventListener('click', () => setActiveView(b.dataset.view)));
}

function setActiveTab(id) {
  state.currentTab=id;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
}

function skeletonHTML() {
  return '<div class="skel skel-block"></div><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-block"></div>';
}

// Tick visible counters (fleet availability numbers) up from 0 — quick, subtle
function animateCounts(root) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.tc-avail').forEach(el => {
    const target = parseInt(el.textContent, 10);
    if (!Number.isFinite(target) || target <= 0) return;
    const t0 = performance.now(), dur = 300;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(target * (p * (2 - p))); // ease-out
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function renderTab(id) {
  setActiveTab(id);
  logPageView(id);
  const titles={bikes:'Bikes',action:'Action',log:'Log',tickets:'Tickets',tours:'Tours',rentals:'Rentals',profile:'Profile',operations:'Operations',fleet:'Fleet','guides-admin':'Guides & Tours','notifs-admin':'Alerts','app-admin':'App',today:'Today'};
  document.getElementById('view-title').textContent=titles[id]||id;
  const c=document.getElementById('content');
  if(id!=='action') c.innerHTML = skeletonHTML(); // action renders instantly, no fetch
  if(id==='bikes') await renderBikesTab(c);
  else if(id==='today') await renderTodayBoard(c);
  else if(id==='action') renderAction(c);
  else if(id==='log') await renderLog(c);
  else if(id==='tickets') await renderTickets(c);
  else if(id==='tours') await renderTours(c);
  else if(id==='rentals') await renderRentals(c);
  else if(id==='profile') await renderProfile(c);
  else if(id==='operations') await renderOperations(c);
  else if(id==='fleet') await renderFleetAdmin(c);
  else if(id==='guides-admin') await renderGuidesAdmin(c);
  else if(id==='notifs-admin') await renderNotifsAdmin(c);
  else if(id==='app-admin') await renderAppAdmin(c);
  c.classList.remove('tab-enter'); void c.offsetWidth; // restart the enter animation
  c.classList.add('tab-enter');
  animateCounts(c);
}

function openMoreMenu() {
  openModal(`
    <div class="modal-title">More</div>
    <button class="btn btn-secondary btn-full" style="margin-bottom:0.5rem;display:flex;align-items:center;gap:8px;justify-content:center" onclick="closeModal();renderTab('rentals')">${iconRentals()} Rentals</button>
    <button class="btn btn-secondary btn-full" style="display:flex;align-items:center;gap:8px;justify-content:center" onclick="closeModal();renderTab('bikes')">${iconBike()} Bikes</button>
  `);
}
document.getElementById('btn-more-menu')?.addEventListener('click', openMoreMenu);

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
// Bikes tab = the live picture (what's available / out / in repair) and the
// fleet catalogue (add / edit / retire bikes) as two sub-tabs. They were two
// separate bottom tabs, which crowded the bar — but they're different jobs
// (daily status vs. rare catalogue editing), so they stay distinct here.
async function renderBikesTab(c) {
  // Counter Mode (shared, unauthenticated iPad) gets the live status only —
  // the Fleet catalogue (add/retire/recode bikes) is destructive and needs to
  // be attributable to a person, so it stays off the shared device.
  if (state.shopMode) return renderBikes(c);

  if (!window._bikesTab) window._bikesTab = 'status';
  const tabs = [['status','Status'],['fleet','Fleet']];
  c.innerHTML = `
    <div class="subtab-row">
      ${tabs.map(([id,label])=>`<button class="subtab${window._bikesTab===id?' active':''}" data-bikestab="${id}" onclick="switchBikesTab('${id}')">${label}</button>`).join('')}
    </div>
    <div id="bikes-tab-content"></div>`;
  await renderBikesSubTab();
}

async function switchBikesTab(tab) {
  window._bikesTab = tab;
  logPageView(`bikes.${tab}`);
  document.querySelectorAll('[data-bikestab]').forEach(b => b.classList.toggle('active', b.dataset.bikestab === tab));
  await renderBikesSubTab();
}

async function renderBikesSubTab() {
  const el = document.getElementById('bikes-tab-content');
  if (!el) return;
  if (window._bikesTab === 'fleet') await renderAdminBikes(el);
  else await renderBikes(el);
}

// 7-day forward availability grid (Bikes tab). One row per type, one column
// per day, cell = units still free that day counting tours + rentals booked in
// FareHarbor. bike_status is deliberately ignored (not maintained). Zero cells
// show the next day within the window the type frees up again.
function wk7Grid(week) {
  const dayHead = week.days.map((d, i) => {
    const dt = new Date(d + 'T12:00');
    const dow = dt.toLocaleDateString('en-GB', { weekday: 'short' }).substring(0, 2);
    return `<div class="wk7-h${i === 0 ? ' wk7-today' : ''}">${i === 0 ? 'Now' : dow}<em>${dt.getDate()}</em></div>`;
  }).join('');

  const rows = week.types.filter(t => t.supply > 0).map(t => {
    const cells = t.free.map((f, i) => {
      const cls = f <= 0 ? 'red' : f === 1 ? 'amber' : 'green';
      let next = '';
      if (f <= 0) {
        const j = t.free.findIndex((v, k) => k > i && v > 0);
        if (j !== -1) next = `<em>→${new Date(week.days[j] + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short' }).substring(0, 2)}</em>`;
      }
      const over = f < 0 ? ` title="overcommitted by ${-f}"` : '';
      return `<div class="wk7-cell ${cls}"${over}><span>${Math.max(f, 0)}${f < 0 ? '!' : ''}</span>${next}</div>`;
    }).join('');
    return `<div class="wk7-type"><strong>${t.id}</strong><em>${escapeHtml(t.label)}</em></div>${cells}`;
  }).join('');

  return `<div class="wk7-grid"><div class="wk7-type wk7-corner"></div>${dayHead}${rows}</div>
    <div class="wk7-note">All FareHarbor bookings, walk-ins included — bikes in repair not subtracted</div>`;
}

async function renderBikes(c) {
  const [avail, week] = await Promise.all([
    api('/api/availability'),
    api('/api/availability/week').catch(() => null),
  ]);
  const types = avail.types;
  const scarce = new Set(['CC','E','SA','AC','AT']);

  const gridCards = types.map(t=>{
    const avl=t.available||0,total=t.total||0,pct=total?avl/total:0;
    const cls=pct===0?'red':pct<=0.4?'amber':'green';
    return '<div class="type-card'+(scarce.has(t.type_id)&&pct<=0.5?' scarce':'')+(pct===0?' empty':'')+'" onclick="drillType(\''+t.type_id+'\')">'
      +'<div class="tc-label">'+t.label+'</div>'
      +'<div class="tc-nums"><span class="tc-avail '+cls+'">'+avl+'</span><span class="tc-total">/ '+total+'</span></div>'
      +'<div class="tc-pips">'
      +(t.out>0?'<span class="tc-pip out">'+t.out+' out</span>':'')
      +(t.repair>0?'<span class="tc-pip repair">'+t.repair+' repair</span>':'')
      +((t.missing||0)>0?'<span class="tc-pip repair">'+t.missing+' missing</span>':'')
      +'</div></div>';
  }).join('');

  c.innerHTML=`
    ${week ? `
    <details class="availability-summary" ${window._bikesWeekOpen!==false?'open':''} ontoggle="window._bikesWeekOpen=this.open">
      <summary>📅 Next 7 days</summary>
      ${wk7Grid(week)}
    </details>` : ''}
    <details class="availability-summary" ${window._bikesGridOpen!==false?'open':''} ontoggle="window._bikesGridOpen=this.open">
      <summary>📊 Fleet availability</summary>
      <div class="type-grid" style="margin-top:0.75rem">${gridCards}</div>
    </details>
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
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.85rem">
      <div class="section-title" style="margin:0">What are you doing?</div>
      ${state.shopMode ? '' : `<button class="btn btn-sm btn-secondary" onclick="openStandaloneBookingModal()">+ Booking</button>`}
    </div>
    ${state.action.bikes.length>0?`<div class="selected-bikes-bar">
      <span class="sbb-label">Selected:</span>
      ${state.action.bikes.map(id=>`<span class="return-tag">${id}<span class="return-tag-remove" onclick="toggleBike('${id}','','');renderAction(document.getElementById('content'))">&times;</span></span>`).join('')}
    </div>`:''}
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

// Add a borrowed "lifesaver" bike from across the street to the current checkout.
async function addExternalBike() {
  const bikes = await api('/api/bikes').catch(() => []);
  const ext = bikes.filter(b => (b.type_id === 'EXT' || b.type_label === 'External') && b.status === 'available' && !state.action.bikes.includes(b.id));
  if (!ext.length) { toast('No external bikes free — add more in Fleet', 'error'); return; }
  toggleBike(ext[0].id, ext[0].name || 'External', 'available');
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
      ${['rental','tour','city','borrowed'].includes(actionId) ? `<button class="btn btn-secondary btn-sm" style="margin-top:0.4rem;width:100%" onclick="addExternalBike()">+ External bike (borrowed)</button>` : ''}
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

  if(actionId==='rental') {
    const fb = state.action.fromBooking; // set when checking out an existing booking
    const fields = `
      <div class="form-group">
        <label class="form-label">Customer name</label>
        <input class="form-input" id="af-name" placeholder="Name"/>
      </div>
      <div class="form-group">
        <label class="form-label">Phone (optional)</label>
        <input class="form-input" id="af-phone" placeholder="+45..."/>
      </div>
      <div class="form-group">
        <label class="form-label">Email (optional)</label>
        <input class="form-input" id="af-email" placeholder="customer@email.com"/>
      </div>
      <div class="form-group">
        <label class="form-label">When</label>
        <select class="form-select" id="af-when" onchange="document.getElementById('af-future-datetime').style.display = this.value==='future' ? 'block' : 'none'">
          <option value="now">Walk-in — starting now</option>
          <option value="future">Future booking — pick date/time</option>
        </select>
      </div>
      <div class="form-group" id="af-future-datetime" style="display:none">
        <label class="form-label">Start date &amp; time</label>
        <input class="form-input" id="af-start-datetime" type="datetime-local"/>
      </div>
      <div class="form-group">
        <label class="form-label">Number of days</label>
        <select class="form-select" id="af-days">
          ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14].map(n=>`<option value="${n}">${n} day${n>1?'s':''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Payment method</label>
        <select class="form-select" id="af-payment">
          <option value="">— not paid yet —</option>
          <option value="cash">Cash</option>
          <option value="card">Card terminal / POS</option>
          <option value="online">Already paid online</option>
        </select>
      </div>
      <div class="toggle-row" style="padding-top:0.5rem">
        <span class="toggle-label">Create booking in FareHarbor</span>
        <label class="toggle"><input type="checkbox" id="af-create-fh" ${fb ? '' : 'checked'}/><span class="toggle-track"></span></label>
      </div>
      <div class="form-group" style="margin-top:0.5rem;margin-bottom:0">
        <label class="form-label">Return due (optional)</label>
        <input class="form-input" id="af-due" type="datetime-local"/>
      </div>`;

    // Existing booking: the customer is already known and the booking already
    // lives in FareHarbor — show a compact header and tuck the form under a
    // toggle so the shop can just pick the bike. Walk-in: show the full form.
    if (fb) return `
      <div class="action-details-card">
        <input type="hidden" id="af-ref" value="${fb.ref || ''}"/>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem">
          <span style="font-weight:700;font-size:0.95rem">${escapeHtml(fb.name || 'Booking')}</span>
          ${fb.ref ? `<span style="font-size:0.75rem;color:var(--text3)">#${fb.ref}</span>` : ''}
        </div>
        <details style="margin-top:0.4rem">
          <summary style="font-size:0.8rem;color:var(--text2);cursor:pointer;padding:0.3rem 0;list-style:none;display:flex;align-items:center;gap:0.4rem"><span>▶</span> Booking &amp; payment details</summary>
          <div style="padding-top:0.5rem">${fields}</div>
        </details>
      </div>`;

    return `<div class="action-details-card">${fields}</div>`;
  }

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

async function addBikeById() {
  const input = document.getElementById('bike-adder-input');
  const raw = input.value.trim().toUpperCase().replace(/,/g,'');
  if(!raw) return;

  try {
    await api(`/api/bikes/${raw}`);
  } catch(e) {
    toast(`${raw} is not a real bike`, 'error');
    input.value = '';
    input.focus();
    return;
  }

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
  if (input?.value?.trim()) await addBikeById();

  const {type, bikes} = state.action;
  if(!type){toast('Select an action type first','error');return;}
  if(bikes.length===0){toast('No bike selected — type a bike ID and tap Add','error');return;}
  const actor = state.actor?.id||'unknown';

  // Before a return wipes the assignment, snapshot each bike's current state so
  // undo can put it back exactly (customer, booking ref, due date) rather than
  // re-checking it out as a generic rental.
  if (type === 'return') {
    const snap = {};
    await Promise.all(bikes.map(async (id) => {
      try {
        const b = await api(`/api/bikes/${id}`);
        snap[id] = {
          assignment_type: b.assignment_type, assigned_to: b.assigned_to,
          customer_name: b.customer_name, fareharbor_booking_ref: b.fareharbor_booking_ref,
          return_due: b.return_due, note: b.status_note,
        };
      } catch {}
    }));
    state.action._preReturn = snap;
  }

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

    // Create a single FareHarbor booking covering all bikes in this rental
    if (type === 'rental' && document.getElementById('af-create-fh')?.checked) {
      const customerName = document.getElementById('af-name')?.value?.trim();
      const phone = document.getElementById('af-phone')?.value?.trim();
      const email = document.getElementById('af-email')?.value?.trim();
      const days = parseInt(document.getElementById('af-days')?.value) || 1;
      const payment = document.getElementById('af-payment')?.value || '';
      const when = document.getElementById('af-when')?.value || 'now';
      const startDatetime = document.getElementById('af-start-datetime')?.value || null;

      if (when === 'future' && !startDatetime) {
        toast('Pick a date and time for the future booking', 'error');
        return;
      }

      if (customerName) {
        toast('Creating FareHarbor booking...', '');
        try {
          const fhResult = await api('/api/fareharbor-agent/create-booking', { method:'POST', body:{
            customer_name: customerName, phone, email, days, payment_method: payment,
            bike_ids: bikes, start_datetime: when === 'future' ? startDatetime : null,
          }});
          if (fhResult?.booking_ref) {
            for (const bikeId of bikes) {
              await api(`/api/bikes/${bikeId}/checkout`, {method:'POST', body:{
                fareharbor_booking_ref: fhResult.booking_ref, force:true,
                assignment_type:'rental', assigned_to: customerName,
              }});
            }
            toast(`FareHarbor booking #${fhResult.booking_ref} created`, 'success');
          }
        } catch(e) {
          // This is important and easy to miss as a quick toast — show a
          // non-dismissible modal instead so it can't be scrolled past unseen.
          openModal(`
            <div class="modal-title" style="color:var(--red)">⚠️ FareHarbor booking failed</div>
            <p style="font-size:0.9rem;color:var(--text2);margin-bottom:1rem">
              The bike${bikes.length>1?'s are':' is'} still checked out in the app, but <strong>no booking was created on FareHarbor</strong>. You may need to create it manually.
            </p>
            <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:0.75rem;font-size:0.82rem;color:var(--text2);margin-bottom:1rem;font-family:monospace">
              ${e.message}
            </div>
            <button class="btn btn-primary btn-full" onclick="closeModal()">Got it</button>
          `);
        }
      }
    }

    const label = submitLabel(type, bikes.length);

    // Build undo function based on action type
    let undoFn = null;
    if (type === 'return') {
      // Restore each bike EXACTLY as it was: same assignment type, customer,
      // booking ref and due date. (state.action._preReturn was captured before
      // the return ran — without it, undo could only re-check-out a generic
      // rental and would silently lose the customer and booking link.)
      const prev = state.action._preReturn || {};
      undoFn = async () => {
        for (const id of bikes) {
          const p = prev[id];
          await api(`/api/bikes/${id}/checkout`, {method:'POST', body: p ? {
            assignment_type: p.assignment_type || 'rental',
            assigned_to: p.assigned_to || '',
            customer_name: p.customer_name || '',
            fareharbor_booking_ref: p.fareharbor_booking_ref || '',
            return_due: p.return_due || '',
            note: p.note || '',
            force: true,
          } : {assignment_type:'rental', assigned_to:'(undone return)', force:true}});
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

    toast(`Done — ${label.toLowerCase()}`, 'success', { undo: !!undoFn });
    if (undoFn) pushUndo(label.toLowerCase(), undoFn);

    if (state.shopMode) {
      const completedBikes = [...bikes];
      state.action = { type: null, bikes: [], searchQ: '', preloaded: null };
      setTimeout(() => showShopWhoDidThis(completedBikes), 600);
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

    // A tour checkout or a return changes what the guide has out — keep the
    // "Return all my tour bikes" banner in sync.
    refreshReturnAllBanner();

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
        ${state.shopMode
          ? `<span style="font-size:0.72rem;color:var(--text3);align-self:center">Log in as yourself to resolve</span>`
          : `<button class="btn btn-sm btn-success" onclick="resolveTicket(${t.id},'${t.bike_id}')">✓ Resolved</button>`}
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
    toast('Complexity updated', 'success');
    pushUndo('complexity change', async () => {
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
    toast(canRent ? 'Marked: can rent' : 'Marked: off fleet', 'success');
    pushUndo(canRent ? 'can-rent toggle' : 'off-fleet toggle', async () => {
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
    toast('Ticket resolved', 'success');
    pushUndo('ticket resolved', async () => {
      await api(`/api/repairs/${ticketId}`, { method:'PATCH', body:{ status:'open' }});
      if (bikeId) await api(`/api/bikes/${bikeId}/return`, {method:'POST', body:{new_status:'repair', note:'Undo resolve'}});
      await renderTab('tickets');
    });
  } catch(e) { toast(e.message, 'error'); }
}

// ── LOG ───────────────────────────────────────────────────────────────────
const LOG_FILTERS = [
  ['all','All'], ['checkout','Checkouts'], ['return','Returns'], ['repair_ticket','Repairs'], ['city','Left in city'],
];

async function renderLog(c) {
  if (!window._logFilter) window._logFilter = 'all';
  const log = await api('/api/log?limit=150');
  const iconMap={checkout:'out',return:'ret',bulk_return:'ret',repair_ticket:'issue',city:'city'};
  const labelMap={checkout:'OUT',return:'RTN',bulk_return:'RTN',repair_ticket:'FIX',city:'PIN'};

  const f = window._logFilter;
  const shown = log.filter(l => {
    if (f === 'all') return true;
    if (f === 'return') return l.action === 'return' || l.action === 'bulk_return';
    return l.action === f;
  });

  c.innerHTML = `
    <div class="chip-row" style="margin:0.2rem 0 0.85rem">
      ${LOG_FILTERS.map(([id,label]) => `<button class="chip${f===id?' active':''}" data-logf="${id}" onclick="setLogFilter('${id}')">${label}</button>`).join('')}
    </div>
    <div class="bike-list">
      ${shown.map(l=>{
        const d=JSON.parse(l.details||'{}');
        const who=d.customer_name||d.assigned_to||'';
        // Every bike action is correctable after the fact — this is the screen
        // you come to when you realise something was recorded wrong.
        const fixable = !!l.bike_id;
        return `<div class="activity-row"${fixable ? ` onclick="openLogFix('${l.bike_id}', ${l.id})" style="cursor:pointer"` : ''}>
          <div class="ar-icon ${iconMap[l.action]||'ret'}">${labelMap[l.action]||'···'}</div>
          <div class="ar-body">
            <div class="ar-main">${l.bike_id||''} ${who?'· '+escapeHtml(who):''}</div>
            <div class="ar-sub">${escapeHtml(l.actor)} · ${timeAgo(l.created_at)}${fixable ? ' · <span style="color:var(--blue)">tap to correct</span>' : ''}</div>
          </div>
        </div>`;
      }).join('')||'<div class="empty-state"><p>Nothing here yet</p></div>'}
    </div>`;
}

async function setLogFilter(id) {
  window._logFilter = id;
  await renderLog(document.getElementById('content'));
}

// Correct any past action on a bike. Shows what the log says, what the bike's
// state is NOW, and offers the corrections that actually make sense for it.
async function openLogFix(bikeId, logId) {
  const [bike, log] = await Promise.all([
    api(`/api/bikes/${bikeId}`).catch(() => null),
    api('/api/log?limit=200').catch(() => []),
  ]);
  if (!bike) { toast('Could not load that bike', 'error'); return; }

  const entry = log.find(l => l.id === logId);
  const ed = entry ? JSON.parse(entry.details || '{}') : {};
  // The checkout that preceded this entry tells us who had the bike.
  const prevCheckout = log.find(l => l.bike_id === bikeId && l.action === 'checkout' && (!entry || l.created_at <= entry.created_at));
  const pd = prevCheckout ? JSON.parse(prevCheckout.details || '{}') : {};
  const who = ed.customer_name || ed.assigned_to || pd.customer_name || pd.assigned_to || '';
  const isOut = bike.status === 'out';

  const actionLabels = { checkout:'Checked out', return:'Returned', bulk_return:'Returned', repair_ticket:'Repair reported', city:'Left in city', missing:'Marked missing' };

  openModal(`
    <div class="modal-title">${bikeId}</div>
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-row"><span class="dr-key">This entry</span><span class="dr-val">${actionLabels[entry?.action] || entry?.action || '—'}${entry ? ' · ' + timeAgo(entry.created_at) : ''}</span></div>
      <div class="detail-row"><span class="dr-key">By</span><span class="dr-val">${escapeHtml(entry?.actor || '—')}</span></div>
      ${who ? `<div class="detail-row"><span class="dr-key">Customer</span><span class="dr-val">${escapeHtml(who)}</span></div>` : ''}
      ${(entry?.booking_ref || prevCheckout?.booking_ref) ? `<div class="detail-row"><span class="dr-key">Booking</span><span class="dr-val">#${entry?.booking_ref || prevCheckout?.booking_ref}</span></div>` : ''}
      <div class="detail-row"><span class="dr-key">Bike is now</span><span class="dr-val"><strong>${bike.status}</strong>${isOut && bike.customer_name ? ' · ' + escapeHtml(bike.customer_name) : ''}</span></div>
    </div>
    <p style="font-size:0.78rem;color:var(--text3);margin:0.6rem 0">Fix the bike's current state if this was recorded wrong.</p>
    ${isOut
      ? `<button class="btn btn-primary btn-full" id="fix-return">Mark as returned (it's back)</button>
         <button class="btn btn-secondary btn-full" style="margin-top:0.5rem" id="fix-repair">Send to repair</button>`
      : `<button class="btn btn-primary btn-full" id="fix-unreturn">Put back out${who ? ' to ' + escapeHtml(who) : ''}</button>
         <button class="btn btn-secondary btn-full" style="margin-top:0.5rem" id="fix-repair">Send to repair</button>`}
    <button class="btn btn-secondary btn-full" style="margin-top:0.5rem" onclick="closeModal()">Close</button>
  `);

  const done = (msg) => { closeModal(); toast(msg, 'success'); renderTab('log'); };

  document.getElementById('fix-unreturn')?.addEventListener('click', async () => {
    try {
      await api(`/api/bikes/${bikeId}/checkout`, {method:'POST', body:{
        assignment_type: pd.assignment_type || 'rental',
        assigned_to: pd.assigned_to || '',
        customer_name: pd.customer_name || '',
        fareharbor_booking_ref: prevCheckout?.booking_ref || '',
        note: 'Corrected from log',
        force: true,
      }});
      done(`${bikeId} put back out${who ? ' to ' + who : ''}`);
    } catch(e) { toast('Could not correct: ' + e.message, 'error'); }
  });

  document.getElementById('fix-return')?.addEventListener('click', async () => {
    try {
      await api(`/api/bikes/${bikeId}/return`, {method:'POST', body:{new_status:'available', note:'Corrected from log'}});
      done(`${bikeId} marked returned`);
    } catch(e) { toast('Could not correct: ' + e.message, 'error'); }
  });

  document.getElementById('fix-repair')?.addEventListener('click', async () => {
    try {
      await api(`/api/bikes/${bikeId}/return`, {method:'POST', body:{new_status:'repair', note:'Corrected from log'}});
      done(`${bikeId} sent to repair`);
    } catch(e) { toast('Could not correct: ' + e.message, 'error'); }
  });
}


// ── Markdown renderer (lightweight, no external dependency) ───────────────
// Supports: headings (#/##/###), bold (**), italic (*), inline code (`),
// unordered lists (- / *), ordered lists (1.), horizontal rules (---),
// blank-line paragraphs.
function renderMarkdown(md) {
  if (!md) return '';
  const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const inline = s => s
    .replace(/`([^`]+)`/g, (_,c) => `<code style="background:var(--surface2);padding:1px 5px;border-radius:3px;font-size:0.85em">${escape(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_,t) => `<strong>${escape(t)}</strong>`)
    .replace(/\*([^*]+)\*/g, (_,t) => `<em>${escape(t)}</em>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_,txt,url) => `<a href="${escape(url)}" target="_blank">${escape(txt)}</a>`);

  const lines = md.split('\n');
  const out = [];
  let inList = null; // 'ul' | 'ol' | null
  let inPara = false;

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closePara = () => { if (inPara) { out.push('</p>'); inPara = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) { closePara(); closeList(); const lvl=hm[1].length+1; out.push(`<h${lvl} style="margin:0.7em 0 0.25em;font-size:${1.05-lvl*0.07}rem;color:var(--text)">${inline(escape(hm[2]))}</h${lvl}>`); continue; }

    // HR
    if (/^---+$/.test(line.trim())) { closePara(); closeList(); out.push('<hr style="border:none;border-top:1px solid var(--border);margin:0.75rem 0">'); continue; }

    // Unordered list
    const ulm = line.match(/^[\s]*[-*]\s+(.+)/);
    if (ulm) { closePara(); if (inList !== 'ul') { closeList(); out.push('<ul style="margin:0.3em 0 0.3em 1.2em;padding:0">'); inList='ul'; } out.push(`<li style="margin-bottom:0.2em">${inline(escape(ulm[1]))}</li>`); continue; }

    // Ordered list
    const olm = line.match(/^[\s]*\d+\.\s+(.+)/);
    if (olm) { closePara(); if (inList !== 'ol') { closeList(); out.push('<ol style="margin:0.3em 0 0.3em 1.2em;padding:0">'); inList='ol'; } out.push(`<li style="margin-bottom:0.2em">${inline(escape(olm[1]))}</li>`); continue; }

    // Blank line
    if (!line.trim()) { closePara(); closeList(); continue; }

    // Normal paragraph text
    closeList();
    if (!inPara) { out.push('<p style="margin:0.35em 0;line-height:1.55">'); inPara=true; } else { out.push(' '); }
    out.push(inline(escape(line)));
  }
  closePara(); closeList();
  return out.join('');
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

// Relative "x ago" for UTC timestamps (SQLite stores "YYYY-MM-DD HH:MM:SS", no Z)
function timeAgo(dt) {
  if (!dt) return '';
  const iso = dt.includes('T') ? dt : dt.replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (isNaN(s)) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  if (s < 604800) return Math.floor(s/86400) + 'd ago';
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}

// ── Icons ─────────────────────────────────────────────────────────────────
function iconHome(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;}
function iconBike(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 0 0-1-1h-1V4a1 1 0 0 0-2 0v1H9l3 6h3l1.6-3.2A1 1 0 0 0 15 6z"/><path d="m5.5 17.5 4-8.5"/></svg>`;}
function iconAction(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;}
function iconLog(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;}
function iconProfile(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;}
function iconTicket(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;}
function iconOperations(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="6" height="6" rx="1"/><rect x="9" y="3" width="6" height="6" rx="1"/><rect x="16" y="3" width="6" height="6" rx="1"/><rect x="2" y="12" width="6" height="9" rx="1"/><rect x="9" y="12" width="13" height="4" rx="1"/><rect x="9" y="18" width="13" height="3" rx="1"/></svg>`;}
function iconFleet(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 0 0-1-1h-1V4a1 1 0 0 0-2 0v1H9l3 6h3l1.6-3.2A1 1 0 0 0 15 6z"/><path d="m5.5 17.5 4-8.5"/><path d="M2 17.5h3.5"/><path d="M15 17.5h3.5"/></svg>`;}
function iconGuides(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;}
function iconApp(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M8 10h8"/><path d="M8 14h5"/><circle cx="17" cy="17" r="3" fill="currentColor" stroke="none"/><path d="m15.5 17 1 1 2-2" stroke="white" stroke-width="1.5" fill="none"/></svg>`;}
function iconNotifs(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;}
function iconGuidesTab(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;}
// ── Boot ──────────────────────────────────────────────────────────────────
document.getElementById('btn-switch-user').addEventListener('click', switchUser);

// If the user arrived via a password-reset email link, handle the token here
// instead of falling through to the normal session/login flow (which ignores it).
const _resetToken = new URLSearchParams(location.search).get('token');
if (_resetToken && location.pathname.replace(/\/+$/, '') === '/reset-password') {
  showResetPasswordScreen(_resetToken);
} else {
  checkSession();
}

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
// ── Guide name matching (mirror of backend logic in ical.js) ─────────────
const GUIDE_ALIASES = {
  'hassan': ['hasse', 'hassesorensen', 'hassesoerensen'],
  'pam': ['paloma'],
};

function normalizeName(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

function guideMatches(availGuide, personName) {
  if (!availGuide || !personName) return false;
  const a = normalizeName(availGuide);
  const p = normalizeName(personName);
  if (!a || !p) return false;
  if (a === p || a.includes(p) || p.includes(a)) return true;
  const personAliases = GUIDE_ALIASES[p] || [];
  if (personAliases.some(alias => a === alias || a.includes(alias) || alias.includes(a))) return true;
  for (const [canonical, aliases] of Object.entries(GUIDE_ALIASES)) {
    if (aliases.includes(p) && (a === canonical || a.includes(canonical))) return true;
    if (aliases.some(al => a.includes(al)) && (p === canonical || p.includes(canonical))) return true;
  }
  return false;
}

// ── Operations tab (Tours, Rentals, Bikes, Tickets sub-tabs) ─────
async function renderOperations(c) {
  if (!window._opsTab) window._opsTab = 'today';
  const tabs = [['today','Today'],['actions','Actions'],['tours','Tours'],['rentals','Rentals'],['bikes','Bikes'],['tickets','Tickets']];
  c.innerHTML = `
    <div class="subtab-row">
      ${tabs.map(([id,label])=>`<button class="subtab${window._opsTab===id?' active':''}" data-opstab="${id}" onclick="switchOpsTab('${id}')">${label}</button>`).join('')}
    </div>
    <div id="ops-tab-content"></div>`;
  await renderOpsTab();
}

async function switchOpsTab(tab) {
  window._opsTab = tab;
  logPageView(`operations.${tab}`);
  document.querySelectorAll('[data-opstab]').forEach(b => b.classList.toggle('active', b.dataset.opstab === tab));
  await renderOpsTab();
}

async function renderOpsTab() {
  const el = document.getElementById('ops-tab-content');
  if (!el) return;
  if (window._opsTab === 'today') await renderTodayBoard(el);
  else if (window._opsTab === 'actions') renderAction(el);
  else if (window._opsTab === 'tours') {
    // Operations shows only the admin's own tours (as a guide). Look 120 days
    // ahead — the default 30-day window was hiding an assigned 31 Aug A3P.
    const name = state.actor?.name;
    const all = await api('/api/ical/tours?days=150');
    const mine = all.filter(t => t.guide && guideMatches(t.guide, name));
    renderToursList(el, mine, true);
  }
  else if (window._opsTab === 'rentals') await renderRentals(el);
  else if (window._opsTab === 'bikes') await renderBikes(el);
  else if (window._opsTab === 'tickets') await renderTickets(el);
}

// ── Admin Notifications tab ───────────────────────────────────────────────
let _notifPollInterval = null;
let _seenNotifIds = null; // null = not yet seeded (first poll after load)

function startNotifPolling() {
  if (_notifPollInterval) return;
  updateNotifBadge();
  _notifPollInterval = setInterval(updateNotifBadge, 30000); // every 30s
}

// Short synthesized ping — no audio file needed
function playNotifPing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch(e) { /* audio not available */ }
}

function showDesktopNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'bc-fleet-alert' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch(e) { /* ignore */ }
}

async function requestDesktopNotifPermission() {
  if (!('Notification' in window)) { toast('Desktop notifications not supported in this browser', 'error'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { toast('Desktop alerts enabled', 'success'); playNotifPing(); }
  else toast('Desktop alerts not enabled', 'error');
  if (window._renderNotifsAdminRef) window._renderNotifsAdminRef();
}

async function updateNotifBadge() {
  if (state.actor?.role !== 'admin') return;
  try {
    const data = await api('/api/admin-notifs');
    const count = data.count || 0;
    const notifications = data.notifications || [];

    // Detect newly-arrived alerts (by id) and ping for them
    const currentIds = new Set(notifications.map(n => n.id));
    if (_seenNotifIds === null) {
      // First poll after page load — just seed the set, don't ping for pre-existing alerts
      _seenNotifIds = currentIds;
    } else {
      const newOnes = notifications.filter(n => !_seenNotifIds.has(n.id));
      if (newOnes.length > 0) {
        playNotifPing();
        if (newOnes.length === 1) {
          showDesktopNotification(newOnes[0].title, newOnes[0].body || '');
        } else {
          showDesktopNotification(`${newOnes.length} new alerts`, newOnes.map(n => n.title).join(' · '));
        }
      }
      _seenNotifIds = currentIds;
    }

    // Find or create badge on the Alerts tab button
    const btn = document.querySelector('[data-tab="notifs-admin"]');
    if (!btn) return;
    let badge = btn.querySelector('.notif-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'notif-badge';
        badge.style.cssText = 'position:absolute;top:2px;right:2px;background:var(--red);color:#fff;font-size:0.6rem;font-weight:700;padding:1px 5px;border-radius:10px;min-width:16px;text-align:center';
        btn.style.position = 'relative';
        btn.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }
  } catch(e) { /* ignore */ }
}

async function renderNotifsAdmin(c) {
  c.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let data;
  try {
    data = await api('/api/admin-notifs');
  } catch(e) {
    c.innerHTML = `<div class="empty-state"><p>Could not load notifications</p></div>`;
    return;
  }

  const notifs = data.notifications || [];
  const typeIcon = { unassigned_tour: '⚠️', unassigned_tour_urgent: '🔥', unavailability: '📅', conflict: '🚨', invoice: '🧾', first_booking_soon: '🎉', bug_report: '🐛', guide_mismatch: '🔀', bike_data_anomaly: '🚲' };
  const typeLabel = { unassigned_tour: 'Unassigned tour', unassigned_tour_urgent: 'Urgent — unassigned tour', unavailability: 'Guide unavailability', conflict: 'Conflict', invoice: 'New invoice', first_booking_soon: 'First booking', bug_report: 'Bug report', guide_mismatch: 'Guide mismatch', bike_data_anomaly: 'Bike data anomaly' };

  const notifPerm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const permBanner = notifPerm === 'granted' ? '' : notifPerm === 'unsupported' ? '' : `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;margin-bottom:0.75rem;background:var(--blue-bg);border-radius:var(--radius)">
      <span style="font-size:0.82rem;color:var(--text)">Get a desktop ping when new alerts come in.</span>
      <button class="btn btn-primary" style="font-size:0.78rem;padding:5px 14px;flex-shrink:0" onclick="requestDesktopNotifPermission()">Enable</button>
    </div>`;

  window._renderNotifsAdminRef = () => renderNotifsAdmin(c);

  c.innerHTML = `
    ${permBanner}
    <div class="detail-section" style="border-top:none;padding-top:0;display:flex;justify-content:space-between;align-items:center">
      <div class="detail-section-title" style="margin:0">Alerts (${notifs.length})</div>
      ${notifs.length > 0 ? `<button class="btn btn-secondary" style="font-size:0.78rem;padding:4px 12px" onclick="dismissAllNotifs()">Dismiss all</button>` : ''}
    </div>
    ${notifs.length === 0
      ? '<div class="empty-state"><p>No alerts — all clear ✅</p></div>'
      : notifs.map(n => `
        <div style="padding:0.6rem 0.75rem;margin-bottom:0.5rem;background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--radius);border-left:3px solid ${n.type==='conflict'||n.type==='unassigned_tour_urgent'?'var(--red)':n.type==='unassigned_tour'?'var(--amber)':n.type==='invoice'?'var(--green)':n.type==='first_booking_soon'?'var(--green)':'var(--blue)'}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
            <div>
              <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">${typeIcon[n.type]||'🔔'} ${typeLabel[n.type]||n.type} · ${fmtDateFull(n.created_at?.substring(0,10))}</div>
              <div style="font-size:0.88rem;font-weight:600">${escapeHtml(n.title)}</div>
              ${n.body ? `<div style="font-size:0.78rem;color:var(--text2);margin-top:2px">${escapeHtml(n.body)}</div>` : ''}
            </div>
            <button onclick="dismissNotif(${n.id})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:1rem;padding:0;flex-shrink:0" title="Dismiss">✕</button>
          </div>
        </div>`).join('')}
  `;
  updateNotifBadge();
}

async function dismissNotif(id) {
  await api(`/api/admin-notifs/dismiss/${id}`, { method:'POST' });
  renderNotifsAdmin(document.getElementById('content'));
}

async function dismissAllNotifs() {
  await api('/api/admin-notifs/dismiss-all', { method:'POST' });
  renderNotifsAdmin(document.getElementById('content'));
}

// ── Fleet tab (bike management) ───────────────────────────────────────────
async function renderFleetAdmin(c) {
  c.innerHTML = `<div id="fleet-admin-content"></div>`;
  await renderAdminBikes(document.getElementById('fleet-admin-content'));
}

// ── Guides tab (Reviews, Availability, Metrics) ───────────────────────────
async function renderGuidesAdmin(c) {
  if (!window._guidesAdminTab) window._guidesAdminTab = 'tours-all';
  c.innerHTML = `
    <div class="subtab-row">
      <button class="subtab${window._guidesAdminTab==='tours-all'?' active':''}" onclick="switchGuidesAdminTab('tours-all')">Tours</button>
      <button class="subtab${window._guidesAdminTab==='guides'?' active':''}" onclick="switchGuidesAdminTab('guides')">Guides</button>
      <button class="subtab${window._guidesAdminTab==='reviews'?' active':''}" onclick="switchGuidesAdminTab('reviews')">Reviews</button>
      <button class="subtab${window._guidesAdminTab==='availability'?' active':''}" onclick="switchGuidesAdminTab('availability')">Availability</button>
    </div>
    <div id="guides-admin-content"></div>`;
  await renderGuidesAdminTab();
}

async function switchGuidesAdminTab(tab) {
  window._guidesAdminTab = tab;
  logPageView(`guides-admin.${tab}`);
  const labels = {'tours-all':'Tours', guides:'Guides', reviews:'Reviews', availability:'Availability'};
  document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.textContent === labels[tab]));
  await renderGuidesAdminTab();
}

async function renderGuidesAdminTab() {
  const el = document.getElementById('guides-admin-content');
  if (!el) return;
  if (window._guidesAdminTab === 'tours-all') await renderAllToursView(el);
  else if (window._guidesAdminTab === 'guides') await renderGuidesMetrics(el);
  else if (window._guidesAdminTab === 'reviews') await renderAdminReviews(el);
  else if (window._guidesAdminTab === 'availability') await renderAdminAvailability(el);
}

async function renderAllToursView(el) {
  el.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  const [tours, team] = await Promise.all([
    api('/api/ical/tours'),
    api('/api/team').catch(()=>[]),
  ]);
  // Collapse guide names to their canonical team member, so a guide who appears
  // under multiple raw names (e.g. "Pam" and "Paloma Lopez Garcia-Pelayo") shows
  // once, under the team display name. Guides not in the team keep their raw name.
  const guideMembers = team.filter(m => m.role === 'guide' || m.is_guide);
  const guideLabels = new Set();
  tours.map(t => t.guide).filter(Boolean).forEach(rg => {
    const m = guideMembers.find(mm => guideMatches(rg, mm.name));
    guideLabels.add(m ? m.name : rg);
  });
  const guides = [...guideLabels].sort();
  const feedIds = [...new Set(tours.map(t => t.feed_id))].sort();

  if (!window._toursFilter) window._toursFilter = { guide: '', feed: '' };

  const filtered = tours.filter(t =>
    (!window._toursFilter.guide || guideMatches(t.guide, window._toursFilter.guide)) &&
    (!window._toursFilter.feed || t.feed_id === window._toursFilter.feed)
  );

  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;padding-top:0.5rem">
      <select class="form-select" id="filter-guide" style="flex:1;min-width:120px">
        <option value="">All guides</option>
        ${guides.map(g => `<option value="${g}" ${window._toursFilter.guide===g?'selected':''}>${g}</option>`).join('')}
      </select>
      <select class="form-select" id="filter-feed" style="flex:1;min-width:100px">
        <option value="">All tours</option>
        ${feedIds.map(f => `<option value="${f}" ${window._toursFilter.feed===f?'selected':''}>${f}</option>`).join('')}
      </select>
    </div>
    <div id="all-tours-list"></div>
  `;

  document.getElementById('filter-guide').addEventListener('change', e => {
    window._toursFilter.guide = e.target.value;
    renderAllToursView(el);
  });
  document.getElementById('filter-feed').addEventListener('change', e => {
    window._toursFilter.feed = e.target.value;
    renderAllToursView(el);
  });

  const listEl = document.getElementById('all-tours-list');
  renderToursList(listEl, filtered, false);
}

// ── App tab (Log, Invoicing, Bugs, View as) ───────────────────────────────
async function renderAppAdmin(c) {
  if (!window._appAdminTab) window._appAdminTab = 'bookings-history';
  // Decluttered: the five diagnostic logs (Action/Changes/Webhooks/Emails/Visits)
  // now live behind a single "Logs" tab instead of cluttering the top row.
  const main = [['bookings-history','Bookings'],['invoicing','Invoicing'],['bugs','Bugs'],['logs','Logs'],['viewas','View as']];
  c.innerHTML = `
    <div class="subtab-row">
      ${main.map(([id,label])=>`<button class="subtab${window._appAdminTab===id?' active':''}" data-apptab="${id}" onclick="switchAppAdminTab('${id}')">${label}</button>`).join('')}
    </div>
    <div id="app-admin-content"></div>`;
  await renderAppAdminTab();
}

async function switchAppAdminTab(tab) {
  window._appAdminTab = tab;
  logPageView(`app-admin.${tab}`);
  document.querySelectorAll('[data-apptab]').forEach(b => b.classList.toggle('active', b.dataset.apptab === tab));
  await renderAppAdminTab();
}

async function renderAppAdminTab() {
  const el = document.getElementById('app-admin-content');
  if (!el) return;
  const tab = window._appAdminTab;
  if (tab === 'invoicing') await renderAdminInvoicing(el);
  else if (tab === 'bugs') await renderBugReports(el);
  else if (tab === 'viewas') await renderViewAs(el);
  else if (tab === 'logs') await renderAppLogs(el);
  else await renderBookingsHistory(el);
}

// The rarely-needed diagnostic logs, grouped under the "Logs" tab.
const APP_LOG_TABS = [
  ['log','Action log'], ['changes','Tour changes'], ['webhooks','Webhooks'],
  ['emails','Sent emails'], ['visits','Page visits'],
];
async function renderAppLogs(el) {
  if (!window._appLogTab) window._appLogTab = 'log';
  el.innerHTML = `
    <div class="chip-row" style="margin:0.6rem 0 0.85rem">
      ${APP_LOG_TABS.map(([id,label])=>`<button class="chip${window._appLogTab===id?' active':''}" data-logtab="${id}" onclick="switchAppLog('${id}')">${label}</button>`).join('')}
    </div>
    <div id="app-log-content"></div>`;
  await renderCurrentLog();
}
async function switchAppLog(id) {
  window._appLogTab = id;
  logPageView(`app-admin.logs.${id}`);
  document.querySelectorAll('[data-logtab]').forEach(b => b.classList.toggle('active', b.dataset.logtab === id));
  await renderCurrentLog();
}
async function renderCurrentLog() {
  const el = document.getElementById('app-log-content');
  if (!el) return;
  const t = window._appLogTab;
  if (t === 'changes') await renderTourChanges(el);
  else if (t === 'webhooks') await renderWebhookLog(el);
  else if (t === 'emails') await renderSentEmails(el);
  else if (t === 'visits') await renderPageVisits(el);
  else await renderAdminLog(el);
}

async function renderBookingsHistory(el) {
  el.innerHTML = `
    <div style="padding-top:0.5rem;margin-bottom:0.75rem">
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem">
        <select class="form-select" id="bh-mode" style="flex:1">
          <option value="days_ago">Bookings made exactly N days ago</option>
          <option value="date">Bookings made on a specific date</option>
          <option value="range">Bookings made in a date range</option>
          <option value="recent">Most recent bookings</option>
        </select>
      </div>
      <div id="bh-inputs" style="display:flex;gap:0.5rem"></div>
    </div>
    <div id="bookings-history-list"><div class="empty-state"><p>Choose a query above</p></div></div>
  `;
  const modeSelect = document.getElementById('bh-mode');
  modeSelect.addEventListener('change', renderBhInputs);
  renderBhInputs();

  function renderBhInputs() {
    const mode = modeSelect.value;
    const inputsEl = document.getElementById('bh-inputs');
    if (mode === 'days_ago') {
      inputsEl.innerHTML = `
        <input class="form-input" type="number" id="bh-days-ago" placeholder="e.g. 22" style="flex:1" value="22">
        <button class="btn btn-primary" id="bh-run">Run</button>`;
    } else if (mode === 'date') {
      inputsEl.innerHTML = `
        <input class="form-input" type="date" id="bh-date" style="flex:1">
        <button class="btn btn-primary" id="bh-run">Run</button>`;
    } else if (mode === 'range') {
      inputsEl.innerHTML = `
        <input class="form-input" type="date" id="bh-from" style="flex:1">
        <input class="form-input" type="date" id="bh-to" style="flex:1">
        <button class="btn btn-primary" id="bh-run">Run</button>`;
    } else {
      inputsEl.innerHTML = `<button class="btn btn-primary" id="bh-run" style="width:100%">Run</button>`;
    }
    document.getElementById('bh-run').addEventListener('click', runBhQuery);
  }

  async function runBhQuery() {
    const mode = modeSelect.value;
    const listEl = document.getElementById('bookings-history-list');
    listEl.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;

    let qs = '';
    if (mode === 'days_ago') qs = `?days_ago=${document.getElementById('bh-days-ago').value}`;
    else if (mode === 'date') qs = `?date=${document.getElementById('bh-date').value}`;
    else if (mode === 'range') qs = `?from=${document.getElementById('bh-from').value}&to=${document.getElementById('bh-to').value}`;

    let data;
    try {
      data = await api(`/api/ical/bookings-history${qs}`);
    } catch(e) {
      listEl.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    if (data.count === 0) {
      listEl.innerHTML = `<div class="empty-state"><p>No bookings found</p></div>`;
      return;
    }

    listEl.innerHTML = `
      <div class="detail-section" style="border-top:none;padding-top:0">
        <div class="detail-section-title">${data.count} booking${data.count!==1?'s':''}</div>
        ${data.bookings.map(b => `
          <div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
              <span style="font-size:0.85rem;font-weight:700">${escapeHtml(b.customer_name || 'Unknown')}</span>
              <span style="font-size:0.72rem;color:var(--text3)">${b.booking_created_at || ''}</span>
            </div>
            <div style="font-size:0.78rem;color:var(--text2)">${escapeHtml(b.feed_id || '')} · tour on ${b.tour_start_date || '?'} · ${escapeHtml(b.source || 'direct')}${b.total ? ' · ' + escapeHtml(b.total) : ''}</div>
          </div>`).join('')}
      </div>
    `;
  }
}

async function renderTourChanges(el) {
  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;padding-top:0.5rem">
      <select class="form-select" id="changes-window-select" style="flex:1">
        <option value="24">Last 24 hours</option>
        <option value="1">Last hour</option>
        <option value="72">Last 3 days</option>
        <option value="">All</option>
      </select>
    </div>
    <div id="tour-changes-list"><div class="empty-state"><p>Loading...</p></div></div>
  `;
  document.getElementById('changes-window-select').addEventListener('change', e => loadTourChanges(e.target.value));
  await loadTourChanges('24');
}

async function loadTourChanges(hours) {
  const listEl = document.getElementById('tour-changes-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let rows;
  try {
    rows = await api(`/api/tour-changes${hours ? '?hours=' + hours : ''}`);
  } catch(e) {
    listEl.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>No changes in this window</p></div>`;
    return;
  }
  const fieldColor = { guide: 'var(--blue)', booking_count: 'var(--green)', status: 'var(--red)' };
  listEl.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">${rows.length} change${rows.length!==1?'s':''}</div>
      ${rows.map(r => `
        <div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
            <span style="font-size:0.8rem;font-weight:700;color:${fieldColor[r.field]||'var(--text)'}">${escapeHtml(r.field)}</span>
            <span style="font-size:0.72rem;color:var(--text3)">${r.created_at} · ${escapeHtml(r.source||'')}</span>
          </div>
          <div style="font-size:0.82rem;color:var(--text2)">
            ${r.feed_id ? escapeHtml(r.feed_id) + ' · ' : ''}${r.start_date || ''}
            — <span style="text-decoration:line-through;color:var(--text3)">${escapeHtml(String(r.old_value ?? '∅'))}</span>
            → <strong>${escapeHtml(String(r.new_value ?? '∅'))}</strong>
          </div>
          <div style="font-size:0.7rem;color:var(--text3)">id: ${escapeHtml(r.availability_id)}</div>
          ${r.raw_data ? `<details style="margin-top:4px"><summary style="font-size:0.72rem;color:var(--blue);cursor:pointer">raw source data</summary><pre style="font-size:0.68rem;background:var(--bg2);padding:6px 8px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin-top:4px">${escapeHtml(r.raw_data)}</pre></details>` : ''}
        </div>`).join('')}
    </div>
  `;
}

async function renderWebhookLog(el) {
  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;padding-top:0.5rem">
      <select class="form-select" id="webhooks-window-select" style="flex:1">
        <option value="24">Last 24 hours</option>
        <option value="1">Last hour</option>
        <option value="72">Last 3 days</option>
        <option value="">All</option>
      </select>
    </div>
    <div id="webhook-log-list"><div class="empty-state"><p>Loading...</p></div></div>
  `;
  document.getElementById('webhooks-window-select').addEventListener('change', e => loadWebhookLog(e.target.value));
  await loadWebhookLog('24');
}

async function loadWebhookLog(hours) {
  const listEl = document.getElementById('webhook-log-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let rows;
  try {
    rows = await api(`/api/webhook-log${hours ? '?hours=' + hours : ''}`);
  } catch(e) {
    listEl.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>No webhooks received in this window</p></div>`;
    return;
  }
  listEl.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">${rows.length} webhook${rows.length!==1?'s':''} received</div>
      ${rows.map(r => `
        <div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
            <span style="font-size:0.8rem;font-weight:700">${escapeHtml(r.event_type || 'unknown')}</span>
            <span style="font-size:0.72rem;color:var(--text3)">${r.created_at}</span>
          </div>
          <details style="margin-top:4px"><summary style="font-size:0.72rem;color:var(--blue);cursor:pointer">raw payload</summary><pre style="font-size:0.68rem;background:var(--bg2);padding:6px 8px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin-top:4px">${escapeHtml(r.raw_body || '')}</pre></details>
        </div>`).join('')}
    </div>
  `;
}

async function renderPageVisits(el) {
  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;padding-top:0.5rem">
      <select class="form-select" id="visits-window-select" style="flex:1">
        <option value="24">Last 24 hours</option>
        <option value="1">Last hour</option>
        <option value="168">Last 7 days</option>
        <option value="">All</option>
      </select>
    </div>
    <div id="page-visits-list"><div class="empty-state"><p>Loading...</p></div></div>
  `;
  document.getElementById('visits-window-select').addEventListener('change', e => loadPageVisits(e.target.value));
  await loadPageVisits('24');
}

async function loadPageVisits(hours) {
  const listEl = document.getElementById('page-visits-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let rows;
  try {
    rows = await api(`/api/page-views${hours ? '?hours=' + hours : ''}`);
  } catch(e) {
    listEl.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>No visits in this window</p></div>`;
    return;
  }
  // Aggregate: per-person totals + last-active, plus overall tab totals.
  // Rows arrive newest-first (API orders created_at DESC).
  const byActor = {};
  const tabTotals = {};
  rows.forEach(r => {
    const name = r.actor_name || r.actor || 'Unknown';
    const a = byActor[name] || (byActor[name] = { count: 0, last: r.created_at, first: r.created_at, tabs: {} });
    a.count++;
    a.tabs[r.tab] = (a.tabs[r.tab] || 0) + 1;
    if (r.created_at > a.last) a.last = r.created_at;
    if (r.created_at < a.first) a.first = r.created_at;
    tabTotals[r.tab] = (tabTotals[r.tab] || 0) + 1;
  });
  const people = Object.keys(byActor).length;
  const busiest = Object.entries(tabTotals).sort((a, b) => b[1] - a[1])[0];
  const actors = Object.entries(byActor).sort((a, b) => (a[1].last < b[1].last ? 1 : -1));
  const feed = rows.slice(0, 50);

  const stat = (n, label) => `<div style="text-align:center"><div style="font-size:1.3rem;font-weight:800;line-height:1.1">${n}</div><div style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.03em">${label}</div></div>`;

  listEl.innerHTML = `
    <div style="display:flex;justify-content:space-around;align-items:center;background:var(--bg3);border-radius:var(--radius);padding:0.75rem;margin-bottom:1rem">
      ${stat(rows.length, 'Visits')}
      ${stat(people, people === 1 ? 'Person' : 'People')}
      ${stat(busiest ? escapeHtml(busiest[0]) : '—', 'Busiest tab')}
    </div>

    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">By person · most recent first</div>
      ${actors.map(([name, a]) => `
        <div style="padding:0.55rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem">
            <span style="font-weight:700;font-size:0.9rem">${escapeHtml(name)}</span>
            <span style="font-size:0.72rem;color:var(--text3)">last active ${timeAgo(a.last)}</span>
          </div>
          <div style="font-size:0.78rem;color:var(--text2);margin-top:0.15rem">
            <span style="color:var(--text)">${a.count}</span> visit${a.count !== 1 ? 's' : ''} · ${Object.entries(a.tabs).sort((x, y) => y[1] - x[1]).map(([tab, c]) => `${escapeHtml(tab)} (${c})`).join(' · ')}
          </div>
        </div>`).join('')}
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Recent activity</div>
      ${feed.map(r => `
        <div style="display:flex;align-items:baseline;gap:0.6rem;padding:0.32rem 0;font-size:0.8rem">
          <span style="color:var(--text3);white-space:nowrap;min-width:64px">${timeAgo(r.created_at)}</span>
          <span style="font-weight:600;min-width:74px">${escapeHtml(r.actor_name || r.actor || 'Unknown')}</span>
          <span style="color:var(--text2)">${escapeHtml(r.tab)}</span>
        </div>`).join('')}
      ${rows.length > feed.length ? `<div style="font-size:0.72rem;color:var(--text3);padding-top:0.4rem">Showing the ${feed.length} most recent of ${rows.length}.</div>` : ''}
    </div>
  `;
}

async function renderSentEmails(el) {
  el.innerHTML = `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;padding-top:0.5rem">
      <select class="form-select" id="email-window-select" style="flex:1">
        <option value="24">Last 24 hours</option>
        <option value="1">Last hour</option>
        <option value="72">Last 3 days</option>
        <option value="168">Last 7 days</option>
        <option value="">All</option>
      </select>
    </div>
    <div id="sent-emails-list"><div class="empty-state"><p>Loading...</p></div></div>
  `;
  document.getElementById('email-window-select').addEventListener('change', e => loadSentEmails(e.target.value));
  await loadSentEmails('24');
}

async function loadSentEmails(hours) {
  const listEl = document.getElementById('sent-emails-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let rows;
  try {
    rows = await api(`/api/sent-emails${hours ? '?hours=' + hours : ''}`);
  } catch(e) {
    listEl.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>No emails sent in this window</p></div>`;
    return;
  }

  // Group by recipient for quick "who got spammed" scanning
  const byRecipient = {};
  rows.forEach(r => {
    const key = r.to_name || r.to_email;
    if (!byRecipient[key]) byRecipient[key] = [];
    byRecipient[key].push(r);
  });
  const counts = Object.entries(byRecipient).sort((a,b) => b[1].length - a[1].length);

  listEl.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">${rows.length} email${rows.length!==1?'s':''} sent · by recipient</div>
      ${counts.map(([name, emails]) => `
        <div class="detail-row">
          <span class="dr-key">${escapeHtml(name)}</span>
          <span class="dr-val" style="font-weight:700;color:${emails.length>=5?'var(--red)':emails.length>=3?'var(--amber)':'var(--text2)'}">${emails.length}</span>
        </div>`).join('')}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">All emails</div>
      ${rows.map(r => `
        <div style="padding:0.5rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
          <div>
            <div style="font-size:0.85rem;font-weight:600">${escapeHtml(r.subject)}</div>
            <div style="font-size:0.75rem;color:var(--text3)">${escapeHtml(r.to_name || r.to_email)} · ${r.sent_at}${r.category ? ' · ' + escapeHtml(r.category) : ''}</div>
          </div>
          ${!r.ok ? `<span style="font-size:0.7rem;font-weight:700;color:var(--red);background:#FFF0F0;padding:2px 8px;border-radius:10px;flex-shrink:0">failed</span>` : ''}
        </div>`).join('')}
    </div>
  `;
}

// ── Guide metrics ─────────────────────────────────────────────────────────
async function renderGuidesMetrics(el) {
  el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const cycleStart = d >= 23 ? `${y}-${String(m+1).padStart(2,'0')}-23` : `${y}-${String(m).padStart(2,'0')}-23`;
  const cycleEnd   = d >= 23 ? `${y+( m===11?1:0)}-${String((m+2)%12||12).padStart(2,'0')}-22` : `${y}-${String(m+1).padStart(2,'0')}-22`;

  const team = await api('/api/team').catch(()=>[]);
  const guides = team.filter(g => g.role === 'guide' || g.is_guide);

  // Review-rate history (per billing cycle, ≤6) for the little per-guide graph.
  const rateHistory = await api('/api/reviews/ratio-history').catch(() => null);

  const data = await Promise.all(guides.map(async g => {
    const [worked, upcoming, reviews] = await Promise.all([
      api(`/api/ical/guide-hours?guide=${encodeURIComponent(g.name)}&from=${cycleStart}&to=${cycleEnd}`).catch(()=>({total_minutes:0,count:0})),
      api(`/api/ical/guide-hours?guide=${encodeURIComponent(g.name)}&upcoming=1`).catch(()=>({total_minutes:0})),
      api(`/api/reviews?guide_id=${g.id}&from=${cycleStart}&to=${cycleEnd}`).catch(()=>[]),
    ]);
    const ratio = worked.total_bookings > 0 && reviews.length > 0 ? Math.round((reviews.length / worked.total_bookings) * 100) : null;
    return { ...g, worked, upcoming, reviews, ratio };
  }));

  // Full-width weekly line chart of the review-to-bookings ratio (one point
  // per Monday-start week, ≤26 weeks). The line BREAKS at weeks with no
  // bookings — a gap, never a fake 0%. Values >100% plot at the cap; the dot
  // tooltip always carries the true numbers. Aspect-preserved SVG so dots
  // stay round at any width.
  const sparkHtml = (guideId) => {
    const h = rateHistory?.guides?.find(g => g.id === guideId);
    if (!h) return '';
    let pts = h.points.map((p, i) => ({ ...p, wk: rateHistory.weeks[i] }));
    while (pts.length && pts[0].bookings === 0 && pts[0].reviews === 0) pts.shift();
    if (!pts.some(p => p.ratio !== null)) return `<div class="rline-empty">No review history yet</div>`;

    const W = 640, H = 150, padL = 30, padR = 10, padT = 12, padB = 20;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = pts.length;
    const x = i => padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = r => padT + ih - (Math.min(r, 100) / 100) * ih;

    // Line segments: consecutive defined points only.
    let path = '', pen = false;
    pts.forEach((p, i) => {
      if (p.ratio === null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.ratio).toFixed(1)}`;
      pen = true;
    });

    const dots = pts.map((p, i) => {
      if (p.ratio === null) return '';
      const tip = `Week of ${p.wk.label}: ${p.reviews} review${p.reviews !== 1 ? 's' : ''} / ${p.bookings} guest${p.bookings !== 1 ? 's' : ''} = ${p.ratio}%`;
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.ratio).toFixed(1)}" r="3.5" class="rline-dot"/>`
        + `<circle cx="${x(i).toFixed(1)}" cy="${y(p.ratio).toFixed(1)}" r="9" fill="transparent"><title>${tip}</title></circle>`;
    }).join('');

    // Sparse x labels: the first week-row of each month.
    const xlabels = pts.map((p, i) => p.wk.monthStart
      ? `<text x="${x(i).toFixed(1)}" y="${H - 5}" class="rline-xlab">${p.wk.label.split(' ')[1]}</text>` : '').join('');

    const grid = [0, 50, 100].map(v =>
      `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="rline-grid"/>`
      + `<text x="${padL - 5}" y="${y(v) + 3}" class="rline-ylab">${v}</text>`).join('');

    return `<div class="rline-wrap">
      <div class="rline-title">Review rate — weekly</div>
      <svg viewBox="0 0 ${W} ${H}" class="rline-svg" role="img" aria-label="Weekly review rate">
        ${grid}
        <path d="${path}" class="rline-path"/>
        ${dots}
        ${xlabels}
      </svg>
    </div>`;
  };

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Guide metrics — current cycle</div>
      ${data.map(g => `
        <div style="padding:0.6rem 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:700;margin-bottom:0.3rem">${g.name}</div>
          <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);gap:0.35rem">
            <div class="stat-card" style="padding:0.5rem 0.6rem">
              <div class="stat-card-num green" style="font-size:1.1rem">${fmtDurationFromMinutes(g.worked.total_minutes)}</div>
              <div class="stat-card-label">Worked</div>
            </div>
            <div class="stat-card" style="padding:0.5rem 0.6rem">
              <div class="stat-card-num" style="font-size:1.1rem">${fmtDurationFromMinutes(g.upcoming.total_minutes)}</div>
              <div class="stat-card-label">Upcoming</div>
            </div>
            <div class="stat-card" style="padding:0.5rem 0.6rem">
              <div class="stat-card-num green" style="font-size:1.1rem">${g.reviews.length}</div>
              <div class="stat-card-label">Reviews</div>
            </div>
            <div class="stat-card" style="padding:0.5rem 0.6rem">
              <div class="stat-card-num ${g.ratio===null?'':g.ratio>=33?'green':g.ratio>=15?'amber':'red'}" style="font-size:1.1rem">${g.ratio !== null ? g.ratio + '%' : '—'}</div>
              <div class="stat-card-label">Rate</div>
            </div>
          </div>
          ${sparkHtml(g.id)}
        </div>`).join('')}
    </div>
  `;
}

// ── Per-guide unavailability calendar ─────────────────────────────────────
// Guides mark unavailability as free-form datetime ranges (no "all day" flag),
// so a day is only shown as FULL when a period genuinely spans 00:00–23:59;
// anything narrower is PARTIAL and the real times are listed under the grid.
// from_dt/to_dt are fixed-width "YYYY-MM-DDTHH:MM", so plain string comparison
// is a correct (and timezone-proof) overlap test.
function unavailDayInfo(periods, dateStr) {
  const dayStart = dateStr + 'T00:00';
  const dayEnd = dateStr + 'T23:59';
  const hits = periods.filter(p => p.from_dt <= dayEnd && p.to_dt >= dayStart);
  if (!hits.length) return null;
  return { full: hits.some(p => p.from_dt <= dayStart && p.to_dt >= dayEnd), hits };
}

// Month navigation for the Availability sub-tab's mixed calendar.
function availCalStep(delta) {
  const st = window._availCal;
  if (!st) return;
  const d = new Date(st.year, st.month + delta, 1);
  st.year = d.getFullYear();
  st.month = d.getMonth();
  renderAvailCalParts();
}

function availCalSetGuide(guideId) {
  if (window._availCal) { window._availCal.guide = guideId; renderAvailCalParts(); }
}

// Draws the calendar grid + the period list into their containers, from
// window._availCal state. All-guides mode shows per-guide initial chips in
// each day cell (solid = all day, outlined = part of day); filtering to one
// guide switches to the full/partial cell colouring with times.
function renderAvailCalParts() {
  const st = window._availCal;
  const gridEl = document.getElementById('avail-cal-grid');
  const listEl = document.getElementById('avail-period-list');
  if (!st || !gridEl || !listEl) return;
  const { year, month, guide, periods, guideName } = st;

  const pad = n => String(n).padStart(2, '0');
  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().substring(0, 10);

  const byGuide = {};
  periods.forEach(p => { (byGuide[p.guide_id] = byGuide[p.guide_id] || []).push(p); });
  const guideIds = Object.keys(byGuide).sort((a, b) => (guideName(a) || a).localeCompare(guideName(b) || b));

  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += `<div class="ucal-cell ucal-blank"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
    const todayCls = dateStr === todayStr ? ' ucal-today' : '';
    if (guide) {
      const info = unavailDayInfo(byGuide[guide] || [], dateStr);
      const cls = ['ucal-cell'];
      if (info) cls.push(info.full ? 'ucal-full' : 'ucal-partial');
      const times = info && !info.full
        ? `${info.hits[0].from_dt.substring(11)}–${info.hits[0].to_dt.substring(11)}` : '';
      cells += `<div class="${cls.join(' ')}${todayCls}"><span>${day}</span>${times ? `<em>${escapeHtml(times)}</em>` : ''}</div>`;
    } else {
      const chips = [];
      for (const gid of guideIds) {
        const info = unavailDayInfo(byGuide[gid], dateStr);
        if (info) chips.push({ gid, full: info.full });
      }
      const shown = chips.slice(0, 3).map(c =>
        `<i class="uchip${c.full ? ' full' : ''}" title="${escapeHtml(guideName(c.gid) || c.gid)}">${escapeHtml((guideName(c.gid) || c.gid).substring(0, 2))}</i>`).join('');
      const more = chips.length > 3 ? `<i class="uchip more">+${chips.length - 3}</i>` : '';
      cells += `<div class="ucal-cell ucal-multi${todayCls}"><span>${day}</span><div class="uchips">${shown}${more}</div></div>`;
    }
  }

  const monthStart = `${year}-${pad(month + 1)}-01T00:00`;
  const monthEnd = `${year}-${pad(month + 1)}-${pad(daysInMonth)}T23:59`;
  const scoped = periods.filter(p => !guide || p.guide_id === guide);
  const inMonth = scoped.filter(p => p.from_dt <= monthEnd && p.to_dt >= monthStart)
    .sort((a, b) => a.from_dt.localeCompare(b.from_dt));
  const fmt = s => s.replace('T', ' ');

  gridEl.innerHTML = `
    <div class="ucal-nav">
      <button onclick="availCalStep(-1)">‹</button>
      <strong>${monthLabel}</strong>
      <button onclick="availCalStep(1)">›</button>
    </div>
    <div class="ucal-grid ucal-head">
      ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => `<div>${d}</div>`).join('')}
    </div>
    <div class="ucal-grid">${cells}</div>
    <div class="ucal-legend">
      <span><i class="sw-full"></i> All day</span>
      <span><i class="sw-partial"></i> Part of day</span>
    </div>`;

  listEl.innerHTML = `
    <div class="detail-section-title" style="margin-top:0.9rem">${guide ? escapeHtml(guideName(guide) || guide) + ' — ' : ''}periods in ${escapeHtml(monthLabel)}</div>
    ${inMonth.length === 0
      ? `<div class="ucal-empty">Nothing marked in ${escapeHtml(monthLabel)}</div>`
      : inMonth.map(p => `
        <div class="ucal-item" style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
          <div>
            <div>${guide ? '' : `<strong style="font-size:0.8rem">${escapeHtml(guideName(p.guide_id) || p.guide_id)}</strong> · `}${fmt(p.from_dt)} → ${fmt(p.to_dt)}</div>
            ${p.reason ? `<div class="ucal-reason">${escapeHtml(p.reason)}</div>` : ''}
          </div>
          <button onclick="adminDeleteUnavailability(${p.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.8rem;padding:0;flex-shrink:0">Remove</button>
        </div>`).join('')}`;
}

async function renderAdminReviews(el) {
  el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  const [team, reviews] = await Promise.all([
    api('/api/team').catch(() => []),
    api('/api/reviews').catch(() => []),
  ]);
  // Who can receive a review = anyone who works with customers, not just guides.
  // Zac is a mechanic but also does shop-floor work and gets good reviews, so
  // key this off capabilities (guide OR shop) rather than the role alone.
  const guides = team.filter(m =>
    m.role === 'guide' || m.role === 'admin' || m.role === 'mechanic' || m.is_guide || m.can_shop
  );
  const today = new Date().toISOString().substring(0, 10);
  const platforms = ['Google Maps', 'GetYourGuide', 'Viator', 'TripAdvisor', 'Airbnb'];

  const _pc = {'Google Maps':{bg:'#E8F0FE',fg:'#1A73E8'},'GetYourGuide':{bg:'#FFE8E2',fg:'#CC3D1F'},'Viator':{bg:'#D6F5EC',fg:'#00754A'},'TripAdvisor':{bg:'#D6F5EC',fg:'#00754A'},'Airbnb':{bg:'#FFE2E3',fg:'#D9363E'}};
  const adminPlatformBadge = p => { const c=_pc[p]||{bg:'var(--surface2)',fg:'var(--text2)'}; return `<span style="font-size:0.7rem;font-weight:700;background:${c.bg};color:${c.fg};padding:2px 8px;border-radius:10px">${p}</span>`; };

  // Show all reviews chronologically, latest first (not grouped by guide).
  const sorted = [...reviews].sort((a, b) =>
    (b.review_date || '').localeCompare(a.review_date || '') || (b.id || 0) - (a.id || 0)
  );

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Log a new review</div>
      <div style="display:flex;flex-direction:column;gap:0.5rem">
        <select class="form-select" id="rev-guide">
          <option value="">Select team member…</option>
          ${[...guides].sort((a,b)=>a.name.localeCompare(b.name)).map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
        </select>
        <div style="display:flex;gap:0.5rem">
          <input class="form-input" type="date" id="rev-date" value="${today}" style="flex:1">
          <select class="form-select" id="rev-platform" style="flex:1">
            ${platforms.map(p => `<option value="${p}">${p}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:0.5rem">
          <select class="form-select" id="rev-type" style="flex:1">
            <option value="Tour">Tour</option>
            <option value="Rental">Rental</option>
          </select>
          <input class="form-input" id="rev-reviewer" placeholder="Reviewer name (optional)" style="flex:2">
        </div>
        <textarea class="form-textarea" id="rev-text" placeholder="Paste the review text here…" style="min-height:100px"></textarea>
        <button class="btn btn-primary" id="rev-submit">Log review &amp; notify guide</button>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">All reviews (${reviews.length})</div>
      ${sorted.length === 0
        ? '<div style="font-size:0.85rem;color:var(--text3)">No reviews logged yet</div>'
        : sorted.map(r => `
          <div class="detail-row" style="flex-direction:column;align-items:flex-start;gap:2px;padding:0.5rem 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;width:100%;justify-content:space-between;align-items:center;gap:0.4rem;flex-wrap:wrap">
              <span style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
                <span style="font-weight:700;font-size:0.82rem">${escapeHtml(r.guide_name || '—')}</span>
                ${adminPlatformBadge(r.platform)}
                <span style="font-size:0.78rem;color:var(--text3)">${r.review_date} · ${r.booking_type}</span>
              </span>
              <button onclick="deleteReview(${r.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.8rem;padding:0">Delete</button>
            </div>
            ${r.reviewer_name ? `<span style="font-size:0.78rem;color:var(--text2)">${escapeHtml(r.reviewer_name)}</span>` : ''}
            ${r.review_text ? `<div style="font-size:0.78rem;color:var(--text3);margin-top:3px;font-style:italic;line-height:1.4">"${escapeHtml(r.review_text)}"</div>` : ''}
          </div>`).join('')}
    </div>
  `;

  document.getElementById('rev-submit').addEventListener('click', async () => {
    const guide_id = document.getElementById('rev-guide').value;
    const review_date = document.getElementById('rev-date').value;
    const platform = document.getElementById('rev-platform').value;
    const booking_type = document.getElementById('rev-type').value;
    const reviewer_name = document.getElementById('rev-reviewer').value.trim();
    const review_text = document.getElementById('rev-text').value.trim();

    if (!guide_id) { toast('Select a guide', 'error'); return; }
    if (!review_date) { toast('Pick a date', 'error'); return; }

    const btn = document.getElementById('rev-submit');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/reviews', { method: 'POST', body: { guide_id, review_date, platform, booking_type, reviewer_name, review_text } });
      toast('Review logged' + (document.querySelector(`option[value="${guide_id}"]`)?.textContent ? ' — email sent to guide' : ''), 'success');
      renderAdminReviews(el);
    } catch(e) {
      toast('Error: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Log review & notify guide';
    }
  });
}

async function deleteReview(id) {
  if (!confirm('Delete this review?')) return;
  try {
    await api(`/api/reviews/${id}`, { method: 'DELETE' });
    toast('Review deleted', 'success');
    renderAdminReviews(document.getElementById('admin-tab-content'));
  } catch(e) {
    toast('Could not delete: ' + e.message, 'error');
  }
}

async function renderAdminAvailability(el) {
  el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  let periods;
  try {
    periods = await api('/api/guides/unavailability');
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  // Names come with the periods (admin query joins team_members); build an
  // id→name lookup so cells/chips/list never show raw ids.
  const names = {};
  periods.forEach(p => { if (p.guide_name) names[p.guide_id] = p.guide_name; });

  const now = new Date();
  const prev = window._availCal;
  window._availCal = {
    guide: prev?.guide || '',
    year: prev?.year ?? now.getFullYear(),
    month: prev?.month ?? now.getMonth(),
    periods,
    guideName: id => names[id],
  };
  // A previously selected guide may have no periods left — reset to All.
  if (window._availCal.guide && !periods.some(p => p.guide_id === window._availCal.guide)) window._availCal.guide = '';

  const guideOpts = Object.entries(names).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${id}" ${window._availCal.guide === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0.5rem">
      <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.75rem">
        <div class="detail-section-title" style="margin:0;flex:1">Guide unavailability (${periods.length})</div>
        <select class="form-select" style="max-width:180px" onchange="availCalSetGuide(this.value)">
          <option value="">All guides</option>
          ${guideOpts}
        </select>
      </div>
      <div id="avail-cal-grid"></div>
      <div id="avail-period-list"></div>
    </div>
  `;
  renderAvailCalParts();
}

async function adminDeleteUnavailability(id) {
  if (!confirm('Remove this unavailability period?')) return;
  try {
    await api(`/api/guides/unavailability/${id}`, { method:'DELETE' });
    toast('Removed', 'success');
    // NB: container id is guides-admin-content (admin-tab-content never existed
    // here — the old wrong id left a stale list after deleting)
    renderAdminAvailability(document.getElementById('guides-admin-content'));
  } catch(e) {
    toast('Could not remove: ' + e.message, 'error');
  }
}

async function sendInvoiceToSoren(invoiceId, guideName, periodLabel) {
  if (!confirm(`Send ${guideName}'s invoice (${periodLabel}) to Søren at sorenherlev@gmail.com?`)) return;
  try {
    await api(`/api/guides/invoices/${invoiceId}/send-to-soren`, { method: 'POST' });
    toast(`Sent to Søren`, 'success');
  } catch(e) {
    toast('Could not send: ' + e.message, 'error');
  }
}

async function renderAdminInvoicing(el) {
  el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  let invoices, instructions;
  try {
    [invoices, instructions] = await Promise.all([
      api('/api/guides/invoices'),
      api('/api/guides/invoice-instructions'),
    ]);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Instructions shown to guides</div>
      <textarea class="form-textarea" id="admin-invoice-instructions" style="min-height:220px;width:100%;box-sizing:border-box;font-family:inherit;font-size:0.85rem">${escapeHtml(instructions.text)}</textarea>
      <button class="btn btn-primary" id="admin-save-instructions" style="margin-top:0.5rem">Save instructions</button>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Uploaded invoices (${invoices.length})</div>
      ${invoices.length === 0 ? '<div style="font-size:0.85rem;color:var(--text3)">No invoices uploaded yet</div>' :
        invoices.map(inv => `
          <div class="detail-row">
            <span class="dr-key">${escapeHtml(inv.guide_name)} · ${escapeHtml(inv.period_label || inv.original_filename)} <span style="color:var(--text3);font-size:0.72rem">· ${fmtDateFull((inv.uploaded_at||'').substring(0,10))}</span></span>
            <span class="dr-val" style="display:flex;gap:0.75rem;align-items:center">
              <a href="/api/guides/invoices/${inv.id}/file" target="_blank">View</a>
              <a href="#" onclick="sendInvoiceToSoren(${inv.id},'${escapeHtml(inv.guide_name)}','${escapeHtml(inv.period_label||inv.original_filename)}');return false;" style="color:var(--green);font-weight:600">Send to Søren</a>
            </span>
          </div>`).join('')}
    </div>
  `;

  document.getElementById('admin-save-instructions').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await api('/api/guides/invoice-instructions', { method:'PUT', body: { text: document.getElementById('admin-invoice-instructions').value }});
      toast('Instructions saved', 'success');
    } catch(err) {
      toast('Could not save: ' + err.message, 'error');
    }
    btn.disabled = false; btn.textContent = 'Save instructions';
  });
}

async function renderBugReports(el) {
  el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  const rows = await api('/api/bug-reports').catch(() => []);
  const open = rows.filter(r => r.status === 'open');
  const resolved = rows.filter(r => r.status === 'resolved');

  if (rows.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No bug reports yet 🎉</p></div>';
    return;
  }

  el.innerHTML = `
    <div class="section-title" style="margin-top:0">${open.length} open</div>
    <div class="bike-list">
      ${open.map(r => `
        <div class="ticket-card">
          <div class="tk-problem">${r.description}</div>
          <div class="tk-meta">${r.reported_by} · ${r.page||''} · ${fmtTime(r.created_at)}</div>
          <div style="margin-top:0.5rem">
            <button class="btn btn-sm btn-success" onclick="resolveBugReport(${r.id})">Mark resolved</button>
          </div>
        </div>`).join('') || '<div class="today-empty">None open</div>'}
    </div>
    ${resolved.length > 0 ? `
      <div class="section-title">${resolved.length} resolved</div>
      <div class="bike-list">
        ${resolved.map(r => `
          <div class="ticket-card" style="opacity:0.6">
            <div class="tk-problem">${r.description}</div>
            <div class="tk-meta">${r.reported_by} · ${fmtTime(r.created_at)}</div>
          </div>`).join('')}
      </div>` : ''}
  `;
}

async function resolveBugReport(id) {
  await api(`/api/bug-reports/${id}`, { method:'PATCH', body:{ status:'resolved' }});
  toast('Marked resolved', 'success');
  renderAdminTab(document.getElementById('content'));
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
    toast(`${id} added`, 'success');
    pushUndo(`${id} added`, async () => {
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
    toast(`${id} updated`, 'success');
    pushUndo(`${id} edit`, async () => {
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
    toast(`${id} ${reactivate?'reactivated':'retired'}`, 'success');
    pushUndo(`${id} ${reactivate?'reactivate':'retire'}`, async () => {
      await api(`/api/fleet/bikes/${id}`, {method:'PATCH', body:{active: reactivate ? false : true}});
      renderAdminTab(document.getElementById('content'));
    });
    renderAdminTab(document.getElementById('content'));
  } catch(e) { toast(e.message, 'error'); }
}

function iconRentals(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 8h-3V4H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1m17-9-2-3h-9l-2 3m13 0v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8m13 0H7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`;}
function iconTours(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;}
function iconToday(){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><rect x="7" y="14" width="4" height="4" rx="1" fill="currentColor" stroke="none"/></svg>`;}
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
  c.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  const role = state.actor?.role;
  const name = state.actor?.name;
  const isGuide = role === 'guide';
  // Look far enough ahead to catch private tours booked weeks out — a guide
  // assigned an A3P six weeks from now needs to see it. The default 30-day
  // window was hiding a real, assigned 31 Aug A3P (47 days out).
  const tours = await api('/api/ical/tours?days=150' + (isGuide ? `&guide=${encodeURIComponent(name)}` : ''));
  renderToursList(c, tours, isGuide);
}

// ── TODAY BOARD (shop manifest) ──────────────────────────────────────────
// Bike type codes, matching bike_types in the fleet (src/db/seed.js).
const CAT_LABELS = {
  A:'Adult bike', SA:'Small adult bike', AC:'Adult + child seat', AT:'Adult + toddler seat',
  B:'Kids bike (small)', BM:'Kids bike (medium)', TB:'Touring bike', MB:'Mountain bike',
  CC:'Cargo bike', E:'Electric bike', GT:'Guided bike',
};
const catLabel = (k) => CAT_LABELS[k] || k;
function hhmmToMin(t) { const m = String(t||'').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }

async function renderTodayBoard(c) {
  const today = new Date().toISOString().substring(0, 10);
  const [tours, rentals, bikes] = await Promise.all([
    api('/api/ical/tours').catch(() => []),
    api('/api/ical/rentals').catch(() => []),
    api('/api/bikes').catch(() => []),
  ]);
  const todayTours = tours.filter(t => (t.start_date || '') === today);
  const todayRentals = rentals.filter(r => (r.start_date || '') === today);

  // bikes currently out, indexed by the booking ref they're linked to
  const outByRef = {};
  bikes.filter(b => b.status === 'out' && b.fareharbor_booking_ref).forEach(b => {
    const k = String(b.fareharbor_booking_ref); (outByRef[k] = outByRef[k] || []).push(b);
  });

  // ---- "Bikes needed today" — ONE number per bike type. ----
  // The shop has one pool of each bike type; a tour bike and a rental bike are
  // the same physical bike. So the answer to "how many must I have ready?" is
  // the PEAK simultaneous demand, per type, across tours AND rentals together.
  //
  //  - A tour holds its bikes from (start - 10min) to (end + 20min), so two
  //    tours far enough apart share the same bikes; overlapping ones don't.
  //  - A rental holds its bikes ALL DAY (they leave and come back days later),
  //    so it overlaps every tour — it's a flat baseline added to the peak.
  //    That includes rentals that STARTED ON AN EARLIER DAY and are still out
  //    (the N-Day feeds), which is why we look at the whole rental window, not
  //    just today's pickups.
  const bikesOf = (r) => { try { return typeof r.bikes_needed === 'string' ? JSON.parse(r.bikes_needed) : (r.bikes_needed || {}); } catch { return {}; } };

  // Rentals that count = only those being PICKED UP today. A bike handed out
  // yesterday on a multi-day rental is already gone from the shop, so it needs
  // no preparing this morning — this number answers "how many bikes must I have
  // ready today", not "how many are in customers' hands".
  const rentalsLive = todayRentals.filter(r => (r.bookings || []).length > 0);

  const cats = new Set();
  todayTours.forEach(t => Object.entries(bikesOf(t)).forEach(([k, n]) => { if (n > 0) cats.add(k); }));
  rentalsLive.forEach(r => Object.entries(bikesOf(r)).forEach(([k, n]) => { if (n > 0) cats.add(k); }));

  const needed = {};
  cats.forEach(cat => {
    // Rentals: flat all-day baseline.
    let rentalN = 0;
    rentalsLive.forEach(r => { rentalN += bikesOf(r)[cat] || 0; });

    // Tours: sweep-line peak, so non-overlapping tours reuse the same bikes.
    const evs = [];
    let untimed = 0;
    todayTours.forEach(t => {
      const n = bikesOf(t)[cat] || 0; if (n <= 0) return;
      const s = hhmmToMin(t.start_time), e = hhmmToMin(t.end_time);
      // A tour with no usable time can't be placed on the timeline — count it
      // in full rather than silently dropping it (better to over-prepare).
      if (s == null || e == null) { untimed += n; return; }
      evs.push([s - 10, n]); evs.push([e + 20, -n]);
    });
    evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // release before acquire at the same minute
    let cur = 0, tourPeak = 0;
    evs.forEach(([, d]) => { cur += d; if (cur > tourPeak) tourPeak = cur; });
    tourPeak += untimed;

    const total = tourPeak + rentalN;
    if (total > 0) needed[cat] = { total, tourPeak, rentalN };
  });

  // ---- Timeline: tour departures + rental pickups, by time ----
  const events = [];
  todayTours.forEach(t => events.push({
    sort: hhmmToMin(t.start_time) ?? 9999, kind: 'tour', time: t.start_time, end: t.end_time,
    label: t.feed_id, who: t.guide || 'No guide yet', pax: t.booking_count, bikes: t.bikes_needed || {}, availId: t.availability_id,
  }));
  todayRentals.forEach(r => (r.bookings || []).forEach(b => {
    const out = outByRef[String(b.ref)] || [];
    events.push({ sort: hhmmToMin(r.start_time) ?? 9999, kind: 'rental', time: r.start_time, who: b.name || 'Unknown', what: b.what, ref: b.ref, availId: r.availability_id, done: out.length > 0, outBikes: out });
  }));
  events.sort((a, b) => a.sort - b.sort);

  // ---- Bikes due back today ----
  const returns = bikes.filter(b => b.status === 'out' && b.return_due && String(b.return_due).substring(0, 10) === today)
    .sort((a, b) => String(a.return_due).localeCompare(String(b.return_due)));

  // ---- Render ----
  const keys = Object.keys(needed).sort((a, b) => needed[b].total - needed[a].total);
  const neededHtml = keys.length
    ? keys.map(k => {
        const v = needed[k];
        // Always say what the bikes are FOR — not only when it's a mix. A bare
        // "Cargo bike 2" leaves the shop guessing whether it's a tour or a rental.
        const parts = [];
        if (v.tourPeak) parts.push(`${v.tourPeak} tour${v.tourPeak !== 1 ? 's' : ''}`);
        if (v.rentalN) parts.push(`${v.rentalN} rental${v.rentalN !== 1 ? 's' : ''}`);
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:0.4rem 0;border-bottom:1px solid var(--border)">
          <span>
            <span style="font-weight:700">${catLabel(k)}</span>
            ${parts.length ? `<span style="font-size:0.72rem;color:var(--text3);margin-left:0.4rem">${parts.join(' + ')}</span>` : ''}
          </span>
          <strong style="font-size:1.15rem">${v.total}</strong>
        </div>`;
      }).join('')
    : '<div style="color:var(--text3);font-size:0.85rem">Nothing needed today</div>';

  const eventsHtml = events.length ? events.map(e => {
    if (e.kind === 'tour') {
      const bikeStr = Object.entries(e.bikes).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${catLabel(k)}`).join(', ');
      return `<div class="rental-card" onclick="openTourDetail('${e.availId}')">
        <div class="rental-card-top"><span class="rental-duration-badge">${e.label}</span><span class="rental-time">${e.time || ''}${e.end ? ' – ' + e.end : ''}</span><span style="margin-left:auto;font-size:0.7rem;color:var(--text3)">TOUR</span></div>
        <div style="font-weight:700;color:var(--text)">${guideEmojiByName(e.who)} ${escapeHtml(e.who)}</div>
        <div style="font-size:0.8rem;color:var(--text2)">${e.pax} guest${e.pax !== 1 ? 's' : ''}${bikeStr ? ' · ' + bikeStr : ''}</div>
      </div>`;
    }
    const doneTag = e.done
      ? `<span style="margin-left:auto;font-size:0.66rem;font-weight:700;background:var(--bg3);color:var(--text3);padding:2px 7px;border-radius:10px">✓ ${e.outBikes.map(x => x.id).join(', ')}</span>`
      : `<span style="margin-left:auto;font-size:0.7rem;color:var(--text3)">RENTAL</span>`;
    return `<div class="rental-card" onclick="openRentalDetail('${e.availId}','${e.ref}')" style="${e.done ? 'opacity:0.6' : ''}">
      <div class="rental-card-top"><span class="rental-duration-badge">Rental</span><span class="rental-time">${e.time || ''}</span>${doneTag}</div>
      <div style="font-weight:700;color:var(--text)">${escapeHtml(e.who)}</div>
      ${e.what ? `<div style="font-size:0.8rem;color:var(--blue);font-weight:600">${escapeHtml(e.what)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty-state" style="padding:1rem 0"><p>Nothing scheduled today</p></div>';

  const returnsHtml = returns.length ? returns.map(b =>
    `<div class="detail-row"><span class="dr-key">${b.id}</span><span class="dr-val">${escapeHtml(b.customer_name || b.assigned_to || '')} · due ${fmtTime(b.return_due)}</span></div>`
  ).join('') : '<div style="color:var(--text3);font-size:0.85rem">Nothing due back today</div>';

  c.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Bikes needed today</div>
      ${neededHtml}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Schedule · ${events.length} today</div>
      ${eventsHtml}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Due back today · ${returns.length}</div>
      ${returnsHtml}
    </div>`;
}

async function renderRentals(c) {
  c.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  const [rentals, bikes] = await Promise.all([
    api('/api/ical/rentals'),
    api('/api/bikes').catch(() => []),
  ]);
  // A booking is "handled" if a bike is currently out against its FareHarbor ref.
  const checkedOutRefs = new Set(
    bikes.filter(b => b.status === 'out' && b.fareharbor_booking_ref)
         .map(b => String(b.fareharbor_booking_ref))
  );
  renderRentalsList(c, rentals, checkedOutRefs);
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
          <div class="tour-pax">${a.booking_count} guest${a.booking_count!==1?'s':''} · ${a.total_bikes > 0 ? a.total_bikes + ' bike' + (a.total_bikes!==1?'s':'') : 'own bikes'}</div>
        </div>
        ${a.guide ? `<div class="tour-guide">${guideEmojiByName(a.guide)} ${a.guide}</div>` : '<div class="tour-no-guide">⚠️ No guide assigned yet</div>'}
        ${needsBikes ? `<div class="tour-bikes">${bikeStr}</div>` : ''}
      </div>`;
    }).join('')}
  `).join('');
}

function renderRentalsList(el, rentals, checkedOutRefs = new Set()) {
  if (rentals.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No upcoming rentals</p></div>';
    return;
  }

  // Flatten: one entry per booking, keeping availability context
  const allBookings = [];
  rentals.forEach(r => {
    const bookings = r.bookings || [];
    if (bookings.length === 0) return;
    bookings.forEach(b => {
      allBookings.push({ ...b, _feed_id: r.feed_id, _start_date: r.start_date, _start_time: r.start_time, _end_time: r.end_time, _avail_id: r.availability_id, _done: checkedOutRefs.has(String(b.ref)) });
    });
  });

  // Group by date
  const byDate = {};
  allBookings.forEach(b => {
    const d = b._start_date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(b);
  });
  // Within each day, sink already-handed-out bookings to the bottom.
  Object.values(byDate).forEach(list => list.sort((a, b) => (a._done ? 1 : 0) - (b._done ? 1 : 0)));

  const sourceColors = {
    'GetYourGuide': { bg:'#FFE8E2', fg:'#CC3D1F' },
    'Viator':       { bg:'#D6F5EC', fg:'#00754A' },
    'TripAdvisor':  { bg:'#D6F5EC', fg:'#00754A' },
    'Airbnb':       { bg:'#FFE2E3', fg:'#D9363E' },
  };

  el.innerHTML = Object.entries(byDate).map(([date, bookings]) => `
    <div class="section-title">${fmtDateFull(date)}</div>
    ${bookings.map(b => {
      const sc = sourceColors[b.source];
      const sourceBadge = (b.source && b.source !== 'direct' && sc)
        ? `<span style="font-size:0.68rem;font-weight:700;background:${sc.bg};color:${sc.fg};padding:2px 7px;border-radius:10px">${b.source}</span>`
        : '';
      const doneBadge = b._done
        ? `<span style="font-size:0.68rem;font-weight:700;background:var(--bg3);color:var(--text3);padding:2px 7px;border-radius:10px">✓ bikes out</span>`
        : '';
      const comment = b.comments ? `<div style="margin-top:0.4rem;padding:0.4rem 0.6rem;background:var(--surface2);border-radius:6px;font-size:0.78rem;color:var(--text2);line-height:1.45;white-space:pre-wrap">${escapeHtml(b.comments)}</div>` : '';
      const bikes = b.what ? `<div style="margin-top:0.35rem;font-size:0.82rem;font-weight:600;color:var(--blue)">${escapeHtml(b.what)}</div>` : '';
      return `<div class="rental-card" onclick="openRentalDetail('${b._avail_id}','${b.ref}')" style="${b._done ? 'opacity:0.5' : ''}">
        <div class="rental-card-top">
          <span class="rental-duration-badge">${b._feed_id}</span>
          <span class="rental-time">${b._start_time || ''}${b._end_time ? ' – ' + b._end_time : ''}</span>
          ${sourceBadge || doneBadge ? `<span style="margin-left:auto;display:flex;gap:0.3rem">${sourceBadge}${doneBadge}</span>` : ''}
        </div>
        <div style="font-size:0.97rem;font-weight:700;color:var(--text)">${escapeHtml(b.name || 'Unknown')}</div>
        ${bikes}
        ${comment}
      </div>`;
    }).join('')}
  `).join('');
}

// ── PROFILE (guides) ─────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtDurationFromMinutes(min) {
  min = min || 0;
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function periodRange(period, customFrom, customTo) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const pad = n => String(n).padStart(2,'0');
  const fmt = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;

  // Billing cycle: 23rd of previous month → 22nd of current month
  // "this cycle": the cycle that contains today
  // If today is on or after the 23rd, cycle is 23rd this month → 22nd next month
  // If today is before the 23rd, cycle is 23rd last month → 22nd this month
  const thisCycleStart = d >= 23
    ? new Date(y, m, 23)
    : new Date(y, m - 1, 23);
  const thisCycleEnd = d >= 23
    ? new Date(y, m + 1, 22)
    : new Date(y, m, 22);

  const lastCycleStart = new Date(thisCycleStart.getFullYear(), thisCycleStart.getMonth() - 1, 23);
  const lastCycleEnd   = new Date(thisCycleStart.getFullYear(), thisCycleStart.getMonth(), 22);

  const cycleLabel = start => {
    const s = start.toLocaleString('en-GB', { month: 'short' });
    const e = new Date(start.getFullYear(), start.getMonth() + 1, 22);
    const es = e.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
    return `23 ${s} – 22 ${es}`;
  };

  if (period === 'last_cycle') {
    return { from: fmt(lastCycleStart), to: fmt(lastCycleEnd), label: cycleLabel(lastCycleStart) };
  }
  if (period === 'this_year') {
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
  }
  if (period === 'custom' && customFrom && customTo) {
    return { from: customFrom, to: customTo, label: `${customFrom} – ${customTo}` };
  }
  // default: this_cycle
  return { from: fmt(thisCycleStart), to: fmt(thisCycleEnd), label: cycleLabel(thisCycleStart) };
}

async function renderProfile(c) {
  const actor = state.actor;
  const role = actor?.role;

  if (role === 'mechanic') {
    await renderMechanicProfile(c);
    return;
  }

  // Guide profile with sub-tabs
  if (!window._profileTab) window._profileTab = 'overview';
  const isTabs = true;

  c.innerHTML = `
    <div class="subtab-row">
      <button class="subtab${window._profileTab==='overview'?' active':''}" onclick="switchProfileTab('overview')">Overview</button>
      <button class="subtab${window._profileTab==='invoice'?' active':''}" onclick="switchProfileTab('invoice')">Invoice</button>
      <button class="subtab${window._profileTab==='availability'?' active':''}" onclick="switchProfileTab('availability')">Availability</button>
      <button class="subtab${window._profileTab==='notifications'?' active':''}" onclick="switchProfileTab('notifications')">Notifications</button>
    </div>
    <div id="profile-tab-content"></div>
  `;
  await renderProfileTab();
}

async function switchProfileTab(tab) {
  window._profileTab = tab;
  logPageView(`profile.${tab}`);
  document.querySelectorAll('.subtab').forEach(b => {
    b.classList.toggle('active', b.textContent === {overview:'Overview', invoice:'Invoice', availability:'Availability', notifications:'Notifications'}[tab]);
  });
  await renderProfileTab();
}

async function renderProfileTab() {
  const el = document.getElementById('profile-tab-content');
  if (!el) return;
  if (window._profileTab === 'notifications') await renderNotificationsTab(el);
  else if (window._profileTab === 'invoice') await renderInvoiceTab(el);
  else if (window._profileTab === 'availability') await renderAvailabilityTab(el);
  else await renderOverviewTab(el);
}

async function renderOverviewTab(el) {
  el.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  if (!window._profilePeriod) window._profilePeriod = 'this_cycle';
  if (!window._profileCustom) window._profileCustom = { from: '', to: '' };
  const actor = state.actor;
  const range = periodRange(window._profilePeriod, window._profileCustom.from, window._profileCustom.to);

  let worked, upcoming, allReviews;
  try {
    [worked, upcoming, allReviews] = await Promise.all([
      api(`/api/ical/guide-hours?guide=${encodeURIComponent(actor.name)}&from=${range.from}&to=${range.to}`),
      api(`/api/ical/guide-hours?guide=${encodeURIComponent(actor.name)}&upcoming=1`),
      api(`/api/reviews`).catch(()=>[]),
    ]);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const reviews = allReviews.filter(r => r.guide_id === actor.id && r.review_date >= range.from && r.review_date <= range.to);
  const reviewCount = reviews.length;
  const bookingCount = worked.total_bookings || 0;
  const ratio = bookingCount > 0 && reviewCount > 0 ? Math.round((reviewCount / bookingCount) * 100) : null;
  const ratioLabel = ratio !== null ? `${ratio}%` : '—';
  const ratioColor = ratio === null ? '' : ratio >= 33 ? 'green' : ratio >= 15 ? 'amber' : 'red';
  const platformColors = {'Google Maps':{bg:'#E8F0FE',fg:'#1A73E8'},'GetYourGuide':{bg:'#FFE8E2',fg:'#CC3D1F'},'Viator':{bg:'#D6F5EC',fg:'#00754A'},'TripAdvisor':{bg:'#D6F5EC',fg:'#00754A'},'Airbnb':{bg:'#FFE2E3',fg:'#D9363E'}};
  const platformBadge = p => { const c=platformColors[p]||{bg:'var(--surface2)',fg:'var(--text2)'}; return `<span style="font-size:0.7rem;font-weight:700;background:${c.bg};color:${c.fg};padding:2px 8px;border-radius:10px">${p}</span>`; };

  el.innerHTML = `
    <div class="section-title">${actor.name}</div>
    <div class="detail-section" style="border-top:none;padding-top:0;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
      <select class="form-select" id="profile-period-select" style="flex:1;min-width:140px">
        <option value="this_cycle" ${window._profilePeriod==='this_cycle'?'selected':''}>This cycle</option>
        <option value="last_cycle" ${window._profilePeriod==='last_cycle'?'selected':''}>Last cycle</option>
        <option value="this_year" ${window._profilePeriod==='this_year'?'selected':''}>This year</option>
        <option value="custom" ${window._profilePeriod==='custom'?'selected':''}>Custom range</option>
      </select>
      ${window._profilePeriod==='custom' ? `
        <input class="form-input" type="date" id="profile-from" value="${window._profileCustom.from}" style="flex:1;min-width:130px">
        <input class="form-input" type="date" id="profile-to" value="${window._profileCustom.to}" style="flex:1;min-width:130px">
        <button class="btn btn-secondary" id="profile-apply-custom">Apply</button>
      ` : ''}
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-card-num green">${fmtDurationFromMinutes(worked.total_minutes)}</div><div class="stat-card-label">Worked · ${range.label}</div></div>
      <div class="stat-card"><div class="stat-card-num">${fmtDurationFromMinutes(upcoming.total_minutes)}</div><div class="stat-card-label">Upcoming</div></div>
      <div class="stat-card"><div class="stat-card-num green">${reviewCount}</div><div class="stat-card-label">5⭐ reviews · ${range.label}</div></div>
      <div class="stat-card"><div class="stat-card-num ${ratioColor}">${ratioLabel}</div><div class="stat-card-label">Review rate</div></div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Reviews · ${range.label}</div>
      ${reviewCount === 0 ? '<div style="font-size:0.85rem;color:var(--text3)">No reviews in this period</div>' :
        reviews.map(r => `<div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
            <span style="display:flex;align-items:center;gap:0.4rem">${platformBadge(r.platform)}<span style="font-size:0.78rem;color:var(--text3)">${r.review_date} · ${r.booking_type}</span></span>
            ${r.reviewer_name ? `<span style="font-size:0.78rem;color:var(--text2)">${escapeHtml(r.reviewer_name)}</span>` : ''}
          </div>
          ${r.review_text ? `<div style="font-size:0.8rem;color:var(--text2);margin-top:4px;font-style:italic;line-height:1.45">"${escapeHtml(r.review_text)}"</div>` : ''}
        </div>`).join('')}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Count worked hours — ${range.label}</div>
      <div style="font-size:0.78rem;color:var(--text3);margin-bottom:0.5rem">Each tour counts as its scheduled length plus prep time before and after.</div>
      ${worked.tours.length === 0 ? '<div style="font-size:0.85rem;color:var(--text3)">No completed tours in this period</div>' :
        worked.tours.map(t => `<div class="detail-row"><span class="dr-key">${fmtDateFull(t.start_date)} · ${t.feed_id}</span><span class="dr-val">${fmtDurationFromMinutes(t.duration_minutes)}</span></div>`).join('')}
      <div class="detail-row" style="border-top:1px solid var(--border);margin-top:0.4rem;padding-top:0.5rem;font-weight:700">
        <span class="dr-key">Total</span><span class="dr-val">${fmtDurationFromMinutes(worked.total_minutes)}</span>
      </div>
    </div>
  `;

  document.getElementById('profile-period-select').addEventListener('change', e => {
    window._profilePeriod = e.target.value;
    renderOverviewTab(el);
  });
  document.getElementById('profile-apply-custom')?.addEventListener('click', () => {
    window._profileCustom.from = document.getElementById('profile-from').value;
    window._profileCustom.to = document.getElementById('profile-to').value;
    if (!window._profileCustom.from || !window._profileCustom.to) { toast('Pick both dates', 'error'); return; }
    renderOverviewTab(el);
  });
}

async function renderInvoiceTab(el) {
  el.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  const actor = state.actor;
  if (!window._profilePeriod) window._profilePeriod = 'this_cycle';
  if (!window._profileCustom) window._profileCustom = { from: '', to: '' };
  const range = periodRange(window._profilePeriod, window._profileCustom.from, window._profileCustom.to);

  let invoices, instructions;
  try {
    [invoices, instructions] = await Promise.all([
      api(`/api/guides/${actor.id}/invoices`).catch(()=>[]),
      api('/api/guides/invoice-instructions').catch(()=>({text:''})),
    ]);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Upload invoice</div>
      <input class="form-input" type="text" id="invoice-period-label" placeholder="Period this invoice covers" value="${escapeHtml(range.label)}" style="margin-bottom:0.5rem;width:100%;box-sizing:border-box">
      <input type="file" id="invoice-file-input" accept="application/pdf,image/*" style="margin-bottom:0.6rem;display:block;width:100%">
      <button class="btn btn-primary btn-full" id="invoice-upload-btn">Upload invoice</button>
      <div style="margin-top:0.9rem">
        ${invoices.length===0 ? '<div style="font-size:0.82rem;color:var(--text3)">No invoices uploaded yet</div>' :
          invoices.map(inv => `<div class="detail-row">
            <span class="dr-key">${escapeHtml(inv.period_label || inv.original_filename)} <span style="color:var(--text3);font-size:0.72rem">· ${fmtDateFull((inv.uploaded_at||'').substring(0,10))}</span></span>
            <span class="dr-val">
              <a href="/api/guides/invoices/${inv.id}/file" target="_blank" style="margin-right:0.7rem">View</a>
              <a href="#" onclick="deleteInvoice(${inv.id});return false;" style="color:var(--red)">Delete</a>
            </span>
          </div>`).join('')}
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">How to invoice</div>
      <div style="font-size:0.85rem;color:var(--text2)">${renderMarkdown(instructions.text || 'No instructions yet.')}</div>
    </div>
  `;
  document.getElementById('invoice-upload-btn').addEventListener('click', () => uploadInvoice(actor.id));
}

async function renderAvailabilityTab(el) {
  el.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let periods;
  try {
    periods = await api('/api/guides/unavailability');
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const fmtDt = s => s ? s.replace('T', ' ').substring(0, 16) : '';

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Mark unavailability</div>
      <div style="display:flex;flex-direction:column;gap:0.5rem">
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <div style="font-size:0.75rem;color:var(--text3);margin-bottom:3px">From</div>
            <input class="form-input" type="datetime-local" id="unavail-from" style="width:100%;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:140px">
            <div style="font-size:0.75rem;color:var(--text3);margin-bottom:3px">Until</div>
            <input class="form-input" type="datetime-local" id="unavail-to" style="width:100%;box-sizing:border-box">
          </div>
        </div>
        <input class="form-input" type="text" id="unavail-reason" placeholder="Reason (optional)">
        <div id="unavail-error" style="display:none;font-size:0.82rem;color:var(--red);padding:0.5rem 0.7rem;background:var(--red-bg,#fff0f0);border-radius:6px;line-height:1.45"></div>
        <button class="btn btn-primary" id="unavail-submit">Mark unavailable</button>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Your unavailability periods</div>
      ${periods.length === 0
        ? '<div style="font-size:0.85rem;color:var(--text3)">No periods marked</div>'
        : periods.map(p => `
          <div class="detail-row" style="align-items:flex-start;flex-direction:column;gap:2px;padding:0.45rem 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;width:100%;justify-content:space-between;align-items:center">
              <span style="font-size:0.85rem;font-weight:600">${fmtDt(p.from_dt)} → ${fmtDt(p.to_dt)}</span>
              <button onclick="deleteUnavailability(${p.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.8rem;padding:0;flex-shrink:0">Remove</button>
            </div>
            ${p.reason ? `<span style="font-size:0.78rem;color:var(--text3)">${escapeHtml(p.reason)}</span>` : ''}
          </div>`).join('')}
    </div>
  `;

  document.getElementById('unavail-submit').addEventListener('click', async () => {
    const from_dt = document.getElementById('unavail-from').value;
    const to_dt = document.getElementById('unavail-to').value;
    const reason = document.getElementById('unavail-reason').value.trim();
    const errEl = document.getElementById('unavail-error');
    errEl.style.display = 'none';

    if (!from_dt || !to_dt) { errEl.textContent = 'Please select both a start and end date/time.'; errEl.style.display = 'block'; return; }
    if (from_dt >= to_dt) { errEl.textContent = 'End must be after start.'; errEl.style.display = 'block'; return; }

    const btn = document.getElementById('unavail-submit');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      await api('/api/guides/unavailability', { method:'POST', body:{ from_dt, to_dt, reason } });
      toast('Unavailability period saved', 'success');
      renderAvailabilityTab(el);
    } catch(e) {
      errEl.textContent = e.message || 'Could not save. Try again.';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Mark unavailable';
    }
  });
}

async function deleteUnavailability(id) {
  if (!confirm('Remove this unavailability period?')) return;
  try {
    await api(`/api/guides/unavailability/${id}`, { method:'DELETE' });
    toast('Removed', 'success');
    renderAvailabilityTab(document.getElementById('profile-tab-content'));
  } catch(e) {
    toast('Could not remove: ' + e.message, 'error');
  }
}

async function renderNotificationsTab(el) {
  el.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  let prefs;
  try {
    prefs = await api('/api/notif-prefs');
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-section-title">Email notifications</div>
      <div style="font-size:0.82rem;color:var(--text3);margin-bottom:0.75rem">Choose which emails you want to receive.</div>
      ${prefs.map(p => `
        <div class="detail-row" style="padding:0.55rem 0">
          <span class="dr-key" style="font-size:0.88rem">${escapeHtml(p.label)}</span>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" data-notif-type="${p.id}" ${p.enabled ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer">
          </label>
        </div>`).join('')}
    </div>
  `;

  el.querySelectorAll('input[data-notif-type]').forEach(cb => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/notif-prefs/${cb.dataset.notifType}`, { method:'PUT', body:{ enabled: cb.checked } });
      } catch(e) {
        toast('Could not save preference', 'error');
        cb.checked = !cb.checked;
      }
    });
  });
}

async function renderMechanicProfile(c) {
  c.innerHTML = `<div class="empty-state"><p>Loading...</p></div>`;
  if (!window._profilePeriod) window._profilePeriod = 'this_cycle';
  if (!window._profileCustom) window._profileCustom = { from: '', to: '' };
  const actor = state.actor;
  const range = periodRange(window._profilePeriod, window._profileCustom.from, window._profileCustom.to);

  let tickets, allReviews;
  try {
    [tickets, allReviews] = await Promise.all([
      api('/api/repairs/tickets').catch(()=>[]),
      api('/api/reviews').catch(()=>[]),
    ]);
  } catch(e) {
    c.innerHTML = `<div class="empty-state"><p>Could not load: ${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const resolved = tickets.filter(t => t.status === 'resolved' && t.resolved_at && t.resolved_at.substring(0,10) >= range.from && t.resolved_at.substring(0,10) <= range.to);
  const reviews = allReviews.filter(r => r.guide_id === actor.id && r.review_date >= range.from && r.review_date <= range.to);
  const platformColors = {'Google Maps':{bg:'#E8F0FE',fg:'#1A73E8'},'GetYourGuide':{bg:'#FFE8E2',fg:'#CC3D1F'},'Viator':{bg:'#D6F5EC',fg:'#00754A'},'TripAdvisor':{bg:'#D6F5EC',fg:'#00754A'},'Airbnb':{bg:'#FFE2E3',fg:'#D9363E'}};
  const platformBadge = p => { const cc=platformColors[p]||{bg:'var(--surface2)',fg:'var(--text2)'}; return `<span style="font-size:0.7rem;font-weight:700;background:${cc.bg};color:${cc.fg};padding:2px 8px;border-radius:10px">${p}</span>`; };

  c.innerHTML = `
    <div class="section-title">${actor.name}</div>
    <div class="detail-section" style="border-top:none;padding-top:0;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
      <select class="form-select" id="profile-period-select" style="flex:1;min-width:140px">
        <option value="this_cycle" ${window._profilePeriod==='this_cycle'?'selected':''}>This cycle</option>
        <option value="last_cycle" ${window._profilePeriod==='last_cycle'?'selected':''}>Last cycle</option>
        <option value="this_year" ${window._profilePeriod==='this_year'?'selected':''}>This year</option>
        <option value="custom" ${window._profilePeriod==='custom'?'selected':''}>Custom range</option>
      </select>
      ${window._profilePeriod==='custom' ? `
        <input class="form-input" type="date" id="profile-from" value="${window._profileCustom.from}" style="flex:1;min-width:130px">
        <input class="form-input" type="date" id="profile-to" value="${window._profileCustom.to}" style="flex:1;min-width:130px">
        <button class="btn btn-secondary" id="profile-apply-custom">Apply</button>
      ` : ''}
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-card-num green">${resolved.length}</div><div class="stat-card-label">Tickets resolved · ${range.label}</div></div>
      <div class="stat-card"><div class="stat-card-num green">${reviews.length}</div><div class="stat-card-label">5⭐ reviews · ${range.label}</div></div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Tickets resolved · ${range.label}</div>
      ${resolved.length === 0 ? '<div style="font-size:0.85rem;color:var(--text3)">No tickets resolved in this period</div>' :
        resolved.map(t => `<div class="detail-row"><span class="dr-key">${fmtDateFull(t.resolved_at?.substring(0,10))} · ${escapeHtml(t.bike_id)}</span><span class="dr-val" style="color:var(--text3);font-size:0.8rem">${escapeHtml(t.problem?.substring(0,40) || '')}</span></div>`).join('')}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Reviews · ${range.label}</div>
      ${reviews.length === 0 ? '<div style="font-size:0.85rem;color:var(--text3)">No reviews in this period</div>' :
        reviews.map(r => `<div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
            ${platformBadge(r.platform)}<span style="font-size:0.78rem;color:var(--text3)">${r.review_date} · ${r.booking_type}</span>
            ${r.reviewer_name ? `<span style="font-size:0.78rem;color:var(--text2);margin-left:auto">${escapeHtml(r.reviewer_name)}</span>` : ''}
          </div>
          ${r.review_text ? `<div style="font-size:0.8rem;color:var(--text2);margin-top:4px;font-style:italic;line-height:1.45">"${escapeHtml(r.review_text)}"</div>` : ''}
        </div>`).join('')}
    </div>
  `;

  document.getElementById('profile-period-select').addEventListener('change', e => {
    window._profilePeriod = e.target.value;
    renderMechanicProfile(c);
  });
  document.getElementById('profile-apply-custom')?.addEventListener('click', () => {
    window._profileCustom.from = document.getElementById('profile-from').value;
    window._profileCustom.to = document.getElementById('profile-to').value;
    if (!window._profileCustom.from || !window._profileCustom.to) { toast('Pick both dates', 'error'); return; }
    renderMechanicProfile(c);
  });
}

function uploadInvoice(guideId) {
  const fileInput = document.getElementById('invoice-file-input');
  const file = fileInput.files[0];
  if (!file) { toast('Choose a file first', 'error'); return; }
  if (file.size > 15*1024*1024) { toast('File too large (max 15MB)', 'error'); return; }

  const periodLabel = document.getElementById('invoice-period-label').value.trim();
  const btn = document.getElementById('invoice-upload-btn');
  btn.disabled = true; btn.textContent = 'Uploading...';

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      await api(`/api/guides/${guideId}/invoices`, { method:'POST', body: {
        filename: file.name, mime_type: file.type, data_base64: base64, period_label: periodLabel,
      }});
      toast('Invoice uploaded', 'success');
      renderProfile(document.getElementById('content'));
    } catch(e) {
      toast('Upload failed: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Upload invoice';
    }
  };
  reader.onerror = () => { toast('Could not read file', 'error'); btn.disabled = false; btn.textContent = 'Upload invoice'; };
  reader.readAsDataURL(file);
}

async function deleteInvoice(id) {
  if (!confirm('Delete this invoice?')) return;
  try {
    await api(`/api/guides/invoices/${id}`, { method:'DELETE' });
    toast('Invoice deleted', 'success');
    renderProfile(document.getElementById('content'));
  } catch(e) {
    toast('Could not delete: ' + e.message, 'error');
  }
}

async function openTourDetail(availId) {
  // Window must cover everything the Tours lists can show (150d), or a far-out
  // tour opens to "Tour not found"
  const tours = await api('/api/ical/tours?days=150');
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
        // Whether the customer still owes money is shop-floor info (you need it
        // when handing the bike over), so it follows the SHOP capability rather
        // than the role — Hassan keeps it after being demoted from admin, and
        // the shared counter device sees it too.
        const canSeePayments = state.shopMode || state.actor?.role === 'admin' || state.actor?.can_shop || state.actor?.role === 'mechanic';
        const unpaid = (canSeePayments && b.due && b.due !== "DKK0.00")
          ? "<span style='font-size:0.68rem;background:#fdecea;color:#e04040;padding:1px 6px;border-radius:10px;margin-left:4px'>Due: "+b.due+"</span>"
          : "";
        return "<div style='padding:0.65rem 0;border-bottom:1px solid var(--border)'>"
          + "<div style='display:flex;align-items:center;flex-wrap:wrap;gap:3px'>"
          + "<span style='font-weight:700;font-size:0.9rem'>"+(b.name||"Unknown")+"</span>"
          + src + unpaid
          + "</div>"
          + (() => {
              const effectiveDate = b.created_at || b.first_seen_at;
              const eligible = !['L2P','L3P','A3P','CUSTOM'].includes(t.feed_id)
                && b.source !== 'Airbnb'
                && effectiveDate && new Date(effectiveDate) < new Date('2026-07-01T00:00:00+02:00');
              return eligible
                ? '<span style="font-size:0.7rem;font-weight:700;background:#e6f4ea;color:#1a7d4a;padding:2px 8px;border-radius:10px;margin-left:4px;border:1px solid #a8ddc0">🚲 Can keep bikes after tour</span>'
                : '';
            })()
          + (b.phone ? "<div style='font-size:0.78rem;color:var(--text2);margin-top:3px'>📞 "+b.phone+"</div>" : "")
          + (b.email ? "<div style='font-size:0.72rem;color:var(--text3)'>"+b.email+"</div>" : "")
          + "<div style='font-size:0.75rem;color:var(--text3);margin-top:2px'>#"+b.ref+(canSeePayments && b.total ? " · "+b.total : "")+"</div>"
          + (b.created_at ? "<div style='font-size:0.7rem;color:var(--text3);margin-top:1px'>Booked "+fmtBookingCreatedAt(b.created_at)+"</div>"
              : b.first_seen_at ? "<div style='font-size:0.7rem;color:var(--text3);margin-top:1px'>First seen "+fmtBookingCreatedAt(b.first_seen_at)+" <span style='opacity:0.7'>(approx.)</span></div>"
              : "")
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

async function openRentalDetail(availId, ref) {
  const [rentals, bikes] = await Promise.all([
    api('/api/ical/rentals'),
    api('/api/bikes').catch(() => []),
  ]);
  const r = rentals.find(x=>x.availability_id===availId);
  if (!r) return;
  const bookings = r.bookings || [];
  // Show ONLY the booking that was clicked (a slot can hold several bookings).
  const b = (ref ? bookings.find(x => String(x.ref) === String(ref)) : null) || bookings[0];
  if (!b) return;

  // Bikes currently out against this booking (linked at checkout by ref).
  const outBikes = bikes.filter(x => x.status === 'out' && String(x.fareharbor_booking_ref) === String(b.ref));

  openModal(`
    <div class="modal-title">${escapeHtml(b.name || 'Unknown')}</div>
    <div class="detail-section" style="border-top:none;padding-top:0">
      <div class="detail-row"><span class="dr-key">Rental</span><span class="dr-val">${r.feed_label} · ${fmtDateFull(r.start_date)}</span></div>
      <div class="detail-row"><span class="dr-key">Time</span><span class="dr-val">${r.start_time || ''}${r.end_time ? ' – ' + r.end_time : ''}</span></div>
      <div class="detail-row"><span class="dr-key">Booking</span><span class="dr-val">#${b.ref}</span></div>
      ${b.phone ? `<div class="detail-row"><span class="dr-key">Phone</span><span class="dr-val">${escapeHtml(b.phone)}</span></div>` : ''}
      ${b.email ? `<div class="detail-row"><span class="dr-key">Email</span><span class="dr-val">${escapeHtml(b.email)}</span></div>` : ''}
      ${b.what ? `<div class="detail-row"><span class="dr-key">Booked</span><span class="dr-val">${escapeHtml(b.what)}</span></div>` : ''}
      ${b.comments ? `<div style="margin-top:0.5rem;padding:0.4rem 0.6rem;background:var(--surface2);border-radius:6px;font-size:0.78rem;color:var(--text2);white-space:pre-wrap">${escapeHtml(b.comments)}</div>` : ''}
    </div>
    ${outBikes.length ? `
      <div class="detail-section">
        <div class="detail-section-title">Bikes checked out (${outBikes.length})</div>
        ${outBikes.map(x => `<div class="detail-row"><span class="dr-key">${x.id}</span><span class="dr-val">${escapeHtml(x.name || x.type_label || '')}${x.return_due ? ' · due ' + fmtTime(x.return_due) : ''}</span></div>`).join('')}
      </div>
      <button class="btn btn-secondary btn-full" id="rental-return-btn" style="margin-top:0.5rem">Return these bikes</button>
      <button class="btn btn-primary btn-full" id="rental-checkout-btn" style="margin-top:0.5rem">Check out more bikes</button>
    ` : `
      <button class="btn btn-primary btn-full" id="rental-checkout-btn" style="margin-top:0.5rem">Check out bikes</button>
    `}
  `);
  const cb = document.getElementById('rental-checkout-btn');
  if (cb) cb.onclick = () => goCheckoutForRental(b);
  const rb = document.getElementById('rental-return-btn');
  if (rb) rb.onclick = () => goReturnForRental(outBikes.map(x => x.id));
}

// Open the Action screen straight into a return, pre-loaded with these bikes.
function goReturnForRental(bikeIds) {
  closeModal();
  state.action = { type: null, bikes: [...bikeIds], searchQ: '', preloaded: null };
  renderTab('action');
  setTimeout(() => selectActionType('return'), 120);
}

// ── "Return all my tour bikes" banner ─────────────────────────────────────
// Guides take bikes via Action → Tour, which tags each bike assignment_type=
// 'tour' and assigned_to=<the guide's name>. So the bikes THIS guide still has
// out on a tour is a clean filter. A persistent banner offers a one-tap return
// of the whole set; it opens the normal Return screen pre-filled so they can
// still drop one a customer kept, or flag one for repair, before confirming.
// Scoped to tour bikes only — any borrowed/city/rental bikes are left alone.
async function myTourBikesOut() {
  const me = (state.actor?.name || '').trim().toLowerCase();
  if (!me || state.shopMode) return [];
  const bikes = await api('/api/bikes').catch(() => []);
  return bikes.filter(b =>
    b.status === 'out' &&
    String(b.assignment_type || '').toLowerCase() === 'tour' &&
    String(b.assigned_to || '').trim().toLowerCase() === me
  );
}

async function refreshReturnAllBanner() {
  const existing = document.getElementById('return-all-banner');
  if (state.shopMode) { existing?.remove(); return; }
  let bikes = [];
  try { bikes = await myTourBikesOut(); } catch { existing?.remove(); return; }
  if (!bikes.length) { existing?.remove(); return; }
  let banner = existing;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'return-all-banner';
    // Persistent bar just above the tabbar, so it stays across tab switches.
    document.getElementById('screen-main').insertBefore(banner, document.getElementById('tabbar'));
  }
  banner.className = 'return-all-banner';
  const n = bikes.length;
  banner.innerHTML = `🚲 You have <strong>${n}</strong> tour bike${n !== 1 ? 's' : ''} out `
    + `<button onclick="returnAllTourBikes()">Return all</button>`;
}

async function returnAllTourBikes() {
  let bikes = [];
  try { bikes = await myTourBikesOut(); } catch {}
  if (!bikes.length) { refreshReturnAllBanner(); toast('No tour bikes out to return', ''); return; }
  state.action = { type: null, bikes: bikes.map(b => b.id), searchQ: '', preloaded: null };
  renderTab('action');
  setTimeout(() => selectActionType('return'), 120);
}

// Open the Action screen straight into a rental checkout, pre-filled with this
// booking's customer, so the user just picks the bike(s) that were handed over.
function goCheckoutForRental(b) {
  closeModal();
  state.action = { type: null, bikes: [], searchQ: '', preloaded: null };
  renderTab('action');
  setTimeout(async () => {
    state.action.fromBooking = b; // existing FareHarbor booking → simplified form
    await selectActionType('rental');
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    set('af-name', b.name);
    set('af-phone', b.phone);
    set('af-email', b.email);
  }, 120);
}

function goCheckoutForTour(tourId, guide) {
  // Pre-set action to tour with guide name
  state.action = { type: 'tour', bikes: [], searchQ: '', preloaded: null };
  renderTab('action');
  setTimeout(() => selectActionType('tour'), 100);
}

function fmtBookingCreatedAt(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  } catch (e) { return iso; }
}

function fmtDateFull(d) {
  if (!d) return '';
  try {
    return new Date(d+'T12:00:00Z').toLocaleDateString('en-DK', {weekday:'short',day:'numeric',month:'short'});
  } catch { return d; }
}

// ── View As (admin preview of another role's view) ───────────────────────
async function renderViewAs(el) {
  const team = await api('/auth/team-admin');
  team.sort((a,b)=>a.name.localeCompare(b.name));
  const hats = (m) => {
    const h = [];
    if (m.can_shop || m.role === 'mechanic' || m.role === 'admin') h.push('Shop');
    if (m.is_guide || m.role === 'guide') h.push('Guide');
    if (m.role === 'admin') h.push('Admin');
    return h.join(' · ') || '—';
  };

  el.innerHTML = `
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">
      Preview the app exactly as another team member would see it. Read-only context — any action you take while previewing is still logged under your real account.
    </p>
    <div class="bike-list">
      ${team.filter(m => m.id !== state.realActor?.id && m.id !== state.actor?.id).map(m => `
        <div class="bike-row" onclick='startViewAs(${JSON.stringify(m.id)}, ${JSON.stringify(m.name)}, ${JSON.stringify(m)})'>
          <div class="br-info">
            <div class="br-name" style="font-weight:600;font-size:0.92rem">${escapeHtml(m.name)}</div>
            <div class="br-detail">${hats(m)}</div>
          </div>
          <span class="badge" style="background:var(--bg3);color:var(--text2)">Preview →</span>
        </div>`).join('')}
    </div>`;
}

function startViewAs(memberId, memberName, member) {
  // Save the real admin identity so we can return to it
  if (!state.realActor) state.realActor = { ...state.actor };
  const m = (member && typeof member === 'object') ? member : { role: member };
  // Carry capabilities too, so the preview reproduces their ACTUAL view (a
  // shop+guide person previews with both hats), not just their role.
  state.actor = { id: memberId, name: memberName, role: m.role, is_guide: m.is_guide, can_shop: m.can_shop, view_mode: m.view_mode };
  state.activeView = null; // let their own default view apply
  state.viewingAs = true;
  buildTabbar();
  renderTab(landingTab());
  showViewAsBanner();
}

function showViewAsBanner() {
  let banner = document.getElementById('view-as-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'view-as-banner';
    document.getElementById('screen-main').insertBefore(banner, document.getElementById('tabbar'));
  }
  banner.className = 'view-as-banner';
  banner.innerHTML = `👁 Viewing as <strong>${state.actor.name}</strong> (${state.actor.role}) <button onclick="exitViewAs()">Exit preview</button>`;
}

function exitViewAs() {
  if (!state.realActor) return;
  state.actor = state.realActor;
  state.realActor = null;
  state.viewingAs = false;
  const banner = document.getElementById('view-as-banner');
  if (banner) banner.remove();
  buildTabbar();
  window._appAdminTab = 'viewas';
  renderTab('app-admin');
}

// ── Shop mode: ask who did this AFTER the action completes ──────────────
async function showShopWhoDidThis(bikeIds) {
  const team = await api('/auth/team').catch(() => []);
  team.sort((a,b)=>a.name.localeCompare(b.name));
  const n = team.length;
  const cols = (n % 4 === 0) ? 4 : 3;

  // Full-screen takeover — not a modal, can't be dismissed without picking someone
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-main').style.display = 'none';
  document.getElementById('screen-identity').classList.add('active');
  document.getElementById('screen-identity').style.display = 'flex';

  document.getElementById('screen-identity').innerHTML = `
    <div class="identity-wrap">
      <div class="bc-logo-wrap">
        <div class="bc-logo-circle"><svg viewBox="0 0 60 60"><text x="4" y="46" font-family="Georgia, serif" font-size="42" font-style="italic" font-weight="bold" fill="white">be</text></svg></div>
        <div class="bc-wordmark">Be<span>Copenhagen</span></div>
      </div>
      <p class="identity-prompt" style="font-size:0.85rem;font-weight:700;color:var(--text)">Who did this?</p>
      <div class="identity-grid" id="shop-attribution-grid" style="--id-cols:${cols}"></div>
    </div>`;

  const grid = document.getElementById('shop-attribution-grid');
  grid.innerHTML = team.map(m=>`
    <button class="identity-btn" data-id="${m.id}">
      <span class="iname">${m.name}</span>
    </button>`).join('');

  grid.querySelectorAll('.identity-btn').forEach(btn=>{
    btn.addEventListener('click', async () => {
      try {
        await api('/api/log/attribute', { method:'POST', body:{ bike_ids: bikeIds, actor_name: btn.querySelector('.iname').textContent }});
      } catch(e) { console.error('Attribution failed:', e); }
      document.getElementById('screen-identity').classList.remove('active');
      document.getElementById('screen-identity').style.display = 'none';
      document.getElementById('screen-main').classList.add('active');
      document.getElementById('screen-main').style.display = 'flex';
      renderAction(document.getElementById('content'));
    });
  });
}

// ── Standalone "+ Booking" — create a FareHarbor booking without checking out a bike in the app ──
function openStandaloneBookingModal() {
  openModal(`
    <div class="modal-title">New FareHarbor booking</div>
    <p style="font-size:0.82rem;color:var(--text2);margin-bottom:1rem">Creates a real booking on FareHarbor. Does not check out any bike in this app — use the Action tab for that.</p>
    <div class="form-group">
      <label class="form-label">Customer name</label>
      <input class="form-input" id="sb-name" placeholder="Name"/>
    </div>
    <div class="form-group">
      <label class="form-label">Phone (optional)</label>
      <input class="form-input" id="sb-phone" placeholder="+45..."/>
    </div>
    <div class="form-group">
      <label class="form-label">Email (optional)</label>
      <input class="form-input" id="sb-email" placeholder="customer@email.com"/>
    </div>
    <div class="form-group">
      <label class="form-label">When</label>
      <select class="form-select" id="sb-when" onchange="document.getElementById('sb-future-datetime').style.display = this.value==='future' ? 'block' : 'none'">
        <option value="now">Now</option>
        <option value="future">Future — pick date/time</option>
      </select>
    </div>
    <div class="form-group" id="sb-future-datetime" style="display:none">
      <label class="form-label">Start date &amp; time</label>
      <input class="form-input" id="sb-start-datetime" type="datetime-local"/>
    </div>
    <div class="form-group">
      <label class="form-label">Number of days</label>
      <select class="form-select" id="sb-days">
        ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14].map(n=>`<option value="${n}">${n} day${n>1?'s':''}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Bikes</label>
      <input class="form-input" id="sb-bike-ids" placeholder="e.g. A29, CC4" autocapitalize="characters"/>
      <div style="font-size:0.72rem;color:var(--text3);margin-top:3px">Comma-separated bike IDs. Types are looked up automatically.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Payment method</label>
      <select class="form-select" id="sb-payment">
        <option value="cash">Cash</option>
        <option value="card">Card terminal / POS</option>
      </select>
    </div>
    <div id="sb-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitStandaloneBooking()">Create booking</button>
    </div>
  `);
}

async function submitStandaloneBooking() {
  const customerName = document.getElementById('sb-name')?.value?.trim();
  const phone = document.getElementById('sb-phone')?.value?.trim();
  const email = document.getElementById('sb-email')?.value?.trim();
  const when = document.getElementById('sb-when')?.value;
  const startDatetime = document.getElementById('sb-start-datetime')?.value;
  const days = parseInt(document.getElementById('sb-days')?.value) || 1;
  const bikeIdsRaw = document.getElementById('sb-bike-ids')?.value?.trim();
  const payment = document.getElementById('sb-payment')?.value || 'cash';
  const err = document.getElementById('sb-error');

  if (!customerName) { err.textContent = 'Customer name required'; return; }
  if (!bikeIdsRaw) { err.textContent = 'At least one bike ID required'; return; }
  if (when === 'future' && !startDatetime) { err.textContent = 'Pick a date and time'; return; }

  const bikeIds = bikeIdsRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  closeModal();
  toast('Creating FareHarbor booking...', '');

  try {
    const result = await api('/api/fareharbor-agent/create-booking', { method:'POST', body:{
      customer_name: customerName, phone, email, days, payment_method: payment,
      bike_ids: bikeIds, start_datetime: when === 'future' ? startDatetime : null,
    }});
    if (result?.booking_ref) {
      toast(`FareHarbor booking #${result.booking_ref} created`, 'success');
    }
  } catch(e) {
    openModal(`
      <div class="modal-title" style="color:var(--red)">⚠️ Booking failed</div>
      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:0.75rem;font-size:0.82rem;color:var(--text2);margin-bottom:1rem;font-family:monospace">
        ${e.message}
      </div>
      <button class="btn btn-primary btn-full" onclick="closeModal()">Got it</button>
    `);
  }
}

// ── Bug report ────────────────────────────────────────────────────────────
document.getElementById('btn-report-bug')?.addEventListener('click', () => {
  openModal(`
    <div class="modal-title">🐛 Report a bug</div>
    <p style="font-size:0.85rem;color:var(--text2);margin-bottom:1rem">This app is in beta — thanks for flagging anything that looks wrong.</p>
    <div class="form-group">
      <label class="form-label">What happened?</label>
      <textarea class="form-textarea" id="bug-description" placeholder="Describe what you were doing and what went wrong..." style="min-height:100px" autofocus></textarea>
    </div>
    <div id="bug-error" style="color:#e04040;font-size:0.85rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitBugReport()">Send report</button>
    </div>
  `);
});

async function submitBugReport() {
  const description = document.getElementById('bug-description')?.value?.trim();
  const err = document.getElementById('bug-error');
  if (!description) { if(err) err.textContent = 'Please describe what happened'; return; }

  try {
    await api('/api/bug-report', { method:'POST', body:{
      description, page: state.currentTab || 'unknown',
    }});
    closeModal();
    toast('Thanks — bug report sent', 'success');
  } catch(e) {
    if (err) err.textContent = e.message;
  }
}
