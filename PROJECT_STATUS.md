# NetLink Project Status

**Last updated:** end of Phase 5
**Current state:** Phases 0 through 5 complete. All checks and builds passing.

This document is the honest record of what NetLink actually does today. Anything not listed as complete is not built, however finished the navigation may look.

---

## Verified gate

Every number below was produced by running the checks, not estimated.

| Check | Result |
|---|---|
| Prettier | Clean |
| gofmt (agent, desktop) | Clean |
| ESLint (API) | Clean |
| `go vet` (agent, desktop) | Clean |
| TypeScript — contracts, ui, api, frontend | Clean |
| Contract tests | **33 passed** |
| API tests (unit + integration, real PostgreSQL) | **219 passed**, 9 suites |
| Go tests (agent) | **118 passed**, 7 packages |
| Frontend tests | **25 passed** |
| **Total automated tests** | **395 passed, 0 failing** |
| Production builds — contracts, API, frontend, agent | All succeed |
| Windows cross-compile — agent, desktop | Both succeed (DPAPI path compiles) |
| End-to-end UI walkthrough (Playwright, real API) | Full flow passes, no console errors |
| Real Go agent against the real API | Enrolls, heartbeats, registers resources, collects and executes signed commands |

Run it yourself: `.\scripts\test-all.ps1`

---

## Phase 0 — Foundation ✅

| | |
|---|---|
| Environment inspection | Node, npm, Go, Wails, WebView2, Docker — all checked by `setup-windows.ps1` with the exact fix command for whatever is missing |
| Monorepo | npm workspaces + two Go modules, as laid out in ARCHITECTURE.md |
| Documentation | README, ARCHITECTURE, SECURITY, THREAT_MODEL, PROJECT_STATUS, docs/ |
| Windows scripts | `setup-windows.ps1`, `dev-windows.ps1`, `test-all.ps1` |
| Design tokens | Full CSS-variable system; deep navy, electric blue, cyan, green/red, with reduced-motion handled at the token level |
| Component system | Button, Card, Input, OtpInput, StatusDot, Badge, Alert, EmptyState, ComingLater |
| Navigation | All ten sections |
| Health checks | `/api/health/live` (liveness) and `/api/health` (readiness — actually queries PostgreSQL) |
| OpenAPI | Served at `/docs` |
| Docker Compose | PostgreSQL 16 + Mailpit, both bound to localhost |

**Two structural deviations from the brief, both explained in ARCHITECTURE.md §2:** the frontend workspace sits at `apps/desktop/frontend` because Wails requires it there, and shared Go packages live in `services/agent/pkg/` because Go forbids cross-module `internal/` imports.

---

## Phase 1 — Authentication and trusted devices ✅

### Registration
- Name, email, password → account created with an **Argon2id** hash (19 MiB, t=2, p=1)
- Six-digit code emailed; stored **only as SHA-256**
- Ten-minute expiry, single use, five attempts, 60-second resend cooldown, three resends
- Registering an already-registered address returns an identical-looking decoy challenge — no email to the real owner, no code that works

### Sign-in and new-device verification
- One generic failure message for wrong password, unknown account and disabled account alike, with a full Argon2id cost paid even for an unknown address so timing does not distinguish them
- Any device not already trusted receives a six-digit code before any session is issued
- The email is shown masked (`c••••••••r@example.com`)
- "Trust This Device" is an explicit choice, applied server-side to the device recorded on the challenge
- An untrusted device gets a **1-day** refresh lifetime instead of 30

### Device identity
- Every installation generates its own **Ed25519 key pair**
- Private key sealed with **Windows DPAPI** (machine scope + application entropy), file mode `0600`; never transmitted, logged or returned
- Only the public key reaches the server, where it is globally unique
- A changed public key for a known installation is refused
- Rename and revoke, both working end to end
- **Revocation is immediate** — a still-valid access token is refused the moment its device is revoked — and leaves every other device signed in

