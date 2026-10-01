import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  Satellite, Activity, HardDrive, User, LogOut, RefreshCw, FileText,
  CheckCircle, Clock, AlertTriangle, XCircle, Plus, Search, Database,
  Calendar, MapPin, Sliders, Shield, Users, Check, ChevronRight, ChevronDown, Info,
  HelpCircle, X, Download, Play, Terminal, Eye, EyeOff, KeyRound, ArrowLeft, Square, Table
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
  const [selectedSatellites, setSelectedSatellites] = useState(['Sentinel-2']);
  const satellite = selectedSatellites.join(', ');
  const [selectedIndices, setSelectedIndices] = useState(['NDVI', 'LSWI']);
  const [compositeInterval, setCompositeInterval] = useState('none');
  const [priority, setPriority] = useState('normal');
  const [maxCloudCover, setMaxCloudCover] = useState(100);
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
  const [logViewMode, setLogViewMode] = useState('table'); // 'table' | 'raw'
  const [logFilter, setLogFilter] = useState('all'); // 'all' | 'downloads' | 'errors'
  const [logSearchQuery, setLogSearchQuery] = useState('');

  // ---------------------------------------------------------------------------
  // 6. Admin State
  // ---------------------------------------------------------------------------
  const [adminUsers, setAdminUsers] = useState([]);
  const [loadingAdmin, setLoadingAdmin] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [userRequestsMap, setUserRequestsMap] = useState({});
  const [loadingUserRequests, setLoadingUserRequests] = useState({});
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [newAdminFullName, setNewAdminFullName] = useState('');
  const [newAdminRole, setNewAdminRole] = useState('USER');
  const [adminUserMsg, setAdminUserMsg] = useState(null);

  // ---------------------------------------------------------------------------
  // 7. Data Retrieval & Export State & Handlers
  // ---------------------------------------------------------------------------
  const [retState, setRetState] = useState('');
  const [retDistrict, setRetDistrict] = useState('');
  const [retSatellite, setRetSatellite] = useState('ALL');
  const [retBand, setRetBand] = useState('ALL');
  const [retStartDate, setRetStartDate] = useState('');
  const [retEndDate, setRetEndDate] = useState('');
  const [retSelectedReqId, setRetSelectedReqId] = useState('');
  const [retResults, setRetResults] = useState(null);
  const [loadingRet, setLoadingRet] = useState(false);
  const [retCopyNotice, setRetCopyNotice] = useState(null);
  const [retDownloadedStates, setRetDownloadedStates] = useState([]);
  const [retDownloadedDistricts, setRetDownloadedDistricts] = useState([]);
  const [loadingRetRegions, setLoadingRetRegions] = useState(false);

  const handleExecuteRetrieval = async () => {
    setLoadingRet(true);
    setRetCopyNotice(null);
    try {
      const params = {};
      if (retState) params.state = retState;
      if (retDistrict) params.district = retDistrict;
      if (retSatellite && retSatellite !== 'ALL') params.satellite = retSatellite;
      if (retBand && retBand !== 'ALL') params.band = retBand;
      if (retStartDate) params.start_date = retStartDate;
      if (retEndDate) params.end_date = retEndDate;

      const res = await axios.get(`${API_BASE}/requests/tifs/retrieve`, { params, headers: getAuthHeader() });
      setRetResults(res.data);
    } catch (err) {
      alert(formatApiError(err, 'Error retrieving downloaded data.'));
    } finally {
      setLoadingRet(false);
    }
  };

  const handleCopyPaths = () => {
    if (!retResults || !retResults.tif_paths || retResults.tif_paths.length === 0) return;
    const textToCopy = retResults.tif_paths.join('\n');
    navigator.clipboard.writeText(textToCopy);
    setRetCopyNotice(`✓ ${retResults.tif_paths.length} file paths copied to clipboard!`);
    setTimeout(() => setRetCopyNotice(null), 3000);
  };

  const handleExportCsv = () => {
    if (!retResults || !retResults.tifs || retResults.tifs.length === 0) return;
    const headers = ['Scene ID', 'Tile', 'Sensing Date', 'Satellite', 'Band', 'Size (MB)', 'Path'];
    const rows = retResults.tifs.map(t => [
      t.scene_id,
      t.tile,
      t.sensing_date,
      t.satellite,
      t.band,
      (t.size_bytes / (1024 * 1024)).toFixed(2),
      `"${t.path.replace(/"/g, '""')}"`
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `SDAP_GeoTIFF_Manifest_${retDistrict || retState || 'Export'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const [downloadingZip, setDownloadingZip] = useState(false);
  const [retNotice, setRetNotice] = useState(null);

  const handleDownloadFile = async (filePath) => {
    if (!filePath) return;
    setRetNotice(null);
    try {
      const currentToken = token || localStorage.getItem('sdap_token');
      const encodedPath = encodeURIComponent(filePath);
      const downloadUrl = `${API_BASE}/requests/tifs/download-file?file_path=${encodedPath}${currentToken ? `&token=${encodeURIComponent(currentToken)}` : ''}`;
      const res = await axios.get(downloadUrl, {
        headers: getAuthHeader(),
        responseType: 'blob'
      });
      const fileName = filePath.split(/[/\\]/).pop() || 'raster.tif';
      const blob = new Blob([res.data], { type: res.headers['content-type'] || 'image/tiff' });
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      let msg = 'Failed to download file.';
      if (err.response && err.response.data instanceof Blob) {
        try {
          const rawText = await err.response.data.text();
          const parsed = JSON.parse(rawText);
          if (parsed.detail) msg = parsed.detail;
        } catch (e) {}
      } else {
        msg = formatApiError(err, msg);
      }
      setRetNotice({ type: 'error', text: `⚠️ ${msg}` });
    }
  };

  const handleDownloadZip = async () => {
    setDownloadingZip(true);
    setRetNotice(null);
    try {
      const currentToken = token || localStorage.getItem('sdap_token');
      const params = new URLSearchParams();
      if (retState) params.append('state', retState);
      if (retDistrict) params.append('district', retDistrict);
      if (retSatellite && retSatellite !== 'ALL') params.append('satellite', retSatellite);
      if (retBand && retBand !== 'ALL') params.append('band', retBand);
      if (retStartDate) params.append('start_date', retStartDate);
      if (retEndDate) params.append('end_date', retEndDate);
      if (currentToken) params.append('token', currentToken);

      const res = await axios.get(`${API_BASE}/requests/tifs/download-zip?${params.toString()}`, {
        headers: getAuthHeader(),
        responseType: 'blob'
      });

      const fileName = `SDAP_GeoTIFF_${retDistrict || retState || 'Export'}.zip`;
      const blob = new Blob([res.data], { type: 'application/zip' });
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
      setRetNotice({ type: 'success', text: `✓ ZIP Archive (${fileName}) downloaded successfully!` });
    } catch (err) {
      let msg = 'No matching downloaded GeoTIFF files found for the selected State/District/Date Range criteria.';
      if (err.response && err.response.data instanceof Blob) {
        try {
          const rawText = await err.response.data.text();
          const parsed = JSON.parse(rawText);
          if (parsed.detail) msg = parsed.detail;
        } catch (e) {}
      } else {
        msg = formatApiError(err, msg);
      }
      setRetNotice({ type: 'warning', text: `⚠️ Data is not available: ${msg}` });
    } finally {
      setDownloadingZip(false);
    }
  };

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

  // Load states + districts from DB whenever token becomes available or changes
  useEffect(() => {
    if (!token) return;
    const storedToken = token || localStorage.getItem('sdap_token');
    if (!storedToken) return;
    setLoadingBoundaries(true);
    const authHeader = { Authorization: `Bearer ${storedToken}` };
    Promise.all([
      axios.get(`${API_BASE}/boundaries/states`, { headers: authHeader }),
      axios.get(`${API_BASE}/boundaries/districts`, { headers: authHeader })
    ])
      .then(([statesRes, distRes]) => {
        const rawStates = statesRes.data || [];
        const rawDistricts = distRes.data || [];
        setStatesList(rawStates);
        setDistrictsList(rawDistricts);
        console.log(`[Boundaries] Loaded ${rawStates.length} states, ${rawDistricts.length} districts`);
      })
      .catch(err => console.error('[Boundaries] Failed to load:', err))
      .finally(() => setLoadingBoundaries(false));
  }, [token]);

  // Fetch Downloaded Regions for Data Retrieval Tab (Only States & Districts in DB/storage)
  const fetchDownloadedRegions = useCallback(async () => {
    if (!token) return;
    setLoadingRetRegions(true);
    try {
      const res = await axios.get(`${API_BASE}/requests/tifs/available-regions`, { headers: getAuthHeader() });
      if (res.data) {
        setRetDownloadedStates(res.data.states || []);
        setRetDownloadedDistricts(res.data.districts || []);
      }
    } catch (err) {
      console.error('Error loading downloaded regions:', err);
    } finally {
      setLoadingRetRegions(false);
    }
  }, [token]);

  useEffect(() => {
    if (token && activeTab === 'retrieve_data') {
      fetchDownloadedRegions();
    }
  }, [token, activeTab, fetchDownloadedRegions]);

  // Fetch Requests List (scoped to logged-in user - stable reference)
  const fetchRequests = useCallback(async () => {
    if (!token) return;
    setLoadingRequests(true);
    try {
      const res = await axios.get(`${API_BASE}/requests/?scope=mine`, { headers: getAuthHeader() });
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

  // Fetch Admin Users Directory
  const fetchAdminData = useCallback(async () => {
    if (!token || currentUser?.role !== 'ADMIN') return;
    setLoadingAdmin(true);
    try {
      const usersRes = await axios.get(`${API_BASE}/users/`, { headers: getAuthHeader() });
      setAdminUsers(usersRes.data || []);
    } catch (err) {
      console.error('Error loading admin users directory:', err);
    } finally {
      setLoadingAdmin(false);
    }
  }, [token, currentUser]);

  // Fetch Specific User's Requests (Admin Only)
  const fetchUserRequests = useCallback(async (userId) => {
    if (!userId) return;
    setLoadingUserRequests(prev => ({ ...prev, [userId]: true }));
    try {
      const res = await axios.get(`${API_BASE}/users/${userId}/requests`, { headers: getAuthHeader() });
      setUserRequestsMap(prev => ({ ...prev, [userId]: res.data || [] }));
    } catch (err) {
      console.error(`Error loading requests for user ${userId}:`, err);
    } finally {
      setLoadingUserRequests(prev => ({ ...prev, [userId]: false }));
    }
  }, []);

  const toggleExpandUser = (userId) => {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
    } else {
      setExpandedUserId(userId);
      fetchUserRequests(userId);
    }
  };

  const openLogsModal = (req) => {
    selectedReqIdRef.current = req.id;
    setSelectedReqForLogs(req);
    setIsLogsModalOpen(true);
  };

  const closeLogsModal = () => {
    selectedReqIdRef.current = null;
    setIsLogsModalOpen(false);
  };

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

  // Smart polling: poll requests & active log modal continuously every 2s
  useEffect(() => {
    if (!token) return;

    const interval = setInterval(async () => {
      fetchRequests();
      if (activeTab === 'admin' && currentUser?.role === 'ADMIN') {
        fetchAdminData();
        if (expandedUserId) {
          fetchUserRequests(expandedUserId);
        }
      }
      if (isLogsModalOpen && selectedReqIdRef.current) {
        try {
          const res = await axios.get(`${API_BASE}/requests/${selectedReqIdRef.current}`, { headers: getAuthHeader() });
          if (res.data) {
            setSelectedReqForLogs(res.data);
          }
        } catch (e) {
          // ignore polling failure
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [token, isLogsModalOpen, activeTab, currentUser?.role, expandedUserId]);

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
    const isS1 = selectedSatellites.includes('Sentinel-1');
    const isS2 = selectedSatellites.includes('Sentinel-2');

    let totalGB = 0;
    let scenesEstimate = 0;

    if (isS1) {
      totalGB += tileCount * 2.5 * months * 0.615;
      scenesEstimate += Math.round(tileCount * 2.5 * months);
    }
    if (isS2) {
      totalGB += tileCount * 6.0 * months * 0.270;
      scenesEstimate += Math.round(tileCount * 6.0 * months);
    }
    if (!isS1 && !isS2) {
      totalGB = tileCount * 6.0 * months * 0.270;
      scenesEstimate = Math.round(tileCount * 6.0 * months);
    }

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
    if (selectedSatellites.length === 0) {
      setReqFormMessage({ type: 'error', text: 'Please select at least one satellite sensor (Sentinel-1 or Sentinel-2).' });
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

    let bands = [];
    if (selectedSatellites.includes('Sentinel-1')) {
      bands.push('VV', 'VH');
    }
    if (selectedSatellites.includes('Sentinel-2')) {
      bands.push('B04', 'B08', 'B08A', 'B11', 'SCL');
    }

    const payload = {
      request_title: reqTitle || `Acquisition - ${selectedDistrict || selectedState || 'Region'}`,
      area_type: areaType,
      state: selectedState || null,
      district: selectedDistrict || null,
      season: season || null,
      start_date: startDate,
      end_date: endDate,
      satellite: selectedSatellites.join(', '),
      bands: bands,
      indices: selectedIndices,
      composite_interval: compositeInterval,
      priority: priority,
      max_cloud_cover: parseFloat(maxCloudCover) || 100.0,
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

  // Dynamically parse acquisition scenes from raw execution logs
  const parseAcquisitionScenes = (rawLogs, selectedReq) => {
    const scenesMap = {};
    const tilesSet = new Set();

    const S1_BANDS = ['VV', 'VH', 'VV_VH', 'VV/VH'];
    const DEFAULT_S2_BANDS = ['B04', 'B08', 'B11', 'SCL'];
    const requestSatellite = selectedReq?.satellite || '';
    const hasS1 = requestSatellite.includes('Sentinel-1');
    const hasS2 = requestSatellite.includes('Sentinel-2');

    let reqBands;
    if (Array.isArray(selectedReq?.bands) && selectedReq.bands.length > 0) {
      reqBands = selectedReq.bands;
    } else if (hasS1 && !hasS2) {
      reqBands = ['VV', 'VH', 'VV_VH'];
    } else {
      reqBands = DEFAULT_S2_BANDS;
    }

    if (rawLogs && rawLogs.trim().length > 0) {
      const lines = rawLogs.split(/\r?\n/).map(l => l.trim());

      for (const line of lines) {
        const tilesMatch = line.match(/Tiles:\s*\[([^\]]+)\]/i) || line.match(/Tiles identified:\s*\[([^\]]+)\]/i);
        if (tilesMatch) {
          tilesMatch[1].replace(/['"]/g, '').split(',').forEach(t => {
            const cleanT = t.trim();
            if (cleanT && cleanT !== 'S1_SAR') tilesSet.add(cleanT);
          });
        }

        const tileDirectMatch = line.match(/Tile\s+'?([A-Za-z0-9_]+)'?/i) || line.match(/\[TILE STATUS:\s*([A-Za-z0-9_]+)\]/i);
        if (tileDirectMatch && tileDirectMatch[1] !== 'S1_SAR') {
          tilesSet.add(tileDirectMatch[1]);
        }

        const sceneMatch = line.match(/\b(S[12][A-C]_[0-9A-Za-z_]+)/i);
        if (sceneMatch) {
          const folderName = sceneMatch[1];
          const parts = folderName.split('_');

          if (parts.length >= 3) {
            const sat = parts[0];
            const isS1 = sat.startsWith('S1');
            let tile = '—';
            let formattedDate = '—';

            if (isS1) {
              tile = 'S1_SAR';
              for (const part of parts) {
                const dtM = part.match(/^(\d{8})T\d+$/);
                if (dtM) {
                  const d8 = dtM[1];
                  formattedDate = `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
                  break;
                }
              }
            } else {
              tile = parts[1] || '—';
              const datePart = parts[2] || '';
              formattedDate = (datePart.length === 8 && /^\d+$/.test(datePart))
                ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
                : (datePart || '—');
              if (tile.length >= 4 && tile !== '—') tilesSet.add(tile);
            }

            const isFailed = /FAILED|ERROR/.test(line);
            const initialBands = isS1
              ? ['VV', 'VH', 'VV_VH']
              : reqBands.filter(b => !S1_BANDS.includes(b));

            if (!scenesMap[folderName]) {
              scenesMap[folderName] = {
                folder: folderName,
                tile: tile,
                date: formattedDate !== '—' ? formattedDate : (selectedReq?.start_date || '—'),
                satellite: sat,
                status: isFailed ? 'FAILED' : 'COMPLETE',
                bands: initialBands
              };
            } else if (isFailed) {
              scenesMap[folderName].status = 'FAILED';
            }

            // Dynamically check for VV_VH or specific index bands in the log line
            if (/VV_VH|VV\/VH|SAR VV\/VH RATIO/.test(line) && isS1) {
              if (!scenesMap[folderName].bands.includes('VV_VH')) {
                scenesMap[folderName].bands.push('VV_VH');
              }
            }
          }
        }
      }
    }

    const sceneList = Object.values(scenesMap);

    if (sceneList.length === 0) {
      Array.from(tilesSet).forEach(t => {
        sceneList.push({
          folder: `Pending Scene Acquisition (${t})`,
          tile: t,
          date: selectedReq?.start_date || '—',
          satellite: selectedReq?.satellite || 'Sentinel-2',
          status: 'PENDING',
          bands: [...reqBands]
        });
      });
    }

    const totalScenes = sceneList.length;
    const completeScenes = sceneList.filter(s => s.status === 'COMPLETE').length;
    const tilesCoveredCount = Math.max(tilesSet.size, new Set(sceneList.map(s => s.tile)).size);
    const bandsNeededCount = reqBands.length;
    const progressPct = totalScenes > 0
      ? Math.round((completeScenes / totalScenes) * 100)
      : (selectedReq?.status === 'COMPLETED' ? 100 : 0);

    return {
      scenes: sceneList,
      totalScenes,
      completeScenes,
      tilesCoveredCount,
      bandsNeededCount,
      progressPct
    };
  };

  const kpiCardStyle = {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '0.65rem',
    padding: '1.1rem 1rem',
    textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  };
  const kpiLabelStyle = { fontSize: '0.78rem', fontWeight: 600, color: '#64748b', marginBottom: '0.35rem' };

  const renderLogTableView = (rawLogs, selectedReq) => {
    const {
      scenes,
      totalScenes,
      completeScenes,
      tilesCoveredCount,
      bandsNeededCount,
      progressPct
    } = parseAcquisitionScenes(rawLogs, selectedReq);

    const filteredScenes = scenes.filter(s => {
      if (logFilter === 'downloads' && s.status !== 'COMPLETE') return false;
      if (logFilter === 'errors' && s.status !== 'FAILED') return false;
      if (logSearchQuery.trim()) {
        const q = logSearchQuery.toLowerCase();
        return (
          s.tile.toLowerCase().includes(q) ||
          s.date.toLowerCase().includes(q) ||
          s.folder.toLowerCase().includes(q) ||
          s.satellite.toLowerCase().includes(q) ||
          s.status.toLowerCase().includes(q)
        );
      }
      return true;
    });

    return (
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '0.5rem 0' }}>

        {/* KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Total Scenes</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#0f172a' }}>{totalScenes}</div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Complete</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#2563eb' }}>{completeScenes}</div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Tiles Covered</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#2563eb' }}>{tilesCoveredCount}</div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Bands Needed</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#7c3aed' }}>{bandsNeededCount}</div>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '0.85rem 1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#334155' }}>Acquisition Progress</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#2563eb' }}>{progressPct}%</span>
          </div>
          <div style={{ height: '8px', width: '100%', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, backgroundColor: '#2563eb', borderRadius: '9999px', transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Section Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0.25rem' }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a' }}>Acquisition Scenes Breakdown</span>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Showing {filteredScenes.length} of {totalScenes} scenes</span>
        </div>

        {/* Scenes Table */}
        <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '0.75rem 1rem', width: '130px', fontWeight: 700, color: '#475569' }}>Date</th>
                <th style={{ padding: '0.75rem 1rem', width: '110px', fontWeight: 700, color: '#475569' }}>Tile</th>
                <th style={{ padding: '0.75rem 1rem', width: '110px', fontWeight: 700, color: '#475569' }}>Satellite</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: '#475569' }}>Folder</th>
                <th style={{ padding: '0.75rem 1rem', width: '130px', fontWeight: 700, color: '#475569' }}>Status</th>
                <th style={{ padding: '0.75rem 1rem', width: '220px', fontWeight: 700, color: '#475569' }}>Bands Verified</th>
              </tr>
            </thead>
            <tbody>
              {filteredScenes.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                    <RefreshCw size={20} className="animate-spin" style={{ margin: '0 auto 0.5rem auto', color: '#94a3b8' }} />
                    <div>No scenes recorded yet in current execution stream.</div>
                  </td>
                </tr>
              ) : (
                filteredScenes.map((sc, idx) => (
                  <tr key={sc.folder + idx} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fcfcfd' }}>
                    <td style={{ padding: '0.7rem 1rem', color: '#334155', fontFamily: 'monospace', fontWeight: 600 }}>{sc.date}</td>
                    <td style={{ padding: '0.7rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>{sc.tile}</td>
                    <td style={{ padding: '0.7rem 1rem', color: '#475569', fontWeight: 600 }}>{sc.satellite}</td>
                    <td style={{ padding: '0.7rem 1rem', color: '#64748b', fontFamily: 'monospace', fontSize: '0.75rem' }}>{sc.folder}</td>
                    <td style={{ padding: '0.7rem 1rem' }}>
                      <span style={{
                        padding: '0.15rem 0.45rem',
                        borderRadius: '0.25rem',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        backgroundColor: sc.status === 'COMPLETE' ? '#eff6ff' : sc.status === 'FAILED' ? '#fee2e2' : '#f8fafc',
                        color: sc.status === 'COMPLETE' ? '#1d4ed8' : sc.status === 'FAILED' ? '#dc2626' : '#64748b',
                        border: sc.status === 'COMPLETE' ? '1px solid #bfdbfe' : sc.status === 'FAILED' ? '1px solid #fca5a5' : '1px solid #e2e8f0'
                      }}>
                        {sc.status}
                      </span>
                    </td>
                    <td style={{ padding: '0.7rem 1rem' }}>
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                        {sc.bands && sc.bands.map((b, bIdx) => (
                          <span key={bIdx} style={{
                            padding: '0.15rem 0.45rem',
                            borderRadius: '0.25rem',
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            fontFamily: 'monospace',
                            backgroundColor: '#f8fafc',
                            border: '1px solid #cbd5e1',
                            color: '#1e293b'
                          }}>
                            {b}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

      </div>
    );
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

          <button
            onClick={() => setActiveTab('retrieve_data')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              border: 'none',
              borderBottom: activeTab === 'retrieve_data' ? '2px solid #2563eb' : '2px solid transparent',
              color: activeTab === 'retrieve_data' ? '#2563eb' : '#64748b',
              backgroundColor: 'transparent',
              cursor: 'pointer'
            }}
          >
            <HardDrive size={16} /> Data Retrieval & Export
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
                          onClick={() => openLogsModal(req)}
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
                                onClick={() => openLogsModal(req)}
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

                {/* Satellite Constellation (Multi-Select Checkboxes) */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155' }}>
                      Satellite Sensor(s) <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                      Select Sentinel-1, Sentinel-2, or both
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <label style={{
                      flex: 1,
                      border: selectedSatellites.includes('Sentinel-1') ? '2px solid #2563eb' : '1px solid #cbd5e1',
                      backgroundColor: selectedSatellites.includes('Sentinel-1') ? '#eff6ff' : '#ffffff',
                      borderRadius: '0.5rem',
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.65rem'
                    }}>
                      <input
                        type="checkbox"
                        value="Sentinel-1"
                        checked={selectedSatellites.includes('Sentinel-1')}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSatellites([...selectedSatellites, 'Sentinel-1']);
                            if (!selectedIndices.includes('VV/VH')) {
                              setSelectedIndices([...selectedIndices, 'VV/VH']);
                            }
                          } else {
                            if (selectedSatellites.length > 1) {
                              setSelectedSatellites(selectedSatellites.filter(s => s !== 'Sentinel-1'));
                              setSelectedIndices(selectedIndices.filter(i => i !== 'VV/VH'));
                            }
                          }
                        }}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#0f172a' }}>Sentinel-1 (SAR Radar)</div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>C-band SAR · ~0.615 GB/scene · GeoTIFF (VV, VH) · Penetrates clouds</div>
                      </div>
                    </label>

                    <label style={{
                      flex: 1,
                      border: selectedSatellites.includes('Sentinel-2') ? '2px solid #2563eb' : '1px solid #cbd5e1',
                      backgroundColor: selectedSatellites.includes('Sentinel-2') ? '#eff6ff' : '#ffffff',
                      borderRadius: '0.5rem',
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.65rem'
                    }}>
                      <input
                        type="checkbox"
                        value="Sentinel-2"
                        checked={selectedSatellites.includes('Sentinel-2')}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSatellites([...selectedSatellites, 'Sentinel-2']);
                            const s2Defaults = ['NDVI', 'LSWI'];
                            setSelectedIndices(Array.from(new Set([...selectedIndices, ...s2Defaults])));
                          } else {
                            if (selectedSatellites.length > 1) {
                              setSelectedSatellites(selectedSatellites.filter(s => s !== 'Sentinel-2'));
                              setSelectedIndices(selectedIndices.filter(i => i === 'VV/VH'));
                            }
                          }
                        }}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#0f172a' }}>Sentinel-2 (MSI Optical)</div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>Multi-Spectral · ~0.270 GB/scene · GeoTIFF COGs (NDVI, LSWI)</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Spectral & SAR Indices */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>
                    Target Spectral & SAR Indices <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                    {(() => {
                      let available = [];
                      if (selectedSatellites.includes('Sentinel-2')) {
                        available.push('NDVI', 'LSWI', 'EVI', 'NDWI');
                      }
                      if (selectedSatellites.includes('Sentinel-1')) {
                        available.push('VV/VH');
                      }
                      return available.map((idx) => {
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
                      });
                    })()}
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

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Max Cloud Cover (%)</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={maxCloudCover}
                      onChange={(e) => setMaxCloudCover(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}
                    />
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Skip Sentinel-2 scenes above threshold (0-100%)</span>
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

            {/* User Management & Per-User Requests/Logs Section */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Users size={18} color="#2563eb" /> System User Directory & Access Controls
                </h3>
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                  Select any user below to view their individual requests and pipeline execution logs.
                </span>
              </div>

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
                    cursor: 'pointer',
                    padding: '0.45rem 0.75rem'
                  }}
                >
                  + Add User
                </button>
              </form>

              {/* Users Directory Table */}
              <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '0.5rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                      <th style={{ padding: '0.75rem 0.85rem' }}>ID</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Full Name</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Email</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Role</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Total Requests</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Account Status</th>
                      <th style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>User Work & Logs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>No users found in directory.</td>
                      </tr>
                    ) : (
                      adminUsers.map((u) => {
                        const isExpanded = expandedUserId === u.id;
                        const userReqs = userRequestsMap[u.id] || [];
                        const isLoadingReqs = loadingUserRequests[u.id];

                        return (
                          <React.Fragment key={u.id}>
                            <tr
                              style={{
                                borderBottom: isExpanded ? 'none' : '1px solid #f1f5f9',
                                backgroundColor: isExpanded ? '#eff6ff' : '#ffffff',
                                transition: 'background-color 0.15s'
                              }}
                            >
                              <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600 }}>#{u.id}</td>
                              <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600, color: '#0f172a' }}>{u.full_name || '—'}</td>
                              <td style={{ padding: '0.75rem 0.85rem', color: '#334155' }}>{u.email}</td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                <span style={{
                                  padding: '0.2rem 0.5rem',
                                  borderRadius: '0.25rem',
                                  fontSize: '0.72rem',
                                  fontWeight: 700,
                                  backgroundColor: u.role === 'ADMIN' ? '#dbeafe' : '#f1f5f9',
                                  color: u.role === 'ADMIN' ? '#1d4ed8' : '#475569'
                                }}>
                                  {u.role}
                                </span>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                <span style={{
                                  padding: '0.2rem 0.5rem',
                                  borderRadius: '0.25rem',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  backgroundColor: (u.request_count > 0 || userReqs.length > 0) ? '#dcfce7' : '#f8fafc',
                                  color: (u.request_count > 0 || userReqs.length > 0) ? '#166534' : '#94a3b8'
                                }}>
                                  {u.request_count ?? userReqs.length} Requests
                                </span>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                <span style={{ color: '#166534', fontWeight: 600, fontSize: '0.75rem' }}>● ACTIVE</span>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>
                                <button
                                  onClick={() => toggleExpandUser(u.id)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    padding: '0.35rem 0.7rem',
                                    backgroundColor: isExpanded ? '#2563eb' : '#ffffff',
                                    color: isExpanded ? '#ffffff' : '#2563eb',
                                    border: '1px solid #2563eb',
                                    borderRadius: '0.375rem',
                                    fontSize: '0.78rem',
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  {isExpanded ? 'Hide Requests' : 'View Requests & Logs'}
                                </button>
                              </td>
                            </tr>

                            {/* Accordion: User Requests & Execution Logs Sub-Panel */}
                            {isExpanded && (
                              <tr style={{ borderBottom: '2px solid #cbd5e1' }}>
                                <td colSpan={7} style={{ padding: '1rem 1.25rem', backgroundColor: '#f8fafc' }}>
                                  <div style={{
                                    backgroundColor: '#ffffff',
                                    border: '1px solid #e2e8f0',
                                    borderRadius: '0.5rem',
                                    padding: '1rem',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                                      <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <FileText size={15} color="#2563eb" /> Requests & Pipeline Logs for {u.full_name} ({u.email})
                                      </h4>
                                      <button
                                        onClick={() => fetchUserRequests(u.id)}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '0.25rem',
                                          padding: '0.25rem 0.5rem',
                                          border: '1px solid #cbd5e1',
                                          borderRadius: '0.25rem',
                                          backgroundColor: '#ffffff',
                                          fontSize: '0.75rem',
                                          color: '#475569',
                                          cursor: 'pointer'
                                        }}
                                      >
                                        <RefreshCw size={11} className={isLoadingReqs ? 'animate-spin' : ''} /> Refresh
                                      </button>
                                    </div>

                                    {isLoadingReqs ? (
                                      <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                                        <RefreshCw size={18} className="animate-spin" style={{ display: 'inline', marginRight: '0.5rem' }} />
                                        Loading user requests...
                                      </div>
                                    ) : userReqs.length === 0 ? (
                                      <div style={{ padding: '1.5rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.82rem' }}>
                                        No satellite requests have been submitted by this user yet.
                                      </div>
                                    ) : (
                                      <div style={{ overflowX: 'auto' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.82rem' }}>
                                          <thead>
                                            <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Req #</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Title</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Location</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Satellite</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Est. Storage</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Status</th>
                                              <th style={{ padding: '0.6rem 0.75rem' }}>Submitted At</th>
                                              <th style={{ padding: '0.6rem 0.75rem', textAlign: 'right' }}>Controls & Logs</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {userReqs.map((req) => (
                                              <tr key={req.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                                <td style={{ padding: '0.6rem 0.75rem', fontWeight: 700, color: '#2563eb' }}>#{req.id}</td>
                                                <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600, color: '#0f172a' }}>{req.request_title}</td>
                                                <td style={{ padding: '0.6rem 0.75rem', color: '#334155' }}>
                                                  {req.district ? `${req.district}, ${req.state}` : req.state || 'All India'}
                                                </td>
                                                <td style={{ padding: '0.6rem 0.75rem' }}>
                                                  <span style={{ fontWeight: 600 }}>{req.satellite}</span>
                                                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                                                    {Array.isArray(req.indices) ? req.indices.join(', ') : req.indices}
                                                  </div>
                                                </td>
                                                <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>
                                                  {req.storage_estimated_gb ? `${req.storage_estimated_gb} GB` : '—'}
                                                </td>
                                                <td style={{ padding: '0.6rem 0.75rem' }}>
                                                  {renderStatusBadge(req.status)}
                                                </td>
                                                <td style={{ padding: '0.6rem 0.75rem', color: '#64748b', fontSize: '0.75rem' }}>
                                                  {new Date(req.created_at).toLocaleString()}
                                                </td>
                                                <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right' }}>
                                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem' }}>
                                                    {/* View Execution Logs */}
                                                    <button
                                                      onClick={() => openLogsModal(req)}
                                                      title="View Pipeline Execution Logs"
                                                      style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.25rem',
                                                        padding: '0.3rem 0.55rem',
                                                        borderRadius: '0.375rem',
                                                        border: '1px solid #cbd5e1',
                                                        backgroundColor: '#ffffff',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 600,
                                                        color: '#334155',
                                                        cursor: 'pointer'
                                                      }}
                                                    >
                                                      <Terminal size={12} color="#2563eb" /> Logs
                                                    </button>

                                                    {/* Approve if Hold for Approval */}
                                                    {req.status === 'HOLD_FOR_APPROVAL' && (
                                                      <button
                                                        onClick={async () => {
                                                          await handleApproveStatus(req.id, 'ACCEPTED');
                                                          fetchUserRequests(u.id);
                                                        }}
                                                        style={{
                                                          padding: '0.3rem 0.55rem',
                                                          backgroundColor: '#166534',
                                                          color: '#ffffff',
                                                          border: 'none',
                                                          borderRadius: '0.375rem',
                                                          fontSize: '0.75rem',
                                                          fontWeight: 600,
                                                          cursor: 'pointer'
                                                        }}
                                                      >
                                                        Approve
                                                      </button>
                                                    )}

                                                    {/* Stop if Processing */}
                                                    {req.status === 'PROCESSING' && (
                                                      <button
                                                        onClick={async () => {
                                                          await handleStop(req.id);
                                                          fetchUserRequests(u.id);
                                                        }}
                                                        disabled={stoppingId === req.id}
                                                        style={{
                                                          padding: '0.3rem 0.55rem',
                                                          backgroundColor: '#dc2626',
                                                          color: '#ffffff',
                                                          border: 'none',
                                                          borderRadius: '0.375rem',
                                                          fontSize: '0.75rem',
                                                          fontWeight: 600,
                                                          cursor: 'pointer'
                                                        }}
                                                      >
                                                        {stoppingId === req.id ? '...' : 'Stop'}
                                                      </button>
                                                    )}

                                                    {/* Rerun if not currently running */}
                                                    {req.status !== 'PROCESSING' && (
                                                      <button
                                                        onClick={async () => {
                                                          await handleRerun(req.id);
                                                          fetchUserRequests(u.id);
                                                        }}
                                                        disabled={rerunningId === req.id}
                                                        style={{
                                                          padding: '0.3rem 0.55rem',
                                                          backgroundColor: '#2563eb',
                                                          color: '#ffffff',
                                                          border: 'none',
                                                          borderRadius: '0.375rem',
                                                          fontSize: '0.75rem',
                                                          fontWeight: 600,
                                                          cursor: 'pointer'
                                                        }}
                                                      >
                                                        {rerunningId === req.id ? '...' : 'Rerun'}
                                                      </button>
                                                    )}
                                                  </div>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 4: Downloaded Data Retrieval Form & GeoTIFF Raster Inspector */}
        {/* ========================================================================= */}
        {activeTab === 'retrieve_data' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Form Card */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <div style={{ marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.35rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HardDrive size={22} color="#2563eb" /> GeoTIFF Raster Retrieval & Export Form
                </h2>
                <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>
                  Select State & District to match spatial tile boundaries in PostgreSQL, resolve held scenes, and retrieve verified .tif file paths for downstream spatial analysis.
                </p>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
                backgroundColor: '#f8fafc',
                padding: '1.25rem',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
                marginBottom: '1.25rem'
              }}>
                {/* State Select (Downloaded States Only) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    State Name (Downloaded)
                  </label>
                  <select
                    value={retState}
                    onChange={(e) => {
                      setRetState(e.target.value);
                      setRetDistrict('');
                    }}
                    disabled={loadingRetRegions}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="">
                      {loadingRetRegions ? 'Loading Downloaded States...' : '-- All Downloaded States --'}
                    </option>
                    {(retDownloadedStates.length > 0 ? retDownloadedStates : statesList).map((s, i) => {
                      const stName = typeof s === 'string' ? s : (s.state_name || '');
                      return <option key={i} value={stName}>{stName}</option>;
                    })}
                  </select>
                </div>

                {/* District Select (Downloaded Districts Only) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    District Name (Downloaded)
                  </label>
                  <select
                    value={retDistrict}
                    onChange={(e) => setRetDistrict(e.target.value)}
                    disabled={loadingRetRegions}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="">
                      {loadingRetRegions ? 'Loading Downloaded Districts...' : (retState ? `-- All Downloaded Districts in ${retState} --` : '-- All Downloaded Districts --')}
                    </option>
                    {(retDownloadedDistricts.length > 0 ? retDownloadedDistricts : districtsList)
                      .filter(d => {
                        const dState = typeof d === 'string' ? '' : (d.state_name || '');
                        return !retState || (dState && dState.toLowerCase() === retState.toLowerCase());
                      })
                      .map((d, i) => {
                        const dName = typeof d === 'string' ? d : (d.district_name || '');
                        return <option key={i} value={dName}>{dName}</option>;
                      })}
                  </select>
                </div>

                {/* Satellite Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Satellite Sensor
                  </label>
                  <select
                    value={retSatellite}
                    onChange={(e) => setRetSatellite(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="ALL">All Sensors (Sentinel-1 & Sentinel-2)</option>
                    <option value="Sentinel-1">Sentinel-1 (SAR Radar)</option>
                    <option value="Sentinel-2">Sentinel-2 (MSI Optical)</option>
                  </select>
                </div>

                {/* Band Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Spectral / SAR Band
                  </label>
                  <select
                    value={retBand}
                    onChange={(e) => setRetBand(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="ALL">All Available Bands (.tif)</option>
                    <option value="B02">B02 (Blue 10m)</option>
                    <option value="B03">B03 (Green 10m)</option>
                    <option value="B04">B04 (Red 10m)</option>
                    <option value="B08">B08 (NIR 10m)</option>
                    <option value="B8A">B8A (Red Edge 20m)</option>
                    <option value="B11">B11 (SWIR 20m)</option>
                    <option value="SCL">SCL (Scene Classification Layer)</option>
                    <option value="TCI">TCI (True Color RGB Image)</option>
                    <option value="VV">VV (Sentinel-1 C-band Co-pol)</option>
                    <option value="VH">VH (Sentinel-1 C-band Cross-pol)</option>
                    <option value="VV_VH">VV_VH (Sentinel-1 SAR Ratio 10m)</option>
                    <option value="NDVI">NDVI (Normalized Difference Veg Index)</option>
                    <option value="LSWI">LSWI (Land Surface Water Index)</option>
                    <option value="Composite">Composite / Clipped Rasters (.tif)</option>
                  </select>
                </div>

                {/* Start Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Start Date Bounds
                  </label>
                  <input
                    type="date"
                    value={retStartDate}
                    onChange={(e) => setRetStartDate(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                {/* End Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    End Date Bounds
                  </label>
                  <input
                    type="date"
                    value={retEndDate}
                    onChange={(e) => setRetEndDate(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleDownloadZip}
                  disabled={downloadingZip}
                  style={{
                    backgroundColor: downloadingZip ? '#15803d' : '#166534',
                    color: '#ffffff',
                    padding: '0.65rem 1.25rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    cursor: downloadingZip ? 'wait' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 1px 2px rgba(22, 101, 52, 0.2)'
                  }}
                >
                  {downloadingZip ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                  {downloadingZip ? 'Preparing ZIP Archive...' : 'Download GeoTIFF Data (.zip)'}
                </button>

                {(retState || retDistrict || retBand !== 'ALL' || retSatellite !== 'ALL' || retStartDate || retEndDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRetState('');
                      setRetDistrict('');
                      setRetSatellite('ALL');
                      setRetBand('ALL');
                      setRetStartDate('');
                      setRetEndDate('');
                      setRetResults(null);
                      setRetCopyNotice(null);
                      setRetNotice(null);
                    }}
                    style={{
                      backgroundColor: '#f1f5f9',
                      color: '#475569',
                      padding: '0.65rem 1rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      cursor: 'pointer'
                    }}
                  >
                    Reset Filters
                  </button>
                )}
              </div>

              {retNotice && (
                <div style={{
                  marginTop: '1rem',
                  padding: '0.85rem 1rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  backgroundColor: retNotice.type === 'success' ? '#dcfce7' : (retNotice.type === 'warning' ? '#fef3c7' : '#fee2e2'),
                  color: retNotice.type === 'success' ? '#15803d' : (retNotice.type === 'warning' ? '#92400e' : '#991b1b'),
                  border: `1px solid ${retNotice.type === 'success' ? '#bbf7d0' : (retNotice.type === 'warning' ? '#fde68a' : '#fca5a5')}`
                }}>
                  {retNotice.text}
                </div>
              )}
            </div>

            {/* Retrieval Results Display Card */}
            {retResults && (
              <div style={{
                backgroundColor: '#ffffff',
                borderRadius: '0.75rem',
                border: '1px solid #e2e8f0',
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.25rem'
              }}>
                {/* Summary Stats Header */}
                <div style={{
                  backgroundColor: '#eff6ff',
                  borderRadius: '0.5rem',
                  border: '1px solid #dbeafe',
                  padding: '1rem 1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '1rem'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#1d4ed8', fontWeight: 700 }}>
                      Retrieval Results Summary
                    </div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginTop: '0.25rem' }}>
                      {retResults.query_district || retResults.district || 'Region'}{' '}
                      <span style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 500 }}>
                        ({retResults.query_state || retResults.state || 'All States'})
                      </span>
                    </div>
                    {retResults.matched_tiles && retResults.matched_tiles.length > 0 && (
                      <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: '0.35rem' }}>
                        <span style={{ fontWeight: 600 }}>Matched Tiles:</span> {retResults.matched_tiles.join(', ')}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#1e293b' }}>{retResults.total_scenes}</div>
                      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>Scenes</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#2563eb' }}>{retResults.total_tifs}</div>
                      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>GeoTIFF Files</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#166534' }}>{retResults.total_size_mb} MB</div>
                      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>Total Volume</div>
                    </div>
                  </div>
                </div>

                {/* Action Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button
                      onClick={handleDownloadZip}
                      disabled={!retResults.tifs || retResults.tifs.length === 0}
                      style={{
                        backgroundColor: '#166534',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '0.375rem',
                        padding: '0.5rem 0.85rem',
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem'
                      }}
                    >
                      <Download size={14} /> Download All (.zip)
                    </button>

                    <button
                      onClick={handleCopyPaths}
                      disabled={!retResults.tif_paths || retResults.tif_paths.length === 0}
                      style={{
                        backgroundColor: '#0f172a',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '0.375rem',
                        padding: '0.5rem 0.85rem',
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem'
                      }}
                    >
                      <FileText size={14} /> Copy All File Paths
                    </button>

                    <button
                      onClick={handleExportCsv}
                      disabled={!retResults.tifs || retResults.tifs.length === 0}
                      style={{
                        backgroundColor: '#ffffff',
                        color: '#334155',
                        border: '1px solid #cbd5e1',
                        borderRadius: '0.375rem',
                        padding: '0.5rem 0.85rem',
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem'
                      }}
                    >
                      <Download size={14} /> Export CSV Manifest
                    </button>
                  </div>

                  {retCopyNotice && (
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#166534', backgroundColor: '#dcfce7', padding: '0.35rem 0.75rem', borderRadius: '0.375rem' }}>
                      {retCopyNotice}
                    </span>
                  )}
                </div>

                {/* GeoTIFF Table */}
                <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '0.5rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                        <th style={{ padding: '0.65rem 0.85rem' }}>#</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Band</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Satellite</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Tile</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Sensing Date</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Size</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Status</th>
                        <th style={{ padding: '0.65rem 0.85rem' }}>Filesystem Path (DB)</th>
                        <th style={{ padding: '0.65rem 0.85rem', textAlign: 'center' }}>Download Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {retResults.tifs && retResults.tifs.length > 0 ? (
                        retResults.tifs.map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '0.65rem 0.85rem', color: '#94a3b8', fontSize: '0.78rem' }}>{idx + 1}</td>
                            <td style={{ padding: '0.65rem 0.85rem' }}>
                              <span style={{ fontWeight: 700, color: '#2563eb', backgroundColor: '#eff6ff', padding: '0.15rem 0.45rem', borderRadius: '0.25rem', fontSize: '0.78rem' }}>
                                {item.band}
                              </span>
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem', color: '#334155' }}>{item.satellite}</td>
                            <td style={{ padding: '0.65rem 0.85rem', fontWeight: 600, color: '#0f172a' }}>{item.tile}</td>
                            <td style={{ padding: '0.65rem 0.85rem', color: '#475569' }}>{item.sensing_date}</td>
                            <td style={{ padding: '0.65rem 0.85rem', color: '#334155' }}>{(item.size_bytes / (1024 * 1024)).toFixed(1)} MB</td>
                            <td style={{ padding: '0.65rem 0.85rem' }}>
                              <span style={{
                                fontSize: '0.72rem',
                                fontWeight: 700,
                                backgroundColor: item.exists_on_disk ? '#dcfce7' : '#fef2f2',
                                color: item.exists_on_disk ? '#166534' : '#991b1b',
                                padding: '0.15rem 0.45rem',
                                borderRadius: '0.25rem'
                              }}>
                                {item.exists_on_disk ? 'VERIFIED' : 'MISSING'}
                              </span>
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#334155', wordBreak: 'break-all' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span>{item.path}</span>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(item.path);
                                    setRetCopyNotice(`✓ Copied: ${item.band}`);
                                    setTimeout(() => setRetCopyNotice(null), 2000);
                                  }}
                                  title="Copy Path"
                                  style={{ border: 'none', backgroundColor: '#f1f5f9', padding: '0.2rem 0.4rem', borderRadius: '0.25rem', cursor: 'pointer', color: '#475569' }}
                                >
                                  Copy
                                </button>
                              </div>
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem', textAlign: 'center' }}>
                              <button
                                onClick={() => handleDownloadFile(item.path)}
                                disabled={!item.exists_on_disk}
                                title={item.exists_on_disk ? `Download ${item.band}.tif` : "File Missing on Disk"}
                                style={{
                                  backgroundColor: item.exists_on_disk ? '#2563eb' : '#94a3b8',
                                  color: '#ffffff',
                                  border: 'none',
                                  borderRadius: '0.375rem',
                                  padding: '0.35rem 0.75rem',
                                  fontSize: '0.8rem',
                                  fontWeight: 600,
                                  cursor: item.exists_on_disk ? 'pointer' : 'not-allowed',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem'
                                }}
                              >
                                <Download size={14} /> Download .tif
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                            No verified GeoTIFF raster paths matched the selected State/District and filter criteria.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
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
                onClick={closeLogsModal}
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

            {/* View Toolbar: Mode Switcher, Filters & Search */}
            <div style={{
              padding: '0.65rem 1.25rem',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              {/* Left: View Mode Toggle & Filter Pills */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', backgroundColor: '#e2e8f0', borderRadius: '0.375rem', padding: '2px' }}>
                  <button
                    onClick={() => setLogViewMode('table')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: 'none',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: logViewMode === 'table' ? '#ffffff' : 'transparent',
                      color: logViewMode === 'table' ? '#1d4ed8' : '#64748b',
                      boxShadow: logViewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                    }}
                  >
                    <Table size={14} /> Structured Table
                  </button>
                  <button
                    onClick={() => setLogViewMode('raw')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: 'none',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: logViewMode === 'raw' ? '#ffffff' : 'transparent',
                      color: logViewMode === 'raw' ? '#1d4ed8' : '#64748b',
                      boxShadow: logViewMode === 'raw' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                    }}
                  >
                    <Terminal size={14} /> Raw Terminal
                  </button>
                </div>

                {logViewMode === 'table' && (
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {[
                      { id: 'all', label: 'All Records' },
                      { id: 'downloads', label: 'Downloads & Cache' },
                      { id: 'errors', label: 'Warnings & Errors' }
                    ].map(f => (
                      <button
                        key={f.id}
                        onClick={() => setLogFilter(f.id)}
                        style={{
                          padding: '0.3rem 0.6rem',
                          borderRadius: '0.25rem',
                          border: logFilter === f.id ? '1px solid #2563eb' : '1px solid #cbd5e1',
                          backgroundColor: logFilter === f.id ? '#eff6ff' : '#ffffff',
                          color: logFilter === f.id ? '#1d4ed8' : '#475569',
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: Search Filter Input */}
              {logViewMode === 'table' && (
                <div style={{ position: 'relative', width: '230px' }}>
                  <Search size={14} style={{ position: 'absolute', left: '0.55rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                  <input
                    type="text"
                    placeholder="Search logs / tiles / scenes..."
                    value={logSearchQuery}
                    onChange={(e) => setLogSearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.35rem 0.5rem 0.35rem 1.85rem',
                      fontSize: '0.78rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      outline: 'none'
                    }}
                  />
                  {logSearchQuery && (
                    <button
                      onClick={() => setLogSearchQuery('')}
                      style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0 }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Modal Body: Switch between Table View and Raw Terminal View */}
            <div style={{
              padding: '1.25rem',
              backgroundColor: '#ffffff',
              flex: 1,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}>
              {logViewMode === 'table' ? (
                renderLogTableView(selectedReqForLogs.execution_logs, selectedReqForLogs)
              ) : (
                <div className="log-terminal">
                  {renderLogContent(selectedReqForLogs.execution_logs)}
                  <div ref={logsEndRef} />
                </div>
              )}
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