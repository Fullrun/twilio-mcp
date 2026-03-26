import { verify, verifyPKCE, generateAccessToken, generateRefreshToken } from "./oauth-helpers.js";

export default async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    let params;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.text();
      params = new URLSearchParams(body);
    } else if (contentType.includes("application/json")) {
      const body = await req.json();
      params = new URLSearchParams(body);
    } else {
      const body = await req.text();
      params = new URLSearchParams(body);
    }

    const grantType = params.get("grant_type");

    // ── Authorization Code Grant ──────────────────────────────────────────
    if (grantType === "authorization_code") {
      const code = params.get("code");
      const redirectUri = params.get("redirect_uri");
      const clientId = params.get("client_id");
      const codeVerifier = params.get("code_verifier");

      if (!code) {
        return errorResponse("invalid_request", "Missing authorization code");
      }

      // Decode and validate the auth code
      const payload = verify(code);
      if (!payload || payload.type !== "auth_code") {
        return errorResponse("invalid_grant", "Invalid authorization code");
      }

      // Check expiration
      if (payload.exp < Date.now()) {
        return errorResponse("invalid_grant", "Authorization code expired");
      }

      // Verify client_id matches
      if (clientId && payload.clientId !== clientId) {
        return errorResponse("invalid_grant", "Client ID mismatch");
      }

      // Verify redirect_uri matches
      if (redirectUri && payload.redirectUri !== redirectUri) {
        return errorResponse("invalid_grant", "Redirect URI mismatch");
      }

      // Verify PKCE if code_challenge was present
      if (payload.codeChallenge && codeVerifier) {
        if (!verifyPKCE(codeVerifier, payload.codeChallenge, payload.codeChallengeMethod)) {
          return errorResponse("invalid_grant", "PKCE verification failed");
        }
      }

      const scope = payload.scope || "mcp:tools mcp:resources mcp:prompts";
      const accessToken = generateAccessToken({ clientId: payload.clientId, scope });
      const refreshToken = generateRefreshToken({ clientId: payload.clientId, scope });

      return new Response(
        JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
          scope,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // ── Refresh Token Grant ───────────────────────────────────────────────
    if (grantType === "refresh_token") {
      const refreshTokenValue = params.get("refresh_token");

      if (!refreshTokenValue) {
        return errorResponse("invalid_request", "Missing refresh token");
      }

      const payload = verify(refreshTokenValue);
      if (!payload || payload.type !== "refresh_token") {
        return errorResponse("invalid_grant", "Invalid refresh token");
      }

      if (payload.exp < Date.now()) {
        return errorResponse("invalid_grant", "Refresh token expired");
      }

      const scope = payload.scope || "mcp:tools mcp:resources mcp:prompts";
      const accessToken = generateAccessToken({ clientId: payload.clientId, scope });
      const newRefreshToken = generateRefreshToken({ clientId: payload.clientId, scope });

      return new Response(
        JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return errorResponse("unsupported_grant_type", `Grant type '${grantType}' is not supported`);
  } catch (err) {
    return errorResponse("server_error", err.message, 500);
  }
};

function errorResponse(error, description, status = 400) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

export const config = {
  path: "/token",
};
