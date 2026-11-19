export const OAUTH_CLIENTS = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    defaultRedirectUri: "http://localhost:1455/auth/callback"
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    defaultRedirectUri: "https://console.anthropic.com/oauth/code/callback"
  },
  github: {
    clientId: "Iv1.b507a08c87ecfe98",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
    scope: "read:user"
  },
  "kimi-coding": {
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    scope: "kimi-code"
  },
  qwen: {
    clientId: "f0304373b74a44d2b584a3fb70ca9e56",
    deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
    tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
    scope: "openid profile email model.completion"
  },
  antigravity: {
    clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    defaultRedirectUri: "http://localhost:51121/oauth-callback"
  }
} as const;

export function supportsProviderOAuth(providerId: string): boolean {
  return ["codex", "claude", "github", "kimi-coding", "qwen", "antigravity", "gemini-cli"].includes(providerId);
}

export function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractCodexAccountInfo(idToken?: string, accessToken?: string): { email?: string; accountId?: string; planType?: string } {
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const authClaim = (idPayload?.["https://api.openai.com/auth"] || accessPayload?.["https://api.openai.com/auth"]) as
    | Record<string, unknown>
    | undefined;
  return {
    email: (idPayload?.email as string) || (accessPayload?.email as string) || undefined,
    accountId: (authClaim?.chatgpt_account_id as string) || undefined,
    planType: (authClaim?.chatgpt_plan_type as string) || undefined
  };
}

