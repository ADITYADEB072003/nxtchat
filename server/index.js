require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');

const { Room, Media, Message, User } = require('./models');
const { messageCache, roomCache, userCache, presenceCache } = require('./cache');
const { signToken, requireAuth, socketAuth, generateOtp, sendOtpEmail } = require('./auth');
const { upload, generateThumbnail, ALLOWED_IMAGES } = require('./upload');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../client')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/admin',   express.static(path.join(__dirname, '../client/admin.html')));

// ══════════════════════════════════════════════════════════════════
//  MongoDB
// ══════════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatapp';

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');
    await seedDefaults();
  } catch {
    console.error('⚠️  MongoDB offline — demo mode');
    global.DEMO_MODE = true;
    await seedDemoData();
  }
}

async function seedDefaults() {
  for (const name of ['general','random','tech-talk'])
    if (!await Room.findOne({ name }))
      await Room.create({ name, description:`#${name} channel`, createdBy:'system', members:[] });
}

// Demo stores
const demoRooms = {}, demoMessages = {}, demoUsers = {}, demoMedia = {};

async function seedDemoData() {
  [
    { _id:'room-general', name:'general',   description:'#general channel' },
    { _id:'room-random',  name:'random',    description:'#random channel'  },
    { _id:'room-tech',    name:'tech-talk', description:'#tech-talk channel' },
  ].forEach(r => {
    demoRooms[r._id]    = { ...r, createdBy:'system', members:[], createdAt:new Date() };
    demoMessages[r._id] = [];
    roomCache.set(`room:${r._id}`, demoRooms[r._id], 0);
  });
  roomCache.set('rooms:all', Object.values(demoRooms), 0);
}

// ── Admin middleware ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function safeUser(u) {
  const { passwordHash, password, resetOtp, resetOtpExpiresAt, resetOtpAttempts, __v, ...rest } = u;
  return rest;
}
function randomColor() {
  const c = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
  return c[Math.floor(Math.random()*c.length)];
}

// ══════════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status:'ok', uptime:process.uptime(), demo:!!global.DEMO_MODE }));

