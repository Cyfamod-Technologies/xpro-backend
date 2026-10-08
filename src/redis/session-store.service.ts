import { Inject, Injectable } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { Redis } from 'ioredis';

export interface StoredSession {
  access: string;
  sessionId: string;
  role: AppRole;
  email: string;
  surfaces: AppRole[] | string[];
  createdAt: string;
  expiresAt: string;
  expiresIn: number;
}

/**
 * Owns the Redis session key scheme and session lifecycle operations
 * (revocation, enumeration). Kept in the global RedisModule so both
 * multiple modules (auth, and anything that revokes sessions during member
 * offboarding) share one implementation without a circular module import.
 */
@Injectable()
export class SessionStore {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  sessionKey(role: string, userId: string, sessionId: string) {
    return `${role.toLowerCase()}:${userId}:session:${sessionId}`;
  }

  sessionsSetKey(role: string, userId: string) {
    return `${role.toLowerCase()}:${userId}:sessions`;
  }

  async revokeSession(userId: string, sessionId: string, role: string) {
    await this.redis.del(this.sessionKey(role, userId, sessionId));
    await this.redis.srem(this.sessionsSetKey(role, userId), sessionId);
    return true;
  }

  async revokeAllSessions(userId: string, role: string) {
    const sessionIds = await this.redis.smembers(
      this.sessionsSetKey(role, userId),
    );
    for (const sessionId of sessionIds) {
      await this.redis.del(this.sessionKey(role, userId, sessionId));
    }
    await this.redis.del(this.sessionsSetKey(role, userId));
    return true;
  }

  async getAllSessions(userId: string, role: string): Promise<StoredSession[]> {
    const sessionIds = await this.redis.smembers(
      this.sessionsSetKey(role, userId),
    );
    const sessions: StoredSession[] = [];
    for (const sessionId of sessionIds) {
      const tokenData = await this.redis.get(
        this.sessionKey(role, userId, sessionId),
      );
      if (tokenData) sessions.push(JSON.parse(tokenData) as StoredSession);
    }
    return sessions;
  }

  async getAllSessionsForUser(userId: string): Promise<StoredSession[]> {
    const roles: AppRole[] = ['super_admin', 'admin', 'user'];
    const all = await Promise.all(
      roles.map((role) => this.getAllSessions(userId, role)),
    );
    return all.flat();
  }

  async revokeAllSessionsForUser(userId: string) {
    const roles: AppRole[] = ['super_admin', 'admin', 'user'];
    await Promise.all(
      roles.map((role) => this.revokeAllSessions(userId, role)),
    );
  }

  private reauthKey(userId: string) {
    return `reauth:${userId}`;
  }

  /** Stores a short-lived reauthentication proof token (default 5 minutes). */
  async setReauthToken(userId: string, token: string, ttlSeconds = 300) {
    await this.redis.setex(this.reauthKey(userId), ttlSeconds, token);
  }

  /** Verifies and consumes a reauthentication proof token. */
  async consumeReauthToken(userId: string, token: string): Promise<boolean> {
    const stored = await this.redis.get(this.reauthKey(userId));
    if (!stored || stored !== token) return false;
    await this.redis.del(this.reauthKey(userId));
    return true;
  }
}
