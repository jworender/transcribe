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
const summaryIntervalMs = 30000; // 30 seconds
let baseSummaryWordCount = 300; // Starting summary length
let lastTranscriptLength = 0; // Track transcript growth
let currentSummaryWordCount = 300; // Dynamic summary length

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

const startStopButton = document.getElementById('start-stop');
const statusElement = document.getElementById('status');
statusElement.textContent = 'Ready - Click the extension icon to grant permissions';
const transcriptContainer = document.getElementById('transcript');
const summaryContainer = document.getElementById('summary');
const summaryStatusElement = document.getElementById('summary-status');

// Connect to background script
function connectToBackground() {
  backgroundPort = chrome.runtime.connect({ name: "sidebar" });
  
  backgroundPort.onMessage.addListener((message) => {
    console.log('Sidebar: Received message from background:', message);
    
    switch (message.type) {
      case 'permissionGranted':
        console.log('Sidebar: Permission granted for tab:', message.tabId);
        statusElement.textContent = 'Permission granted - Ready to record';
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
    }
  });
  
  backgroundPort.onDisconnect.addListener(() => {
    console.log('Sidebar: Disconnected from background');
    backgroundPort = null;
    stopLocalCapture();
    statusElement.textContent = 'Connection lost - Refresh to reconnect';
  });
}

// Connect when sidebar loads
connectToBackground();

startStopButton.addEventListener('click', () => {
  console.log('StartStop button clicked, isRecording=', isRecording);
  
  if (!backgroundPort) {
    statusElement.textContent = 'Connection error - Try refreshing the page';
    return;
  }
  
  if (isRecording) {
    // Stop recording
    stopLocalCapture();
    backgroundPort.postMessage({ action: 'stopCapture' });
    return;
  }

  // Start recording - first check for API key
  chrome.storage.local.get(['openaiApiKey'], (res) => {
    const apiKey = res.openaiApiKey;
    if (!apiKey) {
      statusElement.textContent = 'Missing OpenAI API key - Click Options to set it';
      return;
    }

    statusElement.textContent = 'Requesting permission and starting capture...';
    
    // First try direct capture
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError) {
        console.error('Sidebar: Direct tab capture failed:', chrome.runtime.lastError);
        
        // If direct capture fails, request permission from background
        console.log('Sidebar: Requesting permission from background');
        statusElement.textContent = 'Requesting permission from background...';
        backgroundPort.postMessage({ action: 'requestPermission', apiKey: apiKey });
        return;
      }
      
      if (!stream) {
        console.log('Sidebar: No stream from direct capture, requesting permission from background');
        backgroundPort.postMessage({ action: 'requestPermission', apiKey: apiKey });
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
  statusElement.textContent = 'Recording and transcribing... (Audio playback maintained)';
  
  // Start silence monitoring
  startSilenceMonitoring();
  
  // Clear recent transcripts when starting
  recentTranscripts = [];
  lastFullTranscript = '';
  allTranscripts = [];
  lastSummaryTime = Date.now();
  
  // Reset summary tracking variables
  lastTranscriptLength = 0;
  currentSummaryWordCount = baseSummaryWordCount;
  
  // Update summary status
  summaryStatusElement.textContent = 'Recording started...';
  
  // Start summary timer
  startSummaryTimer(apiKey);
  
  // Start overlapping recording cycles for continuous audio
  startOverlappingRecording(stream, recorderOptions, apiKey);
}

function startSummaryTimer(apiKey) {
  // Clear any existing timer
  if (summaryTimer) {
    clearInterval(summaryTimer);
  }
  
  summaryTimer = setInterval(() => {
    if (isRecording && allTranscripts.length > 0) {
      generateSummary(apiKey);
    }
  }, summaryIntervalMs);
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
  
  // Stop summary timer
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  
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
  startStopButton.textContent = 'Start';
  statusElement.textContent = 'Stopped';
  
  // Update summary status
  summaryStatusElement.textContent = 'Recording stopped';
  
  // Clear recent transcripts when stopping
  recentTranscripts = [];
  lastFullTranscript = '';
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
  if (errorMessage.includes('Extension has not been invoked') || errorMessage.includes('activeTab')) {
    statusElement.textContent = 'Permission denied. Try: 1) Close sidebar 2) Click extension icon 3) Try again';
  } else if (errorMessage.includes('Chrome pages cannot be captured')) {
    statusElement.textContent = 'Cannot capture from Chrome pages. Go to YouTube, news sites, etc.';
  } else if (errorMessage.includes('No audio')) {
    statusElement.textContent = 'No audio found. Make sure the page has audio playing.';
  } else {
    statusElement.textContent = 'Error: ' + errorMessage;
  }
}

// Audio transcription with complete files from overlapping recording
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
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 
        'Authorization': 'Bearer ' + apiKey 
      },
      body: formData
    });
    
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
            statusElement.textContent = 'Recording and transcribing... (Audio playback maintained)';
          }
        }, 3000);
        return;
      }
      
      // For other errors, show to user
      statusElement.textContent = `Transcription Error ${response.status}`;
      return;
    }
    
    const transcription = await response.text();
    if (transcription && transcription.trim()) {
      appendTranscript(transcription.trim());
    }
  } catch (err) {
    console.error('Sidebar: Transcription failed:', err);
    console.log('Sidebar: Continuing despite transcription error');
  }
}

