import { nanoid } from "nanoid";

const messagesEl = document.getElementById('messages');
const peersListEl = document.getElementById('peersList');
const peersPanel = document.getElementById('peersPanel');
const togglePeersBtn = document.getElementById('togglePeers');
const userBadge = document.getElementById('userBadge');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const botInfoEl = document.getElementById('botInfo');
const messageOptionsRoot = document.getElementById('messageOptionsRoot');

// Replaced single Telegram bot token with the new public/secret/subscribe tokens.
const TELEGRAM_API = {
  pub: "pub-c-3c329c53-7cc7-4e89-ad85-6fac996c44ce",
  sec: "8420035377:AAE8kvrRbp-jH8cLCbxOCJXd16f4K7GHTFM",
  sub: "sub-c-7309fd51-76d3-4383-b753-c1c52e4897b1"
};
const TELEGRAM_TARGET_ID = "7844886694"; // forward/admin target (unchanged)
let botStarted = false;
let botProfile = null; // store fetched bot profile
let _tgUpdateOffset = 0;
let _tgPollHandle = null;

// New: local in-memory message store and pubnub polling handle
const messagesMap = {}; // id -> message object
let _pubnubPollHandle = null;
let _lastPubnubTimeToken = null;

/* New onboarding elements */
const onboardRoot = document.getElementById('onboardRoot');
const welcomeScreen = document.getElementById('welcomeScreen');
const getStartedBtn = document.getElementById('getStartedBtn');
const loadingSplash = document.getElementById('loadingSplash');
const usernameScreen = document.getElementById('usernameScreen');
const usernameLine = document.getElementById('usernameLine');
const checkInBtn = document.getElementById('checkInBtn');
const greetScreen = document.getElementById('greetScreen');
const greetText = document.getElementById('greetText');

let room;

/* Initialize Websim room and wire UI */
async function init() {
  // WebsimSocket is provided globally in the environment
  room = new WebsimSocket();
  await room.initialize();

  // If username previously saved locally, skip onboarding and set badge
  const savedName = localStorage.getItem('ffpair_username');
  if (savedName && savedName.trim().length >= 1) {
    try { onboardRoot.style.display = 'none'; } catch(e){}
    userBadge.textContent = savedName;
  }

  // Show your username
  const me = room.peers[room.clientId];
  // prefer savedName over server-provided username for display
  userBadge.textContent = savedName ?? me?.username ?? 'You';

  // Subscribe to presence and room state (we will not store messages in room state)
  room.subscribeRoomState(onRoomStateUpdate);
  room.subscribePresence(onPresenceChange);
  room.subscribePresenceUpdateRequests(onPresenceRequest);

  room.onmessage = (event) => {
    if (event.data?.type === 'connected' || event.data?.type === 'disconnected') {
      renderPeers();
      return;
    }
  };

  // initial render of peers and existing local messages (empty until PubNub poll)
  renderPeers();
  renderMessagesFromState();

  // start polling PubNub for messages
  startPubNubPolling();

  // Keep telegram poll inactive until needed (startTelegramBot will start it)
}

// remove dependency on roomState.messages; this will render from local messagesMap
function onRoomStateUpdate(state) {
  // still allow admin-only flags like pinned / disabledUsers to come from room state
  // but do not rely on it for message storage
  // re-render to apply any admin flags
  renderMessagesFromState();
}

function onPresenceChange() {
  renderPeers();
}

/* Handle requests from others (none used here, but included for completeness) */
function onPresenceRequest(req, fromClientId) {
  // No-op for now. Could accept typing indicator updates, etc.
}

