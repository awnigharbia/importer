import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

interface JwtPayload {
  username: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ success: false, message: 'Access token required' });
    return;
  }

  jwt.verify(token, env.JWT_SECRET, (err, decoded) => {
    if (err) {
      logger.warn('Invalid token attempt', { error: err.message });
      res.status(403).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    req.user = decoded as JwtPayload;
    next();
  });
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    next();
    return;
  }

  jwt.verify(token, env.JWT_SECRET, (err, decoded) => {
    if (!err) {
      req.user = decoded as JwtPayload;
    }
    next();
  });
}