# NetLink Project Status

**Last updated:** end of Phase 10, the interface rebuild
**Current state:** every phase complete. All checks and builds passing.

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
| TypeScript — contracts, ui, api, frontend, mobile | Clean |
| Contract tests | **54 passed** |
| API tests (unit + integration, real PostgreSQL) | **296 passed**, 12 suites |
| Go tests (agent) | **208 passed**, 10 packages |
| Frontend tests | **40 passed** |
| Mobile tests | **11 passed** |
| **Total automated tests** | **609 passed, 0 failing** |
| Android bundle | Metro bundles the phone app (645 modules) |
| Production builds — contracts, API, frontend, agent | All succeed |
| Windows cross-compile — agent, desktop | Both succeed (DPAPI path compiles) |
| End-to-end UI walkthrough (Playwright, real API) | Full flow passes, no console errors |
| Real Go agent against the real API | Enrols, heartbeats, registers resources, collects and executes signed commands |
| Real WebRTC session, end to end | A real peer connection through the real control plane: frames delivered, view-only input refused and audited |
| Release signing, end to end | A real key generated, a real manifest signed, accepted for an older agent and refused as a downgrade for a newer one |

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

## Phase 6 — Remote desktop ✅

### The problem this phase is shaped around

The pixels and the keystrokes travel **directly between the two machines** over
WebRTC. The control plane never sees either. That is good for privacy — a
compromise of the server cannot replay anyone's screen, because there is nothing
there to replay — and it has one hard consequence:

**The server cannot be the thing that stops a view-only session from typing.**
It never sees the input.

So the mode is fixed when the session is authorised, sealed inside an Ed25519
grant, and enforced by the agent, which is the only party that can refuse to
move the mouse. A viewer who edits their own copy of the grant to say `control`
produces something that fails verification on the host.

### `devices.observe` — a sixteenth permission

Deliberately added, and worth stating plainly since the brief named fifteen.
Watching a screen is now separate from controlling one. Without the split,
"view only" would be a label rather than a boundary: anyone allowed to watch
would also be allowed to type, and there would be nothing for the host to
enforce. Control requires **both** — controlling a machine you cannot see is not
a coherent thing to grant, and it means revoking observe genuinely revokes
control.

### What is enforced, and where

| | Enforced by | Proven by |
|---|---|---|
| May this person start a session at all | Control plane, deny-by-default | Integration tests: observe-only cannot take control; control-without-observe is refused; a non-member gets 404 |
| Which mode the session is in | Ed25519 signature over the grant | `TestChangingTheModeInvalidatesTheSignature`, plus an API test that re-verifies a mode-swapped grant and finds it invalid |
| Whether an input event moves anything | **The agent**, against the verified grant | 30+ Go tests, including one over a real peer connection |
| Confirmation before taking control | Six-digit step-up code, same as a shutdown | Integration tests for missing, wrong and reused codes |

### Connections
- ICE with STUN and TURN. **TURN credentials are minted per session** with coturn's REST convention: the username *is* the expiry, the password is an HMAC of it. A leaked pair stops working in minutes and cannot be extended
- The ticket says **honestly** whether a relay is available, so the UI does not spin on a connection that cannot happen
- Direct versus relayed is read from the candidate pair actually in use and shown to the person, because a relay is slower and their traffic is taking a detour

### Sessions end, reliably
Four separate ways, because "still connected" stops being true in four different
ways: the viewer leaves, the viewer stops saying it is there, the computer goes
offline, or the four-hour ceiling is reached. Plus one more that matters most —
**revoking a device ends its live session**, because cutting HTTP and the
WebSocket while a screen keeps streaming would make revocation a half-measure.

### What is recorded
Who connected, to which computer, in which mode, for how long, and whether it
went direct or relayed. Never a frame, never a keystroke — they never reached
the server. Signalling messages are deleted the moment the session ends; they
are the only remote-desktop bytes the control plane ever holds.

### Honest limitations
- **Frames are JPEG over a data channel, not a VP8 or H.264 video track.** A pure-Go encoder would be slower than JPEG and a cgo one would end the agent's single-binary property. The transport underneath is the same encrypted peer connection either way, so nothing about the security story changes — a video track is an efficiency upgrade, not a correctness one.
- **Ctrl+Alt+Delete cannot be sent, and UAC prompts cannot be reached.** The secure attention sequence is reserved for physically-present users by design. NetLink does not work around that.
- Protected video comes back black. That is DRM working, not NetLink failing.