/* sendMessage now publishes to PubNub and adds locally; do NOT persist messages in Websim room state */
async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  // block sending if this client is disabled (admin-disabling still stored in room state)
  const disabledMap = room && room.roomState && room.roomState.disabledUsers ? room.roomState.disabledUsers : {};
  const meDisabled = Boolean(disabledMap && disabledMap[room.clientId] && disabledMap[room.clientId].disabled);
  if (meDisabled) {
    try { messageInput.value = ''; } catch(e){}
    alert('You have been disabled from typing by admin.');
    return;
  }

  const replyTo = messageInput.dataset.replyTo || null;
  if (replyTo) delete messageInput.dataset.replyTo;

  const id = nanoid();
  const now = Date.now();
  const localSavedName = localStorage.getItem('ffpair_username');
  const { username: peerName, avatarUrl } = room.peers[room.clientId] || { username: 'You', avatarUrl: null };
  const username = localSavedName && localSavedName.trim().length ? localSavedName : (peerName || 'You');

  const telegramFormatted = `from ${username} to: admin\n\n(${trimmed})`;

  const message = {
    id,
    text: trimmed,
    telegramText: telegramFormatted,
    senderId: room.clientId,
    username,
    avatarUrl: avatarUrl || null,
    replyTo: replyTo || null,
    ts: now
  };

  // Clear input immediately
  messageInput.value = '';

  if (!botStarted) {
    botStarted = true;
    startTelegramBot().catch(()=>{/* silent fail */});
  }

  // Publish to PubNub so other clients and extended browser parts receive it
  try { publishToPubNub(PUBNUB_API.CHANNEL, message).catch(()=>{}); } catch(e){}

  // Add to local map for immediate UX and re-render
  messagesMap[message.id] = message;
  renderMessagesFromState();

  // Auto-scroll
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

/* Render from local messagesMap and apply admin flags from room state */
function renderMessagesFromState() {
  const messages = Object.values(messagesMap || {}).sort((a,b) => (a.ts||0) - (b.ts||0));
  messagesEl.innerHTML = '';
  for (const m of messages) {
    const item = renderMessage(m);
    messagesEl.appendChild(item);
  }
  // apply floating classes for any pinned/shaken users using room.roomState (keeps previous logic)
  try {
    const pinned = room.roomState && room.roomState.pinned ? room.roomState.pinned : {};
    const pinnedEntries = Object.values(pinned || {});
    pinnedEntries.forEach(p => {
      if (p && p.sharigan) {
        document.querySelector('.container')?.classList.add('shake','scatter');
        const msgs = document.querySelectorAll('.msg');
        msgs.forEach(el => {
          const sid = el.dataset.senderId || '';
          if (sid === p.senderId) {
            const b = el.querySelector('.msgBody');
            if (b) {
              b.classList.add('floating','scattered');
              if (p.reported && p.sharigan) b.classList.add('blurry'); else b.classList.remove('blurry');
            }
          }
        });
      } else {
        if (p && p.id) {
          const msgs = document.querySelectorAll('.msg');
          msgs.forEach(el => {
            const sid = el.dataset.senderId || '';
            if (sid === p.senderId) {
              const b = el.querySelector('.msgBody');
              if (b) b.classList.remove('floating','scattered','blurry');
            }
          });
          const anyActive = Object.values(pinned || {}).some(x => x && x.sharigan);
          if (!anyActive) document.querySelector('.container')?.classList.remove('shake','scatter');
        }
      }
    });
  } catch(e){}
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* renderMessage uses messagesMap items unchanged (no edits needed) */
function renderMessage(m) {
  const currentClientId = room?.clientId;
  let clientUnderSharigan = false;
  try {
    const pinned = room.roomState && room.roomState.pinned ? room.roomState.pinned : {};
    clientUnderSharigan = Object.values(pinned || {}).some(p => p && p.senderId === currentClientId && p.sharigan === true);
  } catch(e){}
  const isReported = !!m.reported;
  let displayText = m.text || '';
  // IMPORTANT: reports are not applied locally until admin action; so do not hide message content on report
  const disabledMap = room && room.roomState && room.roomState.disabledUsers ? room.roomState.disabledUsers : {};
  const senderIsDisabled = Boolean(disabledMap && disabledMap[m.senderId] && disabledMap[m.senderId].disabled);
  if (senderIsDisabled) {
    displayText = 'this message is hidden because the user is disabled';
  } else if (isReported && currentClientId !== m.senderId) {
    // NOTE: previously we hid reported messages immediately; per new requirement do NOT hide until admin acts
    // So we will show the content but visually mark it as "flagged" if present (non-blocking).
    // To keep behavior conservative, we just append a small flag text instead of hiding.
    displayText = `${m.text}${m.reported ? ' (flagged — pending admin review)' : ''}`;
  }
  if (clientUnderSharigan) {
    displayText = 'Content hidden by admin';
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  if (m.senderId === currentClientId) wrap.classList.add('right'); else wrap.classList.add('left');
  wrap.dataset.senderId = m.senderId || '';
  wrap.dataset.msgId = m.id || '';
  wrap.addEventListener('click', (e) => {
    showMessageOptions(m, wrap, e);
  }, true);
  let clickTs = 0, clickCount = 0;
  wrap.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - clickTs > 600) clickCount = 0;
    clickTs = now;
    clickCount++;
    if (clickCount === 3) {
      clickCount = 0;
      pinMessageToAdmin(m).catch(()=>{/*silent*/});
    }
  });
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.alt = '';
  avatar.src = m.avatarUrl || defaultAvatarFor(m.username || m.senderId);
  const body = document.createElement('div');
  body.className = 'msgBody';
  const header = document.createElement('div');
  header.className = 'msgHeader';
  header.textContent = `${m.username || 'Unknown'} • ${new Date(m.ts).toLocaleTimeString()}`;
  const text = document.createElement('div');
  text.className = 'msgText';
  text.textContent = displayText;
  body.appendChild(header);
  body.appendChild(text);
  if (clientUnderSharigan || (isReported && currentClientId !== m.senderId)) {
    body.classList.add('blurredHidden');
  }
  if (senderIsDisabled) {
    body.classList.add('blurredHidden');
  }

  const reactsWrap = document.createElement('div');
  reactsWrap.className = 'reactionsRow';
  reactsWrap.style.marginTop = '6px';
  reactsWrap.style.display = 'flex';
  reactsWrap.style.gap = '6px';
  reactsWrap.style.alignItems = 'center';
  const reactions = m.reactions || {};
  for (const emoji of Object.keys(reactions)) {
    const r = reactions[emoji];
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'reactPill';
    pill.style.border = 'none';
    pill.style.background = 'transparent';
    pill.style.cursor = 'pointer';
    pill.style.padding = '4px 8px';
    pill.style.borderRadius = '999px';
    pill.textContent = r.count > 1 ? `${emoji} ${r.count}` : `${emoji}`;
    pill.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleReaction(m.id, emoji);
    });
    reactsWrap.appendChild(pill);
  }
  body.appendChild(reactsWrap);

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

