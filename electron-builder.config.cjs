/**
 * Configuration electron-builder : installateur Windows (NSIS) et version portable (.exe unique).
 * `npm run exe` → dossier release/ (sans publication).
 * `npm run release` (avec GH_TOKEN) ou le workflow GitHub Actions → publication sur GitHub Releases,
 * avec le fichier latest.yml lu par la mise à jour automatique (electron-updater).
 */
module.exports = {
  appId: 'fr.seb.xylformcad',
  productName: 'Xylform CAD',
  copyright: '© Seb',
  directories: { output: 'release', buildResources: 'build' },
  // l'application web est entièrement compilée dans dist/ : seules les dépendances du processus
  // principal (electron-updater) sont embarquées, electron-builder ne prend que les "dependencies"
  files: ['dist/**/*', 'electron/**/*', 'build/icon.png', 'package.json'],
  extraMetadata: { main: 'electron/main.cjs' },
  npmRebuild: false,
  electronLanguages: ['fr', 'en-US'],
  asar: true,
  afterPack: './scripts/after-pack.cjs',
  // mise à jour automatique : dépôt public GitHub, versions publiées dans « Releases »
  publish: [{ provider: 'github', owner: 'Seb59181', repo: 'XYLFORM-CAD', releaseType: 'release' }],
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    executableName: 'XylformCAD',
    // icône et version écrites par scripts/after-pack.cjs (pas besoin de Wine) ; la signature
    // du code est faite après coup par SignPath (voir .github/workflows/release.yml)
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Xylform CAD',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerLanguages: ['fr_FR'],
    language: '1036',
    artifactName: 'Xylform-CAD-Setup-${version}.${ext}',
  },
  portable: { artifactName: 'Xylform-CAD-${version}-portable.${ext}' },
  fileAssociations: [
    { ext: 'xcad', name: 'XylformCAD.Dessin', description: 'Dessin Xylform CAD', icon: 'build/icon.ico', role: 'Editor' },
    { ext: 'sebcad', name: 'XylformCAD.DessinSebCad', description: 'Dessin SebCad (ancien format)', icon: 'build/icon.ico', role: 'Editor' },
  ],
  linux: { target: ['dir'], icon: 'build/icon.png', category: 'Graphics' },
};
