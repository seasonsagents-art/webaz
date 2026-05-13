# Launch Drafts — WebAZ 0.1.8

工作底稿。HN / Reddit / X / 中文圈四份文案 + 5 分钟 demo 脚本。可以直接复制粘贴，也可以按你的语气改。

---

## A. Hacker News（Show HN — 重技术诚实）

**标题：**

```
Show HN: WebAZ – an agent-native commerce protocol over MCP
```

**正文：**

```
WebAZ is a small protocol I've been building to let humans and AI agents trade on the same rails. Agents access it through 14 MCP tools (search, list product, place order, escrow, dispute, settle); humans access the same backend through a PWA at webaz.xyz. Both sides see the same orders.

A few design choices that may be interesting:

1. **Price lock before order.** `webaz_verify_price` returns a 10-min session_token. `webaz_place_order` won't accept a price that drifted from the locked one — it returns `price_changed` with the new price instead of silently overcharging. Closes the obvious LLM-vs-mutable-state race.

2. **Structured product schema for agents.** Products carry `specs`, `brand`, `model`, `return_days`, `handling_hours`, `warranty_days`, etc. Search returns these plus a one-line `agent_summary` so agents don't have to parse free-form descriptions to compare items.

3. **Real escrow on Base Sepolia.** Each user gets a derived USDC deposit address. A background watcher credits the wallet, a hot wallet sweeps and pays withdrawals. Currently testnet only; mainnet is the next step.

4. **Source-link sovereignty.** When a seller lists a product with a source URL (for price comparison), a different seller can't reuse that URL. If they try, a crowd verification task is created — verifiers visit the original page, look for a code the second seller placed in the title/description, and report. Settles which seller actually controls the listing.

5. **Auto-judgement everywhere.** State transitions have deadlines. Seller doesn't accept in 24h → fault_seller. Buyer doesn't confirm in 72h after delivery → auto-confirm. Defendant doesn't respond to a dispute in 48h → other side wins by default. No human in the loop unless the system can't decide.

**Where it isn't done yet:**
- Evidence upload for disputes is still text-only — the dispute table is wired, the upload endpoint isn't.
- Reviews (the structured 1-5 star feedback that feeds reputation) aren't built.
- Real users: I have ~0. This is the launch.

**Try it:**
- Claude Desktop: `npx -y @seasonkoh/webaz`
- PWA: https://webaz.xyz
- Source: https://github.com/seasonsagents-art/webaz
- MCP Registry: io.github.seasonsagents-art/webaz

Built in TypeScript / better-sqlite3 / viem / MCP SDK. SQLite single-file backend; PostgreSQL is on the roadmap when there's anyone to scale for. Curious what people think of the price-lock + structured-spec combination for agent-driven commerce — does it actually help, or am I over-engineering?
```

---

## B. Reddit r/mcp（社区朋友间口吻）

```
**WebAZ – agent-native commerce protocol over MCP (Show & Tell)**

Hey r/mcp 👋 — wanted to share a project I just got to a "real enough to share" state.

WebAZ is an MCP server (14 tools) that exposes a commerce protocol: search, list product, place order, escrow, dispute, settle. Same backend feeds a PWA at webaz.xyz so humans and agents see the same orders.

A few things I think the MCP community might appreciate:

- **Price lock**: `webaz_verify_price` → 10-min session token → `webaz_place_order` rejects mismatched prices. Avoids the "agent decides on $X, by the time it submits the order it's $Y" race.
- **agent_summary in search results**: one line summarizing brand/model/return days/handling time. So your buyer agent doesn't need to LLM its way through product descriptions to compare.
- **Real USDC escrow** (Base Sepolia for now). Each user has a derived deposit address; on-chain credits show up in the wallet automatically.
- **Auto-judgement**: every state transition has a deadline + a default fault. No frozen orders.

**Install:**
\`\`\`
"webaz": {"command": "npx", "args": ["-y", "@seasonkoh/webaz"]}
\`\`\`
Or `npx -y @seasonkoh/webaz` from a terminal.

Also on **MCP Registry**: `io.github.seasonsagents-art/webaz`.

Looking for: any agent power-users who want to actually try buying/selling and tell me what breaks. The first 5-10 real interactions will probably show me 5-10 things I missed.

Repo: github.com/seasonsagents-art/webaz
```

---

## C. X / Twitter（5 条 thread，钩子先行）

**Tweet 1/5:**

```
Just shipped: WebAZ — a commerce protocol where humans and AI agents trade on the same rails.

14 MCP tools. PWA backend. USDC escrow on Base. Live.

npx -y @seasonkoh/webaz
```

**Tweet 2/5:**

```
The piece I'm most curious about:

webaz_verify_price returns a session_token, locked 10 minutes.
webaz_place_order won't accept a price that drifted from the lock.

Closes the LLM-decides-then-submits race that's been quietly broken in every agent-shopping demo I've seen.
```

**Tweet 3/5:**

```
Products carry structured fields: brand, model, specs, return_days, handling_hours, warranty_days.

Search returns a one-line `agent_summary` so the buyer agent doesn't have to parse free-form descriptions.

Comparing 5 SKUs becomes a string compare.
```

**Tweet 4/5:**

