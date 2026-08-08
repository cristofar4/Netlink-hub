# NetLink Development Phases

Each phase states its exact outcome, what proves it, and what stays simulated afterwards. A phase is not complete while any check fails.

Current state is tracked in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

---

## Phase 0 — Foundation ✅

**Outcome:** the repository builds, runs and reports its own health on a clean Windows machine.

- Environment inspection with actionable fixes (`setup-windows.ps1`)
- Monorepo, documentation, Windows scripts
- Design tokens and the component system, with reduced-motion support
- All ten navigation sections present
- Liveness and readiness health checks; readiness actually queries PostgreSQL
- OpenAPI at `/docs`

**Proven by:** `test-all.ps1` passing end to end; the API answering `/api/health` with `database: up`.

---

## Phase 1 — Authentication and trusted devices ✅

**Outcome:** a person can create an account, confirm it, sign in from a new device, trust that device, and revoke it — with every step audited.

- Registration with Argon2id
- Six-digit email codes: ten minutes, single use, attempt- and resend-capped, stored hashed
- Sign-in with a generic failure message and constant-cost verification
- New-device verification with a masked email and an explicit Trust This Device
- Per-device Ed25519 key pairs, DPAPI-sealed on Windows
- Rotating refresh tokens with reuse detection
- Device list, rename and immediate revocation
- Audit events for everything

**Proven by:** the automated suite; a Playwright walkthrough of the real UI against the real API with no console errors.

**Still simulated afterwards:** agent heartbeats — the agent has a working signed client but the control plane has no endpoint for it yet, so device "online" state is not live.

---

## Phase 2 — Spaces and agents ✅

**Outcome:** a Space exists, the home PC's agent enrolls into it, and the dashboard shows it going online and offline for real.

- `POST /agent/enroll` and `POST /agent/heartbeat`, both verifying the agent's Ed25519 request signature
- A signature covering method, path, timestamp, nonce and body digest — already implemented on the agent side
- Short-lived enrollment tokens issued by the desktop app, so the service never needs the owner's password
- Space creation and resource registration
- WebSocket push so online state changes without polling
- Refresh token sealed with DPAPI through the Go side, so a restart no longer signs the user out

**Proven by:** a real Go agent enrolling against the real API and heartbeating; 28 agent integration tests. Killing the agent turns the map node grey within one heartbeat interval and restarting it turns it green, without a page reload.

**Note:** the desktop app still holds its refresh token in memory only. Sealing it via DPAPI was deferred — signing in again after a restart is the honest trade against leaving a long-lived credential readable by any process running as that user.

---

## Phase 3 — Demo Data Pool ✅

**Outcome:** an owner allocates data to an invited person, who sees their allowance and nothing else.

- The provider adapter interface: `verifyAccount`, `getBalance`, `getPlan`, `createAllocation`, `updateAllocation`, `pauseAllocation`, `revokeAllocation`, `getUsage`, `handleProviderWebhook`
- A **Demo Provider**, labelled as a demo everywhere it appears, seeded with 100 GB and realistic usage events
- Data-Only Pass creation: email or QR, total allocation, daily limit, expiry, no re-sharing
- Claiming a pass with the invitee's own NetLink account
- Member Access: name, device, connection status, usage today, total usage, remaining, daily limit, expiry, Pause, Edit Limit, Revoke, permission list
- Usage tracking by quantity, session time and approved device

**Proven by:** 36 integration tests, including ones that send device, file, printer, power and member requests **directly to the API** as a Data-Only member and assert each is refused — not merely that the UI hides the buttons.

**Explicitly not in scope:** anything that bypasses carrier billing. The Demo Provider is a development fixture and says so.

---

## Phase 4 — Device Power and Wake ✅

**Outcome:** the owner turns on a powered-off Home PC from a trusted remote device, via a Family PC acting as Wake Helper.

The command envelope, its verifier, replay protection and the WoL packet builder are **already complete and tested**. This phase wires them up.

- Wake Helper selection and readiness display: WoL enabled, adapter present, mains power where detectable, helper online, wake-capable link, MAC registered
- Turn On, Restart, Shut Down, Lock, Sleep, Cancel
- Step-up verification for sensitive actions
- A ten-second countdown that can be cancelled
- An audit entry for every request and every result

**Rules that must hold:** restart, shutdown, lock and sleep require the target agent online; wake requires an online helper on the same LAN; invited members get no power permissions by default; no arbitrary execution verb, ever.

