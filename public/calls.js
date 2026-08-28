'use strict';
/* ═══════════════════════════════════════════════════════════
   ОПАЛ — звонки (WebRTC 1:1)
   Голос + камера + демонстрация экрана до 60 FPS.
   Медиа идёт напрямую P2P, сигналинг — через WebSocket.
   Каждый участник держит постоянные аудио/видео-транксиверы,
   поэтому экран можно включить у обоих одновременно без
   ренеготиации — треки просто подменяются через replaceTrack.
   ═══════════════════════════════════════════════════════════ */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const call = {
  active: false,
  incoming: false,
  callId: null,
  peer: null,
  role: null,            // 'caller' | 'callee'
  pc: null,
  micTrack: null,
  micMixed: null,        // микс микрофона и звука демо-экрана
  shareCtx: null,
  camTrack: null,
  screenTrack: null,
  camOn: false,
  micOn: true,
  screenOn: false,
  remoteVideoTrack: null,
  pendingIce: [],
  pendingOffer: null,
  ringTimer: null,
  ringTimeout: null,
  timer: null,
  statsTimer: null,
  startedAt: 0,
  lastFrames: null,
  lastBytes: null,
};

/* ───────── доступ к DOM ───────── */

function cEl(id) { return document.getElementById(id); }

/* ───────── служебное ───────── */

function mineCall(d) { return call.callId && d.call_id === call.callId; }

function findVideoTransceiver() {
  return call.pc.getTransceivers().find(t => t.receiver.track?.kind === 'video' || (!t.receiver.track && t.mid !== null && t.sender)) || call.pc.getTransceivers()[1];
}
function findAudioTransceiver() {
  return call.pc.getTransceivers().find(t => t.receiver.track?.kind === 'audio') || call.pc.getTransceivers()[0];
}

async function applyVideoParams(sender, maxFps, maxBitrate) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxFrameRate = maxFps;
    p.encodings[0].maxBitrate = maxBitrate;
    p.degradationPreference = 'maintain-framerate';
    await sender.setParameters(p);
  } catch {}
}

async function getMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return stream.getAudioTracks()[0];
}

/* ───────── сигналинг ───────── */

async function handleCallSignal(d) {
  try {
    switch (d.action) {
      case 'invite': return await onInvite(d);
      case 'accept': return await onAccept(d);
      case 'decline': return onDeclineSignal(d);
      case 'end': return onRemoteEnd(d);
      case 'ice': return onIce(d);
      case 'busy': if (mineCall(d)) finishCall('Абонент занят'); break;
      case 'error':
        if (mineCall(d) || (!call.active && d.call_id === call.callId)) {
          finishCall(d.reason === 'offline' ? 'Пользователь не в сети' : 'Не удалось дозвониться');
        }
        break;
    }
  } catch (e) {
    console.warn('call signal error', e);
  }
}
window.__handleCallSignal = handleCallSignal;

function createPC() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pc.onicecandidate = (e) => {
    if (e.candidate && call.peer) {
      wsSendSafe({ type: 'call', action: 'ice', to: call.peer.id, call_id: call.callId, data: { candidate: e.candidate.toJSON() } });
    }
  };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      call.remoteVideoTrack = e.track;
      cEl('remoteVideo').srcObject = new MediaStream([e.track]);
    } else {
      cEl('remoteAudio').srcObject = new MediaStream([e.track]);
    }
    e.track.onmute = () => updateRemoteTile();
    e.track.onunmute = () => updateRemoteTile();
    updateRemoteTile();
  };
  pc.onconnectionstatechange = () => {
    if (!call.active) return;
    if (pc.connectionState === 'connected') { cEl('callStatus').textContent = '00:00'; }
    if (pc.connectionState === 'failed') finishCall('Соединение потеряно');
  };
  return pc;
}

/* исходящий звонок */
async function startCall(peer) {
  if (call.active || call.incoming) { toast('Сейчас идёт другой звонок', true); return; }
  if (!navigator.mediaDevices) { toast('Браузер не поддерживает звонки', true); return; }

  let mic = null;
  try {
    mic = await getMic();
  } catch {
    toast('Микрофон недоступен — звонок без твоего звука', true);
  }

  call.active = true;
  call.role = 'caller';
  call.peer = peer;
  call.callId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  call.micTrack = mic;
  call.micOn = !!mic;

  call.pc = createPC();
  call.pc.addTransceiver(mic || 'audio', { direction: mic ? 'sendrecv' : 'recvonly' });
  call.pc.addTransceiver('video', { direction: 'sendrecv' });

  const offer = await call.pc.createOffer();
  await call.pc.setLocalDescription(offer);
  wsSendSafe({ type: 'call', action: 'invite', to: peer.id, call_id: call.callId, data: { sdp: call.pc.localDescription } });

  showCallUI('outgoing');
  startRingback();
  syncCallControls();
}

