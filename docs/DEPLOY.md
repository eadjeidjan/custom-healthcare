# Deploying and operating SickleGuard

SickleGuard runs as Docker Compose **instances** on one server. The `sickleguard` CLI (alias `sg`, source in
`cli/`) does every step: settings, checks, deploy, update with automatic rollback, backups and restore, accounts,
the model and HTTPS.

| Thing | Where |
| --- | --- |
| Live address | **https://sickleguard.kasadaai.com** |
| Server | the Kasada server (public IP 5.199.170.132), repository in **`/opt/kasada/SickleGuard`** (beside `/opt/kasada/CustoCareAI` and `/opt/kasada/eCourier`) |
| Instance `live` | Compose project `sickleguard-live`, settings `deploy/live.env`, web also on `127.0.0.1:<WEB_PORT>` |
| HTTPS | **kasada mode**: CustoCare's `kasada-edge` Caddy (80/443, certificates); SickleGuard writes one file, `sickleguard.caddy`, into its extra-sites folder |
| Event log | `deploy/logs/events.log` (every CLI action, no secrets); state `deploy/logs/<instance>.state` |
| Backups | `backups/<instance>-<YYYYMMDD-HHMMSS>/` (mode 700) |

Containers per instance: `db` (Postgres 17 + pgvector), `qdrant`, `api` (FastAPI), `mcp` (MCP server),
`web` (nginx: the app and `/api` → api). Volumes: `db-data`, `qdrant-data`, `app-data` (`/app/data`, uploaded
files). The risk model is trained while the api image is built and ships inside it (`/app/models`), so every image
tag carries its own model and a rollback brings the matching model back.

The step-by-step server commands for the Kasada server are in **`deploy/INSTALL_STEPS.txt`**; this guide explains
them and covers everyday work.

## Rules that always apply

- **Never print, paste or commit secrets.** Keys and passwords are typed only at hidden prompts
  (`sickleguard env set KEY`). `env get` masks secrets unless you add `--show` on your own terminal. Don't paste
  full logs into chat or tickets; filter them with `grep`.
- **Never hand-replace a working `deploy/<instance>.env`.** Change one key at a time with `sickleguard env set KEY`:
  it edits in place and keeps the previous file as `.bak`.
- Containers read settings only when created: after a settings change, let `env set` recreate them or run
  `sickleguard deploy --no-build`.
- Data is never deleted without typing the instance name (`restore`, `down --volumes`, `demo reset`).
  `update` takes a backup first.
- Try changes on a test instance first (`--instance test`), then live. Never `git reset --hard` on the server.
- On the Kasada server SickleGuard touches exactly one file of kasada's: `sickleguard.caddy` in kasada-edge's
  extra-sites folder (validated before reload, previous copy kept). Everything else of CustoCare's is changed only
  through its own procedures (`/opt/kasada/CustoCareAI`, `kasada …`).

## 1. First installation

### 1.1 How HTTPS works on the Kasada server (kasada mode)

CustoCare's front proxy, the Docker container `kasada-edge-proxy-1` (Caddy), already holds ports 80/443 and the
certificates for every site on the server (CustoCare, AHPC, eCourier). SickleGuard joins it the same way eCourier
does:

1. `deploy/shared-edge.yml` puts SickleGuard's `web` container on kasada-edge's Docker network `kasada-edge` under
   the name `sickleguard-<instance>-web`. The CLI adds this file automatically whenever kasada-edge is on the server.
2. The CLI writes **one file**, `sickleguard.caddy`, into kasada-edge's extra-sites folder (the host folder mounted
   at `/etc/kasada-edge/extra`), one block per instance with a `DOMAIN`:

   ```caddy
   sickleguard.kasadaai.com {
   	import edge
   	tls <ACME_EMAIL>
   	reverse_proxy sickleguard-live-web:80 {
   		flush_interval -1      # the assistant streams its answers (Server-Sent Events)
   	}
   }
   ```

3. It runs `caddy validate` and then `caddy reload` inside kasada-edge. If either fails, the previous file is put
   back (a copy is kept in `deploy/edge/sickleguard.caddy.bak`) and the command stops with Caddy's message.

Nothing else of kasada's is read or changed. `deploy`, `update` and `edge sync` keep the file current;
`edge status` shows the mode, the file and whether the domain is in it. If kasada-edge has no extra-sites folder
the CLI stops with "in /opt/kasada/CustoCareAI run `kasada update --apply`"; if it is stopped, "run
`kasada edge up`". Override the container name with `SICKLEGUARD_KASADA_EDGE_CONTAINER`.

Other servers: **own** mode (`EDGE_MODE=own`, automatic when nothing holds 80/443) starts SickleGuard's own Caddy
(`sickleguard edge up`, project `sickleguard-edge`, `deploy/edge/`); **external** mode prints a site block for any
other proxy (`sickleguard edge snippet --upstream host|docker-host|bridge`).

### 1.2 DNS

