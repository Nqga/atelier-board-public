import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files=['server.mjs'];
for(const dir of ['dist','server','scripts','tests'])for(const name of await readdir(new URL(`../${dir}/`,import.meta.url)))if(/\.(js|mjs)$/.test(name))files.push(`${dir}/${name}`);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`${files.length} JavaScript modules checked.`);