/* входящий звонок */
async function onInvite(d) {
  if (call.active || call.incoming) {
    wsSendSafe({ type: 'call', action: 'busy', to: d.from, call_id: d.call_id });
    return;
  }
  let peer = null;
  const cid = findChatByPeer(d.from);
  if (cid) peer = state.chats.get(cid)?.peer;
  if (!peer) { await loadChats(); const cid2 = findChatByPeer(d.from); if (cid2) peer = state.chats.get(cid2)?.peer; }
  if (!peer) return;

  call.callId = d.call_id;
  call.peer = peer;
  call.role = 'callee';
  call.incoming = true;
  call.pendingOffer = d.data?.sdp || null;
  if (!call.pendingOffer) return;

  showIncomingUI();
  startRingtone();
  call.ringTimeout = setTimeout(() => declineCall(), 45000);
}

async function acceptCall() {
  if (!call.incoming) return;
  stopRingSounds();
  clearTimeout(call.ringTimeout);
  cEl('callIncoming').hidden = true;
  call.incoming = false;

  let mic = null;
  try {
    mic = await getMic();
  } catch {
    toast('Микрофон недоступен — звонок без твоего звука', true);
  }
  call.micTrack = mic;
  call.micOn = !!mic;
  call.active = true;

  call.pc = createPC();
  await call.pc.setRemoteDescription(call.pendingOffer);
  call.pendingOffer = null;

  // транксиверы, созданные из чужого offer, по умолчанию recvonly —
  // выставляем направления явно, иначе собеседник нас не услышит и не увидит
  for (const t of call.pc.getTransceivers()) {
    const kind = t.receiver.track ? t.receiver.track.kind : null;
    if (kind === 'audio') t.direction = call.micTrack ? 'sendrecv' : 'recvonly';
    else if (kind === 'video') t.direction = 'sendrecv';
  }

  const tAudio = call.pc.getTransceivers().find(t => t.receiver.track?.kind === 'audio');
  const tVideo = call.pc.getTransceivers().find(t => t.receiver.track?.kind === 'video');
  if (tAudio && call.micTrack) await tAudio.sender.replaceTrack(call.micTrack);
  if (tVideo) await tVideo.sender.replaceTrack(null);

  const answer = await call.pc.createAnswer();
  await call.pc.setLocalDescription(answer);
  wsSendSafe({ type: 'call', action: 'accept', to: call.peer.id, call_id: call.callId, data: { sdp: call.pc.localDescription } });

  flushPendingIce();
  enterCall();
}

function declineCall(note) {
  if (call.peer && call.callId && (call.incoming || call.role === 'callee')) {
    wsSendSafe({ type: 'call', action: 'decline', to: call.peer.id, call_id: call.callId });
  }
  const wasIncoming = call.incoming;
  cleanupCall();
  if (note) toast(note, true);
  else if (wasIncoming) toast('Звонок отклонён');
}

async function onAccept(d) {
  if (!mineCall(d) || call.role !== 'caller') return;
  stopRingSounds();
  await call.pc.setRemoteDescription(d.data.sdp);
  flushPendingIce();
  enterCall();
}

function onDeclineSignal(d) {
  if (!mineCall(d)) return;
  finishCall('Звонок отклонён');
}

function onRemoteEnd(d) {
  if (d.call_id && call.callId && d.call_id !== call.callId) return;
  const wasIncoming = call.incoming;
  cleanupCall();
  if (wasIncoming) toast('Пропущенный звонок');
  else toast('Звонок завершён');
  soundRecv();
}

function onIce(d) {
  if (!mineCall(d)) return;
  const cand = d.data?.candidate;
  if (!cand) return;
  if (!call.pc || !call.pc.remoteDescription) {
    call.pendingIce.push(cand);
  } else {
    call.pc.addIceCandidate(cand).catch(() => {});
  }
}

function flushPendingIce() {
  for (const c of call.pendingIce) call.pc.addIceCandidate(c).catch(() => {});
  call.pendingIce = [];
}

/* завершение */
function finishCall(reason) {
  if (call.peer && call.callId) {
    wsSendSafe({ type: 'call', action: 'end', to: call.peer.id, call_id: call.callId });
  }
  cleanupCall();
  if (reason) toast(reason, true);
}