---

## Phase 7 — Production hardening ✅

### Rate limiting that actually holds

Counters live in PostgreSQL and are shared across every instance, incremented by one `INSERT … ON CONFLICT DO UPDATE` so two instances cannot interleave.

Postgres rather than Redis, deliberately: the database is already a hard dependency, already secured, already backed up, and the only property that matters here is an atomic increment. Redis becomes the right answer when auth traffic is high enough that a write per attempt is a meaningful share of database load — a long way past where this product is, and a one-class swap when it arrives.

**Production refuses to start on the in-memory store**, because with two replicas the effective limit becomes `limit × replicas`, which is not a limit. The readiness endpoint reports which store is in use, so a misconfiguration shows up on a dashboard rather than in an incident.

### Protecting an account, not just an address

A per-IP limit cannot see the attack that matters. A thousand machines each trying one password against one account is a thousand first attempts from new addresses.

So an account cools off after five failures — 30 seconds, doubling to a fifteen-minute ceiling, decaying after an hour of quiet. Three properties, each deliberate:

- **The refusal is byte-identical to a wrong password.** "This account is locked" confirms the address is real and that the guesses are landing.
- **It is temporary.** A permanent lockout would hand anyone who knows an email address the ability to lock its owner out. Denial of service by helpful security control is still denial of service.
- **It decays.** Somebody who mistypes twice today and twice next week is not an attack, and treating them as one is how a control becomes something people work around.

### Monitoring that does not leak

Prometheus metrics and one structured log line per request. What is *not* in them is the point: no user ids, no emails, no addresses, no Space ids, no bodies, no query strings, no headers. Routes appear as **templates** — `/spaces/:spaceId/files`, never the Space id — and a test asserts it. Unmatched paths are bucketed, so nobody can create unlimited metric series by requesting random URLs.

Implemented as **middleware, not an interceptor**. Nest runs guards before interceptors, so an interceptor never sees a request that authentication refused — which is precisely the request worth counting — and never sees a 404 at all. This was caught by a failing test, not by review.

### Backups that have been restored

`backup-windows.ps1` dumps, writes a checksum beside it, and then **verifies by restoring into a throwaway database and counting tables**. An unverified backup is a belief, and the moment you find out otherwise is the worst possible moment. Retention will never delete the last remaining copy, whatever the clock says.

`restore-windows.ps1` checks the file against its checksum, refuses to run while the API is still answering, and makes you type the database name.

### Releases nothing can substitute

Two signatures doing two jobs. **Authenticode** over the binaries, for SmartScreen and the UAC publisher name. A separate **Ed25519 signature over a manifest** naming each artifact's exact SHA-256, size and URL — that is the one agents actually check.

Authenticode alone is not enough: an attacker who serves a *genuine, signed, older* release performs a downgrade attack without forging anything. So versions cannot go backwards, manifests expire, plain HTTP is refused, and downloads are length-bounded before they are read.

`build-release.ps1` **refuses to claim something was signed when it was not**. An unsigned build labelled unsigned is fine; one quietly labelled signed is how a bad build reaches users.

### A threat model with a reviewer's pack

THREAT_MODEL.md now covers T1–T17 and closes with §7: where to start reading, the seven claims worth attacking with the file that enforces each and the test that proves it, how to run the thing, and — most usefully — what we already know is weak, so nobody spends a week confirming it.

---

## Phase 10 — The interface rebuild ✅

Everything the product does was already built. What it looked like had not kept
up: a column of cards where the design called for instruments — a data gauge, a
usage chart, a map of a Space, a session panel that reports how a connection is
actually holding up.

This phase rebuilt the presentation layer of both clients against that design.
It changed how the product *reads*, not what it does — with two exceptions,
noted below, where the interface needed a number the API had never been asked
for.

### Two new endpoints, because a chart cannot invent its data

| | |
|---|---|
| `GET /spaces/:id/data/usage` | Daily usage, one bucket per calendar day (UTC), **empty days included** — a chart that drops quiet days shows a busy fortnight and a quiet month as the same shape. Aggregated in PostgreSQL rather than by pulling every usage row into the process. Someone who manages the pool sees the Space; a member sees their own allocation and no one else's, decided from a grant read once so opening the screen as a member does not write a denial to the audit log on every load |
| `GET /spaces/:id/overview` | Everything the dashboard shows, in one consistent read — computers, shared resources, members, live sessions, the Data Pool if the caller may manage it, and a health score. Previously five parallel requests that could disagree with each other mid-flight |

