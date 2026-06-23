// PreToolUse hook: Feishu (8s) → Claude dialog fallback
const fs = require('fs');

function log(...args) {
  process.stderr.write(`[CD] ${args.join(' ')}\n`);
}

const PS_DELETE = /(?:^|[;&|({\s])\s*(Remove-Item|rmdir|rm|del|rd|ri)\s/i;

async function main() {
  // Read stdin (same approach as proven-working test_ask.js)
  let payload = null;
  try {
    const raw = fs.readFileSync(process.stdin.fd, 'utf8');
    payload = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) {}

  if (!payload) { process.exit(0); }

  const toolName = payload.tool_name || '';
  const command = (payload.tool_input && payload.tool_input.command) || '';

  // Only handle PowerShell delete commands
  if (toolName !== 'PowerShell' || !PS_DELETE.test(String(command))) {
    process.exit(0);
  }

  log('DELETE DETECTED, trying Feishu...');

  // Try Feishu (8s — hook has 20s, plenty of margin)
  try {
    const res = await fetch('http://127.0.0.1:24000/api/delete-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, command }),
      signal: AbortSignal.timeout(28000),
    });
    const result = await res.json();

    if (result.decision === 'allow') {
      log('Feishu: ALLOW');
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: '飞书已批准删除',
        },
      }));
      process.exit(0);
    }
    if (result.decision === 'deny') {
      log('Feishu: DENY');
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '飞书已拒绝删除',
        },
      }));
      process.exit(0);
    }
  } catch (e) {
    log('Feishu error/timeout:', e.message);
  }

  // Fallback: Claude dialog
  log('FALLBACK: ask dialog');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: '飞书未响应，请在对话框中审批',
    },
  }));
  process.exit(0);
}

main();
