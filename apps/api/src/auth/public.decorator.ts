import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'netlink:isPublic';

/**
 * Marks an endpoint as reachable without a session.
 *
 * The access-token guard is registered globally, so authentication is the
 * default and every exception to it is visible as an explicit `@Public()` in
 * the source — the safe direction for this decision to fail in.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
