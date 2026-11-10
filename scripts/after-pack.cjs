/**
 * Étape « afterPack » d'electron-builder pour Windows : icône et informations de version de
 * l'exécutable principal (XylformCAD.exe), écrites en JavaScript pur (resedit) — fonctionne aussi depuis Linux, sans Wine.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { NtExecutable, NtExecutableResource } = await import('pe-library');
  const ResEdit = await import('resedit');
  const exeName = context.packager.platformSpecificBuildOptions.executableName ?? context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${exeName}.exe`);
  const version = context.packager.appInfo.version.split('.').map((n) => parseInt(n, 10) || 0);
  while (version.length < 4) version.push(0);

  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group ? group.id : 1, group ? group.lang : 1033, icon.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(version[0], version[1], version[2], version[3], 1033);
  vi.setProductVersion(version[0], version[1], version[2], version[3], 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'Xylform CAD, by Seb. — CAO 2D/3D',
      ProductName: 'Xylform CAD',
      CompanyName: 'Seb',
      LegalCopyright: `© ${new Date().getFullYear()} Seb`,
      OriginalFilename: `${exeName}.exe`,
      InternalName: exeName,
    },
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • icône et version appliquées à ${path.basename(exePath)}`);
};
