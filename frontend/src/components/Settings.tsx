import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Key, Shield, Globe, Plus, Trash2, Check, AlertCircle, RefreshCw, ExternalLink, List } from 'lucide-react';

const API_BASE = 'http://localhost:8000';

export const Settings: React.FC = () => {
  const [sessionKey, setSessionKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [incognito, setIncognito] = useState(true);
  const [webSearch, setWebSearch] = useState(false);
  const [proxies, setProxies] = useState<any[]>([]);
  const [dbAccounts, setDbAccounts] = useState<any[]>([]);
  const [newAcc, setNewAcc] = useState({ email: '', key: '', proxy: '' });
  const [newProxy, setNewProxy] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [loading, setLoading] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const token = localStorage.getItem('app_token');

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setStatus(res.data);
      if (res.data.key_set) setSessionKey('********');
      setModel(res.data.model);
      setIncognito(res.data.incognito);
      setWebSearch(res.data.web_search);
    } catch (e) { console.error(e); }
  };

  const fetchProxies = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/proxies`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setProxies(res.data);
    } catch (e) { console.error(e); }
  };

  const fetchDbAccounts = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/db/accounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setDbAccounts(res.data);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    fetchStatus();
    fetchProxies();
    fetchDbAccounts();
  }, []);

  const saveSettings = async () => {
    try {
      const payload: any = { model, incognito, web_search: webSearch };
      if (sessionKey && sessionKey !== '********') payload.session_key = sessionKey;
      await axios.post(`${API_BASE}/api/settings`, payload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessage({ type: 'success', text: 'Settings saved!' });
      fetchStatus();
    } catch (e: any) {
      setMessage({ type: 'error', text: e.response?.data?.detail || 'Failed to save' });
    }
  };

  const addAccount = async () => {
    if (!newAcc.email || !newAcc.key) return;
    try {
      await axios.post(`${API_BASE}/api/db/accounts/bulk`, [newAcc], {
        headers: { Authorization: `Bearer ${token}` }
      });
      setNewAcc({ email: '', key: '', proxy: '' });
      fetchDbAccounts();
      setMessage({ type: 'success', text: 'Account added!' });
    } catch (e) { console.error(e); }
  };

  const handleBulkImport = async () => {
    if (!bulkText.trim()) return;
    setLoading(true);
    try {
      const lines = bulkText.split('\n').filter(l => l.trim());
      const accounts = lines.map(line => {
        const parts = line.split('|').map(p => p.trim());
        return {
          email: parts[0],
          key: parts[1],
          proxy: parts[2] || '',
          status: 'unknown'
        };
      }).filter(a => a.email && a.key);

      await axios.post(`${API_BASE}/api/db/accounts/bulk`, accounts, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setMessage({ type: 'success', text: `Imported ${accounts.length} accounts!` });
      setBulkText('');
      setShowBulk(false);
      fetchDbAccounts();
    } catch (e) {
      setMessage({ type: 'error', text: 'Bulk import failed' });
    } finally {
      setLoading(false);
    }
  };

  const applyAccount = async (index: number) => {
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/api/db/accounts/${index}/apply`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessage({ type: 'success', text: `Connected as ${res.data.email}` });
      fetchStatus();
      fetchDbAccounts();
      fetchProxies();
    } catch (e: any) {
      setMessage({ type: 'error', text: e.response?.data?.detail || 'Failed' });
    } finally { setLoading(false); }
  };

  const validateAll = async () => {
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/api/db/accounts/validate-all`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchDbAccounts();
      setMessage({ type: 'success', text: 'Pool validated!' });
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const deleteAccount = async (index: number) => {
    try {
      await axios.delete(`${API_BASE}/api/db/accounts/${index}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchDbAccounts();
    } catch (e) { console.error(e); }
  };

  return (
    <div className="max-w-5xl mx-auto w-full p-6 space-y-8">
      <section>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="text-purple-500" /> Account Pool
          </h2>
          <button 
            onClick={() => setShowBulk(!showBulk)}
            className="text-xs font-black bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg hover:bg-purple-200 transition-all uppercase flex items-center gap-2"
          >
            <List size={14} /> {showBulk ? 'Back to Form' : 'Mass Import'}
          </button>
        </div>
        
        <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl shadow-sm overflow-hidden">
          {showBulk ? (
            <div className="p-6 space-y-4 bg-purple-50/20 dark:bg-purple-900/10 animate-in fade-in duration-300">
              <textarea 
                className="w-full h-40 p-4 border-2 border-purple-100 dark:border-purple-900/30 rounded-xl dark:bg-gray-900 focus:border-purple-500 outline-none font-mono text-[10px]"
                placeholder="email | session_key | socks5://proxy_url (one per line)"
                value={bulkText}
                onChange={e => setBulkText(e.target.value)}
              />
              <button 
                disabled={loading}
                onClick={handleBulkImport}
                className="w-full py-3 bg-purple-600 text-white font-black rounded-xl hover:bg-purple-700 transition-all shadow-lg shadow-purple-500/20 disabled:opacity-50"
              >
                {loading ? 'PROCESSING...' : 'RUN MASS IMPORT'}
              </button>
            </div>
          ) : (
            <div className="p-6 border-b dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input className="p-2.5 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm" placeholder="Email" value={newAcc.email} onChange={e => setNewAcc({...newAcc, email: e.target.value})} />
                <input className="p-2.5 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm" placeholder="Key" type="password" value={newAcc.key} onChange={e => setNewAcc({...newAcc, key: e.target.value})} />
                <input className="p-2.5 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm" placeholder="Proxy" value={newAcc.proxy} onChange={e => setNewAcc({...newAcc, proxy: e.target.value})} />
                <button onClick={addAccount} className="bg-purple-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-700 flex items-center justify-center gap-2 transition-colors"><Plus size={18} /> Add</button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900 text-gray-400 text-[10px] font-black uppercase tracking-widest">
                <tr><th className="px-6 py-4">Account</th><th className="px-6 py-4">Status</th><th className="px-6 py-4 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {dbAccounts.map((acc, idx) => (
                  <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-6 py-4 font-medium">{acc.email}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${acc.status === 'connected' ? 'bg-green-100 text-green-700' : acc.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>{acc.status?.toUpperCase()}</span>
                    </td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button disabled={loading} onClick={() => applyAccount(idx)} className="text-blue-600 hover:text-blue-800 text-xs font-bold uppercase">Apply</button>
                      <button onClick={() => deleteAccount(idx)} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-900 border-t dark:border-gray-800">
            <button disabled={loading} onClick={validateAll} className="w-full py-3 bg-white dark:bg-gray-800 border-2 border-purple-500/30 text-purple-600 dark:text-purple-400 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 tracking-widest uppercase text-xs">
              {loading ? <RefreshCw className="animate-spin" size={16} /> : <RefreshCw size={16} />} Validate All
            </button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section>
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2"><Key className="text-blue-500" /> Active Session</h2>
          <div className="space-y-4 bg-white dark:bg-gray-800 p-6 rounded-2xl border dark:border-gray-700 shadow-sm">
            <input type="password" value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} placeholder="sk-ant-..." className="w-full p-2.5 border rounded-lg dark:bg-gray-900 text-sm" />
            <div className="grid grid-cols-2 gap-4">
              <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full p-2.5 border rounded-lg dark:bg-gray-900 text-sm">
                <option value="claude-sonnet-4-20250514">Sonnet 4 (Latest)</option>
                <option value="claude-3-5-sonnet-20241022">3.5 Sonnet</option>
              </select>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={incognito} onChange={(e) => setIncognito(e.target.checked)} /> Incognito</label>
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Web Search</label>
              </div>
            </div>
            <button onClick={saveSettings} className="w-full py-3 bg-blue-600 text-white font-bold rounded-xl shadow-lg">Save Settings</button>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2"><Globe className="text-green-500" /> Proxy Manager</h2>
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl shadow-sm overflow-hidden">
             <div className="max-h-[250px] overflow-y-auto">
                <table className="w-full text-left text-[10px]">
                  <tbody className="divide-y dark:divide-gray-700">
                    {proxies.map((p) => (
                      <tr key={p.id}><td className="px-4 py-3 font-mono text-gray-500">{p.url}</td><td className="px-4 py-3 text-right">{p.is_active && <Check size={12} className="text-green-500 ml-auto"/>}</td></tr>
                    ))}
                  </tbody>
                </table>
             </div>
          </div>
        </section>
      </div>

      {message.text && (
        <div className={`fixed bottom-6 right-6 p-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom-5 ${message.type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white`}>
          <Check size={20} /> <span className="font-bold">{message.text}</span>
          <button onClick={() => setMessage({type:'', text:''})} className="ml-2">×</button>
        </div>
      )}
    </div>
  );
};
