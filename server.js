import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { jwtVerify, createRemoteJWKSet } from 'jose';

// Authenticated image-upload service for the RiithoTV admin.
// Verifies the caller's Logto access token (resource = the PostgREST API, the
// same token used for DB writes), stores the file in R2 under `riithotv/`, and
// returns its public URL. R2 credentials stay server-side; the SPA never holds
// them. Hosted on the Coolify box because the Cloudflare token lacks Workers
// permission.

const {
  PORT = '3000',
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET = 'afriinspa-assets',
  R2_PUBLIC_BASE,
  ASSET_PREFIX = 'riithotv',
  LOGTO_JWKS = 'https://auth.afriinspa.com/oidc/jwks',
  RESOURCE = 'https://riithotv-api.178-105-57-200.sslip.io',
  ALLOWED_ORIGINS = 'https://riithotv.co.ke,https://www.riithotv.co.ke,http://localhost:5173',
} = process.env;

const OK_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif'];
const OK_MIME = /^image\//;
const MAX_BYTES = 10 * 1024 * 1024;

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});
const jwks = createRemoteJWKSet(new URL(LOGTO_JWKS));
const origins = ALLOWED_ORIGINS.split(',').map((o) => o.trim());

const app = express();
app.use(cors({ origin: origins, methods: ['POST', 'GET', 'OPTIONS'] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.get('/health', (_req, res) => res.json({ ok: true }));

// Verify the Logto access token (signature via JWKS + audience = the API).
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    await jwtVerify(token, jwks, { audience: RESOURCE });
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no_file' });
  if (!OK_MIME.test(file.mimetype)) return res.status(415).json({ error: 'unsupported_type' });
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (!OK_EXT.includes(ext)) return res.status(415).json({ error: 'unsupported_extension' });

  const key = `${ASSET_PREFIX}/${randomUUID()}.${ext}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    res.json({ url: `${R2_PUBLIC_BASE}/${key}`, key });
  } catch (err) {
    console.error('R2 put failed:', err?.message);
    res.status(502).json({ error: 'upload_failed' });
  }
});

// multer file-size errors → 413
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large' });
  res.status(500).json({ error: 'server_error' });
});

app.listen(Number(PORT), () => console.log(`riithotv-uploads listening on :${PORT}`));