### Network health is a sum of checks, not a mood

The score on the dashboard is the summed weight of six signals that were
actually evaluated against the database: a computer is reachable (30), nothing
was refused in the last 24 hours (20), a Data Pool is connected (15), more than
a tenth of the allowance is left (15), a Wake Helper is online (10), something
is shared (10). The weights live in `packages/contracts/src/spaces.ts` and a
test fails if they stop summing to 100.

Every signal carries the sentence the owner reads when it fails, so a score of
70 can always be explained rather than merely displayed.

### Numbers that are measured, and numbers that are refused

- **Latency** is a real round trip, timed in the client against the liveness endpoint — what matters is how far the service is from *you*, which the server cannot report. When the ping fails the tile says "No answer" rather than showing the last good figure.
- **"May last N days"** divides what is left by the mean daily usage over the window. With no usage recorded there is no projection: the tile says "Unknown" and the reason underneath it, because a number derived from no measurements is a guess wearing a number's clothes.
- **Session quality** puts a word to the frame round-trip, with the millisecond figure beside it so nobody has to take the label's word for it.

### What the screens became

| Screen | |
|---|---|
| Overview | Four measured tiles, the Space map with a progress ring on the Data Pool node, quick actions, NetLink Assist reporting the failing check by name, recent activity |
| Data Pool | A radial gauge for what is left, four tiles, a daily usage chart with a selectable window, the connected provider account, and per-member meters |
| Network Access | Resource cards for computers, folders and printers; a recent-connections table; and an access-permissions panel listing what each member actually holds |
| Live session | Session chrome with the mode badge, a details panel, a fixed-scale latency sparkline, and quick actions that go where the action lives |
| Power and Wake | The wake pair drawn as helper → target, so "why is Turn On available here" is visible rather than explained |
| Settings | Eight sections behind a sub-nav, each stating what NetLink actually does |
| Phone | Home, Data Pool, Remote and Settings, with a data ring built from rotated half-discs rather than a native SVG dependency |

### Chrome that does something

The top bar's search filters the sections and the active Space's computers,
folders and printers, and navigates to what you pick — the index is built when
the box is first focused rather than on every screen. The bell shows real audit
events with a count of the ones since it was last opened. Both exist because a
search box that filters nothing and a bell that never rings teach people the
chrome is decoration.

### Where a control would have been a promise

Notification switches are drawn and disabled, and say "not built yet" beside
them: the events are all recorded, but nothing delivers them. There is no "edit
profile" button, because no endpoint changes a name or an email. Two-factor is
stated as a fact — new-device verification is always on and cannot be switched
off — rather than drawn as a toggle somebody could believe they had disabled.

### One real bug found on the way

`remote.css` referenced `--nl-accent-cyan` and `--nl-shadow-card`, neither of
which exists in the token file. The view-only session frame — the cue that tells
someone at a glance whether they are watching a screen or driving it — was
falling back to `currentColor`. Fixed to the real tokens.

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
- **Remote desktop** — a real WebRTC peer connection carrying real captured frames, verified end to end against the real control plane with a real Go agent. Screen capture is GDI on Windows; on other platforms it returns a labelled test pattern, because NetLink hosts sessions on Windows
- The permission model — real deny-by-default evaluation, shared by API and UI
- The Spaces map — every node reflects live API state

### Not real yet, and shown as such

- **The Data Pool is a Demo Provider.** The allocation logic, limits, expiry, pausing and isolation are all real and tested; the *network data* is simulated. No carrier is connected. Every screen showing its numbers says "Demo Provider" on it. **A real adapter needs a commercial agreement — see the questions below.**

### Deliberately absent, permanently

- Any means of bypassing carrier billing, automating USSD tricks, or presenting mock usage as real network usage
- Arbitrary remote command execution — a test fails if an action resembling `exec`, `run` or `shell` is added
- Whole-drive access
- Cloud storage of file contents
- The owner's Windows password on the server

---

## What is left

Nothing that is a phase. Three things that are decisions rather than code:

