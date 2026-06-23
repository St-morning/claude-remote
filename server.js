const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { networkInterfaces } = require('os');

const app = express();
const PORT = 24000;

// ── Feishu config ────────────────────────────────────────────────────
const FEISHU_APP_ID = 'cli_aab820b96c78dbd6';
const FEISHU_APP_SECRET = 'pdx4z4w7iKKsG3pHQeUWMblchvLZISQ7';
const FEISHU_API = 'https://open.feishu.cn/open-apis';
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE = path.join(__dirname, 'chat.log');

function chatLog(entry) {
  const t = new Date(new Date().getTime() + 8 * 3600000).toISOString().replace('T',' ').slice(0,19);
  const line = `[${t} CST] ${entry}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}
// Auto-clean log every 10 min: keep last 5 min
setInterval(() => {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const cutoff = Date.now() - 300000;
    const recent = lines.filter(l => {
      const idx = l.indexOf('] ');
      return idx > 0 && new Date(l.slice(1, idx)).getTime() > cutoff;
    });
    if (recent.length < lines.length) fs.writeFileSync(LOG_FILE, recent.join('\n') + '\n');
  } catch (_) {}
}, 600000);

let feishuToken = null;
let feishuTokenExpiry = 0;
let userOpenId = null;
let lastCheckedMsgId = null;  // for polling new messages
let feishuChatId = null;
let pollTimer = null;

// Load persisted state
try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  userOpenId = s.userOpenId;
  lastCheckedMsgId = s.lastCheckedMsgId;
  feishuChatId = s.feishuChatId;
} catch (_) { /* first run */ }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ userOpenId, lastCheckedMsgId, feishuChatId })); } catch(e) { console.error("SaveState:", e.message); } }
// Periodic state save every 30s (in case of force kill)
setInterval(saveState, 30000);
// Graceful shutdown
process.on('SIGTERM', () => { saveState(); process.exit(); });
process.on('SIGINT', () => { saveState(); process.exit(); });

// Hardcode known values from successful test
if (!userOpenId) { userOpenId = 'ou_1f3e008bacc691ebaf00b2d00d8bdd09'; }
if (!feishuChatId) { feishuChatId = 'oc_42d219c6722b627a27d1a10ef77d48e5'; }
saveState();

app.use(express.json());
app.get('/ping', (_req, res) => res.send('ok'));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── State ────────────────────────────────────────────────────────────
const pending = new Map();       // id → { id, data, timer, resolve, feishuMsgId }
const deleteRequests = new Map(); // id → { id, file_paths, command, timestamp }
const chatQueue = [];            // { text, timestamp } — messages from Feishu to Claude
let lastActivity = Date.now();
const processedMsgIds = new Set(); // dedupe poll messages  // track user activity for idle detection
const sseClients = new Set();
const history = [];

// ── Helpers ──────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = networkInterfaces();
  const preferred = [], others = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const lower = name.toLowerCase();
        if (lower.includes('wlan') || lower.includes('wi-fi') || lower.includes('wireless') ||
            (lower.includes('以太网') && !lower.includes('2')) || lower === 'ethernet')
          preferred.push(net.address);
        else if (!lower.includes('vmware') && !lower.includes('hyper-v') &&
                 !lower.includes('virtual') && !lower.includes('vethernet') &&
                 !lower.includes('本地连接*'))
          others.push(net.address);
      }
    }
  }
  return [...preferred, ...others][0] || '127.0.0.1';
}

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (_) { sseClients.delete(client); }
  }
}

function summarize(input) {
  if (!input) return 'No details';
  if (input.command) return input.command.slice(0, 300);
  if (input.description) return input.description.slice(0, 300);
  const str = JSON.stringify(input);
  return str.length > 300 ? str.slice(0, 300) + '…' : str;
}

// ── Feishu: get tenant access token ──────────────────────────────────
async function getFeishuToken() {
  if (feishuToken && Date.now() < feishuTokenExpiry - 30_000) return feishuToken;
  const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu auth: ${data.msg}`);
  feishuToken = data.tenant_access_token;
  feishuTokenExpiry = Date.now() + (data.expire || 7200) * 1000;
  return feishuToken;
}

