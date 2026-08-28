'use strict';
/* ═══════════════════════════════════════════════════════════
   ОПАЛ — клиент
   realtime на WebSocket, оптимистичная отправка, голосовые
   ═══════════════════════════════════════════════════════════ */

/* ───────── мини-хелперы ───────── */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts), t = new Date();
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const diff = (t0 - d0) / 86400000;
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  const s = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return d.getFullYear() !== t.getFullYear() ? s + ' ' + d.getFullYear() : s;
}
function fmtLastSeen(u) {
  if (!u) return '';
  if (u.online) return 'в сети';
  if (!u.last_seen) return 'давно не был(а)';
  const diff = Date.now() - u.last_seen;
  if (diff < 60_000) return 'был(а) только что';
  const d = new Date(u.last_seen), t = new Date();
  const sameDay = d.toDateString() === t.toDateString();
  if (sameDay) return 'был(а) в ' + fmtTime(u.last_seen);
  const yest = new Date(t); yest.setDate(t.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'был(а) вчера';
  return 'был(а) ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' МБ';
  return (b / 1073741824).toFixed(2) + ' ГБ';
}
function fmtDur(s) {
  s = Math.round(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function msgPreview(m, fromMe) {
  if (!m) return 'Сообщений пока нет';
  const prefix = fromMe ? 'Ты: ' : '';
  if (m.kind === 'image') return prefix + '📷 Фото';
  if (m.kind === 'voice') return prefix + '🎤 Голосовое сообщение';
  if (m.kind === 'file') return prefix + '📎 ' + (m.file_name || 'Файл');
  return prefix + (m.text || '');
}
function linkify(parent, text) {
  // безопасно: текст как текст, ссылки как <a>
  const re = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = el('a', '', m[0]);
    a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function avatarNode(user, size) {
  const n = el('span', `avatar av-${size}`);
  if (user && user.avatar_path) {
    const img = el('img');
    img.src = user.avatar_path;
    img.alt = '';
    n.appendChild(img);
    if (user.online !== undefined) n.appendChild(onlineDot(user.online));
  } else {
    const hue = user ? (user.avatar_hue || 200) : 200;
    const name = user ? (user.display_name || user.username || '?') : '?';
    n.style.background = `linear-gradient(140deg, hsl(${hue} 72% 66%), hsl(${(hue + 55) % 360} 78% 48%))`;
    n.textContent = name.trim().charAt(0).toUpperCase() || '?';
    if (user && user.online !== undefined) n.appendChild(onlineDot(user.online));
  }
  return n;
}
function onlineDot(on) {
  const d = el('span', 'online-dot');
  if (!on) d.style.display = 'none';
  d.dataset.on = on ? '1' : '0';
  return d;
}
function setDot(dot, on) {
  if (!dot) return;
  dot.style.display = on ? '' : 'none';
  dot.dataset.on = on ? '1' : '0';
}

const hueCache = new Map();
function authorHue(userId, fallbackHue) {
  if (!hueCache.has(userId)) hueCache.set(userId, fallbackHue != null ? fallbackHue : (userId * 47) % 360);
  return hueCache.get(userId);
}

/* ───────── тосты + звук ───────── */

function toast(text, isError) {
  const t = el('div', 'toast' + (isError ? ' error' : ''), text);
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 350);
  }, 3200);
}

let audioCtx = null;
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}
// разблокируем звук первым жестом пользователя (требование браузеров)
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, () => ensureAudio(), { once: true, capture: true }));

function blip(freqA, freqB, dur, vol, delay = 0) {
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freqA, t);
  o.frequency.exponentialRampToValueAtTime(freqB, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.08);
}
// отправка: короткий восходящий «вжик»
function soundSend() {
  blip(620, 940, 0.09, 0.05);
  blip(940, 1250, 0.07, 0.035, 0.07);
}
// получение: мягкий нисходящий «поп»
function soundRecv() {
  blip(520, 300, 0.16, 0.055);
}

/* ───────── API ───────── */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
  return data;
}

/* ───────── состояние ───────── */

const state = {
  me: null,
  chats: new Map(),        // chat_id → {id, peer, last_message, unread, updated_at}
  activeChat: null,        // id
  messages: new Map(),     // chat_id → [{...}]
  peerRead: new Map(),     // chat_id → last_read_message_id собеседника
  online: new Set(),
  ws: null,
  wsReady: false,
  replyTo: null,
  pendingFile: null,       // {file, kind:'image'|'file', previewUrl}
  pending: new Map(),      // client_tag → временный элемент сообщения
  typingTimers: new Map(), // chat_id → timeout
  lastTypingSent: 0,
  searchQ: '',
  sending: false,
};

/* ═══════════ ЭКРАН ВХОДА ═══════════ */

const authScreen = $('authScreen');
const authForm = $('authForm');
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('authSubmitText').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('authSwitchText').textContent = mode === 'login' ? 'Впервые здесь?' : 'Уже есть аккаунт?';
  $('authModeBtn').textContent = mode === 'login' ? 'Создать аккаунт' : 'Войти';
  $('nameField').hidden = mode === 'login';
  $('authError').hidden = true;
  $('authUsername').autocomplete = mode === 'login' ? 'username' : 'username';
}

$('authModeBtn').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('eyeBtn').onclick = () => {
  const p = $('authPassword');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('eyeBtn').classList.toggle('eye-open', show);
};

authForm.onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('authSubmit');
  const username = $('authUsername').value.trim().toLowerCase();
  const password = $('authPassword').value;
  const err = $('authError');

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    err.textContent = 'Юзернейм: 3–20 символов, только латиница, цифры и _';
    err.hidden = false;
    return;
  }
  if (password.length < 6) {
    err.textContent = 'Пароль минимум 6 символов';
    err.hidden = false;
    return;
  }

  btn.disabled = true;
  try {
    const body = { username, password };
    if (authMode === 'register') body.display_name = $('authName').value.trim();
    const data = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST', body,
    });
    enterApp(data.user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    err.style.animation = 'none'; void err.offsetWidth; err.style.animation = '';
  } finally {
    btn.disabled = false;
  }
};

/* ═══════════ ВХОД В ПРИЛОЖЕНИЕ ═══════════ */

async function enterApp(user) {
  state.me = user;
  authScreen.style.display = 'none';
  $('app').hidden = false;
  renderMe();
  await loadChats();
  connectWS();
  setInterval(pingWS, 25000);
}

function renderMe() {
  const av = avatarNode(state.me, 32);
  const old = $('meAvatar');
  old.replaceWith(av);
  av.id = 'meAvatar';
  $('meName').textContent = state.me.display_name || state.me.username;
  $('meUsername').textContent = '@' + state.me.username;
}

$('meChip').onclick = () => openProfile();

/* ═══════════ WEBSOCKET ═══════════ */