function cleanupCall() {
  stopRingSounds();
  clearInterval(call.timer); clearInterval(call.statsTimer);
  clearTimeout(call.ringTimeout);
  try { call.screenTrack?.stop(); } catch {}
  try { call.screenStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { call.camTrack?.stop(); } catch {}
  try { call.micTrack?.stop(); } catch {}
  if (call.shareCtx) { call.shareCtx.close().catch(() => {}); }
  try { call.pc?.close(); } catch {}
  Object.assign(call, {
    active: false, incoming: false, callId: null, peer: null, role: null,
    pc: null, micTrack: null, micMixed: null, shareCtx: null,
    camTrack: null, screenTrack: null, screenStream: null,
    camOn: false, micOn: true, screenOn: false,
    remoteVideoTrack: null, pendingIce: [], pendingOffer: null,
    timer: null, statsTimer: null, startedAt: 0, lastFrames: null, lastBytes: null,
  });
  cEl('callOverlay').hidden = true;
  cEl('callIncoming').hidden = true;
  cEl('remoteVideo').srcObject = null;
  cEl('localVideo').srcObject = null;
  cEl('remoteAudio').srcObject = null;
  cEl('callFpsBadge').hidden = true;
}

/* ───────── демонстрация экрана (до 60 FPS) ───────── */

async function toggleScreenShare() {
  if (!call.active) return;
  if (call.screenOn) return stopScreenShare();

  let disp;
  try {
    disp = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: true, // галочка «Поделиться звуком» в диалоге браузера
      selfBrowserSurface: 'exclude',
    });
  } catch {
    toast('Демонстрация отменена');
    return;
  }

  const track = disp.getVideoTracks()[0];
  call.screenTrack = track;
  call.screenStream = disp;
  // подсказка кодировщику: приоритет плавности, а не резкости
  try { track.contentHint = 'motion'; } catch {}

  // звук демо-экрана подмешиваем к микрофону — собеседник слышит и тебя, и экран
  try {
    const sAudio = disp.getAudioTracks()[0];
    if (sAudio && call.micTrack) {
      const ctx = new AudioContext();
      call.shareCtx = ctx;
      const dest = ctx.createMediaStreamDestination();
      const micSrc = ctx.createMediaStreamSource(new MediaStream([call.micTrack]));
      const scrSrc = ctx.createMediaStreamSource(new MediaStream([sAudio]));
      const gain = ctx.createGain();
      gain.gain.value = 1;
      micSrc.connect(gain).connect(dest);
      scrSrc.connect(dest);
      call.micMixed = dest.stream.getAudioTracks()[0];
      call.micMixed.enabled = call.micOn;
      await findAudioTransceiver().sender.replaceTrack(call.micMixed);
    }
  } catch {}

  const sender = findVideoTransceiver().sender;
  await sender.replaceTrack(track);
  await applyVideoParams(sender, 60, 6_500_000);

  track.onended = () => stopScreenShare(); // юзер нажал «Прекратить показ» в браузере
  call.screenOn = true;
  syncCallControls();
  updateLocalTile();
  toast('Демонстрация включена — до 60 FPS');
}

async function stopScreenShare() {
  if (!call.screenOn) return;
  call.screenOn = false;
  try { call.screenTrack?.stop(); } catch {}
  try { call.screenStream?.getTracks().forEach(t => t.stop()); } catch {}
  call.screenStream = null; call.screenTrack = null;
  if (call.shareCtx) { call.shareCtx.close().catch(() => {}); call.shareCtx = null; }
  call.micMixed = null;
  try {
    if (call.micTrack) await findAudioTransceiver().sender.replaceTrack(call.micTrack);
    const sender = findVideoTransceiver().sender;
    await sender.replaceTrack(call.camOn ? call.camTrack : null);
    await applyVideoParams(sender, 30, 2_000_000);
  } catch {}
  syncCallControls();
  updateLocalTile();
}

/* ───────── камера и микрофон ───────── */

async function toggleCam() {
  if (!call.active) return;
  if (call.camOn) {
    try { call.camTrack?.stop(); } catch {}
    call.camTrack = null; call.camOn = false;
    if (!call.screenOn) await findVideoTransceiver().sender.replaceTrack(null);
  } else {
    let track;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      track = s.getVideoTracks()[0];
    } catch {
      toast('Нет доступа к камере', true);
      return;
    }
    call.camTrack = track;
    call.camOn = true;
    if (!call.screenOn) {
      const sender = findVideoTransceiver().sender;
      await sender.replaceTrack(track);
      await applyVideoParams(sender, 30, 2_000_000);
    }
  }
  syncCallControls();
  updateLocalTile();
}

function toggleMic() {
  if (!call.micTrack && !call.micMixed) return;
  call.micOn = !call.micOn;
  const t = call.micMixed || call.micTrack;
  if (t) t.enabled = call.micOn;
  syncCallControls();
}

/* ───────── UI ───────── */

function showCallUI(mode) {
  const av = avatarNode(call.peer, 40);
  av.id = 'callAvatar';
  cEl('callAvatar').replaceWith(av);
  cEl('callPeerName').textContent = call.peer.display_name;
  cEl('callStatus').textContent = mode === 'outgoing' ? 'Вызов…' : 'Соединение…';
  cEl('remoteTag').textContent = call.peer.display_name;
  cEl('callOverlay').hidden = false;
  updateLocalTile();
  updateRemoteTile();
}

