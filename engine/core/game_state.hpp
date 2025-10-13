#pragma once

#include <vector>
#include <optional>
#include "piece.hpp"
#include "move.hpp"
#include "board.hpp"
#include "team.hpp"

namespace engine {

class GameState {
private:
    Board board;
    Team whiteTeam;
    Team blackTeam;
    int turn;

public:
    GameState();

    Board getBoard() { return board; };
    Team getWhiteTeam() { return whiteTeam; };
    Team getBlackTeam() { return blackTeam; };
    int getTurn() { return turn; };
    void nextTurn() { turn = 1 - turn; };

    bool hasHisKing(PieceColor color);
    bool isInCheck(PieceColor color);
};

} // namespace engine
