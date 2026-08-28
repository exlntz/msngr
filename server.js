'use strict';
// Опал — мессенджер из жидкого стекла
// Сервер: Node.js, встроенный SQLite, WebSocket (ws). Без тяжёлых зависимостей.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const db = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.OPAL_DATA_DIR
  ? path.join(process.env.OPAL_DATA_DIR, 'uploads')
  : path.join(__dirname, 'uploads');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const MAX_UPLOAD = 60 * 1024 * 1024; // 60 МБ

for (const d of [UPLOAD_DIR, path.join(UPLOAD_DIR, 'files'), path.join(UPLOAD_DIR, 'avatars')]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ───────────────────────── утилиты ───────────────────────── */

const now = () => Date.now();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// лёгкий rate-limit для auth-эндпоинтов
const rateMap = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  let e = rateMap.get(key);
  if (!e || t > e.reset) { e = { count: 0, reset: t + windowMs }; rateMap.set(key, e); }
  e.count++;
  if (rateMap.size > 5000) {
    for (const [k, v] of rateMap) if (t > v.reset) rateMap.delete(k);
  }
  return e.count <= max;
}

/* ───────────────────────── сессии / юзеры ───────────────────────── */

function createSession(userId) {
  const token = makeToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now(), now() + SESSION_TTL);
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function authUser(req) {
  const cookies = parseCookies(req);
  return getUserByToken(cookies['opal_token']);
}

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || u.username,
    avatar_path: u.avatar_path,
    avatar_hue: u.avatar_hue,
    bio: u.bio,
    last_seen: u.last_seen,
    online: onlineUsers.has(u.id),
  };
}

/* ───────────────────────── presence / ws ───────────────────────── */

const onlineUsers = new Set();          // user_id → есть хотя бы одно живое соединение
const socketsByUser = new Map();        // user_id → Set<ws>
const lastSeenTouch = new Map();        // user_id → ts (throttle записи last_seen)

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendToUser(userId, obj) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

function touchLastSeen(userId) {
  const t = now();
  const last = lastSeenTouch.get(userId) || 0;
  if (t - last > 60_000) {
    lastSeenTouch.set(userId, t);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(t, userId);
  }
}

/* ───────────────────────── загрузка файлов ───────────────────────── */

const EXT_WHITELIST = new Set([
  'jpg','jpeg','png','webp','gif','avif','heic',
  'webm','mp4','m4a','mp3','ogg','wav','aac','opus',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','odt',
  'txt','md','csv','rtf','zip','rar','7z','tar','gz',
  'apk','exe','msi','dmg','iso','psd','ai','fig','sketch',
  'json','xml','yml','yaml','torrent','epub','fb2',
]);
const IMAGE_MIMES = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const AUDIO_MIMES = new Set(['audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav','audio/aac','audio/opus','video/webm']);

function sanitizeExt(name, mime) {
  let ext = '';
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  if (m) ext = m[1].toLowerCase();
  if (!EXT_WHITELIST.has(ext)) {
    // пробуем вывести из mime
    const map = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
      'audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg','audio/mpeg':'mp3','video/webm':'webm',
      'application/pdf':'pdf','application/zip':'zip','text/plain':'txt','video/mp4':'mp4' };
    ext = map[mime] || 'bin';
  }
  return ext;
}

function saveUpload(buf, originalName, mime, dirKind) {
  const ext = sanitizeExt(originalName, mime);
  const name = `${now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const sub = dirKind === 'avatar' ? 'avatars' : 'files';
  fs.writeFileSync(path.join(UPLOAD_DIR, sub, name), buf);
  return `/uploads/${sub}/${name}`;
}

/* ───────────────────────── чаты: хелперы ───────────────────────── */

function getPrivateChat(userA, userB) {
  const row = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
    JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
    WHERE c.type = 'private' LIMIT 1
  `).get(userA, userB);
  return row ? row.id : null;
}

function createPrivateChat(userA, userB) {
  const t = now();
  const info = db.prepare('INSERT INTO chats (type, created_at) VALUES (?,?)').run('private', t);
  const chatId = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)');
  ins.run(chatId, userA);
  ins.run(chatId, userB);
  return chatId;
}

function chatMemberIds(chatId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map(r => r.user_id);
}

function assertMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

