import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { 
  Copy, Check, Send, RotateCcw, Paperclip, X, FileText, 
  Image as ImageIcon, Loader2, Key, Upload, Download, 
  FileJson, History, Plus, MessageSquare, Trash2, Menu
} from 'lucide-react';

interface Attachment {
  file_name: string;
  file_type: string;
  extracted_content?: string;
  image_data?: string;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Attachment[];
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

const API_BASE = 'http://localhost:8000';

export const ChatInterface: React.FC = () => {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const token = localStorage.getItem('app_token');

  const activeSession = sessions.find(s => s.id === activeSessionId) || { messages: [] };

  // 1. Load Sessions from LocalStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('claude_sessions_v3');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSessions(parsed);
        if (parsed.length > 0) setActiveSessionId(parsed[0].id);
        else createNewSession();
      } catch (e) {
        createNewSession();
      }
    } else {
      createNewSession();
    }
  }, []);

  // 2. Persist Sessions to LocalStorage on change
  useEffect(() => {
    if (sessions.length > 0) {
      localStorage.setItem('claude_sessions_v3', JSON.stringify(sessions));
    }
  }, [sessions]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeSession.messages, isLoading, pendingAttachments]);

  const createNewSession = () => {
    const newSession: ChatSession = {
      id: Date.now().toString(),
      title: 'New Conversation',
      messages: [],
      updatedAt: Date.now()
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Delete this chat session permanently?")) return;
    const filtered = sessions.filter(s => s.id !== id);
    setSessions(filtered);
    if (activeSessionId === id) {
      if (filtered.length > 0) setActiveSessionId(filtered[0].id);
      else createNewSession();
    }
  };

  const updateActiveMessages = (msgs: Message[]) => {
    setSessions(prev => prev.map(s => {
      if (s.id === activeSessionId) {
        let title = s.title;
        if (s.title === 'New Conversation' && msgs.length > 0) {
          const firstMsg = msgs.find(m => m.role === 'user');
          if (firstMsg) title = firstMsg.content.slice(0, 30) + (firstMsg.content.length > 30 ? '...' : '');
        }
        return { ...s, messages: msgs, title, updatedAt: Date.now() };
      }
      return s;
    }));
  };

  const uploadFiles = async (files: FileList | File[]) => {
    setIsUploading(true);
    const newAttachments: Attachment[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await axios.post(`${API_BASE}/api/upload`, formData, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          }
        });
        newAttachments.push(res.data);
      } catch (err) {
        console.error("Upload failed", err);
      }
    }

    setPendingAttachments(prev => [...prev, ...newAttachments]);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const blob = items[i].getAsFile();
        if (blob) {
          const file = new File([blob], `pasted_image_${Date.now()}.png`, { type: blob.type });
          imageFiles.push(file);
        }
      }
    }

    if (imageFiles.length > 0) {
      uploadFiles(imageFiles);
    }
  };

  const sendMessage = async (overrideInput?: string) => {
    const activeInput = overrideInput !== undefined ? overrideInput : input;
    if ((!activeInput.trim() && pendingAttachments.length === 0) || isLoading) return;

    // Format attachments for backend
    const formattedAttachments = pendingAttachments.map(att => ({
      type: "text",
      file_name: att.file_name,
      content: att.extracted_content || ""
    }));

    const userMsg: Message = { 
      role: 'user', 
      content: activeInput,
      attachments: [...pendingAttachments]
    };

    const newMsgs = [...activeSession.messages, userMsg];
    updateActiveMessages(newMsgs);
    
    if (overrideInput === undefined) setInput('');
    setPendingAttachments([]);
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          message: activeInput,
          attachments: formattedAttachments
        })
      });

      if (!response.ok) throw new Error('Failed to send message');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) {
                assistantContent += data.text;
                // Update in real-time
                const updatedMsgs: Message[] = [
                  ...newMsgs, 
                  { role: 'assistant', content: assistantContent }
                ];
                updateActiveMessages(updatedMsgs);
              }
            } catch (e) {}
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportWhole = () => {
    let text = `CLAUDE CHAT EXPORT - ${new Date().toLocaleString()}\n`;
    text += "=".repeat(50) + "\n\n";
    activeSession.messages.forEach(m => {
      text += `[${m.role.toUpperCase()}]\n${m.content}\n\n`;
    });
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chat_${activeSessionId}.txt`;
    a.click();
    setShowExportMenu(false);
  };

  const handleExportContext = () => {
    const contextData = {
      type: "CLAUDE_CONTEXT_V1",
      history: activeSession.messages.slice(-10),
      timestamp: Date.now()
    };
    const blob = new Blob([JSON.stringify(contextData)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `context_${activeSessionId}.json`;
    a.click();
    setShowExportMenu(false);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        if (data.type === "CLAUDE_CONTEXT_V1") {
          const sysMsg: Message = { role: 'system', content: `Imported context (${data.history.length} messages)` };
          const contextPrompt = "CONTINUE FROM PREVIOUS CONTEXT:\n\n" + 
            data.history.map((m: any) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
          
          updateActiveMessages([sysMsg]);
          sendMessage(contextPrompt);
        } else {
          alert("Unsupported file format");
        }
      } catch (err) {
        alert("Failed to parse file");
      }
    };
    reader.readAsText(file);
    if (importInputRef.current) importInputRef.current.value = '';
  };

  return (
    <div className="flex h-full w-full bg-white dark:bg-gray-900 overflow-hidden">
      {/* Sidebar for History */}
      {showSidebar && (
        <div className="w-64 flex-shrink-0 border-r dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col animate-in slide-in-from-left duration-300">
          <div className="p-4 border-b dark:border-gray-800">
            <button 
              onClick={createNewSession}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20"
            >
              <Plus size={18} /> New Conversation
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.map(s => (
              <div 
                key={s.id}
                onClick={() => setActiveSessionId(s.id)}
                className={`group relative p-3 rounded-xl cursor-pointer transition-all ${
                  activeSessionId === s.id ? 'bg-white dark:bg-gray-800 shadow-md border dark:border-gray-700' : 'hover:bg-gray-200/50 dark:hover:bg-gray-800/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <MessageSquare size={16} className={activeSessionId === s.id ? 'text-blue-500' : 'text-gray-400'} />
                  <span className={`text-xs font-bold truncate flex-1 ${activeSessionId === s.id ? 'text-gray-900 dark:text-white' : 'text-gray-500'}`}>
                    {s.title}
                  </span>
                  <button 
                    onClick={(e) => deleteSession(s.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div 
        className="flex-1 flex flex-col relative bg-white dark:bg-gray-900"
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); uploadFiles(e.dataTransfer.files); }}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-blue-600/5 backdrop-blur-sm border-4 border-dashed border-blue-500 flex flex-col items-center justify-center pointer-events-none">
             <div className="bg-white dark:bg-gray-800 p-10 rounded-[2.5rem] shadow-2xl flex flex-col items-center gap-4">
               <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-full animate-bounce">
                 <Upload size={40} className="text-blue-500" />
               </div>
               <h3 className="text-2xl font-black dark:text-white">Drop to Attach</h3>
               <p className="text-gray-500 text-sm">Scripts, Documents, or Images</p>
             </div>
          </div>
        )}

        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <button onClick={() => setShowSidebar(!showSidebar)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">
              <Menu size={20} className="text-gray-600 dark:text-gray-400" />
            </button>
            <div className="flex flex-col">
              <h2 className="text-sm font-black tracking-tight text-blue-600 uppercase leading-none">Claude Web</h2>
              <span className="text-[10px] text-gray-400 font-bold mt-1">v3.5 Multi-Session</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <button 
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-all flex items-center gap-2 text-[10px] font-black text-gray-500 tracking-wider"
              >
                <Download size={16} /> EXPORT
              </button>
              {showExportMenu && (
                <div className="absolute right-0 mt-2 w-52 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl shadow-2xl z-[100] py-2 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                  <button onClick={handleExportWhole} className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 text-xs font-bold flex items-center gap-3">
                    <FileText size={16} className="text-blue-500" /> Whole Chat (.txt)
                  </button>
                  <button onClick={handleExportContext} className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 text-xs font-bold flex items-center gap-3 border-t dark:border-gray-700">
                    <FileJson size={16} className="text-purple-500" /> context (.json)
                  </button>
                </div>
              )}
            </div>

            <button 
              onClick={() => importInputRef.current?.click()}
              className="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-all flex items-center gap-2 text-[10px] font-black text-gray-500 tracking-wider"
            >
              <Upload size={16} /> IMPORT
            </button>
            <input type="file" ref={importInputRef} onChange={handleImportFile} className="hidden" accept=".json" />
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth">
          {activeSession.messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-6 animate-in fade-in duration-1000">
              <div className="p-6 bg-gray-50 dark:bg-gray-800/50 rounded-full scale-110 shadow-inner">
                <MessageSquare size={48} className="text-gray-300 dark:text-gray-700" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-gray-600 dark:text-gray-400">Ready for a new session</h3>
                <p className="text-sm text-gray-400 max-w-[280px]">Import a context file or just start typing below to begin.</p>
              </div>
            </div>
          )}
          
          {activeSession.messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : msg.role === 'system' ? 'justify-center' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-300`}>
              <div className={`${msg.role === 'system' ? 'bg-gray-50 dark:bg-gray-800/50 text-[10px] uppercase font-black py-1.5 px-4 tracking-widest border dark:border-gray-700' : 'max-w-[85%] p-5'} rounded-3xl shadow-sm ${
                msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : msg.role === 'system' ? 'text-gray-500' : 'bg-gray-100 dark:bg-gray-800 dark:text-gray-100 rounded-tl-none'
              }`}>
                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {msg.attachments.map((a, idx) => (
                      <div key={idx} className="bg-black/10 dark:bg-white/10 px-3 py-1.5 rounded-xl text-[10px] font-bold flex items-center gap-2">
                        {a.image_data ? <ImageIcon size={12}/> : <FileText size={12}/>}
                        <span className="truncate max-w-[150px]">{a.file_name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="prose dark:prose-invert max-w-none text-sm leading-relaxed">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]} 
                    components={{
                      code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const content = String(children).replace(/\n$/, '');
                        return !inline && match 
                          ? <CodeBlock language={match[1]} value={content} /> 
                          : <code className="bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded-lg font-mono text-xs border dark:border-gray-700" {...props}>{children}</code>;
                      }
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 dark:bg-gray-800 px-5 py-4 rounded-3xl rounded-tl-none flex items-center gap-3">
                <Loader2 className="animate-spin text-blue-500" size={16}/>
                <span className="text-xs font-black text-gray-500 uppercase tracking-widest">Thinking</span>
              </div>
            </div>
          )}
        </div>

        {/* Input Footer */}
        <div className="p-6 bg-white dark:bg-gray-900 border-t dark:border-gray-800">
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-3 mb-6 animate-in slide-in-from-bottom-2">
              {pendingAttachments.map((att, i) => (
                <div key={i} className="group relative bg-white dark:bg-gray-800 p-2.5 rounded-2xl border-2 dark:border-gray-700 shadow-sm flex items-center gap-3 pr-10">
                  <div className="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-xl">
                    {att.image_data ? <ImageIcon size={20} className="text-blue-500"/> : <FileText size={20} className="text-blue-500"/>}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[10px] font-black truncate max-w-[120px] uppercase text-gray-600 dark:text-gray-300">{att.file_name}</span>
                    <span className="text-[9px] text-gray-400 font-bold">{att.file_type.split('/')[1].toUpperCase()}</span>
                  </div>
                  <button 
                    onClick={() => setPendingAttachments(prev => prev.filter((_, idx) => idx !== i))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                  >
                    <X size={16}/>
                  </button>
                </div>
              ))}
            </div>
          )}
          
          <div className="relative group/input">
            <textarea 
              value={input} 
              onChange={e => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Message Claude..."
              className="w-full p-5 pl-14 pr-16 rounded-[2rem] border-2 border-gray-100 dark:border-gray-800 dark:bg-gray-950 focus:border-blue-500 dark:focus:border-blue-600 outline-none transition-all resize-none min-h-[64px] max-h-80 text-sm shadow-sm"
              rows={1}
            />
            
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-full transition-all"
            >
              {isUploading ? <Loader2 className="animate-spin" size={24}/> : <Paperclip size={24}/>}
            </button>
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" multiple accept="image/*,.txt,.py,.js,.ts,.tsx,.css,.html,.md,.json,.csv" />
            
            <button 
              onClick={() => sendMessage()} 
              disabled={isLoading || (!input.trim() && pendingAttachments.length === 0)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-blue-600 text-white rounded-[1.25rem] disabled:opacity-20 hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/30 active:scale-90"
            >
              <Send size={20}/>
            </button>
          </div>
          <p className="text-[10px] text-center text-gray-400 mt-4 font-bold uppercase tracking-widest opacity-50">
            Powered by Claude Web API Enterprise
          </p>
        </div>
      </div>
    </div>
  );
};

const CodeBlock = ({ language, value }: { language: string, value: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => { 
    navigator.clipboard.writeText(value); 
    setCopied(true); 
    setTimeout(() => setCopied(false), 2000); 
  };

  return (
    <div className="relative my-6 rounded-2xl border-2 dark:border-gray-800 bg-gray-950 overflow-hidden shadow-2xl">
      <div className="flex justify-between items-center px-5 py-3 bg-gray-900/80 border-b dark:border-gray-800 text-[10px] font-black text-gray-500 tracking-widest uppercase">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
          <span className="ml-2 font-mono">{language}</span>
        </div>
        <button 
          onClick={copy} 
          className="hover:text-blue-400 transition-colors flex items-center gap-2"
        >
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <SyntaxHighlighter 
        language={language} 
        style={vscDarkPlus} 
        customStyle={{ 
          margin: 0, 
          padding: '1.5rem', 
          background: 'transparent', 
          fontSize: '0.85rem',
          lineHeight: '1.6'
        }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
};
