# NetLink Project Status

**Last updated:** end of Phase 1
**Current state:** Phase 0 and Phase 1 complete. All checks and builds passing.

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
| API tests (unit + integration, real PostgreSQL) | **86 passed** |
| Go tests (agent) | **6 packages passed** |
| Frontend tests | **25 passed** |
| **Total automated tests** | **144 passed, 0 failing** |
| Production builds — contracts, API, frontend, agent | All succeed |
| Windows cross-compile — agent, desktop | Both succeed (DPAPI path compiles) |
| End-to-end UI walkthrough (Playwright, real API) | Full flow passes, no console errors |

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
| Navigation | All eight sections, plus three detail sections opened from the Spaces map |
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

### Screens that work today
Welcome, Register, Verify email, Sign in, Verify new device, My Spaces dashboard (live map), Trusted devices (list/rename/revoke), Activity, Settings.

Every button on these screens works. Controls belonging to later phases carry a "Coming later" badge and are disabled.

---

## What is real and what is simulated

Stated plainly, because this is the question that matters most.

### Real

- Accounts, password hashing, verification codes, sessions, token rotation — all against real PostgreSQL
- Device key pairs — genuinely generated per installation; the DPAPI path compiles and is what runs on Windows
- Device revocation — genuinely immediate, proven by an integration test that revokes a device and asserts its unexpired token is refused
- The audit trail — real rows, real scrubbing
- Wake-on-LAN magic packets — correctly constructed and unit-tested byte for byte
- Signed power commands — real Ed25519 signing, real replay protection, fully tested
- The permission model — real deny-by-default evaluation, shared by API and UI
- The Spaces map — device counts and trust state come from the live API

### Not real yet, and shown as such

- **Agent heartbeats.** The agent generates its identity and has a working signed client, but the control plane has no `/agent/enroll` or `/agent/heartbeat` endpoint yet, so "online" state is not live. **Phase 2.**
- **The Data Pool.** No provider adapter is implemented. No data is allocated, tracked or shared. **Phase 3.**
- **Power and Wake.** The command envelope, verifier and WoL packet builder are complete and tested; nothing sends or executes one. **Phase 4.**
- **Files and printers.** No folder is exposed, no printer discovered. **Phase 5.**
- **Remote desktop.** Interfaces only. **Phase 6.**
- **Everything on the map with a phase badge.** Data Pool, Approved files, Printers, People and Power and Wake all render their "not set up yet" state.

### Deliberately absent, permanently

- Any means of bypassing carrier billing, automating USSD tricks, or presenting mock usage as real network usage
- Arbitrary remote command execution — a test fails if an action resembling `exec`, `run` or `shell` is added
- Whole-drive access
- Cloud storage of file contents

---

## Remaining phases

| Phase | Scope | State |
|---|---|---|
| 2 | Spaces, agent enrollment, heartbeats, live online state, resource registration | Schema and agent client ready; endpoints not built |
| 3 | Provider adapter, Demo Provider, allocations, Data-Only Passes, Member Access | Schema and permission model ready |
| 4 | Wake Helper, readiness checks, Turn On / Restart / Shut Down / Lock / Sleep | Command envelope, verifier and WoL builder complete and tested |
| 5 | Approved folders, secure transfers, printer discovery, PDF jobs | Not started |
| 6 | WebRTC signalling, direct and relay strategy, screen, input, view-only | Interfaces defined |
| 7 | Signed installers, auto-update, distributed rate limiting, monitoring, backups, external review | Not started |

---

## Known limitations today

| | Why | Planned |
|---|---|---|
| Rate limiting is per-process in memory | Correct for the single-instance MVP; the interface is what a shared store must satisfy | Phase 7 |
| The desktop app holds its refresh token in memory only | Persisting it plainly would leave a long-lived credential readable by any process running as that user. Signing in again after a restart is the honest trade | Phase 2, sealed via DPAPI |
| No passkeys, authenticator apps or biometrics | Interfaces prepared, not built | Phase 7 |
| Installers are not signed | | Phase 7 |
| No external security review | | Phase 7 |
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

---

## Questions that need you

Only the ones that genuinely cannot be decided from the code.

1. **Telecom provider.** Which operator or MVNO is the target for the first real Data Pool adapter, and is there a commercial agreement in place? The Demo Provider covers development, but a real adapter needs credentials and an API contract.
2. **SMTP provider for production.** Codes must be delivered reliably by a real service. Which one, and who holds the credentials?
3. **Code-signing certificate.** Windows installers need an EV or OV certificate for Phase 7. Purchasing and custody are yours to decide.
4. **Hosting.** Where the control plane runs determines the TLS proxy, backup strategy and how coarse location is derived.

None of these block Phase 2, which is where I would go next.
