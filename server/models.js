const mongoose = require('mongoose');

// ── Room ────────────────────────────────────────────────────────────────────
const roomSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  createdBy:   { type: String, required: true },
  members:     [String],
  isPrivate:   { type: Boolean, default: false },
}, { timestamps: true });

// ── Message ─────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  roomId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  sender:    { type: String, required: true },
  text:      { type: String, required: true },
  type:      { type: String, enum: ['text', 'system'], default: 'text' },
  edited:    { type: Boolean, default: false },
  reactions: { type: Map, of: [String], default: {} }, // emoji → [usernames]
}, { timestamps: true });

messageSchema.index({ roomId: 1, createdAt: -1 });

// ── User ─────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  avatar:   { type: String, default: '' }, // initials color
  bio:      { type: String, default: '' },
  lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });

const Room    = mongoose.model('Room',    roomSchema);
const Message = mongoose.model('Message', messageSchema);
const User    = mongoose.model('User',    userSchema);

module.exports = { Room, Message, User };
