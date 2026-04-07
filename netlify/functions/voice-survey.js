import twilio from "twilio";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(xml) {
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function buildNextUrl(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function sendResultsSms(responses, resultsTo) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !fromNumber || !resultsTo) return;

    const client = twilio(accountSid, authToken);
    const lines = responses.map(
      (r, i) => `Q${i + 1}: ${r.question}\nA: ${r.answer || "(no response)"}`
    );
    const body = `Survey Results:\n\n${lines.join("\n\n")}`.substring(0, 1600);
    await client.messages.create({ to: resultsTo, from: fromNumber, body });
  } catch (e) {
    console.error("Failed to send survey results SMS:", e);
  }
}

// ─── Netlify Serverless Function Handler ───────────────────────────────────────
export default async (req) => {
  try {
    // Parse Twilio POST body (contains Digits, SpeechResult, RecordingUrl, etc.)
    let twilioBody = {};
    if (req.method === "POST") {
      try {
        const fd = await req.formData();
        for (const [k, v] of fd.entries()) {
          twilioBody[k] = v;
        }
      } catch (_) {
        // non-form POST, ignore
      }
    }

    const url = new URL(req.url);
    const step = parseInt(url.searchParams.get("step") || "0", 10);
    const questionsEncoded = url.searchParams.get("questions") || "";
    const responsesEncoded = url.searchParams.get("responses") || "";
    const resultsTo = url.searchParams.get("resultsTo") || "";
    const closing =
      url.searchParams.get("closing") ||
      "Thank you for completing our survey. Goodbye!";
    const greeting = url.searchParams.get("greeting") || "";
    // baseUrl is the canonical URL of this function (without query params)
    const baseUrl =
      url.searchParams.get("baseUrl") ||
      `${url.protocol}//${url.host}${url.pathname}`;

    // Decode survey questions
    let questions = [];
    try {
      if (questionsEncoded) {
        questions = JSON.parse(
          Buffer.from(questionsEncoded, "base64url").toString("utf8")
        );
      }
    } catch (_) {
      return twimlResponse(
        "<Response><Say>Survey configuration error. Goodbye.</Say></Response>"
      );
    }

    // Decode collected responses so far
    let responses = [];
    try {
      if (responsesEncoded) {
        responses = JSON.parse(
          Buffer.from(responsesEncoded, "base64url").toString("utf8")
        );
      }
    } catch (_) {
      responses = [];
    }

    // Collect the answer Twilio submitted for the previous question
    if (step > 0 && questions[step - 1]) {
      const prevQuestion = questions[step - 1];
      let answer = "";
      if (prevQuestion.type === "keypad") {
        answer = twilioBody.Digits || "";
      } else if (prevQuestion.type === "voice") {
        // RecordingUrl is available immediately; TranscriptionText arrives later via transcribeCallback
        answer = twilioBody.RecordingUrl || twilioBody.TranscriptionText || "";
      } else if (prevQuestion.type === "speech") {
        answer = twilioBody.SpeechResult || "";
      }
      responses.push({ question: prevQuestion.text, answer });
    }

    // Survey complete — send results and close call
    if (step >= questions.length) {
      if (resultsTo) {
        await sendResultsSms(responses, resultsTo);
      }
      return twimlResponse(
        `<Response><Say>${escapeXml(closing)}</Say></Response>`
      );
    }

    // Build the action URL for the next step, carrying responses forward
    const nextResponsesEncoded = Buffer.from(
      JSON.stringify(responses)
    ).toString("base64url");

    const nextActionUrl = buildNextUrl(baseUrl, {
      step: step + 1,
      questions: questionsEncoded,
      responses: nextResponsesEncoded,
      resultsTo,
      closing,
      greeting,
      baseUrl,
    });

    const question = questions[step];
    let twiml = "<Response>";

    // Say greeting only once at the very first step
    if (step === 0 && greeting) {
      twiml += `<Say>${escapeXml(greeting)}</Say><Pause length="1"/>`;
    }

    if (question.type === "keypad") {
      const numDigits = question.maxDigits || 1;
      const timeout = question.timeout || 10;
      twiml += `<Gather numDigits="${numDigits}" action="${escapeXml(nextActionUrl)}" method="POST" timeout="${timeout}">`;
      twiml += `<Say>${escapeXml(question.text)}</Say>`;
      twiml += `</Gather>`;
      // No-input fallback: advance to next step with an empty answer
      twiml += `<Say>No input received. Moving to the next question.</Say>`;
      twiml += `<Redirect method="POST">${escapeXml(nextActionUrl)}</Redirect>`;
    } else if (question.type === "voice") {
      const maxLength = question.maxLength || 60;
      twiml += `<Say>${escapeXml(question.text)}</Say>`;
      twiml += `<Say>Please speak your answer after the tone, then press the pound key when done.</Say>`;
      twiml += `<Record action="${escapeXml(nextActionUrl)}" method="POST" maxLength="${maxLength}" finishOnKey="#" transcribe="true"/>`;
    } else if (question.type === "speech") {
      const speechTimeout = question.speechTimeout || "auto";
      twiml += `<Gather input="speech" action="${escapeXml(nextActionUrl)}" method="POST" speechTimeout="${speechTimeout}" language="en-US">`;
      twiml += `<Say>${escapeXml(question.text)}</Say>`;
      twiml += `</Gather>`;
      // No-speech fallback
      twiml += `<Say>No response detected. Moving to the next question.</Say>`;
      twiml += `<Redirect method="POST">${escapeXml(nextActionUrl)}</Redirect>`;
    } else {
      // Unknown type — skip
      twiml += `<Redirect method="POST">${escapeXml(nextActionUrl)}</Redirect>`;
    }

    twiml += "</Response>";

    return twimlResponse(twiml);
  } catch (error) {
    console.error("Voice survey error:", error);
    return twimlResponse(
      "<Response><Say>An error occurred with the survey. Goodbye.</Say></Response>"
    );
  }
};

// ─── Route Configuration ───────────────────────────────────────────────────────
export const config = {
  path: "/voice-survey",
};
