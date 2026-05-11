/**
 * L0-5 · Protocol Manifest
 *
 * WebAZ的机器可读规范。
 * 任何 AI Agent 读完这份 Manifest 就能立即参与协议，
 * 无需人工引导、无需试错、无需查文档。
 *
 * 输出格式：结构化 JSON，可通过以下方式获取：
 *   1. MCP Resource：webaz://protocol/manifest
 *   2. HTTP GET：<server>/api/manifest
 *   3. webaz_info 工具返回值中的 manifest 字段
 */

import Database from 'better-sqlite3'

export const MANIFEST_VERSION = '0.1.0'
export const MANIFEST_URI     = 'webaz://protocol/manifest'

// ─── 协议常量（与状态机保持同步）────────────────────────────

const DEADLINES = {
  pay:      { hours: 24,  label: '24h',  description: '买家下单后需在此时间内完成付款' },
  accept:   { hours: 24,  label: '24h',  description: '卖家收到订单通知后需在此时间内接单，否则自动退款并记录违约' },
  ship:     { hours: 72,  label: '72h',  description: '接单后卖家需在此时间内完成发货（含物流单号证明）' },
  pickup:   { hours: 48,  label: '48h',  description: '卖家标记发货后，物流方需在此时间内完成揽收' },
  delivery: { hours: 168, label: '7天',  description: '揽收后物流需在此时间内完成投递（含投递照片证明）' },
  confirm:  { hours: 72,  label: '72h',  description: '投递后买家需在此时间内确认收货，超时系统自动确认并结算' },
}

// ─── 状态机完整描述 ───────────────────────────────────────────

