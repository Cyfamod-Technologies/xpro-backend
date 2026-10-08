import { SetMetadata } from '@nestjs/common';

export const SUCCESS_RESPONSE_KEY = 'successResponse';

export interface SuccessResponseOptions {
  statusCode?: number;
  message?: string;
}

export const SuccessResponse = (
  statusCode = 200,
  message = 'Success',
): MethodDecorator & ClassDecorator =>
  SetMetadata(SUCCESS_RESPONSE_KEY, { statusCode, message });
