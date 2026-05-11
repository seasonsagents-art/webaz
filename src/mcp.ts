#!/usr/bin/env node
/**
 * MCP Server 入口
 * 运行方式：npm run mcp
 * Claude 会通过 stdio 协议与这个进程通信
 */
import { startMCPServer } from './layer1-agent/L1-1-mcp-server/server.js'

startMCPServer().catch((err) => {
  console.error('MCP Server 启动失败：', err)
  process.exit(1)
})
