# Audio Transcriber Chrome Extension

This extension captures audio from the active tab, transcribes it using OpenAI's Whisper API, and displays the transcript in a sidebar panel.

## Features

- **Sidebar Display**: Opens as a proper Chrome sidebar instead of a popup window
- **Smart Duplicate Prevention**: Avoids repeating the same phrases multiple times
- **Silence Detection**: Only transcribes when there's actual audio activity
- **Real-time Transcription**: Shows transcripts with timestamps as they're generated
- **Audio Passthrough**: You can still hear the original audio while transcribing

## Installation

1. Clone or download the extension folder.
2. In Chrome, navigate to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this extension folder.
5. Click **Details** on the extension card and open **Options** to set your OpenAI API key.
6. Click the extension icon in the toolbar to open the sidebar.
7. Press **Start** to begin transcription.

## Permissions

- `tabCapture`: Capture audio from tabs.
- `storage`: Store your API key.
- `sidePanel`: Display content in Chrome's sidebar.
- Access to `https://api.openai.com/` for transcription calls.

## Usage

1. Navigate to any webpage with audio content (YouTube, streaming sites, etc.)
2. Click the extension icon to open the sidebar
3. Click **Start** to begin recording and transcription
4. The extension will automatically detect when there's audio and transcribe it
5. Transcripts appear in real-time with timestamps
6. Click **Stop** when you're done

## Technical Improvements

- **Fixed Audio Overlap**: Removed the WebM header prepending that caused repeated phrases
- **Silence Detection**: Uses Web Audio API to detect when audio is actually playing
- **Better Deduplication**: Content-based duplicate detection prevents repetitive transcriptions
- **Optimized Chunking**: Shorter 3-second chunks for more responsive transcription
- **Proper Sidebar**: Uses Chrome's sidePanel API instead of popup

## Troubleshooting

- Make sure you have a valid OpenAI API key set in the extension options
- The extension requires permission to capture tab audio - make sure to allow this when prompted
- If transcription seems slow, check your internet connection and OpenAI API status