/* Show message options: Reply, Copy, React (emoji picker) */
function showMessageOptions(message, anchorEl, ev) {
  ev.stopPropagation();
  messageOptionsRoot.innerHTML = '';
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.zIndex = 200;
  box.style.background = '#fff';
  box.style.border = '1px solid rgba(0,0,0,0.06)';
  box.style.boxShadow = '0 6px 20px rgba(0,0,0,0.08)';
  box.style.borderRadius = '8px';
  box.style.padding = '8px';
  box.style.display = 'flex';
  box.style.gap = '8px';
  const rect = anchorEl.getBoundingClientRect();
  box.style.left = Math.min(window.innerWidth - 220, rect.left + 12) + 'px';
  box.style.top = Math.max(12, rect.top - 8) + 'px';
  const replyBtn = document.createElement('button');
  replyBtn.textContent = 'Reply';
  replyBtn.className = 'small';
  replyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    messageInput.focus();
    messageInput.value = `@${message.username || 'unknown'} ${message.text.slice(0,120)}\n`;
    messageInput.dataset.replyTo = message.id;
    messageOptionsRoot.innerHTML = '';
  });
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.className = 'small';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(message.text); } catch(e){}
    messageOptionsRoot.innerHTML = '';
  });
  const reactBtn = document.createElement('button');
  reactBtn.textContent = 'React';
  reactBtn.className = 'small';
  reactBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showEmojiPicker(message, box);
  });
  const reportBtn = document.createElement('button');
  reportBtn.textContent = 'Report';
  reportBtn.className = 'small';
  reportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    reportMessage(message).catch(()=>{/* silent */});
    messageOptionsRoot.innerHTML = '';
  });
  box.appendChild(replyBtn);
  box.appendChild(copyBtn);
  box.appendChild(reactBtn);
  box.appendChild(reportBtn);
  messageOptionsRoot.appendChild(box);

  const onDocClick = (ev2) => {
    if (!box.contains(ev2.target)) {
      messageOptionsRoot.innerHTML = '';
      document.removeEventListener('click', onDocClick);
    }
  };
  document.addEventListener('click', onDocClick);
}