// Generate summary using OpenAI GPT with proportional growth
async function generateSummary(apiKey) {
  if (allTranscripts.length === 0) return;
  
  try {
    summaryStatusElement.textContent = 'Generating summary...';
    summaryStatusElement.className = 'summary-loading';
    
    // Combine all transcripts into a single text
    const allText = allTranscripts.join(' ');
    const currentTranscriptLength = allText.length;
    
    // Calculate proportional growth for summary word count
    if (lastTranscriptLength > 0) {
      const growthRatio = currentTranscriptLength / lastTranscriptLength;
      currentSummaryWordCount = Math.round(currentSummaryWordCount * growthRatio);
      
      // Cap at reasonable maximum to avoid token limits
      currentSummaryWordCount = Math.min(currentSummaryWordCount, 800);
      
      console.log(`Sidebar: Transcript grew from ${lastTranscriptLength} to ${currentTranscriptLength} chars (${(growthRatio * 100).toFixed(1)}% growth)`);
      console.log(`Sidebar: Summary target updated to ${currentSummaryWordCount} words`);
    }
    
    // Update tracking variable for next iteration
    lastTranscriptLength = currentTranscriptLength;
    
    // Limit text length to avoid token limits (approximately 3000 tokens)
    const maxLength = 12000; // roughly 3000 tokens
    const textToSummarize = allText.length > maxLength ? 
      allText.slice(-maxLength) : allText;
    
    console.log('Sidebar: Generating summary for', textToSummarize.length, 'characters, target length:', currentSummaryWordCount, 'words');
    
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
            role: 'system',
            content: `You are a helpful assistant that creates comprehensive summaries of audio transcriptions. Focus on key points, main topics, and important information. Keep the summary clear and well-organized. Target approximately ${currentSummaryWordCount} words in your summary.`
          },
          {
            role: 'user',
            content: `Please provide a comprehensive summary of approximately ${currentSummaryWordCount} words for the following audio transcription:\n\n${textToSummarize}`
          }
        ],
        max_tokens: Math.min(Math.round(currentSummaryWordCount * 1.3), 1000), // Allow some flexibility in token limit
        temperature: 0.3
      })
    });
    
    if (!response.ok) {
      let errorText = '';
      try {
        const errorJson = await response.json();
        errorText = errorJson.error?.message || JSON.stringify(errorJson);
      } catch (e) {
        errorText = await response.text();
      }
      
      console.error('Sidebar: Summary generation error', response.status, errorText);
      summaryStatusElement.textContent = `Summary error: ${response.status}`;
      summaryStatusElement.className = 'summary-error';
      return;
    }
    
    const result = await response.json();
    const summary = result.choices?.[0]?.message?.content;
    
    if (summary) {
      updateSummary(summary);
      const now = new Date();
      const wordCount = summary.split(/\s+/).length;
      summaryStatusElement.textContent = `Updated ${now.toLocaleTimeString()} (${wordCount} words)`;
      summaryStatusElement.className = '';
      lastSummaryTime = Date.now();
    } else {
      console.error('Sidebar: No summary content received');
      summaryStatusElement.textContent = 'Summary generation failed';
      summaryStatusElement.className = 'summary-error';
    }
    
  } catch (err) {
    console.error('Sidebar: Summary generation failed:', err);
    summaryStatusElement.textContent = 'Summary generation failed';
    summaryStatusElement.className = 'summary-error';
  }
}

function updateSummary(summaryText) {
  summaryContainer.innerHTML = summaryText;
  console.log('Sidebar: Updated summary:', summaryText);
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
  allTranscripts.push(cleanedText);
  
  // Update summary status to show progress
  if (allTranscripts.length === 1) {
    summaryStatusElement.textContent = 'Collecting transcripts...';
  } else {
    const timeUntilNextSummary = Math.max(0, summaryIntervalMs - (Date.now() - lastSummaryTime));
    const secondsRemaining = Math.ceil(timeUntilNextSummary / 1000);
    summaryStatusElement.textContent = `Next summary in ${secondsRemaining}s`;
  }
  
  // Add timestamp
  const timestamp = new Date().toLocaleTimeString();
  const p = document.createElement('p');
  p.innerHTML = `<span style="color: #666; font-size: 0.8em;">[${timestamp}]</span> ${cleanedText}`;
  transcriptContainer.appendChild(p);
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  
  console.log('Sidebar: Added cleaned transcript:', cleanedText);
}
