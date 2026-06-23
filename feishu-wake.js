// Stop hook with asyncRewake: checks Feishu queue, wakes Claude if messages pending
const http = require('http');

function checkMessages() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:24000/api/chat/unread', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.messages || []);
        } catch (_) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function main() {
  const msgs = await checkMessages();
  if (msgs.length === 0) process.exit(0);

  const text = msgs.map(m => '飞书: ' + m.text).join('\n');
  console.log(JSON.stringify({
    systemMessage: `收到 ${msgs.length} 条飞书消息`,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `[飞书消息 - 请立即处理并回复]\n${text}\n通过 POST http://127.0.0.1:24000/api/chat/send 回复`,
    },
  }));
  // exit 2 = re-wake Claude
  process.exit(2);
}

main();