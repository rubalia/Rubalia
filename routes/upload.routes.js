const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

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
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(
        new Error("Only JPG, PNG and WEBP images are allowed.")
      );
    }

    callback(null, true);
  }
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "rubalia/package-banners",
        resource_type: "image",
        allowed_formats: ["jpg", "jpeg", "png", "webp"],
        transformation: [
          {
            quality: "auto",
            fetch_format: "auto"
          }
        ]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}

// ADMIN: Upload package banner
router.post(
  "/image",
  authenticateToken,
  requireAdmin,
  (req, res, next) => {
    upload.single("image")(req, res, (error) => {
      if (error) {
        return res.status(400).json({
          success: false,
          message: error.code === "LIMIT_FILE_SIZE"
            ? "Image must not exceed 5 MB."
            : error.message
        });
      }

      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!process.env.CLOUDINARY_CLOUD_NAME ||
          !process.env.CLOUDINARY_API_KEY ||
          !process.env.CLOUDINARY_API_SECRET) {
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

      const result = await uploadToCloudinary(req.file.buffer);

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
      console.error("Cloudinary upload failed:", error.message);
      next(error);
    }
  }
);

module.exports = router;
