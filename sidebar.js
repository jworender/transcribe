console.log('Audio Transcriber sidebar loaded');
let isRecording = false;
let backgroundPort = null;
let mediaRecorder = null;
let currentStream = null;
let audioPlaybackNodes = null; // For audio passthrough

// Track the last few transcribed texts to prevent immediate duplicates
let recentTranscripts = [];
const maxRecentTranscripts = 3;
let lastFullTranscript = ''; // Store the complete last transcript for overlap detection

// Summary functionality
let allTranscripts = []; // Store all transcripts for summary generation
let summaryTimer = null;
let lastSummaryTime = 0;
const firstSummaryDelayMs = 120000; // 2 minutes for first summary
const summaryIntervalMs = 30000; // 30 seconds for subsequent summaries
let isFirstSummary = true; // Track if we haven't generated the first summary yet
let baseSummaryWordCount = 200; // Starting summary length
let lastTranscriptLength = 0; // Track transcript growth
let currentSummaryWordCount = 200; // Dynamic summary length
let minTranscriptWordsForGrowth = 400; // Don't grow summary until transcript exceeds this word count

// Silence detection parameters
const silenceThreshold = 0.01;
const silenceTimeoutMs = 3000;
let lastAudioTime = 0;
let silenceCheckInterval = null;
let audioContext = null;
let analyser = null;
let dataArray = null;

// Overlapping recording for continuous audio
let recordingCycles = [];

// Connection monitoring and resilience
let connectionCheckInterval = null;
let lastApiKey = null;
let independentMode = false; // Track if we're running without background connection
let keepAliveInterval = null; // Keep extension alive
let lastTranscriptionTime = 0; // Track transcription activity

const startStopButton = document.getElementById('start-stop');
const statusElement = document.getElementById('status');
statusElement.textContent = 'Click the extension icon first, then click Start';
const transcriptContainer = document.getElementById('transcript');
const summaryContainer = document.getElementById('summary');
const summaryStatusElement = document.getElementById('summary-status');

// Global error handler to prevent crashes
window.addEventListener('error', (event) => {
  console.error('Sidebar: Global error caught:', event.error);
  // Don't let summary errors stop transcription
  if (event.error && event.error.stack && event.error.stack.includes('generateSummary')) {
    console.log('Sidebar: Summary error isolated, continuing transcription');
    event.preventDefault();
  }
});

// Unhandled promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
  console.error('Sidebar: Unhandled promise rejection:', event.reason);
  // Don't let summary promise rejections stop transcription
  if (event.reason && event.reason.stack && event.reason.stack.includes('generateSummary')) {
    console.log('Sidebar: Summary promise rejection isolated, continuing transcription');
    event.preventDefault();
  }
});

// Keep extension alive by preventing service worker suspension
function startKeepAlive() {
  if (keepAliveInterval) return;
  
  keepAliveInterval = setInterval(() => {
    // Ping chrome storage to keep extension active
    chrome.storage.local.get(['keepAlive'], () => {
      console.log('Sidebar: Keep-alive ping');
    });
    
    // Also try to reconnect background if disconnected during recording
    if (isRecording && !backgroundPort) {
      console.log('Sidebar: Background disconnected during recording, attempting reconnection...');
      connectToBackground();
    }
  }, 25000); // Every 25 seconds, before the 30-second timeout
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Enhanced connection monitoring
function startConnectionMonitoring() {
  if (connectionCheckInterval) return;
  
  connectionCheckInterval = setInterval(() => {
    // Check if we're supposed to be recording but haven't had transcription activity
    if (isRecording && Date.now() - lastTranscriptionTime > 15000) {
      console.log('Sidebar: No transcription activity for 15 seconds, checking connection...');
      
      // Try to test the connection
      if (backgroundPort) {
        try {
          backgroundPort.postMessage({ action: 'ping' });
        } catch (err) {
          console.log('Sidebar: Background port failed, switching to independent mode');
          switchToIndependentMode();
        }
      } else {
        console.log('Sidebar: No background port, running in independent mode');
        switchToIndependentMode();
      }
    }
  }, 10000); // Check every 10 seconds
}

function stopConnectionMonitoring() {
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
  }
}

