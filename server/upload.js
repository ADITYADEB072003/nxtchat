const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, '../uploads');
const IMAGE_DIR  = path.join(UPLOAD_DIR, 'images');
const VIDEO_DIR  = path.join(UPLOAD_DIR, 'videos');
const THUMB_DIR  = path.join(UPLOAD_DIR, 'thumbs');

[UPLOAD_DIR, IMAGE_DIR, VIDEO_DIR, THUMB_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const MAX_IMAGE_MB = parseInt(process.env.MAX_IMAGE_MB) || 10;
const MAX_VIDEO_MB = parseInt(process.env.MAX_VIDEO_MB) || 50;

const ALLOWED_IMAGES = ['image/jpeg','image/png','image/gif','image/webp'];
const ALLOWED_VIDEOS = ['video/mp4','video/webm','video/ogg','video/quicktime'];
const ALLOWED_ALL    = [...ALLOWED_IMAGES, ...ALLOWED_VIDEOS];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const isVideo = ALLOWED_VIDEOS.includes(file.mimetype);
    cb(null, isVideo ? VIDEO_DIR : IMAGE_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  if (ALLOWED_ALL.includes(file.mimetype)) cb(null, true);
  else cb(new Error(`File type not allowed: ${file.mimetype}`), false);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 }
});

// Generate image thumbnail using sharp (if available)
async function generateThumbnail(filePath, filename) {
  try {
    const sharp = require('sharp');
    const thumbName = `thumb_${filename.replace(/\.[^.]+$/, '.jpg')}`;
    const thumbPath = path.join(THUMB_DIR, thumbName);
    await sharp(filePath).resize(400, 300, { fit: 'cover' }).jpeg({ quality: 70 }).toFile(thumbPath);
    return `/uploads/thumbs/${thumbName}`;
  } catch { return null; }
}

// Generate video thumbnail by extracting first frame placeholder
function getVideoThumb() { return null; } // Videos show a play icon in UI

module.exports = { upload, generateThumbnail, getVideoThumb, ALLOWED_IMAGES, ALLOWED_VIDEOS, IMAGE_DIR, VIDEO_DIR, THUMB_DIR };
