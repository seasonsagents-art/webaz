// DCP PWA — Vanilla JS SPA
// 路由：hash-based (#shop, #orders, #seller, #order/ord_xxx)

// ─── 状态 ────────────────────────────────────────────────────

const state = {
  user: null,
  apiKey: localStorage.getItem('dcp_key') || null,
  unread: 0,
  sse: null,
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
    if (state.user?.error) { state.apiKey = null; localStorage.removeItem('dcp_key'); state.user = null }
    else connectSSE()
  }

  const app = document.getElementById('app')

  switch (page) {
    case '':
    case 'shop':          return renderShop(app)
    case 'orders':        return renderOrders(app)
    case 'order':         return renderOrderDetail(app, params[0])
    case 'seller':        return renderSeller(app)
    case 'wallet':        return renderWallet(app)
    case 'notifications': return renderNotifications(app)
    case 'login':         return renderLogin()
    default:              return renderShop(app)
  }
}

// ─── 工具 ─────────────────────────────────────────────────────

function statusBadge(status) {
  const map = {
    created:          ['gray',   '待付款'],
    paid:             ['blue',   '待接单'],
    accepted:         ['yellow', '待发货'],
    shipped:          ['yellow', '已发货'],
    picked_up:        ['yellow', '已揽收'],
    in_transit:       ['yellow', '运输中'],
    delivered:        ['blue',   '待确认'],
    confirmed:        ['green',  '已确认'],
    completed:        ['green',  '已完成'],
    disputed:         ['red',    '争议中'],
    cancelled:        ['gray',   '已取消'],
    fault_seller:     ['red',    '卖家违约'],
    fault_buyer:      ['red',    '买家违约'],
    fault_logistics:  ['red',    '物流违约'],
  }
  const [color, label] = map[status] || ['gray', status]
  return `<span class="badge badge-${color}">${label}</span>`
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function alert$(type, msg) {
  return `<div class="alert alert-${type}">${msg}</div>`
}

function loading$() {
  return `<div class="loading"><span class="spinner"></span>加载中...</div>`
}

function shell(content, activeTab) {
  const tabs = [
    { id: 'shop',          icon: '🛍️',  label: '商店' },
    { id: 'orders',        icon: '📦',  label: '订单' },
    { id: 'seller',        icon: '🏪',  label: '卖家' },
    { id: 'notifications', icon: '🔔',  label: '通知', badge: true },
    { id: 'wallet',        icon: '💰',  label: '钱包' },
  ]
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="#shop">🦞 DCP</a>
      <div class="navbar-actions">
        ${state.user
          ? `<span style="font-size:13px;color:#6b7280">${state.user.name}</span>`
          : `<button class="btn btn-primary btn-sm" onclick="navigate('#login')">登录</button>`}
      </div>
    </nav>
    <main class="main">${content}</main>
    <nav class="tabbar">
      ${tabs.map(t => `
        <button class="tab-item ${activeTab === t.id ? 'active' : ''}" onclick="navigate('#${t.id}')">
          <span class="tab-icon" style="position:relative">
            ${t.icon}
            ${t.badge ? `<span id="notif-badge" style="position:absolute;top:-4px;right:-6px;background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:0 4px;min-width:16px;text-align:center;display:${state.unread > 0 ? 'inline' : 'none'}">${state.unread || ''}</span>` : ''}
          </span>${t.label}
        </button>`).join('')}
    </nav>`
}

// ─── 登录/注册页 ──────────────────────────────────────────────

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-logo">🦞</div>
      <h1 class="login-title">DCP 协议</h1>
      <p class="login-sub">去中心化商业协议 · AI Agent 原生</p>
      <div id="login-msg"></div>

      <div class="seg-ctrl" style="margin-bottom:24px">
        <button class="seg-btn active" id="tab-login" onclick="switchLoginTab('login')">我已有账号</button>
        <button class="seg-btn" id="tab-reg" onclick="switchLoginTab('reg')">注册新账号</button>
      </div>

      <div id="panel-login">
        <div class="form-group">
          <label class="form-label">粘贴你的 api_key</label>
          <input class="form-control" id="inp-key" placeholder="key_xxxx..." style="font-family:monospace;font-size:13px">
        </div>
        <button class="btn btn-primary" onclick="doLogin()">登录</button>
      </div>

      <div id="panel-reg" style="display:none">
        <div class="form-group">
          <label class="form-label">名称 / 店铺名</label>
          <input class="form-control" id="inp-name" placeholder="例：陈小明 / 竹韵手工坊">
        </div>
        <div class="form-group">
          <label class="form-label">角色</label>
          <select class="form-control" id="inp-role">
            <option value="buyer">买家 — 浏览购物</option>
            <option value="seller">卖家 — 上架商品</option>
            <option value="logistics">物流 — 揽收投递</option>
            <option value="arbitrator">仲裁员 — 处理争议</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="doRegister()">注册</button>
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
  if (!key) return showMsg('error', '请粘贴 api_key')
  state.apiKey = key
  const user = await GET('/me')
  if (user.error) { state.apiKey = null; return showMsg('error', '无效的 api_key，请重新输入') }
  state.user = user
  localStorage.setItem('dcp_key', key)
  navigate('#shop')
}

window.doRegister = async () => {
  const name = document.getElementById('inp-name').value.trim()
  const role = document.getElementById('inp-role').value
  if (!name) return showMsg('error', '请填写名称')
  const res = await POST('/register', { name, role })
  if (res.error) return showMsg('error', res.error)
  // 注册成功：显示 api_key 并自动登录
  showMsg('success', `注册成功！<br>你的 api_key（请妥善保存，这是你的登录凭证）：<br><code style="font-size:12px;word-break:break-all">${res.api_key}</code>`)
  state.apiKey = res.api_key
  state.user = { ...res }
  localStorage.setItem('dcp_key', res.api_key)
  setTimeout(() => navigate('#shop'), 3000)
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
    ? `<div class="empty"><div class="empty-icon">🛍️</div><div class="empty-text">暂无商品</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${p.title}</div>
              <div class="product-price">${p.price} <span style="font-size:11px;font-weight:400">DCP</span></div>
              <div class="product-seller">@${p.seller_name}</div>
            </div>
          </div>`).join('')}
       </div>`

  app.innerHTML = shell(`
    <h1 class="page-title">发现好物</h1>
    <div class="search-bar">
      <input class="search-input" id="search-inp" placeholder="搜索商品..." onkeydown="if(event.key==='Enter')doSearch()">
      <button class="btn btn-primary btn-sm" style="width:auto;padding:10px 16px" onclick="doSearch()">搜</button>
    </div>
    <div id="product-list">${grid}</div>
  `, 'shop')
}

window.doSearch = async () => {
  const q = document.getElementById('search-inp').value.trim()
  document.getElementById('product-list').innerHTML = loading$()
  const products = await GET(`/products?q=${encodeURIComponent(q)}`)
  const grid = products.length === 0
    ? `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">没有找到"${q}"</div></div>`
    : `<div class="product-grid">
        ${products.map(p => `
          <div class="product-card" onclick="navigate('#order-product/${p.id}')">
            <div class="product-img">${getCategoryIcon(p.category)}</div>
            <div class="product-body">
              <div class="product-name">${p.title}</div>
              <div class="product-price">${p.price} DCP</div>
              <div class="product-seller">@${p.seller_name}</div>
            </div>
          </div>`).join('')}
       </div>`
  document.getElementById('product-list').innerHTML = grid
}

function getCategoryIcon(cat) {
  const map = { '茶具':'🍵', '家居':'🏠', '食品':'🍱', '服装':'👗', '电子':'📱', '手工':'🎨' }
  return map[cat] || '📦'
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
  if (!p) return app.innerHTML = shell(`<div class="empty">商品不存在</div>`, 'shop')

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:16px" onclick="history.back()">← 返回</button>
    <div class="card">
      <div style="font-size:60px;text-align:center;padding:20px 0">${getCategoryIcon(p.category)}</div>
      <h2 style="font-size:18px;font-weight:700;margin-bottom:6px">${p.title}</h2>
      <p style="font-size:14px;color:#6b7280;margin-bottom:12px">${p.description}</p>
      <div class="detail-row"><span class="detail-label">价格</span><span class="detail-value" style="color:#4f46e5;font-size:18px">${p.price} DCP</span></div>
      <div class="detail-row"><span class="detail-label">库存</span><span class="detail-value">${p.stock} 件</span></div>
      <div class="detail-row"><span class="detail-label">卖家</span><span class="detail-value">${p.seller_name}</span></div>
    </div>
    <div id="buy-msg"></div>
    ${state.user?.role === 'buyer' ? `
    <div class="card">
      <div class="form-group">
        <label class="form-label">收货地址</label>
        <input class="form-control" id="inp-addr" placeholder="省市区 详细地址">
      </div>
      <div class="form-group">
        <label class="form-label">备注（可选）</label>
        <input class="form-control" id="inp-notes" placeholder="给卖家的留言">
      </div>
      <button class="btn btn-primary" onclick="doBuy('${p.id}', ${p.price})">立即下单 · ${p.price} DCP</button>
    </div>` : `
    <div class="alert alert-info">${state.user ? '只有买家账号可以下单' : '<a href="#login" style="color:inherit;font-weight:700">登录</a>后下单'}</div>`}
  `, 'shop')
}

window.doBuy = async (productId, price) => {
  const addr = document.getElementById('inp-addr').value.trim()
  const notes = document.getElementById('inp-notes').value.trim()
  if (!addr) { document.getElementById('buy-msg').innerHTML = alert$('error', '请填写收货地址'); return }
  const res = await POST('/orders', { product_id: productId, shipping_address: addr, notes })
  if (res.error) { document.getElementById('buy-msg').innerHTML = alert$('error', res.error); return }
  document.getElementById('buy-msg').innerHTML = alert$('success', `下单成功！${price} DCP 已托管，等待卖家接单`)
  setTimeout(() => navigate(`#order/${res.order_id}`), 1500)
}

// ─── 订单列表页 ───────────────────────────────────────────────

async function renderOrders(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'orders')
  const orders = await GET('/orders')

  const list = orders.length === 0
    ? `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">暂无订单</div></div>`
    : orders.map(o => `
      <div class="card" onclick="navigate('#order/${o.id}')" style="cursor:pointer">
        <div class="order-item">
          <div class="order-icon">${getCategoryIcon(o.category)}</div>
          <div class="order-info">
            <div class="order-title">${o.product_title}</div>
            <div class="order-meta">${fmtTime(o.created_at)} · ${o.buyer_id === state.user.id ? '我买的' : '我卖的'}</div>
            <div style="margin-top:6px">${statusBadge(o.status)}</div>
          </div>
          <div class="order-amount">${o.total_amount}</div>
        </div>
      </div>`).join('')

  app.innerHTML = shell(`<h1 class="page-title">我的订单</h1>${list}`, 'orders')
}

