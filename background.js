// Background script for Audio Transcriber extension

let activeTabId = null;
let sidebarPort = null;

chrome.action.onClicked.addListener(async (tab) => {
  console.log('Background: Extension icon clicked for tab:', tab.id, tab.url);
  
  // Store the active tab ID (this grants activeTab permission)
  activeTabId = tab.id;
  console.log('Background: activeTabId set to:', activeTabId);
  
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
    console.log('Background: Side panel opened successfully');
  } catch (error) {
    console.error('Background: Failed to open side panel:', error);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Background: Extension installed');
  // Explicitly disable automatic panel opening
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    console.log('Background: Disabled automatic panel opening');
  } catch (error) {
    console.log('Background: Could not set panel behavior:', error);
  }
});

// Handle long-lived connections from sidebar
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidebar") {
    sidebarPort = port;
    console.log('Background: Sidebar connected');
    console.log('Background: Current activeTabId when sidebar connected:', activeTabId);
    
    // If activeTabId is null, try to get the current active tab as emergency fallback
    if (!activeTabId) {
      console.log('Background: activeTabId is null, attempting emergency fallback');
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          activeTabId = tabs[0].id;
          console.log('Background: Emergency fallback - set activeTabId to:', activeTabId);
          // Send message to sidebar that we now have permission
          if (sidebarPort) {
            sidebarPort.postMessage({ 
              type: 'permissionStatusUpdate', 
              hasPermission: true,
              tabId: activeTabId 
            });
          }
        }
      });
    }
    
    port.onMessage.addListener((message) => {
      console.log('Background: Received message:', message);
      
      if (message.action === 'stopCapture') {
        console.log('Background: Received stop capture message');
      } else if (message.action === 'requestPermission') {
        // Sidebar is requesting permission - try to get current tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            activeTabId = tabs[0].id;
            console.log('Background: Permission requested - set activeTabId to:', activeTabId);
            port.postMessage({ 
              type: 'permissionGranted', 
              tabId: activeTabId 
            });
          } else {
            port.postMessage({ 
              type: 'error', 
              message: 'Could not get current tab for permission' 
            });
          }
        });
      }
    });
    
    port.onDisconnect.addListener(() => {
      console.log('Background: Sidebar disconnected');
      sidebarPort = null;
    });
  }
});
