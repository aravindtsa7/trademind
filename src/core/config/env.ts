import dotenv from 'dotenv';

dotenv.config();

const port = Number(process.env.PORT ?? 4000);
const environment = process.env.NODE_ENV?.trim() ?? 'development';
const databaseUrl = process.env.DATABASE_URL?.trim() ?? 'file:./dev.db';
const redisUrl = process.env.REDIS_URL?.trim() ?? 'redis://localhost:6379';

if (Number.isNaN(port) || port <= 0) {
  throw new Error('Invalid PORT value defined in environment configuration.');
}

export const config = {
  appName: process.env.APP_NAME?.trim() ?? 'TradeMind',
  environment,
  port,
  databaseUrl,
  redisUrl,
};
