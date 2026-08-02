import app from './app';
import logger from './logger/logger';
import { config } from './config/env';

const server = app.listen(config.port, () => {
  logger.info('Application started', {
    environment: config.environment,
    port: config.port,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
  server.close(() => process.exit(1));
});
