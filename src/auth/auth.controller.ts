import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ConfirmMfaDto,
  DisableMfaDto,
  ForgotPasswordDto,
  LoginDto,
  ReauthenticateDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SignupDto,
  UpdateMeDto,
  VerifyEmailDto,
} from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @ApiOperation({ summary: 'Register a new user account' })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 400, description: 'Invalid signup payload.' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('register')
  @ApiOperation({
    summary: 'Register a new user account (alias for /auth/signup)',
  })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 400, description: 'Invalid signup payload.' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async register(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('verify-email')
  @ApiOperation({ summary: 'Verify an account email with a six-digit code' })
  @ApiResponse({ status: 201, description: 'Email verified.' })
  @ApiResponse({ status: 400, description: 'Invalid verification code.' })
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyEmail(dto);
    this.setSessionCookie(res, result.accessToken);
    return result;
  }

  @Post('resend-verification')
  @ApiOperation({ summary: 'Request a new email verification code' })
  @ApiResponse({ status: 201, description: 'Verification request accepted.' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    this.setSessionCookie(res, result.accessToken);
    return result;
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Initiate password reset' })
  @ApiResponse({ status: 200, description: 'Password reset request accepted.' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password using reset token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid reset token.' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('change-password')
  @ApiOperation({ summary: 'Change the authenticated user password' })
  @ApiResponse({ status: 201, description: 'Password changed successfully.' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, dto);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout the authenticated user' })
  @ApiResponse({ status: 200, description: 'Logout successful.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(SESSION_COOKIE_NAME);
    return this.authService.logout(user.id, user.sid, user.role);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh the authenticated user session token' })
  @ApiResponse({ status: 201, description: 'Session token refreshed.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  async refresh(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.refreshToken(user);
    this.setSessionCookie(res, result.accessToken);
    return result;
  }

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Authenticated user returned.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: RequestUser) {
    return this.authService.me(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUser() user: RequestUser, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(user.id, dto);
  }

  @Post('mfa/setup')
  @ApiOperation({
    summary: 'Begin MFA setup — returns TOTP secret and otpauth URL',
  })
  @ApiResponse({ status: 201, description: 'MFA setup initiated.' })
  @ApiResponse({ status: 400, description: 'MFA already enabled.' })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  setupMfa(@CurrentUser() user: RequestUser) {
    return this.authService.setupMfa(user.id);
  }

  @Post('mfa/confirm')
  @ApiOperation({
    summary: 'Confirm MFA setup with a TOTP code — enables MFA on the account',
  })
  @ApiResponse({ status: 201, description: 'MFA enabled.' })
  @ApiResponse({
    status: 400,
    description: 'No pending MFA setup or invalid code.',
  })
  @ApiResponse({ status: 401, description: 'Authentication required.' })
  @UseGuards(JwtAuthGuard)
  confirmMfa(@CurrentUser() user: RequestUser, @Body() dto: ConfirmMfaDto) {
    return this.authService.confirmMfa(user.id, dto.code);
  }

  @Post('mfa/disable')
  @ApiOperation({
    summary:
      'Disable MFA — requires current password and TOTP code if MFA is active',
  })
  @ApiResponse({ status: 201, description: 'MFA disabled.' })
  @ApiResponse({ status: 400, description: 'Incorrect password.' })
  @ApiResponse({
    status: 401,
    description: 'Authentication required or invalid MFA code.',
  })
  @UseGuards(JwtAuthGuard)
  disableMfa(@CurrentUser() user: RequestUser, @Body() dto: DisableMfaDto) {
    return this.authService.disableMfa(user.id, dto);
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'List active sessions for the authenticated user' })
  @UseGuards(JwtAuthGuard)
  listSessions(@CurrentUser() user: RequestUser) {
    return this.authService.listSessions(user.id, user.role, user.sid);
  }

  @Delete('me/sessions/:sessionId')
  @ApiOperation({ summary: 'Revoke a specific session' })
  @UseGuards(JwtAuthGuard)
  revokeSession(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.authService.revokeSession(user.id, user.role, sessionId);
  }

  @Delete('me/sessions')
  @ApiOperation({ summary: 'Revoke all sessions for the authenticated user' })
  @UseGuards(JwtAuthGuard)
  revokeAllSessions(@CurrentUser() user: RequestUser) {
    return this.authService.revokeAllSessions(user.id);
  }

  @Get('me/login-history')
  @ApiOperation({
    summary: 'Return recent login events for the authenticated user',
  })
  @UseGuards(JwtAuthGuard)
  loginHistory(@CurrentUser() user: RequestUser) {
    return this.authService.loginHistory(user.id);
  }

  @Post('reauthenticate')
  @ApiOperation({
    summary:
      'Reauthenticate to obtain a short-lived proof token for sensitive actions',
  })
  @UseGuards(JwtAuthGuard)
  reauthenticate(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReauthenticateDto,
  ) {
    return this.authService.reauthenticate(user.id, dto.password, dto.code);
  }

  private setSessionCookie(res: Response, accessToken: string) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(SESSION_COOKIE_NAME, accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 4,
    });
  }
}