function connectWS() {
  if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => { state.wsReady = true; };

  ws.onclose = () => {
    state.wsReady = false;
    setTimeout(connectWS, 2500);
  };

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleWS(data);
  };
}

function pingWS() {
  if (state.ws && state.wsReady) state.ws.send(JSON.stringify({ type: 'ping' }));
}

function handleWS(d) {
  switch (d.type) {
    case 'message:new': onNewMessage(d); break;
    case 'message:read': {
      if (d.chat_id) {
        const cur = state.peerRead.get(d.chat_id) || 0;
        if (d.last_read_message_id > cur) {
          state.peerRead.set(d.chat_id, d.last_read_message_id);
          if (d.chat_id === state.activeChat) renderTicks();
        }
      }
      break;
    }
    case 'typing': onTyping(d); break;
    case 'presence': {
      if (d.online) state.online.add(d.user_id); else state.online.delete(d.user_id);
      refreshPresenceUI(d.user_id);
      break;
    }
    case 'profile:update': onProfileUpdate(d.user); break;
    case 'message:delete': onMessageDelete(d); break;
    case 'call': if (window.__handleCallSignal) window.__handleCallSignal(d); break;
  }
}

function findChatByPeer(userId) {
  for (const [id, c] of state.chats) if (c.peer && c.peer.id === userId) return id;
  return null;
}

function refreshPresenceUI(userId) {
  // сайдбар
  const chatId = findChatByPeer(userId);
  if (chatId) {
    const c = state.chats.get(chatId);
    if (c && c.peer) { c.peer.online = state.online.has(userId); renderChatItem(c); }
  }
  // шапка активного чата
  if (state.activeChat && state.chats.get(state.activeChat)?.peer?.id === userId) {
    const c = state.chats.get(state.activeChat);
    c.peer.online = state.online.has(userId);
    renderPeerStatus();
  }
  // модалка друга
  if (!$('peerOverlay').hidden && peerModalUser && peerModalUser.id === userId) {
    peerModalUser.online = state.online.has(userId);
    $('peerBigStatus').textContent = fmtLastSeen(peerModalUser);
    $('peerBigStatus').classList.toggle('online', !!peerModalUser.online);
  }
}

function onProfileUpdate(u) {
  if (state.me && u.id === state.me.id) {
    state.me = { ...state.me, ...u };
    renderMe();
    return;
  }
  const chatId = findChatByPeer(u.id);
  if (chatId) {
    const c = state.chats.get(chatId);
    if (c) {
      c.peer = { ...c.peer, ...u };
      renderChatItem(c);
      if (state.activeChat === chatId) { renderPeerHeader(); renderMessages(); }
    }
  }
  if (!$('peerOverlay').hidden && peerModalUser && peerModalUser.id === u.id) {
    peerModalUser = u;
    renderPeerModal(u);
  }
}

function onTyping(d) {
  if (!state.activeChat || d.chat_id !== state.activeChat || d.user_id === state.me.id) {
    // если печатает не в активном чате — подсветим в сайдбаре
    if (d.user_id !== state.me.id) {
      const cid = d.chat_id;
      const c = state.chats.get(cid);
      if (c) {
        c._typing = true;
        renderChatItem(c);
        clearTimeout(state.typingTimers.get('side' + cid));
        state.typingTimers.set('side' + cid, setTimeout(() => { c._typing = false; renderChatItem(c); }, 3000));
      }
    }
    return;
  }
  renderPeerStatus(true);
  clearTimeout(state.typingTimers.get('head'));
  state.typingTimers.set('head', setTimeout(() => renderPeerStatus(), 2800));
}

/* ═══════════ ЧАТЫ (сайдбар) ═══════════ */

async function loadChats() {
  const data = await api('/api/chats');
  state.chats.clear();
  for (const c of data.chats) {
    if (c.peer && c.peer.online) state.online.add(c.peer.id);
    state.chats.set(c.id, c);
  }
  renderChatList();
}

function sortChats() {
  return [...state.chats.values()].sort((a, b) => b.updated_at - a.updated_at);
}

function renderChatList() {
  const list = $('chatList');
  list.textContent = '';
  const q = state.searchQ.trim().toLowerCase();

  if (q) { renderSearchResults(list, q); return; }

  const chats = sortChats();
  if (!chats.length) {
    list.appendChild(el('div', 'empty-hint', 'Пока пусто.\nНайди друга по юзернейму ↑'));
    return;
  }
  let idx = 0;
  for (const c of chats) {
    const item = chatItemNode(c);
    item.style.animationDelay = Math.min(idx++ * 40, 320) + 'ms';
    list.appendChild(item);
  }
}

function chatItemNode(c, animate = true) {
  const item = el('button', 'chat-item' + (state.activeChat === c.id ? ' active' : ''));
  item.dataset.chatId = c.id;
  if (!animate) item.style.animation = 'none';

  const av = avatarNode(c.peer, 48);

  const main = el('div', 'chat-item-main');
  const top = el('div', 'chat-item-top');
  const name = el('span', 'chat-item-name', c.peer ? c.peer.display_name : '…');
  const time = el('span', 'chat-item-time', c.last_message ? fmtTime(c.last_message.created_at) : '');
  top.append(name, time);

  const bottom = el('div', 'chat-item-bottom');
  const preview = el('span', 'chat-item-preview');
  if (c._typing) {
    const dots = el('span', 'typing-dots');
    dots.append(el('i'), el('i'), el('i'));
    const t = el('span', '', 'печатает…');
    t.style.color = 'var(--accent)';
    preview.append(dots, t);
  } else {
    const lm = c.last_message;
    const mine = lm && lm.sender_id === state.me.id;
    if (mine) preview.appendChild(el('span', 'pv-you', 'Ты: '));
    const txt = el('span', '', lm ? (
      lm.kind === 'image' ? '📷 Фото' :
      lm.kind === 'voice' ? '🎤 Голосовое' :
      lm.kind === 'file' ? '📎 ' + (lm.file_name || 'Файл') :
      lm.text || ''
    ) : 'Сообщений пока нет');
    preview.appendChild(txt);
  }
  bottom.appendChild(preview);
  if (c.unread > 0 && state.activeChat !== c.id) {
    bottom.appendChild(el('span', 'unread-badge', c.unread > 99 ? '99+' : String(c.unread)));
  }
  main.append(top, bottom);
  item.append(av, main);
  item.onclick = () => openChat(c.id);
  return item;
}

function renderChatItem(c) {
  const list = $('chatList');
  const old = list.querySelector(`.chat-item[data-chat-id="${c.id}"]`);
  if (old && !state.searchQ) old.replaceWith(chatItemNode(c, false));
}

/* поиск людей */
let searchDebounce = null;
$('searchInput').addEventListener('input', () => {
  state.searchQ = $('searchInput').value;
  $('searchClear').hidden = !state.searchQ;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderChatList(), 220);
});
$('searchClear').onclick = () => {
  $('searchInput').value = '';
  state.searchQ = '';
  $('searchClear').hidden = true;
  renderChatList();
  $('searchInput').focus();
};

