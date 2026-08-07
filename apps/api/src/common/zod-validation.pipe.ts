import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validates a request body against the shared contract schema.
 *
 * Every write endpoint uses this, so the API accepts exactly the shapes
 * `@netlink/contracts` describes and nothing else — unknown fields are stripped
 * by the schemas rather than reaching a service.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'The request could not be processed.',
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
