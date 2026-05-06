const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── Room ─────────────────────────────────────────────────────────────────────
const roomSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  createdBy:   { type: String, required: true },
  members:     [String],
  isPrivate:   { type: Boolean, default: false },
}, { timestamps: true });

// ── Message ──────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  roomId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  sender:    { type: String, required: true },
  text:      { type: String, required: true },
  type:      { type: String, enum: ['text', 'system'], default: 'text' },
  edited:    { type: Boolean, default: false },
  reactions: { type: Map, of: [String], default: {} },
}, { timestamps: true });

messageSchema.index({ roomId: 1, createdAt: -1 });

// ── User ─────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:          { type: String, required: true, unique: true, trim: true },
  email:             { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash:      { type: String, required: true },
  avatar:            { type: String, default: '' },
  bio:               { type: String, default: '' },
  lastSeen:          { type: Date, default: Date.now },
  resetOtp:          { type: String, default: null },
  resetOtpExpiresAt: { type: Date,   default: null },
  resetOtpAttempts:  { type: Number, default: 0 },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  next();
});

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.setResetOtp = async function (otp) {
  this.resetOtp          = await bcrypt.hash(otp, 10);
  this.resetOtpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  this.resetOtpAttempts  = 0;
};

userSchema.methods.verifyResetOtp = async function (otp) {
  if (!this.resetOtp || !this.resetOtpExpiresAt) return false;
  if (new Date() > this.resetOtpExpiresAt)        return false;
  if (this.resetOtpAttempts >= 5)                 return false;
  this.resetOtpAttempts++;
  const ok = await bcrypt.compare(otp, this.resetOtp);
  if (!ok) { await this.save(); return false; }
  return true;
};

userSchema.methods.clearResetOtp = function () {
  this.resetOtp = null;
  this.resetOtpExpiresAt = null;
  this.resetOtpAttempts  = 0;
};

const Room    = mongoose.model('Room',    roomSchema);
const Message = mongoose.model('Message', messageSchema);
const User    = mongoose.model('User',    userSchema);

module.exports = { Room, Message, User };