// ── Feishu: send text message ────────────────────────────────────────
async function sendFeishuText(text) {
  if (!userOpenId) { console.log('⚠ No user open_id yet'); return null; }
  const token = await getFeishuToken();
  const res = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: userOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) { console.log(`⚠ Feishu send: ${data.msg}`); return null; }
  return data.data?.message_id;
}

// ── Feishu: poll for new messages (by chat_id) ────────────────────────
async function pollFeishuMessages() {
  if (!userOpenId) return;
  try {
    const token = await getFeishuToken();

    // If we have a chat_id, poll that chat; otherwise try to find it
    if (feishuChatId) {
      const url = `${FEISHU_API}/im/v1/messages?container_id_type=chat&container_id=${feishuChatId}&page_size=10&sort_type=ByCreateTimeDesc`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code !== 0) return;
      const items = data.data?.items || [];
      if (items.length === 0) return;

      let newUserLastId = lastCheckedMsgId;
      let foundNew = false;

      for (const msg of items) {
        const senderType = msg.sender?.id_type || msg.sender?.sender_type || '';
        if (senderType !== 'user' && senderType !== 'open_id') continue;
        if (processedMsgIds.has(msg.message_id)) continue;
        processedMsgIds.add(msg.message_id);
        if (processedMsgIds.size > 300) { const arr=[...processedMsgIds]; processedMsgIds.clear(); arr.slice(-150).forEach(id=>processedMsgIds.add(id)); }

        foundNew = true;
        if (!newUserLastId || msg.message_id > newUserLastId) newUserLastId = msg.message_id;
        const msgTime = parseInt(msg.create_time) || 0; // milliseconds
        const content = JSON.parse(msg.body?.content || '{}');
        const replyText = (content.text || '').trim();
        console.log(`💬 User: "${replyText}"`);

        if (replyText === 'hello' || replyText === 'hi' || replyText === '你好' || replyText === '测试') {
          await sendFeishuText('✅ 已连接！当 Claude Code 需要权限时，发消息到这里。回复「允许」或「拒绝」即可审批。');
        } else if (replyText.includes('允许') || replyText.includes('拒绝') || replyText === 'y' || replyText === 'n' || replyText === 'yes' || replyText === 'no') {
          handleUserReply(replyText, msgTime);
        } else {
          // General chat message → queue for Claude
          const dupes = chatQueue.filter(m => m.text === replyText).length; if (dupes === 0) { chatQueue.push({ text: replyText, timestamp: Date.now() }); }
          while (chatQueue.length > 100) chatQueue.shift();
          chatLog(`FROM FEISHU: ${replyText}`);
          console.log(`💬 Chat queued: "${replyText}"`);
        }
      }

      if (foundNew) {
        lastCheckedMsgId = newUserLastId;
        saveState();
      }
    } else {
      // Try to find the chat from the chat list
      const chatRes = await fetch(`${FEISHU_API}/im/v1/chats?page_size=10&sort_type=ByActiveTimeDesc`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const chatData = await chatRes.json();
      if (chatData.code === 0 && chatData.data?.items?.length > 0) {
        feishuChatId = chatData.data.items[0].chat_id;
        console.log(`💬 Found chat: ${feishuChatId}`);
        // Also save the sender as userOpenId from chat members
        const members = chatData.data.items[0].members || [];
        for (const m of members) {
          if (m.member_id_type === 'open_id' && m.member_id !== 'unknown') {
            userOpenId = m.member_id;
            console.log(`👤 User open_id: ${userOpenId.slice(0, 12)}...`);
            break;
          }
        }
        saveState();
        await sendFeishuText('✅ 已连接！当 Claude Code 需要权限时，会发消息到这里。回复「允许」或「拒绝」即可审批。');
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message || err);
  }
}

function handleUserReply(text, msgTime) {
  const lower = text.toLowerCase().replace(/\s+/g, '');
  const isAllow = lower.includes('允许') || lower === 'y' || lower === 'yes' || lower === 'allow' || lower === '1' || lower === '同意' || lower === 'ok';
  const isDeny = lower.includes('拒绝') || lower === 'n' || lower === 'no' || lower === 'deny' || lower === '2' || lower === '否';
  const isAlways = lower.includes('始终') || lower.includes('永久') || lower === 'always' || lower === '3';

  if (!isAllow && !isDeny && !isAlways) {
    sendFeishuText('请回复「允许」或「拒绝」（或「始终允许」）。');
    return;
  }

  // 1. Check delete requests first
  let bestDel = null;
  for (const [id, rec] of deleteRequests) {
    if (msgTime > rec.timestamp && (!bestDel || rec.timestamp > bestDel.rec.timestamp)) {
      bestDel = { id, rec };
    }
  }

  if (bestDel) {
    const decision = isAllow ? 'allow' : 'deny';
    console.log(`🗑️ [${bestDel.id.slice(0, 8)}] Delete ${decision.toUpperCase()} (via Feishu)`);
    if (bestDel.rec.resolve) {
      bestDel.rec.resolve({ decision });
    } else {
      // Legacy: no resolver (from /api/delete), do deletion directly
      if (isAllow) {
        const { file_paths } = bestDel.rec;
        for (const fp of file_paths) {
          try { fs.unlinkSync(fp); } catch (e) {}
        }
      }
    }
    deleteRequests.delete(bestDel.id);
    return;
  }

  // 2. Check regular permission requests
  if (pending.size === 0) {
    sendFeishuText('当前没有待审批的请求。');
    return;
  }

  let best = null;
  for (const [id, rec] of pending) {
    if (msgTime > rec.timestamp && (!best || rec.timestamp > best.rec.timestamp)) {
      best = { id, rec };
    }
  }

  if (best) {
    const decision = isDeny ? 'deny' : 'allow';
    console.log(`${decision === 'allow' ? '✅' : '❌'} [${best.id.slice(0, 8)}] ${decision.toUpperCase()} (via Feishu)`);
    best.rec.resolve({ decision });
    if (isAlways) {
      for (const [id, rec] of pending) {
        if (msgTime > rec.timestamp) {
          console.log(`✅ [${id.slice(0, 8)}] ALLOW (via Feishu 始终允许)`);
          rec.resolve({ decision: 'allow' });
        }
      }
    }
    return;
  }

  sendFeishuText('当前没有待审批的请求。');
}

// ── Start polling ────────────────────────────────────────────────────
function startFeishuPoll() {
  // Try to discover user open_id if not known
  const discoverInterval = userOpenId ? 5000 : 8000;
  pollTimer = setInterval(pollFeishuMessages, discoverInterval);
  console.log('🔄 Feishu poll started');
}

// ── SSE stream ───────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':\n\n');
  sseClients.add(res);
  const snapshot = [];
  for (const [id, r] of pending) {
    snapshot.push({
      id,
      tool_name: r.data.tool_name || '?',
      summary: summarize(r.data.tool_input || r.data.arguments),
      timestamp: r.timestamp,
    });
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ── Claude Code hook entry ───────────────────────────────────────────
app.post('/permission', (req, res) => {
  const id = crypto.randomUUID();
  const data = req.body || {};

  const toolName = data.tool_name || 'Unknown Tool';
  const toolInput = data.tool_input || data.arguments || {};
  const description = summarize(toolInput);

  console.log(`\n📋 [${id.slice(0, 8)}] ${toolName}`);
  console.log(`   ${description}`);

  const timer = setTimeout(() => {
    console.log(`⏰ [${id.slice(0, 8)}] Timeout → server cleanup (Claude dialog appears at 120s hook timeout)`);
    const rec = pending.get(id);
    if (rec) {
      rec.resolve({ decision: 'deny', reason: 'timeout' });
      pending.delete(id);
      history.unshift({ id, tool_name: toolName, decision: 'deny', ts: Date.now() });
      if (history.length > 50) history.length = 50;
      broadcastSSE('resolved', { id, decision: 'deny', reason: 'timeout' });
      sendFeishuText(`⏰ 请求 [${id.slice(0, 8)}] 服务器超时清理`);
    }
  }, 590_000);

  let resolver;
  const promise = new Promise((resolve) => { resolver = resolve; });

  pending.set(id, {
    id,
    data: { ...data, tool_name: toolName, tool_input: toolInput },
    timestamp: Date.now(),
    timer,
    resolve: resolver,
  });

  broadcastSSE('new_request', {
    id,
    tool_name: toolName,
    summary: description,
    timestamp: Date.now(),
    pending_count: pending.size,
  });

  // Send Feishu notification
  const requestLabel = id.slice(0, 8);
  const msg = `🤖 **Claude Code 权限请求** [${requestLabel}]\n\n📌 工具: ${toolName}\n📝 ${description}\n\n⬇️ 请回复以下任一选项:\n• **允许** — 批准本次执行\n• **拒绝** — 拒绝本次执行\n• **始终允许** — 批准并记住\n\n⏱ 15 秒无响应将弹出 Claude 对话框`;
  sendFeishuText(msg);

  promise.then((result) => {
    clearTimeout(timer);
    pending.delete(id);
    history.unshift({ id, tool_name: toolName, decision: result.decision, ts: Date.now() });
    if (history.length > 50) history.length = 50;
    broadcastSSE('resolved', { id, decision: result.decision });
    res.json({ decision: result.decision });
  });
});

// ── REST API (web UI fallback) ───────────────────────────────────────
app.post('/api/approve/:id', (req, res) => {
  const rec = pending.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  rec.resolve({ decision: 'allow' });
  res.json({ ok: true });
});

app.post('/api/deny/:id', (req, res) => {
  const rec = pending.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  rec.resolve({ decision: 'deny' });
  res.json({ ok: true });
});

app.post('/api/always/:id', (req, res) => {
  const rec = pending.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  rec.resolve({ decision: 'allow' });
  res.json({ ok: true });
});

// ── Delete check (sync wait for Feishu, with timeout) ─────────────────
app.post('/api/delete-check', async (req, res) => {
  const { tool_name, command, file_paths } = req.body || {};

  const id = crypto.randomUUID();
  let resolver;
  const promise = new Promise(r => { resolver = r; });

  const paths = file_paths || [];
  deleteRequests.set(id, {
    id, file_paths: paths, command: command || '', timestamp: Date.now(), resolve: resolver,
  });

  const label = paths.length > 0 ? paths.map(p => `• ${p}`).join('\n') : command.slice(0, 200);
  sendFeishuText(`🗑️ **删除请求** [${id.slice(0, 8)}]\n\n${label}\n\n⬇️ 15秒内回复「允许」或「拒绝」`);

  const timer = setTimeout(() => {
    if (deleteRequests.has(id)) {
      deleteRequests.delete(id);
      sendFeishuText(`⏰ 审批超时 [${id.slice(0, 8)}]\n请在 Claude Code 弹出的对话框中审批`);
      resolver({ decision: 'timeout' });
    }
  }, 30000);

  const result = await promise;
  clearTimeout(timer);

  if (result.decision === 'allow') {
    // Delete files server-side too (belt-and-suspenders)
    for (const fp of paths) {
      try { fs.unlinkSync(fp); } catch (_) {}
    }
  }

  res.json({ decision: result.decision });
});
app.get('/api/pending', (_req, res) => {
  const list = [];
  for (const [id, r] of pending) {
    list.push({ id, tool_name: r.data.tool_name || '?', summary: summarize(r.data.tool_input || {}), timestamp: r.timestamp });
  }
  res.json(list);
});

app.get('/api/history', (_req, res) => res.json(history.slice(0, 30)));

// ── Status endpoint ──────────────────────────────────────────────────

// Feishu webhook event callback
app.post('/api/feishu/event', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.type === 'url_verification' || body.challenge) return res.json({ challenge: body.challenge });
    const event = body.event || {};
    const msg = event.message || {};
    const sender = event.sender || {};
    // Skip bot's own messages
    if (msg.msg_type === 'text' && sender.sender_id?.open_id && sender.sender_id.open_id !== userOpenId) {
      const content = JSON.parse(msg.content || '{}');
      const text = (content.text || '').trim();
      if (text) {
        const dupes = chatQueue.filter(m => m.text === text).length;
        if (dupes === 0) {
          chatQueue.push({ text, timestamp: Date.now() });
          chatLog('FROM FEISHU: ' + text);
          console.log('Chat queued (webhook): "' + text + '"');
        }
      }
    }
    res.json({ ok: true });
  } catch (_) { res.json({ ok: true }); }
});

