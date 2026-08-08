# NetLink Security

This describes the security controls **as built**, not as aspired to. Where something is designed but not yet wired up, it says so.

Companion documents: [THREAT_MODEL.md](THREAT_MODEL.md) for what we defend against and what we accept; [ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together.

---

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Include what you found, how to reproduce it, and what you think the impact is. We will confirm receipt, keep you updated, and credit you if you want that.

NetLink has **not** had an external security review. It should not hold data you cannot afford to lose until it has. Phase 7 covers preparing for one.

---

## 1. What NetLink never stores

| Never stored | Stored instead |
|---|---|
| Raw passwords | Argon2id hash (PHC string) |
| Six-digit codes | SHA-256 hash |
| Refresh tokens | SHA-256 hash |
| Invitation claim tokens | SHA-256 hash |
| Device private keys | Nothing — they never leave the device |
| Your Windows password | Nothing. NetLink never asks for it and has no use for it |
| File contents | Nothing. Files move directly between your devices |
| Screen frames and keystrokes | Nothing. A remote desktop session is peer to peer; the server carries a handful of SDP lines and then gets out of the way |
| Print documents | Held only until the agent collects the job, then dropped |
| WebRTC signalling messages | Deleted the moment the session ends — they are the only remote-desktop bytes the server ever holds |
| TURN credentials | Nothing. They are derived per session from a secret and an expiry, never stored |
| Messages, browsing history, precise location | Nothing |

The audit trail actively scrubs metadata: any key containing `password`, `code`, `otp`, `token`, `secret`, `privatekey`, `authorization`, `cookie`, `content` or `body` is dropped rather than written. A careless call site cannot turn the audit log into a credential store. There is an integration test asserting no password, refresh token or Argon2 hash ever reaches an audit row.

---

## 2. Passwords

**Argon2id**, 19 MiB memory, 2 iterations, 1 degree of parallelism, 32-byte output — the OWASP Argon2id baseline.

- Every hash is uniquely salted; the same password never hashes the same way twice.
- Cost parameters are recorded in the stored PHC string, so raising them later still verifies existing hashes. `needsRehash` identifies hashes below current policy, and they are upgraded transparently at the user's next sign-in.
- Verification failures on a malformed stored hash return `false` rather than throwing, so a corrupted row cannot be distinguished from a wrong password by an attacker watching responses.
- Minimum 12 characters, with upper, lower and a digit — enforced by the shared schema on both the client and the server.

---

## 3. Account enumeration

Two paths could reveal which email addresses have NetLink accounts, and both are closed.

**Registration** returns the same challenge-shaped response whether or not the address is already registered. For an address that already has a verified account, a *decoy* challenge is returned: it looks identical, no email is sent to the real owner, and no code can satisfy it.

**Sign-in** returns one generic failure — "That email and password combination did not match" — for an unknown address, a wrong password and a disabled account alike. An unknown address still costs a full Argon2id verification against a fixed dummy hash, so response timing does not distinguish the cases either.

---

## 4. Verification codes

| Control | Value |
|---|---|
| Length | 6 digits, uniformly distributed via `crypto.randomInt` |
| Lifetime | 10 minutes |
| Uses | Exactly one |
| Attempts | 5, then the challenge is burned — the correct code stops working too |
| Resend cooldown | 60 seconds |
| Resends | 3 per challenge |
| Storage | SHA-256 hash only |
| Comparison | Constant-time (`timingSafeEqual`) |

Single use is enforced by a conditional `UPDATE ... WHERE consumedAt IS NULL`, so two concurrent requests carrying the same correct code cannot both succeed — exactly one wins.

Issuing a new challenge for the same purpose supersedes any pending one, and every resend invalidates the previous code. An attacker who observed an earlier email gains nothing by forcing a resend.

Codes for one purpose cannot be used for another: a device-verification code submitted to the email-verification endpoint is refused.

---

## 5. Device identity

Every installation generates **its own Ed25519 key pair** at first run.

- The private key never leaves the machine and is never transmitted, logged or returned by any API. There is an agent test asserting the enrollment request body and every header are free of it, and a desktop test asserting no bound method exposes it.
- On Windows it is sealed with **DPAPI**, `CRYPTPROTECT_LOCAL_MACHINE` scope plus fixed application entropy, so another process on the same machine cannot unprotect it by calling `CryptUnprotectData` with default parameters. Machine scope is required because the service runs as LocalSystem and the window as the signed-in user.
- The key file is written `0600` before DPAPI is even considered.
- The public key is unique across the whole system — it cannot be silently re-registered against a second account.
- A changed public key for a known installation is **refused**. A different key means a different device.
- A private key that does not match the recorded public key is refused at load, so a tampered pair cannot be enrolled.
- On non-Windows platforms the key store reports `file-permissions-only`, and Settings displays that verbatim. NetLink does not claim protection it is not providing.

**There is no shared permanent key.** Compromising one device reveals nothing about any other.

---

## 6. Sessions

| | |
|---|---|
| Access token | JWT, 15 minutes, bound to both user and device |
| Refresh token | Opaque 256-bit, stored as SHA-256 only |
| Trusted device | 30-day refresh lifetime |
| Untrusted device | **1-day** refresh lifetime |

**Rotation and reuse detection.** Refresh tokens rotate on every use. Each login opens a *family*; every rotation stays in it. Presenting a token that is already rotated or revoked means the token leaked — and because we cannot tell whether the legitimate client or the thief is holding it, the whole family is revoked and both must sign in again. Losing a session is a far smaller harm than letting a thief keep one.

The desktop client coalesces concurrent refreshes into one request; two parallel refreshes would each present the same token and the second would be indistinguishable from theft.

**Revocation is immediate.** The access-token guard re-checks the device on every request. A device revoked seconds ago still holds a valid, unexpired JWT — and it is refused anyway. Otherwise "revoke" would mean "revoke within fifteen minutes", which is not what an owner reaching for that button means.

Revoking one device also:

- ends every refresh token belonging to **that device only**;
- clears its trust flag, so re-enrolling requires verification again;
- invalidates any pending verification challenge for it, so a code already sitting in an inbox cannot bring it back;
- **leaves every other device signed in and working.**

---

## 7. Permissions

Deny-by-default and capability-based. Fifteen explicit capabilities, no hierarchy, one evaluation function shared by the API guards and the UI.

The rule that matters most: **access to one resource never implies access to another.** `data.use` grants nothing about files, printers, computers or power.

| Principal | Starts with |
|---|---|
| Owner | Everything, still evaluated through the same path |
| Trusted personal device | `devices.view` only |
| Invited member | Nothing |
| Data-Only member | `data.use`, and only that |

Sensitive capabilities — `devices.control`, `files.delete`, `power.restart`, `power.shutdown`, `members.manage` — additionally require a fresh step-up verification even when already held.

A suspended principal is refused everything. An expired pass grants nothing, and the expiry instant itself counts as expired.

---

## 8. Power commands

*Designed and fully tested in Phase 1; wired up in Phase 4.*

Each command is signed over a canonically-serialised payload built field by field in a fixed order — never by marshalling a struct, because JSON key order is not guaranteed stable and a signature over a shifting representation is not a signature.

Accepted only if **every** check passes:

1. Signed by a trusted key (keyed map, so keys can rotate).
2. Addressed to this device — checked *before* the signature, so a correctly-signed command for another machine is still refused.
3. Action is on the fixed allow-list.
4. Inside its validity window (30 s skew tolerance on issuance).
5. Nonce unseen — and the nonce is consumed **only on success**, so a broken copy sent first cannot pre-emptively block the real command.

**No arbitrary execution verb exists.** A test fails if anything resembling `exec`, `run`, `shell` or `powershell` is ever added to the action list.

Restart and shutdown carry a ten-second countdown anyone at the machine can cancel. Every request and every result produces an audit entry. Invited members receive no power permissions by default.

---

## 9. Files and remote desktop

Both work the same way, and it is the most important thing to understand about NetLink's architecture: **the control plane authorises, records, and gets out of the way.** File bytes, screen frames and keystrokes move directly between the owner's devices. A full compromise of our servers does not yield anyone's files and cannot replay anyone's screen, because none of it is there.

**Files.** Only folders the owner explicitly approved are reachable — there is no "share my whole computer" path. The boundary is one file in the agent, and it carries thirty tests, most of them escape attempts: `..` traversal, absolute paths, drive letters, UNC paths (`\\server\share`), NTFS alternate data streams, embedded NUL bytes, symlinks pointing outside an approved root, and sibling-prefix confusion where `photos` must not match `photos-private`. Deleting needs its own permission *and* an explicit confirmation, and is non-recursive.

**Remote desktop.** Because input travels peer to peer, the server cannot refuse it — it never sees it. So the session mode is fixed when the session is authorised, sealed inside an Ed25519 grant, and enforced by the agent, which is the only party that can decline to move the mouse. A viewer who edits their own copy of the grant to say "control" produces something that fails verification.

`devices.observe` exists as a capability separate from `devices.control` for exactly this reason: without the split, anyone allowed to watch a screen would also be allowed to type on it, and "view only" would be a label rather than a boundary. Taking control additionally requires a fresh six-digit code, for the same reason restarting somebody's machine does.

TURN credentials are minted per session and expire in minutes, so a leaked pair cannot be used as a free proxy. A relayed connection is shown to the person as relayed — it is slower, and their traffic is taking a detour, and they deserve to know rather than just experience it as lag.

---

## 10. Transport and API hardening

- **CORS** is an explicit allow-list, not a wildcard.
- **Helmet** sets the standard security headers.
- **Rate limits**: a global ceiling per address, then sign-in 10/min, registration 5/hour and code verification 10/min per IP, on top of the per-challenge attempt and resend caps. Counters live in PostgreSQL and are shared across instances; production refuses to start on the in-memory store, because per-process counters make the effective limit `limit × replicas`. The global guard runs *ahead* of authentication, so an unauthenticated flood is stopped before it costs a token verification.
- **Per-account protection**: a per-IP limit cannot see a thousand machines each trying one password against one account. After five failures an account cools off, doubling to a fifteen-minute ceiling and decaying after an hour of quiet. The refusal is byte-identical to a wrong password, so it does not confirm the address exists. It is temporary on purpose — a permanent lockout would let anyone who knows an email address lock its owner out.
- **Input validation** uses the shared zod schemas on every write endpoint; unknown fields are stripped rather than reaching a service.
- **Configuration is validated at boot** and the process refuses to start when it is wrong. `EXPOSE_DEV_OTP=true` and a non-SMTP mail transport are rejected outright in production.
- **Authentication is a global guard**; public endpoints opt out explicitly with `@Public()`, so a forgotten decorator leaves an endpoint locked, not open.
- **SMTP certificate validation stays on.** A misconfigured mail server should fail loudly rather than deliver verification codes over an interceptable connection.
- The agent bounds every response read to 1 MiB, so a hostile or broken control plane cannot exhaust its memory.
- **Metrics and request logs carry route templates only** — `/spaces/:spaceId/files`, never the Space id — and no user ids, emails, addresses, bodies, query strings or headers. A metrics endpoint is scraped by monitoring, often unauthenticated inside a network; careless labels turn it into a record of who used what and when. Unmatched paths are bucketed rather than recorded, so nobody can create unlimited metric series by requesting random URLs. `/api/metrics` is off unless `ENABLE_METRICS` is set, and returns 404 when off.

---

## 11. Privacy

NetLink records **what happened, never what was in it**.

Collected: data quantity, session time, approved device, sign-in and permission events, coarse location (city-level at best, derived from IP by an edge proxy — never GPS, and never requested from a device).

Not collected: file contents, message text, passwords, exact browsing history, keystrokes, or screen contents — including during a remote desktop session. Frames and input travel directly between the two machines and never reach the control plane, so a full server compromise cannot replay anybody's screen. What is recorded about a session is who connected, to which computer, in which mode, for how long, and whether the media went direct or through a relay.

The heartbeat contract carries state only — up/down, local address, Wake Helper capability. A test enumerates its fields and fails if one that could carry file names, window titles or user activity is added.

A Data-Only member sees only their allocation, usage, daily limit, expiry and connection status. They cannot see computers, files, printers, other members, owner activity or Space settings — and they cannot reach those APIs by sending requests by hand, which is what the default-deny tests exist to prove.

---

## 12. Known limitations today

Stated plainly, because a security document that only lists strengths is not useful.

| Limitation | Why | Status |
|---|---|---|
| No passkeys, authenticator apps or biometrics | Email is the second factor. Adding another properly means account recovery, device binding and a migration for everyone who already has an account — its own piece of work, not a checkbox | Accepted, documented |
| Refresh token is held in memory only in the desktop app | Persisting it would leave a long-lived credential on disk readable by any process running as that user. Signing in again after a restart is the honest trade until it can be sealed with DPAPI through the Go side | Accepted |
| The control plane's signing key lives in process memory | An HSM is the correct answer and is deployment work rather than code. An attacker with code execution on the API could mint signed commands — though still not read a file or replay a screen, because those never pass through | Named risk; before production |
| The release signing key is protected by custody, not by code | Nothing in software protects a key from whoever holds it. Offline storage and a key id derived from the key are what we have | Operational commitment |
| Installers are unsigned unless you supply a certificate | `build-release.ps1` signs when given a thumbprint and says loudly when it cannot. It never claims a build was signed when it was not | Needs an EV or OV certificate |
| No TURN server is configured by default | STUN is harmless to point at somebody else's server; a relay carries real traffic and should be yours. Without one, remote desktop works only where a direct path exists | Deployment |
| No external security review | The pack for one is THREAT_MODEL.md §7: where to start, the seven claims worth attacking, and what we already know is weak | Not yet commissioned |
| TLS terminates at your reverse proxy | The API binds plain HTTP and expects a TLS-terminating proxy in front. Do not expose it directly | Deployment concern |

---

## 13. Updates

Automatic updates are the most dangerous feature in any product that ships an agent running as a Windows service: a compromised update channel is code execution as SYSTEM on every machine at once, which is worth more than anything else NetLink holds.

So the transport is trusted with nothing. HTTPS, the CDN, DNS and the file on disk are all treated as hostile. The only thing that decides whether a binary runs is an Ed25519 signature over a manifest that names its exact SHA-256, its size and its URL.

Two separate signatures, doing two different jobs:

- **Authenticode**, over each binary. This is what stops SmartScreen warning users and makes the publisher name real in the UAC prompt. It needs a certificate from a public CA.
- **The NetLink release signature**, over the manifest. This is what agents actually check. It is a key that belongs to you and is trusted by nothing except NetLink installations.

Authenticode alone is not enough. An attacker who serves a *genuine, signed, older* release performs a downgrade attack without forging anything — so versions cannot go backwards, manifests expire, plain HTTP is refused, and downloads are length-bounded before they are read.

---

## 14. Backups

`scripts/backup-windows.ps1` dumps, checksums, and then **verifies by restoring into a throwaway database**. An unverified backup is a belief rather than a backup, and the moment you discover the difference is the worst possible moment.

A NetLink backup contains accounts, password hashes, device public keys, membership, permission grants, allocations and the audit trail. It does **not** contain raw passwords, verification codes, device private keys, file contents, screen frames or print documents — none of those are ever stored. A stolen backup is serious: it is everyone's email address and their history. It is not a way into anybody's files or machines.

Keep backups encrypted at rest, and somewhere the API server cannot write to, so ransomware on the server cannot also take the backups.

`scripts/restore-windows.ps1` refuses to run while the API is answering, and makes you type the database name.

---

## 15. Telecom integration boundary

Real shared internet data requires an official telecom, ISP or MVNO integration. NetLink will **not**:

- claim that a VPN creates free internet;
- automate unofficial USSD tricks;
- bypass carrier billing;
- present mock usage as real network usage;
- build anything intended to evade provider charges.

The provider adapter interface (`verifyAccount`, `getBalance`, `getPlan`, `createAllocation`, `updateAllocation`, `pauseAllocation`, `revokeAllocation`, `getUsage`, `handleProviderWebhook`) exists so a legitimate MTN, Airtel, fibre ISP or MVNO adapter drops in later without redesigning the application. The development Demo Provider is labelled as a demo everywhere it appears in the interface.