// ══════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username||!email||!password) return res.status(400).json({ error:'All fields required' });
    if (password.length < 6) return res.status(400).json({ error:'Password min 6 chars' });

    if (global.DEMO_MODE) {
      if (demoUsers[username]) return res.status(409).json({ error:'Username taken' });
      const isFirst = Object.keys(demoUsers).length === 0;
      const user = { _id:uuidv4(), username, email, password, avatar:randomColor(), bio:'', role: isFirst?'admin':'user', banned:false, createdAt:new Date(), lastSeen:new Date() };
      demoUsers[username] = user;
      const token = signToken({ id:user._id, username, role:user.role });
      return res.status(201).json({ token, user:safeUser(user) });
    }

    if (await User.findOne({ $or:[{username},{email}] }))
      return res.status(409).json({ error:'Username or email taken' });
    const isFirst = (await User.countDocuments()) === 0;
    const user = await User.create({ username, email, passwordHash:password, avatar:randomColor(), role: isFirst?'admin':'user' });
    const token = signToken({ id:user._id, username, role:user.role });
    const safe  = safeUser(user.toObject());
    userCache.set(`user:${username}`, safe, 120);
    res.status(201).json({ token, user:safe });
  } catch(err) { res.status(400).json({ error:err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:'Credentials required' });

    if (global.DEMO_MODE) {
      const user = demoUsers[username];
      if (!user||user.password!==password) return res.status(401).json({ error:'Invalid credentials' });
      if (user.banned) return res.status(403).json({ error:`Banned: ${user.bannedReason||'No reason given'}` });
      user.lastSeen = new Date();
      const token = signToken({ id:user._id, username, role:user.role });
      return res.json({ token, user:safeUser(user) });
    }

    const user = await User.findOne({ username });
    if (!user||!await user.verifyPassword(password)) return res.status(401).json({ error:'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error:`Banned: ${user.bannedReason||'No reason given'}` });
    user.lastSeen = new Date(); await user.save();
    const token = signToken({ id:user._id, username, role:user.role });
    const safe  = safeUser(user.toObject());
    userCache.set(`user:${username}`, safe, 120);
    res.json({ token, user:safe });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    if (global.DEMO_MODE) {
      const u = demoUsers[req.user.username];
      return u ? res.json({ user:safeUser(u) }) : res.status(404).json({ error:'Not found' });
    }
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error:'Not found' });
    res.json({ user:safeUser(user) });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const OK = { message:'If that email is registered, a reset code has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error:'Email required' });
    if (global.DEMO_MODE) {
      const user = Object.values(demoUsers).find(u=>u.email===email);
      if (user) { const otp=generateOtp(); user.resetOtp=otp; user.resetOtpExpiresAt=new Date(Date.now()+15*60*1000); console.log(`[DEMO] OTP for ${user.username}: ${otp}`); }
      return res.json(OK);
    }
    const user = await User.findOne({ email });
    if (user) { const otp=generateOtp(); await user.setResetOtp(otp); await user.save(); sendOtpEmail(email,user.username,otp).catch(e=>console.error('Email fail:',e.message)); }
    res.json(OK);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (global.DEMO_MODE) {
      const user = Object.values(demoUsers).find(u=>u.email===email);
      if (!user||user.resetOtp!==otp||new Date()>user.resetOtpExpiresAt) return res.status(400).json({ error:'Invalid or expired code' });
      user.resetOtp = null;
      return res.json({ resetToken: signToken({ id:user._id, username:user.username, purpose:'reset' }) });
    }
    const user = await User.findOne({ email });
    if (!user||!await user.verifyResetOtp(otp)) { await user?.save(); return res.status(400).json({ error:'Invalid or expired code' }); }
    user.clearResetOtp(); await user.save();
    res.json({ resetToken: signToken({ id:user._id, username:user.username, purpose:'reset' }) });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken||!newPassword) return res.status(400).json({ error:'resetToken and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error:'Password min 6 chars' });
    const { verifyToken } = require('./auth');
    let payload;
    try { payload = verifyToken(resetToken); } catch { return res.status(401).json({ error:'Invalid reset token' }); }
    if (payload.purpose !== 'reset') return res.status(401).json({ error:'Not a reset token' });
    if (global.DEMO_MODE) {
      const user = demoUsers[payload.username];
      if (!user) return res.status(404).json({ error:'User not found' });
      user.password = newPassword; userCache.del(`user:${user.username}`);
      return res.json({ message:'Password updated' });
    }
    const user = await User.findById(payload.id);
    if (!user) return res.status(404).json({ error:'User not found' });
    user.passwordHash = newPassword; await user.save();
    userCache.del(`user:${user.username}`);
    res.json({ message:'Password updated' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  FILE UPLOAD  (images + videos — stored locally, no external CDN)
// ══════════════════════════════════════════════════════════════════
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file provided' });
    const isImage = ALLOWED_IMAGES.includes(req.file.mimetype);
    const type    = isImage ? 'image' : 'video';
    let thumbUrl  = null;

    if (isImage) thumbUrl = await generateThumbnail(req.file.path, req.file.filename);

    if (global.DEMO_MODE) {
      const media = {
        _id: uuidv4(), filename: req.file.filename, originalName: req.file.originalname,
        mimeType: req.file.mimetype, size: req.file.size, type,
        thumbnail: thumbUrl, uploadedBy: req.user.username,
        roomId: req.body.roomId, createdAt: new Date(),
        url: `/uploads/${type}s/${req.file.filename}`,
        thumbUrl,
      };
      demoMedia[media._id] = media;
      return res.json(media);
    }

    const media = await Media.create({
      filename: req.file.filename, originalName: req.file.originalname,
      mimeType: req.file.mimetype, size: req.file.size, type,
      thumbnail: thumbUrl, uploadedBy: req.user.username, roomId: req.body.roomId,
    });
    res.json({ ...media.toObject(), url:`/uploads/${type}s/${req.file.filename}`, thumbUrl });
  } catch(err) {
    if (req.file) fs.unlink(req.file.path, ()=>{});
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROOMS
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const cached = roomCache.get('rooms:all');
    if (cached) return res.json({ rooms:cached, source:'cache' });
    if (global.DEMO_MODE) { const rooms=Object.values(demoRooms); roomCache.set('rooms:all',rooms,60); return res.json({ rooms, source:'demo' }); }
    const rooms = await Room.find().sort({ createdAt:1 });
    roomCache.set('rooms:all', rooms, 60);
    res.json({ rooms, source:'db' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error:'name required' });
    let room;
    if (global.DEMO_MODE) {
      room = { _id:uuidv4(), name, description:description||'', createdBy:req.user.username, members:[], createdAt:new Date() };
      demoRooms[room._id] = room; demoMessages[room._id] = [];
    } else {
      room = await Room.create({ name, description, createdBy:req.user.username, members:[] });
    }
    roomCache.del('rooms:all'); roomCache.set(`room:${room._id}`,room,300);
    io.emit('room:new', room);
    res.status(201).json(room);
  } catch(err) { res.status(400).json({ error:err.message }); }
});

app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (global.DEMO_MODE) { delete demoRooms[id]; delete demoMessages[id]; }
    else { await Room.findByIdAndDelete(id); await Message.deleteMany({ roomId:id }); }
    roomCache.del('rooms:all'); roomCache.del(`room:${id}`); messageCache.delByPrefix(`messages:${id}:`);
    io.emit('room:deleted', { roomId:id });
    res.json({ message:'Room deleted' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════════════════════
app.get('/api/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const { roomId } = req.params;
  const limit = parseInt(req.query.limit)||50;
  const cacheKey = `messages:${roomId}:${limit}`;
  try {
    const cached = messageCache.get(cacheKey);
    if (cached) return res.json({ messages:cached, source:'cache' });
    let messages;
    if (global.DEMO_MODE) messages = (demoMessages[roomId]||[]).slice(-limit);
    else { messages = await Message.find({ roomId }).sort({ createdAt:-1 }).limit(limit).lean(); messages.reverse(); }
    messageCache.set(cacheKey, messages, 30);
    res.json({ messages, source:'db' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/messages/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let roomId;
    if (global.DEMO_MODE) {
      for (const [rid, msgs] of Object.entries(demoMessages)) {
        const idx = msgs.findIndex(m=>m._id===id);
        if (idx !== -1) { roomId=rid; msgs.splice(idx,1); break; }
      }
    } else {
      const msg = await Message.findByIdAndDelete(id);
      if (msg) roomId = msg.roomId.toString();
    }
    if (roomId) { messageCache.delByPrefix(`messages:${roomId}:`); io.to(roomId).emit('message:deleted', { messageId:id }); }
    res.json({ message:'Deleted' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════════

// ── GET all users ─────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    if (global.DEMO_MODE) {
      const users = Object.values(demoUsers).map(safeUser);
      return res.json({ users });
    }
    const users = await User.find().select('-passwordHash -resetOtp -resetOtpExpiresAt -resetOtpAttempts').lean();
    res.json({ users });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Ban / unban user ──────────────────────────────────────────────
app.patch('/api/admin/users/:username/ban', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const { banned, reason } = req.body;
    if (username === req.user.username) return res.status(400).json({ error:"Can't ban yourself" });

    if (global.DEMO_MODE) {
      const user = demoUsers[username];
      if (!user) return res.status(404).json({ error:'User not found' });
      user.banned = banned; user.bannedReason = reason||'';
      userCache.del(`user:${username}`);
      return res.json(safeUser(user));
    }
    const user = await User.findOneAndUpdate({ username }, { banned, bannedReason:reason||'' }, { new:true }).lean();
    if (!user) return res.status(404).json({ error:'User not found' });
    userCache.del(`user:${username}`);
    res.json(safeUser(user));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Promote / demote ──────────────────────────────────────────────
app.patch('/api/admin/users/:username/role', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const { role } = req.body;
    if (!['user','admin'].includes(role)) return res.status(400).json({ error:'Invalid role' });
    if (username === req.user.username) return res.status(400).json({ error:"Can't change your own role" });

    if (global.DEMO_MODE) {
      const user = demoUsers[username];
      if (!user) return res.status(404).json({ error:'User not found' });
      user.role = role; userCache.del(`user:${username}`);
      return res.json(safeUser(user));
    }
    const user = await User.findOneAndUpdate({ username }, { role }, { new:true }).lean();
    if (!user) return res.status(404).json({ error:'User not found' });
    userCache.del(`user:${username}`);
    res.json(safeUser(user));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Delete user ───────────────────────────────────────────────────
app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    if (username === req.user.username) return res.status(400).json({ error:"Can't delete yourself" });
    if (global.DEMO_MODE) { delete demoUsers[username]; userCache.del(`user:${username}`); return res.json({ message:'Deleted' }); }
    await User.findOneAndDelete({ username });
    userCache.del(`user:${username}`);
    res.json({ message:'Deleted' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    let stats;
    if (global.DEMO_MODE) {
      stats = {
        users:    Object.keys(demoUsers).length,
        rooms:    Object.keys(demoRooms).length,
        messages: Object.values(demoMessages).reduce((s,m)=>s+m.length,0),
        media:    Object.keys(demoMedia).length,
        online:   presenceCache.size,
        banned:   Object.values(demoUsers).filter(u=>u.banned).length,
      };
    } else {
      const [users,rooms,messages,media,banned] = await Promise.all([
        User.countDocuments(), Room.countDocuments(), Message.countDocuments(),
        Media.countDocuments(), User.countDocuments({ banned:true }),
      ]);
      stats = { users, rooms, messages, media, online:presenceCache.size, banned };
    }
    res.json(stats);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Get all rooms (admin) ─────────────────────────────────────────
app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
  try {
    if (global.DEMO_MODE) return res.json({ rooms: Object.values(demoRooms) });
    const rooms = await Room.find().lean();
    res.json({ rooms });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Broadcast system message ──────────────────────────────────────
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error:'message required' });
    io.emit('system:broadcast', { text:message, from:'Admin', at:new Date() });
    res.json({ message:'Broadcast sent' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Cache stats ───────────────────────────────────────────────────
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
  const username = socket.user.username;
  const role     = socket.user.role;

  socket.on('room:join', ({ roomId }) => {
    socket.join(roomId);
    socket.data.username = username; socket.data.roomId = roomId;
    presenceCache.set(`online:${username}`, { username, roomId, socketId:socket.id, role }, 0);
    io.to(roomId).emit('presence:update', { roomId, users:getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', { _id:uuidv4(), roomId, sender:'system', text:`${username} joined`, type:'system', createdAt:new Date() });
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(roomId);
    presenceCache.del(`online:${username}`);
    io.to(roomId).emit('presence:update', { roomId, users:getOnlineUsers(roomId) });
    io.to(roomId).emit('message:new', { _id:uuidv4(), roomId, sender:'system', text:`${username} left`, type:'system', createdAt:new Date() });
  });

  socket.on('message:send', async ({ roomId, text, mediaId, mediaUrl, thumbUrl, fileName, fileSize, type: msgType }) => {
    if (!text?.trim() && !mediaId) return;
    try {
      const type = msgType || 'text';
      let msg;
      if (global.DEMO_MODE) {
        msg = { _id:uuidv4(), roomId, sender:username, text:text||'', type, mediaId:mediaId||null, mediaUrl:mediaUrl||null, thumbUrl:thumbUrl||null, fileName:fileName||null, fileSize:fileSize||null, createdAt:new Date(), reactions:{} };
        (demoMessages[roomId]=demoMessages[roomId]||[]).push(msg);
        if (demoMessages[roomId].length>500) demoMessages[roomId].shift();
      } else {
        msg = (await Message.create({ roomId, sender:username, text:text||'', type, mediaId:mediaId||null, mediaUrl:mediaUrl||null, thumbUrl:thumbUrl||null, fileName:fileName||null, fileSize:fileSize||null })).toObject();
      }
      messageCache.delByPrefix(`messages:${roomId}:`);
      io.to(roomId).emit('message:new', msg);
    } catch { socket.emit('error', { message:'Failed to send' }); }
  });

  socket.on('typing:start', ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing:true }));
  socket.on('typing:stop',  ({ roomId }) => socket.to(roomId).emit('typing:update', { username, typing:false }));

  socket.on('message:react', async ({ messageId, emoji, roomId }) => {
    if (!global.DEMO_MODE) await Message.updateOne({ _id:messageId }, { $addToSet:{ [`reactions.${emoji}`]:username } }).catch(()=>{});
    messageCache.delByPrefix(`messages:${roomId}:`);
    io.to(roomId).emit('message:reacted', { messageId, emoji, username });
  });

  // Admin: kick user
  socket.on('admin:kick', ({ targetUsername }) => {
    if (role !== 'admin') return;
    for (const [,s] of io.sockets.sockets)
      if (s.user?.username === targetUsername) { s.emit('kicked', { reason:'Kicked by admin' }); s.disconnect(true); }
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    presenceCache.del(`online:${username}`);
    if (roomId) {
      io.to(roomId).emit('presence:update', { roomId, users:getOnlineUsers(roomId) });
      io.to(roomId).emit('message:new', { _id:uuidv4(), roomId, sender:'system', text:`${username} disconnected`, type:'system', createdAt:new Date() });
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

// ══════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
connectDB().then(() => server.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}   admin: http://localhost:${PORT}/admin`)));