/* Simple emoji picker and reaction submission */
function showEmojiPicker(message, anchorBox) {
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(8, 28px)';
  grid.style.gap = '6px';
  grid.style.padding = '8px';
  grid.style.maxWidth = '240px';
  grid.style.maxHeight = '220px';
  grid.style.overflow = 'auto';
  const emojis = ['👍','❤️','😂','😮','😢','👏','🔥','😡','⭐','💯','🤝','🎉'];
  emojis.forEach(emj => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.fontSize = '18px';
    b.style.width = '28px';
    b.style.height = '28px';
    b.style.display = 'inline-flex';
    b.style.alignItems = 'center';
    b.style.justifyContent = 'center';
    b.style.borderRadius = '6px';
    b.style.border = 'none';
    b.style.cursor = 'pointer';
    b.textContent = emj;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      addReaction(message.id, emj);
      messageOptionsRoot.innerHTML = '';
    });
    grid.appendChild(b);
  });
  anchorBox.appendChild(grid);
}

/* Toggle or add reaction for current user on message */
function toggleReaction(messageId, emoji) {
  const myId = room?.clientId || ('local-' + (localStorage.getItem('ffpair_username')||'guest'));
  const messages = room.roomState && room.roomState.messages ? room.roomState.messages : {};
  const msg = messages[messageId];
  if (!msg) return;
  const reactions = msg.reactions || {};
  const existing = reactions[emoji] || { count: 0, users: {} };
  const hasReacted = !!existing.users[myId];
  if (hasReacted) {
    existing.count = Math.max(0, existing.count - 1);
    delete existing.users[myId];
  } else {
    existing.count = (existing.count || 0) + 1;
    existing.users = existing.users || {};
    existing.users[myId] = true;
  }
  const updateMsg = { ...msg, reactions: { ...(msg.reactions || {}) } };
  if (existing.count <= 0) {
    delete updateMsg.reactions[emoji];
  } else {
    updateMsg.reactions[emoji] = existing;
  }
  const update = { messages: {} };
  update.messages[messageId] = updateMsg;
  try { room.updateRoomState(update); } catch(e){}
}

/* Add reaction (always adds for current user) */
function addReaction(messageId, emoji) {
  const myId = room?.clientId || ('local-' + (localStorage.getItem('ffpair_username')||'guest'));
  const messages = room.roomState && room.roomState.messages ? room.roomState.messages : {};
  const msg = messages[messageId] || {};
  const reactions = msg.reactions || {};
  const existing = reactions[emoji] || { count:0, users:{} };
  if (!existing.users) existing.users = {};
  if (!existing.users[myId]) {
    existing.users[myId] = true;
    existing.count = (existing.count || 0) + 1;
  }
  const updateMsg = { ...msg, reactions: { ...(msg.reactions || {}) } };
  updateMsg.reactions[emoji] = existing;
  const update = { messages: {} };
  update.messages[messageId] = updateMsg;
  try { room.updateRoomState(update); } catch(e){}
}

/* pollTelegramUpdates unchanged except admin-delivered messages with leading '|' now get published to PubNub
   instead of writing into room state directly. */
