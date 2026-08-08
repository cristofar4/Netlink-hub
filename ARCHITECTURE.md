# NetLink Architecture

This describes how NetLink is built and, where a decision could reasonably have gone another way, why it went this way.

---

## 1. The shape of the system

NetLink has three programs and one rule that shapes all of them.

**The rule: the control plane never carries your content.** It holds identity, device trust, permissions, signalling and the audit trail. File bytes, screen frames and print payloads travel directly between your own devices. This is not a performance optimisation — it is the reason a NetLink server compromise cannot leak your files.

| Program | Language | Runs | Job |
|---|---|---|---|
| Control plane | TypeScript / NestJS | Server | Identity, trust, permissions, signalling, audit |
| Desktop app | Go (Wails v2) + React | User's session | The window; the only UI |
| Agent | Go | Windows service | Device identity, heartbeats, Wake-on-LAN, signed power commands, later files/printers/screen |

The desktop app and the agent ship in one installer. **The user experiences one NetLink**, even though two processes exist — the window is what they interact with, and the service is what keeps the machine reachable when the window is closed.

### Why the agent is a separate process

The window runs as the signed-in user and dies when they log out. Waking a machine, answering a power command or serving a file at 3 a.m. cannot depend on somebody being logged in. The service runs as LocalSystem and survives logout, which is the whole point.

This is why the device identity lives in `%ProgramData%\NetLink\agent` and is sealed with **machine-scoped** DPAPI: a user-scoped blob written by the window could not be read by the service.

---

## 2. Repository layout

```
apps/api                    NestJS control plane
apps/desktop                Wails window (Go)
apps/desktop/frontend       React + TypeScript + Vite
services/agent              Go Windows service
services/agent/pkg          Shared with the desktop app: identity, command, wol
services/relay              Optional self-hosted TURN relay — configuration and notes
packages/contracts          Permissions, DTO schemas, transport types
packages/ui                 Design tokens and components
infrastructure              Container and database bootstrap
docs, scripts               Reference material and Windows PowerShell scripts
```

### Two deviations from the layout in the brief, and why

**1. The frontend workspace is `apps/desktop/frontend`, not `apps/desktop`.**

Wails v2 expects the web project in a subdirectory beside `main.go`, and drives it through `frontend:install` / `frontend:build` in `wails.json`. Putting the npm workspace at `apps/desktop` would mean a `package.json` and a `go.mod` in the same directory with Wails looking for the web assets in the wrong place. The deviation is one directory level and it is what makes `wails dev` and `wails build` work at all.

**2. Shared Go packages are in `services/agent/pkg/`, not `internal/`.**

The desktop app and the agent both need device-identity code. They are separate Go modules because they ship as separate binaries with different dependency trees — the window pulls in all of Wails; the service must not. Go scopes `internal/` to a single module, so `apps/desktop` importing `services/agent/internal/identity` is a compile error, not a style question. `pkg/` is importable, and `apps/desktop/go.mod` wires it up with a `replace` directive. `internal/` still holds what genuinely is agent-only: `internal/agent` and `internal/client`.

---

## 3. The control plane

A **modular monolith**, deliberately. One deployable, one database, one transaction boundary. Modules are separated by directory and by their public service classes, not by network hops. Microservices would buy distributed-systems problems for a product that has one database and no independent scaling pressure.

```
src/
  config/        Boot-time environment validation (zod)
  prisma/        Database access
  crypto/        Argon2id passwords, OTP and token generation/hashing
  mail/          SMTP abstraction with console / SMTP / memory transports
  audit/         Append-only security record
  auth/          Registration, verification, sign-in, sessions, guards
  devices/       Device identity, trust, rename, revoke
  health/        Liveness and readiness
```

### Decisions worth explaining

**Configuration is validated at boot and the process refuses to start when it is wrong.** An API that silently boots with a placeholder JWT secret is worse than one that does not boot. `EXPOSE_DEV_OTP=true` and a non-SMTP mail transport are rejected outright in production.

**Authentication is a global guard; public endpoints opt out with `@Public()`.** Forgetting a decorator leaves an endpoint locked rather than open. That is the safe direction for the mistake to fail in.

**The access-token guard re-checks the device on every request.** A valid JWT is not enough. A device revoked thirty seconds ago still holds a cryptographically valid, unexpired access token, and it must stop working the moment it is revoked — otherwise "revoke" means "revoke in up to fifteen minutes", which is not what an owner reaching for that button means.

**Request validation uses the shared zod schemas from `@netlink/contracts`,** the same objects the desktop client validates against. One definition, so the client cannot construct a shape the server does not expect, and the server cannot quietly start accepting something the client never sends.

---

## 4. Identity and sessions

### Passwords