// Switch to independent transcription mode
function switchToIndependentMode() {
  console.log('Sidebar: Switching to independent transcription mode');
  independentMode = true;
  statusElement.textContent = 'Recording in independent mode (connection lost)';
  
  // Continue transcription without background script
  if (isRecording && currentStream && lastApiKey) {
    console.log('Sidebar: Maintaining transcription independently');
    // The recording cycles should continue running
  }
}

// Connect to background script with enhanced reconnection
function connectToBackground() {
  try {
    if (backgroundPort) {
      backgroundPort.disconnect();
    }
    
    backgroundPort = chrome.runtime.connect({ name: "sidebar" });
    console.log('Sidebar: Connected to background script');
    independentMode = false;
    
    backgroundPort.onMessage.addListener((message) => {
      console.log('Sidebar: Received message from background:', message);
      
      switch (message.type) {
        case 'permissionGranted':
          console.log('Sidebar: Permission granted for tab:', message.tabId);
          statusElement.textContent = 'Permission granted - Starting capture...';
          // Actually start the capture when permission is granted
          if (lastApiKey) {
            startLocalCapture(lastApiKey);
          }
          break;
          
        case 'permissionStatusUpdate':
          console.log('Sidebar: Permission status updated, hasPermission:', message.hasPermission);
          if (message.hasPermission) {
            statusElement.textContent = 'Permission granted - Ready to record';
          }
          break;
          
        case 'error':
          handleError(message.message);
          break;
          
        case 'pong':
          console.log('Sidebar: Background connection confirmed');
          break;
      }
    });
    
    backgroundPort.onDisconnect.addListener(() => {
      console.log('Sidebar: Disconnected from background');
      backgroundPort = null;
      
      if (isRecording) {
        console.log('Sidebar: Was recording, switching to independent mode...');
        switchToIndependentMode();
      } else {
        statusElement.textContent = 'Click the extension icon first, then click Start';
        // Attempt reconnection after a short delay
        setTimeout(() => {
          if (!backgroundPort && !independentMode) {
            connectToBackground();
          }
        }, 2000);
      }
    });
    
  } catch (err) {
    console.error('Sidebar: Failed to connect to background:', err);
    if (isRecording) {
      switchToIndependentMode();
    }
  }
}

// Connect when sidebar loads
connectToBackground();

startStopButton.addEventListener('click', () => {
  console.log('StartStop button clicked, isRecording=', isRecording);
  
  if (isRecording) {
    // Stop recording
    stopLocalCapture();
    if (backgroundPort) {
      backgroundPort.postMessage({ action: 'stopCapture' });
    }
    return;
  }

  // Start recording - first check for API key
  chrome.storage.local.get(['openaiApiKey'], (res) => {
    const apiKey = res.openaiApiKey;
    if (!apiKey) {
      statusElement.textContent = 'Missing OpenAI API key - Click Options to set it';
      return;
    }

    lastApiKey = apiKey; // Store for independent mode
    statusElement.textContent = 'Requesting permission and starting capture...';
    
    // First try direct capture
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError) {
        console.error('Sidebar: Direct tab capture failed:', chrome.runtime.lastError);
        
        // If direct capture fails, try background if available
        if (backgroundPort) {
          console.log('Sidebar: Requesting permission from background');
          statusElement.textContent = 'Requesting permission from background...';
          backgroundPort.postMessage({ action: 'requestPermission', apiKey: apiKey });
        } else {
          handleError('No permission and background unavailable - Click the extension icon first');
        }
        return;
      }
      
      if (!stream) {
        console.log('Sidebar: No stream from direct capture');
        if (backgroundPort) {
          backgroundPort.postMessage({ action: 'requestPermission', apiKey: apiKey });
        } else {
          handleError('No audio stream available');
        }
        return;
      }
      
      console.log('Sidebar: Direct audio capture successful');
      startRecordingWithStream(stream, apiKey);
    });
  });
});

