# amddash-sync

Watch a local `data.yaml` file and, on **every change**, copy it into this
repo's `data/data.yaml` and auto-commit + push to GitHub. It uses a systemd
**path unit**, which fires on the kernel `inotify` event the instant the file is
written — no polling, no waiting for a cron tick.

## What you get in this folder

| File                     | Purpose                                                          |
|--------------------------|------------------------------------------------------------------|
| `amddash-sync.sh`        | Copy source -> repo `data/data.yaml`, commit, push               |
| `amddash-sync.path`      | systemd path unit — watches the source file                      |
| `amddash-sync.service`   | systemd oneshot service — runs the script on each change         |
| `Makefile`               | Install/enable/status/stop/disable/sync/test                     |
| `README.md`              | This guide                                                       |

## How it works

1. You edit `~/amddash/data.yaml` (or whatever `SRC` points to).
2. The kernel sends an `inotify` event; the `.path` unit wakes immediately and
   starts `amddash-sync.service`.
3. The service runs `amddash-sync.sh`, which:
   - `cp`s the source into `data/data.yaml` of the repo,
   - `git add`s it, and if anything actually changed, commits
     (`Auto-sync data.yaml from ~/amddash/data.yaml ...`) and `git push`es,
   - no-ops (no empty commits) when the file is unchanged, and uses a lockfile
     so rapid writes never pile up commits.
4. If the push is rejected because the remote moved, it `git pull --rebase`
   first, then pushes — so it always stays fast-forward.

## Setup, step by step

### 1. Configure the paths to match YOUR machine

All three files hard-code paths. Edit them for your setup.

**`amddash-sync.sh`** — the only paths you usually need to touch:

```sh
SRC="$HOME/amddash/data.yaml"                    # source file you edit
REPO="$HOME/repos/amdstrix128speedaccuracytest"   # local clone of the target repo
DEST="data/data.yaml"                            # target path inside the repo
```

**`amddash-sync.path`** — must point at the source file exactly:

```ini
PathChanged=/home/dinesh/amddash/data.yaml   # change to your source path
```

**`amddash-sync.service`** — must point at the installed script:

```ini
ExecStart=/home/dinesh/amddash/amddash-sync.sh   # where `make install` puts it
```

### 2. Make sure prerequisites exist

- The target repo is cloned locally (`REPO` above) and its `origin` remote is
  your GitHub repo.
- You can `git push` from that clone non-interactively — an SSH key with no
  passphrase, or a git credential helper. (Test: `cd "$REPO" && git push`.)
- `systemd` user units are available (`systemctl --user status` works). This
  needs no root/sudo.

### 3. Install and enable — one command

From inside this folder:

```sh
make install
```

That copies the script to `~/amddash/amddash-sync.sh`, installs the two units
into `~/.config/systemd/user/`, runs `systemctl --user daemon-reload`, and
enables + starts the watcher. It is now active and armed.

### 4. Verify it works

```sh
make status   # amddash-sync.path should be "active (waiting)"
make test     # touches the source, waits 2s, shows recent auto-sync commits
```

Then make a real edit to the source file, wait ~1 second, and check GitHub —
you'll see an `Auto-sync data.yaml` commit appear. `make sync` runs the script
once manually if you ever want a manual trigger.

## Managing day to day

```sh
make status     # watcher + service status
make sync       # run the sync script once
make restart    # restart the watcher
make stop       # stop it
make disable    # stop + disable at boot
make enable     # re-enable + start
make install    # re-apply files after you edit them
```

## Reboot safety

`make install` and `make enable` create the unit with `WantedBy=default.target`
and, if you run `loginctl enable-linger <user>`, the watcher starts at boot even
before you log in. Without linger it still starts automatically on login.

## Troubleshooting

- `systemctl --user status amddash-sync.service` shows the last run's output.
- If a change was made but no commit appeared: the source and repo file may
  already be identical (the script no-ops), or the push failed — run `make sync`
  in a terminal to see the real error.
- Wrong source path? Edit `PathChanged` in `amddash-sync.path`, then
  `make install`.
- Wrong target repo? Edit `REPO` in `amddash-sync.sh`, then `make install`.

## Files in the repo

The working copies live here (`data/amddash-sync/`). The installed copies live
at `~/amddash/amddash-sync.sh` and `~/.config/systemd/user/amddash-sync.{path,service}`.
Edit the files **here**, commit them, then `make install` to apply.
