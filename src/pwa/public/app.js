// WebAZ — Vanilla JS SPA
// 路由：hash-based (#shop, #orders, #seller, #order/ord_xxx)

// ─── 状态 ────────────────────────────────────────────────────

const state = {
  user: null,
  apiKey: localStorage.getItem('webaz_key') || null,
  unread: 0,
  sse: null,
}

function toggleLang() {
  setLang(window._lang === 'zh' ? 'en' : 'zh')
  document.getElementById('html-root')?.setAttribute('lang', window._lang === 'en' ? 'en' : 'zh-CN')
  route()
}

// ─── API ─────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {}) },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch('/api' + path, opts)
  return res.json()
}

const GET  = (path)       => api('GET',  path)
const POST = (path, body) => api('POST', path, body)

// ─── 路由 ─────────────────────────────────────────────────────

function route() {
  const hash = location.hash.slice(1) || '/'
  const [page, ...params] = hash.split('/')
  render(page || 'shop', params)
}

window.addEventListener('hashchange', route)
window.addEventListener('popstate', route)

function navigate(hash) { location.hash = hash }

// ─── 渲染入口 ─────────────────────────────────────────────────

async function render(page, params) {
  // 未登录时只允许看登录页和商品
  if (!state.apiKey && page !== 'login' && page !== 'shop' && page !== '') {
    return renderLogin()
  }

  // 加载当前用户
  if (state.apiKey && !state.user) {
    state.user = await GET('/me')
    if (state.user?.error) { state.apiKey = null; localStorage.removeItem('webaz_key'); state.user = null }
    else connectSSE()
  }

  // 物流/仲裁员进入商店页时自动跳转到角色首页
  const noShopRoles = ['logistics', 'arbitrator']
  if (noShopRoles.includes(state.user?.role) && (page === '' || page === 'shop')) {
    return navigate(roleHome(state.user.role))
  }

  const app = document.getElementById('app')

  switch (page) {
    case '':
    case 'shop':          return renderShop(app)
    case 'orders':        return renderOrders(app)
    case 'order':         return renderOrderDetail(app, params[0])
    case 'seller':
      if (state.user?.role === 'logistics')  return renderLogistics(app)
      if (state.user?.role === 'arbitrator') return renderDisputeList(app)
      return renderSeller(app)
    case 'wallet':        return renderWallet(app)
    case 'notifications': return renderNotifications(app)
    case 'skills':        return renderSkills(app)
    case 'disputes':      return renderDisputeList(app)
    case 'dispute':       return renderDisputeDetail(app, params[0])
    case 'profile':       return renderProfile(app)
    case 'login':         return renderLogin()
    default:              return renderShop(app)
  }
}

// ─── 工具 ─────────────────────────────────────────────────────

function statusBadge(status) {
  const map = {
    created:          ['gray',   t('待付款')],
    paid:             ['blue',   t('待接单')],
    accepted:         ['yellow', t('待发货')],
    shipped:          ['yellow', t('已发货')],
    picked_up:        ['yellow', t('已揽收')],
    in_transit:       ['yellow', t('运输中')],
    delivered:        ['blue',   t('待确认')],
    confirmed:        ['green',  t('已确认')],
    completed:        ['green',  t('已完成')],
    disputed:         ['red',    t('争议中')],
    cancelled:        ['gray',   t('已取消')],
    fault_seller:     ['red',    t('卖家违约')],
    fault_buyer:      ['red',    t('买家违约')],
    fault_logistics:  ['red',    t('物流违约')],
  }
  const [color, label] = map[status] || ['gray', status]
  return `<span class="badge badge-${color}">${label}</span>`
}

function fmtTime(iso) {
  if (!iso) return ''
  const locale = window._lang === 'en' ? 'en-US' : 'zh-CN'
  return new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function alert$(type, msg) {
  return `<div class="alert alert-${type}">${msg}</div>`
}

function loading$() {
  return `<div class="loading"><span class="spinner"></span>${t('加载中...')}</div>`
}

// 角色首页
function roleHome(role) {
  if (role === 'logistics' || role === 'arbitrator' || role === 'seller') return '#seller'
  return '#shop'
}

function shell(content, activeTab) {
  const role = state.user?.role
  let tabs

  if (role === 'logistics') {
    tabs = [
      { id: 'seller',        icon: '🚚', label: t('配送任务') },
      { id: 'orders',        icon: '📋', label: t('历史记录') },
      { id: 'notifications', icon: '🔔', label: t('通知'), badge: true },
      { id: 'wallet',        icon: '💰', label: t('钱包') },
    ]
  } else if (role === 'arbitrator') {
    tabs = [
      { id: 'seller',        icon: '⚖️', label: t('仲裁台') },
      { id: 'orders',        icon: '📋', label: t('记录') },
      { id: 'notifications', icon: '🔔', label: t('通知'), badge: true },
      { id: 'wallet',        icon: '💰', label: t('钱包') },
    ]
  } else {
    tabs = [
      { id: 'shop',          icon: '🛍️', label: t('商店') },
      { id: 'orders',        icon: '📦', label: t('订单') },
      { id: 'seller',        icon: '🏪', label: role === 'seller' ? t('卖家') : t('后台') },
      { id: 'notifications', icon: '🔔', label: t('通知'), badge: true },
      { id: 'wallet',        icon: '💰', label: t('钱包') },
    ]
  }
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="#shop">🦞 WebAZ</a>
      <div class="navbar-actions">
        <button onclick="toggleLang()" style="background:none;border:1px solid #e5e7eb;cursor:pointer;padding:3px 8px;border-radius:6px;font-size:12px;color:#6b7280;margin-right:4px">${window._lang === 'en' ? '中文' : 'EN'}</button>
        ${state.user
          ? `<button onclick="navigate('#profile')" style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;color:#374151" title="${t('个人资料 & 设置')}">
               <span style="font-size:13px;color:#6b7280">${state.user.name}</span>
               <span style="font-size:18px">👤</span>
             </button>`
          : `<button class="btn btn-primary btn-sm" onclick="navigate('#login')">${t('登录')}</button>`}
      </div>
    </nav>
    <main class="main">${content}</main>
    <nav class="tabbar">
      ${tabs.map(tb => `
        <button class="tab-item ${activeTab === tb.id ? 'active' : ''}" onclick="navigate('#${tb.id}')">
          <span class="tab-icon" style="position:relative">
            ${tb.icon}
            ${tb.badge ? `<span id="notif-badge" style="position:absolute;top:-4px;right:-6px;background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:0 4px;min-width:16px;text-align:center;display:${state.unread > 0 ? 'inline' : 'none'}">${state.unread || ''}</span>` : ''}
          </span>${tb.label}
        </button>`).join('')}
    </nav>`
}

// ─── 个人资料 & 设置 ──────────────────────────────────────────

async function renderProfile(app) {
  app.innerHTML = shell(loading$(), 'profile')
  const data = await GET('/profile')
  if (data.error) return void (app.innerHTML = shell(alert$('error', data.error), 'profile'))

  const roles = data.roles || [data.role]
  const allRoles = ['buyer', 'seller', 'logistics', 'arbitrator']
  const roleLabels = { buyer: t('买家'), seller: t('卖家'), logistics: t('物流'), arbitrator: t('仲裁员') }
  const roleIcons  = { buyer: '🛍️', seller: '🏪', logistics: '🚚', arbitrator: '⚖️' }
  const addable = allRoles.filter(r => !roles.includes(r))

  app.innerHTML = shell(`
    <div class="page-header"><h2>${t('👤 个人资料 & 设置')}</h2></div>
    <div id="profile-msg"></div>

    <!-- 基本信息 -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${t('昵称')}</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:16px">${data.name}</div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:6px">API Key <span style="color:#9ca3af">${t('（你的唯一身份凭证，请妥善保管）')}</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <code id="apikey-display" style="background:#f3f4f6;padding:6px 10px;border-radius:6px;font-size:13px;flex:1;word-break:break-all;filter:blur(4px);user-select:none">${data.api_key}</code>
          <button class="btn btn-outline btn-sm" onclick="toggleApiKey()" id="btn-reveal" style="white-space:nowrap">${t('显示')}</button>
          <button class="btn btn-outline btn-sm" onclick="copyApiKey('${data.api_key}')" style="white-space:nowrap">${t('复制')}</button>
        </div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:6px">${t('钱包余额')}</div>
        <div style="font-size:16px;font-weight:600;color:#059669">${data.wallet?.balance?.toFixed(2) ?? '—'} WAZ</div>
      </div>
    </div>

    <!-- 角色管理 -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div style="font-size:15px;font-weight:600;margin-bottom:12px">${t('角色管理')}</div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:8px">${t('已有角色')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
          ${roles.map(r => `
            <button onclick="switchRole('${r}', this)" style="
              display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:pointer;border:2px solid;
              ${r === data.role ? 'background:#eff6ff;border-color:#3b82f6;color:#1d4ed8;font-weight:600' : 'background:#f9fafb;border-color:#e5e7eb;color:#374151'}
            " title="${r === data.role ? t('当前激活') : t('点击切换')}">
              ${roleIcons[r]} ${roleLabels[r]}
              ${r === data.role ? `<span style="font-size:11px;color:#3b82f6">${t('● 激活')}</span>` : ''}
            </button>
          `).join('')}
        </div>

        ${addable.length > 0 ? `
          <div style="font-size:13px;color:#6b7280;margin-bottom:8px">${t('添加新角色')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${addable.map(r => `
              <button onclick="addRole('${r}', this)" style="
                display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;cursor:pointer;
                background:#f9fafb;border:2px dashed #d1d5db;color:#6b7280
              ">${roleIcons[r]} + ${roleLabels[r]}</button>
            `).join('')}
          </div>
        ` : `<div style="font-size:13px;color:#6b7280">${t('已拥有全部角色')}</div>`}
      </div>
    </div>

    <!-- 找回密钥 -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div style="font-size:15px;font-weight:600;margin-bottom:12px">${t('找回密钥')}</div>
        <p style="font-size:13px;color:#6b7280;margin-bottom:12px">${t('如果你遗失了 API Key，可以通过注册名称找回。')}</p>
        <div style="display:flex;gap:8px">
          <input class="form-control" id="recover-name" placeholder="${t('输入注册时的名称')}" style="flex:1">
          <button class="btn btn-outline" onclick="recoverKey()">${t('找回')}</button>
        </div>
        <div id="recover-result" style="margin-top:10px"></div>
      </div>
    </div>

    <!-- 退出 -->
    <div class="card">
      <div class="card-body">
        <button class="btn btn-outline btn-sm" onclick="logout()" style="color:#dc2626;border-color:#dc2626">${t('退出登录')}</button>
      </div>
    </div>
  `, 'profile')
}

let apiKeyVisible = false
function toggleApiKey() {
  apiKeyVisible = !apiKeyVisible
  const el = document.getElementById('apikey-display')
  const btn = document.getElementById('btn-reveal')
  if (el) el.style.filter = apiKeyVisible ? 'none' : 'blur(4px)'
  if (btn) btn.textContent = apiKeyVisible ? t('隐藏') : t('显示')
}

function copyApiKey(key) {
  navigator.clipboard.writeText(key).then(() => {
    const msgEl = document.getElementById('profile-msg')
    if (msgEl) { msgEl.innerHTML = alert$('success', t('API Key 已复制到剪贴板')); setTimeout(() => msgEl.innerHTML = '', 2000) }
  })
}

async function switchRole(role, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6' }
  const res = await POST('/profile/switch-role', { role })
  if (res.error) {
    if (btn) { btn.disabled = false; btn.style.opacity = '' }
    return void (document.getElementById('profile-msg').innerHTML = alert$('error', res.error))
  }
  state.user = null
  renderProfile(document.getElementById('app'))
}

async function addRole(role, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; btn.style.opacity = '0.6' }
  const res = await POST('/profile/add-role', { role })
  if (res.error) {
    if (btn) { btn.disabled = false; btn.style.opacity = '' }
    return void (document.getElementById('profile-msg').innerHTML = alert$('error', res.error))
  }
  state.user = null
  renderProfile(document.getElementById('app'))
}

async function recoverKey() {
  const name = document.getElementById('recover-name')?.value?.trim()
  if (!name) return
  const res = await api('POST', '/recover-key', { name })
  const el = document.getElementById('recover-result')
  if (!el) return
  if (res.error) return void (el.innerHTML = alert$('error', res.error))
  el.innerHTML = res.accounts.map(a => `
    <div style="background:#f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:600">${a.name} · ${a.role}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
        <code style="font-size:12px;color:#6b7280;filter:blur(3px);cursor:pointer" onclick="this.style.filter='none'">${a.api_key}</code>
        <button class="btn btn-outline btn-sm" onclick="useKey('${a.api_key}')">${t('使用此账号')}</button>
      </div>
    </div>
  `).join('')
}

function useKey(key) {
  localStorage.setItem('webaz_key', key)
  state.apiKey = key
  state.user = null
  navigate('#shop')
}

function logout() {
  localStorage.removeItem('webaz_key')
  state.apiKey = null
  state.user = null
  if (state.sse) { state.sse.close(); state.sse = null }
  navigate('#login')
}

// ─── 登录/注册页 ──────────────────────────────────────────────

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-logo">🦞</div>
      <h1 class="login-title">WebAZ</h1>
      <p class="login-sub">${t('去中心化商业协议 · AI Agent 原生')}</p>
      <div style="text-align:center;margin-bottom:16px">
        <button onclick="toggleLang()" style="background:none;border:1px solid #e5e7eb;cursor:pointer;padding:4px 12px;border-radius:6px;font-size:13px;color:#6b7280">${window._lang === 'en' ? '中文' : 'EN'}</button>
      </div>
      <div id="login-msg"></div>

      <div class="seg-ctrl" style="margin-bottom:24px">
        <button class="seg-btn active" id="tab-login" onclick="switchLoginTab('login')">${t('我已有账号')}</button>
        <button class="seg-btn" id="tab-reg" onclick="switchLoginTab('reg')">${t('注册新账号')}</button>
      </div>

      <div id="panel-login">
        <div class="form-group">
          <label class="form-label">${t('粘贴你的 api_key')}</label>
          <input class="form-control" id="inp-key" placeholder="key_xxxx..." style="font-family:monospace;font-size:13px">
        </div>
        <button class="btn btn-primary" onclick="doLogin()">${t('登录')}</button>
      </div>

      <div id="panel-reg" style="display:none">
        <div class="form-group">
          <label class="form-label">${t('名称 / 店铺名')}</label>
          <input class="form-control" id="inp-name" placeholder="${t('例：陈小明 / 竹韵手工坊')}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('角色')}</label>
          <select class="form-control" id="inp-role">
            <option value="buyer">${t('买家 — 浏览购物')}</option>
            <option value="seller">${t('卖家 — 上架商品')}</option>
            <option value="logistics">${t('物流 — 揽收投递')}</option>
            <option value="arbitrator">${t('仲裁员 — 处理争议')}</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="doRegister()">${t('注册')}</button>
      </div>
    </div>`
}

window.switchLoginTab = (tab) => {
  document.getElementById('panel-login').style.display = tab === 'login' ? '' : 'none'
  document.getElementById('panel-reg').style.display  = tab === 'reg'   ? '' : 'none'
  document.getElementById('tab-login').className = 'seg-btn' + (tab === 'login' ? ' active' : '')
  document.getElementById('tab-reg').className   = 'seg-btn' + (tab === 'reg'   ? ' active' : '')
}

window.doLogin = async () => {
  const key = document.getElementById('inp-key').value.trim()
  if (!key) return showMsg('error', t('请粘贴 api_key'))
  state.apiKey = key
  const user = await GET('/me')
  if (user.error) { state.apiKey = null; return showMsg('error', t('无效的 api_key，请重新输入')) }
  state.user = user
  localStorage.setItem('webaz_key', key)
  navigate(roleHome(user.role))
}

window.doRegister = async () => {
  const name = document.getElementById('inp-name').value.trim()
  const role = document.getElementById('inp-role').value
  if (!name) return showMsg('error', t('请填写名称'))
  const res = await POST('/register', { name, role })
  if (res.error) return showMsg('error', res.error)
  showMsg('success', `${t('注册成功！')}<br>${t('你的 api_key（请妥善保存，这是你的登录凭证）：')}<br><code style="font-size:12px;word-break:break-all">${res.api_key}</code>`)
  state.apiKey = res.api_key
  state.user = { ...res }
  localStorage.setItem('webaz_key', res.api_key)
  setTimeout(() => navigate(roleHome(res.role)), 3000)
}

function showMsg(type, html) {
  const el = document.getElementById('login-msg')
  if (el) el.innerHTML = alert$(type, html)
}

// ─── 商店页 ───────────────────────────────────────────────────

async function renderShop(app) {
  app.innerHTML = shell(loading$(), 'shop')
  const products = await GET('/products')

  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🛍️</div><div class="empty-text">${t('暂无商品')}</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${p.title}</div>
              <div class="product-price">${p.price} <span style="font-size:11px;font-weight:400">WAZ</span></div>
              <div class="product-seller">${repBadge(p.rep_level)}@${p.seller_name}</div>
            </div>
          </div>`).join('')}
       </div>`

  app.innerHTML = shell(`
    <h1 class="page-title">${t('发现好物')}</h1>
    <div class="search-bar">
      <input class="search-input" id="search-inp" placeholder="${t('搜索商品...')}" onkeydown="if(event.key==='Enter')doSearch()">
      <button class="btn btn-primary btn-sm" style="width:auto;padding:10px 16px" onclick="doSearch()">${t('搜')}</button>
    </div>
    <div style="margin-bottom:16px">
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#skills')">${t('⚡ Skill 市场')}</button>
    </div>
    <div id="product-list">${grid}</div>
  `, 'shop')
}

window.doSearch = async () => {
  const q = document.getElementById('search-inp').value.trim()
  document.getElementById('product-list').innerHTML = loading$()
  const products = await GET(`/products?q=${encodeURIComponent(q)}`)
  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">${t('没有找到"')}${q}"</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${p.title}</div>
              <div class="product-price">${p.price} WAZ</div>
              <div class="product-seller">${repBadge(p.rep_level)}@${p.seller_name}</div>
            </div>
          </div>`).join('')}
       </div>`
  document.getElementById('product-list').innerHTML = grid
}

function getCategoryIcon(cat) {
  const map = { '茶具':'🍵', '家居':'🏠', '食品':'🍱', '服装':'👗', '电子':'📱', '手工':'🎨' }
  return map[cat] || '📦'
}

function repBadge(level) {
  const map = { new:'', trusted:'⭐', quality:'🌟', star:'💫', legend:'🔥' }
  return map[level] || ''
}

// 买家下单页
window.render = render  // 暴露给 hash 路由用
window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1)
  if (hash.startsWith('order-product/')) {
    renderBuyPage(document.getElementById('app'), hash.split('/')[1])
  } else {
    route()
  }
})

