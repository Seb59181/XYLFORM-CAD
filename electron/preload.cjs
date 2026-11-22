/** Pont sécurisé entre l'interface et le processus principal (window.sebcadDesktop). */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sebcadDesktop', {
  version: process.versions.electron,
  pathForFile: (file) => webUtils.getPathForFile(file),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  appInfo: () => ipcRenderer.invoke('app-info'),
  checkUpdates: (manual) => ipcRenderer.invoke('check-updates', manual),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('update-status', (_e, s) => cb(s));
  },
  mcpStatus: () => ipcRenderer.invoke('mcp-status'),
  mcpEnable: (on) => ipcRenderer.invoke('mcp-enable', !!on),
  mcpInstall: () => ipcRenderer.invoke('mcp-install'),
  onMcpRequest: (cb) => {
    ipcRenderer.on('mcp-request', async (_e, req) => {
      let result;
      try {
        result = await cb(req);
      } catch (e) {
        result = { content: [{ type: 'text', text: `Erreur : ${e && e.message}` }], isError: true };
      }
      ipcRenderer.send('mcp-response', req.id, result);
    });
  },
  onOpenFile: (cb) => {
    ipcRenderer.on('open-file', (_e, file) => cb(file));
    ipcRenderer.send('renderer-ready');
  },
});
