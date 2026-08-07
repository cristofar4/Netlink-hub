import { useState } from 'react';
import { Alert, Button, Card } from '@netlink/ui';
import { api, ApiError } from '../lib/api';

/**
 * Connects the background agent on this machine to a Space.
 *
 * The owner is already signed in here, so the window vouches for the local
 * agent once by minting a short-lived enrollment token. That is what keeps the
 * owner's password out of the service entirely — everything the agent does
 * afterwards is proven by its own device key.
 *
 * The token is shown rather than injected because the service may be installed
 * but not yet running, and because a person should be able to see exactly what
 * is being handed over.
 */
export function EnrollAgentCard({
  spaceId,
  onEnrolled,
}: {
  spaceId: string;
  onEnrolled: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mint = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await api.createEnrollmentToken(spaceId);
      setToken(response.token);
      setExpiresAt(response.expiresAt);
      setCopied(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not create an enrollment link.',
      );
    } finally {
      setBusy(false);
    }
  };

  const command = token ? `netlink-agent enroll --token ${token}` : '';

  return (
    <Card
      title="Connect this computer"
      subtitle="Join the NetLink agent on this machine to the Space so it can report as online."
    >
      {error && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {!token ? (
        <>
          <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
            NetLink creates a link that is valid for five minutes and can be used once. Your
            password is never given to the background service.
          </p>
          <div style={{ marginTop: 16 }}>
            <Button variant="primary" loading={busy} onClick={() => void mint()}>
              Create an enrollment link
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
            Run this in a terminal on this computer. It works once, and expires{' '}
            {expiresAt ? `at ${new Date(expiresAt).toLocaleTimeString()}` : 'in five minutes'}.
          </p>

          <pre
            className="nl-mono"
            style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 'var(--nl-radius)',
              background: 'var(--nl-surface-sunken)',
              border: '1px solid var(--nl-border)',
              fontSize: 'var(--nl-text-xs)',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {command}
          </pre>

          <div className="nl-row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(command);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy command'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onEnrolled}>
              I have run it — refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setToken(null)}>
              Discard this link
            </Button>
          </div>

          <div style={{ marginTop: 14 }}>
            <Alert tone="warning">
              Treat this link like a password until it is used. Anyone who runs it on any computer
              can join that computer to this Space.
            </Alert>
          </div>
        </>
      )}
    </Card>
  );
}
