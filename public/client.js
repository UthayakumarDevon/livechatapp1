// ===== Socket connection =====
// IMPORTANT: Replace the URL below with your actual backend host (Render, Railway, etc.)
const socket = io("https://your-backend.onrender.com");

const chat = document.getElementById('chat');
const msgInput = document.getElementById('msgInput');
const typingDiv = document.getElementById('typing');
let currentRoom = null;
let myName = null;
let lastSeenId = null;
let unreadInserted = false;
let lastRenderedDate = null; // track last date divider

// ===== Join =====
document.getElementById('joinBtn').onclick = () => {
  const room = document.getElementById('roomInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();
  if (room && name) socket.emit('join', { room, name });
};

socket.on('joined', ({ room, name }) => {
  currentRoom = room; myName = name;
  appendNotice(`You joined ${room} as ${name}`);
});

// ===== Last seen ID =====
socket.on('lastSeenId', id => {
  lastSeenId = id;
});

socket.on('history', rows => {
  lastRenderedDate = null; // reset when loading history
  rows.forEach(r => renderMessage(r.id, r.sender, r.text, r.ts, r.fileUrl, r.fileType));

  if (lastSeenId) {
    const lastRow = document.getElementById('msg-' + lastSeenId);
    const lastIndex = rows.findIndex(r => r.id === lastSeenId);

    if (lastRow && lastIndex !== -1 && lastIndex < rows.length - 1 && !unreadInserted) {
      const divider = document.createElement('div');
      divider.className = 'notice unread';
      divider.textContent = 'Unread messages';
      lastRow.insertAdjacentElement('afterend', divider);
      unreadInserted = true;

      const offset = lastRow.offsetTop - (chat.clientHeight * 0.8);
      chat.scrollTo({ top: offset > 0 ? offset : 0, behavior: 'auto' });
    }
  } else {
    setTimeout(scrollToBottom, 0);
  }

  setTimeout(markSeenVisible, 50);
});

// ===== Incoming message =====
socket.on('message', msg => {
  renderMessage(msg.id, msg.sender, msg.text, msg.ts, msg.fileUrl, msg.fileType);
  markSeenVisible();
  if (isAtBottom()) scrollToBottom();
});

// ===== Delivered / Seen =====
socket.on('delivered', ({ id }) => setTicks(id, '✓', 'delivered'));
socket.on('seen', ({ id, names }) => {
  const row = document.getElementById('msg-' + id);
  if (!row) return;
  row.dataset.seenNames = JSON.stringify(names);
  const tickEl = row.querySelector('.ticks');
  if (tickEl) {
    tickEl.textContent = names.length === 1
      ? `✓✓ seen by ${names[0]}`
      : `✓✓ seen by ${names.length} people`;
    tickEl.className = 'ticks seen';
  }
});

// ===== Typing =====
msgInput.addEventListener('input', () => {
  if (!currentRoom) return;
  const isTyping = msgInput.value.length > 0;
  socket.emit('typing', { room: currentRoom, name: myName, typing: isTyping });

  typingDiv.innerHTML = isTyping
    ? `<div>${myName || 'You'} are typing 
         <span class="typing-indicator"><span></span><span></span><span></span></span>
       </div>`
    : '';
  typingDiv.classList.toggle('hidden', !isTyping);
});

socket.on('typing', ({ name, typing }) => {
  if (typing && name !== myName) {
    typingDiv.innerHTML = `<div>${name} is typing 
      <span class="typing-indicator"><span></span><span></span><span></span></span></div>`;
    typingDiv.classList.remove('hidden');
  } else if (!typing) {
    typingDiv.classList.add('hidden');
    setTimeout(() => typingDiv.textContent = '', 300);
  }
});

// ===== Send =====
document.getElementById('sendBtn').onclick = () => {
  const text = msgInput.value.trim();
  if (!text || !currentRoom) return;
  const id = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  socket.emit('message', { room: currentRoom, id, text });
  msgInput.value = '';
  socket.emit('typing', { room: currentRoom, name: myName, typing: false });
  typingDiv.classList.add('hidden');
  typingDiv.textContent = '';

  lastSeenId = id;
  socket.emit('updateLastSeen', { room: currentRoom, user: myName, id });

  scrollToBottom();
};
// ===== Upload =====
document.getElementById('uploadBtn').onclick = () => {
  document.getElementById('fileInput').click();
};

document.getElementById('fileInput').onchange = async () => {
  const fileInput = document.getElementById('fileInput');
  if (!fileInput.files.length || !currentRoom) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  try {
    // IMPORTANT: Use your backend host URL here
    const res = await fetch("https://your-backend.onrender.com/upload", {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    const id = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const fileType = fileInput.files[0].type.startsWith('image') ? 'image'
                  : fileInput.files[0].type.startsWith('video') ? 'video'
                  : 'file';

    socket.emit('fileMessage', { room: currentRoom, id, fileUrl: data.url, fileType });
    fileInput.value = '';
  } catch (err) {
    console.error('Upload failed:', err);
  }
};

// ===== Dark mode =====
document.getElementById('darkBtn').onclick = () => {
  document.body.classList.toggle('dark');
};

// ===== Reflect reactions =====
socket.on('reaction', ({ id, emoji, count }) => {
  const row = document.getElementById('msg-' + id);
  if (!row) return;
  const target = row.querySelector('.reaction-display');
  if (!target) return;

  let existing = target.querySelector(`span[data-emoji="${emoji}"]`);
  if (!existing && count > 0) {
    existing = document.createElement('span');
    existing.dataset.emoji = emoji;
    target.appendChild(existing);
  }

  if (count > 0) {
    existing.textContent = `${emoji} ${count}`;
  } else if (existing) {
    existing.remove();
  }
});

// ===== Date label helper =====
function formatDayLabel(ts) {
  const msgDate = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const msgDay = msgDate.toDateString();
  if (msgDay === today.toDateString()) return "Today";
  if (msgDay === yesterday.toDateString()) return "Yesterday";
  return msgDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderMessage(id, sender, text, ts, fileUrl, fileType) {
  const msgDate = new Date(ts);
  const dayString = msgDate.toDateString();
  const dayLabel = formatDayLabel(ts);

  // Insert date divider if this is the first message of the day
  if (lastRenderedDate !== dayString) {
    const divider = document.createElement('div');
    divider.className = 'notice date-divider';
    divider.textContent = dayLabel;
    chat.appendChild(divider);
    lastRenderedDate = dayString;
  }

  const isOut = sender === myName;
  const row = document.createElement('div');
  row.className = 'row ' + (isOut ? 'out' : 'in');
  row.id = 'msg-' + id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = (sender || '?').charAt(0).toUpperCase();

  const content = document.createElement('div');
  content.className = 'content';

  const textEl = document.createElement('div');
  if (fileUrl) {
    if (fileType === 'image') {
      textEl.innerHTML = `<strong>${escapeHtml(sender)}:</strong><br>
        <img src="${fileUrl}" style="max-width:200px;border-radius:8px;cursor:pointer;">`;
      textEl.querySelector('img').onclick = () => openPreview(
        `<img src="${fileUrl}" style="max-width:90%;max-height:90%;border-radius:8px;">`
      );
    } else if (fileType === 'video') {
      textEl.innerHTML = `<strong>${escapeHtml(sender)}:</strong><br>
        <video src="${fileUrl}" controls style="max-width:250px;border-radius:8px;cursor:pointer;"></video>`;
      textEl.querySelector('video').onclick = () => openPreview(
        `<video src="${fileUrl}" controls autoplay style="max-width:90%;max-height:90%;border-radius:8px;"></video>`
      );
    } else {
      textEl.innerHTML = `<strong>${escapeHtml(sender)}:</strong><br>
        <span style="color:blue;cursor:pointer;">Download file</span>`;
      textEl.querySelector('span').onclick = () => openPreview(
        `<iframe src="${fileUrl}" style="width:80vw;height:80vh;border:none;"></iframe>`
      );
    }
  } else {
    textEl.innerHTML = `<strong>${escapeHtml(sender)}:</strong> ${escapeHtml(text)}`;
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'ts';
  timeEl.textContent = msgDate.toLocaleTimeString();
  meta.appendChild(timeEl);

  if (isOut) {
    const tickEl = document.createElement('span');
    tickEl.className = 'ticks';
    tickEl.textContent = '✓';
    meta.appendChild(tickEl);
  }

  const reactEl = document.createElement('div');
  reactEl.className = 'reaction-display';

  content.appendChild(textEl);
  content.appendChild(meta);
  content.appendChild(reactEl);

  bubble.appendChild(avatar);
  bubble.appendChild(content);
  row.appendChild(bubble);
  chat.appendChild(row);

  // Context menus
  bubble.oncontextmenu = (e) => {
    e.preventDefault();
    if (isOut) {
      showSenderPopup(bubble, id);
    } else {
      showReactionPopup(bubble, id);
    }
  };

  // Long press (mobile)
  setupLongPress(bubble, () => {
    if (isOut) {
      showSenderPopup(bubble, id);
    } else {
      showReactionPopup(bubble, id);
    }
  });
}

// ===== Emoji popup (receivers) =====
function showReactionPopup(bubble, id) {
  const old = document.querySelector('.reaction-popup');
  if (old) old.remove();

  const popup = document.createElement('div');
  popup.className = 'reaction-popup';
  const emojis = ['👍','❤️','😊','😡','😉','😅','😮','😢','🙏'];

  emojis.forEach(e => {
    const span = document.createElement('span');
    span.textContent = e;
    span.onclick = () => {
      popup.classList.remove('show');
      setTimeout(() => popup.remove(), 250);
      socket.emit('reaction', { room: currentRoom, id, emoji: e });
    };
    popup.appendChild(span);
  });

  chat.appendChild(popup);
  const bubbleRect = bubble.getBoundingClientRect();
  popup.style.left = `${bubbleRect.left}px`;
  popup.style.top = `${bubbleRect.bottom + 5}px`;
  requestAnimationFrame(() => popup.classList.add('show'));

  const onDocClick = (ev) => {
    if (!popup.contains(ev.target)) {
      popup.classList.remove('show');
      setTimeout(() => popup.remove(), 250);
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

// ===== Combined popup for sender (Seen + Emoji) =====
function showSenderPopup(bubble, id) {
  const row = document.getElementById('msg-' + id);
  if (!row) return;
  const names = JSON.parse(row.dataset.seenNames || '[]');

  const old = document.querySelector('.sender-popup');
  if (old) old.remove();

  const popup = document.createElement('div');
  popup.className = 'sender-popup';

  if (names.length) {
    const seenDiv = document.createElement('div');
    seenDiv.textContent = 'Seen by: ' + names.join(', ');
    popup.appendChild(seenDiv);
  }

const emojis = ['👍','❤️','😊','😡','😉','😅','😮','😢','🙏'];
const emojiDiv = document.createElement('div');
emojis.forEach(e => {
  const span = document.createElement('span');
  span.textContent = e;
  span.onclick = () => {
    socket.emit('reaction', { room: currentRoom, id, emoji: e });
    popup.remove();
  };
  emojiDiv.appendChild(span);
});
popup.appendChild(emojiDiv);

chat.appendChild(popup);
const bubbleRect = bubble.getBoundingClientRect();
popup.style.left = `${bubbleRect.left}px`;
popup.style.top = `${bubbleRect.bottom + 5}px`;   // <-- this line was cut off
requestAnimationFrame(() => popup.classList.add('show'));

const onDocClick = (ev) => {
  if (!popup.contains(ev.target)) {
    popup.classList.remove('show');
    setTimeout(() => popup.remove(), 250);
    document.removeEventListener('click', onDocClick);
  }
};
setTimeout(() => document.addEventListener('click', onDocClick), 0);
  chat.appendChild(popup);
  const bubbleRect = bubble.getBoundingClientRect();
  popup.style.left = `${bubbleRect.left}px`;
  popup.style.top = `${bubbleRect.bottom + 5}px`;
  requestAnimationFrame(() => popup.classList.add('show'));

  const onDocClick = (ev) => {
    if (!popup.contains(ev.target)) {
      popup.classList.remove('show');
      setTimeout(() => popup.remove(), 250);
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

// ===== Preview overlay =====
function openPreview(html) {
  const overlay = document.getElementById('previewOverlay');
  const content = document.getElementById('previewContent');
  content.innerHTML = html;
  overlay.classList.remove('hidden');
  overlay.onclick = () => {
    overlay.classList.add('hidden');
    content.innerHTML = '';
  };
}

// ===== Helpers =====
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[m]));
}

function appendNotice(text) {
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  chat.appendChild(div);
}

function scrollToBottom() { chat.scrollTop = chat.scrollHeight; }

function isAtBottom() {
  return chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 5;
}

function setTicks(id, symbol, cls) {
  const row = document.getElementById('msg-' + id);
  if (!row) return;
  const tickEl = row.querySelector('.ticks');
  if (tickEl) {
    tickEl.textContent = symbol;
    tickEl.className = 'ticks ' + cls;
  }
}

function markSeenVisible() {
  const rows = chat.querySelectorAll('.row.out');
  rows.forEach(r => {
    const rect = r.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
      socket.emit('seen', { room: currentRoom, id: r.id.replace('msg-', '') });
    }
  });
}

function setupLongPress(el, callback) {
  let timer;
  el.addEventListener('touchstart', () => {
    timer = setTimeout(callback, 600);
  });
  el.addEventListener('touchend', () => {
    clearTimeout(timer);
  });
}
