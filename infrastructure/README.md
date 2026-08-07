# Infrastructure

Development infrastructure for NetLink. Production deployment is Phase 7.

## `postgres/init/`

SQL run once when the PostgreSQL container is first created.

`01-test-database.sql` creates `netlink_test`, the database the API integration tests use. Those tests truncate every table between cases, so they must never point at your development database — keeping them apart at the container level means a mistyped `DATABASE_URL` cannot wipe your data.

## Development stack

`docker-compose.yml` at the repository root brings up:

| Service | Port | Purpose |
|---|---|---|
| PostgreSQL 16 | 127.0.0.1:5432 | Development and test databases |
| Mailpit | 127.0.0.1:1025 (SMTP), 8025 (web) | See verification emails as real email |

Both are bound to `127.0.0.1` rather than `0.0.0.0`, so an open Windows firewall rule cannot expose your development database to the rest of the network.

```powershell
docker compose up -d
docker compose logs -f postgres
docker compose down       # keeps your data
docker compose down -v    # deletes your data
```

Only the database and the mailbox are containerised. The API, the desktop app and the agent run on your machine so you can attach a debugger and watch the Windows-specific parts — DPAPI, the service, Wake-on-LAN — actually behave. Containerising them would hide exactly what needs testing.

## Not here yet (Phase 7)

TLS termination, production Compose or Kubernetes manifests, backup and restore, monitoring and alerting, secret management, the code-signing pipeline.
