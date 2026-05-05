require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');

const { Room, Message, User } = require('./models');
const { messageCache, roomCache, userCache, presenceCache } = require('./cache');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ══════════════════════════════════════════════════════════════════
//  MongoDB connection
// ══════════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatapp';

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');
    await seedDefaults();
  } catch (err) {
    console.error('⚠️  MongoDB connection failed — running in demo mode (in-memory only)');
    console.error('   Start MongoDB or set MONGO_URI in .env to persist data.');
    global.DEMO_MODE = true;
    await seedDemoData();
  }
}

// ══════════════════════════════════════════════════════════════════
//  Seed helpers
// ══════════════════════════════════════════════════════════════════
async function seedDefaults() {
  const defaults = ['general', 'random', 'tech-talk'];
  for (const name of defaults) {
    const exists = await Room.findOne({ name });
    if (!exists) await Room.create({ name, description: `#${name} channel`, createdBy: 'system', members: [] });
  }
}

// Demo mode: seed into roomCache directly (no MongoDB)
const demoRooms = {};
const demoMessages = {};

async function seedDemoData() {
  const rooms = [
    { _id: 'room-general', name: 'general',   description: '#general channel',   createdBy: 'system', members: [], createdAt: new Date() },
    { _id: 'room-random',  name: 'random',    description: '#random channel',    createdBy: 'system', members: [], createdAt: new Date() },
    { _id: 'room-tech',    name: 'tech-talk', description: '#tech-talk channel', createdBy: 'system', members: [], createdAt: new Date() },
  ];
  rooms.forEach(r => {
    demoRooms[r._id] = r;
    demoMessages[r._id] = [];
    roomCache.set(`room:${r._id}`, r, 0);
  });
  roomCache.set('rooms:all', rooms, 0);
}

