import { Router } from 'express';
import healthRoutes from '../modules/health';
import historicalCandleRoutes from '../modules/historical-candles';
import instrumentRoutes from '../modules/instruments';
import marketDataRoutes from '../modules/market-data';
import upstoxRoutes from '../modules/upstox';
import { notFoundHandler } from '../middleware/not-found.middleware';

const router = Router();

router.use('/', healthRoutes);

// Upstox routes mounted at /api/upstox
router.use('/api/upstox', upstoxRoutes);

// Instrument routes mounted at /api/instruments
router.use('/api/instruments', instrumentRoutes);

// Historical candle routes mounted at /api/historical-candles
router.use('/api/historical-candles', historicalCandleRoutes);

// Market data routes mounted at /api/market-data
router.use('/api/market-data', marketDataRoutes);

router.use(notFoundHandler);

export default router;