Argon2id, 19 MiB memory, 2 iterations, 1 degree of parallelism — the OWASP Argon2id baseline. Parameters are recorded in the stored PHC string, so raising them later still verifies existing hashes; `needsRehash` finds hashes below current policy and they are upgraded transparently at the user's next sign-in, when a verified plaintext password is briefly in hand.

Login spends the cost of a hash comparison even when the email is unknown, against a fixed dummy hash. Without that, response timing tells an attacker which addresses have accounts.

### Six-digit codes

| Property | How |
|---|---|
| Unguessable | `crypto.randomInt(0, 1_000_000)` — not `Math.random`, and not `randomBytes % 1e6`, which is modulo-biased |
| Not recoverable from the database | Stored as SHA-256 only |
| Ten minutes | `expiresAt`, checked on every submission |
| Single use | `consumedAt` set by a conditional `UPDATE ... WHERE consumedAt IS NULL`, so two concurrent requests with the same correct code cannot both win |
| Attempt-capped | Five attempts, then the challenge is burned — the correct code stops working too |
| Resend-capped | 60-second cooldown, three resends, and each resend invalidates the previous code |

SHA-256 rather than a slow KDF is correct here: unlike a password, a six-digit code is not reused anywhere else, lives ten minutes and is attempt-capped, so a slow hash buys nothing and would make every verification needlessly expensive.

### Device identity

Every installation generates its own **Ed25519 key pair** at first run.

- The private key never leaves the machine. On Windows it is sealed with DPAPI (`CRYPTPROTECT_LOCAL_MACHINE`) plus fixed application entropy, so another process on the same machine cannot unprotect it with default parameters.
- Only the public key is sent to the control plane, where it is unique across the whole system — a key cannot be silently re-registered against a second account.
- A changed public key for a known installation is refused, not accepted. A different key means a different device, and it must enroll as one rather than take over an existing trusted record.
- **There is no shared permanent key.** Compromising one device tells an attacker nothing about any other.
- On non-Windows platforms the key store reports `file-permissions-only` and Settings says so. NetLink does not claim a protection it is not providing.

### Sessions

Access tokens are JWTs, 15 minutes, bound to both the user and the device. Refresh tokens are opaque 256-bit values stored only as SHA-256 hashes.

Refresh tokens **rotate on every use**. Each login starts a *family*; every rotation stays in that family. Presenting a token that is already rotated or revoked means the token leaked — we cannot tell whether the legitimate client or the thief is holding it, so the entire family is revoked and both are forced to sign in again. Losing a session is a much smaller harm than letting a thief keep one.

A device the owner did **not** mark "Trust This Device" gets a one-day refresh lifetime instead of thirty. Signing in on a borrowed computer then expires on its own.

The desktop client coalesces concurrent refreshes into a single request. Without that, two requests expiring together would each present the same refresh token, and the second would look exactly like theft.

---

## 5. Permissions

Deny-by-default, capability-based, and evaluated through one function that both the API guards and the UI call — so a button is never shown for something the server would reject, and the server never trusts the UI.

```ts
evaluatePermission(grant, permission, now) -> { allowed, permission, reason }
```

The rule that matters most: **access to one resource never implies access to another.** Holding `data.use` grants nothing about files, printers, computers or power. This is why the capability list is flat and explicit rather than a role hierarchy — a hierarchy is exactly the structure that makes "well, they're a member, so obviously they can…" feel reasonable.

| Principal | Starts with |
|---|---|
| Owner | Everything, still evaluated through the same path — the role is not a bypass |
| Trusted personal device | `devices.view` only. No power, no file mutation, no remote control until assigned |
| Invited member | Nothing. An invitation with no grants can do nothing |
| Data-Only member | `data.use`, and only that |

Sensitive capabilities (`devices.control`, `files.delete`, `power.restart`, `power.shutdown`, `members.manage`) additionally require a fresh step-up verification even when the principal already holds them.

---

## 6. Power commands

The command envelope and its verifier are built and under test now, because getting this wrong is the most dangerous failure NetLink could have.

Every command is signed over a canonically-serialised payload — built field by field in a fixed order, never by marshalling a struct, because JSON key order is not guaranteed stable and a signature over a shifting representation is not a signature.

The agent accepts a command only if **all** of these hold:

1. It is signed by a key this agent trusts (a map of key id → public key, so keys can rotate).
2. It is addressed to *this* device — checked before the signature, so a perfectly-signed command for another machine is still refused.
3. Its action is on the fixed allow-list.
4. It is inside its validity window, with 30 seconds of clock-skew tolerance on issuance.
5. Its nonce has not been seen. The nonce is consumed **only on success**, so an attacker cannot pre-emptively block a legitimate command by sending a broken copy first.

**There is no arbitrary execution verb.** The action list is `power.wake`, `power.restart`, `power.shutdown`, `power.lock`, `power.sleep`, `power.cancel` — and a test fails if anything resembling `exec`, `run` or `shell` is ever added.

