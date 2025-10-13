#ifndef BOARD_HPP
#define BOARD_HPP

#include <vector>
#include "cell.hpp"

namespace engine {

class Board {
private:
    int width;
    int height;
    std::vector<std::vector<Cell>> grid;

public:
    Board(int w, int h) : width(w), height(h), grid(h, std::vector<Cell>(w)) {}
    int getWidth() const { return width; }
    int getHeight() const { return height; }
    Cell& getCell(int x, int y) { return grid[y][x]; }
    void setPiece(int x, int y, const Piece& piece) {
        grid[y][x].pieceId = std::make_shared<Piece>(piece);
    }
};

} // namespace engine

#endif