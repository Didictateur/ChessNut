# include "game_state.hpp"

namespace engine {

GameState::GameState() : board(8, 8) {

    // white pieces
    board.setPiece(0, 0, Piece(PieceColor::WHITE, PieceType::ROOK));
    board.setPiece(1, 0, Piece(PieceColor::WHITE, PieceType::KNIGHT));
    board.setPiece(2, 0, Piece(PieceColor::WHITE, PieceType::BISHOP));
    board.setPiece(3, 0, Piece(PieceColor::WHITE, PieceType::QUEEN));
    board.setPiece(4, 0, Piece(PieceColor::WHITE, PieceType::KING));
    board.setPiece(5, 0, Piece(PieceColor::WHITE, PieceType::BISHOP));
    board.setPiece(6, 0, Piece(PieceColor::WHITE, PieceType::KNIGHT));
    board.setPiece(7, 0, Piece(PieceColor::WHITE, PieceType::ROOK));

    for (int x = 0; x < 8; ++x) {
        board.setPiece(x, 1, Piece(PieceColor::WHITE, PieceType::PAWN));
    }

    // black pieces
    board.setPiece(0, 7, Piece(PieceColor::BLACK, PieceType::ROOK));
    board.setPiece(1, 7, Piece(PieceColor::BLACK, PieceType::KNIGHT));
    board.setPiece(2, 7, Piece(PieceColor::BLACK, PieceType::BISHOP));
    board.setPiece(3, 7, Piece(PieceColor::BLACK, PieceType::QUEEN));
    board.setPiece(4, 7, Piece(PieceColor::BLACK, PieceType::KING));
    board.setPiece(5, 7, Piece(PieceColor::BLACK, PieceType::BISHOP));
    board.setPiece(6, 7, Piece(PieceColor::BLACK, PieceType::KNIGHT));
    board.setPiece(7, 7, Piece(PieceColor::BLACK, PieceType::ROOK));

    for (int x = 0; x < 8; ++x) {
        board.setPiece(x, 6, Piece(PieceColor::BLACK, PieceType::PAWN));
    }
}

} // namespace engine