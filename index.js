const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

app.use(express.static('public'));

// ===== SQLite setup =====
const db = new sqlite3.Database('chat.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room TEXT,
    sender TEXT,
    text TEXT,
    ts INTEGER,
    fileUrl TEXT,
    fileType TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS last_seen (
    room TEXT,
    user TEXT,
    msgId TEXT,
    PRIMARY KEY (room, user)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    msgId TEXT,
    room TEXT,
    user TEXT,
    emoji TEXT,
    PRIMARY KEY (msgId, room, user, emoji)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS room_backgrounds (
    room TEXT PRIMARY KEY,
    url TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    avatarUrl TEXT
  )`);
});

// ===== Multer setup =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Upload route
app.post('/upload', upload.single('file'), (req, res) => {
  const fileUrl = '/uploads/' + req.file.filename;
  res.json({ url: fileUrl });
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log('User connected');

  // Background change (save + broadcast)
  socket.on('backgroundChange', ({ room, url }) => {
    db.run(`INSERT INTO room_backgrounds (room, url) VALUES (?, ?)
            ON CONFLICT(room) DO UPDATE SET url=excluded.url`, [room, url]);
    io.to(room).emit('backgroundChange', { url });
  });

  // Avatar change (save + broadcast)
  socket.on('avatarChange', ({ name, url }) => {
    db.run(`INSERT INTO users (name, avatarUrl) VALUES (?, ?)
            ON CONFLICT(name) DO UPDATE SET avatarUrl=excluded.avatarUrl`, [name, url]);
    io.emit('avatarChange', { name, url });
  });

  // Join room
  socket.on('join', ({ room, name }) => {
    socket.join(room);
    socket.data.name = name;

    // Last seen
    db.get(`SELECT msgId FROM last_seen WHERE room=? AND user=?`, [room, name], (err, row) => {
      const lastSeenId = row ? row.msgId : null;
      socket.emit('lastSeenId', lastSeenId);

      // History with avatars
      db.all(`SELECT m.*, u.avatarUrl 
              FROM messages m 
              LEFT JOIN users u ON m.sender = u.name 
              WHERE room=? ORDER BY ts ASC`, [room], (err, rows) => {
        socket.emit('history', rows);

        // Existing reactions
        db.all(`SELECT msgId, emoji, COUNT(*) as count 
                FROM reactions WHERE room=? GROUP BY msgId, emoji`, [room], (err, reacts) => {
          reacts.forEach(r => {
            socket.emit('reaction', { id: r.msgId, emoji: r.emoji, count: r.count });
          });
        });
      });
    });

    // Send saved background for this room
    db.get(`SELECT url FROM room_backgrounds WHERE room=?`, [room], (err, row) => {
      if (row && row.url) {
        socket.emit('backgroundChange', { url: row.url });
      }
    });

    // Send saved avatar for this user
    db.get(`SELECT avatarUrl FROM users WHERE name=?`, [name], (err, row) => {
      if (row && row.avatarUrl) {
        socket.emit('avatarChange', { name, url: row.avatarUrl });
      }
    });

    socket.emit('joined', { room, name });
  });

  // Text message
  socket.on('message', ({ room, id, text }) => {
    const sender = socket.data.name || 'Anon';
    const ts = Date.now();

    db.get(`SELECT avatarUrl FROM users WHERE name=?`, [sender], (err, row) => {
      const avatarUrl = row ? row.avatarUrl : null;

      db.run(`INSERT INTO messages (id, room, sender, text, ts) VALUES (?, ?, ?, ?, ?)`,
        [id, room, sender, text, ts]);

      io.to(room).emit('message', { id, sender, text, ts, avatarUrl });
      io.to(room).emit('delivered', { id });
    });
  });

  // File message
  socket.on('fileMessage', ({ room, id, fileUrl, fileType }) => {
    const sender = socket.data.name || 'Anon';
    const ts = Date.now();

    db.get(`SELECT avatarUrl FROM users WHERE name=?`, [sender], (err, row) => {
      const avatarUrl = row ? row.avatarUrl : null;

      db.run(`INSERT INTO messages (id, room, sender, text, ts, fileUrl, fileType)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, room, sender, '', ts, fileUrl, fileType]);

      io.to(room).emit('message', { id, sender, text: '', ts, fileUrl, fileType, avatarUrl });
      io.to(room).emit('delivered', { id });
    });
  });

  // ===== Seen handler (fixed) =====
  socket.on('seen', ({ room, id }) => {
    const viewer = socket.data.name || 'Anon';

    // Lookup the original sender
    db.get(`SELECT sender FROM messages WHERE id=? AND room=?`, [id, room], (err, row) => {
      if (!row || !row.sender) return;
      const sender = row.sender;

      // Only emit seen if viewer is not the sender
      if (viewer !== sender) {
        io.to(room).emit('seen', { id, names: [viewer, sender] });
      }
    });
  });

  // Update last seen
  socket.on('updateLastSeen', ({ room, user, id }) => {
    db.run(`INSERT INTO last_seen (room, user, msgId) VALUES (?, ?, ?)
            ON CONFLICT(room, user) DO UPDATE SET msgId=excluded.msgId`,
      [room, user, id]);
  });

  // Typing indicator
  socket.on('typing', ({ room, name, typing }) => {
    io.to(room).emit('typing', { name, typing });
  });

  // Reactions (toggle)
  socket.on('reaction', ({ room, id, emoji }) => {
    const user = socket.data.name || 'Anon';
    db.get(`SELECT 1 FROM reactions WHERE msgId=? AND room=? AND user=? AND emoji=?`,
      [id, room, user, emoji], (err, row) => {
        if (row) {
          db.run(`DELETE FROM reactions WHERE msgId=? AND room=? AND user=? AND emoji=?`,
            [id, room, user, emoji], () => {
              db.get(`SELECT COUNT(*) as count FROM reactions WHERE msgId=? AND room=? AND emoji=?`,
                [id, room, emoji], (err, row) => {
                  const count = row ? row.count : 0;
                  io.to(room).emit('reaction', { id, emoji, count });
                });
            });
        } else {
          db.run(`INSERT INTO reactions (msgId, room, user, emoji) VALUES (?, ?, ?, ?)`,
            [id, room, user, emoji], () => {
              db.get(`SELECT COUNT(*) as count FROM reactions WHERE msgId=? AND room=? AND emoji=?`,
                [id, room, emoji], (err, row) => {
                  const count = row ? row.count : 0;
                  io.to(room).emit('reaction', { id, emoji, count });
                });
            });
        }
      });
  });

  socket.on('disconnect', () => console.log('User disconnected'));
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
