/**
 * L0-2 · 状态机：合法转移表
 *
 * 每一行定义：从哪个状态 → 到哪个状态，谁有权触发，需要什么证据，用哪个截止时间。
 * 不在这张表里的转移，一律拒绝——这是「无歧义」设计的核心。
 */

export type OrderStatus =
  | 'created'      // 买家下单，等待付款
  | 'paid'         // 资金已托管
  | 'accepted'     // 卖家已接单
  | 'shipped'      // 卖家已交物流
  | 'picked_up'    // 物流已揽收
  | 'in_transit'   // 运输中
  | 'delivered'    // 物流已投递
  | 'confirmed'    // 买家确认收货 → 触发结算
  | 'disputed'     // 争议中
  | 'completed'    // 交易完成
  | 'cancelled'    // 已取消
  | 'fault_buyer'      // 超时判责：买家
  | 'fault_seller'     // 超时判责：卖家
  | 'fault_logistics'  // 超时判责：物流

export type UserRole =
  | 'buyer' | 'seller' | 'logistics' | 'reviewer'
  | 'arbitrator' | 'promoter' | 'system'  // system = 超时自动触发

export interface Transition {
  allowedRoles: UserRole[]           // 哪些角色可以触发
  deadlineField?: string             // 对应 orders 表里的截止时间字段
  requiresEvidence?: boolean         // 是否必须提交证据
  evidenceHint?: string              // 提示：应该上传什么证据
  autoFaultState?: OrderStatus       // 超时后自动跳转到哪个判责状态
  faultParty?: UserRole              // 超时时谁负责
  description: string                // 人类可读的说明
}

// key 格式：'from_status→to_status'
export const VALID_TRANSITIONS: Record<string, Transition> = {

  // ── 买家付款 ──────────────────────────────────────────────
  'created→paid': {
    allowedRoles: ['buyer'],
    deadlineField: 'pay_deadline',
    requiresEvidence: false,
    autoFaultState: 'cancelled',
    faultParty: 'buyer',
    description: '买家完成付款，资金进入托管'
  },

  'created→cancelled': {
    allowedRoles: ['buyer', 'seller', 'system'],
    requiresEvidence: false,
    description: '下单后付款前取消订单'
  },

  // ── 卖家接单 ──────────────────────────────────────────────
  'paid→accepted': {
    allowedRoles: ['seller'],
    deadlineField: 'accept_deadline',
    requiresEvidence: false,
    autoFaultState: 'fault_seller',
    faultParty: 'seller',
    description: '卖家确认接单，承诺按时发货'
  },

  'paid→cancelled': {
    allowedRoles: ['buyer'],
    requiresEvidence: false,
    description: '卖家接单前买家可取消（全额退款）'
  },

  // ── 卖家发货 ──────────────────────────────────────────────
  'accepted→shipped': {
    allowedRoles: ['seller'],
    deadlineField: 'ship_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：物流单号截图 + 包裹称重/外观照片',
    autoFaultState: 'fault_seller',
    faultParty: 'seller',
    description: '卖家将包裹交给物流，提交发货证明'
  },

  // ── 物流揽收 ──────────────────────────────────────────────
  'shipped→picked_up': {
    allowedRoles: ['logistics'],
    deadlineField: 'pickup_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：揽收扫描记录 + 当前GPS位置',
    autoFaultState: 'fault_logistics',
    faultParty: 'logistics',
    description: '物流方确认已揽收，包裹完整'
  },

  // ── 运输中更新 ─────────────────────────────────────────────
  'picked_up→in_transit': {
    allowedRoles: ['logistics', 'system'],
    requiresEvidence: false,
    description: '包裹开始运输（可自动触发）'
  },

  // ── 物流投递 ──────────────────────────────────────────────
  'in_transit→delivered': {
    allowedRoles: ['logistics'],
    deadlineField: 'delivery_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：投递照片（含门牌号）+ 收件人签收/GPS坐标',
    autoFaultState: 'fault_logistics',
    faultParty: 'logistics',
    description: '物流确认投递完成，提交投递证明'
  },

  // ── 买家确认 ──────────────────────────────────────────────
  'delivered→confirmed': {
    allowedRoles: ['buyer', 'system'],  // system = 超时自动确认
    deadlineField: 'confirm_deadline',
    requiresEvidence: false,
    autoFaultState: 'confirmed',        // 超时不是判责，而是自动确认
    faultParty: 'system',
    description: '买家确认收货，触发资金结算'
  },

  // ── 发起争议（任何阶段都可触发）──────────────────────────────
  'paid→disputed': {
    allowedRoles: ['buyer', 'seller'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '资金托管后发现问题，发起争议'
  },
  'accepted→disputed': {
    allowedRoles: ['buyer', 'seller'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '卖家接单后发现问题'
  },
  'shipped→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '发货后出现问题'
  },
  'picked_up→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '揽收后出现问题（如包裹损毁）'
  },
  'in_transit→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '运输中出现问题'
  },
  'delivered→disputed': {
    allowedRoles: ['buyer'],
    requiresEvidence: true,
    evidenceHint: '上传：收到货物的照片 + 问题描述',
    description: '买家收货后发现货不对版或货损'
  },

  // ── 仲裁结束 ──────────────────────────────────────────────
  'disputed→completed': {
    allowedRoles: ['arbitrator'],
    requiresEvidence: true,
    evidenceHint: '上传仲裁裁定书',
    description: '仲裁员完成裁定，执行处置结果'
  },
  'disputed→cancelled': {
    allowedRoles: ['arbitrator'],
    requiresEvidence: true,
    evidenceHint: '上传仲裁裁定书',
    description: '仲裁裁定取消交易，全额退款'
  },

  // ── 正常完成 ──────────────────────────────────────────────
  'confirmed→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家确认后系统自动结算，交易完成'
  },

  // ── 超时自动判责转移（system 触发）────────────────────────────
  // 这些转移不在正常操作流程里，只由 checkTimeouts 自动触发
  'created→fault_buyer': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家超时未付款，自动取消并标记违约'
  },
  'paid→fault_seller': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '卖家超时未接单，自动退款并标记违约'
  },
  'accepted→fault_seller': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '卖家超时未发货，自动退款并标记违约'
  },
  'shipped→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未揽收，标记物流违约'
  },
  'picked_up→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未投递，标记物流违约'
  },
  'in_transit→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未投递，标记物流违约'
  },

  // ── 判责后的处置结算 ─────────────────────────────────────────
  'fault_seller→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '卖家违约：退款买家，扣除卖家质押'
  },
  'fault_logistics→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流违约：从物流质押池赔付'
  },
  'fault_buyer→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家违约：资金转给卖家，扣除买家质押'
  },
}

/** 给定当前状态，返回「当前应该由谁来操作」 */
export const CURRENT_RESPONSIBLE: Record<string, UserRole> = {
  created:    'buyer',       // 等买家付款
  paid:       'seller',      // 等卖家接单
  accepted:   'seller',      // 等卖家发货
  shipped:    'logistics',   // 等物流揽收
  picked_up:  'logistics',   // 等物流投递
  in_transit: 'logistics',   // 等物流投递
  delivered:  'buyer',       // 等买家确认
  disputed:   'arbitrator',  // 等仲裁处理
}