app.get('/api/status', (_req, res) => {
  res.json({
    feishu: { paired: !!userOpenId, userId: userOpenId ? userOpenId.slice(0, 12) + '...' : null },
    pending: pending.size,
    server: 'running',
  });
});

// ── Delete request (server-side execution after Feishu approval) ──────
app.post('/api/delete', (req, res) => {
  const { tool_name, command, file_paths } = req.body || {};
  if (!file_paths || file_paths.length === 0) {
    return res.json({ ok: false, reason: 'no file paths' });
  }

  const id = crypto.randomUUID();
  deleteRequests.set(id, {
    id,
    file_paths,
    command: command || '',
    timestamp: Date.now(),
  });

  const pathList = file_paths.map(p => `• ${p}`).join('\n');
  sendFeishuText(`🗑️ **删除请求** [${id.slice(0, 8)}]\n\n📁 文件:\n${pathList}\n\n⬇️ 回复「允许」执行删除，「拒绝」取消`);

  console.log(`🗑️ [${id.slice(0, 8)}] Delete request: ${file_paths.length} file(s)`);
  res.json({ ok: true, id });
});

// ── Chat bridge: Feishu ↔ Claude ────────────────────────────────────

// Check chat.log for new messages since last read
let lastLogMtime = 0;
app.get('/api/chat/fresh', (req, res) => {
  try {
    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    const mtime = stat ? stat.mtimeMs : 0;
    if (mtime <= lastLogMtime) return res.json({ messages: [], fresh: false });
    lastLogMtime = mtime;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const msgs = [], seen = new Set();
    for (let i = lines.length - 1; i >= 0 && msgs.length < 5; i--) {
      const idx = lines[i].indexOf('FROM FEISHU: ');
      if (idx > 0) {
        const text = lines[i].slice(idx + 13);
        if (!seen.has(text)) { seen.add(text); msgs.unshift({ text, timestamp: Date.now() }); }
      }
    }
    res.json({ messages: msgs, fresh: true });
  } catch (_) { res.json({ messages: [], fresh: false }); }
});


