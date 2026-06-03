/**
 * db.js — Sequelize setup + model definitions
 *
 * Supports three SQL dialects via DB_DIALECT env var:
 *   sqlite   → local file, no server needed (default for dev)
 *   postgres → PostgreSQL / Neon / Supabase
 *   mysql    → MySQL / PlanetScale / MariaDB
 */
require('dotenv').config();
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const path   = require('path');

const DIALECT = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

// ── Connection ────────────────────────────────────────────────────
let sequelize;

if (DIALECT === 'sqlite') {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '../../nexchat.db');
  sequelize = new Sequelize({ dialect:'sqlite', storage: dbPath, logging: false });

} else if (DIALECT === 'postgres') {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true'
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : {},
  });

} else if (DIALECT === 'mysql') {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'mysql',
    logging: false,
  });

} else {
  throw new Error(`Unsupported DB_DIALECT: "${DIALECT}". Use sqlite | postgres | mysql`);
}

// ══════════════════════════════════════════════════════════════════
//  MODEL DEFINITIONS
// ══════════════════════════════════════════════════════════════════

// ── User ──────────────────────────────────────────────────────────
const User = sequelize.define('User', {
  id:                 { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  username:           { type: DataTypes.STRING(40),  allowNull: false, unique: true },
  email:              { type: DataTypes.STRING(255),  allowNull: false, unique: true },
  passwordHash:       { type: DataTypes.STRING(255),  allowNull: false },
  avatar:             { type: DataTypes.STRING(20),   defaultValue: '#7C6AF7' },
  bio:                { type: DataTypes.STRING(500),  defaultValue: '' },
  role:               { type: DataTypes.ENUM('user','admin'), defaultValue: 'user' },
  banned:             { type: DataTypes.BOOLEAN,      defaultValue: false },
  bannedReason:       { type: DataTypes.STRING(500),  defaultValue: '' },
  lastSeen:           { type: DataTypes.DATE,         defaultValue: DataTypes.NOW },
  resetOtp:           { type: DataTypes.STRING(255),  allowNull: true },
  resetOtpExpiresAt:  { type: DataTypes.DATE,         allowNull: true },
  resetOtpAttempts:   { type: DataTypes.INTEGER,      defaultValue: 0 },
}, { tableName: 'users', underscored: true });

// Hash password before create / update
User.addHook('beforeCreate', async (u) => { u.passwordHash = await bcrypt.hash(u.passwordHash, 12); });
User.addHook('beforeUpdate', async (u) => {
  if (u.changed('passwordHash')) u.passwordHash = await bcrypt.hash(u.passwordHash, 12);
});

// Instance helpers
User.prototype.verifyPassword    = function(plain) { return bcrypt.compare(plain, this.passwordHash); };
User.prototype.setResetOtp       = async function(otp) {
  this.resetOtp          = await bcrypt.hash(otp, 10);
  this.resetOtpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  this.resetOtpAttempts  = 0;
};
User.prototype.verifyResetOtp    = async function(otp) {
  if (!this.resetOtp || !this.resetOtpExpiresAt) return false;
  if (new Date() > this.resetOtpExpiresAt)        return false;
  if (this.resetOtpAttempts >= 5)                 return false;
  this.resetOtpAttempts++;
  const ok = await bcrypt.compare(otp, this.resetOtp);
  if (!ok) { await this.save(); return false; }
  return true;
};
User.prototype.clearResetOtp     = function() {
  this.resetOtp = null; this.resetOtpExpiresAt = null; this.resetOtpAttempts = 0;
};

// ── Room ──────────────────────────────────────────────────────────
const Room = sequelize.define('Room', {
  id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:          { type: DataTypes.STRING(80),  allowNull: false, unique: true },
  description:   { type: DataTypes.STRING(500), defaultValue: '' },
  createdBy:     { type: DataTypes.STRING(40),  allowNull: false },
  isPrivate:     { type: DataTypes.BOOLEAN,     defaultValue: false },
  inviteCode:    { type: DataTypes.STRING(8),   allowNull: true, unique: true },
  inviteEnabled: { type: DataTypes.BOOLEAN,     defaultValue: false },
}, { tableName: 'rooms', underscored: true });

// ── RoomMember  (join table — replaces members[] array) ───────────
const RoomMember = sequelize.define('RoomMember', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  roomId:   { type: DataTypes.UUID, allowNull: false },
  username: { type: DataTypes.STRING(40), allowNull: false },
  joinedVia:{ type: DataTypes.ENUM('invite','created','seed'), defaultValue: 'invite' },
}, { tableName: 'room_members', underscored: true, indexes: [{ unique: true, fields: ['room_id','username'] }] });

Room.hasMany(RoomMember,    { foreignKey: 'roomId', as: 'roomMembers' });
RoomMember.belongsTo(Room,  { foreignKey: 'roomId' });

// Room helpers
Room.prototype.generateInviteCode = function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  this.inviteCode    = code;
  this.inviteEnabled = true;
  return code;
};
Room.prototype.disableInvite = function() {
  this.inviteCode = null; this.inviteEnabled = false;
};

// ── Message ───────────────────────────────────────────────────────
const Message = sequelize.define('Message', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  roomId:   { type: DataTypes.UUID, allowNull: false },
  sender:   { type: DataTypes.STRING(40), allowNull: false },
  text:     { type: DataTypes.TEXT,       defaultValue: '' },
  type:     { type: DataTypes.ENUM('text','system','image','video'), defaultValue: 'text' },
  mediaId:  { type: DataTypes.UUID,       allowNull: true },
  mediaUrl: { type: DataTypes.STRING(500), allowNull: true },
  thumbUrl: { type: DataTypes.STRING(500), allowNull: true },
  fileName: { type: DataTypes.STRING(255), allowNull: true },
  fileSize: { type: DataTypes.BIGINT,     allowNull: true },
  edited:   { type: DataTypes.BOOLEAN,    defaultValue: false },
}, { tableName: 'messages', underscored: true, indexes: [{ fields: ['room_id','created_at'] }] });

