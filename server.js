const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STATE ─────────────────────────────────────────────────────────
// rooms: { [roomId]: { id, name, createdAt, seats, queue, history, round } }
const rooms = {};

// Clean up empty rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((rid) => {
    const r = rooms[rid];
    const age = now - r.createdAt;
    // Remove rooms older than 6h with no players
    if (age > 6 * 3600 * 1000 && (!r._sockets || r._sockets.size === 0)) {
      delete rooms[rid];
      console.log(`🗑 Cleaned up empty room: ${rid}`);
    }
  });
}, 30 * 60 * 1000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const DICE_FACES = ['⚀','⚁','⚂','⚃','⚄','⚅'];
const DIR_LABELS = { east:'东', south:'南', west:'西', north:'北' };
const SEAT_ORDER = ['east','south','west','north'];
const MAX_QUEUE = 20;
const MAX_HISTORY = 20;

function randomDice() {
  return { num: Math.floor(Math.random() * 6) + 1, face: DICE_FACES[Math.floor(Math.random() * 6)] };
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/room/:id', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: '房间不存在或已过期' });
  const { _sockets, _hostSocketId, ...safe } = r;
  res.json(safe);
});

app.get('/api/stats', (_req, res) => {
  res.json({ rooms: Object.keys(rooms).length, uptime: process.uptime() });
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  // ── Create Room ────────────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName }, callback) => {
    if (!playerName || playerName.trim().length === 0) {
      return callback({ ok: false, error: '请输入名字' });
    }
    const roomId = uuidv4().slice(0, 8);
    const room = {
      id: roomId,
      name: `${escHtml(playerName.trim())}的房间`,
      createdAt: Date.now(),
      round: 1,
      queue: [{ id: uuidv4(), name: escHtml(playerName.trim()), ts: Date.now() }],
      seats: {},
      history: [],
      _sockets: new Set([socket.id]),
      _hostSocketId: socket.id,
    };
    rooms[roomId] = room;
    socket.join(roomId);
    socket._roomId = roomId;
    console.log(`🏠 Room created: ${roomId} by ${playerName}`);
    callback({ ok: true, roomId, room: safeRoom(room) });
  });

  // ── Join Room ───────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId, playerName }, callback) => {
    if (!playerName || playerName.trim().length === 0) {
      return callback({ ok: false, error: '请输入名字' });
    }
    const room = rooms[roomId];
    if (!room) return callback({ ok: false, error: '房间不存在或已过期，请重新创建' });

    const cleanName = escHtml(playerName.trim());
    const existingPlayer = room.queue.find(p => p.name === cleanName);

    if (existingPlayer) {
      // Name exists - check if it's a reconnect (same socket or allow rejoin)
      // For simplicity, we'll remove the old entry and let them rejoin
      room.queue = room.queue.filter(p => p.name !== cleanName);
      console.log(`🔄 ${cleanName} rejoined room ${roomId}`);
    }

    if (room.queue.length >= MAX_QUEUE) {
      return callback({ ok: false, error: `房间已满（最多${MAX_QUEUE}人）` });
    }
    room.queue.push({ id: uuidv4(), name: cleanName, ts: Date.now() });
    room._sockets.add(socket.id);
    socket.join(roomId);
    socket._roomId = roomId;
    io.to(roomId).emit('queue_updated', room.queue);
    console.log(`➕ ${playerName} joined room ${roomId} (${room.queue.length} players)`);
    callback({ ok: true, roomId, room: safeRoom(room) });
  });

  // ── Leave Room ──────────────────────────────────────────────────────────────
  socket.on('leave_room', () => {
    handleLeave(socket);
  });

  // ── Sign Up ─────────────────────────────────────────────────────────────────
  socket.on('signup', ({ playerName }, callback) => {
    const room = rooms[socket._roomId];
    if (!room) return callback({ ok: false, error: '未加入房间' });
    const name = escHtml(playerName.trim());
    if (!name) return callback({ ok: false, error: '名字不能为空' });
    if (room.queue.length >= MAX_QUEUE) return callback({ ok: false, error: '队列已满' });
    if (room.queue.some(p => p.name === name)) return callback({ ok: false, error: '这个名字已经报名了' });
    room.queue.push({ id: uuidv4(), name, ts: Date.now() });
    io.to(socket._roomId).emit('queue_updated', room.queue);
    callback({ ok: true, queue: room.queue });
  });

  // ── Cancel Signup ──────────────────────────────────────────────────────────
  socket.on('cancel_signup', ({ playerId }, callback) => {
    const room = rooms[socket._roomId];
    if (!room) return callback({ ok: false, error: '未加入房间' });
    room.queue = room.queue.filter(p => p.id !== playerId);
    io.to(socket._roomId).emit('queue_updated', room.queue);
    callback({ ok: true, queue: room.queue });
  });

  // ── Draw Seats ──────────────────────────────────────────────────────────────
  socket.on('draw_seats', (callback) => {
    const room = rooms[socket._roomId];
    if (!room) return callback({ ok: false, error: '未加入房间' });
    if (room.queue.length < 4) return callback({ ok: false, error: '至少需要4人才能开打' });

    const players = room.queue.slice(0, 4);
    const diceResults = {};
    SEAT_ORDER.forEach(dir => { diceResults[dir] = randomDice(); });

    // Highest dice → East, second → South, etc.
    const sorted = [...SEAT_ORDER].sort((a, b) => diceResults[b].num - diceResults[a].num);
    const seats = {};
    SEAT_ORDER.forEach(dir => { seats[dir] = { name: null, dice: diceResults[dir] }; });
    sorted.forEach((dir, i) => { seats[dir].name = players[i].name; });

    // Save to history
    const entry = {
      id: uuidv4(),
      round: room.round,
      seats: JSON.parse(JSON.stringify(seats)),
      time: new Date().toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }),
    };
    room.history.unshift(entry);
    if (room.history.length > MAX_HISTORY) room.history = room.history.slice(0, MAX_HISTORY);

    // Broadcast draw result
    io.to(socket._roomId).emit('draw_result', {
      round: room.round,
      seats,
      history: room.history,
      diceResults,
    });

    // Clear queue and advance round
    room.queue = room.queue.slice(4);
    room.round++;

    io.to(socket._roomId).emit('queue_updated', room.queue);
    io.to(socket._roomId).emit('room_updated', safeRoom(room));

    callback({ ok: true, seats, round: room.round, queue: room.queue });
    console.log(`🎲 Room ${socket._roomId} drew seats, round ${room.round}`);
  });

  // ── Re-roll Single Seat ─────────────────────────────────────────────────────
  socket.on('reroll_seat', ({ dir }, callback) => {
    const room = rooms[socket._roomId];
    if (!room) return callback({ ok: false, error: '未加入房间' });
    const newDice = randomDice();
    if (room.seats[dir]) {
      room.seats[dir].dice = newDice;
    }
    io.to(socket._roomId).emit('seat_rerolled', { dir, dice: newDice });
    callback({ ok: true, dice: newDice });
  });

  // ── Reset Game ──────────────────────────────────────────────────────────────
  socket.on('reset_game', (callback) => {
    const room = rooms[socket._roomId];
    if (!room) return callback({ ok: false, error: '未加入房间' });
    room.queue = [];
    room.seats = {};
    room.round = 1;
    room.history = [];
    io.to(socket._roomId).emit('room_reset', safeRoom(room));
    callback({ ok: true });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log(`🔌 ${socket.id} disconnected`);
  });

  // ── Helper: Leave Room ──────────────────────────────────────────────────────
  function handleLeave(sock) {
    const rid = sock._roomId;
    if (!rid) return;
    const room = rooms[rid];
    if (!room) return;
    room._sockets.delete(sock.id);
    sock.leave(rid);
    // If host leaves, assign new host
    if (room._hostSocketId === sock.id && room._sockets.size > 0) {
      room._hostSocketId = [...room._sockets][0];
    }
    // If room is empty, schedule deletion
    if (room._sockets.size === 0) {
      setTimeout(() => {
        if (room._sockets.size === 0) {
          delete rooms[rid];
          console.log(`🗑 Room ${rid} removed (empty)`);
        }
      }, 10 * 60 * 1000); // 10 min
    }
    sock._roomId = null;
  }
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function safeRoom(room) {
  const { _sockets, _hostSocketId, ...safe } = room;
  return { ...safe, playerCount: _sockets ? _sockets.size : 0 };
}

// ─── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🀄 麻将局抽签台 已启动！`);
  console.log(`🌐 访问地址: http://localhost:${PORT}`);
  console.log(`📡 Socket.IO 就绪\n`);
});