function startLocalCapture(apiKey) {
  // This is called when background confirms permission
  console.log('Sidebar: Starting local capture with confirmed permission');
  statusElement.textContent = 'Starting capture with permission...';
  
  chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
    if (chrome.runtime.lastError) {
      console.error('Sidebar: Tab capture failed even with permission:', chrome.runtime.lastError);
      handleError(chrome.runtime.lastError.message);
      return;
    }
    
    if (!stream) {
      handleError('No audio stream received even with permission');
      return;
    }
    
    console.log('Sidebar: Audio capture successful with permission');
    startRecordingWithStream(stream, apiKey);
  });
}

function startRecordingWithStream(stream, apiKey) {
  currentStream = stream;
  lastApiKey = apiKey;
  
  // Set up audio context and passthrough to maintain browser audio
  setupAudioPassthrough(stream);

  // Try different MIME types for better compatibility
  let mimeType = 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    mimeType = 'audio/webm;codecs=opus';
  } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
    mimeType = 'audio/ogg;codecs=opus';
  } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
    mimeType = 'audio/mp4';
  }
  
  const recorderOptions = { mimeType };
  
  isRecording = true;
  startStopButton.textContent = 'Stop';
  statusElement.textContent = 'Recording and transcribing...';
  
  // Start stability measures
  startKeepAlive();
  startConnectionMonitoring();
  
  // Start silence monitoring
  startSilenceMonitoring();
  
  // Clear recent transcripts when starting
  recentTranscripts = [];
  lastFullTranscript = '';
  allTranscripts = [];
  lastSummaryTime = Date.now();
  lastTranscriptionTime = Date.now();
  isFirstSummary = true; // Reset for new recording session
  
  // Reset summary tracking variables
  lastTranscriptLength = 0;
  currentSummaryWordCount = baseSummaryWordCount;
  
  // Update summary status and start summary timer
  summaryStatusElement.textContent = 'First summary in 2 minutes...';
  startSummaryTimer(apiKey);
  
  // Start overlapping recording cycles for continuous audio
  startOverlappingRecording(stream, recorderOptions, apiKey);
}

function startOverlappingRecording(stream, recorderOptions, apiKey) {
  if (!isRecording) return;
  
  // Start first cycle immediately
  startRecordingCycle(stream, recorderOptions, apiKey, 0);
  
  // Start second cycle 3 seconds later (50% overlap)
  setTimeout(() => {
    if (isRecording) {
      startRecordingCycle(stream, recorderOptions, apiKey, 1);
    }
  }, 3000);
}

function startRecordingCycle(stream, recorderOptions, apiKey, cycleId) {
  if (!isRecording) return;
  
  console.log(`Sidebar: Starting recording cycle ${cycleId} with options:`, recorderOptions);
  const recorder = new MediaRecorder(stream, recorderOptions);
  
  recorder.ondataavailable = (event) => {
    console.log(`Sidebar: Cycle ${cycleId} - Received complete audio file, size=`, event.data.size, 'type=', event.data.type);
    if (event.data && event.data.size > 0) {
      // Only transcribe if there was recent audio activity
      if (Date.now() - lastAudioTime < silenceTimeoutMs) {
        transcribeAudio(event.data, apiKey);
        lastTranscriptionTime = Date.now(); // Update activity tracking
      } else {
        console.log(`Sidebar: Cycle ${cycleId} - Skipping transcription due to silence`);
      }
    }
    
    // Start next cycle with 6-second interval (overlapping)
    if (isRecording) {
      setTimeout(() => startRecordingCycle(stream, recorderOptions, apiKey, cycleId), 6000);
    }
  };
  
  recorder.onerror = (event) => {
    console.error(`Sidebar: Cycle ${cycleId} MediaRecorder error:`, event.error);
    if (isRecording) {
      // Try to restart this cycle on error
      setTimeout(() => startRecordingCycle(stream, recorderOptions, apiKey, cycleId), 1000);
    }
  };
  
  // Record for 6 seconds then stop to get complete file
  recorder.start();
  setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, 6000);
  
  // Store current recorder reference
  if (cycleId === 0) {
    mediaRecorder = recorder;
  }
}