### Sessions
- 15-minute JWT access tokens bound to user *and* device
- Opaque refresh tokens stored hashed, **rotating on every use**
- Reuse of a rotated token revokes the whole family
- The desktop client coalesces concurrent refreshes so a legitimate race is never mistaken for theft

### Audit
- Every security event recorded with outcome, device, IP, coarse location and time
- Metadata actively scrubbed of anything resembling a secret or content
- Visible on the Activity screen, paginated

---

## Phase 2 — Spaces, agents and live status ✅

### Spaces
- A Space is the unit of sharing: it owns computers, a Data Pool, approved folders, printers and members
- Every Space read goes through one `requirePermission` path. A non-member gets **404**, not 403 — the existence of a Space is itself information
- A member denied a permission gets 403 **and an audit row**

### Agent enrollment
- The owner generates a single-use enrollment token in the desktop app
- The agent presents it once, with its own public key, and receives an agent identity
- The token is consumed atomically; a replay is refused

### Signed agent requests
- Every agent request is Ed25519-signed over `netlink.agent.v1\nMETHOD\npath\ntimestamp\nnonce\nbase64url(sha256(body))`
- The raw body is captured before JSON parsing so the signature covers exactly the bytes sent
- Nonces are single-use and consumed **last**, after every other check passes, so a failed request cannot burn a nonce
- A clock skew window bounds replay

### Live status
- Heartbeats every 20 seconds; a computer is **offline after 90 seconds** of silence, computed the same way on both sides from `statusFromHeartbeat`
- A native WebSocket gateway at `/api/live` pushes status, power, data and transfer events
- Sockets are scoped per Space; revoking a device disconnects its sockets immediately
- The client reconnects with exponential backoff and **stops** on a 4401 close (authentication is not retryable)

### Resources
- The agent reports its printers and the folders the owner approved; nothing else is enumerated

---

## Phase 3 — Data Pool, NetLink Passes and Member Access ✅

### Provider adapter
- One interface — `verifyAccount`, `getBalance`, `getPlan`, `createAllocation`, `updateAllocation`, `pauseAllocation`, `revokeAllocation`, `getUsage`, `handleProviderWebhook`
- **Demo Provider** implements it with `isReal = false`, seeded with 100 GB, and every screen that shows its numbers says so on the screen itself
- Byte counts are `Decimal(20,0)`, not integers — a terabyte in bytes exceeds `Number.MAX_SAFE_INTEGER`

### Passes
- The owner sets a total allocation, a daily limit, an expiry and whether re-sharing is allowed
- Usage refresh pauses an allocation the moment either limit is reached
- The daily figure resets by comparing the stored day, not by a timer that a restart would lose

### Data-Only isolation
- A Data-Only Pass is forced server-side to exactly `['data.use']` — the request cannot widen it
- Such a member sees allocated, used, remaining, daily limit, expiry and connection status. Nothing else
- Integration tests send computer, file, printer, power and member requests **directly to the API** as a Data-Only member and assert each one is refused. Hiding a button is not the control; the API is

### Telecom boundary
- No USSD automation, no billing bypass, no claim that a VPN creates free internet, and mock usage is labelled mock everywhere it appears

---

## Phase 4 — Device Power and Wake ✅

### Actions
Turn On, Restart, Shut Down, Lock, Sleep, and Cancel — all six work.

### Readiness, shown before you press anything
Wake-on-LAN enabled, adapter present, power connected where detectable, Wake Helper online, wake-capable link, MAC registered. Each one is reported by the agent, not assumed.

### Safety
- Every command is Ed25519-signed over a pinned envelope. Go's `RFC3339Nano` strips trailing zeros and JavaScript's `toISOString` does not, so the timestamp layout is **pinned on both sides** with a test that spells out the exact expected bytes
- A **10-second countdown** on destructive actions, cancellable throughout
- Single-use nonces and an expiry window; a delivered-but-unacknowledged command legitimately blocks a duplicate
- Commands are withheld until `executeAt`, so a cancelled command is never collected
- A wake command routes to the **Wake Helper** on the same `/24`, not to the sleeping machine
- Step-up verification for destructive actions
- Every issue, collection, result and cancellation is audited
- **Invited members receive no power permissions by default**