const STATE_MACHINE = {
  states: {
    created:          { label: '待付款',    responsible: 'buyer',      terminal: false, description: '订单已创建，等待买家付款' },
    paid:             { label: '待接单',    responsible: 'seller',     terminal: false, description: '资金已托管，等待卖家 24h 内接单' },
    accepted:         { label: '待发货',    responsible: 'seller',     terminal: false, description: '卖家已接单，需在 72h 内发货' },
    shipped:          { label: '已发货',    responsible: 'logistics',  terminal: false, description: '包裹已交物流，等待揽收' },
    picked_up:        { label: '已揽收',    responsible: 'logistics',  terminal: false, description: '物流已揽收，正在运输' },
    in_transit:       { label: '运输中',    responsible: 'logistics',  terminal: false, description: '包裹运输中，等待投递' },
    delivered:        { label: '待确认',    responsible: 'buyer',      terminal: false, description: '包裹已投递，等待买家 72h 内确认收货' },
    confirmed:        { label: '已确认',    responsible: 'system',     terminal: false, description: '买家确认收货，触发自动结算' },
    completed:        { label: '已完成',    responsible: null,         terminal: true,  description: '交易完成，资金已按比例分配' },
    cancelled:        { label: '已取消',    responsible: null,         terminal: true,  description: '订单取消，资金退回（如有托管）' },
    disputed:         { label: '争议中',    responsible: 'arbitrator', terminal: false, description: '争议冻结中，等待仲裁员介入' },
    fault_seller:     { label: '卖家违约',  responsible: 'system',     terminal: false, description: '卖家超时判责，正在退款买家' },
    fault_logistics:  { label: '物流违约',  responsible: 'system',     terminal: false, description: '物流方超时判责，正在处置赔付' },
    fault_buyer:      { label: '买家违约',  responsible: 'system',     terminal: false, description: '买家超时判责，资金转给卖家' },
  },

  // 所有合法转移（从 transitions.ts 同步）
  transitions: [
    { from: 'created',   to: 'paid',           actor: 'buyer',              deadline: 'pay',      auto_fault: 'cancelled',        evidence: false, description: '买家完成付款，资金进入协议托管' },
    { from: 'created',   to: 'cancelled',      actor: 'buyer/seller/system', deadline: null,      auto_fault: null,               evidence: false, description: '付款前取消订单，无需费用' },
    { from: 'paid',      to: 'accepted',       actor: 'seller',              deadline: 'accept',  auto_fault: 'fault_seller',     evidence: false, description: '卖家接单，承诺按时发货' },
    { from: 'paid',      to: 'cancelled',      actor: 'buyer',               deadline: null,      auto_fault: null,               evidence: false, description: '接单前买家可取消，全额退款' },
    { from: 'paid',      to: 'disputed',       actor: 'buyer/seller',        deadline: null,      auto_fault: null,               evidence: true,  description: '付款后发现问题，立即发起争议' },
    { from: 'accepted',  to: 'shipped',        actor: 'seller',              deadline: 'ship',    auto_fault: 'fault_seller',     evidence: true,  evidence_hint: '物流单号截图 + 包裹照片', description: '卖家发货，提交物流凭证' },
    { from: 'accepted',  to: 'disputed',       actor: 'buyer/seller',        deadline: null,      auto_fault: null,               evidence: true,  description: '接单后发现问题' },
    { from: 'shipped',   to: 'picked_up',      actor: 'logistics',           deadline: 'pickup',  auto_fault: 'fault_logistics',  evidence: true,  evidence_hint: '揽收扫描 + GPS', description: '物流揽收包裹' },
    { from: 'shipped',   to: 'disputed',       actor: 'buyer/seller/logistics', deadline: null,   auto_fault: null,               evidence: true,  description: '发货后发现问题' },
    { from: 'picked_up', to: 'in_transit',     actor: 'logistics/system',    deadline: null,      auto_fault: null,               evidence: false, description: '开始运输' },
    { from: 'picked_up', to: 'disputed',       actor: 'any',                 deadline: null,      auto_fault: null,               evidence: true,  description: '揽收后发现包裹问题' },
    { from: 'in_transit', to: 'delivered',     actor: 'logistics',           deadline: 'delivery', auto_fault: 'fault_logistics', evidence: true,  evidence_hint: '投递照片（含门牌号）+ 签收记录', description: '物流完成投递' },
    { from: 'in_transit', to: 'disputed',      actor: 'any',                 deadline: null,      auto_fault: null,               evidence: true,  description: '运输中出现问题' },
    { from: 'delivered', to: 'confirmed',      actor: 'buyer/system',        deadline: 'confirm', auto_fault: 'auto_confirmed',   evidence: false, description: '买家确认收货（超时自动确认）' },
    { from: 'delivered', to: 'disputed',       actor: 'buyer',               deadline: null,      auto_fault: null,               evidence: true,  evidence_hint: '收货照片 + 问题描述', description: '买家收货后发现问题' },
    { from: 'confirmed', to: 'completed',      actor: 'system',              deadline: null,      auto_fault: null,               evidence: false, description: '系统自动结算，交易完成' },
    { from: 'disputed',  to: 'completed',      actor: 'arbitrator/system',   deadline: null,      auto_fault: null,               evidence: false, description: '仲裁裁定：资金释放给卖家' },
    { from: 'disputed',  to: 'cancelled',      actor: 'arbitrator/system',   deadline: null,      auto_fault: null,               evidence: false, description: '仲裁裁定：退款买家' },
  ],

  // 超时截止时间配置（从下单到结束每个阶段的 hours）
  deadline_config: DEADLINES,
}

// ─── 经济模型 ─────────────────────────────────────────────────

const ECONOMICS = {
  fees: {
    protocol:   { rate: '2%',  description: '协议运营费，每笔成交后从卖家收益中扣除' },
    logistics:  { rate: '5%',  description: '物流服务费，成交后自动分配给物流方' },
    promoter:   { rate: '3%',  description: '推荐佣金，如果买家通过推荐链接下单，推荐人获得' },
    skill_ref:  { rate: '0.5%', description: 'Skill 推荐佣金：买家订阅了卖家的 catalog_sync Skill，成交后 Skill 发布者获得' },
  },
  seller_net: '成交额 × (100% - 2% - 5% - 3%推荐[可选]) = 约 90~93%',

  stakes: {
    seller: {
      base_rate:    '15%',
      description:  '卖家上架商品时需质押商品价格的 15%（声誉越高折扣越大，最低降至 5%）',
      fate_on_success: '交易完成后100%返还给卖家',
      fate_on_fault:   '违约时扣除部分质押赔付买家',
    },
  },

  escrow: {
    description:  '买家付款后资金立即进入协议托管，不经任何人手',
    release_condition: '仅在买家确认收货或仲裁完成后自动释放',
    currency:     'WAZ（Phase 0 为模拟代币，Phase 2 接入链上稳定币）',
  },
}

// ─── 角色描述 ─────────────────────────────────────────────────

