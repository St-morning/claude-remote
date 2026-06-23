// Claude Worker: polls Feishu chat queue, runs Claude in print mode, sends replies back
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = 'http://127.0.0.1:24000';
const POLL_INTERVAL = 3000;
const CONTEXT_FILE = path.join(__dirname, 'context.json');
const MAX_CONTEXT = 20;
const CLAUDE_TIMEOUT = 300000; // 5 min

let processing = false;

// ── Context persistence ─────────────────────────────────────────────────
let context = [];
try { context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); } catch (_) {}

function saveContext() {
  if (context.length > MAX_CONTEXT) context = context.slice(-MAX_CONTEXT);
  try { fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2)); } catch (_) {}
}

// ── HTTP helpers ────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Claude path ─────────────────────────────────────────────────────────
function getClaudePath() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\' + (process.env.USERNAME || 'default'), 'AppData', 'Roaming');
  return path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
}

// ── Main poll loop ──────────────────────────────────────────────────────
async function pollMessages() {
  if (processing) return;
  try {
    const data = await httpGet(`${SERVER}/api/chat/unread`);
    const msgs = data.messages || [];
    if (msgs.length === 0) return;

    processing = true;

    // Build prompt
    const newTexts = msgs.map(m => m.text);
    const combined = newTexts.join('\n---\n');

    let prompt = '';
    if (context.length > 0) {
      prompt += '[对话历史 - 飞书远程会话]\n';
      for (const entry of context) {
        prompt += `用户(飞书): ${entry.user}\n`;
        prompt += `Claude: ${entry.claude}\n\n`;
      }
    }
    prompt += `[新消息 - 来自飞书]\n${combined}\n\n`;
    prompt += '请简洁回复。回复直接发送到飞书，用纯文本。需要操作文件或执行命令就直接做。';

    // Track context
    context.push({ user: combined, claude: '(处理中...)' });
    saveContext();

    const log = (msg) => console.log(`[Worker ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    log(`Processing: "${combined.slice(0, 80)}${combined.length > 80 ? '...' : ''}"`);

    // Run Claude
    const claudePath = getClaudePath();
    const startTime = Date.now();

    execFile(claudePath, ['-p', prompt], {
      timeout: CLAUDE_TIMEOUT,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, async (err, stdout, stderr) => {
      processing = false;

      if (err) {
        const errorMsg = err.killed
          ? '⏰ Claude 处理超时 (5分钟)，请简化问题重试'
          : `❌ Claude 出错: ${err.message.slice(0, 200)}`;
        log(errorMsg);
        await httpPost(`${SERVER}/api/chat/send`, { text: errorMsg }).catch(() => {});
        context[context.length - 1].claude = errorMsg;
        saveContext();
        return;
      }

      const response = (stdout || '').trim() || '(无输出)';
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Done in ${elapsed}s: "${response.slice(0, 100)}${response.length > 100 ? '...' : ''}"`);

      // Send to Feishu (split long messages)
      const maxLen = 4000;
      const chunks = [];
      for (let i = 0; i < response.length; i += maxLen) {
        chunks.push(response.slice(i, i + maxLen));
      }
      for (const chunk of chunks) {
        await httpPost(`${SERVER}/api/chat/send`, { text: chunk }).catch(() => {});
      }

      // Update context
      context[context.length - 1].claude = response;
      saveContext();
    });

  } catch (err) {
    processing = false;
    console.error('[Worker] Poll error:', err.message);
  }
}

// ── Start ───────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║   🤖 Claude Worker - 飞书远程唤醒       ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  Poll interval: ${POLL_INTERVAL / 1000}s                    ║`);
console.log(`║  Claude path:   ${getClaudePath().slice(0, 35)}... ║`);
console.log(`║  Context:       ${CONTEXT_FILE.slice(0, 35)}... ║`);
console.log('╚══════════════════════════════════════════╝');

setInterval(pollMessages, POLL_INTERVAL);
pollMessages();
