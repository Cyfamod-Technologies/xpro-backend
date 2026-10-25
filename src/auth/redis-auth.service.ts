import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppRole, AppSurface } from '@prisma/client';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { SessionStore } from '../redis/session-store.service';

export interface TokenData {
  access: string;
  sessionId: string;
  role: AppRole;
  email: string;
  surfaces: AppSurface[];
  createdAt: string;
  expiresAt: string;
  expiresIn: number;
}

export type AuthTokenContext = {
  id: string;
  email: string;
  role: AppRole;
  surfaces: AppSurface[];
};

@Injectable()
export class RedisAuthService {
  private readonly tokenExpiry = 4 * 24 * 60 * 60; // 4 days in seconds

  constructor(
    private readonly jwtService: JwtService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly sessions: SessionStore,
  ) {}

  private sessionKey(role: string, userId: string, sessionId: string) {
    return this.sessions.sessionKey(role, userId, sessionId);
  }

  private sessionsSetKey(role: string, userId: string) {
    return this.sessions.sessionsSetKey(role, userId);
  }

  async generateToken(user: AuthTokenContext, expirySeconds?: number) {
    const ttl =
      expirySeconds && expirySeconds > 0 ? expirySeconds : this.tokenExpiry;
    const sessionId = uuidv4();
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      surfaces: user.surfaces,
      sid: sessionId,
    };

    const accessToken = this.jwtService.sign(payload, { jwtid: sessionId });

    const tokenData: TokenData = {
      access: accessToken,
      sessionId,
      role: user.role,
      email: user.email,
      surfaces: user.surfaces,
      createdAt: new Date().toISOString(),
      expiresIn: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };

    await this.redis.setex(
      this.sessionKey(user.role, user.id, sessionId),
      ttl,
      JSON.stringify(tokenData),
    );

    await this.redis.sadd(this.sessionsSetKey(user.role, user.id), sessionId);
    await this.redis.expire(this.sessionsSetKey(user.role, user.id), ttl);

    return tokenData;
  }

  async validateSession(
    userId: string,
    sessionId: string | undefined,
    token: string,
    role: string,
  ): Promise<boolean> {
    if (!sessionId || !token) return false;

    const tokenData = await this.redis.get(
      this.sessionKey(role, userId, sessionId),
    );
    if (!tokenData) return false;

    const parsed = JSON.parse(tokenData) as TokenData;
    return parsed.access === token;
  }

  async validateToken(
    userId: string,
    token: string,
    role: string,
  ): Promise<boolean> {
    const sessionIds = await this.redis.smembers(
      this.sessionsSetKey(role, userId),
    );

    for (const sessionId of sessionIds) {
      const tokenData = await this.redis.get(
        this.sessionKey(role, userId, sessionId),
      );
      if (tokenData && (JSON.parse(tokenData) as TokenData).access === token) {
        return true;
      }
    }

    return false;
  }

  async refreshTokenBySession(
    userId: string,
    sessionId: string | undefined,
    role: AppRole,
  ) {
    if (!sessionId) throw new UnauthorizedException('Session not found');

    const key = this.sessionKey(role, userId, sessionId);
    const tokenData = await this.redis.get(key);
    if (!tokenData) throw new UnauthorizedException('Session not found');

    const parsed = JSON.parse(tokenData) as TokenData;
    const payload = {
      sub: userId,
      email: parsed.email,
      role: parsed.role,
      surfaces: parsed.surfaces,
      sid: sessionId,
    };

    const newAccessToken = this.jwtService.sign(payload, { jwtid: sessionId });
    const updated: TokenData = {
      ...parsed,
      access: newAccessToken,
      createdAt: new Date().toISOString(),
      expiresIn: this.tokenExpiry,
      expiresAt: new Date(Date.now() + this.tokenExpiry * 1000).toISOString(),
    };

    await this.redis.setex(key, this.tokenExpiry, JSON.stringify(updated));
    await this.redis.expire(
      this.sessionsSetKey(role, userId),
      this.tokenExpiry,
    );

    return updated;
  }

  async revokeSession(userId: string, sessionId: string, role: string) {
    return this.sessions.revokeSession(userId, sessionId, role);
  }

  async revokeAllSessions(userId: string, role: string) {
    return this.sessions.revokeAllSessions(userId, role);
  }

  async getAllSessions(userId: string, role: string) {
    return this.sessions.getAllSessions(userId, role) as Promise<TokenData[]>;
  }

  async revokeAllSessionsForUser(userId: string) {
    await this.sessions.revokeAllSessionsForUser(userId);
  }

  private resetTokenKey(tokenHash: string) {
    return `pwd_reset:${tokenHash}`;
  }

  async storePasswordResetToken(userId: string, tokenHash: string) {
    await this.redis.setex(this.resetTokenKey(tokenHash), 60 * 60, userId);
  }

  async consumePasswordResetToken(tokenHash: string): Promise<string | null> {
    const key = this.resetTokenKey(tokenHash);
    const userId = await this.redis.get(key);
    if (userId) await this.redis.del(key);
    return userId;
  }

  private mfaPendingKey(userId: string) {
    return `mfa:pending:${userId}`;
  }

  async storeMfaPendingSecret(userId: string, secret: string) {
    await this.redis.setex(this.mfaPendingKey(userId), 10 * 60, secret);
  }

  async getMfaPendingSecret(userId: string): Promise<string | null> {
    return this.redis.get(this.mfaPendingKey(userId));
  }

  async deleteMfaPendingSecret(userId: string) {
    await this.redis.del(this.mfaPendingKey(userId));
  }
}