async function renderSearchResults(list, q) {
  const head = el('div', 'side-label', 'Люди');
  list.appendChild(head);
  const holder = el('div');
  list.appendChild(holder);
  try {
    const data = await api('/api/users?q=' + encodeURIComponent(q));
    if (!data.users.length) {
      holder.appendChild(el('div', 'empty-hint', 'Никого не нашлось.\nПозови друга — пусть регистрируется!'));
      return;
    }
    let idx = 0;
    for (const u of data.users) {
      const item = el('button', 'chat-item');
      item.style.animationDelay = Math.min(idx++ * 35, 300) + 'ms';
      const main = el('div', 'chat-item-main');
      const top = el('div', 'chat-item-top');
      top.appendChild(el('span', 'chat-item-name', u.display_name));
      main.appendChild(top);
      const bottom = el('div', 'chat-item-bottom');
      bottom.appendChild(el('span', 'chat-item-preview', '@' + u.username + (u.online ? '  •  в сети' : '')));
      main.appendChild(bottom);
      item.append(avatarNode(u, 48), main);
      item.onclick = () => startChatWith(u);
      holder.appendChild(item);
    }
  } catch (ex) {
    holder.appendChild(el('div', 'empty-hint', 'Поиск недоступен: ' + ex.message));
  }
}

async function startChatWith(u) {
  try {
    const data = await api('/api/chats', { method: 'POST', body: { user_id: u.id } });
    if (!state.chats.has(data.chat_id)) {
      state.chats.set(data.chat_id, { id: data.chat_id, peer: data.peer, last_message: null, unread: 0, updated_at: Date.now() });
    } else {
      const c = state.chats.get(data.chat_id);
      c.peer = data.peer;
    }
    state.searchQ = '';
    $('searchInput').value = '';
    $('searchClear').hidden = true;
    renderChatList();
    await openChat(data.chat_id);
  } catch (ex) {
    toast(ex.message, true);
  }
}

/* ═══════════ ОКНО ЧАТА ═══════════ */

const messagesScroll = $('messagesScroll');
const messagesList = $('messagesList');
let loadingHistory = false;
let allLoaded = new Set(); // chat_id → всё загружено

async function openChat(chatId) {
  state.activeChat = chatId;
  state.replyTo = null;
  renderReplyBar();
  $('chatEmpty').hidden = true;
  $('chatWindow').hidden = false;
  $('app').classList.add('chat-open');
  $('scrollDownBtn').hidden = true;

  const c = state.chats.get(chatId);
  if (c) { c.unread = 0; renderChatItem(c); updateTitle(); }

  renderPeerHeader();
  messagesList.textContent = '';
  if (!state.messages.has(chatId)) {
    state.messages.set(chatId, []);
    await loadHistory(chatId);
  } else {
    renderMessages();
  }
  scrollToBottom(false);

  markRead();
  if (window.innerWidth <= 880) $('msgInput').blur();
}

function closeChat() {
  state.activeChat = null;
  $('app').classList.remove('chat-open');
  $('chatWindow').hidden = true;
  $('chatEmpty').hidden = false;
}
$('backBtn').onclick = closeChat;

function renderPeerHeader() {
  const c = state.chats.get(state.activeChat);
  if (!c) return;
  const old = $('peerAvatar');
  const av = avatarNode(c.peer, 40);
  av.id = 'peerAvatar';
  old.replaceWith(av);
  $('peerName').textContent = c.peer.display_name;
  renderPeerStatus();
  $('peerBrief').onclick = () => openPeerModal(c.peer);
}

function renderPeerStatus(typing) {
  const c = state.chats.get(state.activeChat);
  if (!c) return;
  const s = $('peerStatus');
  if (typing) {
    s.textContent = 'печатает…';
    s.className = 'peer-status typing';
  } else {
    s.textContent = fmtLastSeen(c.peer);
    s.className = 'peer-status' + (c.peer.online ? ' online' : '');
  }
}

async function loadHistory(chatId) {
  if (loadingHistory) return;
  loadingHistory = true;
  try {
    const msgs = state.messages.get(chatId) || [];
    const before = msgs.length ? msgs[0].id : 0;
    const data = await api(`/api/chats/${chatId}/messages?limit=60${before ? '&before=' + before : ''}`);
    if (!data.messages.length) allLoaded.add(chatId);
    const existing = state.messages.get(chatId);
    const ids = new Set(existing.map(m => m.id));
    const fresh = data.messages.filter(m => !ids.has(m.id));
    state.messages.set(chatId, [...fresh, ...existing]);
    if (state.activeChat === chatId) {
      renderMessages();
      if (before) scrollToBottom(true);
    }
  } catch (ex) {
    toast('Не удалось загрузить историю', true);
  } finally {
    loadingHistory = false;
  }
}

messagesScroll.addEventListener('scroll', async () => {
  const nearTop = messagesScroll.scrollTop < 260;
  const nearBottom = messagesScroll.scrollHeight - messagesScroll.scrollTop - messagesScroll.clientHeight < 120;
  $('jumpDown').hidden = nearBottom || !messagesList.children.length;
  if (nearBottom && state.activeChat) {
    $('jumpBadge').hidden = true;
  }
  if (nearTop && state.activeChat && !loadingHistory && !allLoaded.has(state.activeChat)) {
    const beforeH = messagesScroll.scrollHeight;
    await loadHistory(state.activeChat);
    // держим позицию
    requestAnimationFrame(() => {
      messagesScroll.scrollTop = messagesScroll.scrollHeight - beforeH;
    });
  }
});

$('jumpDown').onclick = () => scrollToBottom();