// ─── 订单详情页 ───────────────────────────────────────────────

async function renderOrderDetail(app, orderId) {
  if (!orderId) { navigate('#orders'); return }
  app.innerHTML = shell(loading$(), 'orders')
  const data = await GET(`/orders/${orderId}`)
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'orders'); return }

  const { order, history, currentResponsible, activeDeadline, isOverdue, product, dispute } = data
  const isBuyer    = order.buyer_id    === state.user?.id
  const isSeller   = order.seller_id   === state.user?.id
  const isLogistic = order.logistics_id === state.user?.id

  // 操作按钮
  const actions = getActions(order, isBuyer, isSeller, isLogistic)

  const historyHtml = (history || []).map(h => `
    <div class="timeline-item">
      <div><span class="timeline-status">${h.from_status} → ${h.to_status}</span></div>
      <div class="timeline-actor">${h.actor_name}（${h.actor_role}）</div>
      <div class="timeline-time">${fmtTime(h.created_at)}</div>
      ${h.evidence_count > 0 ? `<div class="timeline-evidence">📎 ${h.evidence_count} 份证据</div>` : ''}
    </div>`).join('')

  const disputeHtml = dispute ? `
    <div class="card" style="border-left: 3px solid #dc2626">
      <div style="font-weight:700;margin-bottom:8px">⚖️ 争议中</div>
      <div class="detail-row"><span class="detail-label">发起方</span><span class="detail-value">${dispute.initiator_name}</span></div>
      <div class="detail-row"><span class="detail-label">原因</span><span class="detail-value">${dispute.reason}</span></div>
      <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">${dispute.status}</span></div>
      ${dispute.respond_deadline ? `<div class="detail-row"><span class="detail-label">回应截止</span><span class="detail-value">${fmtTime(dispute.respond_deadline)}</span></div>` : ''}
    </div>` : ''

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:16px" onclick="history.back()">← 返回</button>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:13px;color:#6b7280;font-family:monospace">${order.id}</div>
        ${statusBadge(order.status)}
      </div>
      <div class="detail-row"><span class="detail-label">商品</span><span class="detail-value">${product?.title || ''}</span></div>
      <div class="detail-row"><span class="detail-label">金额</span><span class="detail-value" style="color:#4f46e5">${order.total_amount} DCP</span></div>
      <div class="detail-row"><span class="detail-label">下单时间</span><span class="detail-value">${fmtTime(order.created_at)}</span></div>
      ${order.shipping_address ? `<div class="detail-row"><span class="detail-label">收货地址</span><span class="detail-value">${order.shipping_address}</span></div>` : ''}
      ${isOverdue ? `<div class="alert alert-error" style="margin-top:12px">⚠️ 已超时！协议将自动判责</div>` : ''}
      ${activeDeadline && !isOverdue ? `<div class="alert alert-warning" style="margin-top:12px">截止时间：${fmtTime(activeDeadline.deadline)}</div>` : ''}
    </div>

    ${disputeHtml}

    <div id="action-area">
      ${actions ? renderActions(orderId, actions, order) : ''}
    </div>

    <div class="card">
      <div class="action-title">状态历史</div>
      <div class="timeline">${historyHtml || '<div style="color:#6b7280;font-size:13px">暂无记录</div>'}</div>
    </div>
  `, 'orders')
}

function getActions(order, isBuyer, isSeller, isLogistic) {
  const s = order.status
  if (isSeller && s === 'paid')      return [{ action: 'accept', label: '接单', style: 'success', needsEvidence: false }]
  if (isSeller && s === 'accepted')  return [{ action: 'ship',   label: '确认发货', style: 'success', needsEvidence: true, evidencePlaceholder: '物流单号 + 快递公司' }]
  if (isLogistic && s === 'shipped') return [{ action: 'pickup', label: '确认揽收', style: 'success', needsEvidence: true, evidencePlaceholder: 'GPS坐标 / 扫描记录' }]
  if (isLogistic && s === 'picked_up') return [{ action: 'transit', label: '开始运输', style: 'primary', needsEvidence: false }]
  if (isLogistic && s === 'in_transit') return [{ action: 'deliver', label: '确认投递', style: 'success', needsEvidence: true, evidencePlaceholder: '门口照片描述 / 签收记录' }]
  if (isBuyer && s === 'delivered')  return [
    { action: 'confirm', label: '确认收货', style: 'success', needsEvidence: false },
    { action: 'dispute', label: '发起争议', style: 'danger', needsEvidence: true, evidencePlaceholder: '描述问题（货不对版/货损等）', noteLabel: '争议理由' },
  ]
  return null
}

function renderActions(orderId, actions, order) {
  return `
    <div class="action-area">
      <div class="action-title">我的操作</div>
      <div id="action-msg"></div>
      ${actions.map((a, i) => `
        ${a.needsEvidence ? `
          <div class="form-group" id="evid-group-${i}" style="display:none">
            <label class="form-label">${a.noteLabel || '证据说明'}</label>
            <textarea class="form-control" id="evid-${i}" placeholder="${a.evidencePlaceholder || ''}"></textarea>
          </div>` : ''}
        <button class="btn btn-${a.style}" style="margin-bottom:8px"
          onclick="handleAction('${orderId}', '${a.action}', ${i}, ${a.needsEvidence})">
          ${a.label}
        </button>`).join('')}
    </div>`
}

window.handleAction = async (orderId, action, idx, needsEvidence) => {
  const evidGroup = document.getElementById(`evid-group-${idx}`)
  // 需要证据时先展开输入框
  if (needsEvidence && evidGroup && evidGroup.style.display === 'none') {
    evidGroup.style.display = ''
    return
  }
  const evidDesc = needsEvidence ? (document.getElementById(`evid-${idx}`)?.value?.trim() || '') : ''
  const msgEl = document.getElementById('action-msg')
  msgEl.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>处理中...</div>`

  const res = await POST(`/orders/${orderId}/action`, { action, notes: evidDesc, evidence_description: evidDesc })
  if (res.error) {
    msgEl.innerHTML = alert$('error', res.error)
  } else {
    msgEl.innerHTML = alert$('success', '操作成功！')
    setTimeout(() => renderOrderDetail(document.getElementById('app'), orderId), 1000)
  }
}