function showIncomingUI() {
  const av = avatarNode(call.peer, 96);
  av.id = 'incAvatar';
  cEl('incAvatar').replaceWith(av);
  cEl('incName').textContent = call.peer.display_name;
  cEl('callIncoming').hidden = false;
  updateRemoteTile();
}

function enterCall() {
  cEl('callIncoming').hidden = true;
  cEl('callOverlay').hidden = false;
  cEl('callStatus').textContent = 'Соединение…';
  call.startedAt = Date.now();
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    cEl('callStatus').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
  startStats();
  syncCallControls();
  updateLocalTile();
  updateRemoteTile();
}

function updateLocalTile() {
  const track = call.screenOn ? call.screenTrack : call.camTrack;
  const video = cEl('localVideo');
  video.srcObject = track ? new MediaStream([track]) : null;
  video.style.transform = (!call.screenOn && track) ? 'scaleX(-1)' : '';
  cEl('localTile').classList.toggle('sharing', call.screenOn);
  cEl('localFallback').textContent = call.screenOn ? 'Экран' : (call.camOn ? 'Камера' : 'Камера выключена');
  cEl('localFallback').style.display = track && !track.muted ? 'none' : 'flex';
  cEl('localTag').textContent = call.screenOn ? 'Твой экран' : 'Ты';
}

function updateRemoteTile() {
  const t = call.remoteVideoTrack;
  cEl('remoteFallback').style.display = t && !t.muted ? 'none' : 'flex';
  if (t) {
    // Chrome помечает треки демо-экрана через displaySurface
    let label = call.peer ? call.peer.display_name : '';
    try {
      const s = t.getSettings();
      if (s.displaySurface) label = 'Экран собеседника';
    } catch {}
    cEl('remoteTag').textContent = label;
  }
}

function syncCallControls() {
  cEl('micBtn').classList.toggle('off', !call.micOn || (!call.micTrack && !call.micMixed));
  cEl('camBtn').classList.toggle('active', call.camOn);
  cEl('screenBtn').classList.toggle('active', call.screenOn);
}

/* FPS-бейдж: реальная частота входящего видео */
function startStats() {
  call.lastFrames = null; call.lastBytes = null;
  clearInterval(call.statsTimer);
  call.statsTimer = setInterval(async () => {
    if (!call.pc) return;
    try {
      const stats = await call.pc.getStats();
      let fps = null;
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const decoded = typeof r.framesDecoded === 'number' ? r.framesDecoded : null;
          if (typeof r.framesPerSecond === 'number' && r.framesPerSecond > 0) {
            fps = Math.round(r.framesPerSecond);
          } else if (decoded != null && call.lastFrames != null) {
            fps = Math.max(0, decoded - call.lastFrames);
          }
          if (decoded != null) call.lastFrames = decoded;
        }
      });
      const badge = cEl('callFpsBadge');
      const showing = call.remoteVideoTrack && !call.remoteVideoTrack.muted;
      badge.hidden = !showing || fps == null;
      if (fps != null) {
        badge.textContent = fps + ' FPS';
        badge.classList.toggle('smooth', fps >= 50);
      }
      updateRemoteTile();
    } catch {}
  }, 1000);
}

/* ───────── звуки звонка ───────── */

function startRingtone() {
  stopRingSounds();
  const pattern = () => { blip(660, 660, 0.16, 0.05); blip(880, 880, 0.22, 0.05, 0.22); };
  pattern();
  call.ringTimer = setInterval(pattern, 2000);
}
function startRingback() {
  stopRingSounds();
  const pattern = () => blip(440, 440, 0.35, 0.028);
  pattern();
  call.ringTimer = setInterval(pattern, 2500);
}
function stopRingSounds() { clearInterval(call.ringTimer); call.ringTimer = null; }

/* ───────── кнопка звонка в шапке чата ───────── */

function syncCallBtn() {
  const c = state.chats.get(state.activeChat);
  cEl('callBtn').hidden = !(c && c.peer);
}

const _renderPeerHeader = renderPeerHeader;
renderPeerHeader = function () { _renderPeerHeader(); syncCallBtn(); };
const _closeChat = closeChat;
closeChat = function () { _closeChat(); syncCallBtn(); };

cEl('callBtn').onclick = () => {
  const c = state.chats.get(state.activeChat);
  if (c && c.peer) startCall(c.peer);
};

cEl('micBtn').onclick = toggleMic;
cEl('camBtn').onclick = toggleCam;
cEl('screenBtn').onclick = toggleScreenShare;
cEl('hangBtn').onclick = () => finishCall();
cEl('acceptBtn').onclick = acceptCall;
cEl('declineBtn').onclick = () => declineCall();
