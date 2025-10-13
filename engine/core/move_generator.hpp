#pragma once

#include <vector>
#include "move.hpp"
#include "game_state.hpp"

namespace engine {

class MoveGenerator {
public:
    MoveGenerator();

    // generate moves for a specific piece; pieceId == 0 -> all pieces for player
    std::vector<Move> generateForPlayer(const GameState& state, int playerId) const;
    std::vector<Move> generateForPiece(const GameState& state, PieceId pieceId) const;
};

} // namespace engine