At the DNS provider of `kasadaai.com`, add an **A record** `sickleguard` → `5.199.170.132`. Check:
`getent hosts sickleguard.kasadaai.com` → `5.199.170.132`. Don't change other records.

### 1.3 Code and CLI

Follow `deploy/INSTALL_STEPS.txt` steps 2–3: clone into `/opt/kasada/SickleGuard` with an Azure DevOps personal
access token passed for that one command only (never saved), then `cli/install.sh`, which installs Go 1.27 if
needed (checksum verified) and puts `sickleguard` (and the alias `sg`) in `/usr/local/bin`. The repository path is
built into the binary, so `sickleguard` works from any folder.

### 1.4 Settings, deploy, verify

```bash
sickleguard init --instance live --domain sickleguard.kasadaai.com --email <your email>
sickleguard check --instance live
sickleguard deploy --instance live
sickleguard edge status --instance live
```

`init` asks for the remaining values (suggested defaults are fine; demo data: **no**) and the OpenAI key (hidden).
It picks a free loopback web port (from 8310) — the port is only for the CLI's health checks and SSH tunnels;
traffic from kasada-edge goes over the Docker network. `deploy` builds (tag = git SHA, model trained in the image,
5–10 minutes the first time), starts, checks health, runs the smoke test (admin sign-in + dashboard) and writes
`sickleguard.caddy`. Live defaults: `SEED_DEMO=false`, `SIMULATE_DEVICES=false`, `ENVIRONMENT=production`,
`PUBLIC_URL` (and CORS) `https://sickleguard.kasadaai.com`.

Sign in at https://sickleguard.kasadaai.com as `ADMIN_EMAIL` with `sickleguard env get ADMIN_PASSWORD --show`
(then change it in the app or with `sickleguard users reset-password`).

### 1.5 After installation

```bash
sickleguard users create clinician@example.org --name "Dr A" --role clinician   # password: hidden prompt or generated, shown once
sickleguard backup --keep 14                                                    # first backup
crontab -e    # nightly: 30 2 * * * /usr/local/bin/sickleguard backup --keep 14 >> ~/sickleguard-backup.log 2>&1
```

## 2. Everyday operations

