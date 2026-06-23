// PostToolUse hook: signal activity to server
const http = require('http');
http.get('http://127.0.0.1:24000/api/heartbeat', () => {}).on('error', () => {});