function scrollToBottom(instant) {
  messagesScroll.scrollTo({ top: messagesScroll.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

function nearBottom() {
  return messagesScroll.scrollHeight - messagesScroll.scrollTop - messagesScroll.clientHeight < 130;
}

/* ───────── рендер сообщений ───────── */

function renderMessages() {
  const chatId = state.activeChat;
  const msgs = state.messages.get(chatId) || [];
  messagesList.textContent = '';

  let prevDay = null, prevSender = null, prevTs = 0;
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== prevDay) {
      messagesList.appendChild(el('div', 'day-sep', day));
      prevDay = day;
      prevSender = null;
    }
    const grouped = prevSender === m.sender_id && (m.created_at - prevTs) < 5 * 60_000;
    messagesList.appendChild(messageNode(m, grouped));
    prevSender = m.sender_id;
    prevTs = m.created_at;
  }
  renderTicks();
}

function messageNode(m, grouped) {
  const mine = m.sender_id === state.me.id;
  const row = el('div', `msg-row ${mine ? 'out' : 'in'}${grouped ? ' grouped' : ''}`);
  row.dataset.id = m.id;
  if (m.client_tag && state.pending.has(m.client_tag)) {
    row.dataset.pending = m.client_tag;
    row.classList.add('sending');
  }

  const chat = state.chats.get(m.chat_id);
  if (!mine) {
    const av = el('span', 'msg-avatar');
    if (!grouped) {
      const u = chat ? chat.peer : m;
      const a = avatarNode({ display_name: m.sender_name, avatar_path: u.avatar_path, avatar_hue: u.avatar_hue }, 32);
      av.appendChild(a);
    }
    row.appendChild(av);
  }

  const bubble = el('div', 'msg-bubble');

  // автор в группировке первого сообщения
  if (!mine && !grouped) {
    bubble.appendChild(el('div', 'msg-author', m.sender_name));
    bubble.firstChild.style.setProperty('--h', authorHue(m.sender_id, chat?.peer?.avatar_hue));
  }

  // цитата
  if (m.reply) {
    const q = el('div', 'msg-quote');
    q.appendChild(el('div', 'msg-quote-name', m.reply.sender_name));
    q.appendChild(el('div', 'msg-quote-preview', m.reply.preview || ' '));
    q.onclick = () => jumpToMessage(m.reply.id);
    bubble.appendChild(q);
  }

  if (m.kind === 'text' || (m.kind !== 'text' && m.text)) {
    const t = el('div', 'msg-text');
    linkify(t, m.text);
    bubble.appendChild(t);
  }

  if (m.kind === 'image' && m.file_path) {
    bubble.classList.add('has-image');
    const img = el('img', 'msg-image');
    img.src = m.file_path;
    img.alt = m.file_name || 'Фото';
    img.loading = 'lazy';
    img.onclick = () => openLightbox(m.file_path);
    bubble.appendChild(img);
  }

  if (m.kind === 'file' && m.file_path) {
    const a = el('a', 'msg-file');
    a.href = m.file_path;
    a.download = m.file_name || 'file';
    const ic = el('span', 'file-ic');
    ic.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M13 3v6h6"/></svg>';
    const meta = el('span');
    meta.appendChild(el('div', 'file-name', m.file_name || 'Файл'));
    meta.appendChild(el('div', 'file-size', fmtSize(m.file_size)));
    a.append(ic, meta);
    bubble.appendChild(a);
  }

  if (m.kind === 'voice' && m.file_path) {
    bubble.appendChild(voiceNode(m, mine));
  }

  // мета: время + тики
  const meta = el('div', 'msg-meta' + (m.kind === 'image' ? ' in-image-pad' : ''));
  if (m.client_tag && state.pending.has(m.client_tag)) {
    meta.appendChild(el('span', 'spin'));
  } else {
    meta.appendChild(el('span', '', fmtTime(m.created_at)));
    if (mine) {
      const read = m.id <= (state.peerRead.get(m.chat_id) || 0);
      const tick = el('span', 'tick-wrap');
      tick.innerHTML = `<svg viewBox="0 0 24 24" class="ic tick${read ? ' read' : ''}">${read
        ? '<path d="M2.5 12.5 6 16l8.5-8.5"/><path d="M9 15.5 10.5 17 20 7.5"/>'
        : '<path d="M4 12.5 8 16.5l12-11"/>'}</svg>`;
      meta.appendChild(tick.firstChild);
    }
  }
  bubble.appendChild(meta);

  // действие: ответить
  const act = el('div', 'msg-act');
  const replyBtn = el('button');
  replyBtn.title = 'Ответить';
  replyBtn.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M9.5 7 4 12l5.5 5"/><path d="M4 12h9a7 7 0 0 1 7 7v1"/></svg>';
  replyBtn.onclick = (e) => { e.stopPropagation(); setReply(m); };
  act.appendChild(replyBtn);
  if (mine) {
    const delBtn = el('button');
    delBtn.title = 'Удалить';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteMessage(m); };
    act.appendChild(delBtn);
  }
  row.appendChild(bubble);
  row.appendChild(act);
  return row;
}

function renderTicks() {
  const chatId = state.activeChat;
  const readUpTo = state.peerRead.get(chatId) || 0;
  for (const row of messagesList.querySelectorAll('.msg-row.out')) {
    const id = Number(row.dataset.id);
    const tick = row.querySelector('.tick');
    if (!tick || row.dataset.pending) continue;
    const isRead = id <= readUpTo;
    const want = isRead
      ? '<path d="M2.5 12.5 6 16l8.5-8.5"/><path d="M9 15.5 10.5 17 20 7.5"/>'
      : '<path d="M4 12.5 8 16.5l12-11"/>';
    if (tick.innerHTML !== want) tick.innerHTML = want;
    tick.classList.toggle('read', isRead);
  }
}

function jumpToMessage(id) {
  const row = messagesList.querySelector(`.msg-row[data-id="${id}"]`);
  if (!row) {
    toast('Сообщение выше по истории — листай вверх');
    return;
  }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.style.transition = 'filter .2s';
  row.style.filter = 'brightness(1.5)';
  setTimeout(() => { row.style.filter = ''; }, 700);
}

async function deleteMessage(m) {
  try {
    await api(`/api/messages/${m.id}`, { method: 'DELETE' });
    onMessageDelete({ chat_id: m.chat_id, message_id: m.id });
  } catch (ex) {
    toast('Не получилось удалить: ' + ex.message, true);
  }
}

function onMessageDelete(d) {
  const arr = state.messages.get(d.chat_id);
  if (arr) {
    const i = arr.findIndex(x => x.id === d.message_id);
    if (i >= 0) arr.splice(i, 1);
  }
  if (state.activeChat === d.chat_id) {
    const row = messagesList.querySelector(`.msg-row[data-id="${d.message_id}"]`);
    if (row) {
      row.style.transition = 'opacity .25s, transform .25s';
      row.style.opacity = '0';
      row.style.transform = 'scale(.96)';
      setTimeout(() => { row.remove(); }, 240);
    }
  }
  const c = state.chats.get(d.chat_id);
  if (c && c.last_message && c.last_message.id === d.message_id) {
    const arr2 = state.messages.get(d.chat_id) || [];
    c.last_message = arr2[arr2.length - 1] || null;
    c.updated_at = c.last_message ? c.last_message.created_at : c.updated_at;
    renderChatItem(c);
  }
}

/* ───────── голосовые ───────── */

const waveCache = new Map(); // msg id → peaks
const audioPlayers = new Map(); // msg id → {audio, canvas, peaks}

