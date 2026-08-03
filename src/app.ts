import express, { Application, Request, Response, NextFunction } from 'express';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import logger from './core/logger/logger';

const app: Application = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info('Request received', {
    method: req.method,
    path: req.path,
    query: req.query,
  });
  next();
});

app.use('/', routes);

app.get('/_status', (_req, res) => res.sendStatus(200));

app.use(errorHandler);

export default app;
