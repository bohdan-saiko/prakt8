import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { config } from '../config';
import { PrismaService } from '../prisma.service';

const DAY_MS = 86_400_000;

@Injectable()
export class SessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private readonly db: PrismaService) {}

  onModuleInit() {
    const intervalMs = config().sessionCleanupIntervalSeconds * 1000;

    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();

    void this.run();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async cleanup(now = new Date()) {
    const cutoff = new Date(now.getTime() - config().sessionRetentionDays * DAY_MS);

    return this.db.session.deleteMany({
      where: { expiresAt: { lte: cutoff } },
    });
  }

  private run(): Promise<void> {
    if (this.running) return this.running;

    this.running = this.cleanup()
      .then(() => undefined)
      .catch(() => this.logger.error('Session cleanup failed; retry on next interval'))
      .finally(() => {
        this.running = undefined;
      });

    return this.running;
  }
}