function voiceNode(m, mine) {
  const wrap = el('div', 'msg-voice');
  const play = el('button', 'voice-play');
  play.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>';
  const wave = el('canvas', 'voice-wave');
  wave.width = 120; wave.height = 30;
  wave.style.width = '120px';
  const side = el('span', 'voice-sec');
  const dur = el('span', 'voice-dur', fmtDur(m.duration || 0));
  side.appendChild(dur);
  wrap.append(play, wave, side);

  const audio = new Audio(m.file_path);
  audio.preload = 'metadata';
  const p = { audio, canvas: wave, peaks: waveCache.get(m.id) || null, playing: false };
  audioPlayers.set(m.id + ':' + Math.random(), p);

  const drawDefault = () => {
    if (!p.peaks) p.peaks = pseudoPeaks(m.id);
    drawWave(wave, p.peaks, 0, mine);
  };
  drawDefault();

  play.onclick = async () => {
    if (p.playing) {
      audio.pause();
      return;
    }
    // остановить другие
    for (const [key, other] of audioPlayers) {
      if (other !== p && other.playing) { other.audio.pause(); }
    }
    try {
      if (!p.peaks || p.peaks.length < 5) {
        const buf = await fetch(m.file_path).then(r => r.arrayBuffer());
        const peaks = await decodePeaks(buf);
        if (peaks) { p.peaks = peaks; waveCache.set(m.id, peaks); }
      }
    } catch {}
    audio.play().catch(() => toast('Не удалось воспроизвести', true));
  };

  audio.onplay = () => {
    p.playing = true;
    play.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor" stroke="none"/></svg>';
  };
  audio.onpause = () => {
    p.playing = false;
    play.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>';
    drawWave(wave, p.peaks || pseudoPeaks(m.id), audio.currentTime / (audio.duration || m.duration || 1), mine);
  };
  audio.ontimeupdate = () => {
    if (p.playing) {
      const prog = audio.duration ? audio.currentTime / audio.duration : 0;
      drawWave(wave, p.peaks || pseudoPeaks(m.id), prog, mine);
      dur.textContent = fmtDur(audio.duration ? audio.duration - audio.currentTime : (m.duration || 0) - audio.currentTime);
    }
  };
  audio.onended = () => {
    dur.textContent = fmtDur(m.duration || 0);
    drawWave(wave, p.peaks || pseudoPeaks(m.id), 0, mine);
  };
  return wrap;
}

async function decodePeaks(arrayBuffer, buckets = 48) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const buf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const ch = buf.getChannelData(0);
    const step = Math.floor(ch.length / buckets) || 1;
    const peaks = [];
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step;
      for (let j = 0; j < step; j += 16) {
        const v = Math.abs(ch[start + j] || 0);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const norm = Math.max(...peaks, 0.01);
    return peaks.map(v => Math.min(1, v / norm));
  } catch {
    return null;
  }
}

function pseudoPeaks(seed, buckets = 48) {
  let x = seed % 2147483647;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const peaks = [];
  for (let i = 0; i < buckets; i++) peaks.push(0.25 + rnd() * 0.75);
  return peaks;
}

function drawWave(canvas, peaks, progress, mine) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = peaks.length;
  const gap = 2, bw = (w - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const ph = Math.max(3, peaks[i] * (h - 4));
    const x = i * (bw + gap);
    const y = (h - ph) / 2;
    const done = i / n <= progress;
    ctx.fillStyle = done ? '#1d2f0c' : (mine ? 'rgba(23,48,10,.35)' : '#9ba4b0');
    ctx.beginPath();
    ctx.roundRect(x, y, bw, ph, 2);
    ctx.fill();
  }
}

/* ═══════════ КОМПОЗЕР ═══════════ */

const msgInput = $('msgInput');

msgInput.addEventListener('input', () => {
  autosize();
  updateMorph();
  // typing
  if (state.activeChat && state.wsReady && Date.now() - state.lastTypingSent > 2500) {
    state.lastTypingSent = Date.now();
    state.ws.send(JSON.stringify({ type: 'typing', chat_id: state.activeChat }));
  }
});

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitComposer();
  }
});

function autosize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 132) + 'px';
}

function updateMorph() {
  const hasText = msgInput.value.trim().length > 0;
  const hasFile = !!state.pendingFile;
  $('morphBtn').classList.toggle('ready', hasText || hasFile || recording.active);
}

$('morphBtn').onclick = () => {
  if (recording.active) { finishRecording(true); return; }
  if (msgInput.value.trim() || state.pendingFile) submitComposer();
  else startRecording();
};

function submitComposer() {
  if (recording.active) { finishRecording(true); return; }
  const text = msgInput.value.trim();
  if (state.pendingFile) {
    sendPendingFile(text);
    return;
  }
  if (text && state.activeChat) sendText(text);
}

/* ───────── отправка текста ───────── */

function sendText(text) {
  const chatId = state.activeChat;
  const tag = 't' + Date.now() + Math.random().toString(36).slice(2, 8);
  const optimistic = {
    id: 1e12 + Math.floor(Math.random() * 1e11),
    chat_id: chatId, sender_id: state.me.id,
    sender_name: state.me.display_name,
    kind: 'text', text,
    reply: state.replyTo ? {
      id: state.replyTo.id, sender_name: state.replyTo.sender_name,
      preview: state.replyTo.preview,
    } : null,
    created_at: Date.now(), client_tag: tag,
  };
  pushOptimistic(chatId, optimistic);
  soundSend();

  api('/api/messages', {
    method: 'POST',
    body: { chat_id: chatId, kind: 'text', text, reply_to: state.replyTo ? state.replyTo.id : undefined, client_tag: tag },
  }).catch((ex) => {
    toast('Не отправилось: ' + ex.message, true);
    removeOptimistic(tag);
  });

  msgInput.value = '';
  autosize();
  updateMorph();
  setReply(null);
  scrollToBottom();
}

function wsSendSafe(obj) {
  if (state.ws && state.wsReady) state.ws.send(JSON.stringify(obj));
}

function pushOptimistic(chatId, m) {
  state.pending.set(m.client_tag, m);
  const arr = state.messages.get(chatId) || [];
  arr.push(m);
  state.messages.set(chatId, arr);
  if (state.activeChat === chatId) {
    const stick = nearBottom();
    messagesList.appendChild(messageNode(m, isGroupedWithPrev(arr, arr.length - 1)));
    if (stick) scrollToBottom();
  }
  const c = state.chats.get(chatId);
  if (c) { c.updated_at = Date.now(); c.last_message = m; renderChatItem(c); }
}

function isGroupedWithPrev(arr, i) {
  if (i <= 0) return false;
  const prev = arr[i - 1], cur = arr[i];
  return prev.sender_id === cur.sender_id && cur.created_at - prev.created_at < 5 * 60_000;
}

function removeOptimistic(tag) {
  const m = state.pending.get(tag);
  if (!m) return;
  state.pending.delete(tag);
  const arr = state.messages.get(m.chat_id);
  if (arr) {
    const i = arr.findIndex(x => x.client_tag === tag);
    if (i >= 0) arr.splice(i, 1);
  }
  if (state.activeChat === m.chat_id) {
    const row = messagesList.querySelector(`[data-pending="${tag}"]`);
    if (row) row.remove();
  }
}

