import { useState, useRef, useEffect } from 'react';
import { Rocket, Send, Loader2, CheckCircle2, XCircle, CircleSlash, Circle } from 'lucide-react';

interface StepResult {
  label: string;
  status: 'running' | 'done' | 'error' | 'blocked';
  output?: string;
}

interface ChatMessage {
  id: string;
  type: 'user' | 'assistant';
  text: string;
  error?: string;
  steps?: StepResult[];
}

interface AccountSummary {
  platform: string;
  username?: string;
}

interface CreatorOSPanelProps {
  sessionId: string | null;
  ensureSession: () => Promise<string>;
}

const GREETING = "what is your Creator OS api key? if you dont have one yet, you can get it at creatoros.ca";
const REMEMBER_KEY = 'hyperedit-creatoros-connected';

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const EXAMPLE_PROMPTS = [
  'Download the video in the timeline and upload it to all socials',
  'List my connected accounts',
  'Show my post analytics from the last week',
];

// This panel always ASKS for the API key up front for anyone who hasn't
// connected through this exact chat before — it never trusts an unrelated
// credential that happens to be sitting on disk. Once the user does type
// their key in here, we remember that (this is a local single-user dev
// tool, so a "stay connected across reloads" convenience is fine here) via
// a flag in localStorage, and silently re-verify it with the server on
// mount instead of asking again.
export default function CreatorOSPanel({ sessionId, ensureSession }: CreatorOSPanelProps) {
  const [sid, setSid] = useState<string | null>(sessionId);
  const [initialized, setInitialized] = useState(false);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    localStorage.getItem(REMEMBER_KEY) === '1' ? [] : [{ id: newId(), type: 'assistant', text: GREETING }]
  );
  const [isBusy, setIsBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(localStorage.getItem(REMEMBER_KEY) === '1');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Keep in sync with the app's session (e.g. created elsewhere by uploading a video),
  // but never require one to exist before the user can hand over their API key.
  useEffect(() => {
    if (sessionId) setSid(sessionId);
  }, [sessionId]);

  // Only runs once, and only if this browser previously completed a real
  // connect through this chat — never an unconditional check.
  useEffect(() => {
    if (localStorage.getItem(REMEMBER_KEY) !== '1') return;
    let cancelled = false;
    (async () => {
      try {
        const activeSid = sid ?? await ensureSession();
        if (cancelled) return;
        setSid(activeSid);

        const response = await fetch(`http://localhost:3333/session/${activeSid}/creatoros/status`);
        const data = await response.json();
        if (cancelled) return;

        if (data.initialized) {
          setInitialized(true);
          setAccounts(data.accountSummary || []);
          setMessages([{ id: newId(), type: 'assistant', text: 'Welcome back — still connected to CreatorOS. Tell me what to do.' }]);
        } else {
          localStorage.removeItem(REMEMBER_KEY);
          setMessages([{ id: newId(), type: 'assistant', text: GREETING }]);
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem(REMEMBER_KEY);
          setMessages([{ id: newId(), type: 'assistant', text: GREETING }]);
        }
      } finally {
        if (!cancelled) setReconnecting(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (apiKey: string) => {
    setIsBusy(true);
    try {
      const activeSid = sid ?? await ensureSession();
      setSid(activeSid);

      const response = await fetch(`http://localhost:3333/session/${activeSid}/creatoros/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to connect');
      }

      setInitialized(true);
      setAccounts(data.accountSummary || []);
      localStorage.setItem(REMEMBER_KEY, '1');

      const accountLines = (data.accountSummary || []).length > 0
        ? (data.accountSummary as AccountSummary[])
            .map((a) => `• ${a.platform}${a.username ? ` @${a.username}` : ''}`)
            .join('\n')
        : 'No connected accounts found yet — connect some in the CreatorOS iOS app.';

      setMessages(prev => [
        ...prev,
        {
          id: newId(),
          type: 'assistant',
          text: `Connected (${data.maskedKey}). Here's what I found:\n\n${accountLines}\n\nTell me what to do — e.g. "download the video in the timeline and upload to all socials".`,
        },
      ]);
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          id: newId(),
          type: 'assistant',
          text: `Couldn't connect: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      ]);
    } finally {
      setIsBusy(false);
    }
  };

  // Streams live progress: the job runs server-side (a render + social
  // publish can take minutes), so we start it, get a jobId back immediately,
  // and poll for status — updating the same message bubble in place as each
  // step starts/finishes — instead of waiting on one response at the end.
  const sendChat = async (prompt: string) => {
    if (!sid) return;
    setIsBusy(true);

    const messageId = newId();
    setMessages(prev => [...prev, { id: messageId, type: 'assistant', text: '', steps: [] }]);

    const updateMessage = (patch: Partial<ChatMessage>) => {
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, ...patch } : m)));
    };

    try {
      const startResponse = await fetch(`http://localhost:3333/session/${sid}/creatoros/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const startData = await startResponse.json();
      if (!startResponse.ok) {
        throw new Error(startData.error || 'Failed to start command');
      }

      const jobId = startData.jobId;
      let done = false;
      while (!done) {
        await new Promise(resolve => setTimeout(resolve, 700));

        const statusResponse = await fetch(`http://localhost:3333/session/${sid}/creatoros/chat/status/${jobId}`);
        const statusData = await statusResponse.json();
        if (!statusResponse.ok) {
          throw new Error(statusData.error || 'Lost track of the job');
        }

        updateMessage({
          text: statusData.message || '',
          steps: statusData.steps || [],
        });

        if (statusData.status === 'complete' || statusData.status === 'error') {
          done = true;
          if (statusData.error) {
            updateMessage({ error: statusData.error, text: statusData.message || `Error: ${statusData.error}` });
          } else if (!statusData.message && !(statusData.steps || []).length) {
            updateMessage({ text: "I didn't take any action." });
          }
        }
      }
    } catch (error) {
      updateMessage({
        text: `Sorry, I hit an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy || reconnecting) return;

    const value = input.trim();
    setInput('');

    if (!initialized) {
      setMessages(prev => [...prev, { id: newId(), type: 'user', text: '🔑 API key entered' }]);
      await connect(value);
      return;
    }

    setMessages(prev => [...prev, { id: newId(), type: 'user', text: value }]);
    await sendChat(value);
  };

  const StepIcon = ({ status }: { status: StepResult['status'] }) => {
    if (status === 'running') return <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin flex-shrink-0" />;
    if (status === 'done') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />;
    if (status === 'error') return <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />;
    return <CircleSlash className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />;
  };

  return (
    <div className="flex flex-col h-full bg-zinc-900/80">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-gradient-to-br from-zinc-400 to-zinc-300 rounded-lg flex items-center justify-center">
            <Rocket className="w-4 h-4" />
          </div>
          <h2 className="font-semibold">Creator OS</h2>
          {initialized && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
              <Circle className="w-2 h-2 fill-current" />
              Connected
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400">
          {initialized
            ? `Publish to ${accounts.length || 'your'} connected account${accounts.length === 1 ? '' : 's'}`
            : 'Connect your CreatorOS account to publish and schedule posts'}
        </p>
      </div>

      {/* Processing overlay */}
      {(isBusy || reconnecting) && (
        <div className="p-4 bg-zinc-400/10 border-b border-zinc-400/20">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-zinc-300 animate-spin" />
            <p className="text-sm text-zinc-200 font-medium">
              {reconnecting ? 'Reconnecting…' : initialized ? 'Working on it…' : 'Validating key…'}
            </p>
          </div>
        </div>
      )}

      {/* Chat history */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {messages.map((message, idx) => (
          <div key={idx} className="space-y-2">
            {message.type === 'user' ? (
              <div className="flex justify-end">
                <div className="bg-gradient-to-r from-zinc-400 to-zinc-300 rounded-lg px-3 py-2 max-w-[85%]">
                  <p className="text-sm text-white">{message.text}</p>
                </div>
              </div>
            ) : (
              <div className={`bg-zinc-800 rounded-lg p-3 space-y-2 ${message.error ? 'border border-red-500/30' : ''}`}>
                {message.text && (
                  <p className={`text-sm whitespace-pre-wrap ${message.error ? 'text-red-200' : 'text-zinc-200'}`}>
                    {message.text}
                  </p>
                )}
                {message.steps && message.steps.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {message.steps.map((step, sIdx) => (
                      <div key={sIdx} className="flex items-start gap-2">
                        <StepIcon status={step.status} />
                        <span className={`text-xs font-mono leading-relaxed ${
                          step.status === 'error' ? 'text-red-300' : step.status === 'blocked' ? 'text-amber-300' : 'text-zinc-400'
                        }`}>
                          {step.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {initialized && messages.length <= 1 && (
          <div className="px-1 space-y-2">
            <p className="text-xs text-zinc-500">Try:</p>
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                onClick={() => setInput(example)}
                className="block w-full text-left px-3 py-2 bg-zinc-800/60 hover:bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors"
              >
                "{example}"
              </button>
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-zinc-800/50">
        <div className="bg-zinc-800 rounded-xl border border-zinc-700/50 focus-within:ring-2 focus-within:ring-zinc-400/50 transition-all">
          {!initialized ? (
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="sk_••••••••••••••••••••••••••••"
              className="w-full px-3 py-3 bg-transparent text-sm resize-none focus:outline-none placeholder:text-zinc-500 font-mono"
              disabled={isBusy || reconnecting}
              autoComplete="off"
            />
          ) : (
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tell me what to publish…"
              className="w-full px-3 pt-3 pb-2 bg-transparent text-sm resize-none focus:outline-none placeholder:text-zinc-500"
              rows={2}
              disabled={isBusy || reconnecting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
          )}

          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-[10px] text-zinc-500 px-1">
              {!initialized ? 'Key is stored locally by the CLI, never by this app' : 'Enter to send'}
            </span>
            <button
              type="submit"
              disabled={!input.trim() || isBusy || reconnecting}
              className="w-8 h-8 bg-gradient-to-r from-zinc-400 to-zinc-300 disabled:from-zinc-700 disabled:to-zinc-700 rounded-lg flex items-center justify-center transition-all hover:shadow-lg hover:shadow-zinc-400/50 disabled:shadow-none flex-shrink-0"
            >
              {isBusy ? (
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
