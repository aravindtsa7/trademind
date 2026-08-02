import { createLogger, format, transports } from 'winston';
import { config } from '../config/env';

const logger = createLogger({
  level: config.environment === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'trademind-backend' },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [new transports.Console()],
});

export default logger;