const ROLES = {
  buyer: {
    label:        '买家',
    description:  '浏览搜索商品，下单付款，确认收货。如有问题可发起争议。',
    stake_required: false,
    entry_action: 'webaz_register(role=buyer)',
    workflow: [
      'webaz_search(query="...")  → 搜索商品',
      'webaz_place_order(product_id, shipping_address)  → 下单，资金自动托管',
      'webaz_get_status(order_id)  → 追踪订单进展',
      'webaz_update_order(action=confirm)  → 确认收货，触发结算',
      'webaz_update_order(action=dispute, evidence)  → 如有问题发起争议',
    ],
    key_rights:   ['72h 内不确认可超时自动确认', '任何阶段可发起争议（需提供证据）', '卖家/物流违约自动退款'],
    key_duties:   ['24h 内完成付款', '72h 内确认收货或发起争议', '争议需提供真实证据'],
  },

  seller: {
    label:        '卖家',
    description:  '上架商品，接单，按时发货。质押保证金确保履约。',
    stake_required: true,
    entry_action: 'webaz_register(role=seller)',
    workflow: [
      'webaz_list_product(title, description, price, stock)  → 上架商品（需质押 15% 保证金）',
      'webaz_notifications(unread=true)  → 定期检查新订单通知',
      'webaz_update_order(action=accept, order_id)  → 接单（24h 内必须）',
      'webaz_update_order(action=ship, evidence="物流单号+照片")  → 发货（72h 内必须）',
      'webaz_skill(action=publish, skill_type=auto_accept)  → 可选：发布自动接单 Skill',
    ],
    key_rights:   ['自动结算无需人工干预', '声誉升级降低质押比例', '发布 Skill 获得额外推荐佣金'],
    key_duties:   ['24h 内接单（否则自动退款 + 违约记录）', '72h 内发货（需上传证据）', '争议需在 48h 内提交反驳证据'],
  },

  logistics: {
    label:        '物流方',
    description:  '揽收包裹，更新运输状态，完成投递。每笔成交获得 5% 物流费。',
    stake_required: false,
    entry_action: 'webaz_register(role=logistics)',
    workflow: [
      'webaz_update_order(action=pickup, order_id, evidence="揽收凭证")  → 揽收（48h 内）',
      'webaz_update_order(action=transit, order_id)  → 更新运输状态',
      'webaz_update_order(action=deliver, order_id, evidence="投递照片")  → 确认投递（7天内）',
    ],
    key_rights:   ['每笔成交自动获得 5% 物流费', '违约赔付有责任上限'],
    key_duties:   ['48h 内揽收', '7天内完成投递', '必须上传揽收和投递证明'],
  },

  arbitrator: {
    label:        '仲裁员',
    description:  '处理争议案件，做出裁定。需要公正客观，裁定结果永久上链。',
    stake_required: false,
    entry_action: 'webaz_register(role=arbitrator)',
    workflow: [
      'webaz_dispute(action=list_open)  → 查看所有待处理争议',
      'webaz_dispute(action=view, dispute_id)  → 查看争议详情和双方证据',
      'webaz_dispute(action=arbitrate, ruling=refund_buyer|release_seller|partial_refund, ruling_reason)  → 做出裁定',
    ],
    key_rights:   ['查看所有争议详情', '做出三种裁定选择', '仲裁超时后系统自动裁定（保护所有人）'],
    key_duties:   ['120h 内完成裁定（否则系统自动退款买家）', '裁定必须提供理由（永久记录）', '保持公正客观'],
  },
}

// ─── 信任保障 ─────────────────────────────────────────────────

const TRUST_GUARANTEES = [
  {
    guarantee: '资金自动托管，任何人无法单方面转移',
    mechanism: '买家付款后资金锁定在协议层，仅在双方达成共识或仲裁完成后释放',
  },
  {
    guarantee: '每个状态转移都需要责任方的操作证明',
    mechanism: '状态机拦截所有非法转移；关键步骤（发货/投递）强制要求证据',
  },
  {
    guarantee: '超时自动判责，无需任何人主动触发',
    mechanism: 'cron 进程每 5 分钟扫描，超时方自动判违约并执行处置',
  },
  {
    guarantee: '争议 48h 无响应自动判原告胜诉',
    mechanism: '被告超时不回应，协议自动裁定：买家发起则退款，卖家发起则释放资金',
  },
  {
    guarantee: '仲裁员 120h 不裁定自动退款买家',
    mechanism: '买家保护原则：仲裁员失职时，协议默认保护资金弱势方',
  },
  {
    guarantee: '声誉系统防止恶意行为者反复违约',
    mechanism: '违约每次扣 40 分，累积负面记录，声誉低的参与者需支付更高质押',
  },
]

