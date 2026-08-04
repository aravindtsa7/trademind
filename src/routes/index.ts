import { Router } from 'express';
import healthRoutes from '../modules/health';
import instrumentRoutes from '../modules/instruments';
import upstoxRoutes from '../modules/upstox';
import { notFoundHandler } from '../middleware/not-found.middleware';

const router = Router();

router.use('/', healthRoutes);

// Upstox routes mounted at /api/upstox
router.use('/api/upstox', upstoxRoutes);

// Instrument routes mounted at /api/instruments
router.use('/api/instruments', instrumentRoutes);

router.use(notFoundHandler);

export default router;
