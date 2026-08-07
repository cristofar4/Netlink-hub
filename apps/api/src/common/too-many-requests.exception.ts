import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * @nestjs/common ships no built-in 429 exception, and rate limiting is central
 * to how NetLink protects verification codes, so the one the codebase needs
 * lives here.
 */
export class TooManyRequestsException extends HttpException {
  constructor(message = 'Too many requests', retryAfterSeconds?: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        error: 'Too Many Requests',
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
