.PHONY: sync-frontend dev-sync

all: docker sync-frontend dev-sync

docker:
	docker-compose -f deploy/docker-compose.dev.yml up --build -d
	@echo "Frontend is running at http://localhost:3000"
	@echo "Backend is running at http://localhost:4000"

sync-frontend:
	@echo "Syncing frontend source -> public for dev..."
	@rsync -av --exclude node_modules --exclude .git --delete frontend/src/ frontend/public/src/

dev-sync: sync-frontend
	@echo "Done. You can run 'make dev-sync' whenever you changed frontend/src files."

.PHONY: dev-watch
dev-watch:
	@echo "Watching frontend/src for changes (requires inotifywait). Press Ctrl-C to stop."
	@which inotifywait > /dev/null || (echo "Please install inotify-tools (apt install inotify-tools)" && exit 1)
	while inotifywait -e modify,create,delete -r frontend/src; do \
		$(MAKE) dev-sync; \
	done