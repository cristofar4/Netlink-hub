# NetLink Threat Model

What we are defending, who we are defending it from, what we have actually built, and what we are knowingly accepting.

Reviewed at the end of every phase. Last reviewed: end of Phase 1.

---

## 1. What we are protecting

| Asset | Why it matters |
|---|---|
| The owner's computers | Remote power and, later, remote control |
| Approved folders | The owner's private files |
| Printers | Physical output in the owner's home |
| Shared internet data | Real money |
| Account credentials | The key to all of the above |
| Device private keys | Proof a machine is who it says it is |
| The audit trail | The record of what happened |

## 2. Who we are defending against

| | Capability | Motivation |
|---|---|---|
| **Remote attacker** | Internet access to our endpoints | Account takeover, free data, access to files |
| **Credential stuffer** | Breached passwords from elsewhere | Bulk account takeover |
| **Malicious invitee** | A legitimate NetLink account and a valid Pass | Reach more than they were granted |
| **Network attacker** | Observes or modifies traffic on a shared LAN or Wi-Fi | Replay a command, steal a session |
| **Opportunist with the device** | Physical access to an unlocked or stolen machine | Use an existing session |
| **Malicious local process** | Runs as the same Windows user | Steal the device key or session |
| **Curious insider** | Access to our servers or database | Read user files or passwords |

## 3. Trust boundaries

```
Internet ──▶ [ TLS proxy ] ──▶ [ Control plane ] ──▶ [ PostgreSQL ]
                                      ▲
                                      │ signed, authenticated
                          [ Agent ]───┘   [ Desktop app ]
                                │               │
                                └───────────────┘
                        direct encrypted path (Phases 5–6)
```

The line we care about most: **the control plane is trusted with identity and permissions, and is deliberately never trusted with content.** A full server compromise must not yield the owner's files.

---

## 4. Threats, and what is built today

### T1 — Password guessing and credential stuffing
**Built.** Argon2id (19 MiB, t=2, p=1) makes offline cracking expensive. Sign-in is rate-limited to 10/min per IP. Every sign-in from an unrecognised device requires a six-digit email code, so a correct password alone is not enough.
**Residual:** a shared-IP rate limit can be diluted by a distributed attacker. Per-account limits and adaptive throttling are Phase 7.

### T2 — Account enumeration
**Built.** Registration returns an identical challenge-shaped response for a taken address, sends no email to the real owner, and issues a decoy challenge no code can satisfy. Sign-in returns one generic failure for all causes, and an unknown address still costs a full Argon2id verification so timing does not distinguish it.

### T3 — Intercepted or brute-forced verification codes
**Built.** Ten-minute lifetime, single use enforced by a conditional update, five attempts then the challenge burns, 60-second resend cooldown, three resends per challenge, each resend invalidating the previous code, stored as SHA-256, compared in constant time, and unusable across purposes.
**Residual:** a compromised mailbox defeats email-based verification entirely. That is the known limit of the factor, and why passkeys are on the Phase 7 list.

### T4 — Session theft
**Built.** 15-minute access tokens. Refresh tokens rotate on every use and are stored hashed; presenting a rotated one revokes the entire family. The desktop client coalesces concurrent refreshes so a legitimate race is never mistaken for theft. An untrusted device gets a 1-day refresh lifetime instead of 30.
**Residual:** an attacker who steals a *fresh* refresh token and uses it before the legitimate client does will succeed until the legitimate client's next refresh reveals the reuse. This is inherent to bearer tokens; the window is bounded and the detection is what closes it.

### T5 — Stolen or lost device
**Built.** Revocation is immediate — the guard re-checks the device on every request, so a still-valid access token is refused the moment its device is revoked. Revocation ends that device's sessions, clears its trust, invalidates its pending challenges, and leaves every other device working. A revoked installation cannot re-enroll with the same identity.
**Residual:** a machine stolen while unlocked and signed in has an active session until the owner revokes it. Nothing short of continuous re-authentication changes that; the mitigation is that revoking is one click and instant.

### T6 — Device key theft by a local process
**Built.** DPAPI, machine-scoped, with fixed application entropy so a process calling `CryptUnprotectData` with default parameters fails. The file is `0600`. The key never appears in any request body, header, log or API response.
**Residual:** a process running as **LocalSystem or Administrator** can defeat DPAPI. On Windows, an attacker at that privilege level owns the machine outright, and no user-space design changes that. Hardware-backed keys (TPM) would raise the bar and are a candidate for Phase 7.

