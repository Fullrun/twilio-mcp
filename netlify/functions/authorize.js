import { generateAuthCode } from "./oauth-helpers.js";

export default async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const scope = params.get("scope") || "mcp:tools mcp:resources mcp:prompts";
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method") || "S256";

  // Validate required params
  if (responseType !== "code") {
    return new Response(
      JSON.stringify({ error: "unsupported_response_type" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!clientId || !redirectUri) {
    return new Response(
      JSON.stringify({ error: "invalid_request", error_description: "Missing client_id or redirect_uri" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Generate authorization code (auto-approve — this is a private server)
  const code = generateAuthCode({
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
  });

  // Build redirect URL with code and state
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) {
    redirect.searchParams.set("state", state);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Cache-Control": "no-store",
    },
  });
};

export const config = {
  path: "/authorize",
};
