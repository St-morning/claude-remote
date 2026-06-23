// PostToolUse hook: inject unread Feishu messages into Claude context
const fs = require('fs');

function readStdinSync() {
  try {
    const raw = fs.readFileSync(process.stdin.fd, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) { return null; }
}

async function main() {
  const res = await fetch('http://127.0.0.1:24000/api/chat/unread');
  const data = await res.json();
  const msgs = data.messages || [];
  if (msgs.length === 0) process.exit(0);

  // Concise injection: only the relevant message text
  const text = msgs.map(m => '飞书: ' + m.text).join('\n');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[飞书消息]\n${text}\n请回复，通过 POST http://127.0.0.1:24000/api/chat/send 发回`,
    },
  }));
  process.exit(0);
}

main();