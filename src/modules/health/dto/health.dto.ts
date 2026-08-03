export interface HealthResponseDto {
  status: 'ok';
  timestamp: string;
}

export interface ReadinessResponseDto {
  status: 'ready';
  uptime: number;
  timestamp: string;
}
