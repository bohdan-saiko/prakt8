import { ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RefreshToken, Session } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { hashToken, newRefreshToken, passwordHash, passwordMatches, validTokenShape } from './crypto';
import { LoginDto, RegisterDto } from './dto';

const SAFE_USER_FIELDS = { id: true, email: true, createdAt: true } as const;

type RotationResult =
  | { ok: true; session: Session }
  | { ok: false; code: 'SESSION_INVALID' | 'REFRESH_REUSED' | 'SESSION_EXPIRED' };

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit() {
    this.dummyHash = await passwordHash(randomBytes(32).toString('hex'));
  }

  async register(dto: RegisterDto) {
    const hash = await passwordHash(dto.password);

    try {
      return await this.db.user.create({
        data: { email: dto.email, passwordHash: hash },
        select: SAFE_USER_FIELDS,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email already registered' });
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({ where: { email: dto.email } });

    const passwordOk = await passwordMatches(user?.passwordHash ?? this.dummyHash, dto.password);

    if (!user || !passwordOk) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const refreshToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + config().sessionTtl * 1000);

    const session = await this.db.session.create({
      data: {
        userId: user.id,
        expiresAt,
        tokens: { create: { tokenHash: hashToken(refreshToken), expiresAt } },
      },
    });

    return this.issueTokens(user.id, session.id, refreshToken, expiresAt);
  }

  async refresh(rawToken: unknown) {
    const stored = await this.findRefreshToken(rawToken);
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    const nextToken = newRefreshToken();

    const result = await this.db.$transaction((tx) => this.rotate(tx, stored, nextToken));

    if (!result.ok) {
      throw new UnauthorizedException({ code: result.code, message: 'Please sign in again' });
    }

    const { session } = result;
    return this.issueTokens(session.userId, session.id, nextToken, session.expiresAt);
  }

  private async rotate(
    tx: Prisma.TransactionClient,
    stored: RefreshToken,
    nextToken: string,
  ): Promise<RotationResult> {
    await lockSession(tx, stored.sessionId);

    const token = await tx.refreshToken.findUnique({
      where: { id: stored.id },
      include: { session: true },
    });
    const now = new Date();

    if (!token || token.session.revokedAt) {
      return { ok: false, code: 'SESSION_INVALID' };
    }

    if (token.usedAt) {
      await revokeSession(tx, token.sessionId, now);
      return { ok: false, code: 'REFRESH_REUSED' };
    }

    const expired = token.expiresAt <= now || token.session.expiresAt <= now;
    if (expired) {
      await revokeSession(tx, token.sessionId, now);
      return { ok: false, code: 'SESSION_EXPIRED' };
    }

    await tx.refreshToken.update({
      where: { id: token.id },
      data: { usedAt: now },
    });

    await tx.refreshToken.create({
      data: {
        sessionId: token.sessionId,
        tokenHash: hashToken(nextToken),
        expiresAt: token.session.expiresAt,
      },
    });

    return { ok: true, session: token.session };
  }

  async logout(rawToken: unknown) {
    const stored = await this.findRefreshToken(rawToken);
    if (!stored) return;

    await this.db.$transaction(async (tx) => {
      await lockSession(tx, stored.sessionId);
      await tx.session.updateMany({
        where: { id: stored.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  private async findRefreshToken(rawToken: unknown): Promise<RefreshToken | null> {
    if (!validTokenShape(rawToken)) return null;
    return this.db.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  }

  private async issueTokens(userId: string, sessionId: string, refreshToken: string, expiresAt: Date) {
    const c = config();

    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'access' },
      {
        secret: c.secret,
        algorithm: 'HS256',
        issuer: c.issuer,
        audience: c.audience,
        expiresIn: c.accessTtl,
      },
    );

    return { accessToken, expiresIn: c.accessTtl, tokenType: 'Bearer', refreshToken, expiresAt };
  }
}

// Prisma не підтримує SELECT ... FOR UPDATE, тому row lock через raw SQL.
async function lockSession(tx: Prisma.TransactionClient, sessionId: string) {
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
}

function revokeSession(tx: Prisma.TransactionClient, sessionId: string, at: Date) {
  return tx.session.update({ where: { id: sessionId }, data: { revokedAt: at } });
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