async function renderBuyPage(app, productId) {
  app.innerHTML = shell(loading$(), 'shop')
  const products = await GET('/products')
  const p = products.find(x => x.id === productId)
  if (!p) return app.innerHTML = shell(`<div class="empty">${t('商品不存在')}</div>`, 'shop')

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:16px" onclick="history.back()">${t('← 返回')}</button>
    <div class="card">
      <div style="font-size:60px;text-align:center;padding:20px 0">${getCategoryIcon(p.category)}</div>
      <h2 style="font-size:18px;font-weight:700;margin-bottom:6px">${p.title}</h2>
      <p style="font-size:14px;color:#6b7280;margin-bottom:12px">${p.description}</p>
      <div class="detail-row"><span class="detail-label">${t('价格')}</span><span class="detail-value" style="color:#4f46e5;font-size:18px">${p.price} WAZ</span></div>
      <div class="detail-row"><span class="detail-label">${t('库存')}</span><span class="detail-value">${p.stock} ${t('件')}</span></div>
      <div class="detail-row"><span class="detail-label">${t('卖家')}</span><span class="detail-value">${p.seller_name}</span></div>
    </div>
    <div id="buy-msg"></div>
    ${state.user?.role === 'buyer' ? `
    <div class="card">
      <div class="form-group">
        <label class="form-label">${t('收货地址')}</label>
        <input class="form-control" id="inp-addr" placeholder="${t('省市区 详细地址')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('备注（可选）')}</label>
        <input class="form-control" id="inp-notes" placeholder="${t('给卖家的留言')}">
      </div>
      <button class="btn btn-primary" onclick="doBuy('${p.id}', ${p.price})">${t('立即下单')} · ${p.price} WAZ</button>
    </div>` : `
    <div class="alert alert-info">${state.user ? t('只有买家账号可以下单') : `<a href="#login" style="color:inherit;font-weight:700">${t('登录')}</a>${t('后下单')}`}</div>`}
  `, 'shop')
}

window.doBuy = async (productId, price) => {
  const addr = document.getElementById('inp-addr').value.trim()
  const notes = document.getElementById('inp-notes').value.trim()
  if (!addr) { document.getElementById('buy-msg').innerHTML = alert$('error', t('请填写收货地址')); return }
  const res = await POST('/orders', { product_id: productId, shipping_address: addr, notes })
  if (res.error) { document.getElementById('buy-msg').innerHTML = alert$('error', res.error); return }
  document.getElementById('buy-msg').innerHTML = alert$('success', `${t('下单成功！')}${price} WAZ ${t('已托管，等待卖家接单')}`)
  setTimeout(() => navigate(`#order/${res.order_id}`), 1500)
}

// ─── 订单列表页 ───────────────────────────────────────────────

async function renderOrders(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'orders')
  const orders = await GET('/orders')

  const list = orders.length === 0
    ? `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">${t('暂无订单')}</div></div>`
    : orders.map(o => `
      <div class="card" onclick="navigate('#order/${o.id}')" style="cursor:pointer">
        <div class="order-item">
          <div class="order-icon">${getCategoryIcon(o.category)}</div>
          <div class="order-info">
            <div class="order-title">${o.product_title}</div>
            <div class="order-meta">${fmtTime(o.created_at)} · ${o.buyer_id === state.user.id ? t('我买的') : t('我卖的')}</div>
            <div style="margin-top:6px">${statusBadge(o.status)}</div>
          </div>
          <div class="order-amount">${o.total_amount}</div>
        </div>
      </div>`).join('')

  app.innerHTML = shell(`<h1 class="page-title">${t('我的订单')}</h1>${list}`, 'orders')
}

// ─── 订单详情页 ───────────────────────────────────────────────

