import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import twilio from "twilio";
import { validateBearerToken, getBaseUrl } from "./oauth-helpers.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

// ─── Netlify Serverless Function Handler ───────────────────────────────────────
export default async (req) => {
  try {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Validate Bearer token for POST requests (MCP calls)
    if (req.method === "POST") {
      const tokenPayload = validateBearerToken(req);
      if (!tokenPayload) {
        const baseUrl = getBaseUrl();
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
            },
          }
        );
      }

      const { req: nodeReq, res: nodeRes } = toReqRes(req);
      const server = getServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      const body = await req.json();
      await transport.handleRequest(nodeReq, nodeRes, body);
      nodeRes.on("close", () => {
        transport.close();
        server.close();
      });
      return toFetchResponse(nodeRes);
    }

    // Return basic info for GET requests (health check)
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "twilio-mcp-server",
          version: "1.0.0",
          status: "running",
          protocol: "MCP",
          hint: "Use POST with an MCP client to interact with this server.",
        }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  } catch (error) {
    console.error("MCP error:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: "",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

// ─── XML Escape Helper (for safe TwiML construction) ──────────────────────────
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Twilio Client Helper ──────────────────────────────────────────────────────
function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN environment variables"
    );
  }
  return twilio(accountSid, authToken);
}

// ─── MCP Server Definition ─────────────────────────────────────────────────────
function getServer() {
  const server = new McpServer(
    {
      name: "twilio-mcp-server",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SMS / MESSAGING TOOLS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    "send-sms",
    "Send an SMS or MMS message via Twilio. Requires a 'to' phone number in E.164 format (e.g. +15551234567). Optionally include a mediaUrl for MMS.",
    {
      to: z.string().describe("Destination phone number in E.164 format (e.g. +15551234567)"),
      body: z.string().describe("The text message content to send"),
      from: z
        .string()
        .optional()
        .describe("Twilio phone number to send from (E.164). Defaults to TWILIO_PHONE_NUMBER env var."),
      mediaUrl: z
        .string()
        .optional()
        .describe("URL of media to attach (for MMS)"),
    },
    async ({ to, body, from, mediaUrl }) => {
      try {
        const client = getTwilioClient();
        const fromNumber = from || process.env.TWILIO_PHONE_NUMBER;
        if (!fromNumber) {
          return {
            content: [{ type: "text", text: "Error: No 'from' number provided and TWILIO_PHONE_NUMBER env var is not set." }],
            isError: true,
          };
        }
        const params = { to, from: fromNumber, body };
        if (mediaUrl) params.mediaUrl = [mediaUrl];
        const message = await client.messages.create(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sid: message.sid,
                to: message.to,
                from: message.from,
                status: message.status,
                dateSent: message.dateCreated,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error sending SMS: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list-messages",
    "List recent SMS/MMS messages. Optionally filter by 'to' or 'from' number, date range, or limit the number of results.",
    {
      to: z.string().optional().describe("Filter messages sent to this number (E.164)"),
      from: z.string().optional().describe("Filter messages sent from this number (E.164)"),
      dateSentAfter: z.string().optional().describe("Only messages sent after this date (ISO 8601, e.g. 2025-03-01)"),
      dateSentBefore: z.string().optional().describe("Only messages sent before this date (ISO 8601)"),
      limit: z.number().optional().default(20).describe("Max number of messages to return (default 20)"),
    },
    async ({ to, from, dateSentAfter, dateSentBefore, limit }) => {
      try {
        const client = getTwilioClient();
        const filters = {};
        if (to) filters.to = to;
        if (from) filters.from = from;
        if (dateSentAfter) filters.dateSentAfter = new Date(dateSentAfter);
        if (dateSentBefore) filters.dateSentBefore = new Date(dateSentBefore);
        const messages = await client.messages.list({ ...filters, limit });
        const results = messages.map((m) => ({
          sid: m.sid,
          to: m.to,
          from: m.from,
          body: m.body,
          status: m.status,
          direction: m.direction,
          dateSent: m.dateSent,
          price: m.price,
          numMedia: m.numMedia,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, messages: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing messages: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get-message",
    "Get full details of a specific SMS/MMS message by its SID.",
    {
      messageSid: z.string().describe("The message SID (starts with SM or MM)"),
    },
    async ({ messageSid }) => {
      try {
        const client = getTwilioClient();
        const m = await client.messages(messageSid).fetch();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sid: m.sid,
                to: m.to,
                from: m.from,
                body: m.body,
                status: m.status,
                direction: m.direction,
                dateSent: m.dateSent,
                dateCreated: m.dateCreated,
                dateUpdated: m.dateUpdated,
                price: m.price,
                priceUnit: m.priceUnit,
                numMedia: m.numMedia,
                numSegments: m.numSegments,
                errorCode: m.errorCode,
                errorMessage: m.errorMessage,
                uri: m.uri,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching message: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // VOICE / CALL TOOLS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    "make-call",
    "Initiate an outbound phone call via Twilio. You must provide a TwiML URL or TwiML instructions for what happens when the call connects.",
    {
      to: z.string().describe("Destination phone number (E.164)"),
      from: z.string().optional().describe("Twilio number to call from (E.164). Defaults to TWILIO_PHONE_NUMBER."),
      twimlUrl: z.string().optional().describe("URL returning TwiML instructions for the call"),
      twiml: z.string().optional().describe("Inline TwiML instructions (e.g. '<Response><Say>Hello!</Say></Response>')"),
      record: z.boolean().optional().default(false).describe("Whether to record the call"),
      recordingStatusCallback: z.string().optional().describe("URL to receive recording status webhooks"),
    },
    async ({ to, from, twimlUrl, twiml: twimlContent, record, recordingStatusCallback }) => {
      try {
        const client = getTwilioClient();
        const fromNumber = from || process.env.TWILIO_PHONE_NUMBER;
        if (!fromNumber) {
          return {
            content: [{ type: "text", text: "Error: No 'from' number and TWILIO_PHONE_NUMBER is not set." }],
            isError: true,
          };
        }
        if (!twimlUrl && !twimlContent) {
          return {
            content: [{ type: "text", text: "Error: Provide either twimlUrl or twiml for call instructions." }],
            isError: true,
          };
        }
        const params = { to, from: fromNumber, record };
        if (twimlUrl) params.url = twimlUrl;
        if (twimlContent) params.twiml = twimlContent;
        if (recordingStatusCallback) params.recordingStatusCallback = recordingStatusCallback;
        const call = await client.calls.create(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sid: call.sid,
                to: call.to,
                from: call.from,
                status: call.status,
                direction: call.direction,
                dateCreated: call.dateCreated,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error making call: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list-calls",
    "List recent phone calls. Optionally filter by to/from number, status, or date range.",
    {
      to: z.string().optional().describe("Filter calls to this number"),
      from: z.string().optional().describe("Filter calls from this number"),
      status: z
        .enum(["queued", "ringing", "in-progress", "completed", "busy", "no-answer", "canceled", "failed"])
        .optional()
        .describe("Filter by call status"),
      startTimeAfter: z.string().optional().describe("Calls after this date (ISO 8601)"),
      startTimeBefore: z.string().optional().describe("Calls before this date (ISO 8601)"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ to, from, status, startTimeAfter, startTimeBefore, limit }) => {
      try {
        const client = getTwilioClient();
        const filters = {};
        if (to) filters.to = to;
        if (from) filters.from = from;
        if (status) filters.status = status;
        if (startTimeAfter) filters.startTimeAfter = new Date(startTimeAfter);
        if (startTimeBefore) filters.startTimeBefore = new Date(startTimeBefore);
        const calls = await client.calls.list({ ...filters, limit });
        const results = calls.map((c) => ({
          sid: c.sid,
          to: c.to,
          from: c.from,
          status: c.status,
          direction: c.direction,
          duration: c.duration,
          startTime: c.startTime,
          endTime: c.endTime,
          price: c.price,
          forwardedFrom: c.forwardedFrom,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, calls: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing calls: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get-call",
    "Get detailed information about a specific call by its SID.",
    {
      callSid: z.string().describe("The call SID (starts with CA)"),
    },
    async ({ callSid }) => {
      try {
        const client = getTwilioClient();
        const c = await client.calls(callSid).fetch();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sid: c.sid,
                to: c.to,
                from: c.from,
                status: c.status,
                direction: c.direction,
                duration: c.duration,
                startTime: c.startTime,
                endTime: c.endTime,
                price: c.price,
                priceUnit: c.priceUnit,
                forwardedFrom: c.forwardedFrom,
                callerName: c.callerName,
                uri: c.uri,
                dateCreated: c.dateCreated,
                dateUpdated: c.dateUpdated,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching call: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "make-voice-survey",
    "Make an outbound call that conducts a voice survey. The call speaks each question in sequence and collects answers via keypad (DTMF digits), live speech recognition, or voice recording. When the survey ends, results are sent as an SMS to the specified number. Use this to ask someone a question or series of questions and report back the answers.",
    {
      to: z
        .string()
        .describe("Phone number to call (E.164, e.g. +15551234567)"),
      from: z
        .string()
        .optional()
        .describe(
          "Twilio number to call from (E.164). Defaults to TWILIO_PHONE_NUMBER env var."
        ),
      greeting: z
        .string()
        .optional()
        .describe(
          "Opening message spoken when the call is answered, before any questions."
        ),
      closing: z
        .string()
        .optional()
        .describe(
          "Closing message spoken after all questions. Defaults to 'Thank you for completing our survey. Goodbye!'"
        ),
      questions: z
        .array(
          z.object({
            text: z
              .string()
              .describe(
                "The question text, spoken aloud via text-to-speech."
              ),
            type: z
              .enum(["keypad", "speech", "voice"])
              .describe(
                "How to collect the answer. 'keypad' = DTMF digit(s) pressed by the caller. 'speech' = spoken answer captured inline via speech recognition (best for short answers). 'voice' = full voice recording (best for longer free-form answers)."
              ),
            maxDigits: z
              .number()
              .optional()
              .describe(
                "For keypad type: number of digits to collect (default 1)."
              ),
            maxLength: z
              .number()
              .optional()
              .describe(
                "For voice type: max recording length in seconds (default 60)."
              ),
            speechTimeout: z
              .union([z.number(), z.literal("auto")])
              .optional()
              .describe(
                "For speech type: seconds of silence before capturing is done, or 'auto' (default)."
              ),
            timeout: z
              .number()
              .optional()
              .describe(
                "For keypad type: seconds to wait for input before moving on (default 10)."
              ),
          })
        )
        .min(1)
        .describe("Ordered list of questions to ask during the call."),
      resultsTo: z
        .string()
        .optional()
        .describe(
          "Phone number to SMS the survey results to after the call completes. Defaults to the 'to' number."
        ),
    },
    async ({ to, from, greeting, closing, questions, resultsTo }) => {
      try {
        const client = getTwilioClient();
        const fromNumber = from || process.env.TWILIO_PHONE_NUMBER;
        if (!fromNumber) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No 'from' number and TWILIO_PHONE_NUMBER env var is not set.",
              },
            ],
            isError: true,
          };
        }

        const baseUrl = getBaseUrl();
        const surveyWebhookBase = `${baseUrl}/.netlify/functions/voice-survey`;

        const questionsEncoded = Buffer.from(
          JSON.stringify(questions)
        ).toString("base64url");

        const surveyUrl = new URL(surveyWebhookBase);
        surveyUrl.searchParams.set("step", "0");
        surveyUrl.searchParams.set("questions", questionsEncoded);
        surveyUrl.searchParams.set("resultsTo", resultsTo || to);
        surveyUrl.searchParams.set(
          "closing",
          closing || "Thank you for completing our survey. Goodbye!"
        );
        if (greeting) surveyUrl.searchParams.set("greeting", greeting);
        surveyUrl.searchParams.set("baseUrl", surveyWebhookBase);

        // Initial TwiML just redirects to the survey webhook
        const initialTwiml = `<Response><Redirect method="POST">${escapeXml(
          surveyUrl.toString()
        )}</Redirect></Response>`;

        const call = await client.calls.create({
          to,
          from: fromNumber,
          twiml: initialTwiml,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                callSid: call.sid,
                to: call.to,
                from: call.from,
                status: call.status,
                questionCount: questions.length,
                resultsWillBeSentTo: resultsTo || to,
                message: `Survey call initiated with ${questions.length} question(s). Results will be sent via SMS to ${resultsTo || to} after the survey completes.`,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error making survey call: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RECORDINGS & TRANSCRIPTIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    "list-recordings",
    "List call recordings. Optionally filter by call SID or date range.",
    {
      callSid: z.string().optional().describe("Filter recordings for a specific call SID"),
      dateCreatedAfter: z.string().optional().describe("Recordings after this date (ISO 8601)"),
      dateCreatedBefore: z.string().optional().describe("Recordings before this date (ISO 8601)"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ callSid, dateCreatedAfter, dateCreatedBefore, limit }) => {
      try {
        const client = getTwilioClient();
        const filters = {};
        if (callSid) filters.callSid = callSid;
        if (dateCreatedAfter) filters.dateCreatedAfter = new Date(dateCreatedAfter);
        if (dateCreatedBefore) filters.dateCreatedBefore = new Date(dateCreatedBefore);
        const recordings = await client.recordings.list({ ...filters, limit });
        const results = recordings.map((r) => ({
          sid: r.sid,
          callSid: r.callSid,
          duration: r.duration,
          status: r.status,
          channels: r.channels,
          source: r.source,
          dateCreated: r.dateCreated,
          price: r.price,
          uri: r.uri,
          mediaUrl: `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${r.sid}.mp3`,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, recordings: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing recordings: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get-transcription",
    "Get the transcription text for a specific recording. Note: Twilio's built-in transcription must be enabled on the recording. This fetches transcriptions associated with a recording SID.",
    {
      recordingSid: z.string().describe("The recording SID (starts with RE)"),
    },
    async ({ recordingSid }) => {
      try {
        const client = getTwilioClient();
        const transcriptions = await client
          .recordings(recordingSid)
          .transcriptions.list({ limit: 5 });

        if (transcriptions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message: "No transcriptions found for this recording. Transcription may not have been enabled, or it may still be processing.",
                  recordingSid,
                }),
              },
            ],
          };
        }

        const results = [];
        for (const t of transcriptions) {
          const full = await client.transcriptions(t.sid).fetch();
          results.push({
            sid: full.sid,
            recordingSid: full.recordingSid,
            status: full.status,
            transcriptionText: full.transcriptionText,
            duration: full.duration,
            price: full.price,
            dateCreated: full.dateCreated,
            dateUpdated: full.dateUpdated,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, transcriptions: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching transcription: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list-transcriptions",
    "List all transcriptions on the account. Useful for finding transcripts when you don't have the recording SID.",
    {
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ limit }) => {
      try {
        const client = getTwilioClient();
        const transcriptions = await client.transcriptions.list({ limit });
        const results = transcriptions.map((t) => ({
          sid: t.sid,
          recordingSid: t.recordingSid,
          status: t.status,
          duration: t.duration,
          price: t.price,
          dateCreated: t.dateCreated,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, transcriptions: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing transcriptions: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHONE NUMBER & ACCOUNT MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    "list-phone-numbers",
    "List all phone numbers on your Twilio account with their capabilities and configuration.",
    {},
    async () => {
      try {
        const client = getTwilioClient();
        const numbers = await client.incomingPhoneNumbers.list({ limit: 50 });
        const results = numbers.map((n) => ({
          sid: n.sid,
          phoneNumber: n.phoneNumber,
          friendlyName: n.friendlyName,
          capabilities: n.capabilities,
          smsUrl: n.smsUrl,
          smsMethod: n.smsMethod,
          voiceUrl: n.voiceUrl,
          voiceMethod: n.voiceMethod,
          statusCallback: n.statusCallback,
          dateCreated: n.dateCreated,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, phoneNumbers: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing numbers: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update-phone-number",
    "Update the configuration of a phone number (e.g. change webhook URLs, friendly name).",
    {
      phoneNumberSid: z.string().describe("The phone number SID (starts with PN)"),
      friendlyName: z.string().optional().describe("New friendly name for the number"),
      smsUrl: z.string().optional().describe("URL for incoming SMS webhooks"),
      smsMethod: z.enum(["GET", "POST"]).optional().describe("HTTP method for SMS webhook"),
      voiceUrl: z.string().optional().describe("URL for incoming voice call webhooks"),
      voiceMethod: z.enum(["GET", "POST"]).optional().describe("HTTP method for voice webhook"),
      statusCallback: z.string().optional().describe("URL for status callback webhooks"),
    },
    async ({ phoneNumberSid, friendlyName, smsUrl, smsMethod, voiceUrl, voiceMethod, statusCallback }) => {
      try {
        const client = getTwilioClient();
        const updates = {};
        if (friendlyName) updates.friendlyName = friendlyName;
        if (smsUrl) updates.smsUrl = smsUrl;
        if (smsMethod) updates.smsMethod = smsMethod;
        if (voiceUrl) updates.voiceUrl = voiceUrl;
        if (voiceMethod) updates.voiceMethod = voiceMethod;
        if (statusCallback) updates.statusCallback = statusCallback;
        const number = await client.incomingPhoneNumbers(phoneNumberSid).update(updates);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sid: number.sid,
                phoneNumber: number.phoneNumber,
                friendlyName: number.friendlyName,
                smsUrl: number.smsUrl,
                voiceUrl: number.voiceUrl,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error updating number: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get-account-info",
    "Get information about your Twilio account including balance, status, and name.",
    {},
    async () => {
      try {
        const client = getTwilioClient();
        const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
        
        // Get balance
        let balance = null;
        try {
          const balanceData = await client.balance.fetch();
          balance = {
            balance: balanceData.balance,
            currency: balanceData.currency,
          };
        } catch (e) {
          balance = { error: "Could not fetch balance" };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sid: account.sid,
                friendlyName: account.friendlyName,
                status: account.status,
                type: account.type,
                dateCreated: account.dateCreated,
                dateUpdated: account.dateUpdated,
                balance,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching account: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search-available-numbers",
    "Search for available phone numbers to purchase in a given country. Filter by area code, capabilities, or keyword.",
    {
      country: z.string().default("US").describe("ISO country code (e.g. US, GB, CA)"),
      areaCode: z.string().optional().describe("Area code to search within"),
      contains: z.string().optional().describe("Pattern the number should contain (e.g. 555)"),
      smsEnabled: z.boolean().optional().default(true).describe("Must support SMS"),
      voiceEnabled: z.boolean().optional().default(true).describe("Must support voice"),
      limit: z.number().optional().default(10).describe("Max results"),
    },
    async ({ country, areaCode, contains, smsEnabled, voiceEnabled, limit }) => {
      try {
        const client = getTwilioClient();
        let search = client.availablePhoneNumbers(country).local;
        const filters = { limit };
        if (areaCode) filters.areaCode = areaCode;
        if (contains) filters.contains = contains;
        if (smsEnabled) filters.smsEnabled = smsEnabled;
        if (voiceEnabled) filters.voiceEnabled = voiceEnabled;
        const numbers = await search.list(filters);
        const results = numbers.map((n) => ({
          phoneNumber: n.phoneNumber,
          friendlyName: n.friendlyName,
          locality: n.locality,
          region: n.region,
          capabilities: n.capabilities,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, availableNumbers: results }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error searching numbers: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TWIML BUILDER
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool(
    "build-twiml",
    "Build a TwiML XML string for use with the make-call tool. Supports Say (text-to-speech), Play (audio file), Gather (collect DTMF digits or speech), Record (voice recording), Dial (connect to another number), and Pause verbs. Returns the TwiML XML string to pass as the 'twiml' parameter of make-call.",
    {
      verbs: z
        .array(
          z.object({
            type: z
              .enum(["say", "play", "pause", "gather", "record", "dial"])
              .describe(
                "TwiML verb type: say, play, pause, gather, record, or dial."
              ),
            // say
            text: z
              .string()
              .optional()
              .describe(
                "For 'say': text to speak. For 'gather': optional prompt to speak while collecting input."
              ),
            voice: z
              .string()
              .optional()
              .describe(
                "For 'say': voice name (e.g. alice, man, woman, Polly.Joanna)."
              ),
            language: z
              .string()
              .optional()
              .describe(
                "For 'say' / 'gather': language/locale code (e.g. en-US, es-MX)."
              ),
            // play
            url: z
              .string()
              .optional()
              .describe("For 'play': URL of audio file to play."),
            loop: z
              .number()
              .optional()
              .describe(
                "For 'play': number of times to play (0 = infinite, default 1)."
              ),
            // pause
            length: z
              .number()
              .optional()
              .describe("For 'pause': seconds to pause (default 1)."),
            // gather
            input: z
              .enum(["dtmf", "speech", "dtmf speech"])
              .optional()
              .describe(
                "For 'gather': input mode — dtmf, speech, or dtmf speech (default dtmf)."
              ),
            action: z
              .string()
              .optional()
              .describe(
                "For 'gather' / 'record': URL to POST collected input or recording details to."
              ),
            numDigits: z
              .number()
              .optional()
              .describe(
                "For 'gather': stop after this many digits are collected."
              ),
            finishOnKey: z
              .string()
              .optional()
              .describe(
                "For 'gather' / 'record': key that ends collection (default # for record, * for gather)."
              ),
            timeout: z
              .number()
              .optional()
              .describe(
                "For 'gather' / 'dial': seconds to wait for input or answer."
              ),
            // record
            maxLength: z
              .number()
              .optional()
              .describe("For 'record': max recording length in seconds."),
            transcribe: z
              .boolean()
              .optional()
              .describe("For 'record': whether to transcribe the recording."),
            transcribeCallback: z
              .string()
              .optional()
              .describe(
                "For 'record': URL to POST the transcription result to."
              ),
            playBeep: z
              .boolean()
              .optional()
              .describe(
                "For 'record': play a beep before recording starts (default true)."
              ),
            // dial
            number: z
              .string()
              .optional()
              .describe(
                "For 'dial': E.164 phone number or SIP URI to connect to."
              ),
            callerId: z
              .string()
              .optional()
              .describe("For 'dial': caller ID to present to the dialed party."),
            record: z
              .enum([
                "do-not-record",
                "record-from-answer",
                "record-from-ringing",
                "record-from-answer-dual",
                "record-from-ringing-dual",
              ])
              .optional()
              .describe("For 'dial': recording mode."),
          })
        )
        .min(1)
        .describe("Ordered list of TwiML verbs to include in the response."),
    },
    async ({ verbs }) => {
      try {
        let twiml = "<Response>";

        for (const verb of verbs) {
          switch (verb.type) {
            case "say": {
              if (!verb.text) break;
              const attrs = [];
              if (verb.voice) attrs.push(`voice="${escapeXml(verb.voice)}"`);
              if (verb.language)
                attrs.push(`language="${escapeXml(verb.language)}"`);
              twiml += `<Say${attrs.length ? " " + attrs.join(" ") : ""}>${escapeXml(verb.text)}</Say>`;
              break;
            }
            case "play": {
              if (!verb.url) break;
              const attrs = [];
              if (verb.loop !== undefined) attrs.push(`loop="${verb.loop}"`);
              twiml += `<Play${attrs.length ? " " + attrs.join(" ") : ""}>${escapeXml(verb.url)}</Play>`;
              break;
            }
            case "pause": {
              twiml += `<Pause length="${verb.length ?? 1}"/>`;
              break;
            }
            case "gather": {
              const attrs = [];
              if (verb.input) attrs.push(`input="${escapeXml(verb.input)}"`);
              if (verb.action)
                attrs.push(`action="${escapeXml(verb.action)}"`);
              if (verb.numDigits !== undefined)
                attrs.push(`numDigits="${verb.numDigits}"`);
              if (verb.finishOnKey !== undefined)
                attrs.push(`finishOnKey="${escapeXml(verb.finishOnKey)}"`);
              if (verb.timeout !== undefined)
                attrs.push(`timeout="${verb.timeout}"`);
              if (verb.language)
                attrs.push(`language="${escapeXml(verb.language)}"`);
              const inner = verb.text
                ? `<Say>${escapeXml(verb.text)}</Say>`
                : "";
              twiml += `<Gather${attrs.length ? " " + attrs.join(" ") : ""}>${inner}</Gather>`;
              break;
            }
            case "record": {
              const attrs = [];
              if (verb.action)
                attrs.push(`action="${escapeXml(verb.action)}"`);
              if (verb.maxLength !== undefined)
                attrs.push(`maxLength="${verb.maxLength}"`);
              if (verb.transcribe !== undefined)
                attrs.push(`transcribe="${verb.transcribe}"`);
              if (verb.transcribeCallback)
                attrs.push(
                  `transcribeCallback="${escapeXml(verb.transcribeCallback)}"`
                );
              if (verb.finishOnKey !== undefined)
                attrs.push(`finishOnKey="${escapeXml(verb.finishOnKey)}"`);
              if (verb.playBeep !== undefined)
                attrs.push(`playBeep="${verb.playBeep}"`);
              twiml += `<Record${attrs.length ? " " + attrs.join(" ") : ""}/>`;
              break;
            }
            case "dial": {
              if (!verb.number) break;
              const attrs = [];
              if (verb.callerId)
                attrs.push(`callerId="${escapeXml(verb.callerId)}"`);
              if (verb.timeout !== undefined)
                attrs.push(`timeout="${verb.timeout}"`);
              if (verb.record)
                attrs.push(`record="${escapeXml(verb.record)}"`);
              twiml += `<Dial${attrs.length ? " " + attrs.join(" ") : ""}>${escapeXml(verb.number)}</Dial>`;
              break;
            }
            default:
              break;
          }
        }

        twiml += "</Response>";

        return {
          content: [{ type: "text", text: JSON.stringify({ twiml }) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error building TwiML: ${err.message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RESOURCES (context for AI agents)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.resource(
    "twilio-usage-guide",
    "twilio://usage-guide",
    { mimeType: "text/plain" },
    async () => ({
      contents: [
        {
          uri: "twilio://usage-guide",
          text: `Twilio MCP Server Usage Guide
          
This MCP server provides tools to interact with Twilio's communication APIs.

PHONE NUMBER FORMAT: Always use E.164 format: +[country code][number]
  - US example: +15551234567
  - UK example: +447911123456

SMS TOOLS:
  - send-sms: Send a text message (or MMS with mediaUrl)
  - list-messages: Browse recent messages with filters
  - get-message: Get details of a specific message by SID

VOICE TOOLS:
  - make-call: Start an outbound call (requires TwiML URL or inline TwiML)
  - make-voice-survey: Call someone and ask a series of questions, collecting answers via keypad, speech, or voice recording. Results sent by SMS.
  - build-twiml: Build a TwiML XML string combining Say/Play/Gather/Record/Dial/Pause verbs for use with make-call
  - list-calls: Browse recent calls with filters
  - get-call: Get details of a specific call by SID

RECORDING & TRANSCRIPT TOOLS:
  - list-recordings: Find call recordings
  - get-transcription: Get transcript text for a recording
  - list-transcriptions: Browse all transcriptions

ACCOUNT TOOLS:
  - list-phone-numbers: See all numbers on the account
  - update-phone-number: Change webhook URLs or friendly name
  - get-account-info: Check balance, status, account details
  - search-available-numbers: Find numbers to purchase

SIDs: Twilio uses SID identifiers:
  - SM/MM = Message, CA = Call, RE = Recording, TR = Transcription, PN = Phone Number
  
TIPS:
  - Use list-calls first to find call SIDs, then list-recordings to find recordings for that call
  - Transcriptions must be enabled on the recording to be available
  - The default 'from' number uses the TWILIO_PHONE_NUMBER environment variable
  - make-voice-survey is the easiest way to collect information from a contact: provide questions with type 'keypad' (press 1, 2, etc.), 'speech' (spoken answer via recognition), or 'voice' (recorded response). SMS results arrive after the call ends.
  - build-twiml generates reusable TwiML XML. Pass the resulting 'twiml' value directly to make-call.`,
        },
      ],
    })
  );

  return server;
}

// ─── Route Configuration ───────────────────────────────────────────────────────
export const config = {
  path: "/mcp",
};
