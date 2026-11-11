import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { config } from '../config';
import { PrismaService } from '../prisma.service';

export type AuthRequest = Request & {
  auth: { userId: string; sessionId: string };
};

type AccessClaims = {
  sub?: string;
  sid?: string;
  type?: string;
  exp?: number;
};

const BEARER = /^Bearer ([^\s]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();

    const token = extractBearerToken(req);
    const claims = await this.verifyJwt(token);
    const { userId, sessionId } = validateClaims(claims);
    await this.ensureSessionActive(userId, sessionId);

    req.auth = { userId, sessionId };
    return true;
  }

  private async verifyJwt(token: string): Promise<AccessClaims> {
    const c = config();
    try {
      return await this.jwt.verifyAsync<AccessClaims>(token, {
        secret: c.secret,
        algorithms: ['HS256'],
        issuer: c.issuer,
        audience: c.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async ensureSessionActive(userId: string, sessionId: string) {
    const session = await this.db.session.findUnique({ where: { id: sessionId } });

    const active =
      session !== null &&
      session.userId === userId &&
      session.revokedAt === null &&
      session.expiresAt > new Date();

    if (!active) throw new UnauthorizedException('Session revoked or expired');
  }
}

function extractBearerToken(req: Request): string {
  const match = BEARER.exec(req.headers.authorization ?? '');
  if (!match) throw new UnauthorizedException('Bearer token required');
  return match[1];
}

function validateClaims(claims: AccessClaims) {
  const valid =
    claims.type === 'access' &&
    claims.exp !== undefined &&
    typeof claims.sub === 'string' && UUID.test(claims.sub) &&
    typeof claims.sid === 'string' && UUID.test(claims.sid);

  if (!valid) throw new UnauthorizedException();
  return { userId: claims.sub!, sessionId: claims.sid! };
}
