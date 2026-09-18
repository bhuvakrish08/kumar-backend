const path = require('path');
const fs = require('fs');

/**
 * Returns the resolved upload directory path based on UPLOAD_DIR environment variable.
 * Fallback: backend/uploads directory in local development environment.
 * Ensures directory exists on disk recursively.
 */
function getUploadDir() {
  const uploadDir = process.env.UPLOAD_DIR && process.env.UPLOAD_DIR.trim() !== ''
    ? path.resolve(process.env.UPLOAD_DIR.trim())
    : path.join(__dirname, '..', 'uploads');

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  return uploadDir;
}

module.exports = { getUploadDir };
