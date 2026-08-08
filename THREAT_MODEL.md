# NetLink Threat Model

What we are defending, who we are defending it from, what we have actually built, and what we are knowingly accepting.

Reviewed at the end of every phase. Last reviewed: end of Phase 7.

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
| Live screen content | What is on a computer while someone is watching it |
| The control plane's signing key | It authorises power commands and remote sessions |
| The release signing key | It decides what code runs on every installation |

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
| **Update channel attacker** | Control of DNS, a CDN, or a mirror | Ship code to every machine at once |
| **A member with a modified client** | A valid Pass and the ability to edit their own app | Send input on a view-only session |

## 3. Trust boundaries

```
Internet ──▶ [ TLS proxy ] ──▶ [ Control plane ] ──▶ [ PostgreSQL ]
                                      ▲
                                      │ signed, authenticated
                          [ Agent ]───┘   [ Desktop app ]
                                │               │
                                └───────────────┘
                    direct encrypted path — files, screen, input
```

The line we care about most: **the control plane is trusted with identity and permissions, and is deliberately never trusted with content.** A full server compromise must not yield the owner's files, and must not replay anybody's screen.

Phase 6 sharpened that line into a design constraint rather than a preference. Because remote-desktop input travels peer to peer, the control plane *cannot* police it even if it wanted to — so the enforcement point had to move to the agent, and the mode it enforces had to be sealed in a signature the viewer cannot alter. The boundary is now load-bearing, not aspirational.

---

## 4. Threats, and what is built today

### T1 — Password guessing and credential stuffing
**Built.** Argon2id (19 MiB, t=2, p=1) makes offline cracking expensive. Sign-in is rate-limited to 10/min per IP. Every sign-in from an unrecognised device requires a six-digit email code, so a correct password alone is not enough.
**Also built (Phase 7).** Per-*account* protection, because a per-IP limit cannot see the attack that matters: a thousand machines each trying one password against one account looks like a thousand first attempts from new addresses. After five failures an account cools off, the delay doubling to a fifteen-minute ceiling, decaying after an hour of quiet. The refusal is byte-identical to a wrong password, so it does not confirm the address is real. Counters are shared across instances via PostgreSQL, because per-process counters make the effective limit `limit × replicas`.
**Residual:** the cooling-off period is deliberately temporary. A permanent lockout would let anybody who knows an email address lock its owner out — denial of service by helpful security control is still denial of service. An attacker who paces their guesses below the threshold is not stopped by this; Argon2id and the mandatory device code are what stop them.

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
**Built.** Passwords, codes and tokens are all irreversible hashes; device private keys are not there at all; **file contents are never there**, and neither are screen frames or keystrokes, because all of it moves directly between the owner's devices. Signalling messages — the only remote-desktop bytes the server ever holds — are deleted the moment a session ends. An attacker with the database gets identity metadata and the audit trail; not files, not passwords, not anybody's screen.
**Residual:** an attacker with *code execution* on the control plane could issue signed commands and mint sessions, because the signing key is in that process's memory. Moving it to an HSM is the next step and is not built. What is built is that such an attacker still cannot read a file or replay a screen — those never pass through, so there is nothing to steal.

### T11 — Arbitrary remote code execution through NetLink
**Built by omission.** There is no command surface that runs a program. The power action list is fixed and a test fails if anything resembling `exec`, `run`, `shell` or `powershell` is added. File access is confined to owner-approved folders. This is a permanent product constraint, not a current limitation.

### T12 — Whole-drive exposure
**Built.** Only owner-approved folders appear, and there is no "share my whole computer" path. The boundary is one file — `services/agent/internal/files/vault.go` — carrying thirty tests, most of them escape attempts: `..` traversal, absolute paths, drive letters, UNC paths, NTFS alternate data streams, embedded NUL bytes, symlinks pointing outside an approved root, and sibling-prefix confusion where `photos` must not match `photos-private`. Resolution uses `EvalSymlinks` with a separator-suffixed prefix check.
**Residual:** an attacker who is already running code as the owner does not need NetLink to read the owner's files. The vault defends the *remote* path, which is the one NetLink introduced.

### T14 — Watching a screen without permission, or typing on one you may only watch
**Built (Phase 6), and it is the threat that shaped the design.** Input travels directly between the two machines, so the control plane never sees it and cannot refuse it. The mode is therefore fixed when the session is authorised, sealed inside an Ed25519 grant, and enforced on the agent — the only party that can decline to move the mouse. A viewer who edits their own copy of the grant to say `control` produces something that fails verification. Watching at all needs `devices.observe`, which is a separate capability from `devices.control` precisely so that "view only" is a boundary rather than a label. Taking control additionally needs a fresh six-digit code. Input refused on a view-only session is counted, reported and audited, because with the stock client it should never happen.
**Residual:** somebody who legitimately holds `devices.control` can do anything the signed-in Windows user can. That is what remote control *is*; the mitigations are that it requires an explicit grant, a fresh confirmation code, and leaves an audit record of who connected and for how long.

### T15 — A poisoned update
**Built (Phase 7).** This is the highest-value target in the whole system: a compromised update channel is code execution as SYSTEM on every machine at once, which is worth far more than anything else NetLink holds. So the transport is trusted with nothing. HTTPS, the CDN, DNS and the file on disk are all treated as hostile; the only thing that decides whether a binary runs is an Ed25519 signature over a manifest naming its exact SHA-256, its size and its URL. Versions cannot go backwards, which blocks the replay of a genuine older release whose vulnerability is known — the attack that signing alone does not stop. Manifests expire, so a captured one cannot pin machines at one version forever. Downloads are length-bounded before they are read.
**Residual:** the release private key is the single point of failure. It must live offline, and the key id is derived from the key so a rotation cannot be silently reversed. Custody is an operational commitment, not something code can enforce.