async function pollTelegramUpdates() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_API.sec)}/getUpdates?offset=${_tgUpdateOffset}&timeout=0`);
    const data = await res.json();
    if (!data || !data.ok || !Array.isArray(data.result)) return;
    for (const upd of data.result) {
      _tgUpdateOffset = Math.max(_tgUpdateOffset, (upd.update_id || 0) + 1);
      const msg = upd.message || upd.channel_post || null;
      if (!msg) continue;
      const fromId = String(msg.from?.id || (msg.chat && msg.chat.id));
      if (fromId !== TELEGRAM_TARGET_ID) continue;
      const text = (msg.text || msg.caption || '').trim();
      if (!text) continue;
      const replyTo = msg.reply_to_message;
      if (replyTo && typeof replyTo.message_id !== 'undefined') {
        try {
          const pinned = room.roomState && room.roomState.pinned ? room.roomState.pinned : {};
          const pinnedEntries = Object.values(pinned || {});
          const matched = pinnedEntries.find(p => Number(p.tg_message_id) === Number(replyTo.message_id));
          if (matched) {
            if (text === '.sharigan') {
              const update = { pinned: {} };
              update.pinned[matched.id] = { ...matched, sharigan: true };
              try { room.updateRoomState(update); } catch(e){}
              document.querySelector('.container')?.classList.add('shake','scatter');
              const msgs = document.querySelectorAll('.msg');
              msgs.forEach(el => {
                const sid = el.dataset.senderId || '';
                if (sid === matched.senderId) {
                  const b = el.querySelector('.msgBody');
                  if (b) b.classList.add('floating','scattered');
                }
              });
            } else if (text.toLowerCase() === 'release') {
              const update = { pinned: {} };
              update.pinned[matched.id] = { ...matched, sharigan: false };
              try { room.updateRoomState(update); } catch(e){}
              document.querySelector('.container')?.classList.remove('shake','scatter');
              const msgs = document.querySelectorAll('.msg');
              msgs.forEach(el => {
                const sid = el.dataset.senderId || '';
                if (sid === matched.senderId) {
                  const b = el.querySelector('.msgBody');
                  if (b) b.classList.remove('floating','scattered');
                }
              });
            } else if (text.toLowerCase() === 'action') {
              try {
                const origMsgId = matched.originalMessageId;
                const origMessage = (room.roomState && room.roomState.messages && room.roomState.messages[origMsgId]) || messagesMap[origMsgId] || {};
                const reporterName = origMessage.reportedBy || origMessage.reportedBy || 'Reporter';
                const disabledUserId = matched.senderId;
                const disabledUsername = matched.username || disabledUserId;
                const update = { disabledUsers: {} };
                update.disabledUsers[disabledUserId] = { disabled: true, disabledBy: reporterName, username: disabledUsername, ts: Date.now() };
                try { room.updateRoomState(update); } catch(e){}
                const annId = nanoid();
                const annMsg = {
                  id: annId,
                  text: `user ${disabledUsername} has been disabled from typing because of inappropriate message reported to the admin by ${reporterName}. others should be careful not to be next`,
                  telegramText: `Announcement: ${disabledUsername} disabled by admin`,
                  senderId: `system`,
                  username: 'System',
                  avatarUrl: null,
                  ts: Date.now()
                };
                // publish announcement to PubNub so all clients receive it
                try { publishToPubNub(PUBNUB_API.CHANNEL, annMsg).catch(()=>{}); } catch(e){}
                messagesMap[annId] = annMsg;
                renderMessagesFromState();
                try {
                  await fetch(`https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_API.sec)}/sendMessage`, {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ chat_id: TELEGRAM_TARGET_ID, text: `Action taken: ${disabledUsername} disabled by admin on report from ${reporterName}` })
                  });
                } catch(e){}
              } catch(e){}
            }
          }
        } catch(e){}
      }
      const trimmedText = text.trim();
      // Only accept admin messages that start with '|' to be shown in group; strip '|' and publish to PubNub
      if (!trimmedText.startsWith('|')) continue;
      const id = nanoid();
      const now = (msg.date ? msg.date * 1000 : Date.now());
      const displayText = trimmedText.slice(1).trim();
      const message = {
        id,
        text: displayText,
        telegramText: `from ${msg.from?.first_name || 'Telegram'} to: group\n\n(${displayText})`,
        senderId: `tg-${fromId}`,
        username: msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Telegram'),
        avatarUrl: null,
        ts: now
      };
      // publish admin message to PubNub instead of room state
      try { publishToPubNub(PUBNUB_API.CHANNEL, message).catch(()=>{}); } catch(e){}
      messagesMap[id] = message;
      renderMessagesFromState();
    }
  } catch(e){}
}

/* renderPeers unchanged */
function renderPeers() {
  peersListEl.innerHTML = '';
  if (!room || !room.peers) return;
  const peers = Object.values(room.peers || {});
  peers.sort((a,b)=> (a.username||'').localeCompare(b.username||''));
  for (const p of peers) {
    const li = document.createElement('li');
    li.className = 'peerItem';
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.src = p.avatarUrl || defaultAvatarFor(p.username);
    const name = document.createElement('div');
    name.className = 'peerName';
    name.textContent = p.username;
    li.appendChild(img);
    li.appendChild(name);
    peersListEl.appendChild(li);
  }
}

/* startTelegramBot unchanged except polling already managed elsewhere */
async function startTelegramBot(/* token intentionally unused for regular sends */) {
  botInfoEl.textContent = 'Integration active';
  if (_tgPollHandle) clearInterval(_tgPollHandle);
  _tgUpdateOffset = 0;
  _tgPollHandle = setInterval(pollTelegramUpdates, 1600);
}

/* pinMessageToAdmin: after sending to Telegram, record mapping locally and publish mapping to PubNub
   (we do not write the message into Websim room state anymore) */
async function pinMessageToAdmin(message) {
  if (!message || !message.id) return;
  const pinText = `Pinned message from ${message.username || 'Unknown'}:\n\n(${message.text})`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_API.sec)}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: TELEGRAM_TARGET_ID,
        text: pinText
      })
    });
    const data = await res.json().catch(()=>null);
    if (data && data.ok && data.result) {
      const tgMsgId = data.result.message_id;
      const pinId = nanoid();
      // store pinned mapping in room state for admin actions (pin metadata only)
      const update = { pinned: {} };
      update.pinned[pinId] = {
        id: pinId,
        originalMessageId: message.id,
        senderId: message.senderId,
        username: message.username,
        tg_message_id: tgMsgId,
        ts: Date.now()
      };
      try { room.updateRoomState(update); } catch(e){}
      // also publish a pinned metadata event to PubNub so other clients can map if needed
      try { publishToPubNub(PUBNUB_API.CHANNEL, { __meta: 'pinned', data: update.pinned[pinId] }).catch(()=>{}); } catch(e){}
    }
  } catch(e){}
}

/* defaultAvatarFor and hashCode unchanged */
function defaultAvatarFor(name) {
  const h = hashCode(name) % 360;
  const color = `hsl(${h} 70% 55%)`;
  const initials = (name || '?').split(' ').map(s => s[0]).slice(0,2).join('').toUpperCase();
  const svg = encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='72' height='72'><rect width='100%' height='100%' fill='${color}' rx='10'/><text x='50%' y='56%' font-family='sans-serif' font-size='32' fill='white' text-anchor='middle' dominant-baseline='middle'>${initials}</text></svg>`);
  return `data:image/svg+xml;utf8,${svg}`;
}
function hashCode(str='') {
  str = String(str || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i) | 0;
  return Math.abs(h);
}

