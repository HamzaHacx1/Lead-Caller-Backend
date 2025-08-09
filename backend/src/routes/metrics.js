import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { assertJwt } from '../lib/auth.js';
const prisma = new PrismaClient();
const r = Router();

r.get('/summary', assertJwt, async (req, res) => {
  const today = new Date(new Date().toDateString());
  const [todayLeads, answered, failed, noAnswer, voicemail] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: today } } }),
    prisma.lead.count({ where: { status: 'ANSWERED' } }),
    prisma.lead.count({ where: { status: 'FAILED' } }),
    prisma.lead.count({ where: { status: 'NO_ANSWER' } }),
    prisma.lead.count({ where: { status: 'VOICEMAIL' } })
  ]);
  res.json({ todayLeads, answered, failed, noAnswer, voicemail });
});

r.get('/leads', assertJwt, async (req, res) => {
  const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(leads);
});

r.get('/attempts', assertJwt, async (req, res) => {
  const attempts = await prisma.callAttempt.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(attempts);
});

export default r;
