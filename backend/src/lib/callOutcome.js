import OpenAI from "openai";

const SUPPORTED_OUTCOMES = ["ANSWERED", "NO_ANSWER"];
const DEFAULT_MODEL = process.env.OPENAI_CALL_OUTCOME_MODEL || "gpt-5.0";
const MAX_TURNS = (() => {
  const raw = Number(process.env.CALL_OUTCOME_TRANSCRIPT_TURNS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();
const MAX_CHARS_PER_TURN = (() => {
  const raw = Number(process.env.CALL_OUTCOME_TURN_CHAR_LIMIT ?? 280);
  if (!Number.isFinite(raw)) return 280;
  return Math.max(60, Math.min(raw, 800));
})();

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

const SYSTEM_PROMPT = [
  "You are a call outcome classifier for an outbound lead dialer.",
  "Classify each call using the transcript and metadata.",
  "Return ONLY JSON matching the provided schema.",
  "Possible outcomes:",
  "- ANSWERED: a human engaged with the agent in a meaningful way.",
  "- NO_ANSWER: the call rang out, was declined, reached voicemail, or failed for any reason.",
  "Use the 'reason' field to concisely explain your decision.",
  "Use 'confidence' between 0 and 1 to express certainty.",
].join("\n");

function sanitizeSpeaker(value) {
  if (!value) return null;
  return String(value).toLowerCase().replace(/[^a-z]/g, "_").slice(0, 32) || null;
}

function sanitizeText(value) {
  if (!value) return "";
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS_PER_TURN);
}

function extractText(turn) {
  return (
    turn?.message ??
    turn?.original_message ??
    turn?.text ??
    turn?.transcript ??
    turn?.content ??
    ""
  );
}

function extractSpeaker(turn) {
  return (
    turn?.speaker ??
    turn?.role ??
    turn?.sender ??
    turn?.speaker_name ??
    null
  );
}

function extractOffset(turn) {
  const candidates = [
    turn?.offset_seconds,
    turn?.offset,
    turn?.start_time_secs,
    turn?.start,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildTranscriptExcerpt(transcript) {
  if (!Array.isArray(transcript)) return [];
  const excerpt = [];
  for (const turn of transcript) {
    if (excerpt.length >= MAX_TURNS) break;
    const text = sanitizeText(extractText(turn));
    if (!text) continue;
    excerpt.push({
      speaker: sanitizeSpeaker(extractSpeaker(turn)) ?? "unknown",
      text,
      offset_seconds: extractOffset(turn),
    });
  }
  return excerpt;
}

function buildModelPayload(data = {}) {
  const metadata = data.metadata || {};
  const analysis = data.analysis || {};
  return {
    metadata: {
      call_successful: analysis.call_successful ?? metadata.call_successful ?? null,
      termination_reason: metadata.termination_reason ?? null,
      call_duration_secs:
        metadata.call_duration_secs ?? data.call_duration_secs ?? null,
      features_usage: metadata.features_usage ?? null,
      started_at: metadata.started_at ?? null,
      ended_at: metadata.ended_at ?? null,
      tags: metadata.tags ?? null,
    },
    analysis: {
      transcript_summary: analysis.transcript_summary ?? null,
      call_summary_title: analysis.call_summary_title ?? null,
      action_items: analysis.call_action_items ?? null,
    },
    transcript_excerpt: buildTranscriptExcerpt(data.transcript),
  };
}

function normalizeOutcome(candidate) {
  const value = String(candidate || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (SUPPORTED_OUTCOMES.includes(value)) return value;
  if (value === "NOANSWER" || value === "NO-ANSWER") return "NO_ANSWER";
  if (/ANSWER/.test(value)) return "ANSWERED";
  return "NO_ANSWER";
}


function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, num));
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function inferCallOutcomeFromTranscript(data, options = {}) {
  const client = getClient();
  const model = options.model || DEFAULT_MODEL;
  const payload = buildModelPayload(data);
  const logPrompts = (process.env.LOG_CALL_OUTCOME_PROMPTS ?? "0") === "1";
  const promptText = JSON.stringify(
    {
      instructions:
        "Determine the call outcome using these signals. If information is missing, make the safest choice.",
      payload,
    },
    null,
    2
  );

  if (logPrompts) {
    console.log("[AI CALL OUTCOME] sending prompt", {
      model,
      chars: promptText.length,
      excerpt: promptText.slice(0, 1000),
    });
  }

  const response = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: promptText }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        json_schema: {
          name: "lead_call_outcome",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              outcome: { type: "string", enum: SUPPORTED_OUTCOMES },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
            },
            required: ["outcome"],
          },
        },
      },
    },
    max_output_tokens: 400,
  });

  const parsed =
    response.output?.[0]?.parsed ??
    response.output?.[0]?.content?.[0]?.parsed ??
    safeJsonParse(response.output_text);

  if (!parsed || !parsed.outcome) {
    throw new Error("OpenAI response did not include an outcome");
  }

  const outcome = normalizeOutcome(parsed.outcome);
  if (!SUPPORTED_OUTCOMES.includes(outcome)) {
    throw new Error(`Unsupported outcome returned by OpenAI: ${parsed.outcome}`);
  }

  const confidence = clamp01(parsed.confidence);
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : null;

  return {
    outcome,
    confidence,
    reason,
    raw: parsed,
  };
}

export function shouldUseAiOutcome() {
  return (process.env.CALL_OUTCOME_USE_AI ?? "1") === "1";
}

export { SUPPORTED_OUTCOMES };
