#ifndef PIECE_HPP
#define PIECE_HPP

namespace engine {

enum class PieceColor {
    WHITE,
    BLACK
};

enum class PieceType {
    PAWN,
    KNIGHT,
    BISHOP,
    ROOK,
    QUEEN,
    KING
};

class Piece {
private:
    PieceColor color;
    PieceType type;

public:
    Piece(PieceColor c, PieceType t) : color(c), type(t) {}

    PieceColor getColor() const { return color; }
    PieceType getType() const { return type; }
};

} // namespace engine

#endif