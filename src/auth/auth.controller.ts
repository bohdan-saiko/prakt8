import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { CookieOptions, Request, Response } from 'express';

import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { AuthGuard, AuthRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto';

const REFRESH_COOKIE = 'refresh_token';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config().secure,
    sameSite: 'strict',
    path: '/api/auth',
  };
}

function readRefreshCookie(req: Request): unknown {
  return req.cookies?.[REFRESH_COOKIE];
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: PrismaService,
  ) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, expiresAt, ...body } = await this.auth.login(dto);
    setRefreshCookie(res, refreshToken, expiresAt);
    return body;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const { refreshToken, expiresAt, ...body } = await this.auth.refresh(readRefreshCookie(req));
      setRefreshCookie(res, refreshToken, expiresAt);
      return body;
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthRequest) {
    return this.db.user.findUnique({
      where: { id: req.auth.userId },
      select: { id: true, email: true, createdAt: true },
    });
  }

  @Get('sessions')
  @UseGuards(AuthGuard)
  sessions(@Req() req: AuthRequest) {
    return this.db.session.findMany({
      where: { userId: req.auth.userId },
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }
}
