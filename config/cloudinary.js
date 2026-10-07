const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

if (!cloudName || !apiKey || !apiSecret) {
  console.warn('⚠️  Cloudinary env vars are missing — image uploads will fail.');
} else if (apiKey === 'your_api_key' || cloudName === 'your_cloud_name') {
  console.warn('⚠️  Cloudinary env vars still contain placeholder values from .env — replace them with your real credentials.');
} else {
  console.log(`Cloudinary ready — cloud "${cloudName}", key ending in ...${apiKey.slice(-4)}`);
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'logbase/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
  },
});

const upload = multer({ storage });

// Photos taken while recording a sale (proof of what was sold, condition, etc.)
const saleStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'logbase/sales',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  },
});

const saleUpload = multer({ storage: saleStorage });

// Photos taken while recording a purchase (the delivery, the goods received, the invoice, etc.)
const purchaseStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'logbase/purchases',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  },
});

const purchaseUpload = multer({ storage: purchaseStorage });

// Only pictures a browser can show: JPG, PNG or WebP (an SVG can carry scripts, so it is refused)
function imageOnly(req, file, cb) {
  if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
  const err = new Error('Choose a JPG, PNG or WebP picture');
  err.statusCode = 400;
  cb(err);
}

// A person's own profile photo: one picture, cropped to a square around the face, at most 5 MB
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'logbase/profiles',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: imageOnly,
});

// The wide picture behind the top of a person's profile page: one picture, cropped to a banner, at most 5 MB
const coverStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'logbase/covers',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, height: 480, crop: 'fill', gravity: 'auto' }],
  },
});

const coverUpload = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: imageOnly,
});

module.exports = { cloudinary, upload, saleUpload, purchaseUpload, avatarUpload, coverUpload };
