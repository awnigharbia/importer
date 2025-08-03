import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/auth/login', async (req, res) => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const { username, password } = validatedData;

    // In production, you would fetch this from a database
    // For now, we're using environment variables
    if (username !== env.AUTH_USERNAME) {
      logger.warn('Failed login attempt', { username });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    // Hash the default password on first run if needed
    const storedPassword = env.AUTH_PASSWORD;
    let isValidPassword = false;

    // Check if stored password is already hashed (bcrypt hashes start with $2)
    if (storedPassword.startsWith('$2')) {
      isValidPassword = await bcrypt.compare(password, storedPassword);
    } else {
      // Direct comparison for non-hashed passwords (development only)
      isValidPassword = password === storedPassword;
      if (isValidPassword && env.NODE_ENV === 'production') {
        logger.warn('Using plain text password in production! Please hash your password.');
      }
    }

    if (!isValidPassword) {
      logger.warn('Failed login attempt', { username });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { username },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    logger.info('Successful login', { username });

    return res.json({
      success: true,
      token,
      expiresIn: env.JWT_EXPIRES_IN,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors,
      });
    }

    logger.error('Login error', { error });
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/auth/verify', (req, res): any => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'No token provided',
    });
  }

  jwt.verify(token, env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token',
      });
    }

    return res.json({
      success: true,
      user: decoded,
    });
  });
});

router.post('/auth/logout', (_req, res) => {
  // Since we're using JWT, logout is handled client-side by removing the token
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

// Utility endpoint to generate a bcrypt hash (for development)
if (env.NODE_ENV === 'development') {
  router.post('/auth/hash', async (req, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password required',
      });
    }

    const hash = await bcrypt.hash(password, 10);
    return res.json({
      success: true,
      hash,
      message: 'Use this hash as AUTH_PASSWORD in your .env file',
    });
  });
}

export default router;