// ─── 卖家后台 ─────────────────────────────────────────────────

async function renderSeller(app) {
  if (!state.user) { renderLogin(); return }
  if (state.user.role !== 'seller') {
    app.innerHTML = shell(`
      <h1 class="page-title">卖家后台</h1>
      <div class="alert alert-info">此功能仅限卖家使用。<br>你的角色：${state.user.role}</div>
    `, 'seller')
    return
  }

  app.innerHTML = shell(loading$(), 'seller')
  const [products, orders] = await Promise.all([GET('/my-products'), GET('/orders')])

  const pendingOrders = orders.filter(o => ['paid', 'accepted'].includes(o.status) && o.seller_id === state.user.id)
  const myProducts = products

  const pendingHtml = pendingOrders.length === 0
    ? `<div class="empty" style="padding:24px"><div class="empty-icon">✅</div><div class="empty-text">暂无待处理订单</div></div>`
    : pendingOrders.map(o => `
      <div class="card" onclick="navigate('#order/${o.id}')" style="cursor:pointer">
        <div class="order-item">
          <div class="order-icon">📦</div>
          <div class="order-info">
            <div class="order-title">${o.product_title}</div>
            <div class="order-meta">${fmtTime(o.created_at)}</div>
            <div style="margin-top:6px">${statusBadge(o.status)}</div>
          </div>
          <div class="order-amount">${o.total_amount} DCP</div>
        </div>
      </div>`).join('')

  const productsHtml = myProducts.length === 0
    ? `<div class="empty" style="padding:24px"><div class="empty-icon">📭</div><div class="empty-text">还没有商品</div></div>`
    : myProducts.map(p => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600">${p.title}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px">${p.price} DCP · 库存 ${p.stock}</div>
          </div>
          <span class="badge badge-${p.status === 'active' ? 'green' : 'gray'}">${p.status === 'active' ? '在售' : '已下架'}</span>
        </div>
      </div>`).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">卖家后台</h1>

    ${pendingOrders.length > 0 ? `<div class="alert alert-warning">📬 你有 ${pendingOrders.length} 个订单需要处理</div>` : ''}

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:700">待处理订单</div>
    </div>
    ${pendingHtml}

    <div class="divider"></div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:700">我的商品</div>
      <button class="btn btn-primary btn-sm" onclick="showAddProduct()">+ 上架</button>
    </div>
    ${productsHtml}

    <div id="add-product-form" style="display:none">
      <div class="divider"></div>
      <div class="card">
        <div style="font-weight:700;margin-bottom:16px">上架新商品</div>
        <div id="add-msg"></div>
        <div class="form-group"><label class="form-label">商品名称</label><input class="form-control" id="prd-title" placeholder="例：手工竹编收纳篮"></div>
        <div class="form-group"><label class="form-label">商品描述</label><textarea class="form-control" id="prd-desc" placeholder="材质、尺寸、特点..."></textarea></div>
        <div class="form-group"><label class="form-label">价格（DCP）</label><input class="form-control" id="prd-price" type="number" placeholder="199"></div>
        <div class="form-group"><label class="form-label">库存数量</label><input class="form-control" id="prd-stock" type="number" value="10"></div>
        <div class="form-group"><label class="form-label">分类（可选）</label>
          <select class="form-control" id="prd-cat">
            <option value="">不分类</option>
            <option value="茶具">茶具</option><option value="家居">家居</option>
            <option value="食品">食品</option><option value="服装">服装</option>
            <option value="手工">手工</option><option value="电子">电子</option>
          </select>
        </div>
        <div class="btn-row">
          <button class="btn btn-gray" onclick="hideAddProduct()">取消</button>
          <button class="btn btn-primary" onclick="doAddProduct()">上架</button>
        </div>
      </div>
    </div>
  `, 'seller')
}

