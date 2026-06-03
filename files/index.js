require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
  User, Room, RoomMember, Message, Reaction, Media, Op,
  connectDB, roomWithMembers, findRoomsForUser, addMember,
  removeMember, findMessages, addReaction, safeUser,
} = require('./db');
const { messageCache, roomCache, userCache, presenceCache } = require('./cache');
const { signToken, requireAuth, socketAuth, generateOtp, sendOtpEmail } = require('./auth');
const { upload, generateThumbnail, ALLOWED_IMAGES } = require('./upload');
const {
  strictLimiter, otpLimiter, uploadLimiter, adminLimiter,
  inviteLimiter, apiLimiter, checkSocketRate, cleanSocketRate, logLimits,
} = require('./limiter');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.set('trust proxy', 1); // trust first proxy (Render / nginx)
app.use('/api/', apiLimiter); // global ceiling on all /api/* routes
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../client')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/admin',   express.static(path.join(__dirname, '../client/admin.html')));

// ── Helpers ───────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}
function randomColor() {
  const c = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
  return c[Math.floor(Math.random() * c.length)];
}
function bustAllRoomCaches() {
  for (const [key] of roomCache.store)
    if (key.startsWith('rooms:user:')) roomCache.del(key);
}

// ══════════════════════════════════════════════════════════════════
//  DB CONNECT & SEED
// ══════════════════════════════════════════════════════════════════
async function initDB() {
  try {
    await connectDB();
    await seedDefaults();
  } catch (err) {
    console.error('DB connection failed:', err.message);
    process.exit(1);
  }
}