async function renderOrderDetail(app, orderId) {
  if (!orderId) { navigate('#orders'); return }
  app.innerHTML = shell(loading$(), 'orders')
  const data = await GET(`/orders/${orderId}`)
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'orders'); return }

  const { order, history, currentResponsible, activeDeadline, isOverdue, product } = data
  // 如果有争议，拉取含证据的完整争议数据
  let dispute = data.dispute
  if (dispute?.id) {
    const fullDispute = await GET(`/disputes/${dispute.id}`)
    if (!fullDispute.error) dispute = fullDispute
  }
  const isBuyer    = order.buyer_id    === state.user?.id
  const isSeller   = order.seller_id   === state.user?.id
  // 物流方：已分配的 or 尚未分配（可自行揽收）
  const isLogistic = state.user?.role === 'logistics' &&
    (order.logistics_id === state.user?.id || (!order.logistics_id && order.status === 'shipped'))

  // 卖家在 accepted 状态需要物流公司列表
  let logisticsCompanies = []
  if (isSeller && order.status === 'accepted') {
    const lc = await GET('/logistics/companies')
    logisticsCompanies = Array.isArray(lc) ? lc : []
  }

  // 操作按钮
  const actions = getActions(order, isBuyer, isSeller, isLogistic)

  const STATUS_ZH = {
    created:'待付款', paid:'待接单', accepted:'待发货', shipped:'已发货',
    picked_up:'已揽收', in_transit:'运输中', delivered:'待确认',
    confirmed:'已确认', completed:'已完成', disputed:'争议中',
    cancelled:'已取消', fault_seller:'卖家违约', fault_buyer:'买家违约', fault_logistics:'物流违约',
  }

  const historyHtml = (history || []).map(h => `
    <div class="timeline-item">
      <div><span class="timeline-status">${STATUS_ZH[h.from_status] || h.from_status} → ${STATUS_ZH[h.to_status] || h.to_status}</span></div>
      <div class="timeline-actor">${h.actor_name}（${h.actor_role_name || h.actor_role}）</div>
      <div class="timeline-time">${fmtTime(h.created_at)}</div>
      ${h.notes ? `<div class="timeline-evidence" style="color:#6b7280">💬 ${h.notes}</div>` : ''}
      ${(h.evidence_items || []).map(e => `<div class="timeline-evidence">📎 ${e.description}</div>`).join('')}
    </div>`).join('')

  // 物流跟踪卡
  const trackingStepIcons = { shipped:'📦', picked_up:'✅', in_transit:'🚛', delivered:'📬' }
  const trackingHtml = (data.trackingInfo || []).length > 0 ? `
    <div class="card">
      <div class="action-title">🚚 ${t('物流跟踪')}</div>
      ${(data.trackingInfo || []).map(t => `
        <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f3f4f6">
          <div style="font-size:20px;line-height:1;flex-shrink:0">${trackingStepIcons[t.status] || '•'}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">${STATUS_ZH[t.status] || t.status}
              <span style="font-weight:400;color:#6b7280;margin-left:6px">${t.actor}</span>
            </div>
            <div style="font-size:12px;color:#9ca3af">${fmtTime(t.time)}</div>
            ${t.evidence.map(e => {
              const label = (t.status === 'picked_up' && !e.startsWith('快递单号：')) ? `快递单号：${e}` : e
              return `<div style="font-size:13px;color:#374151;margin-top:3px;background:#f9fafb;border-radius:6px;padding:4px 8px">📎 ${label}</div>`
            }).join('')}
          </div>
        </div>`).join('')}
    </div>` : ''

  const disputeHtml = dispute ? buildDisputeHtml(dispute, state.user) : ''

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:16px" onclick="history.back()">${t('← 返回')}</button>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:13px;color:#6b7280;font-family:monospace">${order.id}</div>
        ${statusBadge(order.status)}
      </div>
      <div class="detail-row"><span class="detail-label">${t('商品')}</span><span class="detail-value">${product?.title || ''}</span></div>
      <div class="detail-row"><span class="detail-label">${t('金额')}</span><span class="detail-value" style="color:#4f46e5">${order.total_amount} WAZ</span></div>
      <div class="detail-row"><span class="detail-label">${t('下单时间')}</span><span class="detail-value">${fmtTime(order.created_at)}</span></div>
      ${order.shipping_address ? `<div class="detail-row"><span class="detail-label">${t('收货地址')}</span><span class="detail-value">${order.shipping_address}</span></div>` : ''}
      ${isOverdue ? `<div class="alert alert-error" style="margin-top:12px">⚠️ ${t('已超时！协议将自动判责')}</div>` : ''}
      ${activeDeadline && !isOverdue ? `<div class="alert alert-warning" style="margin-top:12px">${t('截止时间：')}${fmtTime(activeDeadline.deadline)}</div>` : ''}
    </div>

    ${trackingHtml}
    ${disputeHtml}

    <div id="action-area">
      ${actions ? renderActions(orderId, actions, order, logisticsCompanies) : ''}
    </div>

    <div class="card">
      <div class="action-title">${t('完整状态历史')}</div>
      <div class="timeline">${historyHtml || `<div style="color:#6b7280;font-size:13px">${t('暂无记录')}</div>`}</div>
    </div>
  `, 'orders')
}

function getActions(order, isBuyer, isSeller, isLogistic) {
  const s = order.status
  if (isSeller && s === 'paid')
    return [{ action: 'accept', label: '接单', style: 'success' }]
  if (isSeller && s === 'accepted')
    return [{ action: 'ship', label: '确认发货', style: 'success', logisticsSelector: true,
              evidencePlaceholder: '包装状态描述 / 货物说明（可选）' }]
  if (isLogistic && s === 'shipped')
    return [{ action: 'pickup', label: '✅ 确认揽收', style: 'success', needsEvidence: true,
              noteLabel: '快递单号 *', evidencePlaceholder: '如：SF1234567890' }]
  if (isLogistic && s === 'picked_up')
    return [{ action: 'transit', label: '🚛 开始运输', style: 'primary' }]
  if (isLogistic && s === 'in_transit')
    return [{ action: 'deliver', label: '📬 确认投递', style: 'success', needsEvidence: true,
              noteLabel: '投递凭证', evidencePlaceholder: '门牌照片描述 / 收件人姓名 / 签收时间' }]
  if (isBuyer && s === 'delivered')
    return [
      { action: 'confirm', label: '确认收货', style: 'success' },
      { action: 'dispute', label: '发起争议', style: 'danger', needsEvidence: true,
        noteLabel: '争议理由', evidencePlaceholder: '描述问题（货不对版/货损/未收到等）' },
    ]
  return null
}

function renderActions(orderId, actions, order, logisticsCompanies = []) {
  return `
    <div class="action-area">
      <div class="action-title">我的操作</div>
      <div id="action-msg"></div>
      ${actions.map((a, i) => `
        ${a.logisticsSelector ? `
          <div class="form-group">
            <label class="form-label">选择物流公司 <span style="color:#dc2626">*</span></label>
            <select class="form-control" id="logi-select-${i}">
              <option value="">— 请选择物流公司 —</option>
              ${logisticsCompanies.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>
            ${logisticsCompanies.length === 0
              ? `<div class="alert alert-warning" style="margin-top:6px;font-size:13px">暂无已注册的物流公司，请先让物流方注册账号</div>`
              : ''}
          </div>
          <button class="btn btn-${a.style}" style="margin-bottom:8px"
            onclick="handleAction('${orderId}','${a.action}',${i},false,true)">
            ${a.label}
          </button>` :
        a.needsEvidence ? `
          <div class="form-group">
            <label class="form-label">${a.noteLabel || '证据说明'}</label>
            ${a.action === 'pickup'
              ? `<input type="text" class="form-control" id="evid-${i}" placeholder="${a.evidencePlaceholder || '快递单号'}">`
              : `<textarea class="form-control" id="evid-${i}" placeholder="${a.evidencePlaceholder || ''}"></textarea>`}
          </div>
          <button class="btn btn-${a.style}" style="margin-bottom:8px"
            onclick="handleAction('${orderId}','${a.action}',${i},true,false)">
            ${a.label}
          </button>` : `
          <button class="btn btn-${a.style}" style="margin-bottom:8px"
            onclick="handleAction('${orderId}','${a.action}',${i},false,false)">
            ${a.label}
          </button>`}
      `).join('')}
    </div>`
}

window.handleAction = async (orderId, action, idx, needsEvidence, hasLogisticsSelector) => {
  const msgEl = document.getElementById('action-msg')

  let evidDesc = (needsEvidence || hasLogisticsSelector)
    ? (document.getElementById(`evid-${idx}`)?.value?.trim() || '') : ''

  // 揽收：需要快递单号，且自动加前缀
  if (action === 'pickup') {
    if (!evidDesc) { msgEl.innerHTML = alert$('error', '请填写快递单号'); return }
    if (!evidDesc.startsWith('快递单号：')) evidDesc = `快递单号：${evidDesc}`
  }
  // 其他有证据要求的操作
  if (needsEvidence && action !== 'pickup' && !evidDesc) {
    msgEl.innerHTML = alert$('error', '请填写凭证内容'); return
  }

  // 发货：必须选物流公司，自动生成发货证据（单号由物流揽收时回传）
  let logisticsCompanyId = ''
  if (hasLogisticsSelector) {
    const sel = document.getElementById(`logi-select-${idx}`)
    logisticsCompanyId = sel?.value || ''
    if (!logisticsCompanyId) { msgEl.innerHTML = alert$('error', '请选择物流公司'); return }
    const companyName = sel.options[sel.selectedIndex]?.text || logisticsCompanyId
    evidDesc = `已交付物流公司：${companyName}，快递单号待物流揽收后回传`
  }

  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>处理中...</div>`

  const body = { action, notes: evidDesc, evidence_description: evidDesc,
    ...(logisticsCompanyId ? { logistics_company_id: logisticsCompanyId } : {}) }

  const res = await POST(`/orders/${orderId}/action`, body)
  if (res.error) {
    msgEl.innerHTML = alert$('error', res.error)
  } else {
    msgEl.innerHTML = alert$('success', '操作成功！')
    setTimeout(() => renderOrderDetail(document.getElementById('app'), orderId), 1000)
  }
}

// ─── 争议 UI 辅助 ─────────────────────────────────────────────

const DISPUTE_STATUS_LABELS = {
  open:      ['red',    '等待被告回应'],
  in_review: ['yellow', '仲裁审查中'],
  resolved:  ['green',  '已裁定'],
  dismissed: ['gray',   '已撤销'],
}

function disputeStatusBadge(status) {
  const [color, label] = DISPUTE_STATUS_LABELS[status] || ['gray', status]
  return `<span class="badge badge-${color}">${label}</span>`
}

const RULING_LABELS = {
  refund_buyer:    '🔵 全额退款给买家',
  release_seller:  '🟢 资金释放给卖家',
  partial_refund:  '🟡 部分退款',
  liability_split: '⚖️ 责任分配裁定',
}

function evidenceHtml(list, label) {
  if (!list || list.length === 0) return `<div style="color:#9ca3af;font-size:13px">（${label}尚未提交证据）</div>`
  return list.map(e => `
    <div style="background:#f9fafb;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:13px">
      <span style="color:#6b7280">📎 </span>${e.description || e.type}
    </div>`).join('')
}

const EVIDENCE_TYPE_ICONS = {
  text:       '📝',
  image:      '🖼️',
  video:      '🎥',
  document:   '📄',
  chain_data: '⛓️',
}
const EVIDENCE_TYPE_LABELS = {
  text:       '文字说明',
  image:      '图片',
  video:      '视频',
  document:   '单据/文件',
  chain_data: '链上数据（不可篡改）',
}
const EVIDENCE_REQUEST_STATUS = {
  pending:   ['orange', '待提交'],
  submitted: ['green',  '已提交'],
  expired:   ['gray',   '已过期'],
}

function erStatusBadge(status) {
  const [color, label] = EVIDENCE_REQUEST_STATUS[status] || ['gray', status]
  return `<span class="badge badge-${color}" style="font-size:11px">${label}</span>`
}

