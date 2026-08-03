import { Router } from 'express';
import { asyncHandler } from '../../../middleware/async-handler';
import { healthCheck, readinessCheck } from '../controllers/health.controller';

const router = Router();

router.get('/health', asyncHandler(healthCheck));
router.get('/ready', asyncHandler(readinessCheck));

export default router;
