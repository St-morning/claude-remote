# Claude Remote

通过飞书远程审批 Claude Code 权限操作，并支持飞书双向聊天。

## 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    飞书 (Feishu)                         │
│                  消息 / 审批回复                          │
└──────────┬─────────────────────────────────┬────────────┘
           │ 发送通知                          │ 轮询消息
           ▼                                  ▼
┌─────────────────────────────────────────────────────────┐
│                  server.js (Express :24000)              │
│                                                         │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │ /permission   │  │ /api/delete   │  │ /api/chat    │ │
│  │ 权限审批       │  │ 删除审批       │  │ 消息桥接      │ │
│  └──────────────┘  └───────────────┘  └──────────────┘ │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │              飞书 API 集成                         │  │
│  │  - tenant_access_token                           │  │
│  │  - im/v1/messages (发送/轮询)                     │  │
│  └──────────────────────────────────────────────────┘  │
└──────────┬──────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│                  Claude Code Hooks                       │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ PreToolUse        │  │ Stop (asyncRewake)            │ │
│  │ check-delete.js   │  │ feishu-wake.js               │ │
│  │ 拦截删除命令       │  │ 轮询飞书消息                  │ │
│  │ → 飞书审批        │  │ → 自动唤醒 Claude             │ │
│  └──────────────────┘  └──────────────────────────────┘ │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ PermissionRequest (Bash|Write|Edit)                │  │
│  │ → 飞书审批 → 15s超时弹窗                           │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 功能

| 功能 | 描述 |
|------|------|
| 飞书删除审批 | PowerShell 删除命令 → 飞书审批 → 允许/拒绝/超时弹窗 |
| 飞书远程聊天 | 飞书发消息 → Claude Worker 轮询 → Claude 处理并回复 |
| 权限审批 | Bash/Write/Edit → 飞书通知 → Claude 对话框回退 |
| Web 管理面板 | `http://127.0.0.1:24000` SSE 实时查看待审批请求 |
| 内网穿透 | localtunnel 公网 URL + 飞书 Webhook 事件回调 |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置飞书应用

在 [飞书开放平台](https://open.feishu.cn) 创建企业自建应用：

1. 获取 `App ID` 和 `App Secret`，填入 `server.js` 的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`
2. 开通权限：`im:message`、`im:message:send_as_bot`
3. 发布应用并让用户添加到飞书

### 3. 启动服务

```bash
# 启动 Express 服务 (端口 24000)
npm start

# (可选) 启动内网穿透，获取公网 URL
npm run tunnel
```

### 4. 配置飞书 Webhook（可选，用于事件回调）

将 tunnel 输出的公网 URL + `/api/feishu/event` 填入飞书应用的事件订阅地址。

### 5. 配置 Claude Code Hooks

在 Claude Code 的 `.claude/settings.json` 中添加钩子配置，指向本项目脚本。

## 核心文件

| 文件 | 用途 |
|------|------|
| `server.js` | Express 服务器 + 飞书 API + 审批 + 聊天桥 |
| `claude-worker.js` | 后台轮询飞书消息队列，调用 Claude CLI 处理并回复 |
| `claude.bat` | 启动器：自动启动 server + worker，然后启动 Claude |
| `tunnel.js` | localtunnel 内网穿透，获取公网 URL |
| `check-delete.js` | PreToolUse 钩子，拦截 PowerShell 删除命令 → 飞书审批 |
| `feishu-chat-check.js` | UserPromptSubmit / PostToolUse 钩子，注入飞书消息到 Claude 上下文 |
| `feishu-wake.js` | Stop 钩子 (asyncRewake)，检测未读消息并自动唤醒 Claude |
| `heartbeat.js` | PostToolUse 钩子，向 server 发送心跳标记活动 |
| `state.json` | 飞书会话状态持久化（userOpenId、chatId 等） |
| `context.json` | Worker 对话历史上下文 |
| `public/index.html` | Web 管理面板（SSE 实时推送） |

## 审批流程

### 删除命令审批
```
PowerShell 删除命令
  → PreToolUse 钩子 (check-delete.js)
    → server /api/delete-check (28s 等待飞书回复)
      ├─ 飞书回复「允许」→ allow → 执行删除
      ├─ 飞书回复「拒绝」→ deny → 阻止删除
      └─ 超时 → ask → Claude 弹窗手动审批
```

### 普通权限审批
```
Bash / Write / Edit 命令
  → Claude 触发 PermissionRequest
    → server /permission 发送飞书通知
      ├─ 飞书 15s 内回复「允许」→ allow
      ├─ 飞书回复「拒绝」→ deny
      └─ 超时 → Claude 弹窗
```

### 飞书聊天唤醒
```
飞书发消息
  → server 轮询接收 → 存入 chatQueue
    → Stop 钩子 (feishu-wake.js) 检测未读消息
      → exit 2 → Claude 自动唤醒
    → 或 Worker (claude-worker.js) 轮询直接调用 Claude CLI
      → Claude 处理 → 通过 /api/chat/send 回复到飞书
```

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/` | GET | Web 管理面板 |
| `/ping` | GET | 健康检查，返回 `ok` |
| `/events` | GET | SSE 事件流，实时推送审批请求状态 |
| `/permission` | POST | Claude Code Hook 权限审批入口 |
| `/api/delete-check` | POST | 删除命令同步审批（等待飞书回复） |
| `/api/chat/unread` | GET | 原子获取未读消息（消费后清空） |
| `/api/chat` | GET | 获取消息队列（支持 `?idle=1` 空闲检测） |
| `/api/chat/send` | POST | 发送消息到飞书 |
| `/api/pending` | GET | 获取所有待审批请求 |
| `/api/history` | GET | 获取审批历史（最近 30 条） |
| `/api/status` | GET | 飞书配对状态 + 待审批数量 |
| `/api/approve/:id` | POST | Web UI 手动批准 |
| `/api/deny/:id` | POST | Web UI 手动拒绝 |
| `/api/feishu/event` | POST | 飞书事件回调 Webhook |

## 飞书交互指令

在飞书中发送以下消息进行操作：

| 指令 | 作用 |
|------|------|
| `允许` / `y` / `yes` / `allow` / `同意` | 批准当前待审批请求 |
| `拒绝` / `n` / `no` / `deny` / `否` | 拒绝当前待审批请求 |
| `始终允许` / `always` | 批准当前及所有后续请求 |
| `你好` / `hi` / `测试` | 连接测试，返回确认消息 |
| 其他任意文本 | 转发给 Claude 处理并回复 |

## 文件说明

- `chat.log` — 飞书消息日志，自动保留最近 5 分钟
- `state.json` — 会话状态，30 秒自动保存
- `context.json` — Worker 对话历史，最多保留 20 轮
- `.tunnel_url.txt` — 当前公网 tunnel URL
