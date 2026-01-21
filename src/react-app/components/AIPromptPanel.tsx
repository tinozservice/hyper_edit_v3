import { useState } from 'react';
import { Sparkles, Send, Wand2, Clock, Terminal, CheckCircle, Loader2, VolumeX, FileVideo } from 'lucide-react';

interface TranscriptKeyword {
  keyword: string;
  timestamp: number;
  confidence: number;
  gifUrl?: string;
  assetId?: string;
}

interface ChatMessage {
  type: 'user' | 'assistant';
  text: string;
  command?: string;
  explanation?: string;
  applied?: boolean;
  // For auto-GIF workflow
  extractedKeywords?: TranscriptKeyword[];
  isProcessingGifs?: boolean;
}

interface AIPromptPanelProps {
  onApplyEdit?: (command: string) => Promise<void>;
  onExtractKeywordsAndAddGifs?: () => Promise<void>;
  isApplying?: boolean;
  applyProgress?: number;
  applyStatus?: string;
  hasVideo?: boolean;
}

export default function AIPromptPanel({
  onApplyEdit,
  onExtractKeywordsAndAddGifs,
  isApplying,
  applyProgress,
  applyStatus,
  hasVideo
}: AIPromptPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  const suggestions = [
    { icon: VolumeX, text: 'Remove dead air / silence' },
    { icon: Wand2, text: 'Remove background noise' },
    { icon: Clock, text: 'Speed up by 1.5x' },
    { icon: FileVideo, text: 'Add GIF animations' },
  ];

  // Check if prompt is asking for auto-GIF extraction
  const isAutoGifPrompt = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes('add gif') ||
      lower.includes('gif animation') ||
      lower.includes('extract keyword') ||
      lower.includes('find keyword') ||
      lower.includes('auto gif') ||
      lower.includes('smart gif') ||
      lower.includes('overlay gif') ||
      lower.includes('brand gif')
    );
  };

  // Poll for job completion
  const pollForResult = async (jobId: string, maxAttempts = 60): Promise<any> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      setProcessingStatus(`AI is working... (${attempt + 1}s)`);

      try {
        const response = await fetch(`/api/ai-edit/status/${jobId}`);
        if (!response.ok) {
          throw new Error(`Status check failed: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === 'complete') {
          return data;
        }

        if (data.status === 'error') {
          throw new Error(data.error || 'Processing failed');
        }

        // Still processing, wait and try again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // On network error, wait and retry
        console.error('Poll error:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Request timed out after 60 seconds');
  };

  // Handle the auto-GIF workflow
  const handleAutoGifWorkflow = async () => {
    if (!onExtractKeywordsAndAddGifs) return;

    setIsProcessing(true);
    setProcessingStatus('Starting keyword extraction...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: 'Analyzing your video for keywords and brands...',
        isProcessingGifs: true,
      }]);

      await onExtractKeywordsAndAddGifs();

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: 'Keywords extracted, GIFs found, and added to your timeline!',
            isProcessingGifs: false,
            applied: true,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Auto-GIF workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    const userMessage = prompt.trim();
    setPrompt('');

    // Add user message to chat
    setChatHistory((prev) => [...prev, { type: 'user', text: userMessage }]);

    // Check if this is an auto-GIF request
    if (isAutoGifPrompt(userMessage)) {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then transcribe it, extract keywords (like brand names), find relevant GIFs, and add them to your timeline automatically.',
        }]);
        return;
      }

      await handleAutoGifWorkflow();
      return;
    }

    // Regular AI edit flow
    setIsProcessing(true);
    setProcessingStatus('Starting AI...');

    try {
      // Start the job
      const startResponse = await fetch('/api/ai-edit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMessage }),
      });

      if (!startResponse.ok) {
        const errorText = await startResponse.text();
        console.error('Start error:', startResponse.status, errorText);
        throw new Error(`Failed to start: ${startResponse.status}`);
      }

      const { jobId } = await startResponse.json();

      if (!jobId) {
        throw new Error('No job ID returned');
      }

      // Poll for the result
      const data = await pollForResult(jobId);

      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: data.explanation,
          command: data.command,
          explanation: data.explanation,
          applied: false,
        },
      ]);
    } catch (error) {
      console.error('AI request error:', error);
      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
        },
      ]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const handleApplyEdit = async (command: string, messageIndex: number) => {
    if (!onApplyEdit || !hasVideo) return;

    try {
      await onApplyEdit(command);
      // Mark this message as applied
      setChatHistory((prev) =>
        prev.map((msg, idx) => (idx === messageIndex ? { ...msg, applied: true } : msg))
      );
    } catch (error) {
      console.error('Failed to apply edit:', error);
      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: `Failed to apply edit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ]);
    }
  };

  return (
    <div className="h-full bg-zinc-900/80 border-l border-zinc-800/50 flex flex-col backdrop-blur-sm">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-amber-500 rounded-lg flex items-center justify-center">
            <Sparkles className="w-4 h-4" />
          </div>
          <h2 className="font-semibold">HyperEdit AI</h2>
        </div>
        <p className="text-xs text-zinc-400">
          Describe what you want to do with your video
        </p>
      </div>

      {/* Quick suggestions */}
      {chatHistory.length === 0 && (
        <div className="p-4 space-y-2 border-b border-zinc-800/50">
          <p className="text-xs text-zinc-500 font-medium">Quick actions</p>
          {suggestions.map((suggestion, idx) => (
            <button
              key={idx}
              onClick={() => setPrompt(suggestion.text)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-sm text-left transition-colors group"
            >
              <suggestion.icon className="w-4 h-4 text-zinc-400 group-hover:text-orange-400 transition-colors" />
              <span className="text-zinc-300">{suggestion.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* Processing overlay */}
      {isApplying && (
        <div className="p-4 bg-orange-500/10 border-b border-orange-500/20">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
            <div className="flex-1">
              <p className="text-sm text-orange-200 font-medium">
                {applyStatus || 'Processing video...'}
              </p>
              {(applyProgress ?? 0) > 0 && (
                <>
                  <div className="mt-2 h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-300"
                      style={{ width: `${applyProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">{applyProgress}% complete</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chat history */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {chatHistory.length === 0 ? (
          <div className="text-center text-sm text-zinc-500 py-8">
            {hasVideo
              ? "No edits yet. Try 'Add GIF animations' to auto-extract keywords!"
              : 'Upload a video first to start editing with AI'}
          </div>
        ) : (
          chatHistory.map((message, idx) => (
            <div key={idx} className="space-y-2">
              {message.type === 'user' ? (
                <div className="flex justify-end">
                  <div className="bg-gradient-to-r from-orange-500 to-amber-500 rounded-lg px-3 py-2 max-w-[85%]">
                    <p className="text-sm text-white">{message.text}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                    <p className="text-sm text-zinc-200">{message.text}</p>

                    {/* Processing GIFs indicator */}
                    {message.isProcessingGifs && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-orange-400">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Transcribing video...</span>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          1. Extracting audio and transcribing<br />
                          2. Finding keywords and brands<br />
                          3. Searching for relevant GIFs<br />
                          4. Adding to timeline at correct timestamps
                        </div>
                      </div>
                    )}

                    {/* Show extracted keywords */}
                    {message.extractedKeywords && message.extractedKeywords.length > 0 && (
                      <div className="mt-2 space-y-2">
                        <div className="text-[10px] text-zinc-500 font-medium">Found keywords:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {message.extractedKeywords.map((kw, i) => (
                            <span
                              key={i}
                              className="px-2 py-1 bg-zinc-700/50 rounded text-[11px] text-zinc-300"
                              title={`At ${Math.floor(kw.timestamp / 60)}:${String(Math.floor(kw.timestamp % 60)).padStart(2, '0')}`}
                            >
                              {kw.keyword} @ {Math.floor(kw.timestamp / 60)}:{String(Math.floor(kw.timestamp % 60)).padStart(2, '0')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Success indicator for GIF workflow */}
                    {message.applied && !message.command && (
                      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                        <CheckCircle className="w-3 h-3" />
                        GIFs added to timeline
                      </div>
                    )}

                    {/* FFmpeg command */}
                    {message.command && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-zinc-400">
                          <Terminal className="w-3 h-3" />
                          <span>FFmpeg Command</span>
                        </div>
                        <div className="bg-zinc-900 rounded p-2 font-mono text-xs text-orange-400 overflow-x-auto">
                          {message.command}
                        </div>
                        {message.applied ? (
                          <div className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                            <CheckCircle className="w-3 h-3" />
                            Edit Applied
                          </div>
                        ) : (
                          <button
                            onClick={() => handleApplyEdit(message.command!, idx)}
                            disabled={isApplying || !hasVideo}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:from-zinc-700 disabled:to-zinc-700 rounded-lg text-xs font-medium transition-all"
                          >
                            {isApplying ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Processing...
                              </>
                            ) : (
                              <>
                                <CheckCircle className="w-3 h-3" />
                                Apply Edit
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        {isProcessing && (
          <div className="bg-zinc-800 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <div className="w-4 h-4 border-2 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
              <span>{processingStatus || 'Thinking...'}</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-zinc-800/50">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={hasVideo ? "Try: 'Add GIF animations' to auto-extract keywords..." : "Upload a video first..."}
            className="w-full px-4 py-3 pr-12 bg-zinc-800 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-zinc-500"
            rows={3}
            disabled={isProcessing || !hasVideo}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <button
            type="submit"
            disabled={!prompt.trim() || isProcessing || !hasVideo}
            className="absolute bottom-3 right-3 w-8 h-8 bg-gradient-to-r from-orange-500 to-amber-500 disabled:from-zinc-700 disabled:to-zinc-700 rounded-lg flex items-center justify-center transition-all hover:shadow-lg hover:shadow-orange-500/50 disabled:shadow-none"
          >
            {isProcessing ? (
              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Press Enter to send, Shift+Enter for new line
        </p>
      </form>
    </div>
  );
}