// 单条证据请求卡片
function evidenceRequestCard(req, currentUserId) {
  const isMe = currentUserId && req.requested_from_id === currentUserId
  // evidence_types 存为 JSON 数组字符串
  let types = []
  try { types = typeof req.evidence_types === 'string' ? JSON.parse(req.evidence_types) : (req.evidence_types || []) } catch(e) {}
  const typeLabels = types.map(t => `${EVIDENCE_TYPE_ICONS[t] || ''}${EVIDENCE_TYPE_LABELS[t] || t}`).join('　')

  const submittedHtml = (req.submitted_items || []).length > 0 ? `
    <div style="margin-top:8px">
      ${req.submitted_items.map(it => `
        <div style="background:#f0fdf4;border-radius:6px;padding:6px 8px;margin-top:4px;font-size:12px">
          <span style="color:#6b7280">${EVIDENCE_TYPE_ICONS[it.type] || ''} ${EVIDENCE_TYPE_LABELS[it.type] || it.type}</span>
          <div style="margin-top:2px">${it.description}</div>
          ${it.file_hash ? `<div style="margin-top:3px;font-family:monospace;font-size:10px;color:#9ca3af" title="Phase 0 模拟锚点，Phase 2 替换为 IPFS CID / 链上 TX">🔒 ${it.file_hash}</div>` : ''}
        </div>`).join('')}
    </div>` : ''

  const submitForm = isMe && req.status === 'pending' ? `
    <div id="er-form-${req.id}" style="margin-top:10px;background:#fffbeb;border-radius:8px;padding:10px">
      <div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:6px">提交所需证据</div>
      <div id="er-msg-${req.id}"></div>
      <select class="form-control" id="er-type-${req.id}" style="margin-bottom:6px;font-size:13px">
        <option value="">— 选择证据类型 —</option>
        ${types.map(t => `<option value="${t}">${EVIDENCE_TYPE_ICONS[t]} ${EVIDENCE_TYPE_LABELS[t] || t}</option>`).join('')}
      </select>
      <textarea class="form-control" id="er-desc-${req.id}" placeholder="详细描述内容（如图片描述、文字陈述、链上 TX hash 等）" style="margin-bottom:6px;font-size:13px"></textarea>
      <input class="form-control" id="er-hash-${req.id}" placeholder="（可选）文件哈希 / IPFS CID / 链上 TX ID" style="margin-bottom:6px;font-size:12px;font-family:monospace">
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="handleSubmitEvidence('${req.id}','${req.dispute_id}')">提交证据</button>
    </div>` : ''

  return `
    <div style="border:1px solid ${isMe && req.status === 'pending' ? '#f59e0b' : '#e5e7eb'};border-radius:8px;padding:10px;margin-top:8px;background:${isMe && req.status === 'pending' ? '#fffdf0' : '#fff'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
        <div style="font-size:13px;font-weight:600">${isMe ? '👤 需要你提供' : `请求 → ${req.requested_from_name || '对方'}（${req.requested_from_role || ''}）`}</div>
        ${erStatusBadge(req.status)}
      </div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:4px">类型：${typeLabels}</div>
      ${req.description ? `<div style="font-size:13px;margin-bottom:4px">${req.description}</div>` : ''}
      <div style="font-size:11px;color:#9ca3af">截止：${fmtTime(req.deadline)}</div>
      ${submittedHtml}
      ${submitForm}
    </div>`
}

function buildDisputeHtml(dispute, user) {
  const isDefendant  = user && user.id === dispute.defendant_id
  const isArbitrator = user && user.role === 'arbitrator'
  // is_party is set by the server; fallback to local check
  const isParty = dispute.is_party || (user && dispute.parties && dispute.parties.some(p => p.id === user.id))
  const parties = dispute.parties || []
  const totalAmount = dispute.total_amount || 0

  // ── 证据请求区块 ──────────────────────────────
  const evidenceRequests = dispute.evidence_requests || []
  const erSection = evidenceRequests.length > 0 ? `
    <div style="margin-top:14px;border-top:1px solid #fef3c7;padding-top:12px">
      <div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:6px">📋 补充证据请求（${evidenceRequests.length} 条）</div>
      ${evidenceRequests.map(req => evidenceRequestCard(req, user?.id)).join('')}
    </div>` : ''

  // ── 参与方证据（物流等第三方主动提交的证据）──────
  const partyEvidence = dispute.party_evidence || []
  const partyEvidenceSection = partyEvidence.length > 0 ? `
    <div style="margin-top:10px">
      <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">其他参与方证据</div>
      ${evidenceHtml(partyEvidence, '参与方')}
    </div>` : ''

  // ── 非被告参与方主动举证（物流等）──────────────
  const canAddPartyEvidence = isParty && !isDefendant && !isArbitrator && dispute.status !== 'resolved'
  const partyAddEvidenceSection = canAddPartyEvidence ? `
    <div style="margin-top:12px;background:#f0f9ff;border-radius:8px;padding:10px 12px">
      <div style="font-size:12px;font-weight:600;color:#0369a1;margin-bottom:6px">📤 主动提交我的证据</div>
      <div id="party-evid-msg"></div>
      <select class="form-control" id="party-evid-type" style="margin-bottom:6px;font-size:13px">
        <option value="text">📝 文字说明</option>
        <option value="image">🖼️ 图片</option>
        <option value="video">🎥 视频</option>
        <option value="document">📄 单据/文件</option>
        <option value="chain_data">⛓️ 链上数据（不可篡改）</option>
      </select>
      <textarea class="form-control" id="party-evid-desc"
        placeholder="详细描述你掌握的证据（如揽收记录、配送轨迹、签收凭证等）"
        style="margin-bottom:6px;font-size:13px"></textarea>
      <input class="form-control" id="party-evid-hash"
        placeholder="（可选）文件哈希 / 链上 TX / IPFS CID"
        style="margin-bottom:8px;font-size:12px;font-family:monospace">
      <button class="btn btn-primary btn-sm" style="width:auto"
        onclick="handleAddPartyEvidence('${dispute.id}')">提交证据</button>
    </div>` : ''

  // ── 被诉方提交反驳 ────────────────────────────
  const respondSection = isDefendant && dispute.status === 'open' ? `
    <div style="margin-top:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">📝 提交我的反驳（截止 ${fmtTime(dispute.respond_deadline)}）</div>
      <div id="respond-msg"></div>
      <textarea class="form-control" id="respond-evidence" placeholder="请描述你的反驳理由、证据（如物流记录、商品照片说明等）" style="margin-bottom:8px"></textarea>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="handleDisputeRespond('${dispute.id}','${dispute.order_id}')">提交反驳证据</button>
    </div>` : ''

  // ── 仲裁员：发起补充证据请求 ──────────────────
  const requestEvidenceSection = isArbitrator && dispute.status !== 'resolved' ? `
    <div style="margin-top:12px">
      <button class="btn btn-outline btn-sm" style="width:auto;font-size:12px" onclick="(function(){var s=document.getElementById('req-ev-section');s.style.display=s.style.display==='none'?'':'none'})()">📋 请求补充证据</button>
      <div id="req-ev-section" style="display:none;margin-top:10px;background:#f8fafc;border-radius:8px;padding:12px">
        <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px">向指定当事方请求证据</div>
        <div id="req-ev-msg"></div>
        <div style="margin-bottom:8px">
          <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">当事方</label>
          <select class="form-control" id="req-ev-party" style="font-size:13px">
            <option value="">— 选择当事方 —</option>
            ${parties.map(p => `<option value="${p.id}">${p.name}（${p.role}）</option>`).join('')}
          </select>
        </div>
        <div style="margin-bottom:8px">
          <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">所需证据类型（可多选）</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${Object.entries(EVIDENCE_TYPE_LABELS).map(([k, v]) => `
              <label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">
                <input type="checkbox" class="req-ev-type" value="${k}"> ${EVIDENCE_TYPE_ICONS[k]} ${v}
              </label>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:8px">
          <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">说明（告诉对方需要提供什么）</label>
          <textarea class="form-control" id="req-ev-desc" placeholder="例：请提供商品发出时的快递单照片" style="font-size:13px"></textarea>
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">截止时间</label>
          <select class="form-control" id="req-ev-deadline" style="font-size:13px">
            <option value="24">24 小时</option>
            <option value="48" selected>48 小时</option>
            <option value="72">72 小时</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="handleRequestEvidence('${dispute.id}')">发送请求</button>
      </div>
    </div>` : ''

  // ── 仲裁员裁定（含责任分配）────────────────────
  const arbitrateSection = isArbitrator && (dispute.status === 'open' || dispute.status === 'in_review') ? `
    <div style="margin-top:12px;border-top:1px solid #fecaca;padding-top:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:8px">⚖️ 仲裁员裁定（截止 ${fmtTime(dispute.arbitrate_deadline)}）</div>
      <div style="font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:6px 10px;margin-bottom:8px">
        💰 败诉方须缴纳仲裁费：订单金额 × 1%（最低 1 WAZ）。部分退款时双方各付 0.5%。仲裁费 50% 归仲裁员，50% 归协议。
      </div>
      <div id="arbitrate-msg"></div>

      <div class="form-group" style="margin-bottom:10px">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">裁定方式</label>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${[
            ['refund_buyer',    '🔵 全额退款买家（买家胜诉，卖家承担）'],
            ['release_seller',  '🟢 资金释放给卖家（卖家胜诉）'],
            ['partial_refund',  '🟡 部分退款（折中，需填金额）'],
            ['liability_split', '⚖️ 责任分配（指定各方赔付额）'],
          ].map(([val, label]) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:8px;background:#f9fafb;border-radius:6px">
              <input type="radio" name="arb-ruling-radio" value="${val}" onclick="onArbRulingChange('${val}')"> ${label}
            </label>`).join('')}
        </div>
      </div>

      <!-- 部分退款金额 -->
      <div id="arb-partial-row" style="display:none;margin-bottom:8px">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">退款金额（WAZ，订单总额 ${totalAmount}）</label>
        <input class="form-control" id="arb-amount" type="number" step="0.01" min="0" max="${totalAmount}" placeholder="填写退款金额">
      </div>

      <!-- 责任分配区块 -->
      <div id="arb-liability-block" style="display:none;margin-bottom:10px;background:#fff7ed;border-radius:8px;padding:12px">
        <div style="font-size:12px;font-weight:600;color:#9a3412;margin-bottom:8px">责任方赔付分配</div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:8px">订单总额：${totalAmount} WAZ。填写各方应承担的赔偿金额，总和即为退款给买家的金额。</div>
        ${parties.map(p => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <label style="display:flex;align-items:center;gap:4px;font-size:13px;min-width:130px;cursor:pointer">
              <input type="checkbox" class="arb-liable-chk" value="${p.id}" data-role="${p.role}" data-name="${p.name}">
              ${p.role === 'seller' ? '🏪' : p.role === 'logistics' ? '🚚' : '👤'} ${p.name}（${p.role}）
            </label>
            <input type="number" class="form-control arb-liable-amount" data-party="${p.id}"
              step="0.01" min="0" max="${totalAmount}" placeholder="赔付金额"
              style="width:110px;font-size:13px" disabled>
            ${p.role === 'logistics' ? `
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#6b7280;white-space:nowrap">
                <input type="checkbox" class="arb-liable-insurance" data-party="${p.id}"> 保险兜底
                <input type="number" class="form-control arb-liable-cap" data-party="${p.id}"
                  step="0.01" min="0" placeholder="上限" style="width:80px;font-size:12px;margin-left:4px" disabled>
              </label>` : ''}
          </div>`).join('')}
        <div style="font-size:12px;color:#374151;margin-top:4px">
          合计退款：<span id="arb-total-calc" style="font-weight:700">0</span> WAZ
        </div>
      </div>

      <div style="margin-bottom:8px">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">裁定理由 *</label>
        <textarea class="form-control" id="arb-reason" placeholder="请详细说明裁定依据（将记录在案）" style="font-size:13px"></textarea>
      </div>
      <button class="btn btn-danger btn-sm" style="width:auto" onclick="handleArbitrate('${dispute.id}')">确认裁定</button>
    </div>` : ''

  // ── 裁定结果 ──────────────────────────────────
  let rulingDetailHtml = ''
  if (dispute.status === 'resolved') {
    const liabilityParties = (() => {
      try { return JSON.parse(dispute.liability_parties || '[]') } catch { return [] }
    })()
    rulingDetailHtml = `
      <div style="margin-top:12px;background:#f0fdf4;border-radius:8px;padding:10px 12px">
        <div style="font-weight:700;color:#15803d;margin-bottom:4px">${RULING_LABELS[dispute.ruling_type] || dispute.ruling_type}</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px">${dispute.verdict_reason || ''}</div>
        ${dispute.refund_amount != null ? `<div style="font-size:13px">退款金额：<strong>${dispute.refund_amount} WAZ</strong></div>` : ''}
        ${liabilityParties.length > 0 ? `
          <div style="margin-top:6px;font-size:12px;color:#6b7280">责任分配：</div>
          ${liabilityParties.map(lp => `
            <div style="font-size:12px;margin-top:2px">
              ${lp.role === 'logistics' ? '🚚' : lp.role === 'seller' ? '🏪' : '👤'} ${lp.role}
              承担 ${lp.amount} WAZ
              ${lp.insurance_cap != null ? `（保险兜底上限 ${lp.insurance_cap} WAZ）` : ''}
            </div>`).join('')}
        ` : ''}
      </div>`
  }

  return `
    <div class="card" style="border-left:3px solid #dc2626">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700">⚖️ 争议详情</div>
        ${disputeStatusBadge(dispute.status)}
      </div>
      <div class="detail-row"><span class="detail-label">发起方</span><span class="detail-value">${dispute.initiator_name}（${dispute.initiator_role || ''}）</span></div>
      <div class="detail-row"><span class="detail-label">被诉方</span><span class="detail-value">${dispute.defendant_name || '—'}（${dispute.defendant_role || ''}）</span></div>
      <div class="detail-row"><span class="detail-label">争议原因</span><span class="detail-value">${dispute.reason}</span></div>
      ${dispute.respond_deadline && dispute.status === 'open' ? `<div class="detail-row"><span class="detail-label">被告截止</span><span class="detail-value">${fmtTime(dispute.respond_deadline)}</span></div>` : ''}

      <div style="margin-top:12px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">原告证据</div>
        ${evidenceHtml(dispute.plaintiff_evidence, '原告')}
      </div>

      ${dispute.status !== 'open' || dispute.defendant_notes ? `
      <div style="margin-top:10px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px">被告回应</div>
        ${dispute.defendant_notes ? `<div style="font-size:13px;margin-bottom:4px">${dispute.defendant_notes}</div>` : ''}
        ${evidenceHtml(dispute.defendant_evidence, '被告')}
      </div>` : ''}

      ${partyEvidenceSection}
      ${erSection}
      ${rulingDetailHtml}
      ${respondSection}
      ${partyAddEvidenceSection}
      ${requestEvidenceSection}
      ${arbitrateSection}

      <div style="margin-top:10px;text-align:right">
        <button class="btn btn-gray btn-sm" style="width:auto" onclick="navigate('#dispute/${dispute.id}')">查看完整争议页</button>
      </div>
    </div>`
}

// 被诉方提交反驳
window.handleDisputeRespond = async (disputeId, orderId) => {
  const evidence = document.getElementById('respond-evidence')?.value?.trim() || ''
  const msgEl = document.getElementById('respond-msg')
  if (!evidence) { msgEl.innerHTML = alert$('error', '请填写反驳内容'); return }
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>提交中...</div>`
  const res = await POST(`/disputes/${disputeId}/respond`, { evidence_description: evidence })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', res.message || '反驳已提交！')
  setTimeout(() => renderOrderDetail(document.getElementById('app'), orderId), 1200)
}