// ─── 争议系统 ─────────────────────────────────────────────────

const DISPUTE_SYSTEM = {
  description: '任何参与方对交易有异议时，可在有效阶段发起争议。争议启动后资金冻结直至裁定。',
  timelines: {
    defendant_response: '48h — 被告方提交反驳证据的截止时间',
    arbitrator_ruling:  '120h — 仲裁员做出裁定的截止时间',
  },
  rulings: {
    refund_buyer:    '全额退款买家，扣押卖家 50% 质押作为违约金',
    release_seller:  '释放资金给卖家，扣押部分买家押金',
    partial_refund:  '按指定金额部分退款，适用于质量争议',
  },
  auto_escalation: [
    '被告 48h 不响应 → 原告自动胜诉（无需仲裁员）',
    '仲裁员 120h 不裁定 → 系统默认退款买家（买家保护原则）',
  ],
}

// ─── Skill 市场摘要 ───────────────────────────────────────────

const SKILL_MARKET = {
  description: 'Skill 市场让卖家发布可复用的 Agent 能力插件，买家订阅后自动享受增值服务。解决协议冷启动的核心机制。',
  skill_types: [
    { type: 'catalog_sync',      label: '目录同步',  benefit: '买家订阅后搜索时优先看到你的商品，成交额 0.5% 作为推荐佣金' },
    { type: 'auto_accept',       label: '自动接单',  benefit: '买家下单后立即接受，无需等待 24h，大幅提升买家体验' },
    { type: 'price_negotiation', label: '价格协商',  benefit: '允许买家 Agent 在限定范围内自动议价，减少沟通成本' },
    { type: 'quality_guarantee', label: '质量承诺',  benefit: '额外质押 WAZ 作为品质担保，增强买家信任' },
    { type: 'instant_ship',      label: '极速发货',  benefit: '承诺 24h 内发货，违约自动赔付' },
  ],
}

// ─── 声誉系统摘要 ─────────────────────────────────────────────

const REPUTATION = {
  description: '声誉积分是参与者在协议中的无形资产，影响质押折扣、搜索排序和买家信任度。',
  levels: [
    { key: 'new',     label: '新手 🌱',  min_points: 0,    stake_discount: '0%',   search_boost: '0%' },
    { key: 'trusted', label: '可信 ⭐',  min_points: 200,  stake_discount: '-5%',  search_boost: '+10%' },
    { key: 'quality', label: '优质 🌟',  min_points: 800,  stake_discount: '-10%', search_boost: '+25%' },
    { key: 'star',    label: '明星 💫',  min_points: 2000, stake_discount: '-15%', search_boost: '+50%' },
    { key: 'legend',  label: '传奇 🔥',  min_points: 5000, stake_discount: '-20%', search_boost: '置顶' },
  ],
  earning_events: [
    { event: '交易完成',       seller: '+10', buyer: '+5',  logistics: '+8' },
    { event: '极速接单(6h内)', seller: '+5',  buyer: '-',   logistics: '-' },
    { event: '准时发货',       seller: '+5',  buyer: '-',   logistics: '-' },
    { event: '准时投递',       seller: '-',   buyer: '-',   logistics: '+5' },
    { event: '及时确认收货',   seller: '-',   buyer: '+2',  logistics: '-' },
    { event: '争议胜诉',       all: '+8' },
    { event: '争议败诉',       all: '-25' },
    { event: '超时违约',       all: '-40' },
  ],
}

// ─── Agent 操作指南（直接嵌入 Manifest，供 LLM 读取）──────────

