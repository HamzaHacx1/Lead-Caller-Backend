import OpenAI from "openai";

const { OPENAI_API_KEY } = process.env;

let openai;
if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
}

/**
 * Uses OpenAI to classify a call transcript.
 * @param {string} transcriptText - The full text of the call transcript.
 * @returns {Promise<'ANSWERED'|'VOICEMAIL'|'NO_ANSWER'|null>} The classified outcome.
 */
export async function classifyCallOutcome(transcriptText) {
  if (!openai) {
    console.warn(
      "[OPENAI] OPENAI_API_KEY is not set. Skipping AI classification."
    );
    return null;
  }

  if (!transcriptText || transcriptText.trim().length < 10) {
    return null; // Not enough text to classify
  }

  const systemPrompt = `
    You are an expert call analyst. Your task is to classify a call transcript into one of three categories: ANSWERED, VOICEMAIL, or NO_ANSWER.
    - Respond with 'ANSWERED' if a human answers and a conversation takes place.
    - Respond with 'VOICEMAIL' if the call goes to an answering machine or voicemail. Look for phrases like "leave a message", "at the tone", "mailbox is full", or automated greetings.
    - Respond with 'NO_ANSWER' if the call is not answered, is busy, or if there is only silence.
    - If you are unsure, respond with 'NO_ANSWER'.
    - Only respond with one of the three categories and nothing else.
  `;

  try {
    const completion = await openai.responses.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Classify this transcript:\n\n${transcriptText}`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const classification = completion.choices?.[0]?.message?.content
      ?.trim()
      .toUpperCase();

    if (["ANSWERED", "VOICEMAIL", "NO_ANSWER"].includes(classification)) {
      return classification;
    }
    return null;
  } catch (error) {
    console.error(
      "[OPENAI] Error during call classification:",
      error instanceof OpenAI.APIError
        ? `${error.status} ${error.name}: ${error.message}`
        : error.message
    );
    return null;
  }
}
