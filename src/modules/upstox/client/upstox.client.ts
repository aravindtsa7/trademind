import axios, { AxiosInstance } from 'axios';

export default class UpstoxClient {
  private axios: AxiosInstance;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private redirectUri: string | undefined;
  private authUrl: string;
  private tokenUrl: string;
  private profileUrl: string;

  constructor() {
    this.clientId = process.env.UPSTOX_CLIENT_ID?.trim();
    this.clientSecret = process.env.UPSTOX_CLIENT_SECRET?.trim();
    this.redirectUri = process.env.UPSTOX_REDIRECT_URI?.trim();

    console.log("=== UPSTOX CONFIG DEBUG ===");
  console.log({
    clientId: process.env.UPSTOX_CLIENT_ID,
    clientSecret: process.env.UPSTOX_CLIENT_SECRET ? "***SET***" : undefined,
    redirectUri: process.env.UPSTOX_REDIRECT_URI,
  });
  console.log("===========================");

    this.authUrl = process.env.UPSTOX_AUTH_URL?.trim() ?? 'https://auth.upstox.com/oauth2/authorize';
    this.tokenUrl = process.env.UPSTOX_TOKEN_URL?.trim() ?? 'https://api.upstox.com/oauth2/token';
    this.profileUrl = process.env.UPSTOX_PROFILE_URL?.trim() ?? 'https://api.upstox.com/profile';

    this.axios = axios.create({ timeout: 10_000 });
  }

  private ensureClientConfig() {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      const msg = 'Upstox client configuration missing. Ensure UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET and UPSTOX_REDIRECT_URI are set in environment variables.';
      const e: any = new Error(msg);
      e.status = 500;
      throw e;
    }
  }

  buildAuthUrl(state?: string): string {
    this.ensureClientConfig();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId as string,
      redirect_uri: this.redirectUri as string,
    });

    if (state) {
      params.set('state', state);
    }

    // scope can be provided via env if needed
    const scope = process.env.UPSTOX_SCOPE;
    if (scope) {
      params.set('scope', scope);
    }

    return `${this.authUrl}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<any> {
    this.ensureClientConfig();

    try {
      const data = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri as string,
        client_id: this.clientId as string,
        client_secret: this.clientSecret as string,
      }).toString();

      const resp = await this.axios.post(this.tokenUrl, data, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      return resp.data;
    } catch (err: any) {
      const e: any = new Error('Failed to exchange authorization code for token');
      e.status = err?.response?.status ?? 502;
      e.errors = err?.response?.data ?? err?.message;
      throw e;
    }
  }

  async getProfile(accessToken: string): Promise<any> {
    try {
      const resp = await this.axios.get(this.profileUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      return resp.data;
    } catch (err: any) {
      const e: any = new Error('Failed to fetch user profile from Upstox');
      e.status = err?.response?.status ?? 502;
      e.errors = err?.response?.data ?? err?.message;
      throw e;
    }
  }
}
