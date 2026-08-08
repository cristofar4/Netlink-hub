# Running NetLink on macOS

A Mac can be either end of a NetLink connection — the computer you reach *from*,
and the computer you reach. This covers both, and is honest about the two places
macOS behaves differently from Windows.

---

## 1. Prerequisites

| | Minimum | Install |
|---|---|---|
| macOS | 12 Monterey | |
| Node.js | 20.11 LTS | `brew install node` |
| Go | **1.25** — Wails v2.13 needs it | `brew install go` |
| Docker Desktop | any current | `brew install --cask docker` |
| Xcode command line tools | any | `xcode-select --install` |

The Xcode tools are **optional for the agent and required for full remote
control** — see §5. Everything else works without them.

```bash
./scripts/setup-macos.sh
./scripts/dev-macos.sh
```

`setup-macos.sh` checks each prerequisite and tells you the exact command to fix
whatever is missing, rather than failing later inside a dependency.

---

## 2. A Mac as the computer you reach from

Nothing special. The desktop app is Wails, which builds natively for both Apple
Silicon and Intel:

```bash
cd apps/desktop
wails build          # -> build/bin/NetLink.app
wails dev            # hot reload while developing
```

Sign in, and your Spaces and computers appear exactly as they do on Windows.
Files, printers, power and remote desktop all work against a Windows PC from a
Mac.

---

## 3. A Mac as the computer you reach

Install the agent as a system service:

```bash
cd services/agent
go build -o bin/netlink-agent ./cmd/netlink-agent
sudo ./bin/netlink-agent install
```

That writes a **LaunchDaemon**, not a LaunchAgent, and the difference matters: a
LaunchAgent only runs while somebody is logged in, which would mean NetLink
could not reach a Mac that nobody is sitting at — the exact situation it exists
for. A LaunchDaemon runs from boot, as root, whether anyone is logged in or not.

To enrol it, get a token from the NetLink window (**My Spaces → Add a
computer**) and:

```bash
sudo ./bin/netlink-agent run --api https://your-api/api --token PASTE_TOKEN
```

Removing it:

```bash
sudo ./bin/netlink-agent uninstall
```

---

## 4. The two permissions macOS will ask for

macOS gates screen capture and input injection behind TCC, and **a missing
permission fails silently at the OS level** — `CGEventPost` returns no error and
does nothing. NetLink checks for both up front and reports them by name, because
"I connect and see the screen but my clicks do nothing" is a miserable thing to
debug.

| Permission | Needed for | Where |
|---|---|---|
| **Screen Recording** | Showing this Mac's screen in a remote session | System Settings → Privacy & Security → Screen Recording |
| **Accessibility** | Letting a remote session control this Mac | System Settings → Privacy & Security → Accessibility |

Grant them to the `netlink-agent` binary, then restart the agent. Until Screen
Recording is granted, captures come back empty and NetLink says exactly that.

---

## 5. What is different from Windows, honestly

Three real differences. None of them is a bug, and all three are worth knowing
before you rely on them.

### Remote desktop is slower on a Mac being viewed

The Windows agent captures with GDI BitBlt and sustains about fifteen frames a
second. The macOS agent shells out to `screencapture`, which costs roughly
80–150 ms per frame — so viewing a Mac gives you something like six to eight
frames a second.

Why: the fast paths on macOS are ScreenCaptureKit and `CGDisplayCreateImage`,
and both need cgo. cgo would mean the agent could only be built on a Mac, and
would cost the single-static-binary property that makes it easy to ship. That
trade is worth making deliberately rather than by accident, and it has not been
made. Nothing is written to disk either way — `screencapture -` writes to
standard output, and frames of somebody's screen do not touch their filesystem.

### Controlling a Mac needs a cgo build

Injecting input means `CGEventPost`, which needs cgo. The default build
(`CGO_ENABLED=0`, which is what you get cross-compiling from anything that is
not a Mac) **can be viewed but not controlled**, and says so in as many words
rather than swallowing keystrokes.

For full control, build on a Mac with the Xcode tools present:

```bash
CGO_ENABLED=1 go build -o bin/netlink-agent ./cmd/netlink-agent
```

### Restart and shut down need root, and there is no local countdown

macOS will not let a user process halt the machine — hence the LaunchDaemon.
And unlike Windows' `shutdown /t`, macOS has no way to show the person sitting
at the Mac a warning they can cancel locally.

So NetLink's own ten-second countdown, held in the control plane which withholds
the command until it elapses, is **the only warning** on macOS. That countdown
is real on both platforms; on a Mac it is also the whole protection.

---

## 6. Key protection

| | |
|---|---|
| Windows | DPAPI, machine scope, with application entropy |
| **macOS** | **Login Keychain holds a wrapping key; the device key on disk is sealed under it with AES-256-GCM** |
| Linux | File permissions only — and `netlink-agent status` says so rather than implying more |

The Keychain item is bound to this account on this machine, so the key file
copied to another Mac decrypts to nothing. It does *not* protect against a
process already running as you with Keychain access — the same limit DPAPI has,
for the same reason.

Check what is actually protecting your key:

```bash
./bin/netlink-agent status
```

On a Mac it should read `macos-keychain`. Anything else means the key is not
being sealed by the OS, and NetLink tells you rather than implying otherwise.

---

## 7. Checks

```bash
./scripts/test-all.sh                    # everything
./scripts/test-all.sh --skip-integration # no database needed
./scripts/test-all.sh --fix-formatting
```

The gate cross-compiles for Windows, both Mac architectures and Linux on every
run, so a platform-specific file that stopped compiling is caught by whoever
broke it rather than by whoever next tries to ship for that platform.