// 参与方主动提交证据（物流等非被告方）
window.handleAddPartyEvidence = async (disputeId) => {
  const type = document.getElementById('party-evid-type')?.value || 'text'
  const desc = document.getElementById('party-evid-desc')?.value?.trim()
  const hash = document.getElementById('party-evid-hash')?.value?.trim()
  const msgEl = document.getElementById('party-evid-msg')
  if (!desc) { msgEl.innerHTML = alert$('error', '请填写证据内容'); return }
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>提交中...</div>`
  const res = await POST(`/disputes/${disputeId}/add-evidence`, {
    description: desc, evidence_type: type, file_hash: hash || undefined
  })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', `已提交！锚点哈希：${res.anchor_hash || ''}`)
  setTimeout(() => renderDisputeDetail(document.getElementById('app'), disputeId), 1500)
}

// 仲裁员裁定
window.handleArbitrate = async (disputeId) => {
  const ruling = document.querySelector('input[name="arb-ruling-radio"]:checked')?.value
  const reason = document.getElementById('arb-reason')?.value?.trim()
  const msgEl  = document.getElementById('arbitrate-msg')
  if (!ruling) { msgEl.innerHTML = alert$('error', '请选择裁定方式'); return }
  if (!reason) { msgEl.innerHTML = alert$('error', '请填写裁定理由'); return }

  let body = { ruling, reason }

  if (ruling === 'partial_refund') {
    const amount = document.getElementById('arb-amount')?.value
    if (!amount) { msgEl.innerHTML = alert$('error', '部分退款需填写退款金额'); return }
    body = { ...body, refund_amount: Number(amount) }
  }

  if (ruling === 'liability_split') {
    const liabilityParties = []
    let totalCalc = 0
    for (const chk of document.querySelectorAll('.arb-liable-chk:checked')) {
      const partyId = chk.value
      const amtEl = document.querySelector(`.arb-liable-amount[data-party="${partyId}"]`)
      const amt = parseFloat(amtEl?.value || '0')
      if (!amt || amt <= 0) {
        msgEl.innerHTML = alert$('error', `请填写 ${chk.dataset.name} 的赔付金额`); return
      }
      const entry = { user_id: partyId, role: chk.dataset.role, amount: amt }
      const insuranceChk = document.querySelector(`.arb-liable-insurance[data-party="${partyId}"]`)
      if (insuranceChk?.checked) {
        const capEl = document.querySelector(`.arb-liable-cap[data-party="${partyId}"]`)
        const cap = parseFloat(capEl?.value || '0')
        if (cap > 0) entry.insurance_cap = cap
      }
      liabilityParties.push(entry)
      totalCalc += amt
    }
    if (liabilityParties.length === 0) {
      msgEl.innerHTML = alert$('error', '请至少选择一个责任方并填写金额'); return
    }
    body = { ...body, liability_parties: liabilityParties, refund_amount: totalCalc }
  }

  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>裁定中...</div>`
  const res = await POST(`/disputes/${disputeId}/arbitrate`, body)
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }

  // 显示仲裁费明细
  const fees = res.settlement?.arbitration_fees || {}
  const feeLines = Object.entries(fees).map(([uid, f]) => `用户 ${uid.slice(-6)} 缴纳仲裁费 ${f} WAZ`).join('；')
  const feeNote = feeLines ? `<div style="margin-top:6px;font-size:12px;color:#6b7280">💰 仲裁费：${feeLines}</div>` : ''
  msgEl.innerHTML = alert$('success', (res.message || '裁定已执行！') + feeNote)
  setTimeout(() => renderDisputeList(document.getElementById('app')), 2000)
}

// 裁定方式切换 → 控制相关输入框显隐
window.onArbRulingChange = (ruling) => {
  const partialRow = document.getElementById('arb-partial-row')
  const liabilityBlock = document.getElementById('arb-liability-block')
  if (partialRow) partialRow.style.display = ruling === 'partial_refund' ? '' : 'none'
  if (liabilityBlock) liabilityBlock.style.display = ruling === 'liability_split' ? '' : 'none'
}

// 责任分配：勾选责任方时启用金额输入框，并实时计算合计
document.addEventListener('change', (e) => {
  if (e.target?.classList.contains('arb-liable-chk')) {
    const partyId = e.target.value
    const amtEl = document.querySelector(`.arb-liable-amount[data-party="${partyId}"]`)
    if (amtEl) amtEl.disabled = !e.target.checked
    updateLiabilityTotal()
  }
  if (e.target?.classList.contains('arb-liable-amount')) updateLiabilityTotal()
  if (e.target?.classList.contains('arb-liable-insurance')) {
    const partyId = e.target.dataset.party
    const capEl = document.querySelector(`.arb-liable-cap[data-party="${partyId}"]`)
    if (capEl) capEl.disabled = !e.target.checked
  }
})

function updateLiabilityTotal() {
  let total = 0
  for (const el of document.querySelectorAll('.arb-liable-amount:not([disabled])')) {
    total += parseFloat(el.value || '0') || 0
  }
  const calcEl = document.getElementById('arb-total-calc')
  if (calcEl) calcEl.textContent = total.toFixed(2)
}

// 仲裁员请求补充证据
window.handleRequestEvidence = async (disputeId) => {
  const partyId   = document.getElementById('req-ev-party')?.value
  const desc      = document.getElementById('req-ev-desc')?.value?.trim()
  const deadlineH = document.getElementById('req-ev-deadline')?.value
  const msgEl     = document.getElementById('req-ev-msg')
  const types     = [...document.querySelectorAll('.req-ev-type:checked')].map(el => el.value)
  if (!partyId)           { msgEl.innerHTML = alert$('error', '请选择当事方'); return }
  if (types.length === 0) { msgEl.innerHTML = alert$('error', '请至少选择一种证据类型'); return }
  if (!desc)              { msgEl.innerHTML = alert$('error', '请填写说明'); return }
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>发送中...</div>`
  const res = await POST(`/disputes/${disputeId}/request-evidence`, {
    requested_from_id: partyId,
    evidence_types: types,
    description: desc,
    deadline_hours: Number(deadlineH) || 48,
  })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', '已发送证据请求！')
  setTimeout(() => renderDisputeDetail(document.getElementById('app'), disputeId), 1200)
}

// 当事方提交证据
window.handleSubmitEvidence = async (requestId, disputeId) => {
  const type    = document.getElementById(`er-type-${requestId}`)?.value
  const desc    = document.getElementById(`er-desc-${requestId}`)?.value?.trim()
  const hash    = document.getElementById(`er-hash-${requestId}`)?.value?.trim()
  const msgEl   = document.getElementById(`er-msg-${requestId}`)
  if (!type) { msgEl.innerHTML = alert$('error', '请选择证据类型'); return }
  if (!desc) { msgEl.innerHTML = alert$('error', '请填写内容'); return }
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>提交中...</div>`
  const res = await POST(`/evidence-requests/${requestId}/submit`, {
    evidence_type: type,
    description: desc,
    file_hash: hash || undefined,
  })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', `证据已提交，锚点哈希：${res.anchor_hash || ''}`)
  setTimeout(() => renderDisputeDetail(document.getElementById('app'), disputeId), 1500)
}

// 动态显示部分退款金额输入框
document.addEventListener('change', (e) => {
  if (e.target?.id === 'arb-ruling') {
    const row = document.getElementById('arb-amount-row')
    if (row) row.style.display = e.target.value === 'partial_refund' ? '' : 'none'
  }
})

// ─── 争议详情页（独立页）─────────────────────────────────────