/* ───────── вложения ───────── */

$('attachBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('attachMenu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('emojiPanel').hidden = true;
  $('attachBtn').classList.toggle('open', open);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#attachMenu') && !e.target.closest('#attachBtn')) {
    $('attachMenu').hidden = true;
    $('attachBtn').classList.remove('open');
  }
  if (!e.target.closest('#emojiPanel') && !e.target.closest('#menuEmoji')) {
    $('emojiPanel').hidden = true;
  }
});

$('menuPhoto').onclick = () => {
  $('attachMenu').hidden = true; $('attachBtn').classList.remove('open');
  const inp = $('fileInput');
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    inp.value = '';
    if (f) pickFile(f, 'image');
  };
  inp.click();
  // подсказка: если диалог не открылся (встроенные вьюверы его не поддерживают),
  // фото можно перетащить в чат или вставить из буфера
  setTimeout(() => {
    if (!state.pendingFile) {
      toast('Диалог не открылся? Перетащи фото в чат или нажми Ctrl+V');
    }
  }, 2500);
};

// «Вставить из буфера» — работает даже там, где системный диалог файлов недоступен
$('menuClipboard').onclick = async () => {
  $('attachMenu').hidden = true; $('attachBtn').classList.remove('open');
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('unsupported');
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
        pickFile(new File([blob], 'clipboard.' + ext, { type }), 'image');
        return;
      }
    }
    toast('В буфере нет картинки', true);
  } catch {
    toast('Скопируй картинку и нажми Ctrl+V в поле сообщения', true);
  }
};
$('menuFile').onclick = () => {
  $('attachMenu').hidden = true; $('attachBtn').classList.remove('open');
  const inp = $('fileInput');
  inp.accept = '';
  inp.onchange = () => { pickFile(inp.files[0], 'file'); inp.value = ''; };
  inp.click();
};

// вставка из буфера и drag&drop
msgInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { pickFile(f, 'image'); e.preventDefault(); }
      return;
    }
  }
});
// drag&drop: принимаем на всё окно чата, файл по промаху не «открывается» вкладкой
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!state.activeChat) return;
  const f = e.dataTransfer?.files?.[0];
  if (f) pickFile(f, f.type && f.type.startsWith('image/') ? 'image' : 'file');
});

async function pickFile(file, kind) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { toast('Файл больше 60 МБ — не потянет', true); return; }

  let blob = file;
  let name = file.name || 'photo.jpg';
  if (kind === 'image') {
    const t = (file.type || '').toLowerCase();
    // heic/svg/неизвестный тип браузер не покажет как <img> — пробуем пережать в JPEG
    const needsConvert = !t.startsWith('image/') || ['image/heic', 'image/heif', 'image/svg+xml'].includes(t);
    if (needsConvert || file.size > 3 * 1024 * 1024) {
      try {
        const converted = await downscaleImage(file);
        if (converted && converted.size > 0) {
          blob = converted;
          name = name.replace(/\.[^.]+$/, '') + '.jpg';
          if (needsConvert) toast('Конвертировал в JPEG для превью');
        } else if (needsConvert) {
          kind = 'file';
        }
      } catch {
        if (needsConvert) { kind = 'file'; toast('Этот формат не превьюится — отправлю файлом'); }
      }
    }
  }

  const previewUrl = kind === 'image' ? URL.createObjectURL(blob) : null;
  state.pendingFile = { blob, name, kind, previewUrl };
  renderAttachBar();
  updateMorph();
  msgInput.focus();
}

function renderAttachBar() {
  const bar = $('attachBar');
  const pf = state.pendingFile;
  bar.hidden = !pf;
  if (!pf) return;
  const th = $('attachThumb');
  if (pf.previewUrl) {
    th.style.backgroundImage = `url(${pf.previewUrl})`;
    th.textContent = '';
  } else {
    th.style.backgroundImage = '';
    th.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M13 3v6h6"/></svg>';
  }
  $('attachName').textContent = pf.name;
  $('attachSize').textContent = fmtSize(pf.blob.size) + ' — готово к отправке';
}
$('attachCancel').onclick = () => {
  if (state.pendingFile?.previewUrl) URL.revokeObjectURL(state.pendingFile.previewUrl);
  state.pendingFile = null;
  renderAttachBar();
  updateMorph();
};

async function downscaleImage(file, maxSide = 2048, quality = 0.85) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', quality));
}

