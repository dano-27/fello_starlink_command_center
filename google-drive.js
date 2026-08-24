/**
 * Google Drive Service for DCR File Uploads
 * 
 * Uploads files to a Shared Drive folder, organized by submission.
 * Uses a service account for authentication (no OAuth flow needed).
 * 
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file contents (raw or base64)
 *   GOOGLE_DRIVE_FOLDER_ID — ID of the shared folder (must be in a Shared Drive)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

let driveClient = null;

/**
 * Initialize the Google Drive client from environment variables
 */
function getDriveClient() {
  if (driveClient) return driveClient;

  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!keyRaw || !folderId) {
    console.log('[GDrive] Not configured — missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_DRIVE_FOLDER_ID');
    return null;
  }

  try {
    // Parse the key — support both raw JSON and base64-encoded JSON
    let keyData;
    try {
      keyData = JSON.parse(keyRaw);
    } catch {
      // Try base64 decode
      keyData = JSON.parse(Buffer.from(keyRaw, 'base64').toString('utf8'));
    }

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    driveClient = google.drive({ version: 'v3', auth });
    console.log(`[GDrive] Initialized with service account: ${keyData.client_email}`);
    return driveClient;
  } catch (err) {
    console.error('[GDrive] Initialization error:', err.message);
    return null;
  }
}

/**
 * Create a subfolder inside the root DCR folder
 * @param {string} folderName - e.g. "EB3542 - Acme Corp"
 * @returns {{ folderId: string, folderUrl: string }} or null
 */
async function createSubmissionFolder(folderName) {
  const drive = getDriveClient();
  if (!drive) return null;

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  
  // Check if folder already exists (avoid duplicates)
  try {
    const existing = await drive.files.list({
      q: `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, webViewLink)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });

    if (existing.data.files && existing.data.files.length > 0) {
      const folder = existing.data.files[0];
      console.log(`[GDrive] Reusing existing folder: "${folderName}" (${folder.id})`);
      return {
        folderId: folder.id,
        folderUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      };
    }
  } catch (e) {
    console.log(`[GDrive] Folder search error (will create new): ${e.message}`);
  }

  // Create the folder
  try {
    const folderMeta = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    };

    const folder = await drive.files.create({
      requestBody: folderMeta,
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    console.log(`[GDrive] Created folder: "${folderName}" (${folder.data.id})`);
    return {
      folderId: folder.data.id,
      folderUrl: folder.data.webViewLink || `https://drive.google.com/drive/folders/${folder.data.id}`,
    };
  } catch (err) {
    console.error(`[GDrive] Failed to create folder "${folderName}":`, err.message);
    if (err.errors) console.error(`[GDrive] API errors:`, JSON.stringify(err.errors));
    return null;
  }
}

/**
 * Upload a file to a Google Drive folder (Shared Drive compatible)
 */
async function uploadFile(localPath, fileName, mimeType, folderId) {
  const drive = getDriveClient();
  if (!drive) return null;

  // Verify local file exists before attempting upload
  if (!fs.existsSync(localPath)) {
    console.error(`[GDrive] Local file not found: ${localPath}`);
    return null;
  }
  const fileStats = fs.statSync(localPath);
  console.log(`[GDrive] Uploading "${fileName}" (${fileStats.size} bytes, ${mimeType}) to folder ${folderId}`);

  try {
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: fs.createReadStream(localPath),
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink, size',
      supportsAllDrives: true,
    });

    const fileId = file.data.id;

    // Make the file accessible to anyone with the link
    try {
      await drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
        supportsAllDrives: true,
      });
    } catch (permErr) {
      // Shared Drives may restrict this — not fatal
      console.log(`[GDrive] Permission warning (file still uploaded): ${permErr.message}`);
    }

    console.log(`[GDrive] ✅ Uploaded: "${fileName}" (${fileId}, ${file.data.size} bytes)`);

    return {
      fileId: fileId,
      webViewLink: file.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
      downloadUrl: file.data.webContentLink || `https://drive.google.com/uc?id=${fileId}&export=download`,
      size: parseInt(file.data.size || 0),
    };
  } catch (err) {
    console.error(`[GDrive] ❌ Upload failed for "${fileName}":`, err.message);
    if (err.errors) console.error(`[GDrive] API errors:`, JSON.stringify(err.errors));
    return null;
  }
}

/**
 * Upload multiple files for a DCR submission
 */
async function uploadSubmissionFiles(submissionId, folderName, files, categories = []) {
  if (!files || files.length === 0) return null;

  const drive = getDriveClient();
  if (!drive) {
    console.log('[GDrive] Not configured — files will only be stored locally');
    return null;
  }

  // Create a folder for this submission
  const folder = await createSubmissionFolder(folderName);
  if (!folder) return null;

  // Upload each file
  const uploadedFiles = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // multer v2 may use f.path or construct from destination + filename
    const localPath = f.path || (f.destination && f.filename ? path.join(f.destination, f.filename) : null);
    
    if (!localPath) {
      console.error(`[GDrive] No file path for "${f.originalname}" — multer properties: ${Object.keys(f).join(', ')}`);
      uploadedFiles.push({
        name: f.originalname,
        storedName: f.filename,
        size: f.size,
        type: f.mimetype,
        category: categories[i] || 'general',
        localOnly: true,
        url: `/api/dcr/${submissionId}/files/${f.filename}`,
      });
      continue;
    }

    const result = await uploadFile(localPath, f.originalname, f.mimetype, folder.folderId);

    if (result) {
      uploadedFiles.push({
        name: f.originalname,
        size: f.size,
        type: f.mimetype,
        category: categories[i] || 'general',
        driveFileId: result.fileId,
        driveUrl: result.webViewLink,
        driveDownloadUrl: result.downloadUrl,
      });

      // Delete local temp file after successful upload
      try {
        fs.unlinkSync(localPath);
      } catch (e) {
        // Not critical
      }
    } else {
      // Drive upload failed — keep local file as fallback
      uploadedFiles.push({
        name: f.originalname,
        storedName: f.filename,
        size: f.size,
        type: f.mimetype,
        category: categories[i] || 'general',
        localOnly: true,
        url: `/api/dcr/${submissionId}/files/${f.filename}`,
      });
    }
  }

  return {
    folder: folder,
    files: uploadedFiles,
  };
}

/**
 * Check if Google Drive is configured
 */
function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

module.exports = {
  getDriveClient,
  createSubmissionFolder,
  uploadFile,
  uploadSubmissionFiles,
  isConfigured,
};
