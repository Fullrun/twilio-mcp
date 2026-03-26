import { getBaseUrl } from "./oauth-helpers.js";

export default async (req) => {
  const baseUrl = getBaseUrl();

  const metadata = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:tools", "mcp:resources", "mcp:prompts"],
  };

  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
};

export const config = {
  path: ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
};