const AGENT_GUIDE = {
  for_llm: `你是一个 AI Agent，正在读取 WebAZ的机器可读规范。
以下是你需要知道的核心要点：

1. WebAZ 是一个 Agent 原生的商业协议。你可以作为买家、卖家或物流方参与交易。
2. 调用 webaz_register 获取 api_key，后续所有操作都用这个 key 认证。
3. 每笔交易的资金自动托管，超时自动判责，你不需要担心对方违约。
4. 发货/揽收/投递必须上传证据，否则会被认定为未操作。
5. 如发现问题，立即调用 webaz_update_order(action=dispute) 发起争议，不要等待。
6. 使用 webaz_notifications(unread=true, mark_read=true) 定期检查待处理事项。

⚠️ 关键规则：所有截止时间都是硬性规定，超时自动判责，与对方沟通无法延期。`,

  decision_tree: {
    '我是买家，想购买某件商品': ['webaz_search → webaz_place_order → 等通知 → webaz_update_order(confirm)'],
    '我是卖家，有新订单通知':   ['webaz_get_status → webaz_update_order(accept) → webaz_update_order(ship, evidence)'],
    '我是物流，需要揽收':       ['webaz_update_order(pickup, evidence) → webaz_update_order(deliver, evidence)'],
    '收到货物有问题':           ['立即 webaz_update_order(dispute, evidence_description) → webaz_dispute(respond)'],
    '我是仲裁员':               ['webaz_dispute(list_open) → webaz_dispute(view) → webaz_dispute(arbitrate, ruling, reason)'],
  },
}

// ─── 生成 Manifest ────────────────────────────────────────────

export function generateManifest(db?: Database.Database) {
  // 如果传入 db，可以附加实时统计数据
  const stats = db ? getLiveStats(db) : null

  return {
    $schema:     'https://dcp-protocol.io/schema/manifest/v1',
    $uri:        MANIFEST_URI,
    generated_at: new Date().toISOString(),

    protocol: {
      name:        'WebAZ',
      full_name:   'WebAZ',
      version:     MANIFEST_VERSION,
      tagline:     'AI Agent 原生商业协议 — 任何 Agent 可以买货、卖货、送货',
      description: 'WebAZ 是一个专为 AI Agent 设计的去中心化商业协议。协议通过状态机强制每个参与方按时举证，超时自动判责，资金自动结算。任何 AI Agent 接入 MCP 工具后即可立即参与真实商业交易。',
      phase:       'Phase 0 — 概念验证（SQLite 模拟，无需真实货币）',
      roadmap: {
        phase0: '✅ 完成 — 状态机、资金托管、争议仲裁、通知、Skill 市场、声誉积分',
        phase1: '⏳ 进行中 — MCP 市场发布，接入真实卖家',
        phase2: '⬜ 计划中 — 链上资产托管，去中心化节点',
      },
    },

    agent_guide:  AGENT_GUIDE,
    roles:        ROLES,
    state_machine: STATE_MACHINE,
    economics:    ECONOMICS,
    trust_guarantees: TRUST_GUARANTEES,
    dispute_system:   DISPUTE_SYSTEM,
    skill_market:     SKILL_MARKET,
    reputation:       REPUTATION,

    // 实时统计（可选）
    live_stats: stats,
  }
}

function getLiveStats(db: Database.Database) {
  try {
    const users       = (db.prepare('SELECT COUNT(*) as n FROM users WHERE role != ?').get('system') as { n: number }).n
    const products    = (db.prepare("SELECT COUNT(*) as n FROM products WHERE status = 'active'").get() as { n: number }).n
    const orders      = (db.prepare('SELECT COUNT(*) as n FROM orders').get() as { n: number }).n
    const completed   = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE status = 'completed'").get() as { n: number }).n
    const disputes    = (db.prepare('SELECT COUNT(*) as n FROM disputes').get() as { n: number }).n
    const skills      = (db.prepare("SELECT COUNT(*) as n FROM skills WHERE active = 1").get() as { n: number }).n
    const totalVolume = (db.prepare("SELECT COALESCE(SUM(total_amount),0) as v FROM orders WHERE status = 'completed'").get() as { v: number }).v
    return { users, active_products: products, total_orders: orders, completed_orders: completed, total_disputes: disputes, active_skills: skills, total_volume_dcp: totalVolume }
  } catch {
    return null
  }
}

// ─── 格式化输出（供 webaz_info 使用）──────────────────────────

export function getManifestSummary() {
  return {
    name:        'WebAZ',
    version:     MANIFEST_VERSION,
    tagline:     'AI Agent 原生商业协议',
    roles_count: Object.keys(ROLES).length,
    states_count: Object.keys(STATE_MACHINE.states).length,
    transitions_count: STATE_MACHINE.transitions.length,
    trust_guarantees_count: TRUST_GUARANTEES.length,
    manifest_uri: MANIFEST_URI,
    manifest_http_hint: '通过 GET /api/manifest 获取完整规范（需要 PWA 服务器运行）',
  }
}
