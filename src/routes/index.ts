import { Router } from 'express';
import healthRoutes from '../modules/health';
import upstoxRoutes from '../modules/upstox';
import { notFoundHandler } from '../middleware/not-found.middleware';

const router = Router();

router.use('/', healthRoutes);

// Upstox routes mounted at /api/upstox
router.use('/api/upstox', upstoxRoutes);

router.use(notFoundHandler);

export default router;
