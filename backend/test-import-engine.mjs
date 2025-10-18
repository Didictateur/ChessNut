import fs from 'fs';
import path from 'path';
import url from 'url';

(async function(){
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.resolve(__dirname, '../engine/core/game_state.js');
  console.log('Trying to load:', p);
  try{
    const content = fs.readFileSync(p, 'utf8');
    console.log('File exists, first 200 chars:\n', content.slice(0,200));
  }catch(e){ console.error('Cannot read file', e && e.message); }

  try{
    console.log('\nAttempting dynamic import() with file:// path...');
    const mod = await import('file://' + p);
    console.log('Imported module keys:', Object.keys(mod));
    console.log('Default export type:', typeof mod.default);
  }catch(e){
    console.error('import(file://) failed:');
    console.error(e && e.stack || e);
  }

  try{
    console.log('\nAttempting import with relative path from backend:');
    const mod2 = await import('../engine/core/game_state.js');
    console.log('Imported module keys (rel):', Object.keys(mod2));
    console.log('Default export type (rel):', typeof mod2.default);
  }catch(e){
    console.error('relative import failed:');
    console.error(e && e.stack || e);
  }
})();