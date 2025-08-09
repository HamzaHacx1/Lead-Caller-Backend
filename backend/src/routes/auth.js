import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { hashPassword, comparePassword, signJwt } from '../lib/auth.js';

const prisma = new PrismaClient();
const r = Router();

r.post('/seed-admin', async (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email/password required' });
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: 'User exists' });
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, name: name || email, passwordHash, role: 'admin' } });
  return res.json({ ok: true, id: user.id });
});

r.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email/password required' });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export default r;
