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

### AI Outcome Mapping
- Set `OPENAI_API_KEY` with a key that can access GPT-5 on the OpenAI Responses API.
- Optional overrides: `OPENAI_CALL_OUTCOME_MODEL` (defaults to `gpt-5.0`), `CALL_OUTCOME_USE_AI` (default `1`), `CALL_OUTCOME_TRANSCRIPT_TURNS`, `CALL_OUTCOME_TURN_CHAR_LIMIT`, `LOG_CALL_OUTCOME_PROMPTS`.
- The system only emits `ANSWERED` or `NO_ANSWER`; voicemail and technical failures map to `NO_ANSWER` so downstream notifications stay consistent.
- If the AI call fails or is disabled, the legacy heuristic fallback still runs so webhooks keep working.

---

**Retry policy:** only when outcome is `failed`, cap 3 attempts.  
**Time window:** clamped to 09:00–16:00 in lead timezone.
