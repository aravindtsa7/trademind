import { Router } from 'express';
import UpstoxController from '../controllers/upstox.controller';

const router = Router();
const controller = new UpstoxController();

// GET /api/upstox/auth/url
router.get('/auth/url', controller.getAuthUrl.bind(controller));

// GET /api/upstox/auth/callback
router.get('/auth/callback', controller.callback.bind(controller));

// GET /api/upstox/profile
router.get('/profile', controller.getProfile.bind(controller));

export default router;
