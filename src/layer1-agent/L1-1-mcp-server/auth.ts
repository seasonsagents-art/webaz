/**
 * L1-7 · Agent 身份验证
 * Agent 调用任何需要权限的工具时，必须提供 api_key。
 * api_key 在注册时生成，绑定到用户角色。
 */

import Database from 'better-sqlite3'

export interface AuthUser {
  id: string
  name: string
  role: string
  api_key: string
}

export function authenticate(
  db: Database.Database,
  apiKey: string
): AuthUser | null {
  if (!apiKey || apiKey === '') return null
  return db
    .prepare('SELECT id, name, role, api_key FROM users WHERE api_key = ?')
    .get(apiKey) as AuthUser | null
}

export function requireAuth(
  db: Database.Database,
  apiKey: string
): { user: AuthUser } | { error: string } {
  const user = authenticate(db, apiKey)
  if (!user) {
    return {
      error: '身份验证失败：api_key 无效。请先用 dcp_register 注册并保存你的 api_key。'
    }
  }
  return { user }
}
