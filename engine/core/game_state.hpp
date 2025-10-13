#pragma once

#include <vector>
#include <optional>
#include "piece.hpp"
#include "move.hpp"

namespace engine {

struct Cell {
    std::optional<PieceId> pieceId;
    // additional flags: trap, fog, etc.
};

class GameState {
public:
    GameState();

    int width() const;
    int height() const;
    bool isValid(const Coord& c) const;

    const Cell& cellAt(const Coord& c) const;
    Cell& cellAt(const Coord& c);

    // snapshot / clone
    GameState clone() const;

private:
    int w_ = 8;
    int h_ = 8;
    std::vector<Cell> cells_;
};

} // namespace engine
