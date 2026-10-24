import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--mode','preview'],{stdio:'inherit',env:{...process.env,VITE_APP_MODE:'local'}});
process.exit(result.status??1);