### T7 — A member reaching beyond their Pass
**Built.** Deny-by-default capabilities, one shared evaluation function, no role hierarchy that could imply anything. A Data-Only member holds exactly `data.use`. Contract tests assert that every other capability is refused, and integration tests assert the API refuses hand-crafted requests to device, file, printer and power endpoints — not just that the UI hides the buttons.
**Residual:** an owner can still grant more than they meant to. The Pass creation flow shows exactly what is being granted before it is sent.

### T8 — Replayed or forged power commands
**Built (tested; wired in Phase 4).** Ed25519 signature over a canonical, fixed-order serialisation. Device-addressed and checked before signature verification. Fixed action allow-list. Time-bounded with 30 s skew. Single-use nonce consumed only on success, so a broken copy cannot pre-emptively block the real command. Restart and shutdown carry a cancellable ten-second countdown. Every request and result is audited.
**Residual:** the agent's nonce store is in memory and is forgotten on restart. The short command expiry covers that window — the two protections deliberately overlap.

### T9 — Wake-on-LAN abuse
**Accepted, and bounded.** A magic packet is unauthenticated by design; anyone on the LAN can send one. NetLink does not make this worse: it only ever *wakes* a machine, which is the least harmful power state change, and every wake request is authenticated, authorised and audited before the Wake Helper is asked. The MAC address is registered by the owner rather than discovered.

### T10 — Server or database compromise
**Partly built.** Passwords, codes and tokens are all irreversible hashes; device private keys are not there at all; **file contents are never there**, because content moves directly between the owner's devices. An attacker with the database gets identity metadata and the audit trail, not files and not passwords.
**Residual:** an attacker with *code execution* on the control plane could issue signed commands and mint sessions. Phase 7 covers key custody, monitoring and backups.

### T11 — Arbitrary remote code execution through NetLink
**Built by omission.** There is no command surface that runs a program. The power action list is fixed and a test fails if anything resembling `exec`, `run`, `shell` or `powershell` is added. File access is confined to owner-approved folders. This is a permanent product constraint, not a current limitation.

### T12 — Whole-drive exposure
**By design.** Only owner-approved folders appear. There is no "share my whole computer" path, and path traversal out of an approved root will be rejected explicitly when file access is built in Phase 5.

### T13 — Privacy overreach by NetLink itself
**Built.** The audit trail scrubs any metadata key that looks like a secret or like content, with a test asserting no password, token or hash reaches an audit row. The heartbeat contract carries state only, with a test that fails if a content-carrying field is added. Location is city-level at best, derived from an edge proxy header, never GPS.

---

## 5. Accepted risks

Recorded because they are real, and because pretending otherwise would make this document decorative.

| Risk | Why accepted | Revisit |
|---|---|---|
| Email as the second factor | Universal, needs no extra hardware, and appropriate for an MVP. A compromised mailbox defeats it | Phase 7 — passkeys, authenticator apps |
| In-memory rate limiting | Correct for a single instance; the interface is what a shared store must satisfy | Phase 7 |
| No hardware-backed keys | DPAPI is the right default on Windows; TPM adds deployment complexity | Phase 7 |
| Refresh token not persisted in the desktop app | Persisting it plainly is worse than asking the user to sign in again | Phase 2, sealed via DPAPI |
| Unsigned installers | Pre-release | Phase 7 |
| No external security review | Pre-release | Phase 7 |

## 6. Explicitly out of scope

- A compromised operating system, or an attacker with Administrator/LocalSystem on the owner's machine.
- A compromised email provider.
- Physical attacks on hardware (cold boot, disk removal).
- Attacks on the LAN below IP (rogue DHCP, ARP poisoning) beyond what TLS already covers.
- Denial of service against the owner's own internet connection.

## 7. Review checklist for each phase

- [ ] Does this phase add a new trust boundary?
- [ ] Does it add a capability, and is that capability deny-by-default?
- [ ] Does it store anything new, and does it need to?
- [ ] Does it add an endpoint that could enumerate accounts or resources?
- [ ] Does it add a way to reach content the control plane should never see?
- [ ] Are the new failure modes tested, not just the happy path?
- [ ] Is the audit record for the new action free of content?
