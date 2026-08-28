'use strict';
// Тестовый WS-клиент: звонит указанному юзеру и ждёт ответа (для проверки UI входящего)
const WS = require('ws');
const token = process.argv[2];
const to = Number(process.argv[3]);
const action = process.argv[4] || 'invite';

const ws = new WS('ws://localhost:3000/ws?token=' + token);
const callId = 'test' + Date.now().toString(36);

ws.on('open', () => {
  if (action === 'invite') {
    // минимальный валидный SDP-заглушка — UI покажет модалку до accept
    ws.send(JSON.stringify({ type: 'call', action: 'invite', to, call_id: callId, data: { sdp: { type: 'offer', sdp: 'v=0\r\n' } } }));
    console.log('invite sent, call_id:', callId);
  }
});

ws.on('message', (raw) => {
  const d = JSON.parse(raw.toString());
  if (d.type === 'call') console.log('signal:', d.action, d.call_id);
});

setTimeout(() => { console.log('done'); process.exit(0); }, Number(process.argv[5]) || 12000);
