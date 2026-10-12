import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
await mkdir(resolve(root,'dist/vendor'),{recursive:true});
await build({stdin:{contents:"export * from 'yjs';",resolveDir:root,sourcefile:'yjs-entry.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:resolve(root,'dist/vendor/yjs.js'),legalComments:'eof'});
const licenses=await Promise.all(['yjs','lib0','isomorphic.js'].map(async name=>{try{return `${name}\n${await readFile(resolve(root,'node_modules',name,'LICENSE'),'utf8')}`;}catch{return ''}}));
await writeFile(resolve(root,'dist/vendor/LICENSES.txt'),licenses.filter(Boolean).join('\n\n'));
console.log('Module Yjs navigateur préparé.');
