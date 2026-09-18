# Makefile — manage the amddash-sync watcher (systemd user units + sync script).
#
# Edit the paths in amddash-sync.sh, amddash-sync.path and amddash-sync.service
# FIRST to match your machine, then run `make install` once to set everything up.

REPO   := $(CURDIR)/../..
SYNC   := $(CURDIR)
UNIT   := $(HOME)/.config/systemd/user
SCRIPT := $(HOME)/amddash/amddash-sync.sh
SRC    := $(HOME)/amddash/data.yaml

.PHONY: install enable start restart stop disable status sync test help

install:  ## copy script + units into place, reload systemd, enable watcher
	mkdir -p $(UNIT) $(HOME)/amddash
	cp $(SYNC)/amddash-sync.sh $(SCRIPT)
	chmod +x $(SCRIPT)
	cp $(SYNC)/amddash-sync.path $(UNIT)/amddash-sync.path
	cp $(SYNC)/amddash-sync.service $(UNIT)/amddash-sync.service
	systemctl --user daemon-reload
	systemctl --user enable --now amddash-sync.path

enable:   ## start the watcher now and enable it at boot
	systemctl --user enable --now amddash-sync.path

start:    ## start the watcher now (not at boot)
	systemctl --user start amddash-sync.path

restart:  ## restart the watcher
	systemctl --user restart amddash-sync.path

stop:     ## stop the watcher
	systemctl --user stop amddash-sync.path

disable:  ## stop the watcher and disable it at boot
	systemctl --user disable --now amddash-sync.path

status:   ## show watcher + service status
	systemctl --user status amddash-sync.path amddash-sync.service

sync:     ## run the sync script once (manual trigger)
	$(SCRIPT)

test:     ## touch the source file and show recent auto-sync commits
	@test -f $(SRC) || { echo "No $(SRC) — fix SRC in this Makefile"; exit 1; }
	@touch $(SRC)
	@sleep 2
	git -C $(REPO) log --oneline -5 -- data/data.yaml

help:     ## show available targets
	@awk 'BEGIN{FS=":.*##";print "amddash-sync Makefile targets:"} /^[a-zA-Z_-]+:.*##/{printf "  %-10s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
