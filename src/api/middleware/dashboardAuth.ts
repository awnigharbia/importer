import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

const jwt = require('jsonwebtoken');

export function dashboardAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for JWT token in Authorization header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  // Also check for token in query parameter (for Bull Board compatibility)
  const queryToken = req.query['token'] as string;
  const finalToken = token || queryToken;

  if (!finalToken) {
    // Redirect to login page with return URL
    const returnUrl = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?returnUrl=${returnUrl}`);
    return;
  }

  jwt.verify(finalToken, env.JWT_SECRET, (err: any) => {
    if (err) {
      // Invalid token, redirect to login
      const returnUrl = encodeURIComponent(req.originalUrl);
      res.redirect(`/login?returnUrl=${returnUrl}`);
      return;
    }

    // Valid token, continue
    next();
  });
}