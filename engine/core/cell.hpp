#ifndef CELL_HPP
#define CELL_HPP

#include "piece.hpp"
#include <optional>
#include <memory>

namespace engine {

struct Cell {
    std::optional<std::shared_ptr<Piece>> piece;
};

} // namespace engine

#endif