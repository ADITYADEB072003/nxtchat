/**
 * auth.js — JWT helpers + Express middleware + Nodemailer OTP sender
 */
const jwt      = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const JWT_SECRET  = process.env.JWT_SECRET  || 'nexchat_dev_secret_change_in_prod';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// ── Token helpers ─────────────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws on invalid/expired
}

// ── Express middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Socket.IO middleware ──────────────────────────────────────────────────────
function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}

// ── OTP generator ─────────────────────────────────────────────────────────────
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

// ── Email transporter ─────────────────────────────────────────────────────────
// Uses Ethereal (fake SMTP) in dev — swap with real SMTP creds in production
let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;

  if (process.env.SMTP_HOST) {
    // Real SMTP (production)
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } else {
    // Ethereal test account (dev — no real emails sent)
    const testAccount = await nodemailer.createTestAccount();
    _transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log('📧 Ethereal test email account:', testAccount.user);
    console.log('   Preview emails at https://ethereal.email/messages');
  }
  return _transporter;
}

async function sendOtpEmail(to, username, otp) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from:    process.env.SMTP_FROM || '"NexChat" <noreply@nexchat.dev>',
    to,
    subject: 'Your NexChat password reset code',
    text: `Hi ${username},\n\nYour password reset code is: ${otp}\n\nThis code expires in 15 minutes.\nIf you didn't request this, ignore this email.\n\n— NexChat`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0d0f14;color:#e8eaf0;border-radius:16px;padding:40px;">
        <h1 style="font-family:monospace;color:#7c6af7;margin:0 0 8px">NexChat_</h1>
        <p style="color:#6b7280;margin:0 0 32px;font-size:14px">Password Reset</p>
        <p style="font-size:15px;margin:0 0 24px">Hi <strong>${username}</strong>,</p>
        <p style="font-size:14px;color:#9ca3af;margin:0 0 20px">Use the code below to reset your password. It expires in <strong>15 minutes</strong>.</p>
        <div style="background:#1e2230;border:1px solid #272b38;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
          <span style="font-family:monospace;font-size:36px;font-weight:700;color:#7c6af7;letter-spacing:12px">${otp}</span>
        </div>
        <p style="font-size:13px;color:#6b7280;margin:0">If you didn't request this, you can safely ignore this email.</p>
      </div>`,
  });
  // In dev, print the preview URL so you can inspect the email
  if (!process.env.SMTP_HOST) {
    console.log('📧 Preview URL:', nodemailer.getTestMessageUrl(info));
  }
  return info;
}

module.exports = { signToken, verifyToken, requireAuth, socketAuth, generateOtp, sendOtpEmail };