async function uploadBlob(blob, name, mime) {
  return api(`/api/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: blob,
    headers: { 'Content-Type': mime || blob.type || 'application/octet-stream' },
  });
}

async function sendPendingFile(caption) {
  const chatId = state.activeChat;
  const pf = state.pendingFile;
  if (!pf || !chatId) return;
  state.sending = true;
  const tag = 'f' + Date.now() + Math.random().toString(36).slice(2, 8);
  const optimistic = {
    id: 1e12 + Math.floor(Math.random() * 1e11),
    chat_id: chatId, sender_id: state.me.id,
    sender_name: state.me.display_name,
    kind: pf.kind, text: caption,
    file_path: pf.previewUrl || '',
    file_name: pf.name, file_size: pf.blob.size,
    reply: state.replyTo ? { id: state.replyTo.id, sender_name: state.replyTo.sender_name, preview: state.replyTo.preview } : null,
    created_at: Date.now(), client_tag: tag,
  };
  optimistic._localUrl = pf.previewUrl;
  pushOptimistic(chatId, optimistic);
  soundSend();
  scrollToBottom();

  // attach bar убираем сразу; локальное превью живёт, пока не придёт эхо (иначе пузырь станет битой картинкой)
  state.pendingFile = null;
  renderAttachBar();
  msgInput.value = '';
  autosize();
  updateMorph();
  setReply(null);

  try {
    const up = await uploadBlob(pf.blob, pf.name, pf.kind === 'image' ? 'image/jpeg' : undefined);
    const res = await api('/api/messages', {
      method: 'POST',
      body: {
        chat_id: chatId, kind: up.kind, text: caption,
        file: { url: up.url, name: up.name, size: up.size, mime: up.mime },
        reply_to: optimistic.reply ? optimistic.reply.id : undefined,
        client_tag: tag,
      },
    });
    state.sending = false;
    // эхо уже подменило картинку на серверную — локальный objectURL больше не нужен
    if (optimistic._localUrl) setTimeout(() => URL.revokeObjectURL(optimistic._localUrl), 5000);
  } catch (ex) {
    state.sending = false;
    removeOptimistic(tag);
    if (optimistic._localUrl) URL.revokeObjectURL(optimistic._localUrl);
    toast('Не удалось отправить: ' + ex.message, true);
  }
}

/* ───────── эмодзи ───────── */

const EMOJI = ['😀','😂','🤣','😊','😍','😘','😜','🤪','😎','🥳','😇','🥰','🙃','😴','🤔','🤗','🤝','👍','👎','👌','✌️','🤟','🫶','🙏','💪','🔥','✨','💫','⚡','💎','🎉','🎁','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💯','👀','🙈','😹','🐱','🐶','🦊','🐻','🐺','🌙','☀️','🌈','⭐','☕','🍕','🍔','🍟','🍩','🍺','🍻','🥂','🎂','🚀','🎮','🎵','🎧','📷','💻','📱','⚡','💬','✅','❌','❗','⁉️','🆗','🎯','🏆','⚽','🏀'];

$('menuEmoji').onclick = (e) => {
  e.stopPropagation();
  const p = $('emojiPanel');
  if (!p.children.length) {
    for (const em of EMOJI) {
      const b = el('button', '', em);
      b.onclick = () => {
        msgInput.value += em;
        msgInput.focus();
        autosize();
        updateMorph();
      };
      p.appendChild(b);
    }
  }
  p.hidden = !p.hidden;
  $('attachMenu').hidden = true;
  $('attachBtn').classList.remove('open');
};

/* ───────── цитата ───────── */

function setReply(m) {
  if (!m) { state.replyTo = null; renderReplyBar(); return; }
  state.replyTo = {
    id: m.id,
    sender_name: m.sender_name || m.sender_id,
    preview: m.kind === 'text' ? (m.text || '') :
             m.kind === 'image' ? 'Фото' : m.kind === 'voice' ? 'Голосовое сообщение' :
             (m.file_name || 'Файл'),
  };
  renderReplyBar();
  msgInput.focus();
}
function renderReplyBar() {
  const bar = $('replyBar');
  bar.hidden = !state.replyTo;
  if (state.replyTo) {
    $('replyName').textContent = state.replyTo.sender_name;
    $('replyPreview').textContent = state.replyTo.preview || ' ';
  }
}
$('replyCancel').onclick = () => setReply(null);

/* ═══════════ ГОЛОСОВЫЕ ЗАПИСИ ═══════════ */

const recording = { active: false, media: null, chunks: [], startTs: 0, timer: null, mime: '' };

function pickRecMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startRecording() {
  if (!state.activeChat) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('Браузер не поддерживает запись голоса', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickRecMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recording.active = true;
    recording.media = rec;
    recording.chunks = [];
    recording.startTs = Date.now();
    recording.mime = rec.mimeType || mime || 'audio/webm';

    rec.ondataavailable = (e) => { if (e.data.size) recording.chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const dur = (Date.now() - recording.startTs) / 1000;
      if (recording.sendAfterStop && dur > 0.4) {
        const blob = new Blob(recording.chunks, { type: recording.mime });
        sendVoice(blob, dur);
      } else if (recording.sendAfterStop) {
        toast('Слишком коротко — держи подольше 🙂');
      }
      recording.active = false;
      recording.sendAfterStop = false;
      $('recIndicator').hidden = true;
      clearInterval(recording.timer);
      $('morphBtn').classList.remove('recording');
      updateMorph();
    };
    rec.start(250);

    // UI
    $('recIndicator').hidden = false;
    $('morphBtn').classList.add('recording');
    updateMorph();
    recording.timer = setInterval(() => {
      $('recTime').textContent = fmtDur((Date.now() - recording.startTs) / 1000);
    }, 250);
  } catch (ex) {
    toast('Нет доступа к микрофону: ' + (ex.message || ex.name), true);
  }
}

function finishRecording(send) {
  if (!recording.active || !recording.media) return;
  recording.sendAfterStop = !!send;
  try { recording.media.stop(); } catch {}
}
$('recCancel').onclick = () => finishRecording(false);

async function sendVoice(blob, duration) {
  const chatId = state.activeChat;
  if (!chatId) return;
  const ext = recording.mime.includes('mp4') ? 'm4a' : recording.mime.includes('ogg') ? 'ogg' : 'webm';
  const tag = 'v' + Date.now() + Math.random().toString(36).slice(2, 8);
  const url = URL.createObjectURL(blob);
  const optimistic = {
    id: 1e12 + Math.floor(Math.random() * 1e11),
    chat_id: chatId, sender_id: state.me.id,
    sender_name: state.me.display_name,
    kind: 'voice', text: '',
    file_path: url, file_name: 'voice.' + ext, file_size: blob.size, duration,
    reply: null, created_at: Date.now(), client_tag: tag,
  };
  pushOptimistic(chatId, optimistic);
  soundSend();
  scrollToBottom();

  try {
    const up = await uploadBlob(blob, 'voice.' + ext, recording.mime);
    await api('/api/messages', {
      method: 'POST',
      body: {
        chat_id: chatId, kind: 'voice',
        file: { url: up.url, name: up.name, size: up.size, mime: up.mime, duration },
        client_tag: tag,
      },
    });
  } catch (ex) {
    removeOptimistic(tag);
    toast('Голосовое не отправилось: ' + ex.message, true);
  }
}

/* ═══════════ ПРОФИЛЬ ═══════════ */

function openProfile() {
  $('profileDisplayName').textContent = state.me.display_name || state.me.username;
  $('profileUsername').textContent = '@' + state.me.username;
  $('profileNameInput').value = state.me.display_name === state.me.username ? '' : state.me.display_name;
  $('profileBioInput').value = state.me.bio || '';
  const old = $('profileAvatar');
  const av = avatarNode(state.me, 96);
  av.id = 'profileAvatar';
  old.replaceWith(av);
  $('profileOverlay').hidden = false;
}

$('profileClose').onclick = () => { $('profileOverlay').hidden = true; };
$('profileOverlay').onclick = (e) => { if (e.target === $('profileOverlay')) $('profileOverlay').hidden = true; };

$('avatarEditor').onclick = () => {
  $('avatarInput').onchange = async () => {
    const f = $('avatarInput').files[0];
    $('avatarInput').value = '';
    if (!f) return;
    try {
      let blob = f;
      if (f.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
        blob = await downscaleImage(f, 512, 0.9);
      }
      const data = await api('/api/avatar', {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': f.type === 'image/gif' ? 'image/gif' : 'image/jpeg' },
      });
      state.me = { ...state.me, ...data.user };
      renderMe();
      openProfile();
      toast('Аватарка обновлена ✨');
    } catch (ex) {
      toast(ex.message, true);
    }
  };
  $('avatarInput').click();
};

$('profileSave').onclick = async () => {
  try {
    const data = await api('/api/profile', {
      method: 'POST',
      body: { display_name: $('profileNameInput').value.trim(), bio: $('profileBioInput').value.trim() },
    });
    state.me = { ...state.me, ...data.user };
    renderMe();
    $('profileOverlay').hidden = true;
    toast('Профиль сохранён');
  } catch (ex) {
    toast(ex.message, true);
  }
};

$('logoutBtn').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
};

/* профиль друга */
let peerModalUser = null;
function openPeerModal(u) {
  peerModalUser = u;
  renderPeerModal(u);
  $('peerOverlay').hidden = false;
}
function renderPeerModal(u) {
  const old = $('peerBigAvatar');
  const av = avatarNode(u, 96);
  av.id = 'peerBigAvatar';
  old.replaceWith(av);
  $('peerBigName').textContent = u.display_name;
  $('peerBigUsername').textContent = '@' + u.username;
  $('peerBigStatus').textContent = fmtLastSeen(u);
  $('peerBigStatus').classList.toggle('online', !!u.online);
  const bio = $('peerBigBio');
  if (u.bio) { bio.hidden = false; bio.textContent = u.bio; } else bio.hidden = true;
}
$('peerClose').onclick = () => { $('peerOverlay').hidden = true; };
$('peerOverlay').onclick = (e) => { if (e.target === $('peerOverlay')) $('peerOverlay').hidden = true; };

/* ═══════════ ЛАЙТБОКС ═══════════ */

function openLightbox(src) {
  $('lightboxImg').src = src;
  $('lightboxDl').href = src;
  $('lightbox').hidden = false;
}
$('lightboxClose').onclick = () => { $('lightbox').hidden = true; };
$('lightbox').onclick = (e) => { if (e.target === $('lightbox')) $('lightbox').hidden = true; };

/* ═══════════ ВХОДЯЩИЕ СООБЩЕНИЯ ═══════════ */

// подтягиваем список чатов, если это первое сообщение в новом чате
async function ensureChat(chatId) {
  if (state.chats.has(chatId)) return state.chats.get(chatId);
  await loadChats();
  return state.chats.get(chatId);
}

function onNewMessage(d) {
  onNewMessageAsync(d).catch((e) => console.warn('message handler:', e));
}

async function onNewMessageAsync(d) {
  const m = d.message;
  const chatId = m.chat_id;
  const mine = m.sender_id === state.me.id;

  // дедуп оптимистичной копии
  if (m.client_tag && state.pending.has(m.client_tag)) {
    state.pending.delete(m.client_tag);
    const arr = state.messages.get(chatId);
    if (arr) {
      const i = arr.findIndex(x => x.client_tag === m.client_tag);
      if (i >= 0) arr[i] = m;
    }
    if (state.activeChat === chatId) {
      const row = messagesList.querySelector(`[data-pending="${m.client_tag}"]`);
      if (row) {
        const arr2 = state.messages.get(chatId) || [];
        const idx = arr2.findIndex(x => x.id === m.id);
        const stick = nearBottom();
        row.replaceWith(messageNode(m, isGroupedWithPrev(arr2, Math.max(idx, 0))));
        if (stick) scrollToBottom();
        renderTicks();
      }
    }
  } else if (mine) {
    // эхо из другого таба — просто добавим, если нет
    const arr = state.messages.get(chatId);
    if (arr && !arr.some(x => x.id === m.id)) {
      arr.push(m);
      if (state.activeChat === chatId && nearBottom()) {
        messagesList.appendChild(messageNode(m, isGroupedWithPrev(arr, arr.length - 1)));
        scrollToBottom();
      }
    }
  } else {
    // чужое: если чат ещё неизвестен (первое сообщение) — грузим список чатов с сервера
    const chatWasKnown = state.chats.has(chatId);
    let c = await ensureChat(chatId);

    const arr = state.messages.get(chatId);
    if (arr && !arr.some(x => x.id === m.id)) {
      const stick = state.activeChat === chatId && nearBottom();
      arr.push(m);
      if (state.activeChat === chatId) {
        messagesList.appendChild(messageNode(m, isGroupedWithPrev(arr, arr.length - 1)));
        if (stick) scrollToBottom();
        else {
          $('jumpDown').hidden = false;
          const b = $('jumpBadge');
          b.hidden = false;
          b.textContent = '1';
        }
      }
    }
    if (state.activeChat === chatId && !document.hidden) {
      markRead();
    } else if (chatWasKnown && c) {
      c.unread = (c.unread || 0) + 1;
    }
    if (c) { c.updated_at = m.created_at; c.last_message = m; }
    renderChatList();

    soundRecv();
    if (document.hidden || state.activeChat !== chatId) {
      notifyDesktop(m, c);
    }
  }

  updateTitle();
  // обновим превью чата и в позиции
  const c2 = state.chats.get(chatId);
  if (c2) {
    c2.updated_at = Math.max(c2.updated_at || 0, m.created_at);
    if (!mine) c2.last_message = m;
    renderChatItem(c2);
  }
}

function markRead() {
  const chatId = state.activeChat;
  if (!chatId || document.hidden) return;
  const arr = state.messages.get(chatId);
  if (!arr || !arr.length) return;
  const last = arr[arr.length - 1];
  if (last.client_tag && state.pending.has(last.client_tag)) return;
  api(`/api/chats/${chatId}/read`, { method: 'POST', body: { last_message_id: last.id } }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { markRead(); updateTitle(); }
});

function updateTitle() {
  let total = 0;
  for (const c of state.chats.values()) total += c.unread || 0;
  document.title = total > 0 ? `(${total}) Опал` : 'Опал — мессенджер';
}

function notifyDesktop(m, chat) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const title = m.sender_name || 'Новое сообщение';
    const body = m.kind === 'text' ? m.text : m.kind === 'image' ? '📷 Фото' : m.kind === 'voice' ? '🎤 Голосовое' : '📎 ' + (m.file_name || 'Файл');
    const n = new Notification(title, { body, tag: 'opal-' + m.chat_id, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}
document.addEventListener('click', function askNotif() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().finally(() => document.removeEventListener('click', askNotif));
  }
}, { once: false });

/* ═══════════ ПРОЧЕЕ ═══════════ */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('lightbox').hidden) { $('lightbox').hidden = true; return; }
    if (!$('profileOverlay').hidden) { $('profileOverlay').hidden = true; return; }
    if (!$('peerOverlay').hidden) { $('peerOverlay').hidden = true; return; }
    if (!$('emojiPanel').hidden) { $('emojiPanel').hidden = true; return; }
    if (!$('attachMenu').hidden) { $('attachMenu').hidden = true; $('attachBtn').classList.remove('open'); return; }
    if (state.replyTo) { setReply(null); return; }
  }
});

// блик, следящий за курсором на стекле
document.addEventListener('pointermove', (e) => {
  for (const panel of document.querySelectorAll('.glass-strong')) {
    const r = panel.getBoundingClientRect();
    if (e.clientX >= r.left - 60 && e.clientX <= r.right + 60 && e.clientY >= r.top - 60 && e.clientY <= r.bottom + 60) {
      panel.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    }
  }
}, { passive: true });

/* автозапуск */
(async function init() {
  try {
    const data = await api('/api/me');
    enterApp(data.user);
  } catch {
    // остаёмся на экране входа
    $('authUsername').focus();
  }
})();
