import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * One structured log line and one metric per request.
 *
 * **Middleware rather than an interceptor**, and that is the whole reason this
 * file exists in this shape. Nest runs guards before interceptors, so an
 * interceptor never sees a request the authentication guard refused — and a
 * request that was refused is precisely the one worth counting. It also never
 * sees a 404, because an unmatched path is handled before the interceptor
 * pipeline engages. Middleware wraps `response.finish`, which fires for every
 * response the server sends, whatever decided it.
 *
 * The rules it follows:
 *
 *   * **Routes are recorded as templates, never as the paths that were hit.**
 *     `/spaces/:spaceId/files` and not the Space id. Ids in a metric label are
 *     unbounded cardinality and a record of who used what and when, on an
 *     endpoint monitoring scrapes without authenticating.
 *   * **No request body, no query string, no headers.** A log line that
 *     includes a body eventually includes a password, and NetLink's whole claim
 *     is that content does not reach the server's records.
 *   * **A request id, echoed back.** So somebody reporting "it failed at about
 *     three" can be matched to a line without anyone searching by their email.
 */
@Injectable()
export class ObservabilityMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Request');

  constructor(private readonly metrics: MetricsService) {}

  use(request: Request & { requestId?: string }, response: Response, next: NextFunction): void {
    const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    const method = request.method;
    const startedAt = process.hrtime.bigint();

    response.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const status = response.statusCode;
      // Read at finish, not at entry: Express fills in `route` during routing,
      // which has not happened yet when middleware runs.
      const route = routeTemplate(request);

      this.metrics.increment(
        'netlink_http_requests_total',
        'HTTP requests handled, by route template and status.',
        { method, route, status: String(status) },
      );
      this.metrics.observe(
        'netlink_http_request_duration_seconds',
        'How long requests take, by route template.',
        seconds,
        { method, route },
      );

      // Errors get a line each; successes at debug, so a healthy server does
      // not produce a log line per heartbeat from every agent.
      const message = `${method} ${route} ${status} ${(seconds * 1000).toFixed(1)}ms id=${requestId}`;
      if (status >= 500) this.logger.warn(message);
      else if (status >= 400) this.logger.log(message);
      else this.logger.debug(message);
    });

    next();
  }
}

/**
 * The route as it is declared, not as it was requested.
 *
 * A request that matched nothing has no route, and is bucketed as `unmatched`
 * rather than recorded verbatim — otherwise anyone could create unlimited
 * metric series by requesting random paths, which is both a memory leak and a
 * way to make the metrics endpoint useless.
 */
function routeTemplate(request: Request & { route?: { path?: string } }): string {
  const path = request.route?.path;
  if (!path) return 'unmatched';
  const base = (request.baseUrl ?? '').replace(/\/$/, '');
  return `${base}${path}` || path;
}

function headerValue(request: Request, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  // Bounded and stripped: this is echoed into a response header and a log line,
  // and it arrives from outside.
  const cleaned = value.slice(0, 64).replace(/[^\w.-]/g, '');
  return cleaned || null;
}