function stopLocalCapture() {
  isRecording = false;
  independentMode = false;
  
  // Stop stability measures
  stopKeepAlive();
  stopConnectionMonitoring();
  
  // Stop summary timer
  stopSummaryTimer();
  
  // Stop all active recorders
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
  }
  if (audioContext) {
    audioContext.close();
  }
  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval);
    silenceCheckInterval = null;
  }
  
  mediaRecorder = null;
  currentStream = null;
  audioContext = null;
  analyser = null;
  audioPlaybackNodes = null;
  recordingCycles = [];
  lastApiKey = null;
  startStopButton.textContent = 'Start';
  statusElement.textContent = 'Click the extension icon first, then click Start';
  
  // Update summary status
  summaryStatusElement.textContent = 'Recording stopped';
  
  // Clear recent transcripts when stopping
  recentTranscripts = [];
  lastFullTranscript = '';
}

// Start summary timer with custom timing for first vs subsequent summaries
function startSummaryTimer(apiKey) {
  if (summaryTimer) {
    clearTimeout(summaryTimer);
  }
  
  const delay = isFirstSummary ? firstSummaryDelayMs : summaryIntervalMs;
  console.log(`Sidebar: Starting summary timer, delay: ${delay}ms, isFirstSummary: ${isFirstSummary}`);
  
  summaryTimer = setTimeout(() => {
    if (isRecording && allTranscripts.length > 0) {
      generateSummary(apiKey);
    }
  }, delay);
}

function stopSummaryTimer() {
  if (summaryTimer) {
    clearTimeout(summaryTimer);
    summaryTimer = null;
  }
}

// Generate live summary of transcripts
async function generateSummary(apiKey) {
  if (!isRecording || allTranscripts.length === 0) return;
  
  try {
    console.log('Sidebar: Generating summary from', allTranscripts.length, 'transcript segments');
    
    // Update status
    if (isFirstSummary) {
      summaryStatusElement.textContent = 'Generating first summary...';
    } else {
      summaryStatusElement.textContent = 'Updating summary...';
    }
    
    // Combine all transcripts
    const fullTranscript = allTranscripts.join(' ');
    const transcriptWordCount = fullTranscript.split(/\s+/).length;
    
    // Adjust summary length based on transcript growth
    if (transcriptWordCount > minTranscriptWordsForGrowth && transcriptWordCount > lastTranscriptLength * 1.5) {
      currentSummaryWordCount = Math.min(baseSummaryWordCount + Math.floor((transcriptWordCount - minTranscriptWordsForGrowth) / 100) * 50, 500);
      console.log(`Sidebar: Adjusted summary length to ${currentSummaryWordCount} words based on transcript growth`);
    }
    lastTranscriptLength = transcriptWordCount;
    
    // Create summary prompt
    const summaryPrompt = `Please provide a concise summary of the following transcript in approximately ${currentSummaryWordCount} words. Focus on key topics, main points, and important information:\n\n${fullTranscript}`;
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: summaryPrompt
          }
        ],
        max_tokens: Math.floor(currentSummaryWordCount * 1.5), // Allow some flexibility
        temperature: 0.3
      })
    });
    
    if (!response.ok) {
      throw new Error(`Summary API error: ${response.status}`);
    }
    
    const data = await response.json();
    const summary = data.choices[0].message.content.trim();
    
    // Update summary container
    const timestamp = new Date().toLocaleTimeString();
    summaryContainer.innerHTML = `
      <div style="color: #666; font-size: 0.8em; margin-bottom: 8px;">
        [Updated: ${timestamp}] - ${transcriptWordCount} words transcribed
      </div>
      <div style="line-height: 1.4;">${summary}</div>
    `;
    
    console.log('Sidebar: Summary generated successfully');
    
    // Update status and schedule next summary
    if (isFirstSummary) {
      summaryStatusElement.textContent = 'Summary generated! Next update in 30 seconds...';
      isFirstSummary = false;
    } else {
      summaryStatusElement.textContent = 'Summary updated! Next update in 30 seconds...';
    }
    
    // Schedule next summary
    if (isRecording) {
      startSummaryTimer(apiKey);
    }
    
  } catch (err) {
    console.error('Sidebar: Summary generation failed:', err);
    summaryStatusElement.textContent = 'Summary generation failed - continuing transcription...';
    
    // Still schedule next attempt
    if (isRecording) {
      startSummaryTimer(apiKey);
    }
  }
}

