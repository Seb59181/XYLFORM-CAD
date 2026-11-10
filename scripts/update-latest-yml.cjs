/**
 * Après la signature (SignPath), l'installateur a changé : on recalcule l'empreinte SHA-512 et la
 * taille inscrites dans release/latest.yml, sinon electron-updater refuserait la mise à jour.
 * Le fichier .blockmap (téléchargement différentiel) ne correspond plus : il est supprimé, la mise
 * à jour se fait alors en téléchargement complet.
 *
 * Usage : node scripts/update-latest-yml.cjs [dossier]   (par défaut release/)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || 'release');
const ymlPath = path.join(dir, 'latest.yml');
let yml = fs.readFileSync(ymlPath, 'utf8');

const urls = [...yml.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)].map((m) => m[1].trim());
for (const name of new Set([...urls, ...[...yml.matchAll(/^path:\s*(.+)$/gm)].map((m) => m[1].trim())])) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`latest.yml cite ${name}, absent de ${dir}`);
  const data = fs.readFileSync(file);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  // bloc « - url: name / sha512: … / size: … »
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  yml = yml.replace(new RegExp(`(url:\\s*${esc}\\s*\\n\\s*sha512:\\s*)\\S+(\\s*\\n\\s*size:\\s*)\\d+`), `$1${sha512}$2${data.length}`);
  // champs de premier niveau path / sha512
  if (new RegExp(`^path:\\s*${esc}\\s*$`, 'm').test(yml)) yml = yml.replace(/^sha512:\s*\S+$/m, `sha512: ${sha512}`);
  const blockmap = `${file}.blockmap`;
  if (fs.existsSync(blockmap)) fs.unlinkSync(blockmap);
  console.log(`latest.yml : ${name} → ${data.length} octets, sha512 recalculé`);
}
fs.writeFileSync(ymlPath, yml);
