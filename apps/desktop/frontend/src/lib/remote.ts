import {
  REMOTE_HEARTBEAT_SECONDS,
  strategyFromCandidateTypes,
  type ConnectionStrategy,
  type InputEvent,
  type RemoteSessionTicket,
} from '@netlink/contracts';
import { api } from './api';

/**
 * The viewer half of a remote desktop session.
 *
 * It offers, the computer answers, and from then on the pixels and the
 * keystrokes travel directly between the two machines. The control plane sees
 * neither — it carried a handful of SDP lines and then got out of the way.
 *
 * Two things this class deliberately does not do:
 *
 *   * It does not decide whether input is allowed. It hides the pointer
 *     handlers on a view-only session as a courtesy, but the decision is made
 *     on the host, against a signed grant. Nothing here could grant itself
 *     control by being edited.
 *   * It does not retry forever. A connection that has not come up inside the
 *     window has failed, and saying so beats a spinner that never resolves.
 */

const FRAME_HEADER_BYTES = 12;

export type ViewerEvents = {
  onFrame: (bitmap: ImageBitmap, seq: number, latencyMs: number) => void;
  onStrategy: (strategy: ConnectionStrategy) => void;
  onState: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
  onClosed: (reason: string) => void;
};

export class RemoteViewer {
  private pc: RTCPeerConnection | null = null;
  private inputChannel: RTCDataChannel | null = null;
  private pollTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private statsTimer: number | null = null;
  private closed = false;
  private startedAt = Date.now();

  constructor(
    private readonly spaceId: string,
    private readonly ticket: RemoteSessionTicket,
    private readonly events: ViewerEvents,
  ) {}

  get sessionId(): string {
    return this.ticket.session.id;
  }

  get canControl(): boolean {
    return this.ticket.session.mode === 'control';
  }

