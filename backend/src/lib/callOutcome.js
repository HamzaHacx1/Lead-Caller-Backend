import OpenAI from "openai";

const SUPPORTED_OUTCOMES = ["ANSWERED", "NO_ANSWER"];
const DEFAULT_MODEL = process.env.OPENAI_CALL_OUTCOME_MODEL || "gpt-5";
const MAX_TURNS = (() => {
  const raw = Number(process.env.CALL_OUTCOME_TRANSCRIPT_TURNS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();
const MAX_CHARS_PER_TURN = (() => {
  const raw = Number(process.env.CALL_OUTCOME_TURN_CHAR_LIMIT ?? 280);
  if (!Number.isFinite(raw)) return 280;
  return Math.max(60, Math.min(raw, 800));
})();

const OUTCOME_ALIASES = {
  ANSWERED: new Set([
    "ANSWERED",
    "ANSWER",
    "HUMAN_ANSWERED",
    "LIVE_ANSWER",
    "HUMAN_CONNECTED",
    "CONNECTED",
    "SUCCESS",
    "SUCCESSFUL_CALL",
    "CUSTOMER_ANSWERED",
    "CALL_COMPLETED",
    "REACHED_PARTY",
  ]),
  NO_ANSWER: new Set([
    "NO_ANSWER",
    "NOANSWER",
    "NOT_ANSWERED",
    "UNANSWERED",
    "NO_RESPONSE",
    "NO_RESPONSE_RECEIVED",
    "FAILED",
    "FAILURE",
    "VOICEMAIL",
    "REACHED_VOICEMAIL",
    "LEFT_VOICEMAIL",
    "CALL_FAILED",
    "MISSED",
    "DECLINED",
    "REJECTED",
    "BUSY",
    "USER_BUSY",
    "CANCELED",
    "CANCELLED",
    "CARRIER_ERROR",
    "DID_NOT_ANSWER",
    "NO_PICKUP",
    "NO_PICK_UP",
    "NOT_CONNECTED",
    "NO_AGENT",
    "SILENCE",
  ]),
};

const MIN_ANSWER_DURATION_SECS = Math.max(
  1,
  Number(process.env.MIN_ANSWER_DURATION_SECS ?? 10)
);
const SUSTAINED_CONVERSATION_SECS = Math.max(
  MIN_ANSWER_DURATION_SECS + 5,
  18
);

const DECLINE_PATTERNS = [
  "declined",
  "rejected",
  "cancelled",
  "canceled",
  "hangup",
  "hung up",
  "user busy",
  "caller hung up",
  "call declined",
  "call rejected",
  "call canceled",
];
const REMOTE_HANGUP_PATTERNS = [
  "remote party",
  "ended by remote",
  "remote hangup",
  "remote side hung up",
  "callee hung up",
  "customer ended",
];
const BUSY_PATTERNS = ["busy", "line busy", "user busy", "number busy"];
const ERROR_PATTERNS = [
  "carrier_error",
  "carrier error",
  "error",
  "failed",
  "failure",
  "not reachable",
  "no route",
];
const NO_ANSWER_TERMS = [
  "no_answer",
  "no-answer",
  "noanswer",
  "no answer",
  "did not answer",
  "didn't answer",
  "no pickup",
  "no pick up",
  "no_pickup",
  "no response",
  "no response received",
  "no agent",
  "silence",
];

const HUMAN_SPEAKER_HINT = /\b(user|human|caller|lead|callee|customer|person)\b/;
const AGENT_SPEAKER_HINT = /\b(agent|assistant|ai|ivr|bot)\b/;

const LOG_DECISIONS =
  (process.env.LOG_CALL_OUTCOME_DECISIONS ??
    process.env.LOG_CALL_OUTCOME_PROMPTS ??
    "0") === "1";

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
  "If the transcript does not contain clear human speech or metadata is inconclusive, choose NO_ANSWER.",
  "Do not assume ANSWERED unless success is explicit or human dialogue is documented.",
  "Use the 'reason' field to concisely explain your decision.",
  "Use 'confidence' between 0 and 1 to express certainty.",
].join("\n");

function sanitizeSpeaker(value) {
  if (!value) return null;
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z]/g, "_")
      .slice(0, 32) || null
  );
}

function sanitizeText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS_PER_TURN);
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
    turn?.speaker ?? turn?.role ?? turn?.sender ?? turn?.speaker_name ?? null
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
      call_successful:
        analysis.call_successful ?? metadata.call_successful ?? null,
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

function canonicalizeOutcomeString(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOutcome(candidate) {
  const canonical = canonicalizeOutcomeString(candidate);
  if (SUPPORTED_OUTCOMES.includes(canonical)) return canonical;
  for (const outcome of SUPPORTED_OUTCOMES) {
    if (OUTCOME_ALIASES[outcome].has(canonical)) return outcome;
  }
  return "NO_ANSWER";
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, num));
}

function boolLike(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
    return [
      "true",
      "1",
      "yes",
      "y",
      "success",
      "ok",
      "answered",
      "complete",
    ].includes(normalized);
  }
  return false;
}

