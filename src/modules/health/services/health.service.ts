import { HealthResponseDto, ReadinessResponseDto } from '../dto/health.dto';
import { IHealthService } from '../interfaces/health.interface';

export class HealthService implements IHealthService {
  getHealth(): HealthResponseDto {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  getReadiness(): ReadinessResponseDto {
    return {
      status: 'ready',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
