# ElevenLabs Lead Dialer (Outbound Single Call) – Scaffold

This scaffold ingests Facebook leads, calls them through ElevenLabs *single outbound call* API in a 09:00–16:00 window, retries **only on `failed`**, and provides a tiny React dashboard with JWT login.

## Quickstart

### Backend
```bash
cd backend
cp .env.example .env
# Fill ELEVENLABS keys, JWT_SECRET, etc.
npm i
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Seed admin:
```bash
curl -X POST http://localhost:3001/auth/seed-admin   -H "Content-Type: application/json"   -d '{"email":"admin@example.com","name":"Admin","password":"StrongPass!234"}'
```

### Frontend
```bash
cd ../frontend
cp .env.example .env
npm i
npm run dev   # http://localhost:5173
```

### Wire Zapier
- **FB Lead →** POST to `http://localhost:3001/intake/facebook` with header `Authorization: Bearer <API_KEY>`.
- Body: `{ fbLeadId, full_name, phone, email, timezone, variables, metadata }`

### ElevenLabs webhook
Set Post-Call Webhook → `http://localhost:3001/webhooks/elevenlabs`  
Add header `x-webhook-secret: <EL_WEBHOOK_SECRET>`.

---

**Retry policy:** only when outcome is `failed`, cap 3 attempts.  
**Time window:** clamped to 09:00–16:00 in lead timezone.
