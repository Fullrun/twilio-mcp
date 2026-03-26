# Twilio MCP Server on Netlify

A full-featured Twilio MCP server deployed as a Netlify serverless function. Gives Claude (and other MCP clients) the ability to send SMS, manage calls, pull transcripts, and manage your Twilio account.

## Tools Available

### SMS / Messaging
- **send-sms** — Send SMS or MMS messages
- **list-messages** — List/search messages with filters
- **get-message** — Get full details of a specific message

### Voice / Calls
- **make-call** — Initiate outbound phone calls
- **list-calls** — List recent calls with filters
- **get-call** — Get detailed call information

### Recordings & Transcriptions
- **list-recordings** — List call recordings
- **get-transcription** — Get transcript text for a recording
- **list-transcriptions** — Browse all transcriptions

### Account Management
- **list-phone-numbers** — List all numbers with config
- **update-phone-number** — Change webhook URLs, friendly name
- **get-account-info** — Account balance, status, details
- **search-available-numbers** — Find numbers to purchase

## Deployment Steps

### 1. Create a GitHub repo
```bash
cd twilio-mcp
git init
git add .
git commit -m "Twilio MCP server"
```
Push to GitHub (create a new repo called `twilio-mcp` or similar).

### 2. Deploy to Netlify
- Go to app.netlify.com → **Add new site** → **Import an existing project**
- Connect your GitHub repo
- Build command: `npm install`
- Publish directory: `public`
- Click **Deploy**

### 3. Add Environment Variables
In Netlify → **Site configuration** → **Environment variables**, add:

| Key | Value |
|-----|-------|
| `TWILIO_ACCOUNT_SID` | Your Account SID (starts with AC) |
| `TWILIO_AUTH_TOKEN` | Your Auth Token |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (+1XXXXXXXXXX) |

### 4. Trigger a Deploy
After adding env vars: **Deploys** → **Trigger deploy** → **Deploy project**

### 5. Test It
Visit `https://your-site-name.netlify.app/mcp` in a browser — you should see a JSON health check response.

### 6. Connect to Claude
Add your MCP server URL as a connector in Claude:
- Go to Claude → Settings/Integrations
- Add new integration
- URL: `https://your-site-name.netlify.app/mcp`

Or for Claude Desktop, edit `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "twilio": {
      "command": "npx",
      "args": [
        "mcp-remote@next",
        "https://your-site-name.netlify.app/mcp"
      ]
    }
  }
}
```

## Security Notes
- Your Twilio credentials are stored as Netlify environment variables (never exposed to clients)
- The MCP endpoint is public — anyone who knows the URL can invoke tools
- For production, consider adding authentication (API key header check, etc.)