| | Why it is not built | Who decides |
|---|---|---|
| A real telecom adapter | Needs a commercial agreement, not more code. The interface, the isolation and the limits are all built and tested against the Demo Provider | You, with a carrier |
| A code-signing certificate | The build script signs when given a thumbprint. Buying and holding an EV or OV certificate is a purchase and a custody decision | You |
| Passkeys or an authenticator app | Adding a second factor properly means account recovery, device binding and a migration for everyone who already has an account. That is a piece of work, not a checkbox, and email works today | Product call |

---

## Known limitations today

| | Why | Planned |
|---|---|---|
| The desktop app holds its refresh token in memory only | Persisting it plainly would leave a long-lived credential readable by any process running as that user. Signing in again after a restart is the honest trade | Accepted; would be sealed via DPAPI |
| No passkeys, authenticator apps or biometrics | Email is the second factor. See "What is left" above | Product call |
| The control plane's signing key lives in process memory | An HSM is the right answer and is deployment work rather than code | Before production |
| Installers are unsigned unless you supply a certificate | The build script signs when given one and says loudly when it cannot | Needs a certificate |
| Remote desktop has no audio or clipboard | Real features, neither a security control. Left out rather than half-built | Later |
| No external security review | The pack for one is THREAT_MODEL.md §7 | Not yet commissioned |
| Only the Demo Provider exists | A real one needs a carrier agreement, not more code | Blocked on a commercial decision |
| No TURN server is configured by default | STUN is harmless to point at a public server; a relay carries real traffic and should be yours. Without one, remote desktop works only where a direct path exists | Deployment |
| Remote frames are JPEG, not a video track | A pure-Go video encoder would be slower; a cgo one would end the agent's single-binary property | Later, as an efficiency change |
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
13. **`devices.observe` is a sixteenth permission**, added deliberately. Folding screen-watching into `devices.control` would make view-only a label rather than a boundary — see Phase 6 above.
14. **Remote session grants reuse the control plane's existing signing key**, separated from power commands by a domain string at the head of the signing input. A second key would be a second thing to rotate and a second thing to get wrong; a test proves a power command cannot be replayed as a session grant.
15. **Signalling appends are serialised with a row lock on the session.** ICE emits candidates in parallel, so assigning sequence numbers by reading the highest and then inserting loses the race — and retrying does not help when a dozen writers collide. This was found by running a real connection, not by a test.
16. **Rate-limit counters live in PostgreSQL, not Redis.** The database is already a hard dependency, already secured and already backed up; the property that matters is an atomic increment, and one SQL statement provides it. Redis is right when auth traffic makes a write per attempt significant.
17. **Metrics are hand-rolled rather than `prom-client`.** The whole surface needed is a counter, a gauge and a histogram, and a metrics endpoint is scraped from outside the trust boundary. A hundred readable lines beat a dependency whose defaults have to be configured *away* from exporting the process environment.
18. **Request observability is middleware, not an interceptor.** Guards run first, so an interceptor cannot see the requests authentication refused — the ones most worth counting.
19. **Account lockouts are temporary and decay.** A permanent one is a denial-of-service primitive handed to anyone who knows an email address.

---

## Questions that need you

Only the ones that genuinely cannot be decided from the code.

1. **Telecom provider.** Which operator or MVNO is the target for the first real Data Pool adapter, and is there a commercial agreement in place? The Demo Provider covers development, but a real adapter needs credentials and an API contract. **This is the one item that cannot be finished in code.**
2. **SMTP provider for production.** Codes must be delivered reliably by a real service. Which one, and who holds the credentials?
3. **TURN infrastructure.** Remote desktop needs a TURN server for the sessions that cannot connect directly — which is most of them behind mobile or carrier-grade NAT. Self-hosted coturn or a managed provider is a cost and operations decision; the code is ready for either.
4. **Code-signing certificate.** Windows installers need an EV or OV certificate. `build-release.ps1` uses one when given a thumbprint and refuses to pretend when not. Purchasing and custody are yours.
5. **Custody of the release signing key.** It decides what code runs on every installation. Nothing in software can protect a key from whoever holds it — offline storage is an operational commitment you have to make.
6. **Hosting.** Where the control plane runs determines the TLS proxy, backup strategy and how coarse location is derived.

None of these block anything that can be built. They are the things only you can answer.