// ══════════════════════════════════════════════════════════════════
//  REST API — Rooms
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms', async (req, res) => {
  try {
    const cached = roomCache.get('rooms:all');
    if (cached) return res.json({ rooms: cached, source: 'cache' });

    if (global.DEMO_MODE) {
      const rooms = Object.values(demoRooms);
      roomCache.set('rooms:all', rooms, 60);
      return res.json({ rooms, source: 'demo' });
    }

    const rooms = await Room.find().sort({ createdAt: 1 });
    roomCache.set('rooms:all', rooms, 60);
    res.json({ rooms, source: 'db' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, description, createdBy } = req.body;
    if (!name || !createdBy) return res.status(400).json({ error: 'name and createdBy required' });

    let room;
    if (global.DEMO_MODE) {
      room = { _id: uuidv4(), name, description: description || '', createdBy, members: [], createdAt: new Date() };
      demoRooms[room._id] = room;
      demoMessages[room._id] = [];
    } else {
      room = await Room.create({ name, description, createdBy, members: [] });
    }

    roomCache.del('rooms:all'); // invalidate list cache
    roomCache.set(`room:${room._id}`, room, 300);
    io.emit('room:new', room);
    res.status(201).json(room);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  REST API — Messages
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const cacheKey = `messages:${roomId}:${limit}`;

  try {
    const cached = messageCache.get(cacheKey);
    if (cached) return res.json({ messages: cached, source: 'cache' });

    let messages;
    if (global.DEMO_MODE) {
      messages = (demoMessages[roomId] || []).slice(-limit);
    } else {
      messages = await Message.find({ roomId }).sort({ createdAt: -1 }).limit(limit).lean();
      messages.reverse();
    }

    messageCache.set(cacheKey, messages, 30); // 30-second TTL (fresh enough)
    res.json({ messages, source: 'db' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  REST API — Users
// ══════════════════════════════════════════════════════════════════
app.post('/api/users/join', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    const cacheKey = `user:${username}`;
    let user = userCache.get(cacheKey);
    if (user) return res.json({ user, source: 'cache' });

    if (global.DEMO_MODE) {
      user = { _id: uuidv4(), username, avatar: randomColor(), bio: '', createdAt: new Date(), lastSeen: new Date() };
    } else {
      user = await User.findOneAndUpdate(
        { username },
        { lastSeen: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      if (!user.avatar) {
        user = await User.findOneAndUpdate({ username }, { avatar: randomColor() }, { new: true }).lean();
      }
    }

    userCache.set(cacheKey, user, 120);
    res.json({ user, source: 'db' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  Cache stats endpoint
// ══════════════════════════════════════════════════════════════════
app.get('/api/cache/stats', (req, res) => {
  res.json({
    messageCache:  messageCache.getStats(),
    roomCache:     roomCache.getStats(),
    userCache:     userCache.getStats(),
    presenceCache: presenceCache.getStats(),
  });
});

// ══════════════════════════════════════════════════════════════════
//  Socket.IO — Real-time messaging
// ══════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ── Join room ──────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, username }) => {
    socket.join(roomId);
    socket.data.username = username;
    socket.data.roomId   = roomId;

    presenceCache.set(`online:${username}`, { username, roomId, socketId: socket.id }, 0);

    const onlineList = getOnlineUsers(roomId);
    io.to(roomId).emit('presence:update', { roomId, users: onlineList });

    // system message (not persisted)
    io.to(roomId).emit('message:new', {
      _id: uuidv4(), roomId, sender: 'system', text: `${username} joined the room`,
      type: 'system', createdAt: new Date(),
    });
  });

  // ── Leave room ─────────────────────────────────────────────────
  socket.on('room:leave', ({ roomId, username }) => {
    socket.leave(roomId);
    presenceCache.del(`online:${username}`);
    io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', {
      _id: uuidv4(), roomId, sender: 'system', text: `${username} left the room`,
      type: 'system', createdAt: new Date(),
    });
  });

  // ── Send message ───────────────────────────────────────────────
  socket.on('message:send', async ({ roomId, sender, text }) => {
    if (!text?.trim()) return;

    let msg;
    try {
      if (global.DEMO_MODE) {
        msg = { _id: uuidv4(), roomId, sender, text: text.trim(), type: 'text', createdAt: new Date(), reactions: {} };
        (demoMessages[roomId] = demoMessages[roomId] || []).push(msg);
        // keep only last 200 per room in demo
        if (demoMessages[roomId].length > 200) demoMessages[roomId].shift();
      } else {
        msg = await Message.create({ roomId, sender, text: text.trim(), type: 'text' });
        msg = msg.toObject();
      }

      // Invalidate message cache for this room
      messageCache.delByPrefix(`messages:${roomId}:`);

      io.to(roomId).emit('message:new', msg);
    } catch (err) {
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // ── Typing indicator ───────────────────────────────────────────
  socket.on('typing:start', ({ roomId, username }) => {
    socket.to(roomId).emit('typing:update', { username, typing: true });
  });
  socket.on('typing:stop', ({ roomId, username }) => {
    socket.to(roomId).emit('typing:update', { username, typing: false });
  });

  // ── React to message ───────────────────────────────────────────
  socket.on('message:react', async ({ messageId, emoji, username, roomId }) => {
    try {
      if (!global.DEMO_MODE) {
        await Message.updateOne(
          { _id: messageId },
          { $addToSet: { [`reactions.${emoji}`]: username } }
        );
      }
      messageCache.delByPrefix(`messages:${roomId}:`);
      io.to(roomId).emit('message:reacted', { messageId, emoji, username });
    } catch (err) { /* ignore */ }
  });

  // ── Disconnect ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { username, roomId } = socket.data;
    if (username) {
      presenceCache.del(`online:${username}`);
      if (roomId) {
        io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
        io.to(roomId).emit('message:new', {
          _id: uuidv4(), roomId, sender: 'system', text: `${username} disconnected`,
          type: 'system', createdAt: new Date(),
        });
      }
    }
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════
function getOnlineUsers(roomId) {
  const users = [];
  for (const [key, entry] of presenceCache.store) {
    if (key.startsWith('online:') && entry.value?.roomId === roomId) {
      users.push(entry.value.username);
    }
  }
  return users;
}

function randomColor() {
  const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ══════════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
});

module.exports = { app, server };
