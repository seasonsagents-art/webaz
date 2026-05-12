/**
 * L0-1 · 数据库 Schema
 * 所有表结构定义。协议里每个角色、每笔交易、每个状态都存在这里。
 */

import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'

const DATA_DIR = path.join(os.homedir(), '.webaz')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'webaz.db')

export function initDatabase(): Database.Database {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')  // 更好的并发性能
  db.pragma('foreign_keys = ON')   // 强制外键约束

  db.exec(`

    /* ──────────────────────────────────────────
       用户表 · 每个参与协议的人
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,          -- 唯一ID，格式：usr_xxxx
      name        TEXT NOT NULL,
      role        TEXT NOT NULL,             -- 当前激活角色
      roles       TEXT DEFAULT '[]',         -- 拥有的所有角色（JSON数组）
      api_key     TEXT UNIQUE NOT NULL,      -- Agent 调用时用这个验证身份
      stake       REAL DEFAULT 0,            -- 当前质押金额（模拟货币）
      reputation  REAL DEFAULT 100,          -- 声誉分（满分100）
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       商品表 · 卖家上架的商品
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,         -- 格式：prd_xxxx
      seller_id     TEXT NOT NULL REFERENCES users(id),
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      price         REAL NOT NULL,
      currency      TEXT DEFAULT 'DCP',       -- 协议内部模拟货币
      stock         INTEGER DEFAULT 1,
      category      TEXT,
      images        TEXT DEFAULT '[]',        -- JSON 数组，存图片路径
      stake_amount  REAL DEFAULT 0,           -- 卖家为这个商品质押的金额
      status        TEXT DEFAULT 'active',    -- active / paused / delisted
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       订单表 · 一笔完整的交易
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,       -- 格式：ord_xxxx
      product_id      TEXT NOT NULL REFERENCES products(id),
      buyer_id        TEXT NOT NULL REFERENCES users(id),
      seller_id       TEXT NOT NULL REFERENCES users(id),
      logistics_id    TEXT REFERENCES users(id),   -- 接单的物流方
      promoter_id     TEXT REFERENCES users(id),   -- 带来流量的推荐人（可为空）

      quantity        INTEGER DEFAULT 1,
      unit_price      REAL NOT NULL,
      total_amount    REAL NOT NULL,          -- 买家支付总额
      escrow_amount   REAL NOT NULL,          -- 托管中的金额

      -- 当前状态（L0-2 状态机管理这个字段）
      status          TEXT NOT NULL DEFAULT 'created',
      -- 状态枚举：
      -- created       买家下单，资金待托管
      -- paid          资金已托管
      -- accepted      卖家确认接单
      -- shipped       卖家已交物流
      -- picked_up     物流已揽收
      -- in_transit    运输中
      -- delivered     物流已投递
      -- confirmed     买家确认收货 → 触发结算
      -- disputed      争议中
      -- completed     交易完成，资金已分配
      -- cancelled     取消

      -- 各节点截止时间（超时自动判责）
      pay_deadline      TEXT,   -- 下单后 24h 内必须完成支付
      accept_deadline   TEXT,   -- 支付后 24h 内卖家必须接单
      ship_deadline     TEXT,   -- 接单后按承诺时间发货
      pickup_deadline   TEXT,   -- 发货后 48h 内物流必须揽收
      delivery_deadline TEXT,   -- 揽收后 X 天内必须投递
      confirm_deadline  TEXT,   -- 投递后 72h 内买家确认（否则自动确认）

      shipping_address  TEXT,   -- 收货地址（JSON）
      notes             TEXT,   -- 买家备注

      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       状态历史表 · 订单每次状态变更的完整记录
       这是「自举证」系统的核心，任何状态变更都留档
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS order_state_history (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL REFERENCES orders(id),
      from_status  TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      actor_id     TEXT NOT NULL REFERENCES users(id),  -- 谁触发了这次状态变更
      actor_role   TEXT NOT NULL,                        -- 触发者的角色
      evidence_ids TEXT DEFAULT '[]',                    -- 本次附上的证据（JSON数组）
      notes        TEXT,                                 -- 说明
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       证据表 · 每一份上传的证明材料
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS evidence (
      id           TEXT PRIMARY KEY,           -- 格式：evt_xxxx
      order_id     TEXT NOT NULL REFERENCES orders(id),
      uploader_id  TEXT NOT NULL REFERENCES users(id),
      type         TEXT NOT NULL,              -- photo / video / document / gps / signature
      description  TEXT NOT NULL,              -- 这份证据证明什么
      file_path    TEXT,                       -- 本地存储路径（Phase 0）
      file_hash    TEXT,                       -- 文件内容的哈希（防篡改）
      metadata     TEXT DEFAULT '{}',          -- 额外信息，如GPS坐标（JSON）
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       争议表 · 出现纠纷时的记录
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS disputes (
      id              TEXT PRIMARY KEY,         -- 格式：dsp_xxxx
      order_id        TEXT NOT NULL REFERENCES orders(id),
      initiator_id    TEXT NOT NULL REFERENCES users(id),   -- 谁发起的争议
      reason          TEXT NOT NULL,            -- 争议原因
      stake_deposit   REAL DEFAULT 0,           -- 发起方质押的保证金（防恶意争议）

      status          TEXT DEFAULT 'open',      -- open / in_review / resolved / dismissed
      assigned_arbitrators TEXT DEFAULT '[]',   -- 分配到的仲裁员（JSON数组）
      verdict         TEXT,                     -- 裁定结果（JSON）
      verdict_reason  TEXT,                     -- 裁定理由

      created_at      TEXT DEFAULT (datetime('now')),
      resolved_at     TEXT
    );

    /* ──────────────────────────────────────────
       钱包表 · 协议内的模拟资金
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS wallets (
      user_id   TEXT PRIMARY KEY REFERENCES users(id),
      balance   REAL DEFAULT 0,        -- 可用余额
      staked    REAL DEFAULT 0,        -- 质押中（锁定不可用）
      escrowed  REAL DEFAULT 0,        -- 托管中（交易进行时锁定）
      earned    REAL DEFAULT 0,        -- 累计收益（统计用）
      updated_at TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       收益分配记录
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS payouts (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL REFERENCES orders(id),
      recipient_id TEXT NOT NULL REFERENCES users(id),
      role         TEXT NOT NULL,       -- 以什么角色获得这笔收益
      amount       REAL NOT NULL,
      reason       TEXT NOT NULL,       -- seller_share / promoter_fee / logistics_fee / etc.
      created_at   TEXT DEFAULT (datetime('now'))
    );

  `)

  // 迁移：为已有数据库添加 roles 列
  try {
    db.exec(`ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'`)
  } catch { /* 列已存在 */ }
  db.exec(`UPDATE users SET roles = json_array(role) WHERE roles = '[]' OR roles IS NULL`)

  console.log('✅ L0-1 数据库初始化完成：', DB_PATH)
  return db
}

// 生成唯一 ID 的工具函数
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 6)
  return `${prefix}_${timestamp}${random}`
}
