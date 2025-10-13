#ifndef CELL_HPP
#define CELL_HPP

#include <optional>

namespace engine {

struct PieceId;

struct Cell {
    std::optional<PieceId> pieceId;
};

} // namespace engine

#endif