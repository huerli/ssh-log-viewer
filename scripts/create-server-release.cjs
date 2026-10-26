const fs = require('node:fs');
const path = require('node:path');
const { validateVersion } = require('./collect-release.cjs');
const [directory, tag] = process.argv.slice(2);
validateVersion(tag?.replace(/^[vV]/, ''));
if (!/^[vV]/.test(tag)) throw new Error('Expected release tag');
const base = `https://64.81.112.231:9443/ssh-log-viewer/releases/${encodeURIComponent(tag)}`;
const assets = fs.readdirSync(directory).sort().map(name => {
  if (!/^ssh-log-viewer-[\w.+-]+$/.test(name)) throw new Error('Unexpected asset name');
  return { name, size: fs.statSync(path.join(directory, name)).size, browser_download_url: `${base}/${name}` };
});
const notes = fs.readFileSync(`docs/releases/${tag}.md`, 'utf8');
fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({ tag_name: tag, name: `SSH Log Viewer ${tag}`, body: notes, published_at: new Date().toISOString(), draft: false, prerelease: false, assets }, null, 2));