| Task | Command |
| --- | --- |
| Overview (containers, health, tag, model, OpenAI, volume sizes) | `sickleguard status` |
| Full check | `sickleguard check` |
| Logs | `sickleguard logs api -f` (services: api, mcp, web, db, qdrant) |
| Restart | `sickleguard restart [service]` |
| Change a setting | `sickleguard env set KEY` (secrets: hidden prompt) — then recreate when asked |
| Show a setting | `sickleguard env get KEY` (masked) · `sickleguard env list` |
| Add / rotate the OpenAI key | `sickleguard env set OPENAI_API_KEY`, then `sickleguard knowledge reindex` |
| Accounts | `sickleguard users list / create / set-role / reset-password / link-patient / disable / enable` |
| Patient portal account | `sickleguard users create p@example.org --role patient --mrn <MRN>` |
| Model | `sickleguard model status` · `sickleguard model train` (retrains in the running containers until the next deploy; the image's model is trained at build) |
| Demo data (test instances only) | `sickleguard --instance test demo reset` |
| Shell / SQL | `sickleguard exec api -- python -m app.manage list` · `sickleguard exec db -- psql -U sg sickleguard` |
| Stop (data kept) | `sickleguard down` · start again: `sickleguard deploy --no-build` |
| Shell completion | `sickleguard completion bash > /etc/bash_completion.d/sickleguard` |

Add `--instance <name>` (or `export SG_INSTANCE=<name>`) for other instances, `--yes` for scripts, `-v` to see the
docker commands. `scripts/sg` is a wrapper that runs the same CLI (and builds it if needed).

A **test instance** next to live: `sickleguard --instance test init --demo` (own port, own volumes, project
`sickleguard-test`; give it its own `--domain` such as `sickleguard-test.kasadaai.com` with a DNS record, or none
for SSH-tunnel access only), `deploy`, try the change, `down --volumes` when done. The names `dev` and `edge` are reserved.

## 3. Update and rollback

```bash
sickleguard update
```

1. `git pull --ff-only` (refuses on local changes or diverged history — never reset; see Troubleshooting; with
   `SICKLEGUARD_GIT_PAT` set the token is passed to git for this pull only, through the environment),
2. a backup (`reason: update`),
3. builds `sg-api:<sha>` / `sg-web:<sha>` (`<sha>-dirty-<time>` when the tree has uncommitted changes),
4. starts them, waits for `/api/v1/health` and the smoke test,
5. on failure **rolls back automatically** to the previous tag and says so (exit code 1).

The running and previous tags are in `deploy/logs/<instance>.state`; `status` shows them.

```bash
sickleguard rollback            # back to the previous tag
sickleguard rollback 1a2b3c4    # or a named one (it must still be on the host: docker images sg-api)
```

Rollback changes the code and the model (both are in the image). The database stays as it is; if a new version changed data, restore the backup
that `update` took (`sickleguard backup list`). Don't run `docker image prune -a` on the server, or older tags
disappear.

## 4. Backups and the restore drill

`sickleguard backup [--keep N]` writes `backups/<instance>-<time>/`:

| File | Content |
| --- | --- |
| `postgres.sql.gz` | `pg_dump` of the database (patients, check-ins, assessments, accounts, assistant memory) |
| `qdrant-<collection>.snapshot` | Qdrant snapshot per collection (or `qdrant-volume.tar.gz` if the API snapshot fails) |
| `data.tar.gz` | uploaded files (`/app/data`) |
| `manifest.json`, `SHA256SUMS` | instance, time, git commit, image tag, sizes, checksums (`sha256sum -c SHA256SUMS`) |

Backups hold patient data: keep the folder mode 700 and copy them off the server
(e.g. `rsync -a backups/ backup-host:/srv/sickleguard/`). `sickleguard backup list` shows them.

**Restore** (`sickleguard restore <dir>`): verifies checksums, asks you to type the instance name, takes a
`pre-restore` safety backup, stops api/mcp/web, replaces the database, vectors and uploaded files, starts again and
runs the smoke test.

**Drill (monthly):** restore live's newest backup into a test instance and look at it, without touching live:

```bash
sickleguard --instance drill init --no-demo --yes
sickleguard --instance drill deploy
sickleguard --instance drill restore backups/live-<time>     # type: drill
sickleguard --instance drill status                          # then sign in on http://127.0.0.1:<port> through an SSH tunnel
sickleguard --instance drill down --volumes                  # type: drill
rm deploy/drill.env deploy/logs/drill.state
```

The drill instance uses live's data with its own settings; sign in with live's accounts.

## 5. Troubleshooting

| Symptom | What to do |
| --- | --- |
| `deploy` stops at "containers did not become healthy" | `sickleguard logs api` — usually a setting (`check`), or the database still starting; run `deploy --no-build` again |
| `JWT_SECRET must be…` / `MCP_TOKEN` errors | `sickleguard check`; fix with `env set` |
| Smoke test warns "ADMIN_PASSWORD … do not sign in" | the admin changed their password; harmless (health still checked). Optional: `env set ADMIN_PASSWORD` to the new one |
| HTTPS 502 from kasada-edge | web not on the `kasada-edge` network: `sickleguard deploy --no-build` (adds `shared-edge.yml`), then `edge status`; `curl -fsS http://127.0.0.1:<WEB_PORT>/api/v1/health` on the server |
| "has no extra-sites folder" | `cd /opt/kasada/CustoCareAI && kasada update --apply`, then `sickleguard edge sync` |
| "kasada-edge-proxy-1 is not running" | `cd /opt/kasada/CustoCareAI && kasada edge up`, then `sickleguard edge sync` |
| "kasada-edge validate failed" | the previous `sickleguard.caddy` was put back, nothing changed; read the message (often a `DOMAIN` typo: `env get DOMAIN`) |
| Certificate not issued | DNS must point at 5.199.170.132 before the first HTTPS visit; `sickleguard edge status`; wait a few minutes |
| Assistant answers arrive all at once | the proxy buffers: the site block needs `flush_interval -1` |
| AI summaries / assistant off | no or invalid OpenAI key: `sickleguard check`, `env set OPENAI_API_KEY`, `knowledge reindex` |
| `git pull --ff-only` refuses or asks for a password | local edits: `git status`, undo them (never `reset --hard`). Credentials: see INSTALL_STEPS step 6 (`SICKLEGUARD_GIT_PAT`) |
| `update` rolled back | read the printed error and `logs api`; fix on a test instance; the backup from before the update is in `backup list` |
| Disk full | `sickleguard check`; old backups (`backup --keep N`), `docker builder prune`; keep the image tags you may roll back to |
| Port taken | `sickleguard env set WEB_PORT <port>` then `deploy --no-build` |
| What happened when? | `tail -n 50 deploy/logs/events.log` |

## 6. Security checklist

- `deploy/*.env` and `backups/` are mode 600/700 and never committed (`deploy/.gitignore`, `.gitignore`).
- The Azure DevOps token is never saved on the server: it is passed per command through the environment.
- The web port listens on loopback only; the public way in is kasada-edge (HTTPS).
- `ENVIRONMENT=production`: API docs off, long JWT secret and MCP token enforced; the MCP server is internal.
- `SEED_DEMO=false` and `SIMULATE_DEVICES=false` on live (`check` warns otherwise).
- Rotate a leaked secret with `env set` (JWT_SECRET signs everyone out; POSTGRES_PASSWORD must be changed in
  Postgres too). `users disable` blocks sign-in at once; sessions already open end within `JWT_HOURS` (12 h) —
  rotate JWT_SECRET to end them immediately.
- The event log records who-did-what without secret values; `env get --show` is logged as "revealed".
