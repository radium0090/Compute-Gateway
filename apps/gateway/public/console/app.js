const app = document.querySelector('#app');
const csrfKey = 'rcg_console_csrf';
let csrf = sessionStorage.getItem(csrfKey) || '';

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

async function request(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (options.mutation && csrf) headers['x-rcg-csrf-token'] = csrf;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body?.error?.message || 'The request could not be completed.',
    );
  return body;
}

function authLayout(content) {
  app.innerHTML = `<div class="auth-shell"><aside class="auth-story"><a class="brand" href="/"><span class="logo">R</span><span>RAX Compute Gateway</span></a><div class="story-copy"><p>Customer Console</p><h1>One place to control model access.</h1><p>Manage bounded API keys for a stable, provider-neutral endpoint. Your prompts and completions are not stored by the gateway.</p></div><p class="story-foot">RAX Digital · Tokyo, Japan</p></aside><main class="auth-main">${content}</main></div>`;
}

function status(form, message, error = false) {
  const node = form.querySelector('.form-status');
  node.textContent = message;
  node.classList.toggle('error', error);
}

function bindForm(id, handler) {
  const form = document.querySelector(id);
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status(form, 'Working…');
    try {
      await handler(form, new FormData(form));
    } catch (error) {
      status(form, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function loginView() {
  authLayout(
    `<section class="card"><p class="eyebrow">Welcome back</p><h2>Sign in</h2><p class="sub">Use your verified customer account.</p><form class="form" id="login-form"><label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Password<input name="password" type="password" autocomplete="current-password" required /></label><button class="button" type="submit">Sign in securely</button><p class="form-status" role="status"></p></form><p class="switch"><a href="#" id="forgot">Forgot password?</a></p><p class="switch">New to RAX? <a href="/console/register">Request access</a></p></section>`,
  );
  bindForm('#login-form', async (_form, data) => {
    const result = await request('/console/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: data.get('email'),
        password: data.get('password'),
      }),
    });
    csrf = result.csrf_token;
    sessionStorage.setItem(csrfKey, csrf);
    history.replaceState({}, '', '/console/');
    await dashboardView();
  });
  document.querySelector('#forgot')?.addEventListener('click', (event) => {
    event.preventDefault();
    passwordRequestView();
  });
}

function registerView() {
  authLayout(
    `<section class="card"><p class="eyebrow">Private beta</p><h2>Create an account</h2><p class="sub">Verify your email, then RAX will review and approve bounded service access.</p><form class="form" id="register-form"><div class="form-row"><label>Your name<input name="display_name" autocomplete="name" required maxlength="100" /></label><label>Organization<input name="organization_name" autocomplete="organization" required maxlength="160" /></label></div><label>Work email<input name="email" type="email" autocomplete="email" required /></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /><small>Use at least 12 characters.</small></label><label class="check"><input name="accepted_terms" type="checkbox" required /><span>I request private-beta access and acknowledge the <a href="/legal/service" target="_blank" rel="noreferrer">service notice</a> and <a href="/legal/privacy" target="_blank" rel="noreferrer">privacy notice</a>.</span></label><button class="button" type="submit">Create account</button><p class="form-status" role="status"></p></form><p class="switch">Already registered? <a href="/console/login">Sign in</a></p></section>`,
  );
  bindForm('#register-form', async (form, data) => {
    await request('/console/api/register', {
      method: 'POST',
      body: JSON.stringify({
        display_name: data.get('display_name'),
        organization_name: data.get('organization_name'),
        email: data.get('email'),
        password: data.get('password'),
        accepted_terms: data.get('accepted_terms') === 'on',
      }),
    });
    form.reset();
    status(
      form,
      'Account created. Check your email for the verification link.',
    );
  });
}

function passwordRequestView() {
  authLayout(
    `<section class="card"><p class="eyebrow">Account recovery</p><h2>Reset your password</h2><p class="sub">If the address belongs to an active account, we will send a one-time link.</p><form class="form" id="password-request-form"><label>Email<input name="email" type="email" autocomplete="email" required /></label><button class="button" type="submit">Send reset link</button><p class="form-status" role="status"></p></form><p class="switch"><a href="/console/login">Return to sign in</a></p></section>`,
  );
  bindForm('#password-request-form', async (form, data) => {
    await request('/console/api/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email: data.get('email') }),
    });
    status(form, 'If the account is eligible, the reset email is on its way.');
  });
}

async function verifyView() {
  const token = new URLSearchParams(location.search).get('token') || '';
  authLayout(
    `<section class="card error-page"><span class="logo">R</span><h2>Verifying your email</h2><p class="sub" id="verify-status">Please wait…</p><a class="link" href="/console/login">Continue to sign in</a></section>`,
  );
  try {
    await request('/console/api/verification/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    document.querySelector('#verify-status').textContent =
      'Email verified. Your account is ready to sign in while service access is reviewed.';
  } catch (error) {
    document.querySelector('#verify-status').textContent = error.message;
  }
}

function resetPasswordView() {
  const token = new URLSearchParams(location.search).get('token') || '';
  authLayout(
    `<section class="card"><p class="eyebrow">Account recovery</p><h2>Choose a new password</h2><p class="sub">The one-time link expires after one hour.</p><form class="form" id="reset-form"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><button class="button" type="submit">Reset password</button><p class="form-status" role="status"></p></form><p class="switch"><a href="/console/login">Return to sign in</a></p></section>`,
  );
  bindForm('#reset-form', async (form, data) => {
    await request('/console/api/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token, password: data.get('password') }),
    });
    status(form, 'Password reset. You can now sign in.');
    form.reset();
  });
}

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
        new Date(value),
      )
    : 'Never';
}

