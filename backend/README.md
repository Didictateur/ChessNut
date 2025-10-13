Backend mock for ChessNut (Express + Socket.IO)

API endpoints:
- POST /api/create { name, pass }
- GET /api/list
- POST /api/join { id, pass }

Socket.IO events:
- join-game (room name)
- move (payload includes gameId)

Run locally:

    cd backend
    npm install
    node index.js