function includesAny(text, patterns) {
  if (!text) return false;
  const hay = String(text).toLowerCase();
  return patterns.some((p) => hay.includes(p));
}

function collectOutcomeSignals(data = {}) {
  const metadata = data.metadata || {};
  const analysis = data.analysis || {};
  const callDurationRaw =
    metadata.call_duration_secs ?? data.call_duration_secs ?? 0;
  const callDurationSecs = Number.isFinite(Number(callDurationRaw))
    ? Number(callDurationRaw)
    : 0;

  const termination = String(metadata.termination_reason || "")
    .trim()
    .toLowerCase();
  const success = boolLike(analysis.call_successful ?? metadata.call_successful);

  const transcript = Array.isArray(data.transcript) ? data.transcript : [];

  let hasHumanUtterance = false;
  let transcriptHasDecline = false;
  let transcriptMentionsBusy = false;
  let transcriptMentionsNoAnswer = false;

  for (const turn of transcript) {
    const rawText = extractText(turn);
    if (!rawText) continue;
    const text = String(rawText).trim();
    if (!text) continue;
    const lower = text.toLowerCase();

    const speakerRaw = String(extractSpeaker(turn) || "").toLowerCase();
    const isAgent =
      turn?.is_agent === true || AGENT_SPEAKER_HINT.test(speakerRaw);
    const isHuman =
      turn?.is_agent === false ||
      HUMAN_SPEAKER_HINT.test(speakerRaw) ||
      (!isAgent && !!speakerRaw && !AGENT_SPEAKER_HINT.test(speakerRaw));

    if (isHuman && text.length > 1) {
      hasHumanUtterance = true;
    }

    if (!transcriptHasDecline && includesAny(lower, DECLINE_PATTERNS)) {
      transcriptHasDecline = true;
    }
    if (!transcriptMentionsBusy && includesAny(lower, BUSY_PATTERNS)) {
      transcriptMentionsBusy = true;
    }
    if (!transcriptMentionsNoAnswer && includesAny(lower, NO_ANSWER_TERMS)) {
      transcriptMentionsNoAnswer = true;
    }
  }

  const hasDeclineTerm =
    includesAny(termination, DECLINE_PATTERNS) || transcriptHasDecline;
  const hasBusySignal =
    includesAny(termination, BUSY_PATTERNS) || transcriptMentionsBusy;
  const hasNoAnswerTerm =
    includesAny(termination, NO_ANSWER_TERMS) || transcriptMentionsNoAnswer;
  const hasCarrierError = includesAny(termination, ERROR_PATTERNS);
  const remoteHangup = includesAny(termination, REMOTE_HANGUP_PATTERNS);
  const sustainedHumanConversation =
    hasHumanUtterance && callDurationSecs >= SUSTAINED_CONVERSATION_SECS;

  return {
    callDurationSecs,
    termination,
    success,
    hasHumanUtterance,
    hasDeclineTerm,
    hasBusySignal,
    hasNoAnswerTerm,
    hasCarrierError,
    remoteHangup,
    sustainedHumanConversation,
    transcriptTurns: transcript.length,
  };
}

function forceOutcomeFromSignals(signals) {
  if (!signals) return null;
  if (signals.success) {
    return { outcome: "ANSWERED", reason: "success_flag", confidence: 0.95 };
  }
  if (signals.hasCarrierError) {
    return {
      outcome: "NO_ANSWER",
      reason: "termination_error",
      confidence: 0.9,
    };
  }
  if (signals.remoteHangup && signals.hasHumanUtterance) {
    return {
      outcome: "ANSWERED",
      reason: "remote_hangup_after_speech",
      confidence: 0.9,
    };
  }
  if (signals.sustainedHumanConversation) {
    return {
      outcome: "ANSWERED",
      reason: "sustained_human_conversation",
      confidence: 0.88,
    };
  }
  if (
    signals.callDurationSecs > 0 &&
    signals.callDurationSecs < MIN_ANSWER_DURATION_SECS &&
    !signals.hasHumanUtterance
  ) {
    return {
      outcome: "NO_ANSWER",
      reason: "short_connect_no_human",
      confidence: 0.85,
    };
  }
  if (
    (signals.hasDeclineTerm ||
      signals.hasBusySignal ||
      signals.hasNoAnswerTerm) &&
    !signals.hasHumanUtterance
  ) {
    return {
      outcome: "NO_ANSWER",
      reason: "declined_or_no_answer_signals",
      confidence: 0.85,
    };
  }
  return null;
}

function combineReasonParts(...parts) {
  const filtered = parts
    .filter((part) => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!filtered.length) return null;
  return filtered.join(" | ");
}