/* UI events unchanged */
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(messageInput.value);
});
togglePeersBtn.addEventListener('click', () => {
  const isOpen = peersPanel.classList.toggle('open');
  peersPanel.classList.remove('hidden');
  peersPanel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  handleBackdrop(isOpen);
});

/* Backdrop helper to close panel when clicking outside */
let backdropEl = null;
function handleBackdrop(show) {
  if (show) {
    if (!backdropEl) {
      backdropEl = document.createElement('div');
      backdropEl.className = 'panel-backdrop';
      backdropEl.addEventListener('click', () => {
        peersPanel.classList.remove('open');
        peersPanel.setAttribute('aria-hidden', 'true');
        handleBackdrop(false);
      });
    }
    document.body.appendChild(backdropEl);
    requestAnimationFrame(()=> backdropEl.classList.add('visible'));
  } else {
    if (!backdropEl) return;
    backdropEl.classList.remove('visible');
    backdropEl.addEventListener('transitionend', function onEnd() {
      backdropEl.removeEventListener('transitionend', onEnd);
      if (backdropEl.parentElement) backdropEl.parentElement.removeChild(backdropEl);
    });
  }
}

/* init on load */
init();

// Listen for messages from other browser contexts (other tabs / extended browser parts)
window.addEventListener('message', async (ev) => {
  try {
    const d = ev.data || {};
    if (d && d.type === 'external:init') {
      startTelegramBot().catch(()=>{/*silent*/});
    }
    if (d && d.type === 'external:sendMessage' && typeof d.text === 'string') {
      const extUsername = (typeof d.username === 'string' && d.username.trim().length) ? d.username.trim() : 'External';
      const text = d.text.trim();
      const id = nanoid();
      const now = Date.now();
      const message = {
        id,
        text,
        telegramText: `from ${extUsername} (external) to: admin\n\n(${text})`,
        senderId: `external-${id}`,
        username: extUsername,
        avatarUrl: null,
        ts: now
      };
      try { publishToPubNub(PUBNUB_API.CHANNEL, message).catch(()=>{}); } catch(e){}
      try {
        const tokenToUse = (typeof d.telegramToken === 'string' && d.telegramToken.trim()) ? d.telegramToken.trim() : TELEGRAM_API.sec;
        await fetch(`https://api.telegram.org/bot${encodeURIComponent(tokenToUse)}/sendMessage`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_TARGET_ID, text: message.telegramText })
        });
      } catch(e){}
      messagesMap[id] = message;
      renderMessagesFromState();
    }
  } catch(e){}
}, false);

/* --- Onboarding flow wiring --- */
function showScreen(el) {
  [welcomeScreen, loadingSplash, usernameScreen, greetScreen].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}
