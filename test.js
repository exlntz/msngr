'use strict';
// Интеграционный тест: два юзера, чат, WS-доставка, загрузки, прочтение
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 200) : ''); }
}

function cookieOf(res) {
  const set = res.headers.get('set-cookie') || '';
  return set.split(';')[0];
}

async function req(path, opts = {}, cookie) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

const j = (b) => JSON.stringify(b);

(async () => {
  console.log('— аутентификация —');
  const r1 = await req('/api/register', { method: 'POST', body: j({ username: 'test_' + Date.now() % 100000, password: 'pw123456', display_name: 'Тест А' }) });
  ok('регистрация A', r1.res.status === 201 && r1.data.user.id > 0);
  const cA = cookieOf(r1.res);

  // дубликат только что созданного юзернейма
  const dup = await req('/api/register', { method: 'POST', body: j({ username: r1.data.user.username, password: 'xxxxxx' }) });
  ok('дубликат юзернейма отклонён', dup.res.status === 409, dup.data);

  const badLogin = await req('/api/login', { method: 'POST', body: j({ username: r1.data.user.username, password: 'wrong!' }) });
  ok('неверный пароль отклонён', badLogin.res.status === 401);

  const l1 = await req('/api/login', { method: 'POST', body: j({ username: r1.data.user.username, password: 'pw123456' }) });
  ok('логин A', l1.res.status === 200);
  const cA2 = cookieOf(l1.res);

  const r2 = await req('/api/register', { method: 'POST', body: j({ username: 'test2_' + Date.now() % 100000, password: 'pw123456', display_name: 'Тест Б' }) });
  ok('регистрация B', r2.res.status === 201);
  const cB = cookieOf(r2.res);

  console.log('— профиль и аватар —');
  const av = await req('/api/avatar', { method: 'POST', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), headers: { 'Content-Type': 'image/png' } }, cA);
  ok('аватар загружен', av.res.status === 200 && av.data.user.avatar_path && av.data.user.avatar_path.startsWith('/uploads/avatars/'), av.data);
  const avBad = await req('/api/avatar', { method: 'POST', body: 'text', headers: { 'Content-Type': 'text/plain' } }, cA);
  ok('не-изображение на аватар отклонено', avBad.res.status === 400);

  console.log('— поиск и чаты —');
  const s = await req('/api/users?q=' + encodeURIComponent(r2.data.user.username.slice(0, 4)), {}, cA);
  ok('поиск находит B', s.res.status === 200 && s.data.users.some(u => u.id === r2.data.user.id));

  const ch = await req('/api/chats', { method: 'POST', body: j({ user_id: r2.data.user.id }) }, cA);
  ok('чат создан', ch.res.status === 201 && ch.data.chat_id > 0);
  const ch2 = await req('/api/chats', { method: 'POST', body: j({ user_id: r2.data.user.id }) }, cA);
  ok('повторный вызов возвращает тот же чат', ch2.data.chat_id === ch.data.chat_id);
  const chatId = ch.data.chat_id;

  console.log('— сообщения —');
  const m1 = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'text', text: 'Привет, это тест! 🔥', client_tag: 'tag1' }) }, cA);
  ok('текст отправлен', m1.res.status === 201 && m1.data.message.text.includes('тест'));
  ok('client_tag эхом вернулся', m1.data.message.client_tag === 'tag1');

  const foreign = await req('/api/messages', { method: 'POST', body: j({ chat_id: 99999, kind: 'text', text: 'x' }) }, cA);
  ok('чужой чат отклонён', foreign.res.status === 403 || foreign.res.status === 400);

  // upload + файловое сообщение
  const fdata = Buffer.from('hello opal file content'.repeat(10));
  const up = await req('/api/upload?name=' + encodeURIComponent('документ тест.txt'), { method: 'POST', body: fdata, headers: { 'Content-Type': 'application/octet-stream' } }, cB);
  ok('файл загружен', up.res.status === 200 && up.data.url.startsWith('/uploads/files/'), up.data);
  ok('kind=file для текстового файла', up.data.kind === 'file');
  const m2 = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'file', file: { url: up.data.url, name: up.data.name, size: up.data.size, mime: up.data.mime } }) }, cB);
  ok('файловое сообщение отправлено', m2.res.status === 201 && m2.data.message.file_name.includes('документ'));

  // файл с опасным расширением
  const upBad = await req('/api/upload?name=evil.html', { method: 'POST', body: Buffer.from('<script>'), headers: { 'Content-Type': 'text/html' } }, cA);
  ok('опасное расширение санитизировано', upBad.res.status === 200 && !upBad.data.url.endsWith('.html'), upBad.data);

  // голосовое
  const upV = await req('/api/upload?name=voice.webm&kind=voice', { method: 'POST', body: Buffer.alloc(100, 1), headers: { 'Content-Type': 'audio/webm' } }, cA);
  const m3 = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'voice', file: { url: upV.data.url, name: upV.data.name, mime: 'audio/webm', duration: 5.2 } }) }, cA);
  ok('голосовое отправлено', m3.res.status === 201 && m3.data.message.duration === 5.2);

  // ответ (reply)
  const m4 = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'text', text: 'ответ на файл', reply_to: m2.data.message.id }) }, cA);
  ok('ответ с цитатой', m4.res.status === 201 && m4.data.message.reply && m4.data.message.reply.id === m2.data.message.id);

  // подделка file_path
  const mBad = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'image', file: { url: '/uploads/avatars/../../server.js' } }) }, cA);
  ok('path traversal отклонён', mBad.res.status === 400);

  console.log('— история и прочтение —');
  const hist = await req(`/api/chats/${chatId}/messages?limit=10`, {}, cB);
  ok('история у B', hist.res.status === 200 && hist.data.messages.length === 4, hist.data.messages && hist.data.messages.length);
  const histA = await req(`/api/chats/${chatId}/messages?limit=2`, {}, cA);
  ok('пагинация limit работает', histA.data.messages.length === 2);

  const chatsB = await req('/api/chats', {}, cB);
  const chatB = chatsB.data.chats.find(c => c.id === chatId);
  ok('у B непрочитано 3 (A прислал 3)', chatB && chatB.unread === 3, chatB && chatB.unread);

  const rd = await req(`/api/chats/${chatId}/read`, { method: 'POST', body: j({ last_message_id: m4.data.message.id }) }, cB);
  ok('B прочитал', rd.res.status === 200);
  const chatsB2 = await req('/api/chats', {}, cB);
  ok('непрочитанное обнулилось', chatsB2.data.chats.find(c => c.id === chatId).unread === 0);

  console.log('— удаление —');
  const delForeign = await req(`/api/messages/${m1.data.message.id}`, { method: 'DELETE' }, cB);
  ok('чужое удалить нельзя', delForeign.res.status === 403);
  const del = await req(`/api/messages/${m4.data.message.id}`, { method: 'DELETE' }, cA);
  ok('своё удаляется', del.res.status === 200);

  console.log('— WebSocket —');
  const wsUser = r1.data.user, wsPeer = r2.data.user;
  const WS = (await import('ws')).default;
  const wA = new WS('ws://localhost:3000/ws', { headers: { Cookie: cA } });
  const wB = new WS('ws://localhost:3000/ws', { headers: { Cookie: cB } });
  const gotA = [], gotB = [];
  wA.on('message', d => gotA.push(JSON.parse(d)));
  wB.on('message', d => gotB.push(JSON.parse(d)));
  await new Promise(r => { wA.on('open', r); wB.on('open', r); });
  await new Promise(r => setTimeout(r, 300));

  const sent = await req('/api/messages', { method: 'POST', body: j({ chat_id: chatId, kind: 'text', text: ' realtime push ', client_tag: 'rt1' }) }, cA);
  await new Promise(r => setTimeout(r, 400));
  ok('A получил эхо по WS', gotA.some(d => d.type === 'message:new' && d.message.text === ' realtime push '));
  ok('B получил сообщение по WS', gotB.some(d => d.type === 'message:new' && d.message.text === ' realtime push '));

  wB.send(JSON.stringify({ type: 'typing', chat_id: chatId }));
  await new Promise(r => setTimeout(r, 300));
  ok('A увидел "печатает"', gotA.some(d => d.type === 'typing' && d.chat_id === chatId));

  wB.send(JSON.stringify({ type: 'ping' }));
  await new Promise(r => setTimeout(r, 200));
  ok('pong пришёл', gotB.some(d => d.type === 'pong'));

  // presence: у A онлайн должен быть виден B
  const chatsA = await req('/api/chats', {}, cA);
  ok('B отображается онлайн для A', chatsA.data.chats.find(c => c.id === chatId).peer.online === true);

  // неавторизованный ws
  const wBad = new WS('ws://localhost:3000/ws');
  const badClosed = await new Promise(r => { wBad.on('close', (code) => r(code === 4001)); wBad.on('error', () => {}); });
  ok('WS без куки отклонён (4001)', badClosed);

  wA.close(); wB.close();

  console.log('— статика —');
  const idx = await fetch(BASE + '/');
  ok('index.html отдаётся', idx.status === 200 && (await idx.text()).includes('Опал'));
  const css = await fetch(BASE + '/styles.css');
  ok('styles.css отдаётся', css.status === 200);
  const spa = await fetch(BASE + '/какой-то/путь');
  ok('SPA fallback', spa.status === 200 && (await spa.text()).includes('Опал'));

  console.log(`\n═══ ИТОГ: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
