import { HealthResponseDto, ReadinessResponseDto } from '../dto/health.dto';

export interface IHealthService {
  getHealth(): HealthResponseDto;
  getReadiness(): ReadinessResponseDto;
}
