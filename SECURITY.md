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

## 9. Transport and API hardening

- **CORS** is an explicit allow-list, not a wildcard.
- **Helmet** sets the standard security headers.
- **Rate limits**: sign-in 10/min per IP, registration 5/hour per IP, code verification 10/min per IP, on top of the per-challenge attempt and resend caps.
- **Input validation** uses the shared zod schemas on every write endpoint; unknown fields are stripped rather than reaching a service.
- **Configuration is validated at boot** and the process refuses to start when it is wrong. `EXPOSE_DEV_OTP=true` and a non-SMTP mail transport are rejected outright in production.
- **Authentication is a global guard**; public endpoints opt out explicitly with `@Public()`, so a forgotten decorator leaves an endpoint locked, not open.
- **SMTP certificate validation stays on.** A misconfigured mail server should fail loudly rather than deliver verification codes over an interceptable connection.
- The agent bounds every response read to 1 MiB, so a hostile or broken control plane cannot exhaust its memory.

---

## 10. Privacy

NetLink records **what happened, never what was in it**.

Collected: data quantity, session time, approved device, sign-in and permission events, coarse location (city-level at best, derived from IP by an edge proxy — never GPS, and never requested from a device).

Not collected: file contents, message text, passwords, exact browsing history, keystrokes, screen contents outside an active session the user started.

The heartbeat contract carries state only — up/down, local address, Wake Helper capability. A test enumerates its fields and fails if one that could carry file names, window titles or user activity is added.

A Data-Only member sees only their allocation, usage, daily limit, expiry and connection status. They cannot see computers, files, printers, other members, owner activity or Space settings — and they cannot reach those APIs by sending requests by hand, which is what the default-deny tests exist to prove.

---

## 11. Known limitations today

Stated plainly, because a security document that only lists strengths is not useful.

| Limitation | Why | Planned |
|---|---|---|
| Rate limiting is per-process in memory | Enough for the single-instance MVP; the interface is what a shared store must satisfy | Phase 7 — Redis-backed |
| Refresh token is held in memory only in the desktop app | Persisting it would leave a long-lived credential on disk readable by any process running as that user. Signing in again after a restart is the honest trade until it can be sealed with DPAPI through the Go side | Phase 2 |
| No passkeys, authenticator apps or biometrics | Interfaces are prepared; not built | Phase 7 |
| Installers are not signed | | Phase 7 |
| No external security review | | Phase 7 |
| TLS terminates at your reverse proxy | The API binds plain HTTP and expects a TLS-terminating proxy in front. Do not expose it directly | Deployment concern |

---

## 12. Telecom integration boundary

Real shared internet data requires an official telecom, ISP or MVNO integration. NetLink will **not**:

- claim that a VPN creates free internet;
- automate unofficial USSD tricks;
- bypass carrier billing;
- present mock usage as real network usage;
- build anything intended to evade provider charges.

The provider adapter interface (`verifyAccount`, `getBalance`, `getPlan`, `createAllocation`, `updateAllocation`, `pauseAllocation`, `revokeAllocation`, `getUsage`, `handleProviderWebhook`) exists so a legitimate MTN, Airtel, fibre ISP or MVNO adapter drops in later without redesigning the application. The development Demo Provider is labelled as a demo everywhere it appears in the interface.
