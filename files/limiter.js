/**
 * limiter.js — Rate limiting middleware using express-rate-limit
 *
 * Limiters are tiered by sensitivity:
 *
 *   strictLimiter   — auth attack surface (login, register, forgot-password)
 *   otpLimiter      — OTP verification (most sensitive — brute force target)
 *   uploadLimiter   — file uploads (bandwidth cost)
 *   adminLimiter    — admin write actions (ban, delete, broadcast)
 *   apiLimiter      — all other authenticated API routes
 *   socketLimiter   — per-socket message rate (in-memory, no middleware needed)
 *
 * All limits are configurable via environment variables so you can tighten
 * them in production without touching code.
 */

const rateLimit = require('express-rate-limit');

// ── Helper: build a limiter with sensible defaults ────────────────
function make({ windowMin = 15, max, message, prefix }) {
  return rateLimit({
    windowMs: windowMin * 60 * 1000,
    max,
    standardHeaders: true,   // Return RateLimit-* headers
    legacyHeaders:   false,   // Disable X-RateLimit-* headers
    keyGenerator: (req) => {
      // Use forwarded IP (for Render / proxies) falling back to socket IP
      return req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.ip
        || 'unknown';
    },
    handler: (req, res) => {
      const retryAfter = Math.ceil(
        (req.rateLimit.resetTime - Date.now()) / 1000 / 60
      );
      res.status(429).json({
        error:       'Too many requests',
        message:     message || 'Rate limit exceeded. Please try again later.',
        retryAfter:  `${retryAfter} minute${retryAfter !== 1 ? 's' : ''}`,
        limit:       req.rateLimit.limit,
        remaining:   0,
      });
    },
    skip: (req) => {
      // Never rate-limit health checks (needed by UptimeRobot)
      return req.path === '/api/health';
    },
  });
}

// ── Limiter definitions ───────────────────────────────────────────

/**
 * STRICT — login, register, forgot-password
 * 10 attempts per 15 min per IP
 * Prevents credential stuffing and account enumeration
 */
const strictLimiter = make({
  windowMin: parseInt(process.env.RL_AUTH_WINDOW_MIN) || 15,
  max:       parseInt(process.env.RL_AUTH_MAX)         || 10,
  message:   'Too many auth attempts. Please wait 15 minutes.',
  prefix:    'auth',
});

/**
 * OTP — verify-otp and reset-password
 * 5 attempts per 15 min per IP
 * OTPs are 6-digit — without this limit an attacker could brute-force
 * all 1,000,000 combinations. Combined with DB-level attempt counter
 * this gives two independent layers of protection.
 */
const otpLimiter = make({
  windowMin: parseInt(process.env.RL_OTP_WINDOW_MIN) || 15,
  max:       parseInt(process.env.RL_OTP_MAX)         || 5,
  message:   'Too many OTP attempts. Please request a new code.',
  prefix:    'otp',
});

/**
 * UPLOAD — POST /api/upload
 * 20 uploads per hour per IP
 * Prevents storage exhaustion and bandwidth abuse
 */
const uploadLimiter = make({
  windowMin: parseInt(process.env.RL_UPLOAD_WINDOW_MIN) || 60,
  max:       parseInt(process.env.RL_UPLOAD_MAX)         || 20,
  message:   'Upload limit reached. Max 20 files per hour.',
  prefix:    'upload',
});

/**
 * ADMIN — destructive admin write actions
 * 60 actions per 15 min per IP
 * Prevents scripted mass deletions or mass bans
 */
const adminLimiter = make({
  windowMin: parseInt(process.env.RL_ADMIN_WINDOW_MIN) || 15,
  max:       parseInt(process.env.RL_ADMIN_MAX)         || 60,
  message:   'Admin action rate limit exceeded.',
  prefix:    'admin',
});

/**
 * INVITE — join via invite code
 * 20 join attempts per 15 min per IP
 * Prevents invite code brute-force (8-char alphanumeric = large space
 * but still worth rate-limiting)
 */
const inviteLimiter = make({
  windowMin: parseInt(process.env.RL_INVITE_WINDOW_MIN) || 15,
  max:       parseInt(process.env.RL_INVITE_MAX)         || 20,
  message:   'Too many invite attempts. Please wait.',
  prefix:    'invite',
});

/**
 * API — general authenticated API calls
 * 300 requests per 15 min per IP
 * Soft ceiling to prevent runaway clients or scrapers
 */
const apiLimiter = make({
  windowMin: parseInt(process.env.RL_API_WINDOW_MIN) || 15,
  max:       parseInt(process.env.RL_API_MAX)         || 300,
  message:   'API rate limit exceeded. Please slow down.',
  prefix:    'api',
});

// ── Socket.IO message rate limiter (in-memory, per socket) ────────
// Not Express middleware — call checkSocketRate(socket) in the handler.
const socketMessageCounts = new Map(); // socketId → { count, resetAt }

const SOCKET_MAX     = parseInt(process.env.RL_SOCKET_MAX)      || 30;  // messages
const SOCKET_WINDOW  = parseInt(process.env.RL_SOCKET_WINDOW_MS) || 10000; // 10 seconds

function checkSocketRate(socket) {
  const now   = Date.now();
  const entry = socketMessageCounts.get(socket.id);

  if (!entry || now > entry.resetAt) {
    // New window
    socketMessageCounts.set(socket.id, { count: 1, resetAt: now + SOCKET_WINDOW });
    return true;  // allowed
  }

  entry.count++;
  if (entry.count > SOCKET_MAX) {
    socket.emit('error', {
      code:    'RATE_LIMITED',
      message: `Message rate limit: max ${SOCKET_MAX} messages per ${SOCKET_WINDOW/1000}s`,
    });
    return false; // blocked
  }
  return true;   // allowed
}

// Clean up disconnected sockets from the map
function cleanSocketRate(socketId) {
  socketMessageCounts.delete(socketId);
}

// ── Summary helper — logs active limits on startup ────────────────
function logLimits() {
  console.log('🛡  Rate limits active:');
  console.log(`   Auth      ${strictLimiter.options?.max || 10} req / 15 min`);
  console.log(`   OTP       ${otpLimiter.options?.max    || 5}  req / 15 min`);
  console.log(`   Upload    ${uploadLimiter.options?.max || 20} req / 60 min`);
  console.log(`   Admin     ${adminLimiter.options?.max  || 60} req / 15 min`);
  console.log(`   Invite    ${inviteLimiter.options?.max || 20} req / 15 min`);
  console.log(`   API       ${apiLimiter.options?.max    || 300} req / 15 min`);
  console.log(`   Socket    ${SOCKET_MAX} msg / ${SOCKET_WINDOW/1000}s per connection`);
}

module.exports = {
  strictLimiter,
  otpLimiter,
  uploadLimiter,
  adminLimiter,
  inviteLimiter,
  apiLimiter,
  checkSocketRate,
  cleanSocketRate,
  logLimits,
};
