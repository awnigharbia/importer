import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const jwt = require('jsonwebtoken');

interface JwtPayload {
  username: string;
  iat?: number;
  exp?: number;
}

declare module 'express' {
  interface Request {
    user?: JwtPayload;
  }
}

export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ success: false, message: 'Access token required' });
    return;
  }

  jwt.verify(token, env.JWT_SECRET, (err: any, decoded: any) => {
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

  jwt.verify(token, env.JWT_SECRET, (err: any, decoded: any) => {
    if (!err) {
      req.user = decoded as JwtPayload;
    }
    next();
  });
}