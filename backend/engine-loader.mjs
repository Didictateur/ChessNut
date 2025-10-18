// Small ESM helper run by backend to instantiate engine GameState and print a minimal serialized view.
import fs from 'fs';
import path from 'path';

async function main(){
  try{
    const enginePath = 'file:///app/engine/core/game_state.js';
    const mod = await import(enginePath);
    const GameState = mod && (mod.default || mod.GameState);
    if(typeof GameState !== 'function'){
      console.error(JSON.stringify({ ok:false, error: 'GameState not found in module', keys: Object.keys(mod||{}) }));
      process.exit(2);
    }
    const gs = new GameState();
    // attempt a minimal serialization similar to server's serializeEngineState
    let boardObj = (typeof gs.getBoard === 'function') ? gs.getBoard() : gs.board;
    const w = (typeof boardObj.getWidth === 'function') ? boardObj.getWidth() : (boardObj.width || 8);
    const h = (typeof boardObj.getHeight === 'function') ? boardObj.getHeight() : (boardObj.height || 8);
    const board = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
    // best-effort: leave board nulls—engine may have complex pieces
    const out = { ok:true, width: w, height: h };
    console.log(JSON.stringify(out));
  }catch(e){
    console.error(JSON.stringify({ ok:false, error: (e && e.stack) || String(e) }));
    process.exit(1);
  }
}

main();
