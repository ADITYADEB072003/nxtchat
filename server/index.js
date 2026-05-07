require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

const { Room, Message, User } = require('./models');
const { messageCache, roomCache, userCache, presenceCache } = require('./cache');
const { signToken, requireAuth, socketAuth, generateOtp, sendOtpEmail } = require('./auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
// ══════════════════════════════════════════════════════════════════
//  MongoDB
// ══════════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatapp';

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');
    await seedDefaults();
  } catch (err) {
    console.error('⚠️  MongoDB connection failed — running in demo mode (in-memory only)');
    global.DEMO_MODE = true;
    await seedDemoData();
  }
}

async function seedDefaults() {
  for (const name of ['general', 'random', 'tech-talk']) {
    if (!await Room.findOne({ name }))
      await Room.create({ name, description: `#${name} channel`, createdBy: 'system', members: [] });
  }
}

// ── Demo-mode in-memory stores ────────────────────────────────────
const demoRooms    = {};
const demoMessages = {};
const demoUsers    = {}; // username → user object (plain passwords for demo only)

async function seedDemoData() {
  [
    { _id: 'room-general', name: 'general',   description: '#general channel'   },
    { _id: 'room-random',  name: 'random',    description: '#random channel'    },
    { _id: 'room-tech',    name: 'tech-talk', description: '#tech-talk channel' },
  ].forEach(r => {
    demoRooms[r._id]    = { ...r, createdBy: 'system', members: [], createdAt: new Date() };
    demoMessages[r._id] = [];
    roomCache.set(`room:${r._id}`, demoRooms[r._id], 0);
  });
  roomCache.set('rooms:all', Object.values(demoRooms), 0);
}

// ══════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════

