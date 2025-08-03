import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

const jwt = require('jsonwebtoken');

export function dashboardAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for JWT token in multiple places
  // 1. Authorization header
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];

  // 2. Query parameter (for Bull Board compatibility)
  const queryToken = req.query['token'] as string;
  
  // 3. Cookie
  const cookieToken = req.cookies?.['authToken'];

  const finalToken = headerToken || queryToken || cookieToken;

  if (!finalToken) {
    // Redirect to login page with return URL
    const returnUrl = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?returnUrl=${returnUrl}`);
    return;
  }
  
  // If token came from query, set it as a cookie for future requests
  if (queryToken && !cookieToken) {
    res.cookie('authToken', queryToken, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
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