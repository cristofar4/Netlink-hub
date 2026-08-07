import { useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '@netlink/contracts';
import { api } from '../lib/api';

/**
 * The live-updates socket.
 *
 * The dashboard has to show whether a computer is online. Polling would either
 * be slow to notice or wasteful, so the server pushes transitions instead.
 *
 * Reconnection backs off from one second to thirty. A home connection dropping
 * for a minute is ordinary; hammering the server through it is not.
 */
export type LiveStatus = 'connecting' | 'connected' | 'offline';

export function useLiveEvents(onEvent: (event: LiveEvent) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');

  // Held in a ref so a changing handler never forces the socket to reconnect.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;

      const url = api.liveUrl();
      if (!url) {
        setStatus('offline');
        return;
      }

      setStatus(attempt === 0 ? 'connecting' : 'offline');
      socket = new WebSocket(url);

      socket.onopen = () => {
        attempt = 0;
        setStatus('connected');
      };

      socket.onmessage = (message) => {
        try {
          handler.current(JSON.parse(message.data as string) as LiveEvent);
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      };

      socket.onclose = (event) => {
        setStatus('offline');
        if (closed) return;

        // 4401 is our own "this session is no longer valid". Retrying would
        // just fail again, and the HTTP layer will already be signing the
        // user out.
        if (event.code === 4401) return;

        attempt += 1;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // `onclose` always follows, and that is where reconnection is handled.
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return status;
}