### Never built
Arbitrary remote shell execution. A test fails if an action resembling `exec`, `run` or `shell` is added to the action list.

---

## Phase 5 — Files and printers ✅

### Approved folders only
- The owner approves specific folders. Nothing else on the machine is reachable
- The security boundary is `services/agent/internal/files/vault.go`, and it is the most heavily tested file in the project — **30 tests, most of them escape attempts**: `..` traversal, absolute paths, drive letters, UNC paths (`\\server\share`), NTFS alternate data streams (`file:stream`), embedded NUL bytes, symlinks pointing outside, and sibling-prefix confusion (`photos` must not match `photos-private`)
- Resolution uses `EvalSymlinks` and a **separator-suffixed** prefix check, so a prefix match cannot be a partial name match
- A path whose leaf does not exist yet is still checked, by walking up to the nearest existing ancestor — otherwise `mkdir` could not work safely
- Read-only approval is enforced at the vault, not at the UI
- Revoking a folder makes it unreachable immediately

### Transfers
- The control plane authorises a transfer, records that it happened, and hands both ends a ticket
- **The bytes go directly between devices.** The server never holds file contents, which is why a server compromise cannot leak files
- Resumable, with a refused write on offset mismatch rather than a silently corrupted file
- SHA-256 recorded on completion

### Deleting
- Needs the separate `files.delete` permission **and** an explicit `confirmed: true`. The server does not infer intent from the verb
- Non-recursive: a directory delete refuses rather than taking its contents with it

### Printers
- Discovered by the agent via `Get-Printer`; the owner chooses which to share
- **Only PDFs**, checked by magic bytes (`%PDF`), not by file name
- The preview is the browser's own viewer pointed at a local blob URL — the document does not leave the machine until Print is pressed
- Job history records what was printed, where, how many copies. **Never the contents**

---

## What is real and what is simulated

Stated plainly, because this is the question that matters most.

### Real

- Accounts, password hashing, verification codes, sessions, token rotation — all against real PostgreSQL
- Device key pairs — genuinely generated per installation; the DPAPI path compiles and is what runs on Windows
- Device revocation — genuinely immediate, proven by an integration test that revokes a device and asserts its unexpired token is refused
- The audit trail — real rows, real scrubbing
- **Agent enrollment, heartbeats and live status** — a real Go agent enrolls against the real API, heartbeats, and its online state drives the map
- **Wake-on-LAN magic packets** — correctly constructed, unit-tested byte for byte, and genuinely broadcast by the agent
- **Signed power commands** — real Ed25519 signing, real replay protection, really executed on Windows via `ExitWindowsEx` / `SetSuspendState` / `LockWorkStation`
- **File browsing, transfers and deletion** — real filesystem work through the vault, on real approved folders
- **Printer discovery and printing** — real `Get-Printer` enumeration and real jobs
- The permission model — real deny-by-default evaluation, shared by API and UI
- The Spaces map — every node reflects live API state

### Not real yet, and shown as such

- **The Data Pool is a Demo Provider.** The allocation logic, limits, expiry, pausing and isolation are all real and tested; the *network data* is simulated. No carrier is connected. Every screen showing its numbers says "Demo Provider" on it. **A real adapter needs a commercial agreement — see the questions below.**
- **Remote desktop.** Interfaces only. **Phase 6.**
- **Production hardening.** Rate limiting is per-process, installers are unsigned, there is no automatic update channel. **Phase 7.**

### Deliberately absent, permanently

- Any means of bypassing carrier billing, automating USSD tricks, or presenting mock usage as real network usage
- Arbitrary remote command execution — a test fails if an action resembling `exec`, `run` or `shell` is added
- Whole-drive access
- Cloud storage of file contents
- The owner's Windows password on the server

---

## Remaining phases