function setupAudioPassthrough(stream) {
  try {
    // Create audio context for both analysis and passthrough
    audioContext = new AudioContext();
    
    // Create source from the captured stream
    const source = audioContext.createMediaStreamSource(stream);
    
    // Set up analyzer for silence detection
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    
    // Create gain node for volume control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0; // Full volume
    
    // Connect the audio path: source -> analyzer -> gain -> destination (speakers)
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Store references for cleanup
    audioPlaybackNodes = { source, analyser, gainNode };
    
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    // Initialize lastAudioTime
    lastAudioTime = Date.now();
    
    console.log('Sidebar: Audio passthrough enabled - browser audio will continue playing');
  } catch (e) {
    console.error('Sidebar: Error setting up audio passthrough:', e);
    // Fallback to basic analysis setup
    setupBasicAudioAnalysis(stream);
  }
}

function setupBasicAudioAnalysis(stream) {
  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    // Initialize lastAudioTime
    lastAudioTime = Date.now();
    
    console.log('Sidebar: Basic audio analysis setup (passthrough failed)');
  } catch (e) {
    console.error('Sidebar: Error setting up audio analysis:', e);
    // Fallback: assume there's always audio
    lastAudioTime = Date.now();
  }
}

function startSilenceMonitoring() {
  silenceCheckInterval = setInterval(() => {
    if (!analyser || !dataArray) {
      // Fallback: assume there's audio activity
      lastAudioTime = Date.now();
      return;
    }
    
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate average volume
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const average = sum / dataArray.length / 255; // Normalize to 0-1
    
    if (average > silenceThreshold) {
      lastAudioTime = Date.now();
    }
  }, 100); // Check every 100ms
}

function handleError(errorMessage) {
  console.error('Sidebar: Received error:', errorMessage);
  
  isRecording = false;
  startStopButton.textContent = 'Start';
  
  // Provide helpful error messages
  if (errorMessage.includes('Extension has not been invoked') || errorMessage.includes('activeTab') || errorMessage.includes('No permission')) {
    statusElement.textContent = 'PERMISSION NEEDED: Click the extension icon first, then try Start again';
  } else if (errorMessage.includes('Chrome pages cannot be captured')) {
    statusElement.textContent = 'Cannot capture from Chrome pages. Go to YouTube, news sites, etc.';
  } else if (errorMessage.includes('No audio')) {
    statusElement.textContent = 'No audio found. Make sure the page has audio playing.';
  } else {
    statusElement.textContent = 'Error: ' + errorMessage;
  }
}

// Enhanced audio transcription with connection resilience
async function transcribeAudio(blob, apiKey) {
  console.log('Sidebar: Transcribing complete audio file, size:', blob.size, 'type:', blob.type);
  
  try {
    // Create form data with complete audio file
    const formData = new FormData();
    
    // Determine file extension based on actual blob type
    let filename, fileType;
    if (blob.type.includes('webm')) {
      filename = 'audio.webm';
      fileType = 'audio/webm';
    } else if (blob.type.includes('ogg')) {
      filename = 'audio.ogg';
      fileType = 'audio/ogg';
    } else if (blob.type.includes('mp4')) {
      filename = 'audio.mp4';
      fileType = 'audio/mp4';
    } else {
      filename = 'audio.webm'; // Default fallback
      fileType = 'audio/webm';
    }
    
    const audioFile = new File([blob], filename, { type: fileType });
    
    formData.append('file', audioFile);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');
    
    console.log('Sidebar: Sending complete file to OpenAI, file name:', audioFile.name, 'file type:', audioFile.type, 'size:', audioFile.size);
    
    // Add timeout and abort controller for better reliability
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 
        'Authorization': 'Bearer ' + apiKey 
      },
      body: formData,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      let errorText = '';
      try {
        const errorJson = await response.json();
        errorText = JSON.stringify(errorJson, null, 2);
      } catch (e) {
        errorText = await response.text();
      }
      
      console.error('Sidebar: Transcription error', response.status, errorText);
      
      // For format errors, show temporary status but continue
      if (response.status === 400) {
        statusElement.textContent = 'Transcription format issue - continuing...';
        setTimeout(() => {
          if (statusElement.textContent.includes('format issue')) {
            if (independentMode) {
              statusElement.textContent = 'Recording in independent mode (connection lost)';
            } else {
              statusElement.textContent = 'Recording and transcribing...';
            }
          }
        }, 3000);
        return;
      }
      
      // For other errors, show to user but don't stop
      console.error('Sidebar: Transcription API error, continuing...');
      return;
    }
    
    const transcription = await response.text();
    if (transcription && transcription.trim()) {
      appendTranscript(transcription.trim());
      
      // Update status to show we're actively transcribing
      if (independentMode) {
        statusElement.textContent = 'Recording in independent mode (transcribing)';
      } else {
        statusElement.textContent = 'Recording and transcribing...';
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Sidebar: Transcription request timed out, continuing...');
    } else {
      console.error('Sidebar: Transcription failed:', err);
    }
    console.log('Sidebar: Continuing despite transcription error');
  }
}