```
Real escrow: each user gets a derived USDC deposit address. Funds in → wallet credit. Withdraw → hot wallet pays out. All on Base Sepolia testnet today, mainnet next.

Plus: seller link sovereignty via crowd verification codes. Two sellers can't both claim the same source URL.
```

**Tweet 5/5:**

```
Honest state: zero real users yet. This is the launch.

PWA → webaz.xyz
MCP Registry → io.github.seasonsagents-art/webaz
Repo → github.com/seasonsagents-art/webaz

Looking for the first 10 brave agents to break things.
```

---

## D. 小红书 / 微信 / 即刻（中文短帖）

```
做了个东西叫 WebAZ ——
一个让人类和 AI Agent 在同一协议上交易的小协议。

✨ 关键设计：
• 下单前 10 分钟锁价：webaz_verify_price 拿 token，下单时价格漂了就拒绝。AI 帮你买东西不会"决策时 99 元，下单时 199 元"
• 结构化商品 + agent_summary：品牌/型号/退货天数/发货时效写成一句话，Agent 不用读大段描述比价
• 真链上托管（USDC on Base testnet）：每个用户一个派生地址，充进去自动到账
• 链接主权认证：商家挂外链对标价格要过众包验证码核验，防止抢链

📦 安装一行：
`npx -y @seasonkoh/webaz`

PWA 试用：webaz.xyz
仓库：github.com/seasonsagents-art/webaz

诚实标记：真实用户目前为 0，这就是 launch。想找前 10 个愿意来踩坑的 agent 玩家 🙏
```

---

## E. 5 分钟 Demo 录屏脚本

```
[0:00–0:30]  HOOK
  屏幕：Claude Desktop 对话窗 + 终端分屏
  旁白："想让 Claude 帮你网购？现在的问题是 —— 它决策的价格和真正下单的价格，不一定是同一个。"
  画面：Claude 在浏览电商网站，价格 99 → 切换到下单页价格变 199
  字幕：That's the problem WebAZ solves.

[0:30–1:30]  AGENT BUYING FLOW（最有冲击力）
  旁白："给 Claude 这个指令 —— 帮我在 WebAZ 上买台清洁机，最好支持 7 天退货。"
  画面：Claude 调用 webaz_search → 出现德尔玛 BY100S，agent_summary 一行
  画面：Claude 调用 webaz_verify_price → 返回 session_token，价格 99 WAZ
  画面：Claude 调用 webaz_place_order 带 session_token → 下单成功
  关键 frame：高亮 `verified_price: 99` 和 `session_token: pst_xxx`
  字幕："Verify → lock → order. Three calls, no price drift."

[1:30–2:30]  SELLER SIDE（结构化字段威力）
  画面切换：另一台 Claude 实例，扮演"卖家 Agent"
  旁白："卖家也用 Claude。一行指令：上架我的清洁机，48h 发货，7 天无理由退货，1 年质保。"
  画面：调用 webaz_list_product，参数里 specs / brand / handling_hours / return_days / warranty_days 全填
  画面：买家端再次 search，agent_summary 自动拼出"德尔玛，BY100S，7天退货，1年质保，48h发货"
  字幕："Structured spec → one-line decision summary. No LLM-parsing-descriptions ceremony."

[2:30–3:30]  ON-CHAIN ESCROW
  画面切换：手机浏览器 webaz.xyz 钱包页
  旁白："钱包里点充值，得到一个 USDC 地址 —— Base Sepolia 上你自己的。"
  画面：复制地址 → 切到钱包 App（Rainbow / MetaMask）→ 发 1 USDC
  画面：30 秒后 PWA 钱包余额自动 +1
  画面：MCP 端 webaz_wallet 同步看到余额变化
  字幕："Real on-chain escrow. Testnet today, mainnet next."

[3:30–4:30]  LINK SOVEREIGNTY（独家差异化）
  旁白："如果你的商品对标淘宝某商品做'独家价'呢？两个卖家挂同一个链接怎么办？"
  画面：演示同一个 source_url 二次上架 → 系统返回 verify_task：你需要在原商品标题里放验证码 [ABCD-1234]
  画面：仲裁员 PWA 端看到任务 → 访问外链 → 看到/没看到验证码 → 投票
  画面：验证通过 → 商品状态从 warehouse 切回 active；卖家主权完成认定
  字幕："Crowd-verified source claims. No more dupes, no central arbiter."

[4:30–5:00]  OUTRO + CTA
  画面：终端打入 `npx -y @seasonkoh/webaz`
  旁白："14 个 MCP 工具，零依赖部署，testnet 上跑得起来。仓库链接见简介。"
  字幕：
    Try → npx -y @seasonkoh/webaz
    PWA → webaz.xyz
    Repo → github.com/seasonsagents-art/webaz
    MCP Registry → search "webaz"
```

**拍摄清单（建议提前准备）：**

1. 双 Claude Desktop 实例（一个买家，一个卖家），登录不同 webaz 账号
2. webaz 测试钱包预先充好 50 WAZ（avoid 卡在余额不足）
3. Base Sepolia 钱包提前要好 testnet USDC（faucet 或者预存）
4. 一个空白 source_url（淘宝/京东任意商品页）准备演示链接认领
5. 屏幕录制工具：建议用支持鼠标高亮 / zoom 的（QuickTime + Highlights / Screen Studio）
6. 旁白可以中英双轨录两份，按受众平台切；HN/Reddit 用英文，小红书/即刻用中文
