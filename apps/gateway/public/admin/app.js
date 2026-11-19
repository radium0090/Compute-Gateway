'use strict';

const state = {
  csrfToken: sessionStorage.getItem('rcg_admin_csrf'),
  user: null,
  tenants: [],
  keys: [],
  customers: [],
  inquiries: [],
};

const byId = (id) => document.getElementById(id);
const loginView = byId('login-view');
const consoleView = byId('console-view');
const pageError = byId('page-error');

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined)
    headers.set('content-type', 'application/json');
  if (state.csrfToken && options.method && options.method !== 'GET') {
    headers.set('x-rcg-csrf-token', state.csrfToken);
  }
  const response = await fetch(`/admin/api${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || '请求失败，请稍后重试。';
    const error = new Error(message);
    error.code =
      data.error?.code || data.error?.error?.code || 'request_failed';
    error.status = response.status;
    throw error;
  }
  return data;
}

function showError(message) {
  pageError.textContent = message;
  pageError.classList.toggle('hidden', !message);
}

function setSignedOut() {
  state.user = null;
  state.csrfToken = null;
  sessionStorage.removeItem('rcg_admin_csrf');
  consoleView.classList.add('hidden');
  loginView.classList.remove('hidden');
  byId('login-password').value = '';
}

function setSignedIn(user) {
  state.user = user;
  loginView.classList.add('hidden');
  consoleView.classList.remove('hidden');
  byId('admin-name').textContent = user.display_name;
  byId('admin-email').textContent = user.email;
  byId('password-panel').classList.toggle('hidden', !user.must_change_password);
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.disabled = user.must_change_password;
  });
}

function makeCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function badge(value) {
  const element = document.createElement('span');
  element.className = `badge ${value}`;
  element.textContent = value;
  return element;
}

function formatDate(value) {
  if (!value) return '尚未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function renderTenants() {
  const body = byId('tenant-table');
  body.replaceChildren();
  const select = byId('key-tenant');
  select.replaceChildren();
  for (const tenant of state.tenants) {
    const row = document.createElement('tr');
    row.append(makeCell(tenant.name));
    const statusCell = document.createElement('td');
    statusCell.append(badge(tenant.status));
    row.append(
      statusCell,
      makeCell(tenant.id),
      makeCell(formatDate(tenant.created_at)),
    );
    body.append(row);

    if (tenant.status === 'active') {
      const option = document.createElement('option');
      option.value = tenant.id;
      option.textContent = tenant.name;
      select.append(option);
    }
  }
}

function renderKeys() {
  const body = byId('key-table');
  body.replaceChildren();
  for (const key of state.keys) {
    const row = document.createElement('tr');
    row.append(
      makeCell(key.name),
      makeCell(key.tenant_name),
      makeCell(key.environment),
    );
    const statusCell = document.createElement('td');
    statusCell.append(badge(key.status));
    row.append(statusCell, makeCell(formatDate(key.last_used_at)));
    const actionCell = document.createElement('td');
    if (key.status !== 'revoked') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger-button';
      button.textContent = '撤销';
      button.addEventListener('click', () => revokeKey(key));
      actionCell.append(button);
    }
    row.append(actionCell);
    body.append(row);
  }
}

function entitlementPayload(customer, status) {
  const current = customer.entitlements;
  return {
    status,
    plan_code: current.plan_code || 'private_beta',
    allowed_model_patterns:
      current.allowed_model_patterns.length > 0
        ? current.allowed_model_patterns
        : ['rax/*'],
    allow_streaming: status === 'active',
    allow_tools: current.allow_tools || false,
    requests_per_minute:
      current.status === 'pending' ? 20 : current.requests_per_minute,
    max_concurrent_requests:
      current.status === 'pending' ? 2 : current.max_concurrent_requests,
    max_request_tokens:
      current.status === 'pending' ? 4096 : current.max_request_tokens,
    max_output_tokens:
      current.status === 'pending' ? 1024 : current.max_output_tokens,
    max_active_api_keys:
      current.status === 'pending' ? 2 : current.max_active_api_keys,
    key_ttl_days: current.status === 'pending' ? 90 : current.key_ttl_days,
  };
}

async function updateCustomer(customer, status) {
  const action = status === 'active' ? '激活' : '暂停';
  if (!window.confirm(`确认${action} “${customer.tenant_name}” 的客户访问吗？`))
    return;
  await api(
    `/customers/${encodeURIComponent(customer.tenant_id)}/entitlements`,
    {
      method: 'PUT',
      body: JSON.stringify(entitlementPayload(customer, status)),
    },
  );
  await refresh();
}

function renderCustomers() {
  const body = byId('customer-table');
  body.replaceChildren();
  for (const customer of state.customers) {
    const row = document.createElement('tr');
    row.append(
      makeCell(customer.tenant_name),
      makeCell(`${customer.display_name}\n${customer.email}`),
      makeCell(customer.email_verified_at ? '已验证' : '待验证'),
    );
    const statusCell = document.createElement('td');
    statusCell.append(badge(customer.entitlements.status));
    row.append(statusCell, makeCell(customer.entitlements.plan_code));
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      customer.entitlements.status === 'active'
        ? 'danger-button'
        : 'button primary';
    button.textContent =
      customer.entitlements.status === 'active' ? '暂停' : '激活 Beta';
    button.disabled = !customer.email_verified_at;
    button.addEventListener('click', () =>
      updateCustomer(
        customer,
        customer.entitlements.status === 'active' ? 'suspended' : 'active',
      ),
    );
    action.append(button);
    row.append(action);
    body.append(row);
  }
}

async function updateInquiry(inquiry, status) {
  await api(`/inquiries/${encodeURIComponent(inquiry.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  await refresh();
}

function renderInquiries() {
  const body = byId('inquiry-table');
  body.replaceChildren();
  for (const inquiry of state.inquiries) {
    const row = document.createElement('tr');
    row.append(
      makeCell(`${inquiry.name}\n${inquiry.email}`),
      makeCell(inquiry.company || '—'),
      makeCell(inquiry.message),
    );
    const statusCell = document.createElement('td');
    statusCell.append(badge(inquiry.status));
    row.append(statusCell, makeCell(formatDate(inquiry.created_at)));
    const action = document.createElement('td');
    if (inquiry.status === 'new') {
      const progress = document.createElement('button');
      progress.type = 'button';
      progress.className = 'text-button';
      progress.textContent = '开始处理';
      progress.addEventListener('click', () =>
        updateInquiry(inquiry, 'in_progress'),
      );
      action.append(progress);
    } else {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'text-button';
      close.textContent = '关闭';
      close.addEventListener('click', () => updateInquiry(inquiry, 'closed'));
      action.append(close);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger-button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      if (window.confirm('确认删除这条商务咨询记录吗？'))
        void updateInquiry(inquiry, 'deleted');
    });
    action.append(remove);
    row.append(action);
    body.append(row);
  }
}

function renderDashboard(data) {
  const summary = data.summary;
  byId('metric-tenants').textContent = summary.tenant_count;
  byId('metric-active-tenants').textContent =
    `${summary.active_tenant_count} 个启用`;
  byId('metric-keys').textContent = summary.api_key_count;
  byId('metric-active-keys').textContent =
    `${summary.active_api_key_count} 个有效`;
  byId('metric-used-keys').textContent = summary.api_keys_used_24h;
  const health = byId('health-pill');
  health.className = `health-pill ${data.health.ready ? 'ok' : 'error'}`;
  health.textContent = data.health.ready ? '服务正常' : '服务降级';
  const list = byId('dependency-list');
  list.replaceChildren();
  for (const [name, status] of Object.entries(data.health.checks)) {
    const item = document.createElement('div');
    item.className = 'dependency';
    const label = document.createElement('strong');
    label.textContent = name === 'postgres' ? 'PostgreSQL' : 'Redis';
    const dot = document.createElement('span');
    dot.className = `status-dot ${status === 'ok' ? 'ok' : 'error'}`;
    dot.title = status;
    item.append(label, dot);
    list.append(item);
  }
}

async function refresh() {
  if (state.user?.must_change_password) return;
  showError('');
  try {
    const [dashboard, tenants, keys, customers, inquiries] = await Promise.all([
      api('/dashboard'),
      api('/tenants'),
      api('/api-keys'),
      api('/customers'),
      api('/inquiries'),
    ]);
    state.tenants = tenants.data;
    state.keys = keys.data;
    state.customers = customers.data;
    state.inquiries = inquiries.data;
    renderDashboard(dashboard);
    renderTenants();
    renderKeys();
    renderCustomers();
    renderInquiries();
  } catch (error) {
    if (error.status === 401) return setSignedOut();
    showError(error.message);
  }
}

async function revokeKey(key) {
  if (!window.confirm(`确认撤销 “${key.name}” 吗？此操作立即生效。`)) return;
  try {
    await api(`/api-keys/${encodeURIComponent(key.id)}/revoke`, {
      method: 'POST',
    });
    await refresh();
  } catch (error) {
    showError(error.message);
  }
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorLabel = byId('login-error');
  errorLabel.textContent = '';
  try {
    const result = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        email: byId('login-email').value,
        password: byId('login-password').value,
      }),
    });
    state.csrfToken = result.csrf_token;
    sessionStorage.setItem('rcg_admin_csrf', result.csrf_token);
    setSignedIn(result.user);
    await refresh();
  } catch (error) {
    errorLabel.textContent = error.message;
  }
});

