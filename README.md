# NetLink

Secure remote access to your own home or office computers — the files you choose, the printer in the next room, the internet data you decide to share.

NetLink is an **app-only** product. There is no NetLink router and no proprietary hardware. You install NetLink on your computers; one of them stays online as the home agent and Wake Helper, and you reach approved resources from another device signed in to the same verified NetLink account. People you invite use **their own** NetLink account and receive a restricted NetLink Pass — you never share your password.

**Runs on Windows, macOS and Android.** A Windows PC or a Mac can be either end of a connection — the computer you reach from, or the computer you reach. An Android phone is a client: it reaches your computers, and is never itself a host. See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md), [docs/MACOS_SETUP.md](docs/MACOS_SETUP.md) and [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Status

**All seven phases are complete and tested.** See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what is real today and what is not — including the one thing that is deliberately simulated.

| | |
|---|---|
| Working now | Accounts and trusted devices; Spaces with live agent status; Device Power and Wake; approved folders, transfers and PDF printing; remote desktop with real WebRTC; NetLink Passes and Member Access; the audit trail |
| Real but simulated | The **Data Pool**. The allocation logic, limits, expiry, pausing and isolation are all real and tested — the *network data* comes from a Demo Provider, and every screen showing its numbers says so. A real adapter needs a carrier agreement, not more code |
| Not built | Passkeys and authenticator apps (email is the second factor); remote-desktop audio and clipboard; an HSM for the signing key. Each is named in [SECURITY.md §12](SECURITY.md) rather than quietly omitted |
| Deliberately absent, permanently | Any means of bypassing carrier billing, arbitrary remote command execution, whole-drive access, cloud storage of file contents |

---

## Quick start

### Windows

```powershell
git clone https://github.com/cristofar4/Netlink-hub.git
cd Netlink-hub

# Checks prerequisites, installs everything, writes .env, starts PostgreSQL,
# applies migrations. Safe to re-run.
.\scripts\setup-windows.ps1

# Starts PostgreSQL, the API and the NetLink window with hot reload.
.\scripts\dev-windows.ps1
```

### macOS

```bash
git clone https://github.com/cristofar4/Netlink-hub.git
cd Netlink-hub

./scripts/setup-macos.sh
./scripts/dev-macos.sh
```

### On your phone

An Android build needs the control plane reachable at an HTTPS address first.
[docs/DEPLOY.md](docs/DEPLOY.md) is the four-step path from this repository to an
APK you install on your own phone.

---

The NetLink window opens on the welcome screen. Create an account, and the six-digit code appears in the API console output (and in the response, because `EXPOSE_DEV_OTP=true` in development). Then sign in — the same code flow verifies this device, and you land on My Spaces.

Run the full gate before you commit — `test-all.ps1` on Windows, `test-all.sh` on macOS and Linux:

```powershell
.\scripts\test-all.ps1
```

### Prerequisites

| | Minimum | Why |
|---|---|---|
| Windows | 10 (1809) or 11 | DPAPI, Wake-on-LAN, the Windows service |
| Node.js | 20.11 LTS | API and frontend |
| Go | **1.25** | Wails v2.13 requires it |
| WebView2 runtime | Evergreen | The window will not render without it |
| Docker Desktop | any current | PostgreSQL for development (optional — use your own PostgreSQL with `-SkipDatabase`) |
| Wails CLI | v2.13.0 | Installed for you by the setup script |

`setup-windows.ps1` checks every one of these and tells you the exact command to fix whatever is missing.

---

## What you get when it is running

| | |
|---|---|
| NetLink window | The desktop app |
| `http://127.0.0.1:4000/api` | Control plane |
| `http://127.0.0.1:4000/docs` | OpenAPI documentation |
| `http://localhost:8025` | Mailpit — see the verification emails as real email |

To use Mailpit instead of the console, set `MAIL_TRANSPORT=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025` in `.env`.

---

## Repository layout

```
apps/
  api/                NestJS control plane (modular monolith) + Prisma
  desktop/            Wails v2 window
    frontend/         React + TypeScript + Vite
services/
  agent/              Go Windows service: device identity, heartbeats, WoL, signed commands
    pkg/              Packages shared with the desktop app (identity, command, wol)
  relay/              Optional self-hosted relay (coturn config and notes)
packages/
  contracts/          Permissions, DTO schemas and transport types shared by API and UI
  ui/                 Design tokens and the reusable component system
infrastructure/       Container and database bootstrap
docs/                 Reference material
scripts/              Windows PowerShell scripts
```

Two structural decisions worth knowing about, both documented in [ARCHITECTURE.md](ARCHITECTURE.md):

- **The frontend is an npm workspace at `apps/desktop/frontend`,** not `apps/desktop`, because Wails expects the web project in a subdirectory beside `main.go`.
- **Shared Go code lives in `services/agent/pkg/`,** not `internal/`, because the desktop app is a separate Go module and Go forbids cross-module `internal` imports.

---

## How the pieces fit

```
   Your other device                  The cloud                     Your home
  ┌──────────────────┐          ┌─────────────────────┐        ┌──────────────────┐
  │  NetLink window  │◀────────▶│   Control plane     │◀──────▶│  NetLink agent   │
  │  (Wails + React) │  HTTPS   │  identity, trust,   │ signed │  Windows service │
  │                  │          │  permissions,       │        │                  │
  │                  │          │  signalling, audit  │        │  device key      │
  └────────┬─────────┘          └─────────────────────┘        └────────┬─────────┘
           │                                                            │
           └────────────────────────────────────────────────────────────┘
                  Direct encrypted path for files, screen and input
                       — never through the control plane
```

The control plane holds identity, trust, permissions and the audit trail. It deliberately never carries file contents, screen frames or print payloads — those go directly between your own devices.

---

## Security summary

Full detail in [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md). The short version:

- Passwords are hashed with **Argon2id** (19 MiB, t=2, p=1) and never stored in any other form.
- Six-digit codes are stored **only as SHA-256 hashes**, expire in ten minutes, work exactly once, and are capped by attempt count and resend count.
- Every installation generates **its own Ed25519 key pair**. The private half never leaves the machine — on Windows it is sealed with DPAPI. Only the public half reaches the server. There is no shared key.
- Access tokens live 15 minutes; refresh tokens **rotate on every use**, and presenting a rotated one is treated as theft and revokes that whole session lineage.
- Permissions are **deny-by-default and capability-based**. Holding `data.use` never implies `files.read`. A Data-Only member can see their allowance and nothing else.
- Revoking one device ends that device's sessions **immediately** — including its still-valid access token — and leaves every other device working.
- The audit trail records what happened, never what was in it: no file contents, no messages, no passwords, no browsing history.
- Power commands are signed, addressed to one device, time-bounded and single-use. There is **no arbitrary remote execution verb**, by design.
- Only folders you approve are reachable. The agent's path check carries thirty tests, most of them escape attempts — traversal, UNC paths, alternate data streams, symlinks, and names that merely *look* like an approved folder.
- **View-only remote desktop genuinely cannot type.** Input goes peer to peer, so the server could not police it — the mode is sealed in a signed grant and enforced by the computer being watched, which is the only party that can refuse to move the mouse.
- Updates are refused unless a key you hold signed a manifest naming the binary's exact hash — and refused again if the version goes backwards, which is what stops a genuine older release being replayed against you.

### On shared internet data

Real data sharing needs a licensed telecom, ISP or MVNO integration. NetLink ships a provider adapter interface and a clearly-labelled **Demo Provider** for development. It does **not** claim a VPN creates free internet, automate USSD tricks, bypass carrier billing, or present mock usage as real network usage. A real MTN, Airtel, fibre ISP or MVNO adapter drops into the same interface without redesigning anything.

---

## Development

```powershell
.\scripts\dev-windows.ps1 -ApiOnly     # backend only
.\scripts\dev-windows.ps1 -Agent       # also run the agent in the foreground
.\scripts\test-all.ps1 -SkipBuilds     # faster loop; run the full gate before committing
.\scripts\test-all.ps1 -FixFormatting  # apply Prettier and gofmt
```

The agent has a small CLI:

```powershell
cd services\agent
go run .\cmd\netlink-agent status      # this installation's identity and how the key is protected
go run .\cmd\netlink-agent run -v      # foreground, verbose
go run .\cmd\netlink-agent reset       # forget this device identity
.\bin\netlink-agent.exe install        # register the Windows service (needs Administrator)
```

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system is put together and why |
| [SECURITY.md](SECURITY.md) | Security controls as built, and how to report a vulnerability |
| [THREAT_MODEL.md](THREAT_MODEL.md) | What we defend against, what we accept, and what is out of scope |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Phase-by-phase state: what is real, what is simulated |
| [docs/](docs/) | Windows setup detail and the phase plan |
