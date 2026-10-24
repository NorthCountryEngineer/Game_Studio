import { build } from 'vite';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
await build({ configFile: false, publicDir: false, build: { outDir: 'public/sdk', emptyOutDir: true, lib: { entry: 'src/lib/integration.ts', formats: ['es'], fileName: () => 'game-studio.js' }, minify: false } });
mkdirSync('sdk/dist', { recursive: true });
copyFileSync('public/sdk/game-studio.js','sdk/dist/game-studio.js');
writeFileSync('sdk/package.json', JSON.stringify({name:'@northcountryengineer/game-studio',version:'1.0.0',type:'module',private:true,exports:'./dist/game-studio.js'},null,2)+'\n');
