#pragma once

#include <vector>
#include <string>
#include <optional>

#include "piece.hpp"

namespace engine {

struct Coord { int x; int y; };

using PieceId = int;

enum class MoveActionKind { Move, Capture, Create, Remove, SetFlag };

struct MoveAction {
    MoveActionKind kind;
    PieceId piece; // 0 for create
    Coord from;
    Coord to;
    std::optional<int> extra;
};

enum class MoveType { Normal, Capture, Castling, Promotion, Multi, CardEffect };

struct Move {
    PieceId actor = 0;
    std::vector<MoveAction> actions;
    MoveType type = MoveType::Normal;
    int playerId = -1;
    std::string tag;
};

} // namespace engine
