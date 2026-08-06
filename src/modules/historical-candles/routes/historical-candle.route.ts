import { Router } from 'express';
import HistoricalCandleController from '../controllers/historical-candle.controller';

const router = Router();
const controller = new HistoricalCandleController();

// POST /api/historical-candles/sync
router.post('/sync', controller.sync.bind(controller));

export default router;