// ── POST /api/auth/register ───────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'username, email and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    if (global.DEMO_MODE) {
      if (demoUsers[username]) return res.status(409).json({ error: 'Username already taken' });
      const user = {
        _id: uuidv4(), username, email, password, // plain — demo only
        avatar: randomColor(), bio: '', createdAt: new Date(), lastSeen: new Date(),
      };
      demoUsers[username] = user;
      const token = signToken({ id: user._id, username: user.username });
      const safe  = safeUser(user);
      userCache.set(`user:${username}`, safe, 120);
      return res.status(201).json({ token, user: safe });
    }

    if (await User.findOne({ $or: [{ username }, { email }] }))
      return res.status(409).json({ error: 'Username or email already taken' });

    const user  = await User.create({ username, email, passwordHash: password, avatar: randomColor() });
    const token = signToken({ id: user._id, username: user.username });
    const safe  = safeUser(user.toObject());
    userCache.set(`user:${username}`, safe, 120);
    res.status(201).json({ token, user: safe });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'username and password are required' });

    if (global.DEMO_MODE) {
      const user = demoUsers[username];
      if (!user || user.password !== password)
        return res.status(401).json({ error: 'Invalid username or password' });
      user.lastSeen = new Date();
      const token = signToken({ id: user._id, username: user.username });
      const safe  = safeUser(user);
      userCache.set(`user:${username}`, safe, 120);
      return res.json({ token, user: safe });
    }

    const user = await User.findOne({ username });
    if (!user || !(await user.verifyPassword(password)))
      return res.status(401).json({ error: 'Invalid username or password' });

    user.lastSeen = new Date();
    await user.save();
    const token = signToken({ id: user._id, username: user.username });
    const safe  = safeUser(user.toObject());
    userCache.set(`user:${username}`, safe, 120);
    res.json({ token, user: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────────
// Step 1: request OTP via email
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Always respond 200 to prevent email enumeration
    const OK = { message: 'If that email is registered, a reset code has been sent.' };

    if (global.DEMO_MODE) {
      const user = Object.values(demoUsers).find(u => u.email === email);
      if (user) {
        const otp = generateOtp();
        user.resetOtp = otp; // plain for demo
        user.resetOtpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        console.log(`[DEMO] OTP for ${user.username}: ${otp}`);
      }
      return res.json(OK);
    }

    const user = await User.findOne({ email });
    if (user) {
      const otp = generateOtp();
      await user.setResetOtp(otp);
      await user.save();
      await sendOtpEmail(email, user.username, otp).catch(e =>
        console.error('Email send failed:', e.message)
      );
    }
    res.json(OK);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────
// Step 2: verify OTP → get a short-lived reset token
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });

    if (global.DEMO_MODE) {
      const user = Object.values(demoUsers).find(u => u.email === email);
      if (!user || user.resetOtp !== otp || new Date() > user.resetOtpExpiresAt)
        return res.status(400).json({ error: 'Invalid or expired code' });
      // Issue a short-lived reset token
      const resetToken = signToken({ id: user._id, username: user.username, purpose: 'reset' });
      user.resetOtp = null;
      return res.json({ resetToken });
    }

    const user = await User.findOne({ email });
    if (!user || !(await user.verifyResetOtp(otp))) {
      await user?.save();
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
    const resetToken = signToken({ id: user._id, username: user.username, purpose: 'reset' });
    user.clearResetOtp();
    await user.save();
    res.json({ resetToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────
// Step 3: set new password using the reset token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword)
      return res.status(400).json({ error: 'resetToken and newPassword are required' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    let payload;
    try {
      const { verifyToken } = require('./auth');
      payload = verifyToken(resetToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }
    if (payload.purpose !== 'reset')
      return res.status(401).json({ error: 'Token is not a reset token' });

    if (global.DEMO_MODE) {
      const user = demoUsers[payload.username];
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.password = newPassword;
      userCache.del(`user:${user.username}`);
      return res.json({ message: 'Password updated successfully' });
    }

    const user = await User.findById(payload.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.passwordHash = newPassword; // pre-save hook will hash it
    await user.save();
    userCache.del(`user:${user.username}`);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const cached = userCache.get(`user:${req.user.username}`);
    if (cached) return res.json({ user: cached, source: 'cache' });

    if (global.DEMO_MODE) {
      const user = demoUsers[req.user.username];
      return user ? res.json({ user: safeUser(user), source: 'demo' }) : res.status(404).json({ error: 'Not found' });
    }

    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safe = safeUser(user);
    userCache.set(`user:${user.username}`, safe, 120);
    res.json({ user: safe, source: 'db' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROOMS  (protected)
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms', requireAuth, async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const createdBy = req.user.username;
    if (!name) return res.status(400).json({ error: 'name is required' });

    let room;
    if (global.DEMO_MODE) {
      room = { _id: uuidv4(), name, description: description || '', createdBy, members: [], createdAt: new Date() };
      demoRooms[room._id] = room;
      demoMessages[room._id] = [];
    } else {
      room = await Room.create({ name, description, createdBy, members: [] });
    }

    roomCache.del('rooms:all');
    roomCache.set(`room:${room._id}`, room, 300);
    io.emit('room:new', room);
    res.status(201).json(room);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGES  (protected)
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms/:roomId/messages', requireAuth, async (req, res) => {
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
    messageCache.set(cacheKey, messages, 30);
    res.json({ messages, source: 'db' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  CACHE STATS  (protected)
// ══════════════════════════════════════════════════════════════════
app.get('/api/cache/stats', requireAuth, (req, res) => {
  res.json({
    messageCache:  messageCache.getStats(),
    roomCache:     roomCache.getStats(),
    userCache:     userCache.getStats(),
    presenceCache: presenceCache.getStats(),
  });
});

// ══════════════════════════════════════════════════════════════════
//  SOCKET.IO  (auth middleware applied)
// ══════════════════════════════════════════════════════════════════
io.use(socketAuth);

io.on('connection', (socket) => {
  const username = socket.user.username;
  console.log(`🔌 ${username} connected`);

  socket.on('room:join', ({ roomId }) => {
    socket.join(roomId);
    socket.data.username = username;
    socket.data.roomId   = roomId;
    presenceCache.set(`online:${username}`, { username, roomId, socketId: socket.id }, 0);
    io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', {
      _id: uuidv4(), roomId, sender: 'system',
      text: `${username} joined the room`, type: 'system', createdAt: new Date(),
    });
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(roomId);
    presenceCache.del(`online:${username}`);
    io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', {
      _id: uuidv4(), roomId, sender: 'system',
      text: `${username} left the room`, type: 'system', createdAt: new Date(),
    });
  });

  socket.on('message:send', async ({ roomId, text }) => {
    if (!text?.trim()) return;
    try {
      let msg;
      if (global.DEMO_MODE) {
        msg = { _id: uuidv4(), roomId, sender: username, text: text.trim(), type: 'text', createdAt: new Date(), reactions: {} };
        (demoMessages[roomId] = demoMessages[roomId] || []).push(msg);
        if (demoMessages[roomId].length > 200) demoMessages[roomId].shift();
      } else {
        msg = (await Message.create({ roomId, sender: username, text: text.trim() })).toObject();
      }
      messageCache.delByPrefix(`messages:${roomId}:`);
      io.to(roomId).emit('message:new', msg);
    } catch { socket.emit('error', { message: 'Failed to send message' }); }
  });

  socket.on('typing:start', ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing: true }));
  socket.on('typing:stop',  ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing: false }));

  socket.on('message:react', async ({ messageId, emoji, roomId }) => {
    try {
      if (!global.DEMO_MODE)
        await Message.updateOne({ _id: messageId }, { $addToSet: { [`reactions.${emoji}`]: username } });
      messageCache.delByPrefix(`messages:${roomId}:`);
      io.to(roomId).emit('message:reacted', { messageId, emoji, username });
    } catch { /* ignore */ }
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    presenceCache.del(`online:${username}`);
    if (roomId) {
      io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
      io.to(roomId).emit('message:new', {
        _id: uuidv4(), roomId, sender: 'system',
        text: `${username} disconnected`, type: 'system', createdAt: new Date(),
      });
    }
    console.log(`🔌 ${username} disconnected`);
  });
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════
function getOnlineUsers(roomId) {
  const users = [];
  for (const [key, entry] of presenceCache.store)
    if (key.startsWith('online:') && entry.value?.roomId === roomId)
      users.push(entry.value.username);
  return users;
}

function randomColor() {
  const c = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
  return c[Math.floor(Math.random() * c.length)];
}

function safeUser(u) {
  const { passwordHash, password, resetOtp, resetOtpExpiresAt, resetOtpAttempts, __v, ...rest } = u;
  return rest;
}

// ══════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
connectDB().then(() =>
  server.listen(PORT, () => console.log(`🚀 Server at http://localhost:${PORT}`))
);

module.exports = { app, server };
