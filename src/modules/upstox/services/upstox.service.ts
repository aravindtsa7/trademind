import UpstoxClient from '../client/upstox.client';
import { TokenResponseDto } from '../dto/token-response.dto';
import { ProfileResponseDto } from '../dto/profile-response.dto';

export default class UpstoxService {
  private client = new UpstoxClient();

  async getAuthUrl(): Promise<string> {
    return this.client.buildAuthUrl();
  }

  async exchangeCode(code: string): Promise<TokenResponseDto> {
    return this.client.exchangeCode(code);
  }

  async getProfile(accessToken: string): Promise<ProfileResponseDto> {
    return this.client.getProfile(accessToken);
  }
}
