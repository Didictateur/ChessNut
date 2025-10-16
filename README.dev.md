Dev quickstart (mock backend + static frontend)

From repo root run:

    cd deploy
    docker-compose -f docker-compose.dev.yml up --build -d

Then open http://localhost:3000 for the frontend. Backend API listens on http://localhost:4000

If you edit files under `frontend/src/` during development, run:

    make dev-sync

This will copy changed files into `frontend/public/src/` so the static server (http://localhost:3000) serves the latest JS/CSS without rebuilding containers.

Development workflow note
-------------------------

Two strategies are supported during development to ensure the static server serves the latest frontend sources:

- Symlink (used in this repo): `frontend/public/src/game.js` is a symbolic link to `../../src/game.js` so there's one source of truth. This avoids accidental drift between `src/` and `public/src/` when editing locally. Symlinks are convenient for local development but may not be appropriate for all deployment or CI environments.

- Rsync / dev-sync: Run `make dev-sync` to copy files from `frontend/src/` into `frontend/public/src/`. This works in environments where symlinks are undesirable or when preparing files for containers.

Choose the approach that fits your workflow. This repository currently keeps a regular copy of `game.js` in `frontend/public/src/` (to avoid symlink issues in containers/CI), and `make dev-sync` remains available as the recommended way to update the public copy during development.
