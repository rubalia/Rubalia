
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const pool = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter(req, file, callback) {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error("Only JPG, PNG and WEBP images are allowed.")
      );
    }

    callback(null, true);
  }
});

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function receiveImage(req, res, next) {
  upload.single("image")(req, res, error => {
    if (!error) return next();

    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Image must not exceed 5 MB."
        : error.message
    });
  });
}

function uploadBuffer(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const options = {
      folder,
      resource_type: "image",
      allowed_formats: [
        "jpg",
        "jpeg",
        "png",
        "webp"
      ],
      transformation: [
        {
          width: 900,
          height: 900,
          crop: "limit"
        },
        {
          quality: "auto:good",
          fetch_format: "auto"
        }
      ],
      ...(publicId ? { public_id: publicId } : {})
    };

    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}

async function deleteCloudinaryImage(publicId) {
  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(
      publicId,
      { resource_type: "image" }
    );
  } catch (error) {
    console.error(
      "Old profile image cleanup failed:",
      error.message
    );
  }
}

// ============================================
// ADMIN: PACKAGE BANNER IMAGE UPLOAD
// Existing endpoint preserved.
// POST /api/upload/image
// ============================================

router.post(
  "/image",
  authenticateToken,
  requireAdmin,
  receiveImage,
  async (req, res, next) => {
    try {
      if (!cloudinaryReady()) {
        return res.status(503).json({
          success: false,
          message: "Image upload service is not configured."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select an image."
        });
      }

      const result = await uploadBuffer(
        req.file.buffer,
        "rubalia/package-banners"
      );

      return res.status(201).json({
        success: true,
        message: "Image uploaded successfully.",
        image: {
          url: result.secure_url,
          public_id: result.public_id,
          width: result.width,
          height: result.height
        }
      });

    } catch (error) {
      console.error(
        "Package banner upload failed:",
        error.message
      );

      next(error);
    }
  }
);

// ============================================
// MEMBER: PROFILE PHOTO UPLOAD
// POST /api/upload/profile-image
// ============================================

router.post(
  "/profile-image",
  authenticateToken,
  receiveImage,
  async (req, res, next) => {
    let newImage = null;

    try {
      if (!cloudinaryReady()) {
        return res.status(503).json({
          success: false,
          message: "Profile photo upload service is not configured."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a profile photo."
        });
      }

      const userId = req.auth && req.auth.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required."
        });
      }

      const current = await pool.query(
        `SELECT id, avatar_public_id
         FROM users
         WHERE id = $1`,
        [userId]
      );

      if (!current.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Member account not found."
        });
      }

      const oldPublicId =
        current.rows[0].avatar_public_id || null;

      newImage = await uploadBuffer(
        req.file.buffer,
        "rubalia/member-profiles",
        `member-${userId}-${Date.now()}`
      );

      const updated = await pool.query(
        `UPDATE users
         SET avatar_url = $1,
             avatar_public_id = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING id, avatar_url`,
        [
          newImage.secure_url,
          newImage.public_id,
          userId
        ]
      );

      if (!updated.rows.length) {
        await deleteCloudinaryImage(newImage.public_id);

        return res.status(404).json({
          success: false,
          message: "Member account not found."
        });
      }

      // Delete previous photo after successful DB update.
      if (
        oldPublicId &&
        oldPublicId !== newImage.public_id
      ) {
        await deleteCloudinaryImage(oldPublicId);
      }

      return res.status(201).json({
        success: true,
        message: "Profile photo updated successfully.",
        image: {
          url: updated.rows[0].avatar_url,
          public_id: newImage.public_id,
          width: newImage.width,
          height: newImage.height
        }
      });

    } catch (error) {
      if (newImage && newImage.public_id) {
        await deleteCloudinaryImage(newImage.public_id);
      }

      console.error(
        "Member profile photo upload failed:",
        error.message
      );

      next(error);
    }
  }
);

module.exports = router;