async function renderDisputeDetail(app, disputeId) {
  if (!disputeId) { navigate('#disputes'); return }
  app.innerHTML = shell(loading$(), 'orders')
  const dispute = await GET(`/disputes/${disputeId}`)
  if (dispute.error) { app.innerHTML = shell(alert$('error', dispute.error), 'orders'); return }

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:16px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">争议 #${dispute.id.slice(-6)}</h1>
    ${buildDisputeHtml(dispute, state.user)}
    <div class="card" style="margin-top:12px">
      <div style="font-weight:700;margin-bottom:8px">关联订单</div>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#order/${dispute.order_id}')">查看订单 →</button>
    </div>
  `, 'orders')
}

// ─── 争议列表页（仲裁员视角）─────────────────────────────────

async function renderDisputeList(app) {
  if (!state.user) { renderLogin(); return }
  if (state.user.role !== 'arbitrator') {
    app.innerHTML = shell(`
      <h1 class="page-title">争议仲裁台</h1>
      <div class="alert alert-info">此功能仅限仲裁员使用。<br>你的角色：${state.user.role}</div>
    `, 'orders')
    return
  }

  app.innerHTML = shell(loading$(), 'orders')
  const disputes = await GET('/disputes')
  if (disputes.error) { app.innerHTML = shell(alert$('error', disputes.error), 'orders'); return }

  const html = disputes.length === 0
    ? `<div class="empty"><div class="empty-icon">⚖️</div><div class="empty-text">${t('暂无开放争议')}</div></div>`
    : disputes.map(d => `
      <div class="card" onclick="navigate('#dispute/${d.id}')" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div style="font-weight:600">${d.reason.slice(0, 40)}${d.reason.length > 40 ? '…' : ''}</div>
          ${disputeStatusBadge(d.status)}
        </div>
        <div style="font-size:13px;color:#6b7280">
          原告：${d.initiator_name} → 被告：${d.defendant_name || '—'}
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px">
          金额：${d.total_amount} WAZ · ${fmtTime(d.created_at)}
          ${d.status === 'open' ? ` · 截止 ${fmtTime(d.respond_deadline)}` : ''}
          ${d.status === 'in_review' ? ` · 仲裁截止 ${fmtTime(d.arbitrate_deadline)}` : ''}
        </div>
      </div>`).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">⚖️ 争议仲裁台</h1>
    <div class="alert alert-info" style="font-size:13px">共 ${disputes.length} 个待处理争议。点击进入查看详情并裁定。</div>
    ${html}
  `, 'seller')
}

// ─── 物流仪表盘 ───────────────────────────────────────────────

async function renderLogistics(app) {
  if (!state.user) { renderLogin(); return }
  if (state.user.role !== 'logistics') {
    app.innerHTML = shell(`
      <h1 class="page-title">${t('物流仪表盘')}</h1>
      <div class="alert alert-info">此功能仅限物流角色使用。<br>你的角色：${state.user.role}</div>
    `, 'seller')
    return
  }

  app.innerHTML = shell(loading$(), 'seller')
  const data = await GET('/logistics/orders')
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'seller'); return }

  const { available, mine } = data

  const LOGISTICS_ACTIONS = {
    shipped:    { action: 'pickup',  label: '✅ 确认揽收', style: 'success', hint: '填写运单号和揽收记录', needsEvidence: true },
    picked_up:  { action: 'transit', label: '🚛 开始运输', style: 'primary', hint: '货物已从揽收点发出', needsEvidence: false },
    in_transit: { action: 'deliver', label: '📬 确认投递', style: 'success', hint: '填写门牌描述或签收记录', needsEvidence: true },
  }

  const orderCard = (o, canClaim) => {
    const act = LOGISTICS_ACTIONS[o.status]
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div style="font-weight:600;flex:1;min-width:0;margin-right:8px">${o.product_title}</div>
          ${statusBadge(o.status)}
        </div>
        <div style="font-size:13px;color:#6b7280">
          ${t('买家：')}${o.buyer_name} · ${t('卖家：')}${o.seller_name}
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-top:2px">
          ${o.total_amount} WAZ · ${fmtTime(o.created_at)}
          ${o.ship_deadline ? ` · 发货截止 ${fmtTime(o.ship_deadline)}` : ''}
        </div>
        ${o.shipping_address ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">📍 ${o.shipping_address}</div>` : ''}
        ${act ? `
        <div style="margin-top:10px" id="log-act-${o.id}">
          ${act.needsEvidence ? `
          <div style="margin-bottom:8px">
            <label class="form-label" style="font-size:12px">${act.action === 'pickup' ? '快递单号 *' : '投递凭证 *'}</label>
            <input type="text" class="form-control" id="log-evid-${o.id}"
              placeholder="${act.action === 'pickup' ? '如：SF1234567890' : '门牌描述 / 收件人签收 / 时间'}"
              style="font-size:13px">
          </div>` : ''}
          <div id="log-msg-${o.id}"></div>
          <button class="btn btn-${act.style} btn-sm" style="width:auto"
            onclick="doLogisticsAction('${o.id}','${act.action}',${act.needsEvidence})">
            ${act.label}
          </button>
        </div>` : ''}
      </div>`
  }

  const availableHtml = available.length === 0
    ? `<div class="empty" style="padding:16px"><div class="empty-icon">📭</div><div class="empty-text">${t('暂无待揽收订单')}</div></div>`
    : available.map(o => orderCard(o, true)).join('')

  const mineHtml = mine.length === 0
    ? `<div class="empty" style="padding:16px"><div class="empty-icon">✅</div><div class="empty-text">${t('暂无进行中订单')}</div></div>`
    : mine.map(o => orderCard(o, false)).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">🚚 ${t('物流仪表盘')}</h1>

    ${mine.length > 0 ? `<div class="alert alert-warning">📦 你有 ${mine.length} 个订单正在配送</div>` : ''}

    <div style="font-weight:700;margin-bottom:8px">${t('我的配送任务')}</div>
    ${mineHtml}

    <div class="divider"></div>

    <div style="font-weight:700;margin-bottom:8px">${t('可接订单（未认领）')}</div>
    <div style="font-size:13px;color:#6b7280;margin-bottom:10px">
      ${t('揽收后即自动认领为你的配送任务')}
    </div>
    ${availableHtml}
  `, 'seller')
}