async function dashboardView() {
  let data;
  try {
    data = await request('/console/api/dashboard');
  } catch {
    loginView();
    return;
  }
  const user = data.user;
  const ent = data.entitlements;
  const active = ent?.status === 'active';
  const rows = data.api_keys
    .map(
      (key) =>
        `<tr><td><strong>${escapeHtml(key.name)}</strong><br /><code>${escapeHtml(key.public_id)}</code></td><td>${escapeHtml(key.status)}</td><td>${formatDate(key.expires_at)}</td><td>${formatDate(key.last_used_at)}</td><td>${key.status === 'active' ? `<button data-revoke="${escapeHtml(key.id)}">Revoke</button>` : ''}</td></tr>`,
    )
    .join('');
  app.innerHTML = `<div class="dashboard"><header class="topbar"><a class="brand" href="/"><span class="logo">R</span><span>RAX Compute Gateway</span></a><div class="account"><span class="avatar">${escapeHtml(user.display_name.slice(0, 1).toUpperCase())}</span><p>${escapeHtml(user.display_name)}<br /><small>${escapeHtml(user.email)}</small></p><button class="logout" id="logout">Sign out</button></div></header><main class="workspace"><div class="workspace-head"><div><p class="eyebrow">Customer Console</p><h1>Your gateway access</h1></div><span class="status ${active ? 'active' : ''}"><i></i>${escapeHtml(ent?.status || 'pending')}</span></div>${active ? '' : '<p class="notice">Your account is verified. RAX is reviewing the tenant and will activate bounded API access before a key can be created.</p>'}<section class="metrics"><div class="metric"><small>Plan</small><strong>${escapeHtml(ent?.plan_code || 'Pending')}</strong></div><div class="metric"><small>Active keys</small><strong>${data.api_keys.filter((k) => k.status === 'active').length} / ${ent?.max_active_api_keys || 0}</strong></div><div class="metric"><small>Requests / minute</small><strong>${ent?.requests_per_minute || '—'}</strong></div><div class="metric"><small>Concurrent requests</small><strong>${ent?.max_concurrent_requests || '—'}</strong></div></section><section class="panel"><div class="panel-head"><div><h2>API keys</h2><p>Credentials are displayed only once at creation.</p></div>${active ? '<button class="button" id="create-key">Create key</button>' : ''}</div>${rows ? `<table class="keys"><thead><tr><th>Key</th><th>Status</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No API keys yet.</div>'}</section></main></div>`;
  document.querySelector('#logout')?.addEventListener('click', async () => {
    try {
      await request('/console/api/logout', { method: 'POST', mutation: true });
    } finally {
      sessionStorage.removeItem(csrfKey);
      csrf = '';
      loginView();
    }
  });
  document
    .querySelector('#create-key')
    ?.addEventListener('click', createKeyModal);
  document.querySelectorAll('[data-revoke]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (
        !confirm(
          'Revoke this API key? Existing applications will stop authenticating.',
        )
      )
        return;
      await request(`/console/api/api-keys/${button.dataset.revoke}`, {
        method: 'DELETE',
        mutation: true,
      });
      await dashboardView();
    }),
  );
}

function createKeyModal() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-backdrop" id="modal"><section class="modal"><h2>Create an API key</h2><p class="sub">The new key inherits your approved tenant limits.</p><form class="form" id="key-form"><label>Key name<input name="name" maxlength="100" placeholder="production-app" required /></label><button class="button" type="submit">Create key</button><button class="button secondary" type="button" id="cancel">Cancel</button><p class="form-status"></p></form></section></div>`,
  );
  const modal = document.querySelector('#modal');
  document
    .querySelector('#cancel')
    ?.addEventListener('click', () => modal.remove());
  bindForm('#key-form', async (_form, data) => {
    const result = await request('/console/api/api-keys', {
      method: 'POST',
      mutation: true,
      body: JSON.stringify({ name: data.get('name') }),
    });
    modal.querySelector('.modal').innerHTML =
      `<h2>Copy this key now</h2><p class="sub">It cannot be recovered after this dialog is closed.</p><code class="secret">${escapeHtml(result.credential)}</code><div class="modal-actions"><button class="button" id="copy">Copy key</button><button class="button secondary" id="done">Done</button></div>`;
    modal
      .querySelector('#copy')
      .addEventListener('click', async () =>
        navigator.clipboard.writeText(result.credential),
      );
    modal.querySelector('#done').addEventListener('click', async () => {
      modal.remove();
      await dashboardView();
    });
  });
}

async function start() {
  const path = location.pathname;
  if (path === '/console/register') return registerView();
  if (path === '/console/verify') return verifyView();
  if (path === '/console/reset-password') return resetPasswordView();
  if (path === '/console/login') return loginView();
  await dashboardView();
}

start();
