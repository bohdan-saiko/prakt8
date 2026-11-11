import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { config } from './config';

const STATE_CHANGING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

export async function createApp() {
  const c = config();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });

  app.setGlobalPrefix('api');
  app.use(helmet());

  app.enableCors({
    origin: c.origin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Protection'],
  });

  app.use(cookieParser());
  app.use(securityHeaders);
  app.use(csrfProtection(c.origin));

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  app.enableShutdownHooks();
  await app.init();
  return app;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Request-Id', randomUUID());
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function csrfProtection(allowedOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (!STATE_CHANGING_METHODS.includes(req.method)) return next();

    const hasHeader = req.get('X-CSRF-Protection') === '1';
    const origin = req.get('Origin');
    const originOk = !origin || origin === allowedOrigin;

    if (!hasHeader || !originOk) {
      res.status(403).json({
        statusCode: 403,
        code: 'CSRF_REJECTED',
        message: 'Missing header or invalid origin',
      });
      return;
    }

    next();
  };
}
