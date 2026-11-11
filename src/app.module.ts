import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionCleanupService } from './auth/session-cleanup.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
  ],
  controllers: [AuthController],
  providers: [
    PrismaService,
    AuthService,
    AuthGuard,
    SessionCleanupService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
