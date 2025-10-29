import { app, BrowserWindow, BrowserView, Menu, ipcMain } from 'electron';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TabInfo {
  id: string;
  mode: 'headful' | 'headless';
  view?: Electron.BrowserView;
  wc?: Electron.WebContents;
  name?: string
}

let mainWin: BrowserWindow | null = null;
const tabs = new Map<string, TabInfo>();
let activeTabId: string | null = null;

const configPath = path.join(app.getAppPath(), 'config.json');

let config: { userDataPath?: string } = { userDataPath: 'default' };

function readconfig() {
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
    } catch (err) {
      console.warn('[경고] config.json을 읽는 중 오류 발생:', err);
    }
  }
  
  if (config.userDataPath && config.userDataPath !== 'default') {
    const userDataPath = path.isAbsolute(config.userDataPath)
      ? config.userDataPath
      : path.join(app.getAppPath(), config.userDataPath);
  
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
  
    app.setPath('userData', userDataPath);
    console.log('[INFO] Applied userData Path:', userDataPath);
  } else {
    console.log('[INFO] Applied userData Default Path:', app.getPath('userData'));
  }
}

function createMainWindow(): void {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      partition: 'persist:main'
    },
  });

  mainWin.loadFile(path.join(__dirname, 'src', 'pages', 'select.html'));
  buildMenu();

  createTab(`${Date.now()}`, path.join(__dirname, 'src', 'pages', 'select.html'));

  ipcMain.on('refresh-tab-menu', buildMenu)
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Tab',
      submenu: [
        {
          label: 'new Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => createTab(`tab${Date.now()}`, path.join(__dirname, 'src', 'pages', 'select.html')),
        },
        {
          label: 'Full Clone This Tab',
          click: () => duplicateTab(true),
        },
        {
          label: 'Clone This Tab and Refetch',
          click: () => duplicateTab(false),
        },
        {
          label: 'Close This Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => removeActiveTab(),
        },
        { type: 'separator' },
        {
          label: 'Select Tab',
          submenu: dynamicTabListSubmenu(),
        },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        {
          label: 'Back/Undo',
          accelerator: 'CmdOrCtrl+Z', // 이전 페이지
          click: () => {
            if (activeTabId) {
              const tab = tabs.get(activeTabId);
              if (tab?.wc?.navigationHistory.canGoBack()) {tab.wc.navigationHistory.goBack()}
            }
          }
        },
        {
          label: 'Forward/Redo',
          accelerator: 'CmdOrCtrl+Y', // 다음 페이지
          click: () => {
            if (activeTabId) {
              const tab = tabs.get(activeTabId);
              if (tab?.wc?.navigationHistory.canGoForward()) {tab.wc.navigationHistory.goForward()}
            }
          }
        }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' }
  ]);

  Menu.setApplicationMenu(menu);
}

function dynamicTabListSubmenu(): Electron.MenuItemConstructorOptions[] {
  if (tabs.size === 0) return [{ label: 'Not any Tab Opened', enabled: false }];

  return Array.from(tabs.keys()).map((id) => ({
    label: `${id}${id === activeTabId ? ' (Active)' : ''}`,
    type: 'radio',
    checked: id === activeTabId,
    click: () => switchToTab(id),
  }));
}

async function createTab(id: string, url: string, mode: 'headful' | 'headless' = 'headful') {
  if (!mainWin) return;

  const view = new BrowserView({ webPreferences: { contextIsolation: true } });
  await view.webContents.loadURL(url);

  const tabName = view.webContents.getTitle() || 'Untitled';

  tabs.set(id, { id, mode, view, wc: view.webContents, name: tabName });
  activeTabId = id;

  attachViewToMainWindow(id);
  buildMenu();
}


function attachViewToMainWindow(id: string): void {
  if (!mainWin) return;
  const tab = tabs.get(id);
  if (!tab?.view) return;

  mainWin.setBrowserView(tab.view);

  const [width, height] = mainWin.getContentSize();
  tab.view.setBounds({
    x: 0,
    y: 40,
    width: width,
    height: height - 40
  });

  tab.view.setAutoResize({ width: true, height: true });
}

function switchToTab(id: string): void {
  if (!mainWin) return;
  const tab = tabs.get(id);
  if (!tab?.view) return;

  activeTabId = id;
  mainWin.setBrowserView(tab.view);

  const [width, height] = mainWin.getContentSize();
  tab.view.setBounds({
    x: 0,
    y: 40,
    width: width,
    height: height - 40
  });

  tab.view.setAutoResize({ width: true, height: true });

  buildMenu()
}

function removeActiveTab(): void {
  if (!mainWin || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;

  if (tab.view && mainWin) {
    mainWin.removeBrowserView(tab.view);
  }
  tab.view = undefined;
  tab.wc = undefined;
  tabs.delete(activeTabId);

  const nextId = Array.from(tabs.keys())[0];
  if (nextId) switchToTab(nextId);
  else mainWin.setBrowserView(null);

  activeTabId = nextId || null;
  buildMenu()
}

async function duplicateTab(includeState: boolean): Promise<void> {
  if (!mainWin || !activeTabId) return;
  const src = tabs.get(activeTabId);
  if (!src?.wc) return;

  const newId = `tab${Date.now()}`;

  if (includeState) {
    const html = await src.wc.executeJavaScript('document.documentElement.outerHTML');
    const url = src.wc.getURL();

    const view = new BrowserView({ webPreferences: { contextIsolation: true } });
    await view.webContents.loadURL('about:blank');
    await view.webContents.executeJavaScript(`
      document.open();
      document.write(${JSON.stringify(html)});
      document.close();
      history.replaceState({}, '', ${JSON.stringify(url)});
    `);

    tabs.set(newId, { id: newId, mode: src.mode, view, wc: view.webContents });
    attachViewToMainWindow(newId);
  } else {
    await createTab(newId, src.wc.getURL(), src.mode);
  }

  buildMenu()
}

readconfig(),
app.whenReady().then(createMainWindow);
