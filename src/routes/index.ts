import { Router } from 'express';
import healthRoutes from './health.route';
import { notFoundHandler } from '../middleware/not-found.middleware';

const router = Router();

router.use('/', healthRoutes);
router.use(notFoundHandler);

export default router;