window.showAddProduct = () => { document.getElementById('add-product-form').style.display = '' }
window.hideAddProduct = () => { document.getElementById('add-product-form').style.display = 'none' }

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

  msgEl.innerHTML = alert$('success', `上架成功！质押 ${res.stake_locked} DCP 已锁定`)
  setTimeout(() => renderSeller(document.getElementById('app')), 1500)
}

// ─── 钱包页 ───────────────────────────────────────────────────

async function renderWallet(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'wallet')
  const wallet = await GET('/wallet')

  app.innerHTML = shell(`
    <h1 class="page-title">我的钱包</h1>
    <div class="card">
      <div style="text-align:center;padding:16px 0 8px">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px">可用余额</div>
        <div style="font-size:40px;font-weight:800;color:#4f46e5">${(wallet.balance || 0).toFixed(2)}<span style="font-size:16px;font-weight:400"> DCP</span></div>
      </div>
      <div class="divider"></div>
      <div class="wallet-grid">
        <div class="wallet-item">
          <div class="wallet-label">质押中</div>
          <div class="wallet-value">${(wallet.staked || 0).toFixed(2)}<span class="wallet-unit"> DCP</span></div>
        </div>
        <div class="wallet-item">
          <div class="wallet-label">托管中</div>
          <div class="wallet-value">${(wallet.escrowed || 0).toFixed(2)}<span class="wallet-unit"> DCP</span></div>
        </div>
        <div class="wallet-item" style="grid-column:1/-1">
          <div class="wallet-label">历史累计收益</div>
          <div class="wallet-value">${(wallet.earned || 0).toFixed(2)}<span class="wallet-unit"> DCP</span></div>
        </div>
      </div>
    </div>
    <div class="alert alert-info" style="font-size:13px">
      DCP 为协议内模拟货币。Phase 2 将接入真实链上资产。
    </div>
    <button class="btn btn-gray" onclick="doLogout()">退出登录</button>
  `, 'wallet')
}

window.doLogout = () => {
  state.apiKey = null; state.user = null
  localStorage.removeItem('dcp_key')
  navigate('#login')
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
    ? `<div class="empty"><div class="empty-icon">🔔</div><div class="empty-text">暂无通知</div></div>`
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

  app.innerHTML = shell(`<h1 class="page-title">通知</h1>${html}`, 'notifications')
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