window.doLogisticsAction = async (orderId, action, needsEvidence) => {
  const msgEl = document.getElementById(`log-msg-${orderId}`)

  if (needsEvidence) {
    const raw = document.getElementById(`log-evid-${orderId}`)?.value?.trim() || ''
    if (!raw) { if (msgEl) msgEl.innerHTML = alert$('error', action === 'pickup' ? '请填写快递单号' : '请填写投递凭证'); return }
    // pickup 自动加"快递单号："前缀（如果用户没加的话）
    const evid = (action === 'pickup' && !raw.startsWith('快递单号：')) ? `快递单号：${raw}` : raw
    if (msgEl) msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>处理中...</div>`
    const res = await POST(`/orders/${orderId}/action`, { action, evidence_description: evid })
    if (res.error) { if (msgEl) msgEl.innerHTML = alert$('error', res.error) }
    else { if (msgEl) msgEl.innerHTML = alert$('success', '操作成功！'); setTimeout(() => renderLogistics(document.getElementById('app')), 1000) }
    return
  }

  if (msgEl) msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>处理中...</div>`
  const res = await POST(`/orders/${orderId}/action`, { action })
  if (res.error) { if (msgEl) msgEl.innerHTML = alert$('error', res.error) }
  else { if (msgEl) msgEl.innerHTML = alert$('success', '操作成功！'); setTimeout(() => renderLogistics(document.getElementById('app')), 1000) }
}

// ─── 卖家后台 ─────────────────────────────────────────────────

async function renderSeller(app) {
  if (!state.user) { renderLogin(); return }
  if (state.user.role !== 'seller') {
    app.innerHTML = shell(`
      <h1 class="page-title">${t('卖家后台')}</h1>
      <div class="alert alert-info">此功能仅限卖家使用。<br>你的角色：${state.user.role}</div>
    `, 'seller')
    return
  }

  app.innerHTML = shell(loading$(), 'seller')
  const [products, orders, mySkillsRaw] = await Promise.all([GET('/my-products'), GET('/orders'), GET('/skills/mine')])
  const mySkills = Array.isArray(mySkillsRaw) ? mySkillsRaw : []

  const pendingOrders = orders.filter(o => ['paid', 'accepted'].includes(o.status) && o.seller_id === state.user.id)
  const myProducts = products

  const pendingHtml = pendingOrders.length === 0
    ? `<div class="empty" style="padding:24px"><div class="empty-icon">✅</div><div class="empty-text">${t('暂无待处理订单')}</div></div>`
    : pendingOrders.map(o => `
      <div class="card" onclick="navigate('#order/${o.id}')" style="cursor:pointer">
        <div class="order-item">
          <div class="order-icon">📦</div>
          <div class="order-info">
            <div class="order-title">${o.product_title}</div>
            <div class="order-meta">${fmtTime(o.created_at)}</div>
            <div style="margin-top:6px">${statusBadge(o.status)}</div>
          </div>
          <div class="order-amount">${o.total_amount} WAZ</div>
        </div>
      </div>`).join('')

  const productsHtml = myProducts.length === 0
    ? `<div class="empty" style="padding:24px"><div class="empty-icon">📭</div><div class="empty-text">${t('还没有商品')}</div></div>`
    : myProducts.map(p => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600">${p.title}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px">${p.price} WAZ · ${t('库存')} ${p.stock}</div>
          </div>
          <span class="badge badge-${p.status === 'active' ? 'green' : 'gray'}">${p.status === 'active' ? t('在售') : t('已下架')}</span>
        </div>
      </div>`).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">${t('卖家后台')}</h1>

    ${pendingOrders.length > 0 ? `<div class="alert alert-warning">📬 你有 ${pendingOrders.length} 个订单需要处理</div>` : ''}

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:700">${t('待处理订单')}</div>
    </div>
    ${pendingHtml}

    <div class="divider"></div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:700">${t('我的商品')}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="showImportProduct()">🔗 ${t('导入')}</button>
        <button class="btn btn-primary btn-sm" onclick="showAddProduct()">${t('+ 上架')}</button>
      </div>
    </div>
    ${productsHtml}

    <!-- 一键导入面板 -->
    <div id="import-product-form" style="display:none">
      <div class="divider"></div>
      <div class="card">
        <div style="font-weight:700;margin-bottom:4px">🔗 ${t('一键导入商品')}</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${t('粘贴任意平台商品链接，AI 自动提取信息并给出定价建议')}</div>
        <div id="import-msg"></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input class="form-control" id="import-url" placeholder="${t('粘贴淘宝 / 京东 / 亚马逊 / Shopify 等链接')}" style="flex:1">
          <button class="btn btn-primary" id="btn-import" onclick="doImportProduct()" style="white-space:nowrap">✨ ${t('解析')}</button>
        </div>
        <div id="import-quota" style="font-size:12px;color:#6b7280;margin-bottom:8px"></div>
        <details style="margin-bottom:16px">
          <summary style="font-size:12px;color:#9ca3af;cursor:pointer">${t('使用自己的 Anthropic API Key（不限次数）')}</summary>
          <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
            <input class="form-control" id="import-own-key" type="password"
              placeholder="sk-ant-..."
              style="font-family:monospace;font-size:12px;flex:1"
              value="${localStorage.getItem('webaz_own_ak') || ''}"
              oninput="localStorage.setItem('webaz_own_ak', this.value.trim())">
            <button class="btn btn-outline btn-sm" onclick="localStorage.removeItem('webaz_own_ak');document.getElementById('import-own-key').value=''" style="white-space:nowrap">${t('清除')}</button>
          </div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('Key 仅存储在本地，不上传服务器，用完即丢')}</div>
        </details>
        <!-- 预览区（解析后显示） -->
        <div id="import-preview" style="display:none">
          <div class="divider"></div>
          <div style="font-size:13px;font-weight:600;color:#4f46e5;margin-bottom:12px">✅ ${t('解析完成，确认后上架')}</div>
          <div class="form-group"><label class="form-label">${t('商品名称')}</label><input class="form-control" id="imp-title"></div>
          <div class="form-group"><label class="form-label">${t('商品描述')}</label><textarea class="form-control" id="imp-desc" rows="4"></textarea></div>
          <div style="display:flex;gap:12px">
            <div class="form-group" style="flex:1">
              <label class="form-label">${t('价格（WAZ）')}</label>
              <input class="form-control" id="imp-price" type="number">
            </div>
            <div class="form-group" style="flex:1">
              <label class="form-label">${t('库存数量')}</label>
              <input class="form-control" id="imp-stock" type="number" value="1">
            </div>
          </div>
          <div id="imp-price-hint" style="font-size:12px;color:#059669;margin:-8px 0 12px;padding:8px 12px;background:#f0fdf4;border-radius:6px;display:none"></div>
          <div class="form-group"><label class="form-label">${t('分类（可选）')}</label>
            <select class="form-control" id="imp-cat">
              <option value="">${t('不分类')}</option>
              <option value="茶具">${t('茶具')}</option><option value="家居">${t('家居')}</option>
              <option value="食品">${t('食品')}</option><option value="服装">${t('服装')}</option>
              <option value="手工">${t('手工')}</option><option value="电子">${t('电子')}</option>
            </select>
          </div>
          <div class="btn-row">
            <button class="btn btn-gray" onclick="hideImportProduct()">${t('取消')}</button>
            <button class="btn btn-primary" onclick="doPublishImported()">${t('确认上架')}</button>
          </div>
        </div>
      </div>
    </div>

    <div id="add-product-form" style="display:none">
      <div class="divider"></div>
      <div class="card">
        <div style="font-weight:700;margin-bottom:16px">${t('上架新商品')}</div>
        <div id="add-msg"></div>
        <div class="form-group"><label class="form-label">${t('商品名称')}</label><input class="form-control" id="prd-title" placeholder="例：手工竹编收纳篮"></div>
        <div class="form-group"><label class="form-label">${t('商品描述')}</label><textarea class="form-control" id="prd-desc" placeholder="材质、尺寸、特点..."></textarea></div>
        <div class="form-group"><label class="form-label">${t('价格（WAZ）')}</label><input class="form-control" id="prd-price" type="number" placeholder="199"></div>
        <div class="form-group"><label class="form-label">${t('库存数量')}</label><input class="form-control" id="prd-stock" type="number" value="10"></div>
        <div class="form-group"><label class="form-label">${t('分类（可选）')}</label>
          <select class="form-control" id="prd-cat">
            <option value="">${t('不分类')}</option>
            <option value="茶具">${t('茶具')}</option><option value="家居">${t('家居')}</option>
            <option value="食品">${t('食品')}</option><option value="服装">${t('服装')}</option>
            <option value="手工">${t('手工')}</option><option value="电子">${t('电子')}</option>
          </select>
        </div>
        <div class="btn-row">
          <button class="btn btn-gray" onclick="hideAddProduct()">${t('取消')}</button>
          <button class="btn btn-primary" onclick="doAddProduct()">${t('上架')}</button>
        </div>
      </div>
    </div>

    <div class="divider"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:700">⚡ ${t('我的 Skill')}</div>
      <button class="btn btn-outline btn-sm" onclick="navigate('#skills')">${t('Skill 市场')}</button>
    </div>
    <div id="my-skills-list">${mySkills.length > 0 ? mySkills.map(s => skillCard(s, 'seller')).join('') : `<div class="empty" style="padding:24px"><div class="empty-icon">⚡</div><div class="empty-text">${t('还没有 Skill')}</div></div>`}</div>
    <button class="btn btn-outline" style="margin-top:12px" onclick="showPublishSkill()">${t('+ 发布新 Skill')}</button>

    <div id="publish-skill-form" style="display:none">
      <div class="divider"></div>
      <div class="card">
        <div style="font-weight:700;margin-bottom:16px">${t('发布 Skill')}</div>
        <div id="skill-msg"></div>
        <div class="form-group"><label class="form-label">${t('Skill 类型')}</label>
          <select class="form-control" id="skl-type" onchange="updateSkillConfigHint()">
            <option value="catalog_sync">🔄 目录同步 — 商品接入 WebAZ 搜索</option>
            <option value="auto_accept">⚡ 自动接单 — 买家下单立即接受</option>
            <option value="price_negotiation">🤝 价格协商 — 允许 Agent 议价</option>
            <option value="quality_guarantee">🛡️ 质量承诺 — 额外质押保证</option>
            <option value="instant_ship">🚀 极速发货 — 承诺 24h 发货</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">${t('Skill 名称')}</label><input class="form-control" id="skl-name" placeholder="例：竹韵手工坊自动接单"></div>
        <div class="form-group"><label class="form-label">${t('描述')}</label><textarea class="form-control" id="skl-desc" placeholder="简要说明这个 Skill 能给买家带来什么好处"></textarea></div>
        <div id="skl-config-hint" class="alert alert-info" style="font-size:13px;margin-bottom:16px">目录同步：将你的商品列入 WebAZ 搜索优先级，买家订阅后可优先发现你的商品。推荐佣金 0.5% 由协议自动分配。</div>
        <div class="btn-row">
          <button class="btn btn-gray" onclick="hidePublishSkill()">${t('取消')}</button>
          <button class="btn btn-primary" onclick="doPublishSkill()">${t('发布')}</button>
        </div>
      </div>
    </div>
  `, 'seller')
}

window.showAddProduct = () => { document.getElementById('add-product-form').style.display = '' }
window.hideAddProduct = () => { document.getElementById('add-product-form').style.display = 'none' }

window.showImportProduct = () => {
  document.getElementById('import-product-form').style.display = ''
  document.getElementById('import-preview').style.display = 'none'
  document.getElementById('import-msg').innerHTML = ''
  document.getElementById('import-url').value = ''
}
window.hideImportProduct = () => { document.getElementById('import-product-form').style.display = 'none' }

window.doImportProduct = async () => {
  const url = document.getElementById('import-url').value.trim()
  if (!url) return
  const btn = document.getElementById('btn-import')
  const msgEl = document.getElementById('import-msg')
  const quotaEl = document.getElementById('import-quota')
  const ownKey = localStorage.getItem('webaz_own_ak') || ''

  btn.disabled = true; btn.textContent = t('解析中...')
  msgEl.innerHTML = ''
  document.getElementById('import-preview').style.display = 'none'

  const res = await POST('/import-product', { url, user_api_key: ownKey || undefined })
  btn.disabled = false; btn.textContent = `✨ ${t('解析')}`

  // 更新额度显示
  if (res.quota) {
    quotaEl.textContent = `${t('今日剩余免费次数')}：${res.quota.remaining} / ${res.quota.limit}`
    quotaEl.style.color = res.quota.remaining <= 2 ? '#dc2626' : '#6b7280'
  } else if (res.used_own_key) {
    quotaEl.textContent = `✓ ${t('使用自己的 Key，不限次数')}`
    quotaEl.style.color = '#059669'
  }

  if (res.error) {
    if (res.quota_exceeded) {
      msgEl.innerHTML = alert$('error', res.error)
      // 自动展开 API Key 输入区
      document.querySelector('#import-product-form details')?.setAttribute('open', '')
    } else {
      msgEl.innerHTML = alert$('error', res.error)
    }
    return
  }

  // 填入预览表单
  document.getElementById('imp-title').value = res.title || ''
  document.getElementById('imp-desc').value = res.description || ''
  document.getElementById('imp-price').value = res.suggested_price || ''
  document.getElementById('imp-stock').value = res.stock || 1
  const catEl = document.getElementById('imp-cat')
  if (res.category) {
    const opt = [...catEl.options].find(o => o.value === res.category)
    if (opt) catEl.value = res.category
  }

  // 显示定价建议
  const hintEl = document.getElementById('imp-price-hint')
  if (res.price_reasoning) {
    hintEl.textContent = `💡 ${res.price_reasoning}${res.original_price ? `（${t('原价参考')}：${res.original_price} CNY）` : ''}`
    hintEl.style.display = ''
  }

  document.getElementById('import-preview').style.display = ''
}

window.doPublishImported = async () => {
  const title    = document.getElementById('imp-title').value.trim()
  const desc     = document.getElementById('imp-desc').value.trim()
  const price    = Number(document.getElementById('imp-price').value)
  const stock    = Number(document.getElementById('imp-stock').value) || 1
  const category = document.getElementById('imp-cat').value
  const msgEl    = document.getElementById('import-msg')

  if (!title || !desc || !price) return void (msgEl.innerHTML = alert$('error', t('请填写商品名、描述、价格')))

  const res = await POST('/products', { title, description: desc, price, stock, category })
  if (res.error) return void (msgEl.innerHTML = alert$('error', res.error))

  msgEl.innerHTML = alert$('success', `${t('上架成功！质押')} ${res.stake_locked} WAZ ${t('已锁定')}`)
  setTimeout(() => renderSeller(document.getElementById('app')), 1500)
}

window.doAddProduct = async () => {
  const title = document.getElementById('prd-title').value.trim()
  const desc  = document.getElementById('prd-desc').value.trim()
  const price = Number(document.getElementById('prd-price').value)
  const stock = Number(document.getElementById('prd-stock').value) || 1
  const category = document.getElementById('prd-cat').value
  const msgEl = document.getElementById('add-msg')

  if (!title || !desc || !price) { msgEl.innerHTML = alert$('error', '请填写商品名、描述、价格'); return }

  const res = await POST('/products', { title, description: desc, price, stock, category })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }

  msgEl.innerHTML = alert$('success', `上架成功！质押 ${res.stake_locked} WAZ 已锁定`)
  setTimeout(() => renderSeller(document.getElementById('app')), 1500)
}

// ─── 卖家 Skill 管理 ──────────────────────────────────────────