function messageRow(id) {
  return db.prepare(`
    SELECT m.*, u.username AS sender_username, u.display_name AS sender_name,
           u.avatar_path AS sender_avatar, u.avatar_hue AS sender_hue
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id);
}

function decorateMessage(m) {
  if (!m) return null;
  let reply = null;
  if (m.reply_to_id) {
    const r = db.prepare(`
      SELECT m2.id, m2.kind, m2.text, m2.file_name, m2.sender_id, u.username, u.display_name
      FROM messages m2 JOIN users u ON u.id = m2.sender_id WHERE m2.id = ?
    `).get(m.reply_to_id);
    if (r) {
      reply = { id: r.id, sender_id: r.sender_id, sender_name: r.display_name || r.username,
        preview: r.kind === 'text' ? (r.text || '') :
                 r.kind === 'image' ? 'Фото' : r.kind === 'voice' ? 'Голосовое сообщение' :
                 (r.file_name || 'Файл') };
    }
  }
  return {
    id: m.id, chat_id: m.chat_id, sender_id: m.sender_id,
    sender_name: m.sender_name || m.sender_username,
    kind: m.kind, text: m.text || '',
    file_path: m.file_path, file_name: m.file_name, file_size: m.file_size,
    file_mime: m.file_mime, duration: m.duration,
    reply, created_at: m.created_at,
  };
}

/* ───────────────────────── HTTP-роуты ───────────────────────── */

async function handleAPI(req, res, pathname, url) {
  const ip = req.socket.remoteAddress || 'unknown';

  /* --- регистрация --- */
  if (req.method === 'POST' && pathname === '/api/register') {
    if (!rateLimit(`reg:${ip}`, 20, 60_000)) return sendJSON(res, 429, { error: 'Слишком много попыток, подожди минуту' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const display_name = String(body.display_name || '').trim().slice(0, 40);
    if (!USERNAME_RE.test(username)) {
      return sendJSON(res, 400, { error: 'Юзернейм: 3–20 символов, только a-z, 0-9 и _' });
    }
    if (password.length < 6) return sendJSON(res, 400, { error: 'Пароль минимум 6 символов' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return sendJSON(res, 409, { error: 'Этот юзернейм уже занят' });
    }
    const salt = makeSalt();
    const hash = hashPassword(password, salt);
    const hue = Math.floor(crypto.randomBytes(1)[0] / 255 * 360);
    const info = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, password_salt, avatar_hue, created_at, last_seen)
      VALUES (?,?,?,?,?,?,?)
    `).run(username, display_name || username, hash, salt, hue, now(), now());
    const userId = Number(info.lastInsertRowid);
    const token = createSession(userId);
    res.setHeader('Set-Cookie', `opal_token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return sendJSON(res, 201, { user: publicUser(u) });
  }

  /* --- вход --- */
  if (req.method === 'POST' && pathname === '/api/login') {
    if (!rateLimit(`login:${ip}`, 30, 60_000)) return sendJSON(res, 429, { error: 'Слишком много попыток, подожди минуту' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u) return sendJSON(res, 401, { error: 'Неверный юзернейм или пароль' });
    const hash = hashPassword(password, u.password_salt);
    if (!timingSafeEqualStr(hash, u.password_hash)) {
      return sendJSON(res, 401, { error: 'Неверный юзернейм или пароль' });
    }
    const token = createSession(u.id);
    res.setHeader('Set-Cookie', `opal_token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
    return sendJSON(res, 200, { user: publicUser(u) });
  }

  /* --- выход --- */
  if (req.method === 'POST' && pathname === '/api/logout') {
    const cookies = parseCookies(req);
    if (cookies['opal_token']) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies['opal_token']);
    res.setHeader('Set-Cookie', 'opal_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return sendJSON(res, 200, { ok: true });
  }

  /* --- дальнейшие роуты требуют авторизации --- */
  const me = authUser(req);
  if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
  touchLastSeen(me.id);

  if (req.method === 'GET' && pathname === '/api/me') {
    return sendJSON(res, 200, { user: publicUser(me) });
  }

  /* --- профиль: имя и био --- */
  if (req.method === 'POST' && pathname === '/api/profile') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const display_name = String(body.display_name ?? me.display_name).trim().slice(0, 40);
    const bio = String(body.bio ?? me.bio).trim().slice(0, 140);
    db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(display_name || me.username, bio, me.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
    broadcastProfile(u);
    return sendJSON(res, 200, { user: publicUser(u) });
  }

  /* --- аватарка --- */
  if (req.method === 'POST' && pathname === '/api/avatar') {
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) return sendJSON(res, 400, { error: 'Пустой файл' });
    const mime = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMAGE_MIMES.has(mime)) return sendJSON(res, 400, { error: 'Только изображения: JPG, PNG, WEBP, GIF' });
    const url2 = saveUpload(buf, 'avatar', mime, 'avatar');
    if (me.avatar_path) { try { fs.unlinkSync(path.join(__dirname, me.avatar_path)); } catch {} }
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(url2, me.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
    broadcastProfile(u);
    return sendJSON(res, 200, { user: publicUser(u) });
  }

  /* --- поиск людей --- */
  if (req.method === 'GET' && pathname === '/api/users') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    // LIKE в SQLite не приводит к нижнему регистру кириллицу, поэтому фильтруем в JS
    const rows = db.prepare(`SELECT * FROM users WHERE id != ? ORDER BY last_seen DESC LIMIT 300`).all(me.id)
      .filter(u =>
        !q ||
        u.username.toLowerCase().includes(q) ||
        (u.display_name || '').toLowerCase().includes(q)
      )
      .slice(0, 30);
    return sendJSON(res, 200, { users: rows.map(publicUser) });
  }

  /* --- список чатов --- */
  if (req.method === 'GET' && pathname === '/api/chats') {
    const chats = db.prepare(`
      SELECT c.id, c.created_at FROM chats c
      JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ?
    `).all(me.id);
    const out = [];
    for (const c of chats) {
      const peerRow = db.prepare(`
        SELECT u.* FROM chat_members m JOIN users u ON u.id = m.user_id
        WHERE m.chat_id = ? AND m.user_id != ?
      `).get(c.id, me.id);
      const last = db.prepare(`
        SELECT m.*, u.username AS sender_username, u.display_name AS sender_name,
               u.avatar_path AS sender_avatar, u.avatar_hue AS sender_hue
        FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1
      `).get(c.id);
      const mine = db.prepare('SELECT last_read_message_id FROM chat_members WHERE chat_id = ? AND user_id = ?').get(c.id, me.id);
      const unread = db.prepare(`
        SELECT COUNT(*) AS n FROM messages
        WHERE chat_id = ? AND id > ? AND sender_id != ?
      `).get(c.id, mine ? mine.last_read_message_id : 0, me.id).n;
      out.push({
        id: c.id,
        peer: publicUser(peerRow),
        last_message: decorateMessage(last),
        unread,
        updated_at: last ? last.created_at : c.created_at,
      });
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return sendJSON(res, 200, { chats: out });
  }

  /* --- создать/получить приватный чат --- */
  if (req.method === 'POST' && pathname === '/api/chats') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const peerId = Number(body.user_id);
    if (!peerId || peerId === me.id) return sendJSON(res, 400, { error: 'Некорректный пользователь' });
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(peerId)) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    let chatId = getPrivateChat(me.id, peerId);
    let created = false;
    if (!chatId) { chatId = createPrivateChat(me.id, peerId); created = true; }
    const peer = db.prepare('SELECT * FROM users WHERE id = ?').get(peerId);
    return sendJSON(res, created ? 201 : 200, { chat_id: chatId, peer: publicUser(peer) });
  }

  /* --- история сообщений --- */
  const mHist = /^\/api\/chats\/(\d+)\/messages$/.exec(pathname);
  if (req.method === 'GET' && mHist) {
    const chatId = Number(mHist[1]);
    if (!assertMember(chatId, me.id)) return sendJSON(res, 403, { error: 'Нет доступа' });
    const before = Number(url.searchParams.get('before')) || 0;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 100);
    const rows = before
      ? db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, before, limit)
      : db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
    const msgs = rows.reverse().map(r => decorateMessage(Object.assign(r, {
      sender_username: '', sender_name: '', sender_avatar: '', sender_hue: 0,
    })));
    // дозаполняем данные отправителей
    const userCache = new Map();
    for (const msg of msgs) {
      if (!userCache.has(msg.sender_id)) {
        userCache.set(msg.sender_id, db.prepare('SELECT * FROM users WHERE id = ?').get(msg.sender_id));
      }
      const su = userCache.get(msg.sender_id);
      msg.sender_name = su ? (su.display_name || su.username) : '';
    }
    return sendJSON(res, 200, { messages: msgs });
  }

  /* --- отправить сообщение --- */
  if (req.method === 'POST' && pathname === '/api/messages') {
    const body = JSON.parse((await readBody(req, MAX_UPLOAD)).toString('utf8') || '{}');
    const chatId = Number(body.chat_id);
    const kind = ['text', 'image', 'file', 'voice'].includes(body.kind) ? body.kind : 'text';
    if (!assertMember(chatId, me.id)) return sendJSON(res, 403, { error: 'Нет доступа' });

    let text = String(body.text || '').slice(0, 4000);
    let filePath = null, fileName = null, fileSize = null, fileMime = null, duration = null;

    if (kind !== 'text') {
      const f = body.file || {};
      filePath = String(f.url || '');
      if (!filePath.startsWith('/uploads/files/')) return sendJSON(res, 400, { error: 'Некорректный файл' });
      const abs = path.join(__dirname, filePath);
      if (!fs.existsSync(abs)) return sendJSON(res, 400, { error: 'Файл не найден, загрузи заново' });
      fileSize = fs.statSync(abs).size;
      fileName = String(f.name || 'file').slice(0, 190);
      fileMime = String(f.mime || 'application/octet-stream').slice(0, 100);
      if (kind === 'voice') duration = Math.max(0.1, Math.min(Number(f.duration) || 0, 3600));
      if (kind === 'image') fileMime = IMAGE_MIMES.has(fileMime) ? fileMime : 'image/jpeg';
    } else if (!text.trim()) {
      return sendJSON(res, 400, { error: 'Пустое сообщение' });
    }

    let replyTo = null;
    if (body.reply_to) {
      const r = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(Number(body.reply_to));
      if (r && r.chat_id === chatId) replyTo = r.id;
    }

    const t = now();
    const clientTag = String(body.client_tag || '').slice(0, 64);
    const info = db.prepare(`
      INSERT INTO messages (chat_id, sender_id, kind, text, file_path, file_name, file_size, file_mime, duration, reply_to_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(chatId, me.id, kind, text, filePath, fileName, fileSize, fileMime, duration, replyTo, t);
    const msgId = Number(info.lastInsertRowid);

    const msg = messageRow(msgId);
    const decorated = decorateMessage(msg);
    decorated.client_tag = clientTag;
    const members = chatMemberIds(chatId);
    for (const uid of members) sendToUser(uid, { type: 'message:new', message: decorated, chat_id: chatId });
    return sendJSON(res, 201, { message: decorated });
  }

  /* --- удаление своего сообщения --- */
  const mDel = /^\/api\/messages\/(\d+)$/.exec(pathname);
  if (req.method === 'DELETE' && mDel) {
    const id = Number(mDel[1]);
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!m) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (m.sender_id !== me.id) return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    if (m.file_path) { try { fs.unlinkSync(path.join(__dirname, m.file_path)); } catch {} }
    for (const uid of chatMemberIds(m.chat_id)) {
      sendToUser(uid, { type: 'message:delete', chat_id: m.chat_id, message_id: id });
    }
    return sendJSON(res, 200, { ok: true });
  }

  /* --- прочтение --- */
  const mRead = /^\/api\/chats\/(\d+)\/read$/.exec(pathname);  if (req.method === 'POST' && mRead) {
    const chatId = Number(mRead[1]);
    if (!assertMember(chatId, me.id)) return sendJSON(res, 403, { error: 'Нет доступа' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const lastId = Number(body.last_message_id) || 0;
    const cur = db.prepare('SELECT last_read_message_id FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, me.id);
    if (cur && lastId > cur.last_read_message_id) {
      db.prepare('UPDATE chat_members SET last_read_message_id = ? WHERE chat_id = ? AND user_id = ?').run(lastId, chatId, me.id);
      for (const uid of chatMemberIds(chatId)) {
        if (uid !== me.id) sendToUser(uid, { type: 'message:read', chat_id: chatId, user_id: me.id, last_read_message_id: lastId });
      }
    }
    return sendJSON(res, 200, { ok: true });
  }

  /* --- загрузка файла (raw body) --- */
  if (req.method === 'POST' && pathname === '/api/upload') {
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) return sendJSON(res, 400, { error: 'Пустой файл' });
    const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const originalName = Buffer.from(url.searchParams.get('name') || 'file', 'utf8').toString('utf8').slice(0, 190);
    // голосовые всегда в files
    const url2 = saveUpload(buf, originalName, mime, 'files');
    const kindHint = url.searchParams.get('kind');
    return sendJSON(res, 200, { url: url2, name: originalName, size: buf.length, mime,
      kind: kindHint === 'voice' ? 'voice' : mime && IMAGE_MIMES.has(mime) ? 'image' : 'file' });
  }

  return sendJSON(res, 404, { error: 'Не найдено' });
}

function broadcastProfile(u) {
  const pu = publicUser(u);
  // всем, у кого есть чат с этим юзером
  const rows = db.prepare(`
    SELECT DISTINCT m2.user_id FROM chat_members m1
    JOIN chat_members m2 ON m2.chat_id = m1.chat_id
    WHERE m1.user_id = ? AND m2.user_id != ?
  `).all(u.id, u.id);
  for (const r of rows) sendToUser(r.user_id, { type: 'profile:update', user: pu });
  sendToUser(u.id, { type: 'profile:update', user: pu });
}

/* ───────────────────────── статика ───────────────────────── */

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, absPath, cache) {
  const ext = path.extname(absPath).toLowerCase();
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(absPath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache || 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(absPath).pipe(res);
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const rel = path.normalize(pathname).replace(/^([/\\]\.\.[/\\])+/, '');
    const abs = path.join(__dirname, rel);
    if (!abs.startsWith(UPLOAD_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(abs).toLowerCase();
    // потенциально опасные форматы отдаём на скачивание
    if (['.html', '.htm', '.svg', '.xml'].includes(ext)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(abs).pipe(res);
    }
    return serveFile(res, abs, 'public, max-age=31536000, immutable');
  }
  let p = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, path.normalize(p));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return serveFile(res, abs, abs.endsWith('.html') || abs.endsWith('.css') || abs.endsWith('.js') ? 'no-cache' : 'public, max-age=86400');
  }
  // SPA fallback
  return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
}

/* ───────────────────────── HTTP-сервер ───────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      await handleAPI(req, res, pathname, url);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    console.error('[error]', pathname, err.message);
    if (!res.headersSent) sendJSON(res, err.message === 'payload too large' ? 413 : 500, { error: 'Ошибка сервера' });
  }
});

/* ───────────────────────── WebSocket ───────────────────────── */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const cookies = parseCookies(req);
  const user = getUserByToken(cookies['opal_token']);
  if (!user) { ws.close(4001, 'unauthorized'); return; }

  ws.userId = user.id;
  if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
  const first = socketsByUser.get(user.id).size === 0;
  socketsByUser.get(user.id).add(ws);

  if (first) {
    onlineUsers.add(user.id);
    touchLastSeen(user.id);
    broadcastPresence(user.id, true);
  }
  wsSend(ws, { type: 'hello', user_id: user.id });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === 'typing' && data.chat_id && assertMember(Number(data.chat_id), user.id)) {
      for (const uid of chatMemberIds(Number(data.chat_id))) {
        if (uid !== user.id) sendToUser(uid, { type: 'typing', chat_id: Number(data.chat_id), user_id: user.id });
      }
    } else if (data.type === 'ping') {
      touchLastSeen(user.id);
      wsSend(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    const set = socketsByUser.get(user.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        socketsByUser.delete(user.id);
        onlineUsers.delete(user.id);
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
        broadcastPresence(user.id, false);
      }
    }
  });
  ws.on('error', () => {});
});

function broadcastPresence(userId, online) {
  const rows = db.prepare(`
    SELECT DISTINCT m2.user_id FROM chat_members m1
    JOIN chat_members m2 ON m2.chat_id = m1.chat_id
    WHERE m1.user_id = ? AND m2.user_id != ?
  `).all(userId, userId);
  for (const r of rows) sendToUser(r.user_id, { type: 'presence', user_id: userId, online, last_seen: now() });
}

/* ───────────────────────── старт ───────────────────────── */

server.listen(PORT, HOST, () => {
  console.log(`\n  ◆ Опал запущен:  http://localhost:${PORT}\n`);
});
