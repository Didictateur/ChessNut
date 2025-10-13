#ifndef TEAM_HPP
#define TEAM_HPP

#include "piece.hpp"
#include <memory>

namespace engine {

struct Team {
    Team(std::shared_ptr<Piece> king) : king(king) {}

    enum Type { WHITE, BLACK };
    std::shared_ptr<Piece> king;
};

} // namespace engine

#endif