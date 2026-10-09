const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
(async () => {
  const out = path.join(root, 'www');
  await fs.rm(out, {recursive:true, force:true});
  await fs.mkdir(out, {recursive:true});
  for(const name of ['vendor','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png']) {
    await fs.cp(path.join(root, name), path.join(out, name), {recursive:true});
  }
  let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  html = html.replace('<link rel="manifest" href="manifest.json">', '<script defer src="native.js"></script>');
  await fs.writeFile(path.join(out, 'index.html'), html);
  await fs.copyFile(path.join(root,'src/webview-error.html'), path.join(out,'webview-error.html'));
  await esbuild.build({entryPoints:[path.join(root,'src/native-entry.cjs')], bundle:true, platform:'browser',
    target:['chrome89'], outfile:path.join(out,'native.js'), minify:true, legalComments:'eof'});
})();
