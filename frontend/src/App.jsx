import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  Satellite, Activity, HardDrive, User, LogOut, RefreshCw, FileText,
  CheckCircle, Clock, AlertTriangle, XCircle, Plus, Search, Database,
  Calendar, MapPin, Sliders, Shield, Users, Check, ChevronRight, Info,
  HelpCircle, X, Download, Play, Terminal, Eye, EyeOff, KeyRound, ArrowLeft, Square
} from 'lucide-react';

const API_BASE = '/api/v1';

const getAuthHeader = () => {
  const token = localStorage.getItem('sdap_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Helper function to extract clear, readable error messages from FastAPI responses
const formatApiError = (err, defaultMsg) => {
  if (!err || !err.response) {
    if (err && err.message) return `Connection Error: ${err.message}. Please check if backend server is running.`;
    return defaultMsg;
  }
  const detail = err.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(item => {
      const field = item.loc ? item.loc[item.loc.length - 1] : '';
      if (item.type === 'string_too_short') {
        return `${field.replace('_', ' ')} must be at least ${item.ctx?.min_length || 6} characters long`;
      }
      return item.msg || 'Invalid input';
    }).join('. ');
  }
  return defaultMsg;
};

export default function App() {
  // ---------------------------------------------------------------------------
  // 1. Authentication State
  // ---------------------------------------------------------------------------
  const [token, setToken] = useState(localStorage.getItem('sdap_token') || '');
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('sdap_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register' | 'forgot'
  
  // Form fields
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regFullName, setRegFullName] = useState('');

  // Forgot password fields
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [forgotSuccessMsg, setForgotSuccessMsg] = useState('');

  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // 2. Main App Navigation & UI State
  // ---------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState('requests'); // 'requests' | 'new_request' | 'admin'
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // ---------------------------------------------------------------------------
  // 3. Dynamic Administrative Boundaries State (From DB)
  // ---------------------------------------------------------------------------
  const [statesList, setStatesList] = useState([]);
  const [districtsList, setDistrictsList] = useState([]);
  const [loadingBoundaries, setLoadingBoundaries] = useState(false);

  // ---------------------------------------------------------------------------
  // 4. New Request Form State
  // ---------------------------------------------------------------------------
  const [reqTitle, setReqTitle] = useState('');
  const [areaType, setAreaType] = useState('Administrative Unit');
  const [selectedState, setSelectedState] = useState('');
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [season, setSeason] = useState('Kharif');
  const [startDate, setStartDate] = useState('2026-06-01');
  const [endDate, setEndDate] = useState('2026-10-31');
  const [satellite, setSatellite] = useState('Sentinel-2');
  const [selectedIndices, setSelectedIndices] = useState(['NDVI', 'LSWI']);
  const [compositeInterval, setCompositeInterval] = useState('none');
  const [priority, setPriority] = useState('normal');
  const [submittingReq, setSubmittingReq] = useState(false);
  const [reqFormMessage, setReqFormMessage] = useState(null);

  // Pre-submit confirmation modal state (SRS 8.3 — show estimate before confirming)
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState(null);

  // Storage estimation breakdown modal
  const [showStorageModal, setShowStorageModal] = useState(false);

  // ---------------------------------------------------------------------------
  // 5. Requests & Live Logs State
  // ---------------------------------------------------------------------------
  const [requests, setRequests] = useState([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [selectedReqForLogs, setSelectedReqForLogs] = useState(null);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [rerunningId, setRerunningId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  const logsEndRef = useRef(null);
  const selectedReqIdRef = useRef(null);

  // ---------------------------------------------------------------------------
  // 6. Admin State
  // ---------------------------------------------------------------------------
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLiveFeed, setAdminLiveFeed] = useState([]);
  const [loadingAdmin, setLoadingAdmin] = useState(false);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [newAdminFullName, setNewAdminFullName] = useState('');
  const [newAdminRole, setNewAdminRole] = useState('USER');
  const [adminUserMsg, setAdminUserMsg] = useState(null);

  // ---------------------------------------------------------------------------
  // Handlers & API Calls
  // ---------------------------------------------------------------------------

  // Handle Login
  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/auth/login/json`, {
        email: loginEmail,
        password: loginPassword
      });
      const { access_token, user } = res.data;
      localStorage.setItem('sdap_token', access_token);
      localStorage.setItem('sdap_user', JSON.stringify(user));
      setToken(access_token);
      setCurrentUser(user);
    } catch (err) {
      setAuthError(formatApiError(err, 'Login failed. Please check your email and password.'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Self-Registration
  const handleRegister = async (e) => {
    e.preventDefault();
    setAuthError('');

    if (regPassword.length < 6) {
      setAuthError('Password must be at least 6 characters long.');
      return;
    }

    setAuthLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/auth/register`, {
        email: regEmail,
        password: regPassword,
        full_name: regFullName,
        role: 'USER'
      });
      const { access_token, user } = res.data;
      localStorage.setItem('sdap_token', access_token);
      localStorage.setItem('sdap_user', JSON.stringify(user));
      setToken(access_token);
      setCurrentUser(user);
    } catch (err) {
      setAuthError(formatApiError(err, 'Registration failed. Please check inputs.'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Forgot Password Reset
  const handleResetPassword = async (e) => {
    e.preventDefault();
    setAuthError('');
    setForgotSuccessMsg('');

    if (forgotNewPassword.length < 6) {
      setAuthError('New password must be at least 6 characters long.');
      return;
    }

    if (forgotNewPassword !== forgotConfirmPassword) {
      setAuthError('New password and confirm password do not match.');
      return;
    }

    setAuthLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/auth/reset-password`, {
        email: forgotEmail,
        new_password: forgotNewPassword,
        confirm_password: forgotConfirmPassword
      });
      setForgotSuccessMsg(res.data?.message || 'Password reset successfully! Please sign in with your new password.');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
    } catch (err) {
      setAuthError(formatApiError(err, 'Password reset failed. Please check the email address.'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('sdap_token');
    localStorage.removeItem('sdap_user');
    setToken('');
    setCurrentUser(null);
    setSelectedReqForLogs(null);
    setIsLogsModalOpen(false);
  };

  // Sync selectedReqIdRef to track selected request across poll updates
  useEffect(() => {
    selectedReqIdRef.current = selectedReqForLogs?.id || null;
  }, [selectedReqForLogs?.id]);

  // Fetch Administrative Boundaries ONCE on login/mount (static data - do NOT poll)
  useEffect(() => {
    if (!token) return;
    let isCancelled = false;
    setLoadingBoundaries(true);

    const loadBoundaries = async () => {
      try {
        const [statesRes, distRes] = await Promise.all([
          axios.get(`${API_BASE}/boundaries/states`, { headers: getAuthHeader() }),
          axios.get(`${API_BASE}/boundaries/districts`, { headers: getAuthHeader() })
        ]);
        if (!isCancelled) {
          const rawStates = statesRes.data || [];
          const rawDistricts = distRes.data || [];
          setStatesList(rawStates);
          setDistrictsList(rawDistricts);
          console.log(`Loaded ${rawStates.length} states and ${rawDistricts.length} districts from DB.`);
        }
      } catch (err) {
        console.error('Error fetching administrative boundaries:', err);
      } finally {
        if (!isCancelled) setLoadingBoundaries(false);
      }
    };

    loadBoundaries();
    return () => { isCancelled = true; };
  }, [token]);

  // Fetch Requests List (stable reference - only depends on token)
  const fetchRequests = useCallback(async () => {
    if (!token) return;
    setLoadingRequests(true);
    try {
      const res = await axios.get(`${API_BASE}/requests/`, { headers: getAuthHeader() });
      const data = res.data || [];
      setRequests(data);

      if (selectedReqIdRef.current) {
        const updated = data.find(r => r.id === selectedReqIdRef.current);
        if (updated) {
          setSelectedReqForLogs(updated);
        }
      }
    } catch (err) {
      console.error('Error loading requests:', err);
    } finally {
      setLoadingRequests(false);
    }
  }, [token]);

  // Fetch Admin Data
  const fetchAdminData = useCallback(async () => {
    if (!token || currentUser?.role !== 'ADMIN') return;
    setLoadingAdmin(true);
    try {
      const [usersRes, liveRes] = await Promise.all([
        axios.get(`${API_BASE}/users/`, { headers: getAuthHeader() }),
        axios.get(`${API_BASE}/requests/live-monitoring`, { headers: getAuthHeader() })
      ]);
      setAdminUsers(usersRes.data || []);
      setAdminLiveFeed(liveRes.data?.live_feed || []);
    } catch (err) {
      console.error('Error loading admin feed:', err);
    } finally {
      setLoadingAdmin(false);
    }
  }, [token, currentUser]);

  // Initial fetch of requests on login
  useEffect(() => {
    if (token) {
      fetchRequests();
    }
  }, [token, fetchRequests]);

  // Initial / tab-switch fetch for admin data
  useEffect(() => {
    if (token && currentUser?.role === 'ADMIN' && activeTab === 'admin') {
      fetchAdminData();
    }
  }, [token, currentUser, activeTab, fetchAdminData]);

  // Smart polling: poll requests every 3s only when a job is active or logs modal is open
  useEffect(() => {
    if (!token) return;

    const hasActiveTask = requests.some(r => r.status === 'PROCESSING' || r.status === 'SUBMITTED' || r.status === 'VALIDATED');
    const shouldPoll = hasActiveTask || isLogsModalOpen || (activeTab === 'admin' && currentUser?.role === 'ADMIN');

    if (!shouldPoll) return;

    const interval = setInterval(() => {
      fetchRequests();
      if (activeTab === 'admin' && currentUser?.role === 'ADMIN') {
        fetchAdminData();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [token, requests, isLogsModalOpen, activeTab, currentUser?.role, fetchRequests, fetchAdminData]);

  // Auto scroll terminal log view when logs update
  useEffect(() => {
    if (isLogsModalOpen && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedReqForLogs?.execution_logs, isLogsModalOpen]);

  // ---------------------------------------------------------------------------
  // Dynamic Storage Estimation Logic (SRS 8.3 Algorithm)
  // Matches backend estimate_request_storage() exactly.
  // ---------------------------------------------------------------------------
  const calculateEstimatedStorage = () => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.max(0, end - start);
    const days = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const months = days / 30.0;

    // SRS 11.1: 32 tiles for whole state, ~3 tiles for a single district
    const tileCount = selectedDistrict ? 3 : (selectedState ? 32 : 3);

    const acquisitionsPerMonth = satellite === 'Sentinel-1' ? 2.5 : 6.0;
    const sceneSizeGB = satellite === 'Sentinel-1' ? 0.615 : 0.270;
    const scenesEstimate = Math.round(tileCount * acquisitionsPerMonth * months);

    const totalGB = tileCount * acquisitionsPerMonth * months * sceneSizeGB;
    return {
      gb: Math.round(totalGB * 100) / 100,
      tiles: tileCount,
      scenes: scenesEstimate,
      days,
      months: months.toFixed(1)
    };
  };

  const estResult = calculateEstimatedStorage();
  const estimatedGb = estResult.gb;
  // SRS 8.3: Hold if > 20% of 10 TB = 2,000 GB; Reject if > 10,000 GB
  const willRequireApproval = estimatedGb > 2000;
  const willBeRejected = estimatedGb > 10000;

  // Date validation helpers
  const AWS_MIN_DATE = '2018-12-01';
  const startDateError = startDate && startDate < AWS_MIN_DATE
    ? 'Start date cannot be before December 2018 (AWS archive depth).'
    : null;
  const dateSanityError = startDate && endDate && endDate < startDate
    ? 'End date must be on or after start date.'
    : null;
  const dateSpanDays = startDate && endDate
    ? Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24))
    : 0;
  const dateSpanError = dateSpanDays > 365
    ? `Date span (${dateSpanDays} days) exceeds the maximum 365 days (1 year).`
    : null;
  const formDateError = startDateError || dateSanityError || dateSpanError;

  // First click: show confirmation modal (SRS 8.3 — show estimate before confirming)
  const handleShowConfirm = (e) => {
    e.preventDefault();
    if (formDateError) {
      setReqFormMessage({ type: 'error', text: formDateError });
      return;
    }
    if (willBeRejected) {
      setReqFormMessage({ type: 'error', text: `Request would be rejected: estimated ${estimatedGb} GB exceeds the 10,000 GB platform limit. Narrow the date range or area.` });
      return;
    }
    if (!selectedState && !selectedDistrict) {
      setReqFormMessage({ type: 'error', text: 'Please select at least a State or District.' });
      return;
    }
    const payload = {
      request_title: reqTitle || `Acquisition - ${selectedDistrict || selectedState || 'Region'}`,
      area_type: areaType,
      state: selectedState || null,
      district: selectedDistrict || null,
      season: season || null,
      start_date: startDate,
      end_date: endDate,
      satellite: satellite,
      bands: satellite === 'Sentinel-1' ? ['VV', 'VH'] : ['B04', 'B08', 'B08A', 'B11', 'SCL'],
      indices: selectedIndices,
      composite_interval: compositeInterval,
      priority: priority,
      delivery_outputs: ['clipped_images']
    };
    setConfirmPayload(payload);
    setShowConfirmModal(true);
    setReqFormMessage(null);
  };

  // Second click: actually submit (after user confirms)
  const handleConfirmAndSubmit = async () => {
    setShowConfirmModal(false);
    setSubmittingReq(true);
    setReqFormMessage(null);
    try {
      const res = await axios.post(`${API_BASE}/requests/`, confirmPayload, { headers: getAuthHeader() });
      setReqFormMessage({
        type: 'success',
        text: `✓ Request #${res.data.id} submitted! Status: ${res.data.status}${res.data.status === 'ACCEPTED' ? ' — Pipeline started automatically.' : ' — Awaiting admin approval.'}`
      });
      setReqTitle('');
      setConfirmPayload(null);
      fetchRequests();
      setTimeout(() => {
        setActiveTab('requests');
        setReqFormMessage(null);
      }, 2000);
    } catch (err) {
      setReqFormMessage({
        type: 'error',
        text: formatApiError(err, 'Failed to submit request.')
      });
    } finally {
      setSubmittingReq(false);
    }
  };


  // Re-run / Retry Handler
  const handleRerun = async (reqId) => {
    setRerunningId(reqId);
    try {
      const res = await axios.post(`${API_BASE}/requests/${reqId}/rerun`, {}, { headers: getAuthHeader() });
      fetchRequests();
      if (selectedReqForLogs && selectedReqForLogs.id === reqId) {
        setSelectedReqForLogs(res.data);
      }
    } catch (err) {
      alert(formatApiError(err, 'Error rerunning pipeline.'));
    } finally {
      setRerunningId(null);
    }
  };

  // Stop / Cancel Pipeline Execution Handler
  const handleStop = async (reqId) => {
    if (!window.confirm(`Are you sure you want to stop the execution of request #${reqId}?`)) return;
    setStoppingId(reqId);
    try {
      const res = await axios.post(`${API_BASE}/requests/${reqId}/stop`, {}, { headers: getAuthHeader() });
      fetchRequests();
      if (selectedReqForLogs && selectedReqForLogs.id === reqId) {
        setSelectedReqForLogs(res.data);
      }
    } catch (err) {
      alert(formatApiError(err, 'Error stopping request pipeline.'));
    } finally {
      setStoppingId(null);
    }
  };

  // Admin Approve Handler
  const handleApproveStatus = async (reqId, newStatus) => {
    try {
      await axios.patch(`${API_BASE}/requests/${reqId}/status?status_value=${newStatus}`, {}, { headers: getAuthHeader() });
      fetchRequests();
      if (activeTab === 'admin') fetchAdminData();
    } catch (err) {
      alert(formatApiError(err, 'Error updating request status.'));
    }
  };

  // Admin Create User Handler
  const handleCreateUser = async (e) => {
    e.preventDefault();
    setAdminUserMsg(null);
    try {
      await axios.post(`${API_BASE}/users/`, {
        email: newAdminEmail,
        password: newAdminPassword,
        full_name: newAdminFullName,
        role: newAdminRole
      }, { headers: getAuthHeader() });

      setAdminUserMsg({ type: 'success', text: `User ${newAdminEmail} created successfully.` });
      setNewAdminEmail('');
      setNewAdminPassword('');
      setNewAdminFullName('');
      fetchAdminData();
    } catch (err) {
      setAdminUserMsg({ type: 'error', text: formatApiError(err, 'Error creating user.') });
    }
  };

  // Filtered Districts based on selectedState (case-insensitive & trimmed)
  const availableDistricts = selectedState
    ? districtsList.filter(d => {
        const sName = typeof d === 'object' && d ? (d.state_name || '') : '';
        return sName.trim().toLowerCase() === selectedState.trim().toLowerCase();
      })
    : [];

  // Filtered requests list
  const filteredRequests = requests.filter(r => {
    const matchesStatus = statusFilter === 'ALL' || r.status === statusFilter;
    const q = searchTerm.toLowerCase();
    const matchesSearch = !searchTerm ||
      (r.request_title && r.request_title.toLowerCase().includes(q)) ||
      (r.district && r.district.toLowerCase().includes(q)) ||
      (r.state && r.state.toLowerCase().includes(q)) ||
      (r.satellite && r.satellite.toLowerCase().includes(q)) ||
      (r.id && r.id.toString().includes(q));
    return matchesStatus && matchesSearch;
  });

  // Helper for Status Badge styling
  const renderStatusBadge = (statusStr) => {
    switch (statusStr) {
      case 'ACCEPTED':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#dcfce7', color: '#166534', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><CheckCircle size={12} /> ACCEPTED</span>;
      case 'PROCESSING':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#dbeafe', color: '#1e40af', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><RefreshCw size={12} className="animate-spin" /> PROCESSING</span>;
      case 'COMPLETED':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#bbf7d0', color: '#14532d', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><CheckCircle size={12} /> COMPLETED</span>;
      case 'HOLD_FOR_APPROVAL':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#fef3c7', color: '#92400e', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={12} /> HOLD FOR APPROVAL</span>;
      case 'STOPPED':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#fee2e2', color: '#991b1b', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><Square size={11} fill="#991b1b" /> STOPPED</span>;
      case 'REJECTED':
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#fee2e2', color: '#991b1b', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}><XCircle size={12} /> REJECTED</span>;
      default:
        return <span style={{ padding: '0.25rem 0.6rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#f1f5f9', color: '#475569' }}>{statusStr}</span>;
    }
  };

  // Format log lines into clean individual elements
  const renderLogContent = (rawLogs) => {
    if (!rawLogs || rawLogs.trim().length === 0) {
      return <div className="log-line log-line-info">Initializing pipeline log recorder... No logs written yet.</div>;
    }

    const lines = rawLogs.split(/\r?\n/).filter(line => line.length > 0);

    return lines.map((line, idx) => {
      let className = 'log-line';
      if (line.includes('ERROR') || line.includes('Failed') || line.includes('Exception')) {
        className += ' log-line-error';
      } else if (line.includes('WARNING') || line.includes('WARN')) {
        className += ' log-line-warn';
      } else if (line.startsWith('===') || line.includes('STARTING') || line.includes('STEP')) {
        className += ' log-line-header';
      } else {
        className += ' log-line-info';
      }
      return <div key={idx} className={className}>{line}</div>;
    });
  };

  // ===========================================================================
  // RENDER: Unauthenticated View (Login / Register / Forgot Password)
  // ===========================================================================
  if (!token || !currentUser) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f8fafc',
        padding: '1.5rem'
      }}>
        <div style={{
          backgroundColor: '#ffffff',
          width: '100%',
          maxWidth: '430px',
          borderRadius: '0.75rem',
          boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01)',
          border: '1px solid #e2e8f0',
          padding: '2rem'
        }}>
          {/* Brand Header with Satellite Logo */}
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '52px',
              height: '52px',
              backgroundColor: '#eff6ff',
              color: '#2563eb',
              borderRadius: '0.75rem',
              marginBottom: '0.75rem',
              border: '1px solid #dbeafe',
              boxShadow: '0 2px 4px rgba(37, 99, 235, 0.08)'
            }}>
              <Satellite size={28} />
            </div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.25rem 0' }}>SDAP Platform</h1>
            <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>Satellite Data Acquisition & Processing Platform</p>
          </div>

          {/* Navigation Mode Header */}
          {authMode !== 'forgot' ? (
            <div style={{
              display: 'flex',
              backgroundColor: '#f1f5f9',
              borderRadius: '0.5rem',
              padding: '0.25rem',
              marginBottom: '1.25rem'
            }}>
              <button
                onClick={() => { setAuthMode('login'); setAuthError(''); }}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  backgroundColor: authMode === 'login' ? '#ffffff' : 'transparent',
                  color: authMode === 'login' ? '#0f172a' : '#64748b',
                  boxShadow: authMode === 'login' ? '0 1px 2px rgba(0, 0, 0, 0.05)' : 'none'
                }}
              >
                Sign In
              </button>
              <button
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  backgroundColor: authMode === 'register' ? '#ffffff' : 'transparent',
                  color: authMode === 'register' ? '#0f172a' : '#64748b',
                  boxShadow: authMode === 'register' ? '0 1px 2px rgba(0, 0, 0, 0.05)' : 'none'
                }}
              >
                Register
              </button>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '1.25rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid #f1f5f9'
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <KeyRound size={18} color="#2563eb" /> Reset Password
              </h3>
              <button
                type="button"
                onClick={() => { setAuthMode('login'); setAuthError(''); setForgotSuccessMsg(''); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  border: 'none',
                  background: 'none',
                  color: '#2563eb',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <ArrowLeft size={14} /> Back to Sign In
              </button>
            </div>
          )}

          {authError && (
            <div style={{
              backgroundColor: '#fef2f2',
              color: '#991b1b',
              padding: '0.75rem',
              borderRadius: '0.375rem',
              fontSize: '0.85rem',
              marginBottom: '1rem',
              border: '1px solid #fecaca'
            }}>
              {authError}
            </div>
          )}

          {/* ==================== SIGN IN FORM ==================== */}
          {authMode === 'login' && (
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Email Address</label>
                <input
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="admin@sdap.niruthi.in"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Password Input with Show/Hide Toggle */}
              <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#334155' }}>Password</label>
                  <button
                    type="button"
                    onClick={() => { setAuthMode('forgot'); setAuthError(''); }}
                    style={{ border: 'none', background: 'none', color: '#2563eb', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', padding: 0 }}
                  >
                    Forgot Password?
                  </button>
                </div>

                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    style={{
                      width: '100%',
                      padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.9rem',
                      outline: 'none'
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute',
                      right: '0.65rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      border: 'none',
                      background: 'none',
                      color: '#64748b',
                      cursor: 'pointer',
                      padding: '0.2rem',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={authLoading}
                style={{
                  width: '100%',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  padding: '0.65rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  marginTop: '1.25rem'
                }}
              >
                {authLoading ? 'Signing In...' : 'Sign In'}
              </button>
            </form>
          )}

          {/* ==================== REGISTER FORM ==================== */}
          {authMode === 'register' && (
            <form onSubmit={handleRegister}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Full Name</label>
                <input
                  type="text"
                  required
                  value={regFullName}
                  onChange={(e) => setRegFullName(e.target.value)}
                  placeholder="Officer / Analyst Name"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Email Address</label>
                <input
                  type="email"
                  required
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="analyst@sdap.gov.in"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Password with Show/Hide Toggle */}
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Password (min 6 characters)</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="••••••••"
                    style={{
                      width: '100%',
                      padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.9rem',
                      outline: 'none'
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute',
                      right: '0.65rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      border: 'none',
                      background: 'none',
                      color: '#64748b',
                      cursor: 'pointer',
                      padding: '0.2rem',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={authLoading}
                style={{
                  width: '100%',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  padding: '0.65rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  cursor: 'pointer'
                }}
              >
                {authLoading ? 'Creating Account...' : 'Create Account'}
              </button>
            </form>
          )}

          {/* ==================== FORGOT PASSWORD FORM ==================== */}
          {authMode === 'forgot' && (
            <form onSubmit={handleResetPassword}>
              {forgotSuccessMsg ? (
                <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                  <div style={{
                    backgroundColor: '#dcfce7',
                    color: '#166534',
                    padding: '0.85rem',
                    borderRadius: '0.5rem',
                    fontSize: '0.85rem',
                    border: '1px solid #bbf7d0',
                    marginBottom: '1.25rem'
                  }}>
                    {forgotSuccessMsg}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setAuthMode('login'); setForgotSuccessMsg(''); }}
                    style={{
                      width: '100%',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      padding: '0.65rem',
                      border: 'none',
                      borderRadius: '0.375rem',
                      cursor: 'pointer'
                    }}
                  >
                    Return to Sign In
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Account Email Address
                    </label>
                    <input
                      type="email"
                      required
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      placeholder="admin@sdap.niruthi.in"
                      style={{
                        width: '100%',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.9rem',
                        outline: 'none'
                      }}
                    />
                  </div>

                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      New Password (min 6 characters)
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={forgotNewPassword}
                        onChange={(e) => setForgotNewPassword(e.target.value)}
                        placeholder="••••••••"
                        style={{
                          width: '100%',
                          padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #cbd5e1',
                          fontSize: '0.9rem',
                          outline: 'none'
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        title={showPassword ? 'Hide password' : 'Show password'}
                        style={{
                          position: 'absolute',
                          right: '0.65rem',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          border: 'none',
                          background: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          padding: '0.2rem',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Confirm New Password
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={forgotConfirmPassword}
                        onChange={(e) => setForgotConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        style={{
                          width: '100%',
                          padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #cbd5e1',
                          fontSize: '0.9rem',
                          outline: 'none'
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        title={showPassword ? 'Hide password' : 'Show password'}
                        style={{
                          position: 'absolute',
                          right: '0.65rem',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          border: 'none',
                          background: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          padding: '0.2rem',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={authLoading}
                    style={{
                      width: '100%',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      padding: '0.65rem',
                      border: 'none',
                      borderRadius: '0.375rem',
                      cursor: 'pointer'
                    }}
                  >
                    {authLoading ? 'Resetting Password...' : 'Reset Password'}
                  </button>
                </>
              )}
            </form>
          )}

        </div>
      </div>
    );
  }

  // ===========================================================================
  // RENDER: Main Authenticated Dashboard Layout
  // ===========================================================================
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#f8fafc' }}>
      
      {/* Top Header Bar */}
      <header style={{
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        padding: '0.75rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            backgroundColor: '#2563eb',
            color: '#ffffff',
            padding: '0.45rem',
            borderRadius: '0.375rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <Satellite size={22} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0, lineHeight: 1.2 }}>
              SDAP Platform
            </h2>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Satellite Data Acquisition & Processing Infrastructure</span>
          </div>
        </div>

        {/* User Badge & Logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backgroundColor: '#f1f5f9',
            padding: '0.35rem 0.75rem',
            borderRadius: '9999px',
            fontSize: '0.8rem',
            color: '#334155'
          }}>
            <User size={14} color="#2563eb" />
            <span style={{ fontWeight: 600 }}>{currentUser.full_name || currentUser.email}</span>
            <span style={{
              fontSize: '0.68rem',
              fontWeight: 700,
              backgroundColor: currentUser.role === 'ADMIN' ? '#dbeafe' : '#e2e8f0',
              color: currentUser.role === 'ADMIN' ? '#1d4ed8' : '#475569',
              padding: '0.1rem 0.4rem',
              borderRadius: '0.25rem',
              textTransform: 'uppercase'
            }}>
              {currentUser.role}
            </span>
          </div>

          <button
            onClick={handleLogout}
            title="Sign Out"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              backgroundColor: 'transparent',
              border: '1px solid #cbd5e1',
              borderRadius: '0.375rem',
              padding: '0.35rem 0.75rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: '#64748b',
              cursor: 'pointer'
            }}
          >
            <LogOut size={14} /> Sign Out
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '1400px', width: '100%', margin: '0 auto', padding: '1.5rem' }}>
        
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1.5rem' }}>
          <button
            onClick={() => setActiveTab('requests')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              border: 'none',
              borderBottom: activeTab === 'requests' ? '2px solid #2563eb' : '2px solid transparent',
              color: activeTab === 'requests' ? '#2563eb' : '#64748b',
              backgroundColor: 'transparent',
              cursor: 'pointer'
            }}
          >
            <FileText size={16} /> My Requests & Pipeline Logs
          </button>

          <button
            onClick={() => setActiveTab('new_request')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              border: 'none',
              borderBottom: activeTab === 'new_request' ? '2px solid #2563eb' : '2px solid transparent',
              color: activeTab === 'new_request' ? '#2563eb' : '#64748b',
              backgroundColor: 'transparent',
              cursor: 'pointer'
            }}
          >
            <Plus size={16} /> Submit New Request
          </button>

          {currentUser.role === 'ADMIN' && (
            <button
              onClick={() => setActiveTab('admin')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.25rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                border: 'none',
                borderBottom: activeTab === 'admin' ? '2px solid #2563eb' : '2px solid transparent',
                color: activeTab === 'admin' ? '#2563eb' : '#64748b',
                backgroundColor: 'transparent',
                cursor: 'pointer'
              }}
            >
              <Shield size={16} /> Admin Control & Live Feed
            </button>
          )}
        </div>

        {/* ========================================================================= */}
        {/* TAB 1: Requests & Pipeline Logs Table View */}
        {/* ========================================================================= */}
        {activeTab === 'requests' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* Filter & Search Bar */}
            <div style={{
              backgroundColor: '#ffffff',
              padding: '1rem 1.25rem',
              borderRadius: '0.5rem',
              border: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              flexWrap: 'wrap'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: '260px' }}>
                <div style={{ position: 'relative', width: '100%' }}>
                  <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search by Title, District, State, Satellite, or ID..."
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem 0.5rem 2.25rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.85rem',
                      outline: 'none'
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>Status Filter:</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{
                      padding: '0.45rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.85rem',
                      backgroundColor: '#ffffff',
                      outline: 'none'
                    }}
                  >
                    <option value="ALL">All Statuses</option>
                    <option value="ACCEPTED">ACCEPTED</option>
                    <option value="PROCESSING">PROCESSING</option>
                    <option value="COMPLETED">COMPLETED</option>
                    <option value="STOPPED">STOPPED</option>
                    <option value="HOLD_FOR_APPROVAL">HOLD FOR APPROVAL</option>
                    <option value="REJECTED">REJECTED</option>
                  </select>
                </div>

                <button
                  onClick={fetchRequests}
                  title="Refresh Table"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.45rem 0.75rem',
                    backgroundColor: '#ffffff',
                    border: '1px solid #cbd5e1',
                    borderRadius: '0.375rem',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: '#334155',
                    cursor: 'pointer'
                  }}
                >
                  <RefreshCw size={14} className={loadingRequests ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>
            </div>

            {/* Requests Table Card */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.5rem',
              border: '1px solid #e2e8f0',
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
            }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                      <th style={{ padding: '0.85rem 1rem' }}>Req #</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Request Title</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Location</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Satellite & Indices</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Est. Storage</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Status</th>
                      <th style={{ padding: '0.85rem 1rem' }}>Submitted At</th>
                      <th style={{ padding: '0.85rem 1rem', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRequests.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: '3rem', textAlign: 'center', color: '#64748b' }}>
                          <FileText size={32} style={{ color: '#cbd5e1', marginBottom: '0.5rem' }} />
                          <p style={{ margin: 0, fontWeight: 500 }}>No satellite acquisition requests found.</p>
                          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Click "Submit New Request" to create your first pipeline task.</span>
                        </td>
                      </tr>
                    ) : (
                      filteredRequests.map((req) => (
                        <tr
                          key={req.id}
                          style={{
                            borderBottom: '1px solid #f1f5f9',
                            transition: 'background-color 0.15s',
                            cursor: 'pointer'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ffffff'}
                          onClick={() => {
                            setSelectedReqForLogs(req);
                            setIsLogsModalOpen(true);
                          }}
                        >
                          <td style={{ padding: '0.85rem 1rem', fontWeight: 700, color: '#2563eb' }}>#{req.id}</td>
                          <td style={{ padding: '0.85rem 1rem', fontWeight: 600, color: '#0f172a' }}>
                            {req.request_title}
                            {req.user_full_name && (
                              <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 400 }}>By: {req.user_full_name}</div>
                            )}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', color: '#334155' }}>
                            {req.district ? `${req.district}, ${req.state}` : req.state || 'All India'}
                          </td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{req.satellite}</span>
                            <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                              {Array.isArray(req.indices) ? req.indices.join(', ') : req.indices}
                            </div>
                          </td>
                          <td style={{ padding: '0.85rem 1rem', fontWeight: 600, color: '#0f172a' }}>
                            {req.storage_estimated_gb ? `${req.storage_estimated_gb} GB` : '—'}
                          </td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            {renderStatusBadge(req.status)}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', color: '#64748b', fontSize: '0.78rem' }}>
                            {new Date(req.created_at).toLocaleString()}
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem' }}>
                              <button
                                onClick={() => {
                                  setSelectedReqForLogs(req);
                                  setIsLogsModalOpen(true);
                                }}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  padding: '0.35rem 0.6rem',
                                  borderRadius: '0.375rem',
                                  border: '1px solid #cbd5e1',
                                  backgroundColor: '#ffffff',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  color: '#334155',
                                  cursor: 'pointer'
                                }}
                              >
                                <Terminal size={12} /> Logs
                              </button>

                              {req.status === 'PROCESSING' ? (
                                <button
                                  onClick={() => handleStop(req.id)}
                                  disabled={stoppingId === req.id}
                                  title="Stop / Cancel Pipeline Execution"
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.35rem 0.6rem',
                                    borderRadius: '0.375rem',
                                    border: '1px solid #ef4444',
                                    backgroundColor: '#fef2f2',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    color: '#dc2626',
                                    cursor: 'pointer'
                                  }}
                                >
                                  <Square size={12} fill="#dc2626" />
                                  {stoppingId === req.id ? 'Stopping...' : 'Stop'}
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleRerun(req.id)}
                                  disabled={rerunningId === req.id}
                                  title="Re-run Pipeline Request"
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.35rem 0.6rem',
                                    borderRadius: '0.375rem',
                                    border: '1px solid #2563eb',
                                    backgroundColor: '#eff6ff',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    color: '#2563eb',
                                    cursor: 'pointer'
                                  }}
                                >
                                  <Play size={12} className={rerunningId === req.id ? 'animate-spin' : ''} />
                                  {rerunningId === req.id ? 'Retrying...' : 'Re-run'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 2: Submit New Request Form */}
        {/* ========================================================================= */}
        {activeTab === 'new_request' && (
          <div style={{ maxWidth: '850px', margin: '0 auto', width: '100%' }}>
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '2rem',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.03)'
            }}>
              <div style={{ marginBottom: '1.5rem', borderBottom: '1px solid #f1f5f9', pb: '1rem' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.25rem 0' }}>
                  Submit Satellite Acquisition & Pipeline Request
                </h2>
                <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>
                  Configure district parameters, date bounds, satellite sensors, and indices for automated gap check & acquisition.
                </p>
              </div>

              {reqFormMessage && (
                <div style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.85rem',
                  marginBottom: '1.25rem',
                  backgroundColor: reqFormMessage.type === 'success' ? '#dcfce7' : '#fef2f2',
                  color: reqFormMessage.type === 'success' ? '#166534' : '#991b1b',
                  border: reqFormMessage.type === 'success' ? '1px solid #bbf7d0' : '1px solid #fecaca'
                }}>
                  {reqFormMessage.text}
                </div>
              )}

              <form onSubmit={handleShowConfirm} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                
                {/* Title */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Request Title / Label <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={reqTitle}
                    onChange={(e) => setReqTitle(e.target.value)}
                    placeholder="e.g. Kharif Crop Monitoring - Anugul District 2025"
                    style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.9rem', outline: 'none' }}
                  />
                </div>

                {/* Area Type + Season Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Area Type <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <select
                      value={areaType}
                      onChange={(e) => setAreaType(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}
                    >
                      <option value="Administrative Unit">Administrative Unit</option>
                      <option value="Uploaded Boundary">Uploaded Boundary</option>
                      <option value="BBox">Bounding Box (BBox)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Season / Crop Cycle
                    </label>
                    <select
                      value={season}
                      onChange={(e) => setSeason(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}
                    >
                      <option value="Kharif">Kharif (Jun – Oct)</option>
                      <option value="Rabi">Rabi (Nov – Mar)</option>
                      <option value="Zaid">Zaid (Mar – Jun)</option>
                      <option value="Annual">Annual</option>
                    </select>
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Used for labelling and pre-filling dates</span>
                  </div>
                </div>

                {/* Region & Administrative Boundary Selection */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      State / Union Territory
                    </label>
                    <select
                      value={selectedState}
                      onChange={(e) => { setSelectedState(e.target.value); setSelectedDistrict(''); }}
                      disabled={loadingBoundaries}
                      style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}
                    >
                      <option value="">-- Select State --</option>
                      {statesList.map((st, i) => (
                        <option key={i} value={st.state_name}>{st.state_name}</option>
                      ))}
                      <option value="">{loadingBoundaries ? 'Loading States from DB...' : '-- Select State --'}</option>
                      {statesList.map((st, i) => {
                        const name = typeof st === 'string' ? st : (st.state_name || '');
                        return <option key={i} value={name}>{name}</option>;
                      })}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      District (blank = whole state)
                    </label>
                    <select
                      value={selectedDistrict}
                      onChange={(e) => setSelectedDistrict(e.target.value)}
                      disabled={!selectedState || loadingBoundaries}
                      style={{
                        width: '100%',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                        backgroundColor: '#ffffff',
                        outline: 'none',
                        opacity: (!selectedState || loadingBoundaries) ? 0.6 : 1,
                        cursor: (!selectedState) ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <option value="">
                        {!selectedState ? '-- Select State First --' : '-- Whole State (All Districts) --'}
                      </option>
                      {availableDistricts.map((d, i) => {
                        const name = typeof d === 'string' ? d : (d.district_name || '');
                        return <option key={i} value={name}>{name}</option>;
                      })}
                    </select>
                  </div>
                </div>

                {/* Date Range Selection */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Acquisition Start Date <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="date"
                      required
                      min="2018-12-01"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: startDateError ? '1px solid #ef4444' : '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                        outline: 'none'
                      }}
                    />
                    {startDateError && <span style={{ fontSize: '0.72rem', color: '#ef4444' }}>{startDateError}</span>}
                    <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Earliest: 2018-12-01 (AWS archive depth)</span>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Acquisition End Date <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="date"
                      required
                      min="2018-12-01"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: (dateSanityError || dateSpanError) ? '1px solid #ef4444' : '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                        outline: 'none'
                      }}
                    />
                    {(dateSanityError || dateSpanError) && (
                      <span style={{ fontSize: '0.72rem', color: '#ef4444' }}>{dateSanityError || dateSpanError}</span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Max span: 365 days (1 year) · Future end = standing request</span>
                  </div>
                </div>

                {/* Satellite Constellation */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>
                    Satellite Sensor <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <label style={{ flex: 1, border: satellite === 'Sentinel-1' ? '2px solid #2563eb' : '1px solid #cbd5e1', backgroundColor: satellite === 'Sentinel-1' ? '#eff6ff' : '#ffffff', borderRadius: '0.5rem', padding: '0.75rem 1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="radio" name="satellite" value="Sentinel-1" checked={satellite === 'Sentinel-1'} onChange={(e) => { setSatellite(e.target.value); setSelectedIndices(['VV/VH']); }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#0f172a' }}>Sentinel-1 (SAR Radar)</div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>C-band SAR · ~0.615 GB/scene · Works through cloud cover</div>
                      </div>
                    </label>

                    <label style={{ flex: 1, border: satellite === 'Sentinel-2' ? '2px solid #2563eb' : '1px solid #cbd5e1', backgroundColor: satellite === 'Sentinel-2' ? '#eff6ff' : '#ffffff', borderRadius: '0.5rem', padding: '0.75rem 1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="radio" name="satellite" value="Sentinel-2" checked={satellite === 'Sentinel-2'} onChange={(e) => { setSatellite(e.target.value); setSelectedIndices(['NDVI', 'LSWI']); }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#0f172a' }}>Sentinel-2 (MSI Optical)</div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>Multi-Spectral · ~0.270 GB/scene · NDVI, LSWI indices</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Spectral Indices */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>
                    Target Spectral Indices <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                    {(satellite === 'Sentinel-1' ? ['VV/VH'] : ['NDVI', 'LSWI', 'EVI', 'NDWI']).map((idx) => {
                      const checked = selectedIndices.includes(idx);
                      return (
                        <label key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.75rem', borderRadius: '0.375rem', border: checked ? '1px solid #2563eb' : '1px solid #cbd5e1', backgroundColor: checked ? '#eff6ff' : '#ffffff', fontSize: '0.82rem', fontWeight: 600, color: checked ? '#1d4ed8' : '#475569', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={(e) => {
                            if (e.target.checked) setSelectedIndices([...selectedIndices, idx]);
                            else setSelectedIndices(selectedIndices.filter(i => i !== idx));
                          }} />
                          {idx}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Composite Interval + Priority Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Composite Interval</label>
                    <select value={compositeInterval} onChange={(e) => setCompositeInterval(e.target.value)} style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}>
                      <option value="none">None (Individual Scenes)</option>
                      <option value="weekly">Weekly</option>
                      <option value="fortnightly">Fortnightly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Priority</label>
                    <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}>
                      <option value="high">High Priority</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low Priority</option>
                    </select>
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>High-priority requests are downloaded first</span>
                  </div>
                </div>

                {/* Delivery Outputs */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>Delivery Outputs</label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.85rem', borderRadius: '0.375rem', border: '1px solid #2563eb', backgroundColor: '#eff6ff', fontSize: '0.82rem', fontWeight: 600, color: '#1d4ed8', cursor: 'default' }}>
                    <CheckCircle size={14} /> Clipped Images (always produced)
                  </label>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8', marginLeft: '0.5rem' }}>Per-district boundary clip, reprojected to unified CRS</span>
                </div>

                {/* Dynamic Estimated Storage Box */}
                <div style={{ backgroundColor: willBeRejected ? '#fef2f2' : willRequireApproval ? '#fffbeb' : '#f0fdf4', border: `1px solid ${willBeRejected ? '#fca5a5' : willRequireApproval ? '#fde68a' : '#bbf7d0'}`, borderRadius: '0.5rem', padding: '1rem 1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600, color: '#64748b', marginBottom: '0.25rem' }}>
                        <HardDrive size={14} color="#2563eb" /> Estimated Storage Requirement
                      </div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a' }}>
                        {estimatedGb} <span style={{ fontSize: '0.9rem', fontWeight: 500, color: '#64748b' }}>GB</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>
                        ~{estResult.scenes} scenes · {estResult.tiles} tiles · {estResult.months} months
                      </div>
                    </div>
                    <div>
                      {willBeRejected ? (
                        <span style={{ padding: '0.4rem 0.75rem', borderRadius: '0.375rem', fontSize: '0.78rem', fontWeight: 600, backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <XCircle size={14} /> Will Be REJECTED (&gt;10,000 GB)
                        </span>
                      ) : willRequireApproval ? (
                        <span style={{ padding: '0.4rem 0.75rem', borderRadius: '0.375rem', fontSize: '0.78rem', fontWeight: 600, backgroundColor: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <AlertTriangle size={14} /> Requires Admin Approval (&gt;2,000 GB)
                        </span>
                      ) : (
                        <span style={{ padding: '0.4rem 0.75rem', borderRadius: '0.375rem', fontSize: '0.78rem', fontWeight: 600, backgroundColor: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <CheckCircle size={14} /> Auto-Accepted (&lt;2,000 GB)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Date error summary */}
                {formDateError && (
                  <div style={{ padding: '0.6rem 0.85rem', backgroundColor: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '0.375rem', fontSize: '0.82rem', color: '#991b1b', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <AlertTriangle size={14} /> {formDateError}
                  </div>
                )}

                {/* Submit — opens confirmation modal */}
                <button
                  type="submit"
                  disabled={submittingReq || !!formDateError || willBeRejected}
                  style={{
                    backgroundColor: (submittingReq || formDateError || willBeRejected) ? '#94a3b8' : '#2563eb',
                    color: '#ffffff',
                    fontWeight: 600,
                    fontSize: '0.95rem',
                    padding: '0.75rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    cursor: (submittingReq || formDateError || willBeRejected) ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    marginTop: '0.5rem'
                  }}
                >
                  <ChevronRight size={18} />
                  {submittingReq ? 'Submitting...' : 'Review & Confirm Request'}
                </button>
              </form>

              {/* ── Pre-Submit Confirmation Modal (SRS 8.3) ── */}
              {showConfirmModal && confirmPayload && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
                  <div style={{ backgroundColor: '#ffffff', borderRadius: '0.75rem', padding: '2rem', maxWidth: '520px', width: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.15)', border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                      <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Info size={20} color="#2563eb" /> Confirm Acquisition Request
                      </h3>
                      <button onClick={() => setShowConfirmModal(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}>
                        <X size={20} />
                      </button>
                    </div>
                    <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem' }}>
                      Please review the estimate below before submitting. Most large requests are date-entry errors — correct if the numbers look wrong.
                    </p>

                    <div style={{ backgroundColor: '#f8fafc', borderRadius: '0.5rem', padding: '1rem', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Title</span><span style={{ fontWeight: 600, color: '#0f172a', textAlign: 'right', maxWidth: '60%' }}>{confirmPayload.request_title}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Location</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{confirmPayload.district ? `${confirmPayload.district}, ${confirmPayload.state}` : (confirmPayload.state || '—')}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Season</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{confirmPayload.season || '—'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Satellite</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{confirmPayload.satellite}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Date Range</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{confirmPayload.start_date} → {confirmPayload.end_date}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Indices</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{(confirmPayload.indices || []).join(', ')}</span></div>
                      <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '0.25rem 0' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Scenes</span><span style={{ fontWeight: 700, color: '#0f172a' }}>~{estResult.scenes}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Storage</span><span style={{ fontWeight: 700, fontSize: '1rem', color: willRequireApproval ? '#92400e' : '#166534' }}>{estimatedGb} GB</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Expected Status</span><span style={{ fontWeight: 700, color: willRequireApproval ? '#92400e' : '#166534' }}>{willRequireApproval ? 'HOLD FOR APPROVAL' : 'AUTO-ACCEPTED + PIPELINE STARTS'}</span></div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem' }}>
                      <button
                        onClick={() => setShowConfirmModal(false)}
                        style={{ flex: 1, padding: '0.65rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontWeight: 600, fontSize: '0.875rem', color: '#334155', backgroundColor: '#ffffff', cursor: 'pointer' }}
                      >
                        ← Go Back & Edit
                      </button>
                      <button
                        onClick={handleConfirmAndSubmit}
                        disabled={submittingReq}
                        style={{ flex: 1, padding: '0.65rem', border: 'none', borderRadius: '0.375rem', fontWeight: 600, fontSize: '0.875rem', color: '#ffffff', backgroundColor: '#2563eb', cursor: 'pointer' }}
                      >
                        {submittingReq ? 'Submitting...' : '✓ Confirm & Submit'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 3: Admin Control & System Feed */}
        {/* ========================================================================= */}
        {activeTab === 'admin' && currentUser.role === 'ADMIN' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Live Pipeline Telemetry Feed */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={18} color="#2563eb" /> Real-Time Pipeline Telemetry & Active Jobs
              </h3>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Job ID</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>User</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Location</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Stage</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Progress</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Live Telemetry</th>
                      <th style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>Admin Controls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminLiveFeed.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>No active telemetry jobs found.</td>
                      </tr>
                    ) : (
                      adminLiveFeed.map((feedItem) => (
                        <tr key={feedItem.request_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '0.75rem 0.85rem', fontWeight: 700 }}>#{feedItem.request_id}</td>
                          <td style={{ padding: '0.75rem 0.85rem' }}>{feedItem.user_name}</td>
                          <td style={{ padding: '0.75rem 0.85rem' }}>{feedItem.location}</td>
                          <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600, color: '#2563eb' }}>{feedItem.pipeline_stage}</td>
                          <td style={{ padding: '0.75rem 0.85rem', width: '140px' }}>
                            <div style={{ backgroundColor: '#e2e8f0', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                              <div style={{ backgroundColor: '#2563eb', height: '100%', width: `${feedItem.progress_pct}%`, transition: 'width 0.3s' }} />
                            </div>
                            <span style={{ fontSize: '0.72rem', color: '#64748b' }}>{feedItem.progress_pct}%</span>
                          </td>
                          <td style={{ padding: '0.75rem 0.85rem', color: '#334155', fontSize: '0.8rem' }}>{feedItem.live_telemetry}</td>
                          <td style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>
                            {feedItem.status === 'HOLD_FOR_APPROVAL' && (
                              <button
                                onClick={() => handleApproveStatus(feedItem.request_id, 'ACCEPTED')}
                                style={{
                                  padding: '0.3rem 0.6rem',
                                  backgroundColor: '#166534',
                                  color: '#ffffff',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  cursor: 'pointer'
                                }}
                              >
                                Approve Request
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* User Management Section */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Users size={18} color="#2563eb" /> System User Directory & Access Controls
              </h3>

              {adminUserMsg && (
                <div style={{
                  padding: '0.6rem 0.85rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.82rem',
                  marginBottom: '1rem',
                  backgroundColor: adminUserMsg.type === 'success' ? '#dcfce7' : '#fef2f2',
                  color: adminUserMsg.type === 'success' ? '#166534' : '#991b1b'
                }}>
                  {adminUserMsg.text}
                </div>
              )}

              {/* Create User Sub-Form */}
              <form onSubmit={handleCreateUser} style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.75rem',
                backgroundColor: '#f8fafc',
                padding: '1rem',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
                marginBottom: '1.25rem'
              }}>
                <input
                  type="text"
                  required
                  placeholder="Full Name"
                  value={newAdminFullName}
                  onChange={(e) => setNewAdminFullName(e.target.value)}
                  style={{ padding: '0.45rem 0.65rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                />
                <input
                  type="email"
                  required
                  placeholder="User Email"
                  value={newAdminEmail}
                  onChange={(e) => setNewAdminEmail(e.target.value)}
                  style={{ padding: '0.45rem 0.65rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                />
                <input
                  type="password"
                  required
                  placeholder="Password (min 6 chars)"
                  minLength={6}
                  value={newAdminPassword}
                  onChange={(e) => setNewAdminPassword(e.target.value)}
                  style={{ padding: '0.45rem 0.65rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                />
                <select
                  value={newAdminRole}
                  onChange={(e) => setNewAdminRole(e.target.value)}
                  style={{ padding: '0.45rem 0.65rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem', backgroundColor: '#ffffff' }}
                >
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
                <button
                  type="submit"
                  style={{
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    cursor: 'pointer'
                  }}
                >
                  + Add User
                </button>
              </form>

              {/* Users Directory Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                      <th style={{ padding: '0.75rem 0.85rem' }}>ID</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Full Name</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Email</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Role</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Account Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers.map((u) => (
                      <tr key={u.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600 }}>#{u.id}</td>
                        <td style={{ padding: '0.75rem 0.85rem' }}>{u.full_name || '—'}</td>
                        <td style={{ padding: '0.75rem 0.85rem' }}>{u.email}</td>
                        <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600, color: u.role === 'ADMIN' ? '#1d4ed8' : '#475569' }}>
                          {u.role}
                        </td>
                        <td style={{ padding: '0.75rem 0.85rem' }}>
                          <span style={{ color: '#166534', fontWeight: 600 }}>ACTIVE</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: Execution Logs Terminal Viewer */}
      {/* ========================================================================= */}
      {isLogsModalOpen && selectedReqForLogs && (
        <div className="modal-overlay">
          <div className="modal-content">
            
            {/* Modal Header */}
            <div style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#f8fafc'
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                    Execution Logs — #{selectedReqForLogs.id}: {selectedReqForLogs.request_title}
                  </h3>
                  {renderStatusBadge(selectedReqForLogs.status)}
                </div>
                <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                  Target: {selectedReqForLogs.district || selectedReqForLogs.state} | Satellite: {selectedReqForLogs.satellite} | Est. Storage: {selectedReqForLogs.storage_estimated_gb} GB
                </span>
              </div>

              <button
                onClick={() => setIsLogsModalOpen(false)}
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '0.25rem'
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body: Live Terminal View */}
            <div style={{ padding: '1.25rem', backgroundColor: '#0f172a', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="log-terminal">
                {renderLogContent(selectedReqForLogs.execution_logs)}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Modal Footer Controls */}
            <div style={{
              padding: '0.85rem 1.25rem',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#ffffff'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <RefreshCw size={12} className="animate-spin" /> Live logs stream updating automatically (S3 / DB)
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {selectedReqForLogs.status === 'PROCESSING' && (
                  <button
                    onClick={() => handleStop(selectedReqForLogs.id)}
                    disabled={stoppingId === selectedReqForLogs.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      backgroundColor: '#dc2626',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      padding: '0.45rem 0.85rem',
                      border: 'none',
                      borderRadius: '0.375rem',
                      cursor: 'pointer'
                    }}
                  >
                    <Square size={13} fill="#ffffff" /> {stoppingId === selectedReqForLogs.id ? 'Stopping...' : 'Stop Execution'}
                  </button>
                )}

                <button
                  onClick={() => handleRerun(selectedReqForLogs.id)}
                  disabled={rerunningId === selectedReqForLogs.id || selectedReqForLogs.status === 'PROCESSING'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    backgroundColor: selectedReqForLogs.status === 'PROCESSING' ? '#94a3b8' : '#2563eb',
                    color: '#ffffff',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    padding: '0.45rem 0.85rem',
                    border: 'none',
                    borderRadius: '0.375rem',
                    cursor: selectedReqForLogs.status === 'PROCESSING' ? 'not-allowed' : 'pointer'
                  }}
                >
                  <Play size={14} /> {rerunningId === selectedReqForLogs.id ? 'Retrying...' : 'Re-run / Resume Pipeline'}
                </button>

                <button
                  onClick={() => setIsLogsModalOpen(false)}
                  style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #cbd5e1',
                    color: '#334155',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    padding: '0.45rem 0.85rem',
                    borderRadius: '0.375rem',
                    cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: Storage Calculation Explanation */}
      {/* ========================================================================= */}
      {showStorageModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '550px' }}>
            <div style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#f8fafc'
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                Storage Estimation Breakdown (SRS Section 8.3 & 11.1)
              </h3>
              <button onClick={() => setShowStorageModal(false)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '1.25rem', fontSize: '0.85rem', color: '#334155', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ margin: 0 }}>
                Storage estimates are calculated dynamically based on spatial tile resolution, satellite sensor characteristics, and requested duration:
              </p>
              <div style={{ backgroundColor: '#f1f5f9', padding: '0.75rem', borderRadius: '0.375rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                Est. GB = Tile Count × Acquisitions/Mo × Months × Scene Size (GB)
              </div>
              <ul style={{ paddingLeft: '1.25rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <li><b>Tile Count:</b> Resolved dynamically from PostgreSQL tile grid mappings (District ~8 tiles, State ~32 tiles).</li>
                <li><b>Acquisition Frequency:</b> ~6 scene passes/month for Sentinel-2 optical, ~2.5 passes/month for Sentinel-1 radar.</li>
                <li><b>Scene Size:</b> ~0.270 GB for optical bands, ~0.615 GB for dual-pol SAR.</li>
                <li><b>Approval Threshold:</b> Requests under <b>500 GB</b> are auto-accepted. Requests over 500 GB hold for Admin review.</li>
              </ul>
            </div>
            <div style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0', textAlign: 'right', backgroundColor: '#ffffff' }}>
              <button
                onClick={() => setShowStorageModal(false)}
                style={{ backgroundColor: '#2563eb', color: '#ffffff', border: 'none', padding: '0.4rem 0.85rem', borderRadius: '0.375rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

