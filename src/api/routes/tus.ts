import { Router } from 'express';
import { createTusServer } from '../../services/tusServer';

const router = Router();

const tusServer = createTusServer();

// Handle all TUS routes
router.all('*', (req, res) => {
  tusServer.handle(req, res);
});

export default router;