byId('logout-button').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* clear locally */
  }
  setSignedOut();
});

byId('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  try {
    await api('/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: byId('current-password').value,
        new_password: byId('new-password').value,
      }),
    });
    window.alert('密码已更新，请使用新密码重新登录。');
    setSignedOut();
  } catch (error) {
    showError(error.message);
  }
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document
      .querySelectorAll('.nav-item')
      .forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
    const section = item.dataset.section;
    const titles = {
      overview: '服务概览',
      tenants: '租户管理',
      keys: 'API Key 管理',
      customers: '客户账号',
      inquiries: '商务咨询',
    };
    byId('section-title').textContent = titles[section];
    document
      .querySelectorAll('.section-view')
      .forEach((view) => view.classList.add('hidden'));
    byId(`${section}-section`).classList.remove('hidden');
  });
});

byId('refresh-button').addEventListener('click', refresh);
byId('tenant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/tenants', {
      method: 'POST',
      body: JSON.stringify({ name: byId('tenant-name').value }),
    });
    byId('tenant-name').value = '';
    await refresh();
  } catch (error) {
    showError(error.message);
  }
});

const keyDialog = byId('key-dialog');
byId('open-key-dialog').addEventListener('click', () => keyDialog.showModal());
byId('close-key-dialog').addEventListener('click', () => keyDialog.close());
byId('cancel-key-dialog').addEventListener('click', () => keyDialog.close());
byId('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('key-form-error').textContent = '';
  try {
    const result = await api('/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: byId('key-tenant').value,
        name: byId('key-name').value,
        environment: byId('key-environment').value,
        allowed_model_patterns: byId('key-models')
          .value.split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        allow_streaming: byId('key-streaming').checked,
        allow_tools: byId('key-tools').checked,
        requests_per_minute: Number(byId('key-rpm').value),
        max_concurrent_requests: Number(byId('key-concurrency').value),
        expires_at: null,
      }),
    });
    keyDialog.close();
    byId('created-credential').textContent = result.credential;
    byId('credential-dialog').showModal();
    byId('key-form').reset();
    await refresh();
  } catch (error) {
    byId('key-form-error').textContent = error.message;
  }
});

byId('copy-credential').addEventListener('click', async () => {
  await navigator.clipboard.writeText(byId('created-credential').textContent);
  byId('copy-credential').textContent = '已复制';
});
byId('close-credential').addEventListener('click', () => {
  byId('created-credential').textContent = '';
  byId('credential-dialog').close();
});

(async () => {
  if (!state.csrfToken) return setSignedOut();
  try {
    const result = await api('/session');
    setSignedIn(result.user);
    await refresh();
  } catch {
    setSignedOut();
  }
})();
