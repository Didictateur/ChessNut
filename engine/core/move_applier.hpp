#pragma once

#include "game_state.hpp"
#include "move_result.hpp"

namespace engine {

class MoveApplier {
public:
    MoveApplier();

    MoveResult applyMove(GameState& state, const Move& move);
    MoveResult simulateApply(const GameState& state, const Move& move, GameState& outState) const;
};

} // namespace engine
