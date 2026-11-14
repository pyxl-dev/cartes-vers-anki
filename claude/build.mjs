/* Construit dist/cartes-vers-anki.mcpb pour Claude Desktop.
   Les modules partagés sont copiés depuis extension/ : une seule source de vérité. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const stage = path.join(here, 'dist', 'stage');
fs.rmSync(path.join(here, 'dist'), {recursive: true, force: true});
fs.mkdirSync(path.join(stage, 'server', 'lib'), {recursive: true});

for (const f of ['index.mjs', 'anki.mjs']) fs.copyFileSync(path.join(here, 'server', f), path.join(stage, 'server', f));
for (const f of ['shared.js', 'search.js', 'similarity.js', 'cards.js']) fs.copyFileSync(path.join(root, 'extension', f), path.join(stage, 'server', 'lib', f));
fs.copyFileSync(path.join(here, 'manifest.json'), path.join(stage, 'manifest.json'));
fs.copyFileSync(path.join(root, 'extension', 'icons', '128.png'), path.join(stage, 'icon.png'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error(`Versions différentes : package.json ${pkg.version}, manifest.json ${manifest.version}`);
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: pkg.dependencies}, null, 2));
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {cwd: stage, stdio: 'inherit'});

const mcpb = path.join(here, 'node_modules', '.bin', 'mcpb');
execFileSync(mcpb, ['validate', path.join(stage, 'manifest.json')], {stdio: 'inherit'});
execFileSync(mcpb, ['pack', stage, path.join(here, 'dist', 'cartes-vers-anki.mcpb')], {stdio: 'inherit'});
