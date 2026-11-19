export interface StoredProviderConnection {
  provider: string;
  authType: "oauth" | "apikey" | "local-import";
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  apiKey?: string;
  baseUrl?: string;
  email?: string;
  planType?: string;
  accountId?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface OAuthStartResult {
  provider: string;
  flowType: "pkce" | "device_code";
  authUrl?: string;
  state?: string;
  redirectUri?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  interval?: number;
}

export interface PkcePendingSession {
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

