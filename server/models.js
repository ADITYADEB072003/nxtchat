const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── Room ─────────────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const roomSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  createdBy:   { type: String, required: true },
  members:     [String],
  isPrivate:   { type: Boolean, default: false },
  inviteCode:  { type: String, unique: true, sparse: true, default: null },
  inviteEnabled: { type: Boolean, default: false },
  inviteUsedBy:  [String],
}, { timestamps: true });

// Generate a fresh unique invite code
roomSchema.methods.generateInviteCode = function() {
  this.inviteCode    = genCode();
  this.inviteEnabled = true;
  return this.inviteCode;
};

roomSchema.methods.disableInvite = function() {
  this.inviteCode    = null;
  this.inviteEnabled = false;
};

// ── Media ─────────────────────────────────────────────────────────────────────
const mediaSchema = new mongoose.Schema({
  filename:     { type: String, required: true },
  originalName: { type: String, required: true },
  mimeType:     { type: String, required: true },
  size:         { type: Number, required: true },
  type:         { type: String, enum: ['image','video'], required: true },
  thumbnail:    { type: String, default: null },
  uploadedBy:   { type: String, required: true },
  roomId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
}, { timestamps: true });

// ── Message ───────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  roomId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  sender:    { type: String, required: true },
  text:      { type: String, default: '' },
  type:      { type: String, enum: ['text','system','image','video'], default: 'text' },
  mediaId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },
  mediaUrl:  { type: String, default: null },
  thumbUrl:  { type: String, default: null },
  fileName:  { type: String, default: null },
  fileSize:  { type: Number, default: null },
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
  role:              { type: String, enum: ['user','admin'], default: 'user' },
  banned:            { type: Boolean, default: false },
  bannedReason:      { type: String, default: '' },
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
userSchema.methods.verifyPassword = function (plain) { return bcrypt.compare(plain, this.passwordHash); };
userSchema.methods.setResetOtp = async function (otp) {
  this.resetOtp = await bcrypt.hash(otp, 10);
  this.resetOtpExpiresAt = new Date(Date.now() + 15*60*1000);
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
  this.resetOtp = null; this.resetOtpExpiresAt = null; this.resetOtpAttempts = 0;
};

const Room    = mongoose.model('Room',    roomSchema);
const Media   = mongoose.model('Media',   mediaSchema);
const Message = mongoose.model('Message', messageSchema);
const User    = mongoose.model('User',    userSchema);

module.exports = { Room, Media, Message, User };
