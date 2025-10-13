#pragma once

#include "../core/game_state.hpp"
#include "../core/move.hpp"
#include "../core/move_result.hpp"
#include "../core/move_generator.hpp"

namespace engine::plugins {

class EffectPlugin {
public:
    virtual ~EffectPlugin() = default;

    // modify the move generation step (can register extra moves)
    virtual void modifyMoveGeneration(const engine::GameState& state, engine::MoveGenerator& generator) {}

    // hook before applying a move (can mutate the move or block it)
    virtual void onBeforeApply(engine::GameState& state, engine::Move& move, engine::MoveResult& out) {}

    // hook after move applied
    virtual void onAfterApply(engine::GameState& state, const engine::Move& move, engine::MoveResult& out) {}
};

} // namespace engine::plugins