### T16 — Abuse of the relay
**Built (Phase 7).** TURN relays real traffic, so a long-lived credential is a free proxy for anyone who finds it. Credentials are minted per session using coturn's REST convention: the username *is* the expiry and the password is an HMAC of it under a secret only the TURN server and the control plane hold. A leaked pair stops working within minutes and cannot be extended, and no credential is stored anywhere.
**Residual:** within its short life, a leaked credential can relay traffic. The TTL is the mitigation, and it is configurable.

### T17 — Leakage through monitoring
**Built (Phase 7).** A metrics endpoint is scraped by monitoring, often unauthenticated inside a network, and careless labels turn it into a record of who used what and when. Routes are recorded as templates only — `/spaces/:spaceId/files`, never the Space id. No user ids, emails, addresses or Space ids appear anywhere in the metrics, and a test asserts it. Unmatched paths are bucketed rather than recorded verbatim, so nobody can create unlimited metric series, or write into the metrics, by requesting random URLs. Request logs carry a request id and a route template and no body, query string or headers.
**Residual:** request *volume* per route is still visible to anyone who can scrape the endpoint, which reveals activity patterns. That is inherent to having metrics at all; the endpoint is off by default.

### T13 — Privacy overreach by NetLink itself
**Built.** The audit trail scrubs any metadata key that looks like a secret or like content, with a test asserting no password, token or hash reaches an audit row. The heartbeat contract carries state only, with a test that fails if a content-carrying field is added. Location is city-level at best, derived from an edge proxy header, never GPS.

---

## 5. Accepted risks

Recorded because they are real, and because pretending otherwise would make this document decorative.

| Risk | Why accepted | Revisit |
|---|---|---|
| Email as the second factor | Universal, needs no extra hardware, and appropriate for an MVP. A compromised mailbox defeats it | Passkeys, not yet built |
| No hardware-backed keys | DPAPI is the right default on Windows; TPM adds deployment complexity | Not yet built |
| Refresh token not persisted in the desktop app | Persisting it plainly is worse than asking the user to sign in again | Not yet built; would be sealed via DPAPI |
| The control-plane signing key lives in process memory | An HSM is the correct answer and is deployment work rather than code | Before a production launch |
| The release signing key is protected by custody, not by code | Nothing in software can protect a key from whoever holds it. Offline storage and a derived key id are what we have | Operational commitment |
| The Demo Data Pool is not real network data | A real adapter needs a carrier agreement, and everything that shows its numbers says "Demo Provider" | Blocked on a commercial decision |
| No external security review | Not yet commissioned; §8 is the pack for one | Before a production launch |

## 6. Explicitly out of scope

- A compromised operating system, or an attacker with Administrator/LocalSystem on the owner's machine.
- A compromised email provider.
- Physical attacks on hardware (cold boot, disk removal).
- Attacks on the LAN below IP (rogue DHCP, ARP poisoning) beyond what TLS already covers.
- Denial of service against the owner's own internet connection.

## 7. For an external reviewer

The pack a security reviewer needs, so the first week is spent reviewing rather than orienting.

**Start here, in this order.** These five files hold nearly all the security-relevant decisions:

| File | What it decides |
|---|---|
| `packages/contracts/src/permissions.ts` | The whole capability model. One `evaluatePermission`, used by both the API and the UI |
| `apps/api/src/spaces/spaces.service.ts` | `requirePermission` and `requireOwner` — every Space read goes through them |
| `apps/api/src/agents/agent-signature.guard.ts` | How an agent proves who it is, and the replay guard |
| `services/agent/internal/files/vault.go` | The only thing standing between a remote request and the filesystem |
| `services/agent/pkg/remotegrant/grant.go` | Why "view only" is a boundary rather than a label |

**The claims worth attacking.** Each is stated as a falsifiable sentence, with where it is enforced and where it is tested:

1. A Data-Only member cannot reach any computer, file, printer, power or remote endpoint — *`data.service.ts`; `data.integration.spec.ts`, `remote.integration.spec.ts`*
2. A view-only remote session cannot move the pointer or press a key — *`internal/remote/session.go`; `remote_test.go`, `peer_test.go`*
3. Nothing outside an approved folder is reachable — *`internal/files/vault.go`; `vault_test.go`*
4. A revoked device loses HTTP, WebSocket and any live screen immediately — *`devices.service.ts`; `devices.integration.spec.ts`, `remote.integration.spec.ts`*
5. No file content, screen frame or keystroke is ever stored server-side — *architecture; `files.service.ts`, `remote.service.ts`*
6. A power command cannot be replayed, redirected, or presented as a session grant — *`pkg/command`, `pkg/remotegrant`; both test files*
7. An update cannot be downgraded, redirected or substituted — *`pkg/release`; `release_test.go`*

**How to run it:** `scripts/setup-windows.ps1`, then `scripts/dev-windows.ps1`. The full suite is `scripts/test-all.ps1` and needs a real PostgreSQL — the integration tests exercise the real guards against real SQL, because a mocked repository proves nothing about whether a revoked device is actually refused.

**What we already know is weak**, so nobody spends time confirming it: §5 above, in full. The three that matter most are the control-plane signing key living in process memory, email as the only second factor, and the absence of hardware-backed device keys.

**What is out of scope:** §6 above.

---

## 8. Review checklist for each phase

- [ ] Does this phase add a new trust boundary?
- [ ] Does it add a capability, and is that capability deny-by-default?
- [ ] Does it store anything new, and does it need to?
- [ ] Does it add an endpoint that could enumerate accounts or resources?
- [ ] Does it add a way to reach content the control plane should never see?
- [ ] Are the new failure modes tested, not just the happy path?
- [ ] Is the audit record for the new action free of content?