Room.hasMany(Message,    { foreignKey: 'roomId', as: 'messages' });
Message.belongsTo(Room,  { foreignKey: 'roomId' });

// ── Reaction (replaces reactions Map) ────────────────────────────
const Reaction = sequelize.define('Reaction', {
  id:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  messageId: { type: DataTypes.UUID,          allowNull: false },
  emoji:     { type: DataTypes.STRING(10),    allowNull: false },
  username:  { type: DataTypes.STRING(40),    allowNull: false },
}, { tableName: 'reactions', underscored: true, indexes: [{ unique: true, fields: ['message_id','emoji','username'] }] });

Message.hasMany(Reaction,   { foreignKey: 'messageId', as: 'reactions' });
Reaction.belongsTo(Message, { foreignKey: 'messageId' });

// ── Media ─────────────────────────────────────────────────────────
const Media = sequelize.define('Media', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  filename:     { type: DataTypes.STRING(255), allowNull: false },
  originalName: { type: DataTypes.STRING(255), allowNull: false },
  mimeType:     { type: DataTypes.STRING(100), allowNull: false },
  size:         { type: DataTypes.BIGINT,      allowNull: false },
  type:         { type: DataTypes.ENUM('image','video'), allowNull: false },
  thumbnail:    { type: DataTypes.STRING(500), allowNull: true },
  uploadedBy:   { type: DataTypes.STRING(40),  allowNull: false },
  roomId:       { type: DataTypes.UUID,        allowNull: false },
}, { tableName: 'media', underscored: true });

// ══════════════════════════════════════════════════════════════════
//  CONNECT & SYNC
// ══════════════════════════════════════════════════════════════════
async function connectDB() {
  await sequelize.authenticate();
  // alter:true updates existing tables without dropping data
  await sequelize.sync({ alter: true });
  console.log(`✅ SQL (${DIALECT}) connected and synced`);
}

// ══════════════════════════════════════════════════════════════════
//  QUERY HELPERS  (match the Mongoose API shape used by index.js)
// ══════════════════════════════════════════════════════════════════

/** Returns plain room object with members[] array attached */
async function roomWithMembers(room) {
  if (!room) return null;
  const r  = room.get ? room.get({ plain: true }) : { ...room };
  const ms = await RoomMember.findAll({ where: { roomId: r.id }, attributes: ['username'] });
  r.members      = ms.map(m => m.username);
  r.inviteUsedBy = r.members; // compatibility alias
  r._id          = r.id;      // compatibility alias
  return r;
}

/** Find rooms visible to a given user */
async function findRoomsForUser(username, isAdmin) {
  let rows;
  if (isAdmin) {
    rows = await Room.findAll({ order: [['createdAt','ASC']] });
  } else {
    // Room is public, OR user created it, OR user is a member
    const memberOf = await RoomMember.findAll({ where: { username }, attributes: ['roomId'] });
    const memberIds = memberOf.map(m => m.roomId);
    rows = await Room.findAll({
      where: {
        [Op.or]: [
          { isPrivate: false },
          { createdBy: username },
          { id: { [Op.in]: memberIds.length ? memberIds : ['__none__'] } },
        ]
      },
      order: [['createdAt','ASC']],
    });
  }
  return Promise.all(rows.map(roomWithMembers));
}

/** Add user as a member of a room (idempotent) */
async function addMember(roomId, username, joinedVia = 'invite') {
  await RoomMember.findOrCreate({ where: { roomId, username }, defaults: { joinedVia } });
}

/** Remove user from a room */
async function removeMember(roomId, username) {
  await RoomMember.destroy({ where: { roomId, username } });
}

/** Fetch last N messages for a room, including reactions */
async function findMessages(roomId, limit = 50) {
  const msgs = await Message.findAll({
    where: { roomId },
    order: [['createdAt','DESC']],
    limit,
    include: [{ model: Reaction, as: 'reactions', attributes: ['emoji','username'] }],
  });
  // Reverse to ascending order and convert reactions to Map-like object
  return msgs.reverse().map(m => {
    const plain = m.get({ plain: true });
    plain._id   = plain.id;
    // group reactions: { emoji: [username, ...] }
    const reactionMap = {};
    (plain.reactions || []).forEach(r => {
      if (!reactionMap[r.emoji]) reactionMap[r.emoji] = [];
      reactionMap[r.emoji].push(r.username);
    });
    plain.reactions = reactionMap;
    return plain;
  });
}

/** Add or toggle a reaction */
async function addReaction(messageId, emoji, username) {
  const [, created] = await Reaction.findOrCreate({ where: { messageId, emoji, username } });
  if (!created) await Reaction.destroy({ where: { messageId, emoji, username } });
}

/** Safe user object (strips secrets) */
function safeUser(u) {
  const plain = u.get ? u.get({ plain: true }) : { ...u };
  const { passwordHash, resetOtp, resetOtpExpiresAt, resetOtpAttempts, ...rest } = plain;
  rest._id = rest.id;
  return rest;
}

module.exports = {
  sequelize, Op,
  User, Room, RoomMember, Message, Reaction, Media,
  connectDB,
  roomWithMembers, findRoomsForUser, addMember, removeMember,
  findMessages, addReaction, safeUser,
};
