#pragma once

#include <string>
#include <variant>
#include <vector>
#include "move.hpp"

namespace engine {

struct Event {
    std::string type; // e.g., "capture", "move", "promotion", "mine_triggered"
    std::string detail; // JSON or human-readable details
};

} // namespace engine
