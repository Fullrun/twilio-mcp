import crypto from "crypto";

const SECRET = process.env.OAUTH_SECRET || process.env.TWILIO_AUTH_TOKEN || "twilio-mcp-default-secret";
const BASE_URL = process.env.URL || "https://twilio-mcp-server.netlify.app";

export function getBaseUrl() {
  return BASE_URL;
}

// HMAC sign a payload
export function sign(payload) {
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

// Verify and decode a signed token
export function verify(token) {
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  const expectedSig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
}

// Generate an authorization code (short-lived, 5 min)
export function generateAuthCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, scope }) {
  return sign({
    type: "auth_code",
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    exp: Date.now() + 5 * 60 * 1000,
  });
}

// Generate an access token (1 hour)
export function generateAccessToken({ clientId, scope }) {
  return sign({
    type: "access_token",
    clientId,
    scope,
    exp: Date.now() + 60 * 60 * 1000,
  });
}

// Generate a refresh token (30 days)
export function generateRefreshToken({ clientId, scope }) {
  return sign({
    type: "refresh_token",
    clientId,
    scope,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

// Validate a Bearer token from request
export function validateBearerToken(req) {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const payload = verify(token);
  if (!payload) return null;
  if (payload.type !== "access_token") return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

// Verify PKCE code_verifier against code_challenge
export function verifyPKCE(codeVerifier, codeChallenge, method) {
  if (method === "S256") {
    const computed = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return computed === codeChallenge;
  }
  // plain method
  return codeVerifier === codeChallenge;
}
