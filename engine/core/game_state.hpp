#pragma once

#include <vector>
#include <optional>
#include "piece.hpp"
#include "move.hpp"
#include "board.hpp"

namespace engine {

class GameState {
private:
    Board board;

public:
    GameState();
};

} // namespace engine
