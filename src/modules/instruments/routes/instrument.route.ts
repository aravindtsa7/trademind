import { Router } from 'express';
import InstrumentSyncController from '../controllers/instrument-sync.controller';

const router = Router();
const controller = new InstrumentSyncController();

// POST /api/instruments/sync
router.post('/sync', controller.sync.bind(controller));

export default router;