**Proven by:** 35 integration tests plus Go tests that pin the signing input byte for byte on both sides. The scenario in the brief — Family PC online, Home PC off but on mains, owner presses Turn On — is the intended path and is what the wake readiness checks describe; it needs real hardware to demonstrate, and every component of it is tested.

---

## Phase 5 — Files and printers ✅

**Outcome:** the owner browses an approved folder, transfers a file, and prints a PDF at home.

- Approved-folder registration; nothing outside it is ever visible, and traversal out of a root is rejected explicitly
- Browse, download, upload, create folder, rename
- Resumable transfers with progress, integrity checking and cancellation
- Deletion behind its own permission and a confirmation
- Printer discovery on the home Windows machine
- PDF jobs with preview, copies, colour and paper size; `printers.use` required
- An audit entry per operation

**Proven by:** 27 API integration tests and 30 Go tests on the vault, most of the latter being escape attempts — `..` traversal, absolute paths, drive letters, UNC paths, alternate data streams, NUL bytes, symlink escape, and sibling-prefix confusion.

---

## Phase 6 — Remote desktop ✅

**Outcome:** the owner sees and controls their home computer's screen.

- WebRTC signalling through the control plane; the peers connect directly
- ICE with STUN and TURN, TURN credentials minted per session and expiring in minutes
- Direct connection preferred, relay where the network requires it, and the viewer is told which
- Screen stream and full keyboard and mouse control
- View Only and Full Control, with Full Control behind a six-digit confirmation
- Connection state, direct-or-relay, latency, session duration and a hard four-hour ceiling

**Proven by:** 45 API integration tests, 40+ Go tests including two peers connecting over a real WebRTC data channel, and a verified end-to-end run: a real agent, a real peer connection, real frames, and input on a view-only session refused, counted and audited.

**The design decision that mattered:** input travels peer to peer, so the control plane cannot police it. The mode is therefore sealed in a signed grant and enforced by the agent. `devices.observe` was added as a sixteenth permission so that view-only can be granted independently of control — without that split, "view only" would be a label rather than a boundary.

**Not built:** audio, and clipboard sharing. Both are genuine features and neither is a security control; they were left out rather than half-built. Unattended-versus-ask-every-time is likewise not built: every session today is unattended-with-a-signed-grant, and an at-the-machine approval prompt is a real addition rather than a toggle.

**Never:** storing the user's Windows password on the server. There is no code path that asks for one.

---

## Phase 7 — Production hardening ✅

**Outcome:** NetLink is fit to hand to people who are not us.

- **Distributed rate limiting.** Counters in PostgreSQL, shared across instances, incremented by a single atomic statement. Postgres rather than Redis: the database is already a hard dependency, already secured and already backed up, and the property that matters is an increment two instances cannot interleave.
- **Per-account abuse prevention.** A per-IP limit cannot see a thousand machines each trying one password against one account. After five failures an account cools off, doubling to a fifteen-minute ceiling and decaying after an hour of quiet — temporary on purpose, because a permanent lockout would let anyone who knows an email address lock its owner out.
- **Monitoring.** Prometheus metrics and one structured log line per request, both carrying route *templates* and never ids, emails or addresses. Implemented as middleware rather than an interceptor, because guards run before interceptors and a request refused by authentication is exactly the one worth counting.
- **Backups.** `backup-windows.ps1` dumps, checksums and then **verifies by restoring into a throwaway database** — an unverified backup is a belief, not a backup. `restore-windows.ps1` refuses to run while the API is up and makes you type the database name.
- **Signed releases and safe updates.** Authenticode over the binaries, and a separate Ed25519 signature over a manifest naming each artifact's exact SHA-256. Downgrades are refused, manifests expire, plain HTTP is refused, and downloads are length-bounded. `build-release.ps1` refuses to claim something was signed when it was not.
- **A full threat-model review.** THREAT_MODEL.md covers T1–T17 and now includes a reviewer's pack: where to start, the seven claims worth attacking, and what we already know is weak.

**Deliberately not built:** passkeys, authenticator apps and biometric unlock. Email remains the second factor, and that is recorded as an accepted risk rather than quietly omitted — adding a second factor properly means account recovery, device binding and a migration path for everyone who already has an account, which is its own piece of work rather than a checkbox.

**Also not built:** an HSM for the control plane's signing key. That is deployment work, and it is named in the accepted-risks table.

**Done when:** an external reviewer has what they need — THREAT_MODEL.md §7 — and every remaining entry in the known-limitations table is a deliberate, documented acceptance. Both hold.