/**
 * Remove overlapping text from new transcript using progressive character comparison
 */
function removeOverlap(lastText, newText) {
  if (!lastText || !newText) return newText;
  
  // Convert to uppercase for comparison (but preserve original case for output)
  const lastUpper = lastText.toUpperCase();
  const newUpper = newText.toUpperCase();
  
  // Start from the end of the last text and work backwards
  // Find the longest matching suffix of lastText that matches a prefix of newText
  let maxOverlapLength = 0;
  let overlapStartInNew = 0;
  
  // We'll check progressively longer suffixes of the last text
  // Start checking from 10 characters to avoid single word matches
  const minOverlapLength = 10;
  const maxCheckLength = Math.min(lastText.length, newText.length, 200); // Limit check to reasonable size
  
  for (let suffixLength = minOverlapLength; suffixLength <= maxCheckLength; suffixLength++) {
    const suffix = lastUpper.slice(-suffixLength); // Get suffix from end of last text
    const prefixEndIndex = newUpper.indexOf(suffix);
    
    if (prefixEndIndex !== -1) {
      // Found a match - check if this is better than our current best
      const overlapLength = suffix.length;
      if (overlapLength > maxOverlapLength) {
        maxOverlapLength = overlapLength;
        overlapStartInNew = prefixEndIndex;
      }
    }
  }
  
  // If we found a significant overlap, remove it from the new text
  if (maxOverlapLength > 0) {
    const cleanNewText = newText.slice(overlapStartInNew + maxOverlapLength).trim();
    console.log(`Sidebar: Found overlap of ${maxOverlapLength} characters, removed from new text`);
    console.log(`Sidebar: Original new text: "${newText}"`);
    console.log(`Sidebar: Cleaned new text: "${cleanNewText}"`);
    return cleanNewText;
  }
  
  return newText;
}

/**
 * Append transcribed text to the transcript container.
 * Uses progressive character comparison to remove overlapping parts.
 */
function appendTranscript(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  
  // If this is not the first transcript, check for overlaps
  let cleanedText = trimmed;
  if (lastFullTranscript) {
    cleanedText = removeOverlap(lastFullTranscript, trimmed);
    
    // If the cleaned text is too short or empty, it might be all overlap
    if (cleanedText.length < 10) {
      console.log('Sidebar: Cleaned text too short, likely all overlap - skipping');
      return;
    }
  }
  
  // Update the last full transcript for next comparison
  lastFullTranscript = trimmed;
  
  // Skip if cleaned text is empty
  if (!cleanedText) {
    console.log('Sidebar: No new content after overlap removal');
    return;
  }
  
  // Add to all transcripts for summary generation
  try {
    allTranscripts.push(cleanedText);
  } catch (err) {
    console.error('Sidebar: Error updating transcripts array (isolated):', err);
  }
  
  // Add timestamp
  const timestamp = new Date().toLocaleTimeString();
  const p = document.createElement('p');
  p.innerHTML = `<span style="color: #666; font-size: 0.8em;">[${timestamp}]</span> ${cleanedText}`;
  transcriptContainer.appendChild(p);
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  
  console.log('Sidebar: Added cleaned transcript:', cleanedText);
}
