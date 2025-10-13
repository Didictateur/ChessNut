#pragma once

#include <string>
#include <vector>
#include "move.hpp"
#include "events.hpp"

namespace engine {

enum class MoveStatus {
    Ok,
    Illegal,
    BlockedByCard,
    OutOfBounds,
    RequiresConfirmation
};

struct MoveResult {
    MoveStatus status = MoveStatus::Ok;
    std::vector<Event> events;
    std::string reason;
};

} // namespace engine
