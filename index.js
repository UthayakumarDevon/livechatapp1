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
});

// ===== Multer setup =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Upload route
app.post('/upload', upload.single('file'), (req, res) => {
  const fileUrl = '/uploads/' + req.file.filename;
  res.json({ url: fileUrl });
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log('User connected');

  socket.on('join', ({ room, name }) => {
    socket.join(room);
    socket.data.name = name;

    db.get(`SELECT msgId FROM last_seen WHERE room=? AND user=?`, [room, name], (err, row) => {
      const lastSeenId = row ? row.msgId : null;
      socket.emit('lastSeenId', lastSeenId);

      db.all(`SELECT * FROM messages WHERE room=? ORDER BY ts ASC`, [room], (err, rows) => {
        socket.emit('history', rows);

        db.all(`SELECT msgId, emoji, COUNT(*) as count 
                FROM reactions WHERE room=? GROUP BY msgId, emoji`, [room], (err, reacts) => {
          reacts.forEach(r => {
            socket.emit('reaction', { id: r.msgId, emoji: r.emoji, count: r.count });
          });
        });
      });
    });

    socket.emit('joined', { room, name });
  });

  socket.on('message', ({ room, id, text }) => {
    const sender = socket.data.name || 'Anon';
    const ts = Date.now();
    db.run(`INSERT INTO messages (id, room, sender, text, ts) VALUES (?, ?, ?, ?, ?)`,
      [id, room, sender, text, ts]);
    io.to(room).emit('message', { id, sender, text, ts });
    io.to(room).emit('delivered', { id });
  });

  socket.on('fileMessage', ({ room, id, fileUrl, fileType }) => {
    const sender = socket.data.name || 'Anon';
    const ts = Date.now();
    db.run(`INSERT INTO messages (id, room, sender, text, ts, fileUrl, fileType)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, room, sender, '', ts, fileUrl, fileType]);
    io.to(room).emit('message', { id, sender, text: '', ts, fileUrl, fileType });
    io.to(room).emit('delivered', { id });
  });

  socket.on('seen', ({ room, id }) => {
    const user = socket.data.name || 'Anon';
    io.to(room).emit('seen', { id, names: [user] });
  });

  socket.on('updateLastSeen', ({ room, user, id }) => {
    db.run(`INSERT INTO last_seen (room, user, msgId) VALUES (?, ?, ?)
            ON CONFLICT(room, user) DO UPDATE SET msgId=excluded.msgId`,
      [room, user, id]);
  });

  socket.on('typing', ({ room, name, typing }) => {
    socket.to(room).emit('typing', { name, typing });
  });

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

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});