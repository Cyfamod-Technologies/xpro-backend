import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { AppRole, AppSurface } from '@prisma/client';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { RedisAuthService } from './redis-auth.service';

type JwtPayload = {
  sub: string;
  email: string;
  role: AppRole;
  surfaces: AppSurface[];
  sid?: string;
};

const cookieExtractor = (request: Request): string | null => {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  const cookie = cookieHeader
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));

  return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
};

const bearerExtractor = ExtractJwt.fromAuthHeaderAsBearerToken();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redisAuth: RedisAuthService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) throw new Error('JWT_SECRET is not defined');

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        bearerExtractor,
        cookieExtractor,
      ]),
      secretOrKey: secret,
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    const token = bearerExtractor(req) ?? cookieExtractor(req) ?? '';

    const [sessionValid, user] = await Promise.all([
      this.redisAuth.validateSession(
        payload.sub,
        payload.sid,
        token,
        payload.role,
      ),
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, status: true },
      }),
    ]);

    if (!sessionValid) {
      throw new UnauthorizedException('Session expired or has been revoked');
    }

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Authentication failed');
    }

    return {
      id: user.id,
      email: user.email,
      role: payload.role,
      surfaces: payload.surfaces,
      sid: payload.sid,
    };
  }
}