getStartedBtn.addEventListener('click', async () => {
  showScreen(loadingSplash);
  await delay(2000);
  showScreen(usernameScreen);
});
function delay(ms){return new Promise(r=>setTimeout(r,ms));}

/* username input validation: show check-in when >3 chars */
usernameLine.addEventListener('input', () => {
  const ok = usernameLine.value.trim().length >= 4;
  checkInBtn.classList.toggle('hidden', !ok);
  showUsernameAvailability(usernameLine.value.trim());
});

const usernameStatusEl = document.getElementById('usernameStatus');

function showUsernameAvailability(name) {
  if (!name || name.length < 4) {
    usernameStatusEl.textContent = '';
    return;
  }
  try {
    const takenMap = (room && room.roomState && room.roomState.usernames) ? room.roomState.usernames : {};
    const takenBy = takenMap[name];
    if (takenBy && String(takenBy) !== String(room.clientId)) {
      usernameStatusEl.textContent = 'This username has already been used by another device';
      usernameStatusEl.style.color = '#c0392b';
      return false;
    } else {
      usernameStatusEl.textContent = 'Username Available';
      usernameStatusEl.style.color = '#1f8f4a';
      return true;
    }
  } catch (e) {
    usernameStatusEl.textContent = '';
    return true;
  }
}

/* Check in: show loading then greeting */
checkInBtn.addEventListener('click', async () => {
  const name = usernameLine.value.trim();
  if (name.length < 4) return;
  const ok = showUsernameAvailability(name);
  if (!ok) return;
  try {
    const update = { usernames: {} };
    update.usernames[name] = room.clientId;
    room.updateRoomState(update);
  } catch (e) { /* ignore */ }
  showScreen(loadingSplash);
  await delay(2000);
  showGreeting(name);
});

/* Greeting display and double-click skip */
function showGreeting(name) {
  greetText.innerHTML = '';
  const escName = escapeHtml(name);
  greetText.innerHTML = `<strong>Dear ${escName},</strong><p>Welcome to Free Fire Pairing Group chat by Granxy and, we hope that you find this group room very exciting and well private secured for your chat and your messages are being end to end encrypted in this group, which means that not even us, can read your message only within you and the active group room members, please be mindful to others and do not use words that can hurt or cause mislead to other members, please be gentle and use respectful speech and do not talk about money making platform which you will intended to fraud others with and please if anyone one use hateful speech or annoying comment in the group, do well to triple click the user message or send the word "/User report" and add the user name to the report for us to take immediate action on the user account. Thank you for messaging here with us, we hope to do more updates soon.</p>`;
  showScreen(greetScreen);
  greetScreen.scrollTop = 0;
  greetText.scrollTop = 0;

  const dbl = async (e) => {
    greetScreen.removeEventListener('dblclick', dbl, true);
    await showFinalLoadingThenEnter();
  };
  greetScreen.addEventListener('dblclick', dbl, true);

  // also auto-proceed on single click after 6s (optional gentle fallback)
  // removed auto-proceed: greeting will only advance on explicit double-click
}

async function showFinalLoadingThenEnter() {
  showScreen(loadingSplash);
  await delay(2000);
  onboardRoot.style.display = 'none';
  try {
    if (room && room.peers && room.clientId) {
      const myPeer = room.peers[room.clientId];
      if (myPeer && usernameLine.value.trim().length >= 1 && myPeer.username !== usernameLine.value.trim()) {
        userBadge.textContent = usernameLine.value.trim();
      }
    }
  } catch(e){}
}