function skillCard(s, context) {
  const typeIcons = { catalog_sync:'🔄', auto_accept:'⚡', price_negotiation:'🤝', quality_guarantee:'🛡️', instant_ship:'🚀' }
  const typeLabels = { catalog_sync:'目录同步', auto_accept:'自动接单', price_negotiation:'价格协商', quality_guarantee:'质量承诺', instant_ship:'极速发货' }
  const icon = typeIcons[s.skill_type] || '⚙️'
  const label = typeLabels[s.skill_type] || s.skill_type
  if (context === 'seller') {
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${icon} ${s.name}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">${label} · ${s.subscriber_count || 0} 订阅 · 使用 ${s.total_uses} 次</div>
          </div>
          <span class="badge badge-green">${t('运行中')}</span>
        </div>
        <div style="font-size:13px;color:#6b7280;margin-top:8px">${s.description}</div>
      </div>`
  }
  // buyer context
  const subscribed = Boolean(s.subscribed)
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${icon} ${s.name}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">${label} · @${s.seller_name} · ${s.subscriber_count || 0} 订阅</div>
        </div>
        <button class="btn ${subscribed ? 'btn-gray' : 'btn-primary'} btn-sm" style="flex-shrink:0;margin-left:8px"
          onclick="toggleSubscribeSkill('${s.id}', ${subscribed})">${subscribed ? t('已订阅') : t('+ 订阅')}</button>
      </div>
      <div style="font-size:13px;color:#6b7280;margin-top:8px">${s.description}</div>
    </div>`
}

const SKILL_CONFIG_HINTS = {
  catalog_sync:      '目录同步：订阅此 Skill 的买家在搜索时会优先看到你的商品。成交后协议自动给你 0.5% 推荐佣金。',
  auto_accept:       '自动接单：买家下单后无需手动操作，系统自动接受。可设置每日上限、金额范围。',
  price_negotiation: '价格协商：允许买家 Agent 在你设定的折扣范围内自动议价，减少沟通成本。',
  quality_guarantee: '质量承诺：额外质押 WAZ 作为品质担保，增强买家信任，适合高客单价商品。',
  instant_ship:      '极速发货：承诺接单后 24h 内发货，违约自动赔付。适合有充足现货的卖家。',
}

window.updateSkillConfigHint = () => {
  const type = document.getElementById('skl-type').value
  const hint = document.getElementById('skl-config-hint')
  if (hint) hint.textContent = SKILL_CONFIG_HINTS[type] || ''
}

window.showPublishSkill = () => { document.getElementById('publish-skill-form').style.display = '' }
window.hidePublishSkill = () => { document.getElementById('publish-skill-form').style.display = 'none' }

window.doPublishSkill = async () => {
  const skill_type = document.getElementById('skl-type').value
  const name = document.getElementById('skl-name').value.trim()
  const description = document.getElementById('skl-desc').value.trim()
  const msgEl = document.getElementById('skill-msg')
  if (!name || !description) { msgEl.innerHTML = alert$('error', '请填写名称和描述'); return }
  const res = await POST('/skills', { skill_type, name, description })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', '✅ Skill 已发布！买家可以在 Skill 市场订阅')
  setTimeout(() => renderSeller(document.getElementById('app')), 1500)
}

// ─── 钱包页 ───────────────────────────────────────────────────

async function renderWallet(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'wallet')
  const [wallet, rep] = await Promise.all([GET('/wallet'), GET('/reputation')])

  const LEVEL_LABELS = { new:t('新手 🌱'), trusted:t('可信 ⭐'), quality:t('优质 🌟'), star:t('明星 💫'), legend:t('传奇 🔥') }
  const LEVEL_THRESHOLDS = { new:0, trusted:200, quality:800, star:2000, legend:5000 }
  const levelKeys = ['new','trusted','quality','star','legend']
  const curIdx = levelKeys.indexOf(rep.level?.key || 'new')
  const nextKey = levelKeys[curIdx + 1]
  const nextThreshold = LEVEL_THRESHOLDS[nextKey]
  const curPoints = rep.total_points || 0
  const progressPct = nextThreshold
    ? Math.min(100, Math.round((curPoints - LEVEL_THRESHOLDS[rep.level?.key || 'new']) / (nextThreshold - LEVEL_THRESHOLDS[rep.level?.key || 'new']) * 100))
    : 100

  const recentHtml = (rep.recent_events || []).length > 0
    ? rep.recent_events.slice(0,5).map(e => `
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6">
          <span style="color:#6b7280">${e.reason}</span>
          <span style="font-weight:600;color:${e.points > 0 ? '#059669' : '#dc2626'}">${e.points > 0 ? '+' : ''}${e.points}</span>
        </div>`).join('')
    : `<div style="color:#9ca3af;font-size:13px;text-align:center;padding:12px 0">${t('完成第一笔交易后开始积累声誉')}</div>`

  app.innerHTML = shell(`
    <h1 class="page-title">${t('我的钱包')}</h1>
    <div class="card">
      <div style="text-align:center;padding:16px 0 8px">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px">${t('可用余额')}</div>
        <div style="font-size:40px;font-weight:800;color:#4f46e5">${(wallet.balance || 0).toFixed(2)}<span style="font-size:16px;font-weight:400"> WAZ</span></div>
      </div>
      <div class="divider"></div>
      <div class="wallet-grid">
        <div class="wallet-item">
          <div class="wallet-label">${t('质押中')}</div>
          <div class="wallet-value">${(wallet.staked || 0).toFixed(2)}<span class="wallet-unit"> WAZ</span></div>
        </div>
        <div class="wallet-item">
          <div class="wallet-label">${t('托管中')}</div>
          <div class="wallet-value">${(wallet.escrowed || 0).toFixed(2)}<span class="wallet-unit"> WAZ</span></div>
        </div>
        <div class="wallet-item" style="grid-column:1/-1">
          <div class="wallet-label">${t('历史累计收益')}</div>
          <div class="wallet-value">${(wallet.earned || 0).toFixed(2)}<span class="wallet-unit"> WAZ</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-weight:700">${t('声誉积分')}</div>
        <div style="font-size:20px;font-weight:800;color:#4f46e5">${curPoints} ${t('分')}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:14px;font-weight:600">${LEVEL_LABELS[rep.level?.key || 'new'] || '新手 🌱'}</span>
        ${nextKey ? `<span style="font-size:12px;color:#6b7280">${t('距')} ${LEVEL_LABELS[nextKey]} ${t('还差')} ${nextThreshold - curPoints} ${t('分')}</span>` : `<span style="font-size:12px;color:#f59e0b">${t('最高等级 🏆')}</span>`}
      </div>
      <div style="height:8px;background:#f3f4f6;border-radius:99px;overflow:hidden;margin-bottom:12px">
        <div style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:99px;transition:width .3s"></div>
      </div>
      <div class="wallet-grid" style="margin-bottom:12px">
        <div class="wallet-item"><div class="wallet-label">${t('成交次数')}</div><div class="wallet-value" style="font-size:18px">${rep.transactions_done || 0}</div></div>
        <div class="wallet-item"><div class="wallet-label">${t('争议胜/败')}</div><div class="wallet-value" style="font-size:18px">${rep.disputes_won || 0}/${rep.disputes_lost || 0}</div></div>
        <div class="wallet-item" style="grid-column:1/-1">
          <div class="wallet-label">${t('质押优惠')}</div>
          <div class="wallet-value" style="font-size:15px">${rep.level?.stakeDiscount > 0 ? `-${(rep.level.stakeDiscount * 100).toFixed(0)}%（当前 ${((0.15 - rep.level.stakeDiscount) * 100).toFixed(0)}%）` : t('暂无（升到可信即可享受 -5%）')}</div>
        </div>
      </div>
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${t('最近记录')}</div>
      ${recentHtml}
    </div>

    <div class="card">
      <div style="font-weight:700;margin-bottom:10px">💰 充值测试 WAZ</div>
      <div style="font-size:13px;color:#6b7280;margin-bottom:12px">Phase 0 测试专用，单次最多 1000 WAZ，余额上限 5000 WAZ。</div>
      <div id="topup-msg"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${[100,300,500,1000].map(n => `
          <button class="btn btn-outline btn-sm" style="width:auto;flex:1;min-width:60px"
            onclick="doTopup(${n})">+${n}</button>`).join('')}
      </div>
    </div>

    <div class="alert alert-info" style="font-size:13px">
      WAZ 为协议内模拟货币。Phase 2 将接入真实链上资产。
    </div>
    <button class="btn btn-gray" onclick="doLogout()">${t('退出登录')}</button>
  `, 'wallet')
}

window.doLogout = () => {
  state.apiKey = null; state.user = null
  localStorage.removeItem('webaz_key')
  navigate('#login')
}

window.doTopup = async (amount) => {
  const msgEl = document.getElementById('topup-msg')
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('充值中...')}</div>`
  const res = await POST('/wallet/topup', { amount })
  if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
  msgEl.innerHTML = alert$('success', `✅ 已充入 ${res.added} WAZ，当前余额 ${res.new_balance.toFixed(2)} WAZ`)
  setTimeout(() => renderWallet(document.getElementById('app')), 1200)
}

// ─── SSE 实时通知 ─────────────────────────────────────────────

function connectSSE() {
  if (!state.apiKey || state.sse) return
  // EventSource 不支持自定义 header，通过 URL 参数传 key
  state.sse = new EventSource(`/api/notifications/stream?key=${state.apiKey}`)

  state.sse.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.type === 'init') {
      updateBadge(data.unread)
    } else {
      // 实时推送：更新角标 + 显示 toast
      state.unread++
      updateBadge(state.unread)
      showToast(data.title, data.body)
    }
  }
  state.sse.onerror = () => {
    state.sse?.close(); state.sse = null
    // 5秒后重连
    setTimeout(connectSSE, 5000)
  }
}

function disconnectSSE() {
  state.sse?.close(); state.sse = null
}

function updateBadge(count) {
  state.unread = count
  // 更新 tab bar 角标
  const badge = document.getElementById('notif-badge')
  if (badge) {
    badge.textContent = count > 0 ? count : ''
    badge.style.display = count > 0 ? 'inline' : 'none'
  }
}

let toastTimer = null
function showToast(title, body) {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `position:fixed;bottom:76px;left:16px;right:16px;background:#1e1b4b;color:#fff;border-radius:12px;padding:12px 16px;font-size:14px;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,.3);cursor:pointer`
    toast.onclick = () => navigate('#notifications')
    document.body.appendChild(toast)
  }
  toast.innerHTML = `<div style="font-weight:700;margin-bottom:3px">${title}</div><div style="opacity:.85;font-size:13px">${body}</div>`
  toast.style.opacity = '1'
  toast.style.transform = 'translateY(0)'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.style.opacity = '0' }, 4000)
}

// ─── 通知列表页 ───────────────────────────────────────────────

async function renderNotifications(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'notifications')

  await POST('/notifications/read', {})  // 全部标为已读
  updateBadge(0)

  const data = await GET('/notifications')
  const list = (data.notifications || [])
  const html = list.length === 0
    ? `<div class="empty"><div class="empty-icon">🔔</div><div class="empty-text">${t('暂无通知')}</div></div>`
    : list.map(n => `
      <div class="card" ${n.order_id ? `onclick="navigate('#order/${n.order_id}')" style="cursor:pointer"` : ''}>
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="font-size:24px;line-height:1;flex-shrink:0">${n.title.slice(0,2)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px">${n.title.slice(2)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:3px">${n.body}</div>
            <div style="font-size:11px;color:#d1d5db;margin-top:4px">${fmtTime(n.created_at)}</div>
          </div>
        </div>
      </div>`).join('')

  app.innerHTML = shell(`<h1 class="page-title">${t('通知')}</h1>${html}`, 'notifications')
}

// ─── Skill 市场页 ─────────────────────────────────────────────

async function renderSkills(app) {
  app.innerHTML = shell(loading$(), 'shop')

  const skills = await GET('/skills')
  const isBuyer = state.user?.role === 'buyer'

  const typeIcons = { catalog_sync:'🔄', auto_accept:'⚡', price_negotiation:'🤝', quality_guarantee:'🛡️', instant_ship:'🚀' }
  const typeLabels = { catalog_sync:'目录同步', auto_accept:'自动接单', price_negotiation:'价格协商', quality_guarantee:'质量承诺', instant_ship:'极速发货' }

  const groups = {}
  for (const s of skills) {
    if (!groups[s.skill_type]) groups[s.skill_type] = []
    groups[s.skill_type].push(s)
  }

  let html = ''
  if (skills.length === 0) {
    html = `<div class="empty"><div class="empty-icon">⚡</div><div class="empty-text">还没有 Skill，卖家可以去后台发布</div></div>`
  } else {
    for (const [type, items] of Object.entries(groups)) {
      const icon = typeIcons[type] || '⚙️'
      const label = typeLabels[type] || type
      html += `<div style="font-weight:700;margin:16px 0 8px">${icon} ${label}</div>`
      html += items.map(s => skillCard(s, 'buyer')).join('')
    }
  }

  app.innerHTML = shell(`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <button class="btn btn-gray btn-sm" style="width:auto" onclick="history.back()">←</button>
      <h1 class="page-title" style="margin:0">⚡ Skill 市场</h1>
    </div>
    ${isBuyer ? `
    <div class="alert alert-info" style="font-size:13px">
      订阅卖家发布的 Skill，即可享受自动接单、优先推荐、价格协商等特权。
    </div>` : !state.user ? `
    <div class="alert alert-info" style="font-size:13px">
      <a href="#login" style="color:inherit;font-weight:700">登录</a>后即可订阅 Skill
    </div>` : ''}
    <div id="skill-sub-msg"></div>
    ${html}
  `, 'shop')
}

window.toggleSubscribeSkill = async (skillId, currentlySubscribed) => {
  const msgEl = document.getElementById('skill-sub-msg')
  if (currentlySubscribed) {
    await fetch(`/api/skills/${skillId}/subscribe`, { method: 'DELETE', headers: { Authorization: `Bearer ${state.apiKey}` } })
    msgEl.innerHTML = alert$('info', '已取消订阅')
  } else {
    const res = await POST(`/skills/${skillId}/subscribe`, {})
    if (res.error) { msgEl.innerHTML = alert$('error', res.error); return }
    msgEl.innerHTML = alert$('success', '✅ 订阅成功！你将优先看到此卖家商品')
  }
  setTimeout(() => renderSkills(document.getElementById('app')), 800)
}

// ─── 启动 ─────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// 初始路由
route()

// hash 变化时补充处理 order-product
const _origHashChange = window.onhashchange
window.onhashchange = () => {
  const hash = location.hash.slice(1)
  if (hash.startsWith('order-product/')) {
    renderBuyPage(document.getElementById('app'), hash.split('/')[1])
  } else {
    route()
  }
}