// Atomic unread fetch for hooks
app.get('/api/chat/unread', (_req, res) => {
  const msgs = chatQueue.splice(0, 10);
  res.json({ messages: msgs, count: msgs.length });
});

app.get('/api/chat', (req, res) => {
  // If idle=1, only return messages after 5 min of no local activity
  if (req.query.idle === '1') {
    const idleSec = (Date.now() - lastActivity) / 1000;
    if (idleSec < 60) return res.json({ messages: [], idle_seconds: Math.floor(idleSec) });
  }
  const limit = parseInt(req.query.limit) || 10;
  const msgs = chatQueue.splice(0, limit);
  res.json({ messages: msgs, idle_seconds: Math.floor((Date.now() - lastActivity) / 1000) });
});

app.post('/api/chat/send', (req, res) => {
  const text = (req.body || {}).text || '';
  if (!text) return res.json({ ok: false, reason: 'empty' });
  sendFeishuText(text);
  res.json({ ok: true });
});

app.post('/api/heartbeat', (_req, res) => {
  lastActivity = Date.now();
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   📱  Claude Code Remote + Feishu 飞书      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:   http://127.0.0.1:${PORT}        ║`);
  console.log(`║  Network: http://${localIP}:${PORT}     ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Status:  http://127.0.0.1:24000/api/status ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  startFeishuPoll();

  if (userOpenId)
    console.log('✅ 飞书已配对，等待权限请求...\n');
  else
    console.log('📱 在飞书中搜索你的 Bot 应用，发送任意消息来配对。\n');
});