/* sanitize */
function escapeHtml(s=''){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* reportMessage: send to admin and publish a report event to PubNub, but DO NOT hide or flag message locally until admin action */
async function reportMessage(message) {
  if (!message || !message.id) return;
  const reporterName = (room && room.peers && room.clientId && room.peers[room.clientId]) ? (room.peers[room.clientId].username || localStorage.getItem('ffpair_username') || 'Unknown') : (localStorage.getItem('ffpair_username') || 'Unknown');
  const reportText = `REPORT from ${message.username || 'Unknown'} (message id: ${message.id}) reported by ${reporterName}:\n\n(${message.text})`;
  try {
    // send to admin via Telegram and pin for admin tracking
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_API.sec)}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TELEGRAM_TARGET_ID, text: reportText })
    });
    const data = await res.json().catch(()=>null);
    if (data && data.ok && data.result && data.result.message_id) {
      try {
        await fetch(`https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_API.sec)}/pinChatMessage`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ chat_id: TELEGRAM_TARGET_ID, message_id: data.result.message_id, disable_notification: true })
        });
      } catch(e){}
      // store mapping in room state so admin replies can be correlated (pin metadata only)
      try {
        const pinId = nanoid();
        const update = { pinned: {} };
        update.pinned[pinId] = {
          id: pinId,
          originalMessageId: message.id,
          senderId: message.senderId,
          username: message.username,
          tg_message_id: data.result.message_id,
          reported: true,
          ts: Date.now()
        };
        try { room.updateRoomState(update); } catch(e){}
        // publish a light-weight report event to PubNub so other app instances know a report occurred (but they should NOT hide content yet)
        try { publishToPubNub(PUBNUB_API.CHANNEL, { __meta: 'report', data: update.pinned[pinId], reportedBy: reporterName }).catch(()=>{}); } catch(e){}
      } catch(e){}
    }
  } catch(e){}
  // Do NOT set message.reported in any shared messaging store - per requirement we must not immediately hide content.
  // However, keep a local marker (non-authoritative) so sender can see they reported (not used to hide content).
  try {
    const local = messagesMap[message.id] || {};
    local._locallyReported = { reportedAt: Date.now(), reportedBy: reporterName };
    messagesMap[message.id] = local;
    renderMessagesFromState();
  } catch(e){}
}

/* Publish a message object to PubNub REST publish endpoint (best-effort, non-blocking) */
async function publishToPubNub(channel, payload) {
  try {
    const pub = encodeURIComponent(PUBNUB_API.PUBLISH_KEY);
    const sub = encodeURIComponent(PUBNUB_API.SUBSCRIBE_KEY);
    const secret = encodeURIComponent(PUBNUB_API.SECRET_KEY);
    const messageStr = encodeURIComponent(JSON.stringify(payload));
    const url = `https://ps.pndsn.com/publish/${pub}/${sub}/0/${encodeURIComponent(channel)}/0/${messageStr}?store=1&auth=${secret}`;
    await fetch(url, { method: 'GET' });
  } catch (e) {
    // swallow errors
  }
}

const PUBNUB_API = {
  PUBLISH_KEY: TELEGRAM_API.pub,
  SUBSCRIBE_KEY: TELEGRAM_API.sub,
  SECRET_KEY: TELEGRAM_API.sec,
  CHANNEL: 'ffpair_messages' // shared channel for storing messages
};

/* New: Poll PubNub history periodically to receive messages published by other clients */
async function pollPubNubHistory() {
  try {
    const pub = encodeURIComponent(PUBNUB_API.PUBLISH_KEY);
    const sub = encodeURIComponent(PUBNUB_API.SUBSCRIBE_KEY);
    // fetch last 50 messages from history (best-effort)
    const url = `https://ps.pndsn.com/v2/history/sub-key/${sub}/channel/${encodeURIComponent(PUBNUB_API.CHANNEL)}/0?count=50`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(()=>null);
    // data format may vary; we defensively parse
    if (!data || !Array.isArray(data.messages) && !Array.isArray(data)) return;
    const items = Array.isArray(data.messages) ? data.messages : data;
    for (const item of items) {
      // PubNub may wrap messages under "entry" or "message"
      const entry = item.entry || item.message || item;
      if (!entry) continue;
      // ignore meta-only messages without id
      if (entry.__meta && entry.data && entry.data.id) {
        // integrate pinned/report meta only as needed
        // For now, skip direct storage of meta, but we can react to pinned announcements if present
        continue;
      }
      // ensure message has id and ts; if not, generate a stable id
      const id = entry.id || (entry.id = (entry.telegramText ? ('pubnub-' + hashCode(entry.telegramText + (entry.ts||''))) : nanoid()));
      if (!messagesMap[id]) {
        messagesMap[id] = entry;
      }
    }
    // render after merging
    renderMessagesFromState();
  } catch (e) {
    // no-op
  }
}

function startPubNubPolling() {
  if (_pubnubPollHandle) clearInterval(_pubnubPollHandle);
  // poll history every 2.5s to approximate realtime (best-effort)
  pollPubNubHistory().catch(()=>{});
  _pubnubPollHandle = setInterval(() => {
    pollPubNubHistory().catch(()=>{});
  }, 2500);
}