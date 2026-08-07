# NetLink Development Phases

Each phase states its exact outcome, what proves it, and what stays simulated afterwards. A phase is not complete while any check fails.

Current state is tracked in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

---

## Phase 0 — Foundation ✅

**Outcome:** the repository builds, runs and reports its own health on a clean Windows machine.

- Environment inspection with actionable fixes (`setup-windows.ps1`)
- Monorepo, documentation, Windows scripts
- Design tokens and the component system, with reduced-motion support
- All eight navigation sections present
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

**Proven by:** 144 automated tests; a Playwright walkthrough of the real UI against the real API with no console errors.

**Still simulated afterwards:** agent heartbeats — the agent has a working signed client but the control plane has no endpoint for it yet, so device "online" state is not live.

---

## Phase 2 — Spaces and agents

**Outcome:** a Space exists, the home PC's agent enrolls into it, and the dashboard shows it going online and offline for real.

- `POST /agent/enroll` and `POST /agent/heartbeat`, both verifying the agent's Ed25519 request signature
- A signature covering method, path, timestamp, nonce and body digest — already implemented on the agent side
- Short-lived enrollment tokens issued by the desktop app, so the service never needs the owner's password
- Space creation and resource registration
- WebSocket push so online state changes without polling
- Refresh token sealed with DPAPI through the Go side, so a restart no longer signs the user out

**Done when:** killing the agent turns the map node grey within one heartbeat interval, and restarting it turns it green — without a page reload.

---

## Phase 3 — Demo Data Pool

**Outcome:** an owner allocates data to an invited person, who sees their allowance and nothing else.

- The provider adapter interface: `verifyAccount`, `getBalance`, `getPlan`, `createAllocation`, `updateAllocation`, `pauseAllocation`, `revokeAllocation`, `getUsage`, `handleProviderWebhook`
- A **Demo Provider**, labelled as a demo everywhere it appears, seeded with 100 GB and realistic usage events
- Data-Only Pass creation: email or QR, total allocation, daily limit, expiry, no re-sharing
- Claiming a pass with the invitee's own NetLink account
- Member Access: name, device, connection status, usage today, total usage, remaining, daily limit, expiry, Pause, Edit Limit, Revoke, permission list
- Usage tracking by quantity, session time and approved device

**Done when:** an integration test proves a Data-Only member receives 403 from every device, file, printer and power endpoint when calling them by hand — not merely that the UI hides the buttons.

**Explicitly not in scope:** anything that bypasses carrier billing. The Demo Provider is a development fixture and says so.

---

## Phase 4 — Device Power and Wake

**Outcome:** the owner turns on a powered-off Home PC from a trusted remote device, via a Family PC acting as Wake Helper.

The command envelope, its verifier, replay protection and the WoL packet builder are **already complete and tested**. This phase wires them up.

- Wake Helper selection and readiness display: WoL enabled, adapter present, mains power where detectable, helper online, wake-capable link, MAC registered
- Turn On, Restart, Shut Down, Lock, Sleep, Cancel
- Step-up verification for sensitive actions
- A ten-second countdown that can be cancelled
- An audit entry for every request and every result

**Rules that must hold:** restart, shutdown, lock and sleep require the target agent online; wake requires an online helper on the same LAN; invited members get no power permissions by default; no arbitrary execution verb, ever.

**Done when:** the scenario in the brief works on real hardware — Family PC online, Home PC off but on mains, owner presses Turn On, Home PC boots and its agent reports Online.

---

## Phase 5 — Files and printers

**Outcome:** the owner browses an approved folder, transfers a file, and prints a PDF at home.

- Approved-folder registration; nothing outside it is ever visible, and traversal out of a root is rejected explicitly
- Browse, download, upload, create folder, rename
- Resumable transfers with progress, integrity checking and cancellation
- Deletion behind its own permission and a confirmation
- Printer discovery on the home Windows machine
- PDF jobs with preview, copies, colour and paper size; `printers.use` required
- An audit entry per operation

**Done when:** a file transfers correctly with a verified checksum, a resumed transfer completes, and a member without `files.read` is refused by the API.

---

## Phase 6 — Remote desktop

**Outcome:** the owner sees and controls their home computer's screen.

- WebRTC signalling through the control plane
- ICE, STUN and TURN with short-lived credentials
- Direct connection preferred; end-to-end encrypted relay fallback
- Screen stream, optional audio, keyboard and mouse, clipboard
- Ask Every Time / Unattended, View Only / Full Control
- Connecting stages, direct-or-relay, latency, quality, resolution, secure status, disconnect

**Done when:** a direct connection is established where the network allows one, the relay path works where it does not, and View Only genuinely cannot send input.

**Never:** storing the user's Windows password on the server.

---

## Phase 7 — Production hardening

**Outcome:** NetLink is fit to hand to people who are not us.

- Signed installers and secure automatic updates
- Distributed rate limiting and abuse prevention
- Monitoring, alerting and backups
- Passkeys, authenticator apps, biometric unlock
- A full threat-model review
- Preparation for an external security review

**Done when:** an external reviewer has what they need, and the known-limitations table in SECURITY.md is empty or every remaining entry is a deliberate, documented acceptance.
