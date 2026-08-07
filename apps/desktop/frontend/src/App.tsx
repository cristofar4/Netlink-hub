import { SessionProvider, useSession } from './state/session';
import { AuthFlow } from './screens/auth/AuthFlow';
import { Shell } from './screens/Shell';

export function App() {
  return (
    <SessionProvider>
      <Root />
    </SessionProvider>
  );
}

function Root() {
  const { ready, signedIn } = useSession();

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
        <span className="nl-visually-hidden">Starting NetLink</span>
      </div>
    );
  }

  return signedIn ? <Shell /> : <AuthFlow />;
}
