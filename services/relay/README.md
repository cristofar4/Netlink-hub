# NetLink Relay

**Phase 6. Not implemented.** This directory holds the placement and the contract, so the decision about what a relay may and may not do is made before any code exists.

## What it will be

When two devices cannot reach each other directly — a symmetric NAT on both ends, a restrictive corporate network — media falls back to a relay. The relay's entire job is to forward opaque bytes between two peers that have already established end-to-end encryption with each other.

## What it must never be

- It must never hold a decryption key. Media stays end-to-end encrypted **through** the relay; it is a dumb pipe, not a participant.
- It must never store or buffer content beyond what forwarding requires.
- It must never be reachable without a short-lived, session-scoped credential issued by the control plane.

If a future change would require the relay to see plaintext, that is a redesign, not a feature.

## Contract

The types the relay must satisfy already exist in
[`packages/contracts/src/connection.ts`](../../packages/contracts/src/connection.ts):
`IceServerConfig`, `ConnectionStrategy`, `ConnectionQuality`, `SignalMessage`, `SignallingTransport`.

`ConnectionStrategy` distinguishes `direct` from `relay` explicitly, because the desktop app tells the user which one they are on — a person should be able to see when their traffic is taking the longer path.

## Before building this

Phase 6 depends on Phases 1 through 5 being stable. Remote desktop is the most dangerous capability in the product; it is built last, on foundations that have been exercised.