| Phase | Scope | State |
|---|---|---|
| 6 | WebRTC signalling, direct and relay strategy, screen, input, view-only enforcement | Interfaces defined |
| 7 | Signed installers, auto-update, distributed rate limiting, monitoring, backups, external review | Not started |

---

## Known limitations today

| | Why | Planned |
|---|---|---|
| Rate limiting is per-process in memory | Correct for the single-instance MVP; the interface is what a shared store must satisfy | Phase 7 |
| The desktop app holds its refresh token in memory only | Persisting it plainly would leave a long-lived credential readable by any process running as that user. Signing in again after a restart is the honest trade | Phase 7, sealed via DPAPI |
| No passkeys, authenticator apps or biometrics | Interfaces prepared, not built | Phase 7 |
| Installers are not signed | | Phase 7 |
| No external security review | | Phase 7 |
| Only the Demo Provider exists | A real one needs a carrier agreement, not more code | Blocked on a commercial decision |
| TLS terminates at your reverse proxy | The API binds plain HTTP and expects a proxy in front. Do not expose it directly | Deployment |

---

## Decisions made without asking

Recorded here so they can be overridden deliberately rather than discovered by surprise.

1. **Wails v2.13.0**, the current stable v2 — which requires **Go 1.25**. The setup script checks for it explicitly.
2. **Prisma 6.19.3**, not 7. Prisma 7 changes generator configuration; 6.x is stable and the migration can happen on its own schedule.
3. **`@nestjs/swagger` 11.4.6 with a scoped `js-yaml` override** to 5.2.3. Both advisories on the transitive `js-yaml` are parser denial-of-service issues; the override is scoped so the 3.x/4.x copies used by ESLint and Istanbul keep their APIs. `npm audit` is clean.
4. **`nodemailer` 9.0.5**, which fixes several SMTP injection advisories directly relevant to sending verification codes.
5. **SHA-256, not a slow KDF, for OTPs and refresh tokens.** They are high-entropy, short-lived and attempt-capped, so a slow hash buys nothing and would make every token refresh needlessly expensive.
6. **Email is the second factor for the MVP.** Universal and needs no extra hardware. A compromised mailbox defeats it, which is why passkeys are on the Phase 7 list.
7. **Mailpit in Docker Compose**, so verification codes can be read as real email during development rather than out of a log.
8. **The domain stays visible when masking an email.** The local part is what identifies a person; the domain is what lets the owner recognise which mailbox to open.
9. **Native `ws`, not socket.io.** The client is a single first-party app, so the protocol negotiation and fallbacks socket.io exists to provide are cost without benefit.
10. **Byte counts are `Decimal(20,0)` and cross the wire as strings.** A terabyte in bytes exceeds `Number.MAX_SAFE_INTEGER`; a float would quietly lose the last digits of a usage figure someone is being billed against.
11. **Power command timestamps use a pinned layout on both sides.** Go and JavaScript disagree about trailing zeros in fractional seconds, and a signature does not tolerate disagreement.
12. **A non-member gets 404 from a Space, not 403.** 403 confirms the Space exists.

---

## Questions that need you

Only the ones that genuinely cannot be decided from the code.

1. **Telecom provider.** Which operator or MVNO is the target for the first real Data Pool adapter, and is there a commercial agreement in place? The Demo Provider covers development, but a real adapter needs credentials and an API contract. **This is the one item that cannot be finished in code.**
2. **SMTP provider for production.** Codes must be delivered reliably by a real service. Which one, and who holds the credentials?
3. **TURN infrastructure.** Phase 6 needs a TURN server for the sessions that cannot connect directly. Self-hosted coturn or a managed provider is a cost and operations decision.
4. **Code-signing certificate.** Windows installers need an EV or OV certificate for Phase 7. Purchasing and custody are yours to decide.
5. **Hosting.** Where the control plane runs determines the TLS proxy, backup strategy and how coarse location is derived.

None of these block Phase 6, which is where I would go next.