function applyOutcomeGuards(result, signals) {
  if (!signals) {
    return {
      outcome: result.outcome,
      confidence: clamp01(result.confidence),
      reason: result.reason ?? null,
      raw: result.raw ? { ...result.raw } : {},
    };
  }

  const guardNotes = [];
  let outcome = result.outcome;
  let confidence =
    result.confidence == null ? null : clamp01(result.confidence);
  let reason = result.reason ?? null;

  const ensureMinConfidence = (value) => {
    if (value == null) return;
    confidence =
      confidence == null ? clamp01(value) : clamp01(Math.max(confidence, value));
  };
  const ensureMaxConfidence = (value) => {
    if (value == null) return;
    confidence =
      confidence == null ? clamp01(value) : clamp01(Math.min(confidence, value));
  };
  const addGuardNote = (note) => {
    if (!guardNotes.includes(note)) {
      guardNotes.push(note);
    }
  };

  if (outcome === "ANSWERED") {
    if (signals.hasCarrierError) {
      outcome = "NO_ANSWER";
      addGuardNote("override_carrier_error");
      ensureMinConfidence(0.8);
    } else if (!signals.hasHumanUtterance) {
      outcome = "NO_ANSWER";
      addGuardNote("override_no_human_speech");
      ensureMaxConfidence(0.6);
    } else if (
      signals.callDurationSecs > 0 &&
      signals.callDurationSecs < MIN_ANSWER_DURATION_SECS
    ) {
      outcome = "NO_ANSWER";
      addGuardNote("override_short_call");
      ensureMaxConfidence(0.65);
    }
  } else if (outcome === "NO_ANSWER") {
    if (signals.success) {
      outcome = "ANSWERED";
      addGuardNote("override_success_flag");
      ensureMinConfidence(0.95);
    } else if (signals.remoteHangup && signals.hasHumanUtterance) {
      outcome = "ANSWERED";
      addGuardNote("override_remote_hangup");
      ensureMinConfidence(0.9);
    } else if (signals.sustainedHumanConversation) {
      outcome = "ANSWERED";
      addGuardNote("override_human_conversation");
      ensureMinConfidence(0.88);
    }
  }

  const guardReason =
    guardNotes.length > 0 ? `guard:${guardNotes.join(",")}` : null;
  const finalReason = combineReasonParts(guardReason, reason);

  const raw = result.raw ? { ...result.raw } : {};
  if (guardNotes.length > 0) {
    raw.guard = {
      ...(raw.guard || {}),
      adjusted: true,
      notes: guardNotes,
    };
    if (LOG_DECISIONS) {
      console.log("[AI CALL OUTCOME] guard adjustment", {
        original: result.outcome,
        final: outcome,
        notes: guardNotes,
        confidence,
        call_duration_secs: signals.callDurationSecs,
        human_utterance: signals.hasHumanUtterance,
        termination: signals.termination?.slice(0, 120) || null,
      });
    }
  }

  return {
    outcome,
    confidence: confidence == null ? null : clamp01(confidence),
    reason: finalReason,
    raw,
  };
}

export async function inferCallOutcomeFromTranscript(data, options = {}) {
  const signals = collectOutcomeSignals(data);
  const forced = forceOutcomeFromSignals(signals);

  if (forced) {
    const confidence =
      clamp01(forced.confidence) ??
      (forced.outcome === "ANSWERED" ? 0.9 : 0.85);
    if (LOG_DECISIONS) {
      console.log("[AI CALL OUTCOME] forced by signals", {
        outcome: forced.outcome,
        reason: forced.reason,
        confidence,
        call_duration_secs: signals.callDurationSecs,
        human_utterance: signals.hasHumanUtterance,
        termination: signals.termination?.slice(0, 120) || null,
      });
    }
    return {
      outcome: forced.outcome,
      confidence,
      reason: forced.reason,
      raw: {
        outcome: forced.outcome,
        confidence,
        reason: forced.reason,
        guard: {
          forced: true,
          reason: forced.reason,
          signals: {
            call_duration_secs: signals.callDurationSecs,
            human_utterance: signals.hasHumanUtterance,
            success: signals.success,
            termination: signals.termination ?? null,
          },
        },
      },
    };
  }

  const client = getClient();
  const model = options.model || DEFAULT_MODEL || "gpt-5";
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
    input: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: promptText,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "lead_call_outcome",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: SUPPORTED_OUTCOMES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
          required: ["outcome", "confidence", "reason"], // Schema is now complete
        },
        strict: true,
      },
    },

    max_output_tokens: 400,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(response.output_text || "");
  } catch (err) {
    parsed = null;
  }

  if (!parsed || !parsed.outcome) {
    throw new Error("OpenAI response did not include an outcome");
  }

  const outcome = normalizeOutcome(parsed.outcome);
  if (!SUPPORTED_OUTCOMES.includes(outcome)) {
    throw new Error(
      `Unsupported outcome returned by OpenAI: ${parsed.outcome}`
    );
  }

  const confidence = clamp01(parsed.confidence);
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : null;

  const guarded = applyOutcomeGuards(
    {
      outcome,
      confidence,
      reason,
      raw: parsed,
    },
    signals
  );

  return {
    outcome: guarded.outcome,
    confidence: guarded.confidence,
    reason: guarded.reason,
    raw: guarded.raw,
  };
}

export function shouldUseAiOutcome() {
  return (process.env.CALL_OUTCOME_USE_AI ?? "1") === "1";
}

export { SUPPORTED_OUTCOMES };
