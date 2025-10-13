Dev quickstart (mock backend + static frontend)

From repo root run:

    cd deploy
    docker-compose -f docker-compose.dev.yml up --build -d

Then open http://localhost:3000 for the frontend. Backend API listens on http://localhost:4000
