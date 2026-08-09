import { SessionProvider, useSession } from './state/session';
import { BrandProvider, useBrandName } from './state/brand';
import { AuthFlow } from './screens/auth/AuthFlow';
import { Shell } from './screens/Shell';

export function App() {
  return (
    <BrandProvider>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </BrandProvider>
  );
}

function Root() {
  const { ready, signedIn } = useSession();
  const brand = useBrandName();

  // `ready` waits for the Go side to report which control plane this
  // installation talks to. Rendering the sign-in form first would let a user
  // start typing against the wrong endpoint.
  if (!ready) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--nl-text-muted)',
        }}
      >
        <span className="nl-spinner" aria-hidden="true" />
        <span className="nl-visually-hidden">Starting {brand}</span>
      </div>
    );
  }

  return signedIn ? <Shell /> : <AuthFlow />;
}
