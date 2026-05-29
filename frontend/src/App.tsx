import React, { useState } from 'react';
import axios from 'axios';
import { MessageSquare, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { ChatInterface } from './components/ChatInterface';
import { Settings } from './components/Settings';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function App() {
  const [token, setToken] = useState(localStorage.getItem('app_token'));
  const [password, setPassword] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'settings'>('chat');
  const [error, setError] = useState('');
  const [backendDown, setBackendDown] = useState(false);

  React.useEffect(() => {
    const checkBackend = async () => {
      try {
        // Use a valid GET endpoint for health check
        await axios.get(`${API_BASE}/api/status`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setBackendDown(false);
      } catch (err: any) {
        // If it's a 401, the backend is up but we just aren't logged in
        if (err.response && err.response.status === 401) {
          setBackendDown(false);
        } else if (!err.response) {
          setBackendDown(true);
        }
      }
    };
    checkBackend();
  }, [token]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await axios.post(`${API_BASE}/api/login`, { password });
      const newToken = res.data.token;
      localStorage.setItem('app_token', newToken);
      setToken(newToken);
      setError('');
      setBackendDown(false);
    } catch (err: any) {
      if (!err.response) {
        setError('Backend server is not running');
      } else {
        setError('Invalid password');
      }
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('app_token');
    setToken(null);
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl w-full max-w-md space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold mb-2">Claude Web</h1>
            <p className="text-gray-500">Enter password to continue</p>
            {backendDown && (
              <div className="mt-4 p-2 bg-red-100 text-red-700 text-xs rounded border border-red-200">
                ⚠️ Backend is offline. Run ./start.sh
              </div>
            )}
          </div>
          
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full p-4 rounded-xl border dark:bg-gray-900 dark:border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
          </div>

          <button
            type="submit"
            className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden">
      {/* Sidebar */}
      <div className="w-20 md:w-64 border-r dark:border-gray-800 flex flex-col items-center md:items-stretch p-4 space-y-4 flex-shrink-0">
        <div className="hidden md:block text-2xl font-black mb-8 px-4 italic text-blue-600">CLAUDE</div>
        
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
            activeTab === 'chat' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          <MessageSquare size={24} />
          <span className="hidden md:block font-medium">Chat</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
            activeTab === 'settings' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          <SettingsIcon size={24} />
          <span className="hidden md:block font-medium">Settings</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={handleLogout}
          className="flex items-center gap-3 p-3 rounded-xl hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/20 transition-colors"
        >
          <LogOut size={24} />
          <span className="hidden md:block font-medium">Logout</span>
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {activeTab === 'chat' ? <ChatInterface /> : <Settings />}
      </div>
    </div>
  );
}

export default App;