  async start(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.ticket.iceServers });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void this.send('candidate', JSON.stringify(event.candidate.toJSON()));
    };

    pc.onconnectionstatechange = () => {
      this.events.onState(pc.connectionState);
      if (pc.connectionState === 'failed') {
        this.events.onError('The connection to that computer failed.');
        void this.close('failed');
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        void this.close('failed');
      }
    };

    // Unreliable and unordered: a screen frame that arrives late is worse than
    // useless — it paints a stale picture over a newer one.
    const frames = pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 });
    frames.binaryType = 'arraybuffer';
    frames.onmessage = (event) => void this.paint(event.data as ArrayBuffer);

    // Reliable and ordered: a dropped key-up leaves a modifier stuck down on
    // someone else's machine, and a reordered click lands in the wrong place.
    this.inputChannel = pc.createDataChannel('input', { ordered: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.send('offer', JSON.stringify(offer));

    this.pollTimer = window.setInterval(() => void this.poll(), 700);
    this.heartbeatTimer = window.setInterval(
      () => void this.heartbeat(),
      REMOTE_HEARTBEAT_SECONDS * 1000,
    );
    this.statsTimer = window.setInterval(() => void this.readStrategy(), 3000);
  }

  /** Sends one input event. Ignored entirely on a view-only session. */
  sendInput(event: InputEvent): void {
    if (!this.canControl) return;
    const channel = this.inputChannel;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(event));
  }

  async close(reason: 'viewer_left' | 'failed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const timer of [this.pollTimer, this.heartbeatTimer, this.statsTimer]) {
      if (timer !== null) window.clearInterval(timer);
    }

    try {
      await api.endRemoteSession(this.spaceId, this.sessionId, reason);
    } catch {
      // The session is over either way; a failed tidy-up must not be what the
      // person sees on their way out.
    }

    this.pc?.close();
    this.pc = null;
    this.events.onClosed(reason);
  }

  // -------------------------------------------------------------------------

  private async send(kind: 'offer' | 'candidate' | 'bye', payload: string): Promise<void> {
    if (this.closed) return;
    try {
      await api.sendRemoteSignal(this.spaceId, this.sessionId, kind, payload);
    } catch {
      // Signalling is retried by ICE itself; one lost candidate is not fatal.
    }
  }

  private async poll(): Promise<void> {
    if (this.closed || !this.pc) return;

    let signals;
    try {
      signals = await api.collectRemoteSignals(this.spaceId, this.sessionId);
    } catch {
      return;
    }

    for (const signal of signals) {
      try {
        if (signal.kind === 'answer' && !this.pc.currentRemoteDescription) {
          await this.pc.setRemoteDescription(
            JSON.parse(signal.payload) as RTCSessionDescriptionInit,
          );
        } else if (signal.kind === 'candidate' && this.pc.remoteDescription) {
          await this.pc.addIceCandidate(JSON.parse(signal.payload) as RTCIceCandidateInit);
        } else if (signal.kind === 'bye') {
          await this.close('viewer_left');
        }
      } catch {
        // A candidate that will not apply is dropped; ICE sends more.
      }
    }

    // Once the answer is in and the connection is up, the post box has nothing
    // left to carry.
    if (this.pc.connectionState === 'connected' && this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.closed) return;
    try {
      await api.remoteHeartbeat(this.spaceId, this.sessionId);
    } catch {
      // A missed beat is recoverable; several are not, and the server closes
      // the session on its own idle timer.
    }
  }

  /**
   * Reads which kinds of candidate ended up carrying the session.
   *
   * A relayed connection is not a failure — it is what happens behind a
   * symmetric NAT — but it is slower and the traffic takes a detour, and a
   * person deserves to be told rather than left to experience it as lag.
   */
  private async readStrategy(): Promise<void> {
    if (this.closed || !this.pc) return;

    const stats = await this.pc.getStats();
    let local: string | null = null;
    let remote: string | null = null;

    stats.forEach((report) => {
      if (report.type !== 'candidate-pair') return;
      const pair = report as RTCIceCandidatePairStats & { nominated?: boolean };
      if (pair.state !== 'succeeded' || !pair.nominated) return;
      const localCandidate = stats.get(pair.localCandidateId ?? '') as
        | { candidateType?: string }
        | undefined;
      const remoteCandidate = stats.get(pair.remoteCandidateId ?? '') as
        | { candidateType?: string }
        | undefined;
      local = localCandidate?.candidateType ?? null;
      remote = remoteCandidate?.candidateType ?? null;
    });

    this.events.onStrategy(strategyFromCandidateTypes(local, remote));
  }

  /**
   * Turns one wire message into a picture.
   *
   * A fixed twelve-byte header then a JPEG. `createImageBitmap` decodes off the
   * main thread, which is what keeps a 15fps stream from making the rest of the
   * window feel sticky.
   */
  private async paint(raw: ArrayBuffer): Promise<void> {
    if (raw.byteLength <= FRAME_HEADER_BYTES) return;

    const header = new DataView(raw, 0, FRAME_HEADER_BYTES);
    const seq = header.getUint32(0, true);
    const at = header.getUint32(8, true);

    const blob = new Blob([raw.slice(FRAME_HEADER_BYTES)], { type: 'image/jpeg' });
    try {
      const bitmap = await createImageBitmap(blob);
      const latency = Math.max(Date.now() - this.startedAt - at, 0);
      this.events.onFrame(bitmap, seq, latency);
    } catch {
      // A corrupt frame is dropped. The next one is 60ms away.
    }
  }
}

/**
 * Maps a pointer position on the canvas to normalised 0..1 coordinates.
 *
 * Normalised rather than pixels so a viewer on a laptop and a host on a 4K
 * monitor agree without either knowing the other's resolution.
 */
export function normalisePointer(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/** Browser button numbers to the names the host understands. */
export function buttonName(button: number): 'left' | 'middle' | 'right' | null {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return null;
}
