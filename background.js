// Background script for Audio Transcriber extension

let activeTabId = null;
let sidebarPort = null;

chrome.action.onClicked.addListener(async (tab) => {
  console.log('🔥🔥🔥 EXTENSION ICON CLICKED! Tab:', tab.id, tab.url);
  
  // Store the active tab ID (this grants activeTab permission)
  activeTabId = tab.id;
  console.log('🔥🔥🔥 PERMISSION GRANTED! activeTabId set to:', activeTabId);
  
  // Check if we're on a chrome:// page or other restricted page
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Audio Transcriber',
      message: 'Cannot capture audio from Chrome system pages. Please navigate to a regular website (YouTube, news sites, etc.) and try again.'
    });
    return;
  }

  // Open the side panel manually
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    console.log('🔥🔥🔥 Side panel opened successfully WITH PERMISSION');
    
    // Notify sidebar that permission is now available
    if (sidebarPort) {
      sidebarPort.postMessage({ 
        type: 'permissionGranted', 
        tabId: activeTabId 
      });
    }
  } catch (error) {
    console.error('Background: Failed to open side panel:', error);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Background: Extension installed');
  // Explicitly disable automatic sidebar opening to ensure our action.onClicked fires
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    console.log('Background: Disabled automatic sidebar opening');
  } catch (error) {
    console.log('Background: Could not disable automatic opening:', error);
  }
});

// Handle long-lived connections from sidebar
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidebar") {
    sidebarPort = port;
    console.log('Background: Sidebar connected');
    console.log('Background: Current activeTabId when sidebar connected:', activeTabId);
    
    if (activeTabId === null) {
      console.log('⚠️⚠️⚠️ SIDEBAR OPENED WITHOUT CLICKING EXTENSION ICON! You must click the extension icon in the toolbar!');
    }
    
    // If we already have permission, notify the sidebar
    if (activeTabId) {
      port.postMessage({ 
        type: 'permissionStatusUpdate', 
        hasPermission: true,
        tabId: activeTabId 
      });
    }
    
    port.onMessage.addListener((message) => {
      console.log('Background: Received message:', message);
      
      if (message.action === 'stopCapture') {
        console.log('Background: Received stop capture message');
      } else if (message.action === 'requestPermission') {
        // Check if we have permission from a previous icon click
        if (activeTabId) {
          console.log('Background: Using existing permission for tab:', activeTabId);
          port.postMessage({ 
            type: 'permissionGranted', 
            tabId: activeTabId 
          });
        } else {
          console.log('⚠️⚠️⚠️ NO PERMISSION - USER MUST CLICK EXTENSION ICON FIRST!');
          port.postMessage({ 
            type: 'error', 
            message: 'No permission - Please click the extension icon first to grant access to this tab' 
          });
        }
      } else if (message.action === 'ping') {
        // Respond to ping to confirm connection
        port.postMessage({ type: 'pong' });
      }
    });
    
    port.onDisconnect.addListener(() => {
      console.log('Background: Sidebar disconnected');
      sidebarPort = null;
    });
  }
});
