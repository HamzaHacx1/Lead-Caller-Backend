import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

/** API key (for Zapier intake) */
export function assertApiKey(req, res, next) {
  const cfgKey = process.env.API_KEY;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!cfgKey || token !== cfgKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/** Webhook secret (for ElevenLabs) */
export function assertWebhookSecret(req, res, next) {
  const secret = req.headers['x-elevenlabs-signature'] || req.headers['x-webhook-secret'];
  if (process.env.EL_WEBHOOK_SECRET && secret !== process.env.EL_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'bad_signature' });
  }
  next();
}

// Password helpers
export async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}
export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// JWT
export function signJwt(payload, expiresIn = '7d') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}
export function assertJwt(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(raw, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
