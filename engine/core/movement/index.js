// Central export for movement modules
import {RookMove, BishopMove, KnightMove, QueenMove, KingMove, PawnMove} from './moves.js';
import { generateLinearMoves } from './generateMoves.js';

export default {
    RookMove,
    BishopMove,
    KnightMove,
    QueenMove,
    KingMove,
    PawnMove,
    generateLinearMoves,
};