Restart and shutdown carry a ten-second countdown that anyone at the machine can cancel.

### Wake-on-LAN

Waking a powered-off machine is a local-network operation: the cloud cannot reach a computer that is not running. So a wake needs a **Wake Helper** — another computer already online on the same LAN — to send the magic packet (six `0xFF` bytes, then the target MAC sixteen times) as a UDP broadcast. Broadcast rather than unicast, because a powered-off machine has no ARP entry.

Every precondition is checked and displayed before the Turn On button is offered: Wake-on-LAN enabled, adapter present, wake-capable link, MAC registered, Wake Helper online. Mains power is displayed but is deliberately *not* a blocker — many desktops cannot report it, and treating "unknown" as "not ready" would disable the feature on hardware where it works.

---

## 7. The desktop app

Wails v2.13 (stable) + React 19 + TypeScript + Vite.

The Go side exposes a deliberately small surface to JavaScript: `GetDeviceIdentity`, `GetEnvironment`, `ForgetDeviceIdentity`. **There is no method that returns the private key**, and there should never be. Keeping identity behind bound methods rather than letting the frontend read files means the key has exactly one path in and out, in Go.

A browser fallback lets the UI be developed and tested without Wails. It generates a throwaway identity, is clearly labelled, and reports its key protection as `none — browser development only`.

### Design system

All colour, spacing, radius and motion comes from CSS variables in `packages/ui/src/tokens.css`. Components never hard-code a value.

The palette is dark-first because NetLink is a control surface people glance at: a deep navy ground makes cyan connection paths and green online indicators the things the eye lands on. Red is reserved for actions that destroy or remove something — an offline device is muted grey, not red, because offline is absence, not alarm.

**Motion explains state and never costs time.** Durations are 120–320 ms. Ambient loops (connection flow, status pulses) are driven by `--nl-pulse-duration` and `--nl-flow-duration`, which `prefers-reduced-motion` sets to `0s` at the token level — so a component gets the accessible behaviour without knowing the preference exists. Transitions collapse to 1 ms rather than being removed, so state changes still land instantly instead of appearing broken.

### Honesty in the interface

Every visible control works. The two sections that remain placeholders — Automations, and the optional private-network layer — say what they are for and carry a "Coming later" badge. Nothing in NetLink is a button that silently does nothing.

---

## 8. The connection layer

Files, screen frames and input all travel the same way: **the control plane authorises, records, and gets out of the way.**

- **WebRTC** for screen and input. Two data channels, and the asymmetry between them is deliberate: frames are unreliable and unordered, because a late frame paints a stale picture over a newer one; input is reliable and ordered, because a dropped key-up leaves a modifier stuck down on somebody else's machine.
- **ICE / STUN / TURN** for path discovery. TURN credentials are minted per session from a shared secret and an expiry — never a long-lived password handed to a client.
- **Direct** connections preferred; media then never touches our servers at all.
- **Relay fallback** that stays end-to-end encrypted through the relay, so the relay is a dumb pipe. The viewer is told which path it got, because a relay is slower and the person deserves to know rather than just experience it as lag.
- **The mode is enforced on the host, not the server.** Input never reaches the control plane, so it could not police it even in principle. A signed grant carries the mode, and the agent refuses input it was not granted. This is the one place where the architecture's privacy property forced a security design rather than merely permitting one.
- **WireGuard** remains an explicitly separate, later decision, and the interface for it is still just an interface. Handing someone a route onto the whole home network is a categorically larger grant than access to one computer, and bolting it on because the plumbing is nearby is how that decision gets made by accident.

---

## 9. Testing

| Layer | Tool | Covers |
|---|---|---|
| Contracts | Vitest | Default-deny, data-only isolation, pass expiry, email masking, remote session modes, schema validation |
| API unit | Jest | Argon2id parameters and verification, OTP generation and hashing, agent signature verification |
| API integration | Jest + supertest + **real PostgreSQL** | The full auth flow, device revocation, audit, guards, data isolation, power, files, remote sessions, rate limiting |
| Agent | `go test` | Identity, key store, WoL packets, signed commands, replay, request signing, the file vault, the view-only gate, update manifests, and **two real WebRTC peers connecting over loopback** |
| Frontend | Vitest + Testing Library | API client behaviour, refresh coalescing, OTP input |

Integration tests run against a real database and a real Nest application — no mocked repositories. The point of these tests is to prove the guards and the SQL behave, and a mock proves neither.

---

## 10. What is deliberately not here

- **No proprietary NetLink router.** App-only.
- **No arbitrary remote shell.** Not now, not later.
- **No whole-drive exposure.** Only folders the owner approves.
- **No cloud file storage** unless the user explicitly enables a future feature.
- **No carrier-billing workaround.** Real data sharing requires a licensed provider integration; the Demo Provider is labelled as a demo everywhere it appears.
- **No microservices** until there is a problem that microservices solve.
