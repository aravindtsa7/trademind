import { Router } from 'express';
import MarketDataController from '../controllers/market-data.controller';

const router = Router();
const controller = new MarketDataController();

// GET /api/market-data/status
router.get('/status', controller.status.bind(controller));

export default router;