async function seedDefaults() {
  for (const { name, description } of [
    { name:'general',   description:'#general channel'   },
    { name:'random',    description:'#random channel'    },
    { name:'tech-talk', description:'#tech-talk channel' },
  ]) {
    const [room, created] = await Room.findOrCreate({
      where: { name },
      defaults: { description, createdBy:'system', isPrivate:false },
    });
    if (created) console.log(`  Seeded #${name}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) =>
  res.json({ status:'ok', uptime:process.uptime(), db: process.env.DB_DIALECT || 'sqlite' })
);

// ══════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/register', strictLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username||!email||!password) return res.status(400).json({ error:'All fields required' });
    if (password.length < 6) return res.status(400).json({ error:'Password min 6 chars' });

    const exists = await User.findOne({ where: { [Op.or]: [{ username }, { email }] } });
    if (exists) return res.status(409).json({ error:'Username or email taken' });

    const isFirst = (await User.count()) === 0;
    const user    = await User.create({
      username, email, passwordHash: password,
      avatar: randomColor(), role: isFirst ? 'admin' : 'user',
    });
    const token = signToken({ id:user.id, username, role:user.role });
    userCache.set(`user:${username}`, safeUser(user), 120);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', strictLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:'Credentials required' });

    const user = await User.findOne({ where: { username } });
    if (!user || !await user.verifyPassword(password))
      return res.status(401).json({ error:'Invalid credentials' });
    if (user.banned)
      return res.status(403).json({ error:`Banned: ${user.bannedReason||'No reason given'}` });

    user.lastSeen = new Date(); await user.save();
    const token = signToken({ id:user.id, username, role:user.role });
    userCache.set(`user:${username}`, safeUser(user), 120);
    res.json({ token, user: safeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const cached = userCache.get(`user:${req.user.username}`);
    if (cached) return res.json({ user: cached });
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error:'Not found' });
    res.json({ user: safeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/forgot-password', strictLimiter, async (req, res) => {
  const OK = { message:'If that email is registered, a reset code has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:'Email required' });
    const user = await User.findOne({ where: { email } });
    if (user) {
      const otp = generateOtp();
      await user.setResetOtp(otp); await user.save();
      sendOtpEmail(email, user.username, otp).catch(e => console.error('Email fail:', e.message));
    }
    res.json(OK);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user || !await user.verifyResetOtp(otp))
      return res.status(400).json({ error:'Invalid or expired code' });
    user.clearResetOtp(); await user.save();
    res.json({ resetToken: signToken({ id:user.id, username:user.username, purpose:'reset' }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', otpLimiter, async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken||!newPassword) return res.status(400).json({ error:'resetToken and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error:'Password min 6 chars' });
    const { verifyToken } = require('./auth');
    let payload;
    try { payload = verifyToken(resetToken); } catch { return res.status(401).json({ error:'Invalid reset token' }); }
    if (payload.purpose !== 'reset') return res.status(401).json({ error:'Not a reset token' });
    const user = await User.findByPk(payload.id);
    if (!user) return res.status(404).json({ error:'User not found' });
    user.passwordHash = newPassword; await user.save();
    userCache.del(`user:${user.username}`);
    res.json({ message:'Password updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════════════════
app.post('/api/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file provided' });
    const isImage = ALLOWED_IMAGES.includes(req.file.mimetype);
    const type    = isImage ? 'image' : 'video';
    const thumbUrl = isImage ? await generateThumbnail(req.file.path, req.file.filename) : null;

    const media = await Media.create({
      filename: req.file.filename, originalName: req.file.originalname,
      mimeType: req.file.mimetype, size: req.file.size, type,
      thumbnail: thumbUrl, uploadedBy: req.user.username, roomId: req.body.roomId,
    });
    res.json({ ...media.get({ plain:true }), _id: media.id,
      url: `/uploads/${type}s/${req.file.filename}`, thumbUrl });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROOMS
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { username, role } = req.user;
    const cacheKey = `rooms:user:${username}`;
    const cached   = roomCache.get(cacheKey);
    if (cached) return res.json({ rooms: cached, source:'cache' });

    const rooms = await findRoomsForUser(username, role === 'admin');
    roomCache.set(cacheKey, rooms, 60);
    res.json({ rooms, source:'db' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name, description, isPrivate } = req.body;
    if (!name) return res.status(400).json({ error:'name required' });
    const username = req.user.username;
    const _private = !!isPrivate;

    const room = await Room.create({ name, description: description||'', createdBy: username, isPrivate: _private });
    await addMember(room.id, username, 'created');
    const full = await roomWithMembers(room);
    roomCache.del(`rooms:user:${username}`);
    roomCache.set(`room:${room.id}`, full, 300);

    if (_private) {
      const cs = [...io.sockets.sockets.values()].find(s => s.user?.username === username);
      if (cs) cs.emit('room:new', full);
    } else {
      bustAllRoomCaches();
      io.emit('room:new', full);
    }
    res.status(201).json(full);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/rooms/:id', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    await Message.destroy({ where: { roomId: id } });
    await RoomMember.destroy({ where: { roomId: id } });
    await Room.destroy({ where: { id } });
    bustAllRoomCaches();
    roomCache.del(`room:${id}`);
    messageCache.delByPrefix(`messages:${id}:`);
    io.emit('room:deleted', { roomId: id });
    res.json({ message:'Room deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Exit channel ──────────────────────────────────────────────────
app.post('/api/rooms/:id/exit', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const username = req.user.username;
    const room = await Room.findByPk(id);
    if (!room) return res.status(404).json({ error:'Room not found' });
    if (room.createdBy === username)
      return res.status(400).json({ error:'You created this channel. Delete it instead.' });
    await removeMember(id, username);
    roomCache.del(`rooms:user:${username}`);
    roomCache.del(`room:${id}`);
    res.json({ message:`Left #${room.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  INVITE CODE
// ══════════════════════════════════════════════════════════════════
app.post('/api/rooms/:id/invite', requireAuth, async (req, res) => {
  try {
    const room = await Room.findByPk(req.params.id);
    if (!room) return res.status(404).json({ error:'Room not found' });
    if (room.createdBy !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error:'Only creator or admin can generate invite codes' });
    const code = room.generateInviteCode();
    await room.save();
    roomCache.del(`rooms:user:${req.user.username}`);
    roomCache.del(`room:${room.id}`);
    res.json({ inviteCode: code, roomName: room.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/rooms/:id/invite', requireAuth, async (req, res) => {
  try {
    const room = await Room.findByPk(req.params.id);
    if (!room) return res.status(404).json({ error:'Room not found' });
    if (room.createdBy !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error:'Not authorized' });
    room.disableInvite(); await room.save();
    roomCache.del(`rooms:user:${req.user.username}`);
    roomCache.del(`room:${room.id}`);
    res.json({ message:'Invite code disabled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invite/:code', requireAuth, inviteLimiter, async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const room = await Room.findOne({ where: { inviteCode: code, inviteEnabled: true } });
    if (!room) return res.status(404).json({ error:'Invalid or expired invite code' });
    const count = await RoomMember.count({ where: { roomId: room.id } });
    res.json({ roomName: room.name, description: room.description, memberCount: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invite/join', requireAuth, inviteLimiter, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error:'Code required' });
    const normalised = code.trim().toUpperCase();
    const room = await Room.findOne({ where: { inviteCode: normalised, inviteEnabled: true } });
    if (!room) return res.status(404).json({ error:'Invalid or expired invite code' });

    await addMember(room.id, req.user.username, 'invite');
    roomCache.del(`rooms:user:${req.user.username}`);
    roomCache.del(`room:${room.id}`);
    const full = await roomWithMembers(room);
    const js   = [...io.sockets.sockets.values()].find(s => s.user?.username === req.user.username);
    if (js) js.emit('room:new', full);
    res.json({ room: full, message:`Joined #${room.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms/:roomId/messages', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const cacheKey = `messages:${roomId}:${limit}`;
    const cached = messageCache.get(cacheKey);
    if (cached) return res.json({ messages: cached, source:'cache' });

    const messages = await findMessages(roomId, limit);
    messageCache.set(cacheKey, messages, 30);
    res.json({ messages, source:'db' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/messages/:id', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const msg = await Message.findByPk(req.params.id);
    if (!msg) return res.status(404).json({ error:'Not found' });
    const roomId = msg.roomId;
    await Reaction.destroy({ where: { messageId: msg.id } });
    await msg.destroy();
    messageCache.delByPrefix(`messages:${roomId}:`);
    io.to(roomId).emit('message:deleted', { messageId: req.params.id });
    res.json({ message:'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════════
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.findAll({ attributes:{ exclude:['passwordHash','resetOtp','resetOtpExpiresAt','resetOtpAttempts'] } });
    res.json({ users: users.map(u => ({ ...u.get({ plain:true }), _id:u.id })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/:username/ban', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { username } = req.params;
    if (username === req.user.username) return res.status(400).json({ error:"Can't ban yourself" });
    const { banned, reason } = req.body;
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(404).json({ error:'User not found' });
    user.banned = banned; user.bannedReason = reason||''; await user.save();
    userCache.del(`user:${username}`);
    res.json(safeUser(user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/:username/role', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { username } = req.params;
    if (username === req.user.username) return res.status(400).json({ error:"Can't change your own role" });
    const { role } = req.body;
    if (!['user','admin'].includes(role)) return res.status(400).json({ error:'Invalid role' });
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(404).json({ error:'User not found' });
    user.role = role; await user.save();
    userCache.del(`user:${username}`);
    res.json(safeUser(user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:username', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { username } = req.params;
    if (username === req.user.username) return res.status(400).json({ error:"Can't delete yourself" });
    await User.destroy({ where: { username } });
    userCache.del(`user:${username}`);
    res.json({ message:'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [users, rooms, messages, media, banned] = await Promise.all([
      User.count(), Room.count(), Message.count(),
      Media.count(), User.count({ where:{ banned:true } }),
    ]);
    res.json({ users, rooms, messages, media, online: presenceCache.size, banned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
  try {
    const rooms = await Room.findAll({ order:[['createdAt','ASC']] });
    res.json({ rooms: await Promise.all(rooms.map(roomWithMembers)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/broadcast', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error:'message required' });
    io.emit('system:broadcast', { text: message, from:'Admin', at: new Date() });
    res.json({ message:'Broadcast sent' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cache/stats', requireAuth, (req, res) => {
  res.json({
    messageCache:  messageCache.getStats(),
    roomCache:     roomCache.getStats(),
    userCache:     userCache.getStats(),
    presenceCache: presenceCache.getStats(),
  });
});

// ══════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.use(socketAuth);

io.on('connection', (socket) => {
  const { username, role, id: userId } = socket.user;

  socket.on('room:join', ({ roomId }) => {
    socket.join(roomId);
    socket.data.username = username; socket.data.roomId = roomId;
    presenceCache.set(`online:${username}`, { username, roomId, socketId:socket.id, role }, 0);
    io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', sysMsg(roomId, `${username} joined`));
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(roomId);
    presenceCache.del(`online:${username}`);
    io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', sysMsg(roomId, `${username} left`));
  });

  socket.on('message:send', async ({ roomId, text, mediaId, mediaUrl, thumbUrl, fileName, fileSize, type: msgType }) => {
    if (!checkSocketRate(socket)) return; // rate limited
    if (!text?.trim() && !mediaId) return;
    try {
      const msg = await Message.create({
        roomId, sender: username, text: text||'',
        type: msgType||'text', mediaId: mediaId||null,
        mediaUrl: mediaUrl||null, thumbUrl: thumbUrl||null,
        fileName: fileName||null, fileSize: fileSize||null,
      });
      const plain = msg.get({ plain:true }); plain._id = plain.id; plain.reactions = {};
      messageCache.delByPrefix(`messages:${roomId}:`);
      io.to(roomId).emit('message:new', plain);
    } catch { socket.emit('error', { message:'Failed to send' }); }
  });

  socket.on('typing:start', ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing:true }));
  socket.on('typing:stop',  ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing:false }));

  socket.on('message:react', async ({ messageId, emoji, roomId }) => {
    await addReaction(messageId, emoji, username).catch(() => {});
    messageCache.delByPrefix(`messages:${roomId}:`);
    io.to(roomId).emit('message:reacted', { messageId, emoji, username });
  });

  socket.on('admin:kick', ({ targetUsername }) => {
    if (role !== 'admin') return;
    for (const [,s] of io.sockets.sockets)
      if (s.user?.username === targetUsername) { s.emit('kicked', { reason:'Kicked by admin' }); s.disconnect(true); }
  });

  socket.on('disconnect', () => {
    cleanSocketRate(socket.id); // free memory
    const { roomId } = socket.data;
    presenceCache.del(`online:${username}`);
    if (roomId) {
      io.to(roomId).emit('presence:update', { roomId, users: getOnlineUsers(roomId) });
      io.to(roomId).emit('message:new', sysMsg(roomId, `${username} disconnected`));
    }
  });
});

function getOnlineUsers(roomId) {
  const users = [];
  for (const [key, entry] of presenceCache.store)
    if (key.startsWith('online:') && entry.value?.roomId === roomId)
      users.push({ username: entry.value.username, role: entry.value.role });
  return users;
}

function sysMsg(roomId, text) {
  return { _id: uuidv4(), roomId, sender:'system', text, type:'system', createdAt: new Date() };
}

// ══════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  logLimits();
  server.listen(PORT, () =>
    console.log(`🚀 http://localhost:${PORT}   admin: http://localhost:${PORT}/admin`)
  );
});
