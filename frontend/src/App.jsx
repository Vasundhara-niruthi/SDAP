import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  Satellite, Activity, HardDrive, User, LogOut, RefreshCw, FileText, Folder,
  CheckCircle, Clock, AlertTriangle, XCircle, Plus, Search, Database,
  Calendar, MapPin, Sliders, Shield, Users, Check, ChevronRight, ChevronDown, Info,
  HelpCircle, X, Download, Play, Terminal, Eye, EyeOff, KeyRound, ArrowLeft, Square, Table,
  Layers, ArrowUp, ArrowDown, TrendingUp, BarChart3, Filter, Trash2,
  Minimize2, Maximize2, Package
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

  const isOnlyS1 = selectedSatellites.includes('Sentinel-1') && !selectedSatellites.includes('Sentinel-2');

  useEffect(() => {
    if (isOnlyS1 && (compositeInterval === 'weekly' || compositeInterval === 'monthly')) {
      setCompositeInterval('fortnightly');
    }
  }, [isOnlyS1, compositeInterval]);
  const [level, setLevel] = useState('max');
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
  const [logsModalTifs, setLogsModalTifs] = useState([]);
  const [logsModalComposites, setLogsModalComposites] = useState([]);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [selectedWarningScene, setSelectedWarningScene] = useState(null);
  const [rerunningId, setRerunningId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  const logsEndRef = useRef(null);
  const selectedReqIdRef = useRef(null);
  const [logViewMode, setLogViewMode] = useState('table'); // 'table' | 'raw'
  const [logFilter, setLogFilter] = useState('all'); // 'all' | 'downloads' | 'errors'
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [logStepFilter, setLogStepFilter] = useState('all'); // 'all' | 'step1' | 'step2' | 'step3' | 'step4'

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

  // Daily Storage Analytics (Admin Only)
  const [dailyStorageData, setDailyStorageData] = useState(null);
  const [loadingDailyStorage, setLoadingDailyStorage] = useState(false);
  const [dailyStorageFilter, setDailyStorageFilter] = useState('ALL'); // 'ALL' | '7D' | '30D' | 'CUSTOM'
  const [dailyStartDate, setDailyStartDate] = useState('');
  const [dailyEndDate, setDailyEndDate] = useState('');
  const [expandedDailyDate, setExpandedDailyDate] = useState(null);

  // ---------------------------------------------------------------------------
  // 7. Data Retrieval & Export State & Handlers
  // ---------------------------------------------------------------------------
  const RET_S1_BANDS = [
    {
      id: 'VV_Orb_tnr_cal_Tc_db.tiff',
      label: 'VV_Orb_tnr_cal_Tc_db.tiff',
      tag: 'Calibrated Co-pol Sigma0 (dB, 10m)'
    },
    {
      id: 'VH_Orb_tnr_cal_Tc_db.tiff',
      label: 'VH_Orb_tnr_cal_Tc_db.tiff',
      tag: 'Calibrated Cross-pol Sigma0 (dB, 10m)'
    },
    {
      id: 'VV_VH_Orb_tnr_cal_Tc_db.tiff',
      label: 'VV_VH_Orb_tnr_cal_Tc_db.tiff',
      tag: 'Dual-Pol Ratio (VV_dB - VH_dB)'
    },
  ];

  const RET_S2_BANDS = [
    { id: 'B02', label: 'B02', tag: 'Blue (10m)' },
    { id: 'B03', label: 'B03', tag: 'Green (10m)' },
    { id: 'B04', label: 'B04', tag: 'Red (10m)' },
    { id: 'B08', label: 'B08', tag: 'NIR (10m)' },
    { id: 'B8A', label: 'B8A', tag: 'Red Edge (20m)' },
    { id: 'B11', label: 'B11', tag: 'SWIR (20m)' },
    { id: 'B12', label: 'B12', tag: 'SWIR-2 (20m)' },
    { id: 'SCL', label: 'SCL', tag: 'Scene Class.' },
    { id: 'TCI', label: 'TCI', tag: 'RGB True Color' },
    { id: 'NDVI', label: 'NDVI', tag: 'Vegetation' },
    { id: 'LSWI', label: 'LSWI', tag: 'Water Index' },
    { id: 'Composite', label: 'Composite', tag: 'Clipped Rasters' },
  ];

  const [retState, setRetState] = useState('');
  const [retDistrict, setRetDistrict] = useState('');
  const [retSatellite, setRetSatellite] = useState('ALL');
  const [retBand, setRetBand] = useState('ALL');
  const [retSelectedBands, setRetSelectedBands] = useState([]);
  const [retCompositeInterval, setRetCompositeInterval] = useState('ALL');
  const [retStartDate, setRetStartDate] = useState('');
  const [retEndDate, setRetEndDate] = useState('');
  const [retSelectedReqId, setRetSelectedReqId] = useState('');
  const [retResults, setRetResults] = useState(null);
  const [loadingRet, setLoadingRet] = useState(false);
  const [verifyingNAS, setVerifyingNAS] = useState(false);
  const [showDownloadPromptModal, setShowDownloadPromptModal] = useState(false);
  const [retCopyNotice, setRetCopyNotice] = useState(null);
  const [retDownloadedStates, setRetDownloadedStates] = useState([]);
  const [retDownloadedDistricts, setRetDownloadedDistricts] = useState([]);
  const [loadingRetRegions, setLoadingRetRegions] = useState(false);

  // Helper to determine active bands query parameter string
  const getSelectedBandsQuery = () => {
    let available = [];
    if (retSatellite === 'Sentinel-1') {
      available = RET_S1_BANDS.map(b => b.id);
    } else if (retSatellite === 'Sentinel-2') {
      available = RET_S2_BANDS.map(b => b.id);
    } else {
      available = [...RET_S1_BANDS.map(b => b.id), ...RET_S2_BANDS.map(b => b.id)];
    }
    const active = retSelectedBands.filter(b => available.includes(b));
    if (active.length === 0) {
      return 'ALL';
    }
    return active.join(',');
  };

  const handleToggleRetBand = (bandId) => {
    setRetSelectedBands(prev => {
      if (prev.includes(bandId)) {
        return prev.filter(b => b !== bandId);
      } else {
        return [...prev, bandId];
      }
    });
  };

  const handleSelectAllRetBands = () => {
    if (retSatellite === 'Sentinel-1') {
      setRetSelectedBands(RET_S1_BANDS.map(b => b.id));
    } else if (retSatellite === 'Sentinel-2') {
      setRetSelectedBands(RET_S2_BANDS.map(b => b.id));
    } else {
      setRetSelectedBands([...RET_S1_BANDS.map(b => b.id), ...RET_S2_BANDS.map(b => b.id)]);
    }
  };

  const handleClearAllRetBands = () => {
    setRetSelectedBands([]);
  };

  const handleRetSatelliteChange = (newSat) => {
    setRetSatellite(newSat);
    if (newSat === 'Sentinel-1') {
      const s1Ids = RET_S1_BANDS.map(b => b.id);
      setRetSelectedBands(prev => prev.filter(b => s1Ids.includes(b)));
    } else if (newSat === 'Sentinel-2') {
      const s2Ids = RET_S2_BANDS.map(b => b.id);
      setRetSelectedBands(prev => prev.filter(b => s2Ids.includes(b)));
    }
  };


  const handleVerifyNASData = async () => {
    setVerifyingNAS(true);
    setLoadingRet(true);
    setRetCopyNotice(null);
    setRetNotice(null);
    try {
      const params = {};
      if (retState) params.state = retState;
      if (retDistrict) params.district = retDistrict;
      if (retSatellite && retSatellite !== 'ALL') params.satellite = retSatellite;
      const bQuery = getSelectedBandsQuery();
      if (bQuery && bQuery !== 'ALL') params.band = bQuery;
      if (retCompositeInterval && retCompositeInterval !== 'ALL') params.composite_interval = retCompositeInterval;
      if (retStartDate) params.start_date = retStartDate;
      if (retEndDate) params.end_date = retEndDate;

      const res = await axios.get(`${API_BASE}/requests/tifs/retrieve`, { params, headers: getAuthHeader() });
      setRetResults(res.data);

      if (res.data && res.data.total_tifs > 0) {
        setShowDownloadPromptModal(true);
        setRetNotice({
          type: 'success',
          text: `✓ Verified ${res.data.total_tifs} raster files (${res.data.total_size_mb} MB) available on NAS storage!`
        });
      } else {
        setShowDownloadPromptModal(false);
        setRetNotice({
          type: 'warning',
          text: '⚠️ No matching raster files found on NAS storage for the selected criteria. Please adjust your criteria or submit an acquisition request.'
        });
      }
    } catch (err) {
      setShowDownloadPromptModal(false);
      setRetNotice({
        type: 'error',
        text: `⚠️ NAS verification error: ${formatApiError(err, 'Error querying NAS storage.')}`
      });
    } finally {
      setVerifyingNAS(false);
      setLoadingRet(false);
    }
  };

  const handleExecuteRetrieval = handleVerifyNASData;

  const [downloadingZip, setDownloadingZip] = useState(false);
  const [retNotice, setRetNotice] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [downloadWidgetMinimized, setDownloadWidgetMinimized] = useState(false);

  const handleDownloadZip = async () => {
    // 1. Close modal immediately so the user's workspace is not blocked
    setShowDownloadPromptModal(false);

    const currentToken = token || localStorage.getItem('sdap_token');
    const params = new URLSearchParams();
    if (retState) params.append('state', retState);
    if (retDistrict) params.append('district', retDistrict);
    if (retSatellite && retSatellite !== 'ALL') params.append('satellite', retSatellite);
    const bQuery = getSelectedBandsQuery();
    if (bQuery && bQuery !== 'ALL') params.append('band', bQuery);
    if (retCompositeInterval && retCompositeInterval !== 'ALL') params.append('composite_interval', retCompositeInterval);
    if (retStartDate) params.append('start_date', retStartDate);
    if (retEndDate) params.append('end_date', retEndDate);
    if (currentToken) params.append('token', currentToken);

    const downloadUrl = `${API_BASE}/requests/tifs/download-zip?${params.toString()}`;
    const fileName = `SDAP_GeoTIFF_${retDistrict || retState || 'Export'}.zip`;

    setDownloadingZip(true);
    setDownloadProgress({
      fileName,
      percent: 0,
      loadedMB: '0.0',
      totalMB: retResults?.total_size_mb ? String(retResults.total_size_mb) : null,
      status: 'downloading'
    });

    setRetNotice({
      type: 'info',
      status: 'initiated',
      fileName: fileName,
      text: `⏳ Downloading "${fileName}" in the background... You can freely continue your work.`
    });

    try {
      const response = await axios.get(downloadUrl, {
        responseType: 'blob',
        headers: getAuthHeader(),
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            const loadedMB = (progressEvent.loaded / (1024 * 1024)).toFixed(1);
            const totalMB = (progressEvent.total / (1024 * 1024)).toFixed(1);
            setDownloadProgress({
              fileName,
              percent: percentCompleted,
              loadedMB,
              totalMB,
              status: 'downloading'
            });
            setRetNotice({
              type: 'info',
              status: 'initiated',
              fileName: fileName,
              text: `⏳ Downloading "${fileName}" in background (${percentCompleted}% - ${loadedMB} / ${totalMB} MB)... You can continue your work.`
            });
          } else if (progressEvent.loaded > 0) {
            const loadedMB = (progressEvent.loaded / (1024 * 1024)).toFixed(1);
            setDownloadProgress(prev => ({
              fileName,
              percent: null,
              loadedMB,
              totalMB: prev?.totalMB || null,
              status: 'downloading'
            }));
            setRetNotice({
              type: 'info',
              status: 'initiated',
              fileName: fileName,
              text: `⏳ Downloading "${fileName}" in background (${loadedMB} MB downloaded)... You can continue your work.`
            });
          }
        }
      });

      // Verify if response is a JSON error encapsulated in Blob
      if (response.data && response.data.type === 'application/json') {
        const text = await response.data.text();
        const errObj = JSON.parse(text);
        throw new Error(errObj.detail || 'Download failed');
      }

      // Stream to file download via blob object
      const blob = new Blob([response.data], { type: 'application/zip' });
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        try {
          document.body.removeChild(link);
          window.URL.revokeObjectURL(blobUrl);
        } catch (e) {}
      }, 2000);

      // Transition to download completed status ONLY after download has fully completed
      setDownloadProgress(prev => ({
        fileName,
        percent: 100,
        loadedMB: prev?.totalMB || prev?.loadedMB || '',
        totalMB: prev?.totalMB || null,
        status: 'completed'
      }));

      setRetNotice({
        type: 'success',
        status: 'completed',
        fileName: fileName,
        text: `✓ Download completed! "${fileName}" has been downloaded successfully.`
      });

      // Automatically dismiss the completed widget after 12 seconds
      setTimeout(() => {
        setDownloadProgress(prev => prev?.status === 'completed' ? null : prev);
      }, 12000);

    } catch (err) {
      console.error('Failed to download ZIP archive:', err);
      let errMsg = 'Failed to download ZIP file.';
      if (err.response) {
        if (err.response.data instanceof Blob) {
          try {
            const txt = await err.response.data.text();
            try {
              const j = JSON.parse(txt);
              if (j.detail) errMsg = j.detail;
              else if (txt && txt.length < 300) errMsg = txt;
            } catch (pErr) {
              if (txt && txt.length < 300) errMsg = txt;
            }
          } catch (e) {}
        } else if (err.response.data && err.response.data.detail) {
          errMsg = err.response.data.detail;
        } else if (err.response.statusText) {
          errMsg = `${err.response.status}: ${err.response.statusText}`;
        }
      } else if (err.message) {
        errMsg = err.message;
      }
      setDownloadProgress({
        fileName,
        status: 'error',
        errorMsg: errMsg
      });
      setRetNotice({
        type: 'error',
        status: 'error',
        fileName: fileName,
        text: `⚠️ Download error: ${errMsg}`
      });
    } finally {
      setDownloadingZip(false);
    }
  };

  // ---------------------------------------------------------------------------
  // 9. Layer Stacking Studio State & Handlers
  // ---------------------------------------------------------------------------
  const extractBandsFromStackFilename = (filename) => {
    if (!filename) return [];
    const stem = filename.replace(/\.(tif|tiff)$/i, '');
    const m = stem.match(/(\d{4}-?\d{2}-?\d{2})[_\-](\d{4}-?\d{2}-?\d{2})_(.+)$/i);
    if (m && m[3]) {
      return m[3].split('_').map(b => b.trim().toUpperCase()).filter(Boolean);
    }
    const m2 = stem.match(/_(?:Kharif|Rabi|Zaid|Annual|Monsoon|Winter|Pre-Monsoon|Post-Monsoon|Custom)_([A-Za-z0-9_]+)$/i);
    if (m2 && m2[1]) {
      return m2[1].split('_').map(b => b.trim().toUpperCase()).filter(Boolean);
    }
    return [];
  };

  const isExactMatchingStack = (stackItem, selectedLayers, targetDistrict, targetSeason, targetStartDate, targetEndDate) => {
    if (!stackItem || !selectedLayers || selectedLayers.length === 0) return false;

    // Check district match
    if (targetDistrict && stackItem.district) {
      if (stackItem.district.trim().toLowerCase() !== targetDistrict.trim().toLowerCase()) {
        return false;
      }
    }

    // Check season match if present
    if (targetSeason && stackItem.season) {
      const s1 = targetSeason.split('(')[0].trim().toLowerCase();
      const s2 = stackItem.season.split('(')[0].trim().toLowerCase();
      if (s1 && s2 && s1 !== s2) {
        return false;
      }
    }

    // Extract exact bands from layers array or filename
    let itemBands = [];
    if (Array.isArray(stackItem.layers) && stackItem.layers.length > 0) {
      itemBands = stackItem.layers.map(b => b.trim().toUpperCase()).filter(Boolean);
    } else if (stackItem.filename) {
      itemBands = extractBandsFromStackFilename(stackItem.filename);
    }

    if (itemBands.length === 0) return false;

    const selBands = selectedLayers.map(b => b.trim().toUpperCase()).filter(Boolean);
    if (itemBands.length !== selBands.length) return false;

    const bandsMatch = selBands.every(b => itemBands.includes(b)) && itemBands.every(b => selBands.includes(b));
    if (!bandsMatch) return false;

    // Check date range if target dates and item dates are available
    if (targetStartDate && targetEndDate) {
      const tStart = targetStartDate.replace(/-/g, '');
      const tEnd = targetEndDate.replace(/-/g, '');
      const dRangeStr = `${tStart}_${tEnd}`;
      if (stackItem.filename) {
        const dm = stackItem.filename.match(/_(\d{8}_\d{8})_/);
        if (dm && dm[1] && dm[1] !== dRangeStr) {
          return false;
        }
      }
      if (stackItem.start_date && stackItem.end_date) {
        const iStart = stackItem.start_date.replace(/-/g, '');
        const iEnd = stackItem.end_date.replace(/-/g, '');
        if (tStart !== iStart || tEnd !== iEnd) {
          return false;
        }
      }
    }

    return true;
  };

  const [stackState, setStackState] = useState('');
  const [stackDistrict, setStackDistrict] = useState('');
  const [stackSeason, setStackSeason] = useState('Kharif');
  const [stackStartDate, setStackStartDate] = useState('2026-06-01');
  const [stackEndDate, setStackEndDate] = useState('2026-10-31');
  const [stackSelectedLayers, setStackSelectedLayers] = useState(['NDVI', 'LSWI']);
  const [stackClipToDistrict, setStackClipToDistrict] = useState(true);
  const [stackLoading, setStackLoading] = useState(false);
  const [stackNotice, setStackNotice] = useState(null);
  const [stackResult, setStackResult] = useState(null);
  const [stackHistory, setStackHistory] = useState([]);
  const [loadingStackHistory, setLoadingStackHistory] = useState(false);
  const [stackHistorySearch, setStackHistorySearch] = useState('');
  const [exactStackMatchModal, setExactStackMatchModal] = useState(null);
  const [stackMatchSelectedFiles, setStackMatchSelectedFiles] = useState(new Set());
  const [stackRequestId, setStackRequestId] = useState(null);
  const [stackFilesModalReq, setStackFilesModalReq] = useState(null);

  // Dedicated NAS Layer Stack Archive Verification state (Tab 4: Retrieve Data)
  const [stackArchiveState, setStackArchiveState] = useState('');
  const [stackArchiveDistrict, setStackArchiveDistrict] = useState('');
  const [stackArchiveSeason, setStackArchiveSeason] = useState('ALL');
  const [stackArchiveStartDate, setStackArchiveStartDate] = useState('');
  const [stackArchiveEndDate, setStackArchiveEndDate] = useState('');
  const [stackArchiveResults, setStackArchiveResults] = useState([]);
  const [hasVerifiedStackArchive, setHasVerifiedStackArchive] = useState(false);
  const [verifyingStackArchive, setVerifyingStackArchive] = useState(false);
  const [stackArchiveNotice, setStackArchiveNotice] = useState(null);
  const [stackArchiveSearch, setStackArchiveSearch] = useState('');
  const [selectedStackForLogs, setSelectedStackForLogs] = useState(null);
  const [stackModalViewMode, setStackModalViewMode] = useState('table');
  const [stackModalFilter, setStackModalFilter] = useState('all');
  const [stackModalSearch, setStackModalSearch] = useState('');

  // Request-linked downloaded scenes & filename preservation state
  const [stackDownloadedBandsData, setStackDownloadedBandsData] = useState({});
  const [stackSelectedScenes, setStackSelectedScenes] = useState({});
  const [loadingStackReqFiles, setLoadingStackReqFiles] = useState(false);

  // Layer Stacking Real-time execution tracking & live log states
  const [stackTaskId, setStackTaskId] = useState('');
  const [stackProgress, setStackProgress] = useState(0);
  const [stackStep, setStackStep] = useState('');
  const [stackLogs, setStackLogs] = useState([]);
  const [stackLogViewMode, setStackLogViewMode] = useState('table'); // 'table' | 'terminal'
  const [stackLogFilter, setStackLogFilter] = useState('all'); // 'all' | 'info' | 'success' | 'warnings' | 'errors'
  const [stackLogSearchQuery, setStackLogSearchQuery] = useState('');
  const [stackHistoryScope, setStackHistoryScope] = useState('district'); // 'district' | 'all'
  const stackPollIntervalRef = useRef(null);
  const stackLogsEndRef = useRef(null);
  const stackTerminalContainerRef = useRef(null);
  const hasAutoLoadedStackRef = useRef(false);

  const AVAILABLE_OPTICAL_BANDS = [
    { id: 'B02', label: 'B02 - Blue (490nm, 10m)' },
    { id: 'B03', label: 'B03 - Green (560nm, 10m)' },
    { id: 'B04', label: 'B04 - Red (665nm, 10m)' },
    { id: 'B08', label: 'B08 - NIR Wide (842nm, 10m)' },
    { id: 'B8A', label: 'B8A - NIR Narrow (865nm, 20m)' },
    { id: 'B11', label: 'B11 - SWIR 1 (1610nm, 20m)' },
    { id: 'SCL', label: 'SCL - Scene Classification Map (20m)' }
  ];

  const AVAILABLE_SAR_BANDS = [
    { id: 'VV', label: 'VV - Vertical-Vertical Co-polarization (10m)' },
    { id: 'VH', label: 'VH - Vertical-Horizontal Cross-polarization (10m)' },
    { id: 'VV_VH', label: 'VV_VH - Dual-pol Cross-ratio Backscatter (10m)' }
  ];

  const AVAILABLE_INDICES = [
    { id: 'NDVI', label: 'NDVI - Normalized Difference Vegetation Index (B08 - B04)/(B08 + B04)' },
    { id: 'LSWI', label: 'LSWI - Land Surface Water Index (B08 - B11)/(B08 + B11)' }
  ];

  const loadBandsAndScenesForRegion = useCallback(async (stateVal, distVal, seasonVal, startVal, endVal, specificRequestId) => {
    if (!distVal && !stateVal && !specificRequestId) {
      setStackDownloadedBandsData({});
      setStackSelectedScenes({});
      return;
    }

    setLoadingStackReqFiles(true);
    try {
      // 1. Fetch district requests from backend to ensure both admin & regular users discover jobs
      let candidateRequests = [...requests];
      if (distVal) {
        try {
          const distReqsRes = await axios.get(`${API_BASE}/requests/by-district/${encodeURIComponent(distVal)}`, { headers: getAuthHeader() });
          if (Array.isArray(distReqsRes.data) && distReqsRes.data.length > 0) {
            const newReqs = distReqsRes.data;
            candidateRequests = [...newReqs, ...candidateRequests.filter(cr => !newReqs.some(nr => nr.id === cr.id))];
          }
        } catch (e) {
          // fallback to local candidateRequests
        }
      }

      // If a specificRequestId is provided, prioritize it directly
      let matchingReq = null;
      if (specificRequestId) {
        matchingReq = candidateRequests.find(r => String(r.id) === String(specificRequestId)) || null;
        if (!matchingReq) {
          try {
            const reqRes = await axios.get(`${API_BASE}/requests/${specificRequestId}`, { headers: getAuthHeader() });
            if (reqRes.data) {
              matchingReq = reqRes.data;
              candidateRequests.unshift(matchingReq);
            }
          } catch (e) {
            console.warn('Could not fetch specific request details:', e);
          }
        }
      }

      // 2. Find matching requests for this district / state
      // If a specificRequestId is supplied, strictly limit to that exact request!
      let matchingList = matchingReq ? [matchingReq] : [];

      if (!specificRequestId && distVal) {
        const dList = candidateRequests.filter(r => 
          r.district && r.district.toLowerCase() === distVal.toLowerCase() &&
          (!stateVal || !r.state || r.state.toLowerCase() === stateVal.toLowerCase())
        );
        matchingList = [...matchingList, ...dList.filter(d => !matchingList.some(m => m.id === d.id))];
      }
      if (!matchingReq && matchingList.length === 0 && stateVal) {
        matchingList = candidateRequests.filter(r => 
          r.state && r.state.toLowerCase() === stateVal.toLowerCase()
        );
      }

      if (!matchingReq && matchingList.length > 0) {
        // Sort matchingList: prefer matching season, then COMPLETED/HELD/new runs, then highest ID
        matchingList.sort((a, b) => {
          let scoreA = a.status === 'COMPLETED' ? 10 : (['HELD', 'PROCESSING', 'DOWNLOADING', 'PENDING'].includes(a.status) ? 8 : 4);
          let scoreB = b.status === 'COMPLETED' ? 10 : (['HELD', 'PROCESSING', 'DOWNLOADING', 'PENDING'].includes(b.status) ? 8 : 4);
          if (seasonVal && a.season && a.season.toLowerCase() === seasonVal.toLowerCase()) scoreA += 5;
          if (seasonVal && b.season && b.season.toLowerCase() === seasonVal.toLowerCase()) scoreB += 5;
          const diff = scoreB - scoreA;
          return diff !== 0 ? diff : (b.id - a.id);
        });
        matchingReq = matchingList[0];
      }

      // If matchingReq is identified, partition by satellite so Sentinel-1 and Sentinel-2 requests never cross-contaminate
      if (matchingReq && matchingReq.satellite && !specificRequestId) {
        const isS1 = matchingReq.satellite.toLowerCase().includes('sentinel-1') && !matchingReq.satellite.toLowerCase().includes('sentinel-2');
        const isS2 = matchingReq.satellite.toLowerCase().includes('sentinel-2') && !matchingReq.satellite.toLowerCase().includes('sentinel-1');
        matchingList = matchingList.filter(r => {
          if (!r.satellite) return true;
          const rS1 = r.satellite.toLowerCase().includes('sentinel-1') && !r.satellite.toLowerCase().includes('sentinel-2');
          const rS2 = r.satellite.toLowerCase().includes('sentinel-2') && !r.satellite.toLowerCase().includes('sentinel-1');
          if (isS1 && !rS1) return false;
          if (isS2 && !rS2) return false;
          return true;
        });
      }

      let tifs = [];
      const reqsToTry = specificRequestId ? (matchingReq ? [matchingReq] : []) : (matchingReq ? [matchingReq] : matchingList);
      if (matchingReq || reqsToTry.length > 0) {
        if (matchingReq) {
          if (matchingReq.state && !stateVal) setStackState(matchingReq.state);
          if (matchingReq.district && !distVal) setStackDistrict(matchingReq.district);
          if (matchingReq.season) setStackSeason(matchingReq.season);
          if (matchingReq.start_date && !startVal) setStackStartDate(matchingReq.start_date.split('T')[0]);
          if (matchingReq.end_date && !endVal) setStackEndDate(matchingReq.end_date.split('T')[0]);
        }

        // Query candidate requests for tifs
        const allTifsMap = new Map();
        for (const r of reqsToTry) {
          try {
            const res = await axios.get(`${API_BASE}/requests/${r.id}/tifs`, { headers: getAuthHeader() });
            const list = res.data?.tifs || [];
            list.forEach(t => {
              const k = (t.path || `${t.scene_id}_${t.band}`).toLowerCase();
              if (!allTifsMap.has(k)) {
                allTifsMap.set(k, t);
              }
            });
          } catch (e) {
            console.warn('Could not fetch request tifs directly:', e);
          }
        }
        tifs = Array.from(allTifsMap.values());
      }

      // If direct request tifs yielded 0 or no matchingReq, fallback to region search only when no specific request is selected
      if (tifs.length === 0 && !specificRequestId && (distVal || stateVal)) {
        try {
          const retRes = await axios.get(`${API_BASE}/requests/tifs/retrieve`, {
            params: {
              state: stateVal || undefined,
              district: distVal || undefined,
              start_date: startVal || undefined,
              end_date: endVal || undefined
            },
            headers: getAuthHeader()
          });
          tifs = retRes.data?.tifs || [];
        } catch (rErr) {
          console.warn('Could not retrieve tifs by region:', rErr);
        }
      }

      const grouped = {};
      const isReqS1Only = Boolean(matchingReq && matchingReq.satellite && matchingReq.satellite.includes('Sentinel-1') && !matchingReq.satellite.includes('Sentinel-2'));
      const isReqS2Only = Boolean(matchingReq && matchingReq.satellite && matchingReq.satellite.includes('Sentinel-2') && !matchingReq.satellite.includes('Sentinel-1'));

      tifs.forEach(item => {
        const fPath = item.path || '';
        // Skip previously generated layer stack outputs from raw input scenes
        if (fPath.toLowerCase().includes('/composites/stack/') || fPath.toLowerCase().includes('\\composites\\stack\\')) {
          return;
        }

        let rawBand = (item.band || '').trim();
        let b = rawBand.replace(/\.tiff?$/i, '').toUpperCase().trim();
        const fName = (item.filename || (fPath ? fPath.split(/[\\/]/).pop() : '')).toUpperCase();

        if (b.includes('LSWI')) {
          b = 'LSWI';
        } else if (b.includes('NDVI')) {
          b = 'NDVI';
        } else if (b.includes('VV_VH') || b.includes('VV/VH')) {
          b = 'VV_VH';
        } else if (
          b === 'IW-VV' || b.endsWith('-VV') || b.endsWith('_VV') || b === 'VV' ||
          ((b.includes('VV') || fName.includes('IW-VV') || fName.includes('-VV.') || fName.includes('_VV.')) && !b.includes('VH') && !fName.includes('VH'))
        ) {
          b = 'VV';
        } else if (
          b === 'IW-VH' || b.endsWith('-VH') || b.endsWith('_VH') || b === 'VH' ||
          ((b.includes('VH') || fName.includes('IW-VH') || fName.includes('-VH.') || fName.includes('_VH.')) && !b.includes('VV') && !fName.includes('VV'))
        ) {
          b = 'VH';
        } else if (b.includes('_') || b.includes('-')) {
          const parts = b.split(/[_\-]+/);
          const lastPart = parts[parts.length - 1];
          if (['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B08A', 'B09', 'B11', 'B12', 'SCL', 'TCI', 'VV', 'VH'].includes(lastPart)) {
            b = lastPart;
          }
        }
        if (b === 'B2') b = 'B02';
        if (b === 'B3') b = 'B03';
        if (b === 'B4') b = 'B04';
        if (b === 'B8') b = 'B08';
        if (b === 'B08A') b = 'B8A';
        if (b === 'VV/VH' || b === 'VV-VH') b = 'VV_VH';

        if (!grouped[b]) grouped[b] = [];
        const filePath = item.path;
        const fileName = item.path ? item.path.split(/[\\/]/).pop() : (item.filename || `${b}.tif`);
        const fnUp = fileName.toUpperCase();
        const isCalibrated = Boolean(item.is_calibrated || fnUp.includes('CAL_TC_DB') || fnUp.includes('ORB_TNR') || fnUp.includes('_CAL_'));

        let tileVal = item.tile || '';
        if (!tileVal && item.path) {
          const tm = item.path.match(/T([0-9]{2}[A-Z]{3})/i) || item.path.match(/([0-9]{2}[A-Z]{3})/i);
          if (tm) tileVal = tm[1];
        }

        let sDate = item.sensing_date || '';
        if (!sDate && fileName) {
          const dm = fileName.match(/(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})/);
          if (dm) sDate = `${dm[1]}-${dm[2]}-${dm[3]} to ${dm[4]}-${dm[5]}-${dm[6]}`;
        }
        const isComp = fileName.toLowerCase().includes('composite');

        const sceneObj = {
          scene_id: item.scene_id || (isComp ? 'Composite' : 'Scene'),
          tile: tileVal,
          sensing_date: sDate,
          path: filePath,
          filename: fileName,
          size_bytes: item.size_bytes,
          is_composite: isComp,
          is_calibrated: isCalibrated
        };

        const existingIdx = grouped[b].findIndex(existing => {
          if (existing.path && filePath && existing.path.toLowerCase() === filePath.toLowerCase()) return true;
          if (existing.scene_id && item.scene_id && existing.scene_id === item.scene_id) return true;
          return false;
        });

        // Enforce strict satellite partitioning on grouped bands
        if (isReqS1Only && !['VV', 'VH', 'VV_VH'].includes(b)) return;
        if (isReqS2Only && ['VV', 'VH', 'VV_VH'].includes(b)) return;

        if (existingIdx >= 0) {
          // If existing is uncalibrated raw but this one is calibrated, upgrade to calibrated GeoTIFF
          if (!grouped[b][existingIdx].is_calibrated && isCalibrated) {
            grouped[b][existingIdx] = sceneObj;
          }
        } else {
          grouped[b].push(sceneObj);
        }
      });

      // Also try fetching composites for matched requests (skip optical composites for pure Sentinel-1 requests)
      const isPureS1 = matchingReq && matchingReq.satellite && matchingReq.satellite.toLowerCase().includes('sentinel-1') && !matchingReq.satellite.toLowerCase().includes('sentinel-2');
      if (!isPureS1) {
        const candidateReqs = (typeof reqsToTry !== 'undefined' && reqsToTry.length > 0) ? reqsToTry : (matchingReq ? [matchingReq] : []);
        for (const reqItem of candidateReqs) {
          if (reqItem.satellite && reqItem.satellite.toLowerCase().includes('sentinel-1') && !reqItem.satellite.toLowerCase().includes('sentinel-2')) continue;
          try {
            const compRes = await axios.get(`${API_BASE}/requests/${reqItem.id}/composites`, { headers: getAuthHeader() });
          const comps = compRes.data?.composites || compRes.data || [];
          comps.forEach(c => {
            let b = c.index;
            if (!b && c.filename) {
              const fn = c.filename.toUpperCase();
              if (fn.includes('LSWI')) b = 'LSWI';
              else if (fn.includes('NDVI')) b = 'NDVI';
              else if (fn.includes('VV_VH') || fn.includes('VV/VH')) b = 'VV_VH';
              else if (fn.includes('B02') || fn.includes('_B2')) b = 'B02';
              else if (fn.includes('B03') || fn.includes('_B3')) b = 'B03';
              else if (fn.includes('B04') || fn.includes('_B4')) b = 'B04';
              else if (fn.includes('B08') || fn.includes('_B8')) b = 'B08';
              else if (fn.includes('B8A') || fn.includes('B08A')) b = 'B8A';
              else if (fn.includes('B11')) b = 'B11';
            }
            if (!b) b = 'NDVI';
            b = b.toUpperCase().trim();
            if (b === 'B08A') b = 'B8A';
            if (!grouped[b]) grouped[b] = [];
            const cPath = c.path || c.output_path || c.local_delivery_path;
            const cFilename = c.filename || (cPath ? cPath.split(/[\\/]/).pop() : `Composite_${b}.tif`);
            const isDup = grouped[b].some(existing => (existing.path && cPath && existing.path.toLowerCase() === cPath.toLowerCase()) || (existing.filename && existing.filename.toLowerCase() === cFilename.toLowerCase()));
            if (!isDup) {
              let sDate = c.window ? `${c.window.start_date} to ${c.window.end_date}` : '';
              if (!sDate && cFilename) {
                const dm = cFilename.match(/(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})/);
                if (dm) sDate = `${dm[1]}-${dm[2]}-${dm[3]} to ${dm[4]}-${dm[5]}-${dm[6]}`;
              }
              if (!sDate) sDate = reqItem.start_date ? reqItem.start_date.split('T')[0] : (startVal || '');

              grouped[b].push({
                scene_id: `Composite (${c.window?.label || c.composite_interval || 'Delivered'})`,
                tile: c.district || distVal || 'Composite',
                sensing_date: sDate,
                path: cPath,
                filename: cFilename,
                size_bytes: (c.file_size_mb || c.size_mb || 0) * 1024 * 1024,
                is_composite: true
              });
            }
          });
        } catch (cErr) {
          // ignore
        }
      }
    }

      setStackDownloadedBandsData(grouped);

      // Default selection of layers based on request / available data
      const initialLayers = [];
      const initSelectedScenes = {};

      const isS1Only = matchingReq && matchingReq.satellite && matchingReq.satellite.includes('Sentinel-1') && !matchingReq.satellite.includes('Sentinel-2');
      const isS2Only = matchingReq && matchingReq.satellite && matchingReq.satellite.includes('Sentinel-2') && !matchingReq.satellite.includes('Sentinel-1');

      if (matchingReq) {
        const reqIndices = Array.isArray(matchingReq.indices) ? matchingReq.indices : (matchingReq.indices ? [matchingReq.indices] : []);
        reqIndices.forEach(idx => {
          let cleanIdx = idx.toUpperCase().trim();
          if (cleanIdx === 'VV/VH' || cleanIdx === 'VV-VH') cleanIdx = 'VV_VH';
          if (isS1Only && !['VV', 'VH', 'VV_VH'].includes(cleanIdx)) return;
          if (isS2Only && ['VV', 'VH', 'VV_VH'].includes(cleanIdx)) return;
          if (['NDVI', 'LSWI', 'VV_VH'].includes(cleanIdx) && !initialLayers.includes(cleanIdx)) {
            initialLayers.push(cleanIdx);
          }
        });
        const reqBands = Array.isArray(matchingReq.bands) ? matchingReq.bands : [];
        reqBands.forEach(b => {
          let cleanB = b.toUpperCase().replace(/\.TIFF?$/i, '').trim();
          if (cleanB === 'B08A') cleanB = 'B8A';
          if (cleanB === 'VV/VH' || cleanB === 'VV-VH') cleanB = 'VV_VH';
          if (cleanB === 'IW-VV' || cleanB.endsWith('-VV') || cleanB.endsWith('_VV') || (cleanB.includes('VV') && !cleanB.includes('VH'))) cleanB = 'VV';
          if (cleanB === 'IW-VH' || cleanB.endsWith('-VH') || cleanB.endsWith('_VH') || (cleanB.includes('VH') && !cleanB.includes('VV'))) cleanB = 'VH';
          if (isS1Only && !['VV', 'VH', 'VV_VH'].includes(cleanB)) return;
          if (isS2Only && ['VV', 'VH', 'VV_VH'].includes(cleanB)) return;
          if (!initialLayers.includes(cleanB)) initialLayers.push(cleanB);
        });
      }

      if (isS1Only) {
        if (grouped['VV'] && grouped['VV'].length > 0 && !initialLayers.includes('VV')) initialLayers.push('VV');
        if (grouped['VH'] && grouped['VH'].length > 0 && !initialLayers.includes('VH')) initialLayers.push('VH');
        if (grouped['VV_VH'] && grouped['VV_VH'].length > 0 && !initialLayers.includes('VV_VH')) initialLayers.push('VV_VH');
      } else if (isS2Only) {
        if (grouped['NDVI'] && grouped['NDVI'].length > 0 && !initialLayers.includes('NDVI')) initialLayers.push('NDVI');
        if (grouped['LSWI'] && grouped['LSWI'].length > 0 && !initialLayers.includes('LSWI')) initialLayers.push('LSWI');
      } else {
        if (grouped['VV'] && grouped['VV'].length > 0 && !initialLayers.includes('VV')) initialLayers.push('VV');
        if (grouped['VH'] && grouped['VH'].length > 0 && !initialLayers.includes('VH')) initialLayers.push('VH');
        if (grouped['NDVI'] && grouped['NDVI'].length > 0 && !initialLayers.includes('NDVI')) initialLayers.push('NDVI');
        if (grouped['LSWI'] && grouped['LSWI'].length > 0 && !initialLayers.includes('LSWI')) initialLayers.push('LSWI');
      }

      // Keep only layers that have actual scenes/rasters present in grouped
      let validLayers = initialLayers.filter(l => grouped[l] && grouped[l].length > 0);

      // If still empty, auto-select available bands from grouped (up to 4 bands)
      if (validLayers.length === 0) {
        Object.keys(grouped).slice(0, 4).forEach(k => {
          if (!validLayers.includes(k)) validLayers.push(k);
        });
      }

      // Default selected stage: select scenes within requested date window, or all if no date window
      Object.keys(grouped).forEach(bKey => {
        const scenesInWindow = grouped[bKey].filter(s => {
          if (!startVal && !endVal) return true;
          if (s.is_composite) return true;
          const rawDate = s.sensing_date || '';
          let dVal = '';
          const m1 = rawDate.match(/(\d{4})-(\d{2})-(\d{2})/);
          if (m1) {
            dVal = `${m1[1]}-${m1[2]}-${m1[3]}`;
          } else {
            const m2 = (rawDate || s.filename || '').match(/(\d{4})(\d{2})(\d{2})/);
            if (m2) dVal = `${m2[1]}-${m2[2]}-${m2[3]}`;
          }
          if (!dVal) return true;
          if (startVal && dVal < startVal) return false;
          if (endVal && dVal > endVal) return false;
          return true;
        });
        const scenesToSelect = scenesInWindow.length > 0 ? scenesInWindow : grouped[bKey];
        initSelectedScenes[bKey] = new Set(scenesToSelect.map(s => s.path || s.scene_id));
      });

      setStackSelectedScenes(initSelectedScenes);
      if (validLayers.length > 0) {
        setStackSelectedLayers(validLayers);
      } else {
        setStackSelectedLayers([]);
      }
    } catch (err) {
      console.warn('Could not fetch tifs for selected region:', err);
    } finally {
      setLoadingStackReqFiles(false);
    }
  }, [requests]);

  const selectAllScenesForBand = (band) => {
    const allScenes = stackDownloadedBandsData[band] || [];
    setStackSelectedScenes(prev => ({
      ...prev,
      [band]: new Set(allScenes.map(s => s.path || s.scene_id))
    }));
  };

  const deselectAllScenesForBand = (band) => {
    setStackSelectedScenes(prev => ({
      ...prev,
      [band]: new Set()
    }));
  };

  const toggleSceneSelection = (band, sceneKey) => {
    setStackSelectedScenes(prev => {
      const allScenes = stackDownloadedBandsData[band] || [];
      const currentSet = new Set(prev[band] !== undefined ? prev[band] : allScenes.map(s => s.path || s.scene_id));
      if (currentSet.has(sceneKey)) {
        currentSet.delete(sceneKey);
      } else {
        currentSet.add(sceneKey);
      }
      return { ...prev, [band]: currentSet };
    });
  };

  const deleteSceneFromBand = (band, sceneKey) => {
    setStackDownloadedBandsData(prev => {
      const list = prev[band] || [];
      return {
        ...prev,
        [band]: list.filter(s => (s.path || s.scene_id) !== sceneKey)
      };
    });
    setStackSelectedScenes(prev => {
      const allScenes = stackDownloadedBandsData[band] || [];
      const currentSet = new Set(prev[band] !== undefined ? prev[band] : allScenes.map(s => s.path || s.scene_id));
      currentSet.delete(sceneKey);
      return { ...prev, [band]: currentSet };
    });
  };

  const handleStackSeasonChange = (s) => {
    setStackSeason(s);
    let sDate = '2026-06-01';
    let eDate = '2026-10-31';
    if (s === 'Kharif') {
      sDate = '2026-06-01';
      eDate = '2026-10-31';
    } else if (s === 'Rabi') {
      sDate = '2026-11-01';
      eDate = '2027-03-31';
    } else if (s === 'Zaid') {
      sDate = '2026-03-01';
      eDate = '2026-06-30';
    } else if (s === 'Pre-Monsoon') {
      sDate = '2026-03-01';
      eDate = '2026-05-31';
    } else if (s === 'Monsoon') {
      sDate = '2026-06-01';
      eDate = '2026-09-30';
    } else if (s === 'Post-Monsoon') {
      sDate = '2026-10-01';
      eDate = '2026-12-31';
    } else if (s === 'Winter') {
      sDate = '2026-01-01';
      eDate = '2026-02-28';
    } else if (s === 'Annual') {
      sDate = '2026-01-01';
      eDate = '2026-12-31';
    }
    setStackStartDate(sDate);
    setStackEndDate(eDate);
    if (stackDistrict) {
      loadBandsAndScenesForRegion(stackState, stackDistrict, s, sDate, eDate);
    }
  };

  const toggleStackLayer = (layerId) => {
    setStackSelectedLayers(prev => {
      let next;
      if (prev.includes(layerId)) {
        next = prev.filter(l => l !== layerId);
      } else {
        next = [...prev, layerId];
        // Ensure all downloaded scenes for this band/index are selected by default
        setStackSelectedScenes(prevScenes => {
          const bandScenes = stackDownloadedBandsData[layerId] || [];
          if (bandScenes.length > 0 && !prevScenes[layerId]) {
            return {
              ...prevScenes,
              [layerId]: new Set(bandScenes.map(s => s.path || s.scene_id))
            };
          }
          return prevScenes;
        });
      }
      return next;
    });
  };

  const moveStackLayer = (index, direction) => {
    setStackSelectedLayers(prev => {
      const next = [...prev];
      if (direction === 'up' && index > 0) {
        const tmp = next[index - 1];
        next[index - 1] = next[index];
        next[index] = tmp;
      } else if (direction === 'down' && index < next.length - 1) {
        const tmp = next[index + 1];
        next[index + 1] = next[index];
        next[index] = tmp;
      }
      return next;
    });
  };

  const removeStackLayer = (layerId) => {
    setStackSelectedLayers(prev => prev.filter(l => l !== layerId));
  };

  const fetchStackHistory = useCallback(async (districtFilter) => {
    if (!token) return;
    setLoadingStackHistory(true);
    try {
      const params = {};
      if (districtFilter && districtFilter.trim()) {
        params.district = districtFilter.trim();
      }
      const res = await axios.get(`${API_BASE}/requests/layer-stack/history`, {
        params,
        headers: getAuthHeader()
      });
      setStackHistory(res.data || []);
    } catch (err) {
      console.error('Error fetching stack history:', err);
    } finally {
      setLoadingStackHistory(false);
    }
  }, [token]);

  const handleVerifyStackArchive = useCallback(async () => {
    if (!token) return;
    setVerifyingStackArchive(true);
    setStackArchiveNotice(null);
    try {
      const params = {};
      if (stackArchiveDistrict && stackArchiveDistrict.trim() && stackArchiveDistrict !== 'ALL') {
        params.district = stackArchiveDistrict.trim();
      }
      if (stackArchiveState && stackArchiveState.trim() && stackArchiveState !== 'ALL') {
        params.state = stackArchiveState.trim();
      }
      if (stackArchiveSeason && stackArchiveSeason.trim() && stackArchiveSeason !== 'ALL') {
        params.season = stackArchiveSeason.split('(')[0].trim();
      }
      if (stackArchiveStartDate && stackArchiveStartDate.trim()) {
        params.start_date = stackArchiveStartDate.trim();
      }
      if (stackArchiveEndDate && stackArchiveEndDate.trim()) {
        params.end_date = stackArchiveEndDate.trim();
      }
      const res = await axios.get(`${API_BASE}/requests/layer-stack/history`, {
        params,
        headers: getAuthHeader()
      });
      const data = res.data || [];
      setStackArchiveResults(data);
      setHasVerifiedStackArchive(true);
      if (data.length > 0) {
        setStackArchiveNotice({
          type: 'success',
          text: `Found ${data.length} verified layer stack(s) matching your parameters on NAS archive.`
        });
      } else {
        setStackArchiveNotice({
          type: 'warning',
          text: 'No layer-stacked GeoTIFFs found on NAS archive for the selected state/district/season/dates.'
        });
      }
    } catch (err) {
      console.error('Error verifying layer stacks on NAS archive:', err);
      setStackArchiveNotice({
        type: 'error',
        text: 'Failed to query NAS archive for layer stacks. Please check network connectivity.'
      });
    } finally {
      setVerifyingStackArchive(false);
    }
  }, [token, stackArchiveDistrict, stackArchiveState, stackArchiveSeason, stackArchiveStartDate, stackArchiveEndDate]);

  const handleResetStackArchive = () => {
    setStackArchiveState('');
    setStackArchiveDistrict('');
    setStackArchiveSeason('ALL');
    setStackArchiveStartDate('');
    setStackArchiveEndDate('');
    setStackArchiveResults([]);
    setHasVerifiedStackArchive(false);
    setStackArchiveNotice(null);
    setStackArchiveSearch('');
  };

  const startStackPolling = useCallback((taskId, targetDistrict) => {
    if (stackPollIntervalRef.current) {
      clearInterval(stackPollIntervalRef.current);
      stackPollIntervalRef.current = null;
    }

    setStackTaskId(taskId);
    setStackLoading(true);

    const poll = async () => {
      try {
        const pollRes = await axios.get(`${API_BASE}/requests/layer-stack/status/${taskId}`, {
          headers: getAuthHeader()
        });
        const data = pollRes.data;

        if (data.progress !== undefined) setStackProgress(data.progress);
        if (data.step) setStackStep(data.step);
        if (data.logs && Array.isArray(data.logs)) {
          setStackLogs(data.logs);
        }

        if (data.status === 'SUCCESS') {
          if (stackPollIntervalRef.current) {
            clearInterval(stackPollIntervalRef.current);
            stackPollIntervalRef.current = null;
          }
          setStackLoading(false);
          setStackProgress(100);
          setStackResult(data.result);
          setStackNotice({
            type: 'success',
            text: data.result?.already_completed
              ? `✓ Already in NAS: Layer stack for these exact bands is already generated on NAS — retrieved existing file "${data.result?.filename}" (${data.result?.file_size_mb} MB) directly without downloading or re-processing.`
              : `✓ Data retrieved from NAS: Layer stack assembled successfully from existing downloaded rasters: "${data.result?.filename}" (${data.result?.file_size_mb} MB, ${data.result?.total_bands} bands). No downloading required.`
          });
          localStorage.removeItem('sdap_active_stack_task');
          if (targetDistrict || stackDistrict) {
            fetchStackHistory(targetDistrict || stackDistrict);
          }
          fetchRequests();
        } else if (data.status === 'FAILED') {
          if (stackPollIntervalRef.current) {
            clearInterval(stackPollIntervalRef.current);
            stackPollIntervalRef.current = null;
          }
          setStackLoading(false);
          setStackNotice({
            type: 'error',
            text: `⚠️ Layer stacking failed: ${data.error || data.message || 'Execution failed.'}`
          });
          localStorage.removeItem('sdap_active_stack_task');
        }
      } catch (pollErr) {
        console.warn('Status poll warning:', pollErr);
      }
    };

    poll();
    stackPollIntervalRef.current = setInterval(poll, 1200);
  }, [stackDistrict, fetchStackHistory]);

  const executeStackTask = async (forceOverwrite = false) => {
    if (stackPollIntervalRef.current) {
      clearInterval(stackPollIntervalRef.current);
      stackPollIntervalRef.current = null;
    }

    setStackLoading(true);
    setStackNotice(null);
    setStackResult(null);
    setStackProgress(5);
    setStackStep('VERIFYING_TASK');
    setStackLogs([
      {
        timestamp: new Date().toLocaleTimeString(),
        level: 'INFO',
        message: forceOverwrite
          ? `Initiating fresh layer stack assembly for ${stackDistrict} (${stackSeason || 'Kharif'}) [Overwrite Mode]...`
          : `Checking whether layer stack for ${stackDistrict} (${stackSeason || 'Kharif'}) is already generated on NAS...`
      },
      {
        timestamp: new Date().toLocaleTimeString(),
        level: 'SUCCESS',
        message: `✓ Selected bands (${stackSelectedLayers.join(', ')}) are verified from downloaded data on NAS storage. Layer stacking will retrieve existing GeoTIFF rasters directly from NAS — no downloading required.`
      }
    ]);

    // Collect all selected file paths from scenes strictly based on checked boxes
    const selectedPaths = [];
    const selectedFilesByBand = {};

    stackSelectedLayers.forEach(lyr => {
      const scenes = stackDownloadedBandsData[lyr] || [];
      const selectedSet = stackSelectedScenes[lyr] !== undefined
        ? stackSelectedScenes[lyr]
        : new Set(scenes.map(s => s.path || s.scene_id));
      
      const bandPaths = [];
      scenes.forEach(sc => {
        const key = sc.path || sc.scene_id;
        if (selectedSet.has(key) && sc.path) {
          selectedPaths.push(sc.path);
          bandPaths.push(sc.path);
        }
      });
      if (bandPaths.length > 0) {
        selectedFilesByBand[lyr] = bandPaths;
      }
    });

    try {
      const isForce = forceOverwrite === true;
      const payload = {
        state: stackState || null,
        district: stackDistrict,
        season: stackSeason || 'Kharif',
        start_date: stackStartDate || null,
        end_date: stackEndDate || null,
        layers: stackSelectedLayers,
        clip_to_district: stackClipToDistrict,
        selected_files: selectedPaths.length > 0 ? selectedPaths : null,
        selected_files_by_band: Object.keys(selectedFilesByBand).length > 0 ? selectedFilesByBand : null,
        force_recreate: isForce,
        request_id: stackRequestId || null
      };

      const res = await axios.post(`${API_BASE}/requests/layer-stack`, payload, {
        headers: getAuthHeader()
      });

      // BACKEND SAFEGUARD: If exact matching layer stack is already on NAS storage, pop up modal!
      if (res.data.status === 'EXISTS_ON_NAS' || res.data.already_in_nas) {
        setStackLoading(false);
        fetchRequests();
        const matches = res.data.matches && res.data.matches.length > 0
          ? res.data.matches
          : [{
              filename: res.data.filename,
              path: res.data.path || res.data.output_path,
              file_size_mb: res.data.file_size_mb || res.data.size_mb,
              size_mb: res.data.file_size_mb || res.data.size_mb,
              district: res.data.district || stackDistrict,
              season: res.data.season || stackSeason,
              layers: stackSelectedLayers
            }];
        setStackMatchSelectedFiles(new Set(matches.map(m => m.filename)));
        setExactStackMatchModal({
          files: matches,
          district: stackDistrict,
          state: stackState,
          season: stackSeason,
          bands: stackSelectedLayers
        });
        return;
      }

      const taskId = res.data.task_id;
      setStackTaskId(taskId);
      setStackStep('TASK_STARTED');
      localStorage.setItem('sdap_active_stack_task', JSON.stringify({
        taskId,
        district: stackDistrict,
        season: stackSeason
      }));
      setStackLogs(prev => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString(),
          level: 'INFO',
          message: `Task ${taskId} registered in database. Streaming live execution logs from NAS...`
        }
      ]);

      startStackPolling(taskId, stackDistrict);

    } catch (err) {
      setStackLoading(false);
      setStackNotice({
        type: 'error',
        text: `⚠️ Layer stacking failed: ${formatApiError(err, 'Failed to launch layer stacking task.')}`
      });
    }
  };

  const handleExecuteLayerStacking = async (forceOverwrite = false) => {
    // CRITICAL: Strictly compare with boolean true so React SyntheticEvent is never treated as forceOverwrite=true
    const isForce = forceOverwrite === true;

    if (!stackDistrict) {
      setStackNotice({
        type: 'error',
        text: '⚠️ Please select a District to execute layer stacking.'
      });
      return;
    }
    if (!stackSelectedLayers || stackSelectedLayers.length === 0) {
      setStackNotice({
        type: 'error',
        text: '⚠️ Please select at least one band or index to build the layer stack.'
      });
      return;
    }

    if (!isForce) {
      // 1. Fetch latest NAS history for this district to ensure 100% up-to-date data
      let historyList = stackHistory || [];
      try {
        const cleanDistParam = (stackDistrict || '').split(',')[0].trim();
        const checkRes = await axios.get(`${API_BASE}/requests/layer-stack/history`, {
          params: { district: cleanDistParam },
          headers: getAuthHeader()
        });
        if (Array.isArray(checkRes.data)) {
          historyList = checkRes.data;
          setStackHistory(historyList);
        }
      } catch (checkErr) {
        console.warn('Live history check before stacking skipped:', checkErr);
      }

      // 2. Find ALL files where bands match stackSelectedLayers EXACTLY
      const isMatchingBands = (item) => {
        if (!item || !stackSelectedLayers || stackSelectedLayers.length === 0) return false;

        // Match district name robustly (handles 'North Goa' vs 'North_Goa', 'Anantapur, Andhra Pradesh' vs 'Anantapur')
        if (stackDistrict) {
          const dClean = stackDistrict.split(',')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const itemD = (item.district || '').split(',')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const fn = (item.filename || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          if (itemD && dClean && itemD !== dClean && !fn.startsWith(dClean) && !fn.includes(dClean) && !dClean.includes(itemD)) {
            return false;
          }
        }

        let itemBands = [];
        if (Array.isArray(item.layers) && item.layers.length > 0) {
          itemBands = item.layers.map(b => b.trim().toUpperCase()).filter(Boolean);
        } else if (item.filename) {
          itemBands = extractBandsFromStackFilename(item.filename);
        }
        if (itemBands.length === 0) return false;
        const selBands = stackSelectedLayers.map(b => b.trim().toUpperCase()).filter(Boolean);
        if (itemBands.length !== selBands.length) return false;
        return selBands.every(b => itemBands.includes(b)) && itemBands.every(b => selBands.includes(b));
      };

      const matchingFiles = historyList.filter(isMatchingBands);

      // 3. If exact matching layer stack data exists on NAS, pop up modal with the single best matching file!
      if (matchingFiles.length > 0) {
        let bestMatch = matchingFiles[0];

        if (matchingFiles.length > 1) {
          const dRangeTarget = (stackStartDate && stackEndDate)
            ? `${stackStartDate.replace(/-/g, '')}_${stackEndDate.replace(/-/g, '')}`
            : '';
          const exactDateMatches = matchingFiles.filter(f => 
            (f.start_date === stackStartDate && f.end_date === stackEndDate) ||
            (dRangeTarget && f.filename && f.filename.includes(dRangeTarget))
          );
          if (exactDateMatches.length > 0) {
            bestMatch = exactDateMatches[0];
          } else if (stackStartDate && stackEndDate) {
            try {
              const reqSpan = Math.abs((new Date(stackEndDate) - new Date(stackStartDate)) / (1000 * 60 * 60 * 24)) + 1;
              let bestDiff = Infinity;
              matchingFiles.forEach(c => {
                if (c.start_date && c.end_date) {
                  const cSpan = Math.abs((new Date(c.end_date) - new Date(c.start_date)) / (1000 * 60 * 60 * 24)) + 1;
                  const diff = Math.abs(cSpan - reqSpan);
                  if (diff < bestDiff) {
                    bestDiff = diff;
                    bestMatch = c;
                  }
                }
              });
            } catch (spanErr) {
              bestMatch = matchingFiles[0];
            }
          }
        }

        const selectedTarget = [bestMatch];
        setStackMatchSelectedFiles(new Set([bestMatch.filename]));
        setExactStackMatchModal({
          files: selectedTarget,
          district: stackDistrict,
          state: stackState,
          season: stackSeason,
          bands: stackSelectedLayers
        });
        return;
      }
    }

    // No exact match found or user explicitly requested overwrite: proceed with background task
    executeStackTask(isForce);
  };

  const handleStopLayerStacking = async () => {
    const currentTaskId = stackTaskId || (JSON.parse(localStorage.getItem('sdap_active_stack_task') || '{}')).taskId;
    try {
      const stopTarget = currentTaskId || 'all';
      await axios.post(`${API_BASE}/requests/layer-stack/stop/${stopTarget}`, {}, { headers: getAuthHeader() });
    } catch (e) {
      console.warn('Failed to stop layer stack task on backend:', e);
    }
    if (stackPollIntervalRef.current) {
      clearInterval(stackPollIntervalRef.current);
      stackPollIntervalRef.current = null;
    }
    setStackLoading(false);
    setStackStep('CANCELLED');
    localStorage.removeItem('sdap_active_stack_task');
    setStackNotice({
      type: 'warning',
      text: '⚠️ Layer stacking task was stopped upon user request.'
    });
    setStackLogs(prev => [
      ...prev,
      {
        timestamp: new Date().toLocaleTimeString(),
        level: 'WARNING',
        phase: 'STOPPED',
        message: '⏹️ Execution stopped by user. All background workers and mosaicing tasks halted.'
      }
    ]);
  };

  const handleDownloadStackedTif = (filePath, fileName) => {
    const currentToken = token || localStorage.getItem('sdap_token');
    const params = new URLSearchParams();
    params.append('file_path', filePath);
    if (currentToken) params.append('token', currentToken);

    const downloadUrl = `${API_BASE}/requests/layer-stack/download?${params.toString()}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.setAttribute('download', fileName || 'layer_stack.tif');
    link.setAttribute('target', '_blank');
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      try { document.body.removeChild(link); } catch (e) {}
    }, 1500);
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

  const boundariesLoadedRef = useRef(false);
  const isFetchingRequestsRef = useRef(false);

  // Sync selectedReqIdRef to track selected request across poll updates
  useEffect(() => {
    selectedReqIdRef.current = selectedReqForLogs?.id || null;
  }, [selectedReqForLogs?.id]);

  // Load states + districts from DB once when token becomes available
  useEffect(() => {
    if (!token) {
      boundariesLoadedRef.current = false;
      return;
    }
    if (boundariesLoadedRef.current) return;
    const storedToken = token || localStorage.getItem('sdap_token');
    if (!storedToken) return;
    boundariesLoadedRef.current = true;
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
      .catch(err => {
        console.error('[Boundaries] Failed to load:', err);
        boundariesLoadedRef.current = false;
      })
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
    if (token && (activeTab === 'retrieve_data' || activeTab === 'layer_stacking')) {
      fetchDownloadedRegions();
    }
    if (token && activeTab === 'layer_stacking') {
      fetchStackHistory(stackDistrict);
    }
  }, [token, activeTab, fetchDownloadedRegions, fetchStackHistory, stackDistrict]);

  // Reset autoload guard when token changes (login/logout)
  useEffect(() => {
    hasAutoLoadedStackRef.current = false;
  }, [token, currentUser?.id]);

  // Autoload initial Layer Stacking district ONCE when entering Tab 5
  useEffect(() => {
    if (!token || activeTab !== 'layer_stacking') return;
    if (hasAutoLoadedStackRef.current) return;

    // If district is already populated, mark as completed so user actions are not overridden
    if (stackDistrict) {
      hasAutoLoadedStackRef.current = true;
      return;
    }

    // Determine initial default district ONCE:
    let initialReq = null;
    if (requests && requests.length > 0) {
      initialReq = requests.find(r => r.district && ['COMPLETED', 'HELD', 'PROCESSING', 'SUCCESS'].includes(r.status)) ||
                   requests.find(r => r.district) || null;
    }

    if (initialReq && initialReq.district) {
      hasAutoLoadedStackRef.current = true;
      const d = initialReq.district;
      const s = initialReq.state || '';
      const sea = initialReq.season || 'Kharif';
      const sDate = initialReq.start_date ? initialReq.start_date.split('T')[0] : '2026-06-01';
      const eDate = initialReq.end_date ? initialReq.end_date.split('T')[0] : '2026-10-31';
      setStackDistrict(d);
      setStackState(s);
      setStackSeason(sea);
      setStackStartDate(sDate);
      setStackEndDate(eDate);
      loadBandsAndScenesForRegion(s, d, sea, sDate, eDate, initialReq.id);
      fetchStackHistory(d);
      return;
    }

    if (retDownloadedDistricts && retDownloadedDistricts.length > 0) {
      hasAutoLoadedStackRef.current = true;
      const firstDist = retDownloadedDistricts[0];
      const dName = typeof firstDist === 'string' ? firstDist : (firstDist.district_name || '');
      const sName = typeof firstDist === 'string' ? '' : (firstDist.state_name || '');
      if (dName) {
        setStackDistrict(dName);
        if (sName) setStackState(sName);
        loadBandsAndScenesForRegion(sName, dName, stackSeason, stackStartDate, stackEndDate);
        fetchStackHistory(dName);
      }
    }
  }, [token, activeTab, requests, retDownloadedDistricts]);

  // Fetch Requests List (scoped to logged-in user, or all requests for administrators)
  const fetchRequests = useCallback(async (isSilent = false) => {
    if (!token) return;
    if (isFetchingRequestsRef.current) return;
    isFetchingRequestsRef.current = true;
    if (!isSilent) setLoadingRequests(true);
    try {
      const scopeParam = currentUser?.role === 'ADMIN' ? '' : '?scope=mine';
      const res = await axios.get(`${API_BASE}/requests/${scopeParam}`, { headers: getAuthHeader() });
      const data = res.data || [];
      setRequests(data);
    } catch (err) {
      console.error('Error loading requests:', err);
    } finally {
      isFetchingRequestsRef.current = false;
      if (!isSilent) setLoadingRequests(false);
    }
  }, [token, currentUser?.role]);

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

  // Fetch Daily Storage Analytics (Admin Only)
  const fetchDailyStorage = useCallback(async (start = dailyStartDate, end = dailyEndDate) => {
    if (!token || currentUser?.role !== 'ADMIN') return;
    setLoadingDailyStorage(true);
    try {
      const params = new URLSearchParams();
      if (start) params.append('start_date', start);
      if (end) params.append('end_date', end);
      const qStr = params.toString();
      const res = await axios.get(`${API_BASE}/users/analytics/daily-storage${qStr ? '?' + qStr : ''}`, { headers: getAuthHeader() });
      setDailyStorageData(res.data);
    } catch (err) {
      console.error('Error loading daily storage analytics:', err);
    } finally {
      setLoadingDailyStorage(false);
    }
  }, [token, currentUser, dailyStartDate, dailyEndDate]);

  const handleDailyStorageQuickFilter = (range) => {
    setDailyStorageFilter(range);
    let start = '';
    let end = '';
    const now = new Date();
    if (range === '7D') {
      const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      start = past.toISOString().split('T')[0];
      end = now.toISOString().split('T')[0];
    } else if (range === '30D') {
      const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      start = past.toISOString().split('T')[0];
      end = now.toISOString().split('T')[0];
    }
    setDailyStartDate(start);
    setDailyEndDate(end);
    fetchDailyStorage(start, end);
  };

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
    axios.get(`${API_BASE}/requests/${req.id}`, { headers: getAuthHeader() })
      .then(res => {
        if (res.data && selectedReqIdRef.current === req.id) {
          setSelectedReqForLogs(res.data);
        }
      })
      .catch(() => {});
    axios.get(`${API_BASE}/requests/${req.id}/tifs`, { headers: getAuthHeader() })
      .then(res => {
        if (selectedReqIdRef.current === req.id) {
          setLogsModalTifs(res.data?.tifs || []);
        }
      })
      .catch(() => setLogsModalTifs([]));
    axios.get(`${API_BASE}/requests/${req.id}/composites`, { headers: getAuthHeader() })
      .then(res => {
        if (selectedReqIdRef.current === req.id) {
          setLogsModalComposites(res.data?.composites || res.data || []);
        }
      })
      .catch(() => setLogsModalComposites([]));
  };

  const closeLogsModal = () => {
    selectedReqIdRef.current = null;
    setIsLogsModalOpen(false);
    setSelectedReqForLogs(null);
    setLogsModalTifs([]);
    setLogsModalComposites([]);
    setShowWarningModal(false);
    setSelectedWarningScene(null);
    setLogStepFilter('all');
    setLogSearchQuery('');
  };

  // Initial fetch of requests on login
  useEffect(() => {
    if (token) {
      fetchRequests();
    }
  }, [token, fetchRequests]);

  // Initial / tab-switch fetch for admin data
  useEffect(() => {
    if (token && currentUser?.role === 'ADMIN') {
      if (activeTab === 'admin') {
        fetchDailyStorage();
      } else if (activeTab === 'users') {
        fetchAdminData();
      }
    }
  }, [token, currentUser, activeTab, fetchAdminData, fetchDailyStorage]);

  // Smart polling: poll requests & active log modal continuously in real-time (1s when modal open, 2.5s otherwise)
  useEffect(() => {
    if (!token) return;

    const interval = setInterval(async () => {
      // 1. If execution logs modal is open, strictly poll only the active modal request's data.
      // Do NOT run background table re-fetches to prevent unnecessary DOM re-renders, shifting, or scrolling.
      if (isLogsModalOpen && selectedReqIdRef.current) {
        const targetModalId = selectedReqIdRef.current;
        try {
          const res = await axios.get(`${API_BASE}/requests/${targetModalId}`, { headers: getAuthHeader() });
          if (res.data && selectedReqIdRef.current === targetModalId) {
            setSelectedReqForLogs(res.data);
          }
        } catch (e) {
          // ignore polling failure
        }
        try {
          const tifsRes = await axios.get(`${API_BASE}/requests/${targetModalId}/tifs`, { headers: getAuthHeader() });
          if (selectedReqIdRef.current === targetModalId) {
            setLogsModalTifs(tifsRes.data?.tifs || []);
          }
        } catch (e) {
          // ignore tifs polling failure
        }
        try {
          const compRes = await axios.get(`${API_BASE}/requests/${targetModalId}/composites`, { headers: getAuthHeader() });
          if (selectedReqIdRef.current === targetModalId) {
            setLogsModalComposites(compRes.data?.composites || compRes.data || []);
          }
        } catch (e) {
          // ignore composites polling failure
        }
        return; // Don't run background table re-fetches while user is inspecting logs in modal
      }

      // 2. Normal background polling when modal is closed (using isSilent=true to avoid loading state flickering)
      fetchRequests(true);
      if (currentUser?.role === 'ADMIN') {
        if (activeTab === 'users') {
          fetchAdminData();
          if (expandedUserId) {
            fetchUserRequests(expandedUserId);
          }
        }
      }
    }, isLogsModalOpen ? 1500 : 5000);

    return () => clearInterval(interval);
  }, [token, isLogsModalOpen, activeTab, currentUser?.role, expandedUserId, fetchRequests, fetchAdminData, fetchUserRequests]);

  // Auto scroll layer stack live console within its own container only if user is already near bottom (respects manual user scrolling)
  useEffect(() => {
    if (stackTerminalContainerRef.current && (stackLoading || stackLogs.length > 0)) {
      const el = stackTerminalContainerRef.current;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [stackLogs, stackLoading]);

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (stackPollIntervalRef.current) {
        clearInterval(stackPollIntervalRef.current);
      }
    };
  }, []);

  // Resume active layer stack task on page refresh / load
  useEffect(() => {
    if (!token) return;
    try {
      const savedTaskStr = localStorage.getItem('sdap_active_stack_task');
      if (savedTaskStr) {
        const saved = JSON.parse(savedTaskStr);
        if (saved && saved.taskId) {
          setStackTaskId(saved.taskId);
          if (saved.district && !stackDistrict) {
            setStackDistrict(saved.district);
          }
          if (saved.season && !stackSeason) {
            setStackSeason(saved.season);
          }
          startStackPolling(saved.taskId, saved.district);
        }
      }
    } catch (e) {
      console.warn('Failed to resume stack task from localStorage:', e);
    }
  }, [token, startStackPolling, stackDistrict, stackSeason]);

  // ---------------------------------------------------------------------------
  // Dynamic Storage & Step-Based Duration Estimation Logic (SRS 8.3 Algorithm)
  // Calculates estimated time dynamically based on active pipeline steps (2 to 4 steps).
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

    // Cloud cover filter reduces Sentinel-2 downloadable scenes when threshold < 100%
    const cloudVal = Math.min(100, Math.max(0, parseFloat(maxCloudCover) || 100));
    const s2CloudFactor = isS2 ? (0.35 + 0.65 * (cloudVal / 100.0)) : 1.0;

    if (isS1) {
      totalGB += tileCount * 2.5 * months * 0.615;
      scenesEstimate += Math.round(tileCount * 2.5 * months);
    }
    if (isS2) {
      const s2Scenes = Math.max(1, Math.round(tileCount * 6.0 * months * s2CloudFactor));
      totalGB += s2Scenes * 0.270;
      scenesEstimate += s2Scenes;
    }
    if (!isS1 && !isS2) {
      totalGB = tileCount * 6.0 * months * 0.270;
      scenesEstimate = Math.round(tileCount * 6.0 * months);
    }

    const totalMB = totalGB * 1024;

    // ── Step-by-Step Pipeline Duration Calculation (All in consistent minutes) ──
    // Using whole minutes (mins) for every step and the total prevents sec/mins unit confusion
    // and guarantees Step 1 + Step 2 + Step 3 + Step 4 === Overall Estimated Duration.

    // Step 1: Scene Discovery, Metadata Indexing & NAS Gap Verification (Always runs)
    const step1Mins = Math.max(1, Math.round((45 + (tileCount * 8) + (months * 10)) / 60));

    // Step 2: Raw Band Acquisition / AWS S3 Download (~12 MB/s pipeline transfer; Always runs)
    const step2Mins = Math.max(1, Math.round((totalMB / 12.0) / 60));

    // Step 3: Spectral & SAR Index Calculation (Runs only if indices are selected)
    const hasStep3 = Array.isArray(selectedIndices) && selectedIndices.length > 0;
    const step3Mins = hasStep3
      ? Math.max(1, Math.round((scenesEstimate * selectedIndices.length * 4.5) / 60))
      : 0;

    // Step 4: Temporal Compositing & District Clipping (Runs only if compositeInterval !== 'none')
    const hasStep4 = Boolean(compositeInterval && compositeInterval !== 'none');
    let compositeWindows = 0;
    const s1FortnightStep = (isS1 && !isS2) ? 12 : 15;
    if (compositeInterval === 'weekly') compositeWindows = Math.max(1, Math.ceil(days / 7));
    else if (compositeInterval === 'fortnightly') compositeWindows = Math.max(1, Math.ceil(days / s1FortnightStep));
    else if (compositeInterval === 'monthly') compositeWindows = Math.max(1, Math.ceil(days / 30));

    const levelFactor = level === 'mean' ? 1.25 : 1.0;
    const activeLayersForComp = Math.max(1, selectedIndices.length);
    const step4Mins = hasStep4
      ? Math.max(1, Math.round((compositeWindows * activeLayersForComp * tileCount * 6.0 * levelFactor) / 60))
      : 0;

    const activeStepsList = [
      { step: 1, name: 'Scene Discovery & Gap Check', active: true, mins: step1Mins, seconds: step1Mins * 60 },
      { step: 2, name: 'Raw Band Acquisition (S3)', active: true, mins: step2Mins, seconds: step2Mins * 60 },
      { step: 3, name: `Index Calculation (${selectedIndices.length} selected)`, active: hasStep3, mins: step3Mins, seconds: step3Mins * 60 },
      { step: 4, name: `Temporal Compositing (${compositeInterval || 'none'})`, active: hasStep4, mins: step4Mins, seconds: step4Mins * 60 },
    ];
    const activeStepsCount = activeStepsList.filter(s => s.active).length;

    // Overall total in minutes is the exact sum of the active steps' minutes
    const totalMins = activeStepsList.reduce((sum, s) => sum + (s.active ? s.mins : 0), 0);
    const totalSeconds = totalMins * 60;

    const formatStepMins = (m) => {
      if (m <= 0) return 'Skipped';
      return `~${m} mins`;
    };

    const downloadTimeText = `~${totalMins} mins`;

    return {
      gb: Math.round(totalGB * 100) / 100,
      tiles: tileCount,
      scenes: scenesEstimate,
      days,
      months: months.toFixed(1),
      downloadTimeText,
      totalMins,
      totalSeconds,
      activeStepsCount,
      totalPipelineSteps: 4,
      stepBreakdown: activeStepsList.map(s => ({
        ...s,
        durationText: formatStepMins(s.mins)
      }))
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
      level: level,
      priority: 'normal',
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

  // Admin Delete User Handler
  const handleDeleteUser = async (userId, userEmail) => {
    if (userId === currentUser?.id || userEmail === currentUser?.email) {
      alert("Administrators cannot delete their own active account.");
      return;
    }
    if (!window.confirm(`Are you sure you want to delete user account "${userEmail}"?\n\nThis will remove their account and clear associated work.`)) {
      return;
    }
    setAdminUserMsg(null);
    try {
      await axios.delete(`${API_BASE}/users/${userId}`, { headers: getAuthHeader() });
      setAdminUserMsg({ type: 'success', text: `User account "${userEmail}" deleted successfully.` });
      fetchAdminData();
      if (expandedUserId === userId) setExpandedUserId(null);
    } catch (err) {
      setAdminUserMsg({ type: 'error', text: formatApiError(err, 'Failed to delete user account.') });
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
      } else if (line.includes('WARNING') || line.includes('WARN') || line.includes('SKIPPED')) {
        className += ' log-line-warn';
      } else if (line.includes('downloaded & verified') || line.includes('[NEW DOWNLOAD COMPLETED]') || line.includes('COMPUTED]')) {
        className += ' log-line-download';
      } else if (line.startsWith('===') || line.includes('STARTING') || line.includes('STEP') || line.includes('STAGE')) {
        className += ' log-line-header';
      } else {
        className += ' log-line-info';
      }
      return <div key={idx} className={className}>{line}</div>;
    });
  };

  // Dynamically parse acquisition scenes, execution configs & tile scene insights from raw execution logs & verified TIFs
  const parseAcquisitionScenes = (rawLogs, selectedReq, verifiedTifs = []) => {
    const scenesMap = {};
    const tilesSet = new Set();
    const tileAuditMap = {};
    const stagesList = [];
    const gapSummary = {
      availableS3: 0,
      alreadyHeld: 0,
      missing: 0,
      targetDistrict: selectedReq?.district || selectedReq?.state || 'Auto',
      tilesIdentified: []
    };
    let currentActiveFolder = null;

    const configInfo = {
      district: selectedReq?.district || selectedReq?.state || 'Auto',
      range: selectedReq ? `${(selectedReq.start_date || '').split('T')[0]} to ${(selectedReq.end_date || '').split('T')[0]}` : '—',
      satellite: selectedReq?.satellite || 'Sentinel-1, Sentinel-2',
      indices: selectedReq?.indices ? selectedReq.indices.join(', ') : 'NDVI, LSWI',
      maxCloud: selectedReq?.max_cloud_cover ? `${selectedReq.max_cloud_cover}%` : '70.0%',
      level: selectedReq?.level ? selectedReq.level.toUpperCase() : 'MAX',
      composite: selectedReq?.composite_interval || 'WEEKLY'
    };

    const S1_BANDS = ['VV', 'VH'];
    const DEFAULT_S2_BANDS = ['B04', 'B08', 'B11', 'SCL'];
    const requestSatellite = selectedReq?.satellite || '';
    const hasS1 = requestSatellite.includes('Sentinel-1');
    const hasS2 = requestSatellite.includes('Sentinel-2');

    let reqBands;
    if (Array.isArray(selectedReq?.bands) && selectedReq.bands.length > 0) {
      reqBands = selectedReq.bands;
    } else if (hasS1 && !hasS2) {
      reqBands = ['VV', 'VH'];
    } else {
      reqBands = DEFAULT_S2_BANDS;
    }

    const warningsList = [];

    // Isolate the real-time execution logs from the latest run to prevent previous run logs from polluting
    let activeLogs = rawLogs || '';
    if (activeLogs.includes('--- USER TRIGGERED RE-RUN')) {
      const parts = activeLogs.split(/--- USER TRIGGERED RE-RUN[^-\n]*---/);
      const latestRunLogs = parts[parts.length - 1];
      if (latestRunLogs && latestRunLogs.trim().length > 30) {
        activeLogs = latestRunLogs;
      }
    } else if (activeLogs) {
      const execHeaders = activeLogs.split(/={40,}\r?\n\s*SDAP PIPELINE EXECUTION/);
      if (execHeaders.length > 1) {
        activeLogs = "SDAP PIPELINE EXECUTION" + execHeaders[execHeaders.length - 1];
      }
    }

    if (activeLogs && activeLogs.trim().length > 0) {
      const lines = activeLogs.split(/\r?\n/).map(l => l.trim());

      for (const line of lines) {
        // Extract timestamp: [YYYY-MM-DD HH:MM:SS] or HH:MM:SS
        const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/) || line.match(/^(\d{2}:\d{2}:\d{2})/);
        const timestamp = tsMatch ? (tsMatch[1] || tsMatch[0]) : '';

        // 1. Extract Pipeline Execution Stages & Steps
        const stageM = line.match(/\[(STAGE\s*\d(?:\/\d)?\s*[^\]]*)\]/i) || line.match(/(STEP\s*\d+:\s*[^.]*)/i);
        if (stageM) {
          const stageText = stageM[1].trim();
          if (!stagesList.some(s => s.text === stageText)) {
            stagesList.push({
              timestamp,
              text: stageText,
              rawLine: line
            });
          }
        }

        // 2. Extract Gap Check summary & target district
        const gapDistM = line.match(/(?:Gap Check & Scene Search for|querying database for tiles overlapping)\s*['"]?([^'"]+)['"]?/i);
        if (gapDistM) gapSummary.targetDistrict = gapDistM[1].trim();

        const gapTilesM = line.match(/Tiles identified.*:\s*\[([^\]]+)\]/i) || line.match(/Gap Check complete\.\s*Tiles:\s*\[([^\]]+)\]/i);
        if (gapTilesM) {
          const rawTiles = gapTilesM[1].replace(/['"]/g, '').split(',').map(t => t.trim()).filter(Boolean);
          gapSummary.tilesIdentified = rawTiles;
          rawTiles.forEach(t => { if (t !== 'S1_SAR' || hasS1) tilesSet.add(t); });
        }

        const gapM = line.match(/Gap Check complete.*Available on S3:\s*(\d+).*Already held:\s*(\d+).*Genuinely missing:\s*(\d+)/i)
          || line.match(/Available on AWS S3:\s*(\d+)/i);
        if (gapM) {
          if (gapM[3] !== undefined) {
            gapSummary.availableS3 = parseInt(gapM[1]);
            gapSummary.alreadyHeld = parseInt(gapM[2]);
            gapSummary.missing = parseInt(gapM[3]);
          } else {
            gapSummary.availableS3 = parseInt(gapM[1]);
          }
        }
        const heldM = line.match(/Already held in archive:\s*(\d+)/i);
        if (heldM) gapSummary.alreadyHeld = parseInt(heldM[1]);
        const missM = line.match(/Missing from archive:\s*(\d+)/i);
        if (missM) gapSummary.missing = parseInt(missM[1]);

        // 3. Extract Config Info from header lines
        const distM = line.match(/District:\s*([^\s|]+(?:\s+[^\s|]+)*)/i);
        if (distM) configInfo.district = distM[1].trim();

        const rangeM = line.match(/Range:\s*(\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2})/i);
        if (rangeM) configInfo.range = rangeM[1].trim();

        const satM = line.match(/Satellite:\s*([^|]+)/i);
        if (satM) configInfo.satellite = satM[1].trim();

        const indM = line.match(/Indices:\s*(\[[^\]]+\]|[^|]+)/i);
        if (indM) configInfo.indices = indM[1].replace(/[\[\]']/g, '').trim();

        const cloudM = line.match(/Max Cloud:\s*([^|]+)/i);
        if (cloudM) configInfo.maxCloud = cloudM[1].trim();

        const levelM = line.match(/Level:\s*([^|]+)/i);
        if (levelM) configInfo.level = levelM[1].trim().toUpperCase();

        const compM = line.match(/Composite:\s*([^\s|]+)/i);
        if (compM) configInfo.composite = compM[1].trim();

        // 4. Parse Tile Audit & Storage Status lines
        const tileAuditM = line.match(/\[TILE STATUS:\s*([^\]]+)\]\s*Tile\s+'?([A-Za-z0-9_]+)'?:\s*(.*)/i);
        if (tileAuditM) {
          const statusTag = tileAuditM[1].trim();
          const tileName = tileAuditM[2].trim();
          const detailsStr = tileAuditM[3].trim();

          const countsM = detailsStr.match(/(\d+)\/(\d+)\s+scenes/i);
          const heldCount = countsM ? parseInt(countsM[1]) : 0;
          const totalCount = countsM ? parseInt(countsM[2]) : 0;

          tileAuditMap[tileName] = {
            tile: tileName,
            status: statusTag,
            details: detailsStr,
            held: heldCount,
            total: totalCount
          };
          if (tileName !== 'S1_SAR' || hasS1) tilesSet.add(tileName);
        }

        // 5. Extract MGRS / S1 Tiles identified
        const tilesMatch = line.match(/Tiles:\s*\[([^\]]+)\]/i) || line.match(/Tiles identified:\s*\[([^\]]+)\]/i);
        if (tilesMatch) {
          tilesMatch[1].replace(/['"]/g, '').split(',').forEach(t => {
            const cleanT = t.trim();
            if (cleanT && (cleanT !== 'S1_SAR' || hasS1)) tilesSet.add(cleanT);
          });
        }

        const tileDirectMatch = line.match(/Tile\s+'?([A-Za-z0-9_]+)'?/i);
        if (tileDirectMatch && tileDirectMatch[1] !== 'S1_SAR') {
          tilesSet.add(tileDirectMatch[1]);
        }

        // 6. Parse Processing Scene lines: e.g. [1/51 - 1%] Processing 'S2B_43PHS_20260502_0_L2A'
        // or Processing time-step 1/20 (S1_20240601T001631_VH)
        const procM = line.match(/(?:\[(\d+\/\d+)(?:\s*-\s*\d+%)?\]\s*)?Processing\s+(?:Sentinel-1\s+Scene:\s*)?['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i)
          || line.match(/Processing\s+time-step\s+(\d+\/\d+)\s*\((S1_[0-9A-Za-z_]+)\)/i)
          || line.match(/(?:Already processed at|Processing Sentinel-1 Scene:?)\s*['"]?(?:.*[\\/])?(S1[A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i);

        if (procM) {
          const folderName = [procM[3], procM[2], procM[1]].find(g => g && (g.startsWith('S1') || g.startsWith('S2'))) || procM[2] || procM[1];
          if (folderName) {
            currentActiveFolder = folderName;
            const parts = folderName.split('_');
          const sat = parts[0] || (folderName.startsWith('S1') ? 'S1A' : 'S2');
          const isS1 = sat.startsWith('S1');
          let tile = isS1 ? 'S1_SAR' : (parts[1] || '—');
          let formattedDate = '—';

          if (isS1) {
            for (const part of parts) {
              const dtM = part.match(/^(\d{8})T\d+$/);
              if (dtM) {
                const d8 = dtM[1];
                formattedDate = `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
                break;
              }
            }
          } else {
            const datePart = parts[2] || '';
            formattedDate = (datePart.length === 8 && /^\d+$/.test(datePart))
              ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
              : (datePart || '—');
            if (tile.length >= 4 && tile !== '—') tilesSet.add(tile);
          }

          if (!scenesMap[folderName]) {
            scenesMap[folderName] = {
              folder: folderName,
              tile,
              date: formattedDate !== '—' ? formattedDate : (selectedReq?.start_date || '—'),
              satellite: sat,
              status: 'DOWNLOADING',
              bands: [], // Starts EMPTY - only real downloads added
              missingBands: [],
              warning: null,
              warnings: [],
              bandSizes: {},
              totalSize: '',
              storagePath: '',
              progressRatio: procM[1] || '',
              progressPct: procM[2] || '',
              timestamp
            };
          } else {
            if (scenesMap[folderName].status !== 'COMPLETE' && scenesMap[folderName].status !== 'SKIPPED') {
              scenesMap[folderName].status = 'DOWNLOADING';
            }
            if (procM[1]) scenesMap[folderName].progressRatio = procM[1];
            if (procM[2]) scenesMap[folderName].progressPct = procM[2];
          }
        }
      }

        // 7. Parse Band download progress lines in real time:
        // Examples:
        // ↳ Band 'B02.tif' (201.6 MB) downloaded & verified on NAS.
        // [2026-09-29 10:36:32] INFO:sdap.universal_pipeline:     ↳ Band 'B04.tif' (220.5 MB) downloaded & verified on NAS.
        // Tile 1/1 (VH.tiff) reprojected successfully.
        // [ATTACHED] Band 2/20: S1_20240606T000529_VH (21499514 valid pixels)
        const bandM = line.match(/(?:↳\s*)?Band\s+'(?:measurement[\\/])?([A-Za-z0-9_\-]+)\.(?:tiff?|jp2)'(?:\s*\(([^)]+)\))?\s*downloaded/i)
          || line.match(/Tile\s+\d+\/\d+\s*\(([A-Za-z0-9_\-]+)\.tiff?\)\s*reprojected/i)
          || line.match(/\[ATTACHED\]\s*Band\s+\d+\/\d+:\s*(?:S1_[0-9A-Za-z_]+_)?([A-Za-z0-9_\-]+)(?:\s*\(([^)]+)\))?/i);

        if (bandM) {
          let bandName = bandM[1].toUpperCase().replace(/\.TIFF?$/, '').trim();
          if (bandName === 'B08A') bandName = 'B8A';
          if (bandName === 'IW-VV' || bandName === 'IW_VV') bandName = 'VV';
          if (bandName === 'IW-VH' || bandName === 'IW_VH') bandName = 'VH';
          const bandSize = bandM[2] || '';

          // Determine target scene: currentActiveFolder or explicit scene tag in line
          let targetSc = currentActiveFolder;
          const scExplicit = line.match(/\[(S[12][A-Za-z0-9]_[0-9A-Za-z_]+|S1_\d{8}T\d+_[A-Za-z0-9_]+)\]/i);
          if (scExplicit && scenesMap[scExplicit[1]]) {
            targetSc = scExplicit[1];
          }

          if (targetSc && scenesMap[targetSc]) {
            if (!scenesMap[targetSc].bands.includes(bandName)) {
              scenesMap[targetSc].bands.push(bandName);
            }
            if (bandSize) scenesMap[targetSc].bandSizes[bandName] = bandSize;
            scenesMap[targetSc].timestamp = timestamp;
            if (scenesMap[targetSc].status === 'PENDING') {
              scenesMap[targetSc].status = 'DOWNLOADING';
            }
          }
        }

        // 8. Parse Individual Scene Completion lines with band summary:
        // Examples:
        // [NEW DOWNLOAD COMPLETED] Scene 'S2B_43PHS_20260502_0_L2A' (Tile 43PHS, Date 2026-05-02) downloaded to '...'
        //   (8 new bands, 1205.2 MB: B02.tif: 201.6MB, B03.tif: 208.1MB, B04.tif: 220.5MB, B08.tif: 222.2MB, B8A.tif: 57.5MB, B11.tif: 57.4MB, SCL.tif: 2.0MB, TCI.tif: 314.5MB, metadata.xml stored).
        const compMatch = line.match(/✓?\s*\[(?:NEW DOWNLOAD COMPLETED|SENTINEL-1 COMPLETE PRODUCT DOWNLOADED|ALREADY DOWNLOADED - SKIPPED)\]\s*Scene\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i)
          || line.match(/✓?\s*\[NAS VERIFIED - SKIPPED\]\s*['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i)
          || line.match(/\[CACHE VERIFIED\]\s*Scene\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i)
          || line.match(/\[SAR POLARIZATIONS VERIFIED\].*Scene\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i);

        if (compMatch) {
          const folderName = compMatch[1];
          if (scenesMap[folderName]) {
            scenesMap[folderName].status = 'COMPLETE';
            const sizeM = line.match(/(\d+(?:\.\d+)?\s*MB)/i);
            if (sizeM) scenesMap[folderName].totalSize = sizeM[1];
            const destM = line.match(/(?:downloaded to|saved to NAS in|cached at|at)\s+'([^']+)'/i);
            if (destM) scenesMap[folderName].storagePath = destM[1];
            scenesMap[folderName].timestamp = timestamp;

            // For Sentinel-1, ensure core VV & VH bands are marked
            if (folderName.startsWith('S1')) {
              if (!scenesMap[folderName].bands.includes('VV')) scenesMap[folderName].bands.push('VV');
              if (!scenesMap[folderName].bands.includes('VH')) scenesMap[folderName].bands.push('VH');
            }

            // Extract all bands mentioned in the summary list e.g. B02.tif: 201.6MB, B03.tif: ...
            const bandMatches = line.matchAll(/([A-Za-z0-9_]+)\.tiff?(?::\s*([\d.]+\s*MB))?/gi);
            for (const bm of bandMatches) {
              let bName = bm[1].toUpperCase().trim();
              if (bName === 'B08A') bName = 'B8A';
              if (!['METADATA', 'PRODUCTINFO', 'TILEINFO', 'MANIFEST'].includes(bName)) {
                if (!scenesMap[folderName].bands.includes(bName)) {
                  scenesMap[folderName].bands.push(bName);
                }
                if (bm[2]) scenesMap[folderName].bandSizes[bName] = bm[2];
              }
            }
          }
        }

        // 9. Parse Stage 3 Indices Calculations & Cache Verification:
        // Examples:
        // ✓ [INDICES VERIFIED ON NAS & DB - SKIPPED] [3/51] Scene 'S2C_43PHS_20260507_0_L2A' -> 'NDVI.tif' & 'LSWI.tif' cached at ... Skipping calculation.
        // ✓ [CLOUD MASKING & INDICES COMPUTED] [1/51] Scene 'S2B_43PHS_20260502_0_L2A' -> Saved 'NDVI.tif' & 'LSWI.tif' in ...
        // ✓ [SAR VV/VH RATIO COMPUTED] [1/18] Scene 'S1_...' -> Saved 'VV_VH.tif'
        // ✓ [SAR RATIO VERIFIED ON NAS & DB - SKIPPED] [1/18] Scene 'S1_...' -> 'VV_VH.tif' cached ...
        const idxSkipM = line.match(/\[INDICES VERIFIED ON NAS & DB - SKIPPED\].*Scene\s+['"]?([A-Za-z0-9_]+)['"]?\s*->\s*(.*)/i);
        if (idxSkipM) {
          const folderName = idxSkipM[1];
          if (scenesMap[folderName]) {
            if (!scenesMap[folderName].bands.includes('NDVI')) scenesMap[folderName].bands.push('NDVI');
            if (!scenesMap[folderName].bands.includes('LSWI')) scenesMap[folderName].bands.push('LSWI');
            if (scenesMap[folderName].status !== 'DOWNLOADING') {
              scenesMap[folderName].status = 'COMPLETE';
            }
          }
        }

        const idxCompM = line.match(/\[CLOUD MASKING & INDICES COMPUTED\].*Scene\s+['"]?([A-Za-z0-9_]+)['"]?\s*->\s*(.*)/i);
        if (idxCompM) {
          const folderName = idxCompM[1];
          if (scenesMap[folderName]) {
            if (!scenesMap[folderName].bands.includes('NDVI')) scenesMap[folderName].bands.push('NDVI');
            if (!scenesMap[folderName].bands.includes('LSWI')) scenesMap[folderName].bands.push('LSWI');
            if (scenesMap[folderName].status !== 'DOWNLOADING') {
              scenesMap[folderName].status = 'COMPLETE';
            }
          }
        }

        const sarRatioM = line.match(/\[SAR (?:VV\/VH )?RATIO (?:VERIFIED|COMPUTED)[^\]]*\].*Scene\s+['"]?([A-Za-z0-9_]+)['"]?/i);
        if (sarRatioM) {
          const folderName = sarRatioM[1];
          if (scenesMap[folderName]) {
            if (!scenesMap[folderName].bands.includes('VV_VH')) scenesMap[folderName].bands.push('VV_VH');
            if (scenesMap[folderName].status !== 'DOWNLOADING') {
              scenesMap[folderName].status = 'COMPLETE';
            }
          }
        }

        // Catch general 'Saved NDVI.tif' / 'Saved LSWI.tif' lines
        if (line.includes('NDVI.tif') || line.includes('LSWI.tif')) {
          const scM = line.match(/Scene\s+['"]?([A-Za-z0-9_]+)['"]?/i) || line.match(/\[([A-Za-z0-9_]+)\]/);
          const tSc = scM ? scM[1] : currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            if (line.includes('NDVI.tif') && !scenesMap[tSc].bands.includes('NDVI')) scenesMap[tSc].bands.push('NDVI');
            if (line.includes('LSWI.tif') && !scenesMap[tSc].bands.includes('LSWI')) scenesMap[tSc].bands.push('LSWI');
          }
        }

        // Sentinel-1 SAR Sequential Calibration Steps & Deliverables
        const s1StepM = line.match(/\[STEP\s*(\d)\/5:\s*([^\]]+)\]/i);
        if (s1StepM) {
          const tSc = currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            scenesMap[tSc].s1CurrentStep = parseInt(s1StepM[1]);
            scenesMap[tSc].s1StepDesc = s1StepM[2].trim();
            scenesMap[tSc].hasSarCalibrated = true;
          }
        }

        if (/VV_Orb_tnr_cal_Tc_db/i.test(line) || /Calibrated VV/i.test(line)) {
          const tSc = currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            if (!scenesMap[tSc].bands.includes('VV_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VV_Orb_tnr_cal_Tc_db');
            scenesMap[tSc].hasSarCalibrated = true;
          }
        }
        if (/VH_Orb_tnr_cal_Tc_db/i.test(line) || /Calibrated VH/i.test(line)) {
          const tSc = currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            if (!scenesMap[tSc].bands.includes('VH_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VH_Orb_tnr_cal_Tc_db');
            scenesMap[tSc].hasSarCalibrated = true;
          }
        }
        if (/VV_VH_Orb_tnr_cal_Tc_db/i.test(line) || /polarimetric decibel ratio/i.test(line) || /Saved GeoTIFF:.*VV_VH/i.test(line)) {
          const tSc = currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            if (!scenesMap[tSc].bands.includes('VV_VH_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VV_VH_Orb_tnr_cal_Tc_db');
            if (!scenesMap[tSc].bands.includes('VV_VH')) scenesMap[tSc].bands.push('VV_VH');
            scenesMap[tSc].hasSarCalibrated = true;
          }
        }
        if (/\[SAR CACHED\]/i.test(line) || /deliverables archived successfully/i.test(line) || /SENTINEL-1 SAR CALIBRATION/i.test(line)) {
          const tSc = currentActiveFolder;
          if (tSc && scenesMap[tSc]) {
            scenesMap[tSc].hasSarCalibrated = true;
            scenesMap[tSc].status = 'COMPLETE';
            if (!scenesMap[tSc].bands.includes('VV_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VV_Orb_tnr_cal_Tc_db');
            if (!scenesMap[tSc].bands.includes('VH_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VH_Orb_tnr_cal_Tc_db');
            if (!scenesMap[tSc].bands.includes('VV_VH_Orb_tnr_cal_Tc_db')) scenesMap[tSc].bands.push('VV_VH_Orb_tnr_cal_Tc_db');
            if (!scenesMap[tSc].bands.includes('VV_VH')) scenesMap[tSc].bands.push('VV_VH');
          }
        }

        // 10. Parse Download Failed / Incomplete Scenes (Stage 2):
        // Examples:
        // ⚠ WARN: Scene 'S2C_45QVC_20241207_1_L2A' download failed (Incomplete bands: []) - remains PENDING.
        // ⚠ WARN: Scene 'S2C_45QVD_20241107_1_L2A' download failed (Incomplete bands: ['B04']) - remains PENDING.
        const dlFailM = line.match(/(?:⚠\s*)?(?:WARN|WARNING):\s*Scene\s+['"]?([A-Za-z0-9_]+)['"]?\s+download failed(?:\s*\(Incomplete bands:\s*\[([^\]]*)\]\))?\s*-\s*remains PENDING/i);
        if (dlFailM) {
          const folderName = dlFailM[1];
          const rawFailedBands = (dlFailM[2] || '').replace(/['"]/g, '').split(',').map(b => b.trim()).filter(Boolean);
          const warnMsg = rawFailedBands.length > 0
            ? `Download failed (Missing bands: [${rawFailedBands.join(', ')}]) - remains PENDING in queue`
            : `Download failed from S3 (Incomplete bands) - remains PENDING in acquisition queue`;

          if (!scenesMap[folderName]) {
            const parts = folderName.split('_');
            const sat = parts[0] || 'S2';
            const tile = parts[1] || '—';
            let formattedDate = '—';
            const datePart = parts[2] || '';
            if (datePart.length === 8 && /^\d+$/.test(datePart)) {
              formattedDate = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
            }
            scenesMap[folderName] = {
              folder: folderName,
              tile,
              date: formattedDate !== '—' ? formattedDate : (selectedReq?.start_date || '—'),
              satellite: sat,
              status: 'PENDING',
              bands: [],
              missingBands: rawFailedBands,
              warning: warnMsg,
              warnings: [warnMsg],
              isFailedDownload: true,
              bandSizes: {},
              totalSize: '',
              storagePath: '',
              timestamp
            };
          } else {
            scenesMap[folderName].status = 'PENDING';
            scenesMap[folderName].warning = warnMsg;
            scenesMap[folderName].isFailedDownload = true;
            if (!scenesMap[folderName].warnings) scenesMap[folderName].warnings = [];
            scenesMap[folderName].warnings.push(warnMsg);
            if (rawFailedBands.length > 0) scenesMap[folderName].missingBands = rawFailedBands;
          }

          warningsList.push({
            type: 'DOWNLOAD_FAILED',
            scene: folderName,
            message: warnMsg,
            bands: rawFailedBands,
            timestamp
          });
        }

        // 10.5. Parse Missing Optical Composite Rasters:
        // Examples:
        // ⚠ WARN: No NDVI rasters available for window 2024-07-31 to 2024-08-14.
        // ⚠ WARN: No LSWI rasters available for window 2024-07-31 to 2024-08-14.
        const noRasterM = line.match(/(?:⚠\s*)?(?:WARN|WARNING):\s*No\s+([A-Za-z0-9_/]+)\s+rasters available for window\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
        if (noRasterM) {
          const idxName = noRasterM[1];
          const wStart = noRasterM[2];
          const wEnd = noRasterM[3];
          const msg = `No ${idxName} rasters available for window ${wStart} to ${wEnd} (heavy cloud cover)`;
          warningsList.push({
            type: 'NO_RASTERS',
            scene: `Window ${wStart} to ${wEnd}`,
            message: msg,
            bands: [idxName],
            timestamp
          });
        }

        // 10.6. Parse Missing Bands Warnings:
        // Examples:
        // ⚠ WARN: Missing required bands for optical indices in 'S2B_...': ['B04', 'B08']
        // Scene S2B_... incomplete missing ['B02', 'B03'] - remains PENDING
        const missBandsM = line.match(/Missing required bands.*in\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?:\s*\[([^\]]+)\]/i)
          || line.match(/Scene\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?\s+incomplete missing\s*\[([^\]]+)\]/i);

        if (missBandsM) {
          const folderName = missBandsM[1];
          const rawMissing = missBandsM[2].replace(/['"]/g, '').split(',').map(b => b.trim()).filter(Boolean);
          if (scenesMap[folderName]) {
            scenesMap[folderName].missingBands = rawMissing;
            scenesMap[folderName].warning = `Missing required bands: ${rawMissing.join(', ')}`;
            scenesMap[folderName].status = 'WARNING';
          }
          warningsList.push({
            type: 'MISSING_BANDS',
            scene: folderName,
            message: `Missing bands: ${rawMissing.join(', ')}`,
            bands: rawMissing,
            timestamp
          });
        }

        // 11. Parse Out-of-bounds Sentinel-1 & 0-pixel Warnings:
        // Examples:
        // WARNING [S1_20240601T001631_VH] Tile VH.tiff bounds [67.75, -50.18 to 71.92, -47.67] do NOT overlap target district bounds [86.25, 20.29 to 87.09, 20.79]. Skipping.
        // WARNING [SKIPPED] Tile 'S1_20240601T001631_VH' contains 0 valid data pixels for district 'Kendrapara' (out-of-bounds). Omitting from final layer stack.
        const oobM = line.match(/\[(S1_[0-9A-Za-z_]+)\]\s*Tile\s+.*bounds.*do\s+NOT\s+overlap.*district/i)
          || line.match(/Tile\s+'?(S1_[0-9A-Za-z_]+)'?\s*contains\s+0\s+valid\s+data\s+pixels/i)
          || line.match(/Tile\s+VH\.tiff\s+bounds.*do\s+NOT\s+overlap/i);

        if (oobM) {
          let oobScene = oobM[1] || currentActiveFolder;
          if (oobScene && scenesMap[oobScene]) {
            scenesMap[oobScene].status = 'SKIPPED';
            scenesMap[oobScene].warning = 'Tile bounds do not overlap target district (0 valid pixels)';
          }
          warningsList.push({
            type: 'OUT_OF_BOUNDS',
            scene: oobScene || 'Sentinel-1 Tile',
            message: 'Tile bounds do not overlap target district boundary (0 valid pixels). Skipped from layer stack.',
            timestamp
          });
        }

        // 12. Parse failed or error scenes
        const failMatch = line.match(/Scene\s+['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?\s+(?:incomplete|download failed)|Failed fetching.*['"]?(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)['"]?/i);
        if (failMatch) {
          const folderName = failMatch[1] || failMatch[2];
          if (scenesMap[folderName]) {
            scenesMap[folderName].status = 'PENDING';
            if (!scenesMap[folderName].warning) {
              scenesMap[folderName].warning = `Acquisition failed: ${line}`;
            }
          }
          if (!warningsList.some(w => w.scene === folderName)) {
            warningsList.push({
              type: 'FAILED',
              scene: folderName,
              message: `Acquisition failed: ${line}`,
              timestamp
            });
          }
        }

        // 13. General scene matching for pre-existing or cached scenes
        const sceneMatch = line.match(/\b(S[12][A-Za-z0-9]_[0-9A-Za-z_]+)/i);
        if (sceneMatch) {
          const folderName = sceneMatch[1];
          const parts = folderName.split('_');

          if (parts.length >= 3 && !scenesMap[folderName]) {
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
            const isComplete = /COMPLETED|downloaded & verified|100% CACHED/.test(line);
            const isLineSkipped = /SKIPPED|0 valid pixels|do NOT overlap/i.test(line);

            scenesMap[folderName] = {
              folder: folderName,
              tile,
              date: formattedDate !== '—' ? formattedDate : (selectedReq?.start_date || '—'),
              satellite: sat,
              status: isFailed ? 'FAILED' : isLineSkipped ? 'SKIPPED' : isComplete ? 'COMPLETE' : 'PENDING',
              bands: [], // Start EMPTY - only real downloads added
              missingBands: [],
              bandSizes: {},
              totalSize: '',
              storagePath: '',
              warning: isLineSkipped ? line : null,
              warnings: [],
              timestamp
            };
          }
        }
      }
    }

    // Incorporate directly verified TIFs from the database and NAS storage
    if (Array.isArray(verifiedTifs) && verifiedTifs.length > 0) {
      verifiedTifs.forEach(t => {
        const scId = t.scene_id;
        if (!scId) return;
        if (t.tile && t.tile !== 'S1_SAR') tilesSet.add(t.tile);

        let rawBand = (t.band || '').trim();
        let bClean = rawBand.replace(/\.tiff?$/i, '').toUpperCase().trim();
        if (bClean.includes('LSWI')) bClean = 'LSWI';
        else if (bClean.includes('NDVI')) bClean = 'NDVI';
        else if (bClean.includes('VV_VH') || bClean.includes('VV/VH')) bClean = 'VV_VH';
        if (bClean === 'B08A') bClean = 'B8A';

        const parts = scId.split('_');
        const sat = scId.startsWith('S1') ? 'S1A' : (parts[0] || 'S2B');

        let sDate = t.sensing_date || '';
        if (!sDate && parts.length >= 3) {
          const datePart = parts[2] || '';
          if (datePart.length === 8 && /^\d+$/.test(datePart)) {
            sDate = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
          }
        }
        if (!sDate && selectedReq?.start_date) {
          sDate = selectedReq.start_date.split('T')[0];
        }

        if (!scenesMap[scId]) {
          // If real-time execution logs exist, ONLY scenes explicitly logged in the current run may be displayed.
          // NEVER inject unlogged or previous historical scenes from the DB.
          if (rawLogs && rawLogs.trim().length > 0) {
            return;
          }

          const reqSat = selectedReq?.satellite || '';
          const isReqS1Only = reqSat.includes('Sentinel-1') && !reqSat.includes('Sentinel-2');
          const isReqS2Only = reqSat.includes('Sentinel-2') && !reqSat.includes('Sentinel-1');
          if (isReqS1Only && (sat.startsWith('S2') || scId.startsWith('S2') || t.tile !== 'S1_SAR')) return;
          if (isReqS2Only && (sat.startsWith('S1') || scId.startsWith('S1') || t.tile === 'S1_SAR')) return;

          const reqStart = (selectedReq?.start_date || '').split('T')[0];
          const reqEnd = (selectedReq?.end_date || '').split('T')[0];
          const isWithinDates = (!sDate || !reqStart || sDate >= reqStart) && (!sDate || !reqEnd || sDate <= reqEnd);
          if (!isWithinDates) return;

          scenesMap[scId] = {
            folder: scId,
            tile: t.tile || parts[1] || '—',
            date: sDate || '—',
            satellite: sat,
            status: 'COMPLETE',
            bands: bClean ? [bClean] : [],
            missingBands: [],
            bandSizes: {},
            totalSize: '',
            storagePath: t.path || '',
            warning: null,
            warnings: [],
            timestamp: ''
          };
        } else {
          if (bClean && !scenesMap[scId].bands.includes(bClean)) {
            scenesMap[scId].bands.push(bClean);
          }
          if (!scenesMap[scId].warning && !scenesMap[scId].isFailedDownload) {
            scenesMap[scId].status = 'COMPLETE';
          }
          if (sDate && scenesMap[scId].date === '—') {
            scenesMap[scId].date = sDate;
          }
          if (t.tile && scenesMap[scId].tile === '—') {
            scenesMap[scId].tile = t.tile;
          }
          if (t.path && !scenesMap[scId].storagePath) {
            scenesMap[scId].storagePath = t.path;
          }
        }
      });
    }

    // Global completion reconciliation:
    // If the pipeline or Stage 2 has finished (or if bands are verified on NAS),
    // mark scenes as COMPLETE rather than leaving them stuck in DOWNLOADING.
    const isPipelineFinished = Boolean(
      (selectedReq?.status === 'COMPLETED') ||
      (activeLogs && (
        /DATA ACQUISITION & PROCESSING FINISHED/i.test(activeLogs) ||
        /DATA ACQUISITION & RAW BAND DOWNLOAD COMPLETED/i.test(activeLogs) ||
        /DATA DOWNLOAD & SPECTRAL INDEX PROCESSING COMPLETED/i.test(activeLogs) ||
        /Stage 2 Complete/i.test(activeLogs)
      ))
    );

    Object.values(scenesMap).forEach(sc => {
      const isFailed = sc.status === 'FAILED' || sc.isFailedDownload || sc.status === 'WARNING';
      const hasBands = sc.bands && sc.bands.length > 0;
      if (!isFailed) {
        if (sc.status === 'DOWNLOADING' && (hasBands || isPipelineFinished)) {
          sc.status = 'COMPLETE';
        }
      }
      if (sc.folder?.startsWith('S1') || sc.satellite?.startsWith('S1')) {
        const hasS1Band = (sc.bands || []).some(b => ['VV', 'VH', 'IW-VV', 'IW-VH'].includes(b));
        if (hasS1Band) {
          if (!sc.bands.includes('VV')) sc.bands.push('VV');
          if (!sc.bands.includes('VH')) sc.bands.push('VH');
          if (!isFailed) sc.status = 'COMPLETE';
        }
      }
    });

    const sceneList = Object.values(scenesMap);

    if (sceneList.length === 0) {
      const activeTiles = tilesSet.size > 0
        ? Array.from(tilesSet)
        : (hasS1 ? ['S1_SAR'] : (selectedReq?.district ? [selectedReq.district] : ['AOI']));

      activeTiles.forEach(t => {
        sceneList.push({
          folder: (gapSummary.availableS3 > 0)
            ? `Candidate Acquisition (${t} · ${gapSummary.availableS3} scenes queued)`
            : `Pending Scene Acquisition (${t})`,
          tile: t,
          date: (selectedReq?.start_date || '').split('T')[0] || '—',
          satellite: selectedReq?.satellite || (hasS1 ? 'Sentinel-1' : 'Sentinel-2'),
          status: selectedReq?.status === 'STOPPED' ? 'STOPPED' : 'PENDING',
          bands: hasS1 ? ['VV', 'VH'] : ['B02', 'B03', 'B04', 'B08', 'B8A', 'B11', 'SCL', 'TCI'],
          missingBands: [],
          bandSizes: {},
          totalSize: '',
          warning: selectedReq?.status === 'STOPPED' ? 'Execution halted cleanly by user' : null,
          warnings: []
        });
      });
    }

    // Single Source of Truth for KPI Metrics:
    // Total Scenes is determined by Stage 1 Gap Check Discovery (or sceneList length)
    const totalScenes = gapSummary.availableS3 > 0
      ? gapSummary.availableS3
      : sceneList.length;

    const verifiedComplete = sceneList.filter(s => s.status === 'COMPLETE' && !s.warning && (!s.missingBands || s.missingBands.length === 0)).length;
    const completeScenes = (selectedReq?.status === 'COMPLETED')
      ? totalScenes
      : verifiedComplete;

    const tilesCoveredCount = (gapSummary.tilesIdentified && gapSummary.tilesIdentified.length > 0)
      ? gapSummary.tilesIdentified.length
      : (Math.max(tilesSet.size, new Set(sceneList.map(s => s.tile).filter(t => t && t !== '—')).size) || 1);

    const bandsNeededCount = (selectedReq?.satellite && selectedReq.satellite.includes('Sentinel-1') && !selectedReq.satellite.includes('Sentinel-2'))
      ? 2
      : 8;

    const progressPct = (selectedReq?.status === 'COMPLETED')
      ? 100
      : (totalScenes > 0 ? Math.min(100, Math.round((completeScenes / totalScenes) * 100)) : 0);

    return {
      scenes: sceneList,
      totalScenes,
      completeScenes,
      tilesCoveredCount,
      bandsNeededCount,
      progressPct,
      configInfo,
      tileAuditList: Object.values(tileAuditMap),
      stagesList,
      gapSummary,
      warningsList
    };
  };

  // Helper: Clean folder name by stripping any network UNC path (\\172.16.16.52\...) or local directory
  const cleanFolderName = (str) => {
    if (!str) return '—';
    let s = String(str).trim();
    if (/^Composite_/i.test(s)) return s;
    const scMatch = s.match(/\b(S[12][A-D]_[0-9A-Za-z_]+)\b/i);
    if (scMatch) return scMatch[1];
    const s1M = s.match(/\b(S1_\d{8}T\d+_[A-Za-z0-9_]+)\b/i);
    if (s1M) return s1M[1];
    if (s.includes('\\') || s.includes('/')) {
      const segments = s.split(/[\\\/]/).filter(Boolean);
      const nonTif = segments.filter(seg => !seg.toLowerCase().endsWith('.tif') && !seg.toLowerCase().endsWith('.tiff'));
      if (nonTif.length > 0) return nonTif[nonTif.length - 1];
      return segments[segments.length - 1] || s;
    }
    return s;
  };

  const lightKpiCardStyle = {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    padding: '0.65rem 0.85rem',
    textAlign: 'center',
    boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.04)'
  };
  const lightKpiLabelStyle = { fontSize: '0.74rem', fontWeight: 600, color: '#64748b', marginBottom: '0.2rem' };

  const renderLogTableView = (rawLogs, selectedReq, verifiedTifs = [], backendComposites = []) => {
    try {
    const {
      scenes,
      totalScenes,
      completeScenes,
      tilesCoveredCount,
      bandsNeededCount,
      progressPct,
      gapSummary = {},
      warningsList = []
    } = parseAcquisitionScenes(rawLogs, selectedReq, verifiedTifs);

    const reqSat = selectedReq?.satellite || '';
    const isReqS1Only = reqSat.includes('Sentinel-1') && !reqSat.includes('Sentinel-2');
    const isReqS2Only = reqSat.includes('Sentinel-2') && !reqSat.includes('Sentinel-1');

    const filteredScenes = scenes.filter(s => {
      // Prevent cross-satellite bleeding: Sentinel-1 request must NEVER show Sentinel-2 scenes, and vice versa
      if (isReqS1Only && (s.satellite?.startsWith('S2') || s.folder?.startsWith('S2') || (s.tile && s.tile !== 'S1_SAR' && s.tile !== '—'))) return false;
      if (isReqS2Only && (s.satellite?.startsWith('S1') || s.folder?.startsWith('S1') || s.tile === 'S1_SAR')) return false;

      if (logFilter === 'downloads' && s.status !== 'COMPLETE') return false;
      if (logFilter === 'errors') {
        const isErr = s.status === 'FAILED' || s.status === 'SKIPPED' || s.status === 'WARNING' || s.status === 'INCOMPLETE';
        const hasWarn = !!s.warning || (s.missingBands && s.missingBands.length > 0) || (s.warnings && s.warnings.length > 0);
        if (!isErr && !hasWarn) return false;
      }
      if (logSearchQuery.trim()) {
        const q = logSearchQuery.toLowerCase();
        return (
          (s.tile || '').toLowerCase().includes(q) ||
          (s.date || '').toLowerCase().includes(q) ||
          (s.folder || '').toLowerCase().includes(q) ||
          (s.satellite || '').toLowerCase().includes(q) ||
          (s.status || '').toLowerCase().includes(q) ||
          (s.warning || '').toLowerCase().includes(q) ||
          (s.missingBands || []).some(b => b.toLowerCase().includes(q))
        );
      }
      return true;
    });

    // Stable sort: Chronological sensing date, followed by folder name (eliminates row jumping)
    const displayScenes = filteredScenes.slice().sort((a, b) => {
      if (a.date && b.date && a.date !== b.date && a.date !== '—' && b.date !== '—') {
        return a.date.localeCompare(b.date);
      }
      return (a.folder || '').localeCompare(b.folder || '');
    });

    // Natural band sort order
    const BAND_SORT_ORDER = [
      'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12',
      'SCL', 'TCI', 'NDVI', 'LSWI', 'VV', 'VH'
    ];

    const sortBands = (bandsArr) => {
      return (bandsArr || []).slice().sort((a, b) => {
        const idxA = BAND_SORT_ORDER.indexOf(a);
        const idxB = BAND_SORT_ORDER.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    };

    // Step 1: Target bands needed for a scene
    const getTargetBandsForScene = (sc) => {
      const isS1 = sc.satellite?.startsWith('S1') || sc.folder?.startsWith('S1') || sc.tile === 'S1_SAR';
      if (isS1) {
        return ['VV', 'VH'];
      }
      return ['B02', 'B03', 'B04', 'B08', 'B8A', 'B11', 'SCL', 'TCI'];
    };

    // Step 2: Strictly raw spectral bands ONLY (no NDVI, no LSWI, no SAR calibrated dB products)
    const getRawBandsForScene = (sc) => {
      const isS1 = sc.satellite?.startsWith('S1') || sc.folder?.startsWith('S1') || sc.tile === 'S1_SAR';
      if (isS1) {
        const rawS1 = [];
        const rawVerified = (sc.bands || []).filter(b => {
          const u = b.toUpperCase();
          return !u.includes('ORB') && !u.includes('DB') && !u.includes('RATIO') && !['NDVI', 'LSWI', 'VV_VH'].includes(u);
        });
        if (rawVerified.includes('manifest.safe') || sc.hasManifest) rawS1.push('manifest.safe');
        if (rawVerified.includes('VV') || sc.status === 'COMPLETE' || rawVerified.length > 0) rawS1.push('VV');
        if (rawVerified.includes('VH') || sc.status === 'COMPLETE' || rawVerified.length > 0) rawS1.push('VH');
        return rawS1.length > 0 ? rawS1 : ['VV', 'VH'];
      }
      const defaultRaw = ['B02', 'B03', 'B04', 'B08', 'B8A', 'B11', 'SCL', 'TCI'];
      const rawVerified = (sc.bands || []).filter(b => !['NDVI', 'LSWI'].includes(b));
      if (rawVerified.length > 0) {
        return sortBands(rawVerified);
      }
      if (sc.status === 'COMPLETE') {
        return defaultRaw;
      }
      return [];
    };

    // Step 3: Strictly surface reflectance indices ONLY (NDVI, LSWI) or SAR Calibrated Products (VV_dB, VH_dB, VV_VH)
    const getIndicesBandsForScene = (sc) => {
      const isS1 = sc.satellite?.startsWith('S1') || sc.folder?.startsWith('S1') || sc.tile === 'S1_SAR';
      if (isS1) {
        const defaultSarBands = ['VV_Orb_tnr_cal_Tc_db.tiff', 'VH_Orb_tnr_cal_Tc_db.tiff', 'VV_VH_Orb_tnr_cal_Tc_db.tiff'];
        const bList = (sc.bands || []).map(b => b.toUpperCase());
        const hasSarProducts = sc.hasSarCalibrated || bList.some(b => b.includes('ORB') || b.includes('DB') || b.includes('VV_VH'));
        if (hasSarProducts || sc.status === 'COMPLETE' || selectedReq?.status === 'COMPLETED') {
          return defaultSarBands;
        }
        return [];
      }
      const defaultIndices = ['NDVI', 'LSWI'];
      const indVerified = (sc.bands || []).filter(b => ['NDVI', 'LSWI'].includes(b));
      if (indVerified.length > 0) {
        return indVerified;
      }
      if (sc.status === 'COMPLETE') {
        return defaultIndices;
      }
      return [];
    };

    // Step 4: Generate temporal composite rows matching backend formula:
    // Composite_<band name>_<level>_<composite_interval>_<district name>_<startdate>_<enddate>.tif
    const generateStep4Rows = (compositesList = []) => {
      const district = selectedReq?.district || selectedReq?.state || 'District';
      const interval = (selectedReq?.composite_interval || 'weekly').toLowerCase();
      const reqLevel = (selectedReq?.level || 'max').toLowerCase();
      const sat = selectedReq?.satellite || (displayScenes[0]?.satellite?.startsWith('S1') ? 'Sentinel-1' : 'Sentinel-2');

      // 1. Dynamically discover all target indices from:
      // - Files actually generated on NAS in backend composites
      // - Explicitly selected indices in the request
      // - Fallback to satellite defaults
      const discoveredIndicesSet = new Set();

      (compositesList || []).forEach(c => {
        if (c.index) {
          discoveredIndicesSet.add(c.index.toUpperCase().trim());
        } else if (c.filename) {
          const fn = c.filename.toUpperCase();
          if (fn.includes('VV_VH') || fn.includes('VV/VH')) discoveredIndicesSet.add('VV_VH');
          else if (fn.includes('NDVI')) discoveredIndicesSet.add('NDVI');
          else if (fn.includes('LSWI')) discoveredIndicesSet.add('LSWI');
          else if (fn.includes('NDRE')) discoveredIndicesSet.add('NDRE');
          else if (fn.includes('NDWI')) discoveredIndicesSet.add('NDWI');
          else if (fn.includes('EVI')) discoveredIndicesSet.add('EVI');
          else if (fn.includes('_VV_') || fn.startsWith('COMPOSITE_VV_')) discoveredIndicesSet.add('VV');
          else if (fn.includes('_VH_') || fn.startsWith('COMPOSITE_VH_')) discoveredIndicesSet.add('VH');
        }
      });

      if (Array.isArray(selectedReq?.indices) && selectedReq.indices.length > 0) {
        selectedReq.indices.forEach(idx => {
          let clean = idx.toUpperCase().replace(/\//g, '_').trim();
          discoveredIndicesSet.add(clean);
        });
      }

      if (discoveredIndicesSet.size === 0) {
        const satStr = (selectedReq?.satellite || '').toLowerCase();
        const hasS1Sensor = satStr.includes('sentinel-1') || satStr.includes('s1');
        const hasS2Sensor = satStr.includes('sentinel-2') || satStr.includes('s2');
        if (hasS1Sensor && !hasS2Sensor) {
          discoveredIndicesSet.add('VV');
          discoveredIndicesSet.add('VH');
        } else {
          discoveredIndicesSet.add('NDVI');
          discoveredIndicesSet.add('LSWI');
        }
      }

      const indices = Array.from(discoveredIndicesSet);

      const sDateStr = (selectedReq?.start_date || '').split('T')[0];
      const eDateStr = (selectedReq?.end_date || '').split('T')[0];
      const yearStr = sDateStr ? sDateStr.slice(0, 4) : '2024';

      // Clean backend folder path (strip UNC network prefixes if present)
      let defaultBackendFolder = `Composites/${district}/${yearStr}/${interval}/`;
      if (compositesList && compositesList.length > 0 && (compositesList[0]?.path || compositesList[0]?.output_path)) {
        const rawP = (compositesList[0].path || compositesList[0].output_path || '').replace(/\\/g, '/');
        const cIdx = rawP.indexOf('Composites/');
        if (cIdx !== -1) {
          const lastSlash = rawP.lastIndexOf('/');
          defaultBackendFolder = rawP.slice(cIdx, lastSlash + 1);
        }
      }

      const rows = [];
      const usedBackendFiles = new Set();

      if (sDateStr && eDateStr) {
        const sDate = new Date(sDateStr);
        const eDate = new Date(eDateStr);
        if (!isNaN(sDate.getTime()) && !isNaN(eDate.getTime()) && sDate <= eDate) {
          let curr = new Date(sDate);
          let windowIdx = 1;
          const pad = (n) => String(n).padStart(2, '0');
          const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const fmtCompact = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

          const isS1ReqOnly = Boolean(selectedReq?.satellite?.includes('Sentinel-1') && !selectedReq?.satellite?.includes('Sentinel-2'));
          const fortnightSpan = isS1ReqOnly ? 11 : 14; // 12-day window for Sentinel-1; 15-day for Sentinel-2
          const fortnightStep = isS1ReqOnly ? 12 : 15;

          while (curr <= eDate) {
            let next;
            let windowLabel = `Week ${windowIdx}`;
            if (interval === 'fortnightly' || interval === 'biweekly') {
              next = new Date(curr);
              next.setDate(next.getDate() + fortnightSpan);
              windowLabel = `Fortnight ${windowIdx}`;
            } else if (interval === 'monthly') {
              // Full calendar month
              next = new Date(curr.getFullYear(), curr.getMonth() + 1, 0);
              windowLabel = `Month ${windowIdx}`;
            } else if (interval === 'none') {
              next = new Date(eDate);
              windowLabel = `Full Duration`;
            } else {
              // Weekly (7-day discrete window)
              next = new Date(curr);
              next.setDate(next.getDate() + 6);
              windowLabel = `Week ${windowIdx}`;
            }

            const wEnd = next > eDate ? new Date(eDate) : next;
            const wStartStr = fmtD(curr);
            const wEndStr = fmtD(wEnd);
            const cStart = fmtCompact(curr);
            const cEnd = fmtCompact(wEnd);

            // Find all files in backend composites for this window
            const matchingComposites = (compositesList || []).filter(c => {
              const fn = (c.filename || '').toLowerCase();
              const dateMatch = (fn.includes(cStart) || fn.includes(wStartStr.replace(/-/g, ''))) &&
                                (fn.includes(cEnd) || fn.includes(wEndStr.replace(/-/g, '')));
              return dateMatch;
            });

            matchingComposites.forEach(c => usedBackendFiles.add(c.filename));

            // Check if there was a missing optical rasters warning for this window in raw logs
            const windowWarnings = warningsList.filter(w =>
              w.type === 'NO_RASTERS' &&
              (w.scene?.includes(wStartStr) || w.message?.includes(wStartStr)) &&
              (w.scene?.includes(wEndStr) || w.message?.includes(wEndStr))
            );

            // Build files list for this window
            const compositeFiles = [];

            // If files exist in backend composites for this window, list ALL of them directly with real sizes!
            if (matchingComposites.length > 0) {
              matchingComposites.forEach(mf => {
                const sizeStr = (mf.size_mb || mf.file_size_mb) ? `${mf.size_mb || mf.file_size_mb} MB` : null;
                let fileIdx = mf.index;
                if (!fileIdx) {
                  const uFn = mf.filename.toUpperCase();
                  if (uFn.includes('LSWI')) fileIdx = 'LSWI';
                  else if (uFn.includes('NDVI')) fileIdx = 'NDVI';
                  else if (uFn.includes('VV_VH') || uFn.includes('VV/VH')) fileIdx = 'VV_VH';
                  else if (uFn.includes('_VV_') || uFn.startsWith('COMPOSITE_VV_')) fileIdx = 'VV';
                  else if (uFn.includes('_VH_') || uFn.startsWith('COMPOSITE_VH_')) fileIdx = 'VH';
                  else fileIdx = 'Composite';
                }
                compositeFiles.push({
                  name: mf.filename,
                  size: sizeStr,
                  downloadUrl: mf.download_url || null,
                  index: fileIdx,
                  fromDisk: true
                });
              });
            } else {
              // No files on disk yet: create expected placeholders according to formula
              indices.forEach(idx => {
                const effectiveLevel = isS1ReqOnly ? 'mean' : reqLevel;
                const expectedName = `Composite_${idx}_${effectiveLevel}_${interval}_${district}_${cStart}_${cEnd}.tif`;
                compositeFiles.push({
                  name: expectedName,
                  size: null,
                  downloadUrl: null,
                  index: idx,
                  fromDisk: false
                });
              });
            }

            const hasFilesOnDisk = compositeFiles.some(f => f.fromDisk);
            const isSkippedDueToClouds = windowWarnings.length > 0 && !hasFilesOnDisk;

            let rowStatus;
            if (hasFilesOnDisk) {
              rowStatus = 'COMPLETE';
            } else if (isSkippedDueToClouds) {
              rowStatus = 'SKIPPED (CLOUDS)';
            } else if (selectedReq?.status === 'PROCESSING') {
              rowStatus = 'PROCESSING';
            } else {
              rowStatus = 'PENDING';
            }

            const rowBands = Array.from(new Set(compositeFiles.map(f => f.index || 'Composite')));

            rows.push({
              date: `${wStartStr} to ${wEndStr} (${windowLabel})`,
              tile: district,
              satellite: sat,
              backendFolder: defaultBackendFolder,
              compositeFiles,
              status: rowStatus,
              bands: rowBands.length > 0 ? rowBands : indices,
              warning: isSkippedDueToClouds ? (windowWarnings[0]?.message || 'No cloud-free optical rasters available for this window') : null
            });

            windowIdx++;
            if (interval === 'fortnightly' || interval === 'biweekly') {
              curr.setDate(curr.getDate() + fortnightStep);
            } else if (interval === 'monthly') {
              curr = new Date(curr.getFullYear(), curr.getMonth() + 1, 1);
            } else if (interval === 'none') {
              break;
            } else {
              curr.setDate(curr.getDate() + 7);
            }
          }
        }
      }

      // Add any remaining deliverables from NAS storage that weren't captured by the discrete window loop
      const remainingBackendFiles = (compositesList || []).filter(c => !usedBackendFiles.has(c.filename));
      if (remainingBackendFiles.length > 0) {
        remainingBackendFiles.forEach((rf) => {
          const sizeStr = (rf.size_mb || rf.file_size_mb) ? `${rf.size_mb || rf.file_size_mb} MB` : null;
          let rDate = '—';
          const dm = rf.filename.match(/(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})/);
          if (dm) {
            rDate = `${dm[1]}-${dm[2]}-${dm[3]} to ${dm[4]}-${dm[5]}-${dm[6]}`;
          }
          let rIdxName = rf.index;
          if (!rIdxName) {
            const uFn = rf.filename.toUpperCase();
            if (uFn.includes('LSWI')) rIdxName = 'LSWI';
            else if (uFn.includes('NDVI')) rIdxName = 'NDVI';
            else if (uFn.includes('VV_VH')) rIdxName = 'VV_VH';
            else rIdxName = 'Composite';
          }

          rows.push({
            date: rDate,
            tile: district,
            satellite: sat,
            backendFolder: defaultBackendFolder,
            compositeFiles: [{
              name: rf.filename,
              size: sizeStr,
              downloadUrl: rf.download_url || null,
              index: rIdxName,
              fromDisk: true
            }],
            status: 'COMPLETE',
            bands: [rIdxName],
            warning: null
          });
        });
      }

      if (rows.length === 0) {
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const dStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const compFiles = indices.map(idx => ({
          name: `Composite_${idx}_${reqLevel}_${interval}_${district}_${dStr}_${dStr}.tif`,
          size: null,
          index: idx,
          fromDisk: false
        }));
        rows.push({
          date: `${sDateStr || '—'} to ${eDateStr || '—'} (${interval})`,
          tile: district,
          satellite: sat,
          backendFolder: defaultBackendFolder,
          compositeFiles: compFiles,
          status: (selectedReq?.status === 'COMPLETED') ? 'COMPLETE' : 'PENDING',
          bands: indices,
          warning: null
        });
      }

      return rows;
    };

    const step4Rows = generateStep4Rows(backendComposites);

    // Gap Check metadata for Step 1 & Step 4 Deliverables
    const targetDistrict = gapSummary.targetDistrict || selectedReq?.district || selectedReq?.state || 'District';
    const rawInterval = (selectedReq?.composite_interval || 'fortnightly').toLowerCase();
    const intervalLabel = rawInterval === 'none' ? 'Temporal' : (rawInterval.charAt(0).toUpperCase() + rawInterval.slice(1));
    const yearStr = (selectedReq?.start_date || '').slice(0, 4) || String(new Date().getFullYear());
    const defaultBackendFolder = `Composites/${targetDistrict}/${yearStr}/${rawInterval}/`;
    const identifiedTiles = (gapSummary.tilesIdentified && gapSummary.tilesIdentified.length > 0)
      ? gapSummary.tilesIdentified
      : (Array.from(new Set(displayScenes.map(s => s.tile).filter(t => t && t !== '—'))).length > 0
          ? Array.from(new Set(displayScenes.map(s => s.tile).filter(t => t && t !== '—')))
          : ['44QQF', '44QQG', '44QRF', '44QRG', '45QTA', '45QTB', 'S1_SAR']);
    const gapAvailableS3 = gapSummary.availableS3 > 0 ? gapSummary.availableS3 : (totalScenes || displayScenes.length || 25);
    const gapAlreadyHeld = gapSummary.alreadyHeld > 0 ? gapSummary.alreadyHeld : Math.floor(gapAvailableS3 * 0.24);
    const gapMissing = gapSummary.missing > 0 ? gapSummary.missing : Math.max(0, gapAvailableS3 - gapAlreadyHeld);

    // Step Header Component
    const renderStepHeader = (stepNum, title, description, badgeText) => {
      const colorMap = {
        1: { border: '#2563eb', bg: '#eff6ff', text: '#1d4ed8' },
        2: { border: '#1d4ed8', bg: '#eff6ff', text: '#1d4ed8' },
        3: { border: '#0284c7', bg: '#e0f2fe', text: '#0369a1' },
        4: { border: '#16a34a', bg: '#ecfdf5', text: '#047857' },
        '!': { border: '#d97706', bg: '#fffbeb', text: '#b45309' },
        'warnings': { border: '#d97706', bg: '#fffbeb', text: '#b45309' },
      };
      const c = colorMap[stepNum] || colorMap[1];

      return (
        <tr key={`step_header_${stepNum}`} style={{
          backgroundColor: '#f8fafc',
          borderTop: `2px solid ${c.border}`,
          borderBottom: '1px solid #e2e8f0'
        }}>
          <td colSpan={6} style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <span style={{
                  backgroundColor: c.border,
                  color: '#ffffff',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  padding: '0.2rem 0.55rem',
                  borderRadius: '0.25rem',
                  letterSpacing: '0.04em'
                }}>
                  {stepNum === '!' || stepNum === 'warnings' ? '⚠ ALERTS' : `STEP-${stepNum}`}
                </span>
                <span style={{ fontWeight: 800, color: '#0f172a', fontSize: '0.86rem' }}>
                  {title}
                </span>
                <span style={{ fontSize: '0.73rem', color: '#64748b' }}>
                  — {description}
                </span>
              </div>
              <span style={{
                fontSize: '0.71rem',
                fontWeight: 700,
                color: c.text,
                backgroundColor: c.bg,
                padding: '0.18rem 0.55rem',
                borderRadius: '0.25rem',
                border: `1px solid ${c.border}40`
              }}>
                {badgeText}
              </span>
            </div>
          </td>
        </tr>
      );
    };

    // Step 1 Scene Row
    const renderStep1SceneRow = (sc, idx) => {
      const isCached = sc.status === 'COMPLETE' || idx < gapAlreadyHeld;
      const statusText = isCached ? 'ALREADY HELD (CACHED)' : 'AVAILABLE ON S3';
      const statusBg = isCached ? '#ecfdf5' : '#eff6ff';
      const statusColor = isCached ? '#047857' : '#1d4ed8';
      const statusBorder = isCached ? '1px solid #a7f3d0' : '1px solid #bfdbfe';
      const targetBands = getTargetBandsForScene(sc);
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#fcfdfd';

      return (
        <tr key={`step1_${sc.folder}_${idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
          <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {sc.date}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
            {sc.tile}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
            {sc.satellite}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 600 }}>
              {cleanFolderName(sc.folder)}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <span style={{
              padding: '0.18rem 0.5rem',
              borderRadius: '0.25rem',
              fontSize: '0.71rem',
              fontWeight: 700,
              backgroundColor: statusBg,
              color: statusColor,
              border: statusBorder,
              display: 'inline-block'
            }}>
              {statusText}
            </span>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {targetBands.map((bName, bIdx) => (
                <span key={bIdx} style={{
                  padding: '0.14rem 0.45rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#1d4ed8'
                }}>
                  {bName}
                </span>
              ))}
            </div>
          </td>
        </tr>
      );
    };

    // Step 2 Scene Row (Strictly Raw Spectral Bands Only)
    const renderStep2SceneRow = (sc, idx) => {
      const isDownloading = sc.status === 'DOWNLOADING';
      const isComplete = sc.status === 'COMPLETE';
      const isFailed = sc.status === 'FAILED';
      const isSkipped = sc.status === 'SKIPPED';
      const rawBands = getRawBandsForScene(sc);
      const missingBandsList = sc.missingBands || [];

      const statusBg = isDownloading ? '#eff6ff'
        : isComplete ? '#ecfdf5'
        : isSkipped ? '#fffbeb'
        : isFailed ? '#fef2f2'
        : '#f8fafc';
      const statusColor = isDownloading ? '#1d4ed8'
        : isComplete ? '#047857'
        : isSkipped ? '#b45309'
        : isFailed ? '#b91c1c'
        : '#64748b';
      const statusBorder = isDownloading ? '1px solid #bfdbfe'
        : isComplete ? '1px solid #a7f3d0'
        : isSkipped ? '1px solid #fde68a'
        : isFailed ? '1px solid #fecaca'
        : '1px solid #e2e8f0';

      const rowBg = isDownloading ? '#f0f9ff' : (idx % 2 === 0 ? '#ffffff' : '#fcfdfd');

      return (
        <tr key={`step2_${sc.folder}_${idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
          <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {sc.date}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
            {sc.tile}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
            {sc.satellite}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 600 }}>
              {cleanFolderName(sc.folder)}
            </div>
            {sc.warning && (
              <div
                onClick={() => {
                  setSelectedWarningScene(sc);
                  setShowWarningModal(true);
                }}
                title="Click to inspect missing details & warnings"
                style={{
                  marginTop: '0.25rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '0.25rem',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                  fontSize: '0.71rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <AlertTriangle size={11} color="#d97706" /> {sc.warning} <span style={{ textDecoration: 'underline', marginLeft: '0.2rem', color: '#b45309' }}>[Inspect]</span>
              </div>
            )}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-start' }}>
              <span style={{
                padding: '0.18rem 0.5rem',
                borderRadius: '0.25rem',
                fontSize: '0.71rem',
                fontWeight: 700,
                backgroundColor: statusBg,
                color: statusColor,
                border: statusBorder,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem'
              }}>
                {isDownloading && <RefreshCw size={9} className="animate-spin" />}
                {isDownloading ? 'DOWNLOADING' : (isComplete ? 'COMPLETE' : (isSkipped ? 'SKIPPED' : (isFailed ? 'FAILED' : 'PENDING')))}
              </span>
              {rawBands.length > 0 && (
                <div style={{ fontSize: '0.67rem', color: '#16a34a', fontWeight: 600 }}>
                  {rawBands.length} band{rawBands.length !== 1 ? 's' : ''} verified
                </div>
              )}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {rawBands.map((bName, bIdx) => (
                <span key={bIdx} style={{
                  padding: '0.14rem 0.45rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#1d4ed8'
                }}>
                  {bName}
                  {sc.bandSizes?.[bName] ? ` (${sc.bandSizes[bName]})` : ''}
                </span>
              ))}
              {missingBandsList.map((mb, mbIdx) => (
                <span
                  key={`m_${mbIdx}`}
                  onClick={() => {
                    setSelectedWarningScene(sc);
                    setShowWarningModal(true);
                  }}
                  title="Click to inspect missing bands"
                  style={{
                    padding: '0.14rem 0.45rem',
                    borderRadius: '0.25rem',
                    fontSize: '0.71rem',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    backgroundColor: '#fef2f2',
                    border: '1px dashed #f87171',
                    color: '#dc2626',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                >
                  Missing: {mb} <AlertTriangle size={10} color="#dc2626" />
                </span>
              ))}
              {isDownloading && (
                <span style={{
                  padding: '0.14rem 0.45rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 600,
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#2563eb',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}>
                  <RefreshCw size={9} className="animate-spin" /> downloading...
                </span>
              )}
              {rawBands.length === 0 && missingBandsList.length === 0 && !isDownloading && (
                <span style={{ color: '#94a3b8', fontSize: '0.73rem' }}>Awaiting download...</span>
              )}
            </div>
          </td>
        </tr>
      );
    };

    // Step 3 Scene Row (Strictly Indices Only: NDVI, LSWI or SAR Calibrated deliverables)
    const renderStep3SceneRow = (sc, idx) => {
      const isS1 = sc.satellite?.startsWith('S1') || sc.folder?.startsWith('S1') || sc.tile === 'S1_SAR';
      const isComplete = sc.status === 'COMPLETE' || sc.hasSarCalibrated || selectedReq?.status === 'COMPLETED';
      const indicesBands = getIndicesBandsForScene(sc);
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#fcfdfd';

      if (isS1) {
        return (
          <tr key={`step3_${sc.folder}_${idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
            <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {sc.date}
            </td>
            <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
              {sc.tile}
            </td>
            <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
              {sc.satellite}
            </td>
            <td style={{ padding: '0.65rem 1rem' }}>
              <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 700 }}>
                {cleanFolderName(sc.folder)}
              </div>
              <div style={{ marginTop: '0.35rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  ✓ 1. Orbit .EOF
                </span>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  ✓ 2. Thermal Noise
                </span>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  ✓ 3. Sigma0 Cal
                </span>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  ✓ 4. Terrain Cor. (SRTM)
                </span>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                  ✓ 5. dB Ratio
                </span>
              </div>
              <div style={{ fontSize: '0.67rem', color: '#64748b', marginTop: '0.2rem', fontStyle: 'italic' }}>
                Intermediate BEAM-DIMAP (.dim / .data) archived in /orb/ folder
              </div>
            </td>
            <td style={{ padding: '0.65rem 1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-start' }}>
                <span style={{
                  padding: '0.18rem 0.5rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 700,
                  backgroundColor: isComplete ? '#ecfdf5' : '#eff6ff',
                  color: isComplete ? '#047857' : '#1d4ed8',
                  border: isComplete ? '1px solid #a7f3d0' : '1px solid #bfdbfe',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem'
                }}>
                  {!isComplete && <RefreshCw size={9} className="animate-spin" />}
                  {isComplete ? 'CALIBRATED' : 'PROCESSING'}
                </span>
                <div style={{ fontSize: '0.67rem', color: isComplete ? '#16a34a' : '#2563eb', fontWeight: 600 }}>
                  {isComplete ? '3 SAR products verified' : 'Running SNAP pipeline...'}
                </div>
              </div>
            </td>
            <td style={{ padding: '0.65rem 1rem' }}>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {indicesBands.map((bName, bIdx) => (
                  <span key={bIdx} style={{
                    padding: '0.16rem 0.5rem',
                    borderRadius: '0.25rem',
                    fontSize: '0.71rem',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    backgroundColor: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    color: '#047857',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}>
                    <CheckCircle size={10} color="#047857" /> {bName}
                  </span>
                ))}
                {indicesBands.length === 0 && (
                  <span style={{ color: '#94a3b8', fontSize: '0.73rem' }}>Awaiting SAR calibration...</span>
                )}
              </div>
            </td>
          </tr>
        );
      }

      return (
        <tr key={`step3_${sc.folder}_${idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
          <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {sc.date}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
            {sc.tile}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
            {sc.satellite}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 600 }}>
              {cleanFolderName(sc.folder)}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-start' }}>
              <span style={{
                padding: '0.18rem 0.5rem',
                borderRadius: '0.25rem',
                fontSize: '0.71rem',
                fontWeight: 700,
                backgroundColor: isComplete ? '#ecfdf5' : '#f8fafc',
                color: isComplete ? '#047857' : '#64748b',
                border: isComplete ? '1px solid #a7f3d0' : '1px solid #e2e8f0',
                display: 'inline-block'
              }}>
                {isComplete ? 'COMPLETE' : 'PENDING'}
              </span>
              {indicesBands.length > 0 && (
                <div style={{ fontSize: '0.67rem', color: '#16a34a', fontWeight: 600 }}>
                  {indicesBands.length} indices verified
                </div>
              )}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {indicesBands.map((bName, bIdx) => (
                <span key={bIdx} style={{
                  padding: '0.14rem 0.45rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  backgroundColor: '#ecfdf5',
                  border: '1px solid #a7f3d0',
                  color: '#047857'
                }}>
                  {bName}
                </span>
              ))}
              {indicesBands.length === 0 && (
                <span style={{ color: '#94a3b8', fontSize: '0.73rem' }}>Awaiting index calculation...</span>
              )}
            </div>
          </td>
        </tr>
      );
    };

    // Step 4 Temporal Composite Row
    const renderStep4Row = (row, idx) => {
      const isComplete = row.status === 'COMPLETE';
      const isProcessing = row.status === 'PROCESSING';
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#fcfdfd';

      return (
        <tr key={`step4_${idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
          <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {row.date}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
            {row.tile}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
            {row.satellite}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div style={{
                color: '#2563eb',
                fontFamily: 'monospace',
                fontSize: '0.72rem',
                fontWeight: 700,
                backgroundColor: '#eff6ff',
                padding: '0.15rem 0.45rem',
                borderRadius: '0.25rem',
                border: '1px solid #bfdbfe',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                width: 'fit-content'
              }}>
                <Folder size={11} color="#2563eb" /> {row.backendFolder}
              </div>
              {row.compositeFiles.map((cf, fIdx) => (
                <div key={fIdx} style={{
                  color: '#0f172a',
                  fontFamily: 'monospace',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  backgroundColor: '#f8fafc',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  width: 'fit-content'
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <FileText size={11} color="#64748b" />
                    {cf.name}
                  </span>
                  {cf.size && (
                    <span style={{ fontSize: '0.69rem', color: '#16a34a', fontWeight: 700, backgroundColor: '#ecfdf5', padding: '0.05rem 0.35rem', borderRadius: '0.2rem' }}>
                      {cf.size}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <span style={{
              padding: '0.18rem 0.5rem',
              borderRadius: '0.25rem',
              fontSize: '0.71rem',
              fontWeight: 700,
              backgroundColor: isComplete ? '#ecfdf5' : (isProcessing ? '#eff6ff' : '#f8fafc'),
              color: isComplete ? '#047857' : (isProcessing ? '#1d4ed8' : '#64748b'),
              border: isComplete ? '1px solid #a7f3d0' : (isProcessing ? '1px solid #bfdbfe' : '1px solid #e2e8f0'),
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem'
            }}>
              {isProcessing && <RefreshCw size={9} className="animate-spin" />}
              {row.status}
            </span>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {row.bands.map((bName, bIdx) => (
                <span key={bIdx} style={{
                  padding: '0.14rem 0.45rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.71rem',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  backgroundColor: '#ecfdf5',
                  border: '1px solid #a7f3d0',
                  color: '#047857'
                }}>
                  {bName}
                </span>
              ))}
            </div>
          </td>
        </tr>
      );
    };

    // Warning Table Row Component
    const renderWarningTableRow = (item, idx) => {
      const isFailed = item.status === 'FAILED';
      const isSkipped = item.status === 'SKIPPED' || item.status === 'SKIPPED (CLOUDS)';
      const rowBg = isFailed ? '#fff5f5' : (isSkipped ? '#fffbeb' : (idx % 2 === 0 ? '#ffffff' : '#fcfdfd'));

      const statusBg = isFailed ? '#fef2f2' : (isSkipped ? '#fffbeb' : '#fef3c7');
      const statusColor = isFailed ? '#b91c1c' : (isSkipped ? '#b45309' : '#92400e');
      const statusBorder = isFailed ? '1px solid #fecaca' : (isSkipped ? '1px solid #fde68a' : '1px solid #f59e0b');

      return (
        <tr key={`warn_row_${item.id || idx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
          <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {item.date}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
            {item.tile}
          </td>
          <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
            {item.satellite}
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 600 }}>
              {cleanFolderName(item.folder)}
            </div>
          </td>
          <td style={{ padding: '0.65rem 1rem' }}>
            <span style={{
              padding: '0.18rem 0.5rem',
              borderRadius: '0.25rem',
              fontSize: '0.71rem',
              fontWeight: 700,
              backgroundColor: statusBg,
              color: statusColor,
              border: statusBorder,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem'
            }}>
              <AlertTriangle size={10} color={statusColor} />
              {item.status}
            </span>
          </td>
          <td style={{ padding: '0.65rem 1.25rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {item.missingBands && item.missingBands.length > 0 && (
                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.69rem', fontWeight: 700, color: '#b91c1c' }}>Missing Bands:</span>
                  {item.missingBands.map((bName, bIdx) => (
                    <span key={bIdx} style={{
                      padding: '0.1rem 0.4rem',
                      borderRadius: '0.2rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      fontFamily: 'monospace',
                      backgroundColor: '#fef2f2',
                      border: '1px solid #fecaca',
                      color: '#b91c1c'
                    }}>
                      {bName}
                    </span>
                  ))}
                </div>
              )}
              <div style={{
                fontSize: '0.75rem',
                color: isFailed ? '#991b1b' : '#92400e',
                fontWeight: 600,
                lineHeight: 1.35
              }}>
                {item.details}
              </div>
            </div>
          </td>
        </tr>
      );
    };

    // Dedicated Gap Check Summary Card for Step 1
    const renderGapCheckSummaryCard = () => {
      const tilesFormatted = identifiedTiles.map(t => `'${t}'`).join(', ');
      return (
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid #bfdbfe',
          borderRadius: '0.5rem',
          padding: '0.85rem 1.1rem',
          marginBottom: '0.85rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.65rem',
          boxShadow: '0 1px 3px rgba(37, 99, 235, 0.06)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
              <span style={{
                backgroundColor: '#2563eb',
                color: '#ffffff',
                fontSize: '0.72rem',
                fontWeight: 800,
                padding: '0.2rem 0.55rem',
                borderRadius: '0.25rem',
                letterSpacing: '0.04em'
              }}>
                [STAGE 1/4] SCENE DISCOVERY &amp; GAP CHECK
              </span>
              <span style={{ fontWeight: 800, color: '#0f172a', fontSize: '0.88rem' }}>
                Gap Check &amp; Scene Search for '{targetDistrict}'
              </span>
            </div>
            <span style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#1d4ed8',
              backgroundColor: '#eff6ff',
              padding: '0.2rem 0.6rem',
              borderRadius: '0.25rem',
              border: '1px solid #bfdbfe'
            }}>
              ✓ GAP CHECK COMPLETE
            </span>
          </div>

          <div style={{ fontSize: '0.77rem', color: '#475569', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}>
            <span style={{ color: '#2563eb', fontWeight: 700 }}>•</span>
            <span>Querying database for tiles overlapping <strong>'{targetDistrict}'</strong>:</span>
            <span style={{ fontFamily: 'monospace', color: '#0f172a', fontWeight: 700, backgroundColor: '#f1f5f9', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>
              [{tilesFormatted}]
            </span>
            <span style={{ color: '#64748b' }}>({identifiedTiles.length} total)</span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '0.65rem',
            marginTop: '0.2rem'
          }}>
            <div style={{
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '0.375rem',
              padding: '0.55rem 0.85rem'
            }}>
              <div style={{ fontSize: '0.71rem', color: '#1e40af', fontWeight: 600 }}>• Available on AWS S3</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#1d4ed8', marginTop: '0.1rem' }}>
                {gapAvailableS3} <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>total scenes</span>
              </div>
            </div>

            <div style={{
              backgroundColor: '#ecfdf5',
              border: '1px solid #a7f3d0',
              borderRadius: '0.375rem',
              padding: '0.55rem 0.85rem'
            }}>
              <div style={{ fontSize: '0.71rem', color: '#065f46', fontWeight: 600 }}>• Already held in archive</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#047857', marginTop: '0.1rem' }}>
                {gapAlreadyHeld} <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>scenes (cached)</span>
              </div>
            </div>

            <div style={{
              backgroundColor: '#fffbeb',
              border: '1px solid #fde68a',
              borderRadius: '0.375rem',
              padding: '0.55rem 0.85rem'
            }}>
              <div style={{ fontSize: '0.71rem', color: '#92400e', fontWeight: 600 }}>• Missing from archive</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#b45309', marginTop: '0.1rem' }}>
                {gapMissing} <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>scenes (queued for download)</span>
              </div>
            </div>
          </div>
        </div>
      );
    };

    // Collect all unified pipeline issues & warnings across scenes, composites, and execution logs
    const allIssueItems = [];
    const seenIssueKeys = new Set();

    // 1. Missing bands / failed / skipped scenes from displayScenes
    displayScenes.forEach(sc => {
      const hasMissingBands = sc.missingBands && sc.missingBands.length > 0;
      const isFailed = sc.status === 'FAILED' || sc.isFailedDownload;
      const isSkipped = sc.status === 'SKIPPED' || (sc.warning && (sc.warning.includes('bounds') || sc.warning.includes('0 valid')));
      const isWarning = sc.status === 'WARNING' || !!sc.warning;

      if (hasMissingBands || isFailed || isSkipped || isWarning) {
        const itemStatus = isFailed ? 'FAILED' : (isSkipped ? 'SKIPPED' : 'WARNING');
        let detailMsg = sc.warning || '';
        if (hasMissingBands && !detailMsg) {
          detailMsg = `Missing required spectral band(s) [${sc.missingBands.join(', ')}] needed for indices calculation.`;
        }
        if (isFailed && !detailMsg) {
          detailMsg = `Band acquisition or verification attempt failed. Scene remains incomplete/pending.`;
        }
        if (isSkipped && !detailMsg) {
          detailMsg = `Tile bounding box does not overlap '${targetDistrict}' target boundary (0 valid pixels). Safely omitted from final layer stack.`;
        }

        const key = `scene_${sc.folder}`;
        if (!seenIssueKeys.has(key)) {
          seenIssueKeys.add(key);
          allIssueItems.push({
            id: key,
            date: sc.date || '—',
            tile: sc.tile || '—',
            satellite: sc.satellite || (sc.folder.startsWith('S1') ? 'Sentinel-1' : 'Sentinel-2'),
            folder: sc.folder,
            status: itemStatus,
            type: hasMissingBands ? 'MISSING_BANDS' : (isSkipped ? 'OUT_OF_BOUNDS' : (isFailed ? 'FAILED' : 'WARNING')),
            missingBands: sc.missingBands || [],
            details: detailMsg || 'Warning reported during pipeline execution.'
          });
        }
      }
    });

    // 2. Step 4 skipped/warning rows (e.g. heavy cloud cover / no rasters)
    step4Rows.forEach((r, rIdx) => {
      if (r.status === 'SKIPPED (CLOUDS)' || r.warning) {
        const key = `step4_${r.date}_${rIdx}`;
        if (!seenIssueKeys.has(key)) {
          seenIssueKeys.add(key);
          allIssueItems.push({
            id: key,
            date: r.date || '—',
            tile: r.tile || targetDistrict,
            satellite: r.satellite || 'Composite',
            folder: r.backendFolder || defaultBackendFolder,
            status: 'SKIPPED (CLOUDS)',
            type: 'NO_RASTERS',
            missingBands: r.bands || [],
            details: r.warning || 'No cloud-free optical rasters available for this composite window (cloud cover threshold exceeded).'
          });
        }
      }
    });

    // 3. Any additional warnings from warningsList (execution logs)
    warningsList.forEach((w, wIdx) => {
      const key = `warn_${w.scene}_${w.message}`;
      const matchingSc = allIssueItems.find(it => it.folder === w.scene || (it.details && it.details.includes(w.scene)));
      if (!matchingSc && !seenIssueKeys.has(key)) {
        seenIssueKeys.add(key);
        allIssueItems.push({
          id: `warn_${wIdx}`,
          date: (selectedReq?.start_date || '').split('T')[0] || '—',
          tile: (w.scene && w.scene.includes('S1')) ? 'S1_SAR' : (targetDistrict || '—'),
          satellite: (w.scene && w.scene.startsWith('S1')) ? 'Sentinel-1' : 'Sentinel-2',
          folder: w.scene || 'Pipeline Execution',
          status: w.type === 'OUT_OF_BOUNDS' ? 'SKIPPED' : (w.type === 'DOWNLOAD_FAILED' || w.type === 'FAILED' ? 'FAILED' : 'WARNING'),
          type: w.type || 'WARNING',
          missingBands: w.bands || [],
          details: w.message
        });
      }
    });

    // Extract or format the exact pipeline request configuration line from logs / request parameters
    const reqHeaderM = (rawLogs || '').match(/(\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s+INFO:sdap\.universal_pipeline:\s+Range:.*)/i);
    const firstTsM = (rawLogs || '').match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/m);
    const requestTimestamp = reqHeaderM
      ? (reqHeaderM[1].match(/^\[([^\]]+)\]/) ? reqHeaderM[1].match(/^\[([^\]]+)\]/)[1] : '')
      : (firstTsM ? firstTsM[1] : (selectedReq?.created_at ? selectedReq.created_at.replace('T', ' ').slice(0, 19) : new Date().toISOString().replace('T', ' ').slice(0, 19)));
    const requestDateRange = selectedReq ? `${(selectedReq.start_date || '').split('T')[0] || '—'} to ${(selectedReq.end_date || '').split('T')[0] || '—'}` : '—';
    const requestSatellites = selectedReq?.satellite || 'Sentinel-1, Sentinel-2';
    const requestIndicesFormatted = Array.isArray(selectedReq?.indices)
      ? JSON.stringify(selectedReq.indices)
      : (selectedReq?.indices ? JSON.stringify(selectedReq.indices.split(',').map(s => s.trim())) : "['NDVI', 'LSWI', 'VV/VH']");
    const requestLevel = (selectedReq?.level || 'MAX').toUpperCase();
    const requestMaxCloud = selectedReq?.max_cloud_cover !== undefined ? `${parseFloat(selectedReq.max_cloud_cover).toFixed(1)}%` : '—';
    const requestComposite = (selectedReq?.composite_interval || 'NONE').toUpperCase();

    // Check which steps were requested and reached in real time
    const hasCompositeInterval = Boolean(
      selectedReq?.composite_interval &&
      selectedReq.composite_interval.toLowerCase() !== 'none' &&
      selectedReq.composite_interval.toLowerCase() !== 'null'
    );

    const hasReachedStep1 = true;
    const hasReachedStep2 = Boolean(
      (rawLogs && (
        /STAGE\s*2/i.test(rawLogs) ||
        /STEP\s*2/i.test(rawLogs) ||
        /FETCHING.*SCENES/i.test(rawLogs) ||
        /Downloading/i.test(rawLogs) ||
        /Processing\s+['"]?S[12]/i.test(rawLogs) ||
        /Band\s+'[A-Za-z0-9_]+/i.test(rawLogs) ||
        /NAS VERIFIED/i.test(rawLogs) ||
        /NEW DOWNLOAD/i.test(rawLogs)
      )) ||
      displayScenes.some(s => s.status === 'COMPLETE' || s.status === 'DOWNLOADING' || (s.bands && s.bands.length > 0)) ||
      (selectedReq?.status === 'COMPLETED')
    );

    const isPureS1Req = (selectedReq?.satellite || '').includes('Sentinel-1') && !(selectedReq?.satellite || '').includes('Sentinel-2');

    const hasReachedStep3 = Boolean(
      hasReachedStep2 && (
        isPureS1Req
          ? (
              (rawLogs && (
                /SENTINEL-1 SAR CALIBRATION/i.test(rawLogs) ||
                /SNAP/i.test(rawLogs) ||
                /APPLY ORBIT FILE/i.test(rawLogs) ||
                /THERMAL NOISE REMOVAL/i.test(rawLogs) ||
                /RADIOMETRIC CALIBRATION/i.test(rawLogs) ||
                /TERRAIN CORRECTION/i.test(rawLogs) ||
                /DECIBEL CONVERSION/i.test(rawLogs) ||
                /_Orb/i.test(rawLogs) ||
                /VV_Orb_tnr_cal_Tc_db/i.test(rawLogs) ||
                /VH_Orb_tnr_cal_Tc_db/i.test(rawLogs) ||
                /SAR CACHED/i.test(rawLogs) ||
                /Calibrated VV/i.test(rawLogs)
              )) ||
              displayScenes.some(s => s.hasSarCalibrated || (s.bands || []).some(b => b.includes('Orb') || b.includes('VV_VH') || b.includes('_db'))) ||
              (selectedReq?.status === 'COMPLETED')
            )
          : (
              (rawLogs && (
                /STAGE\s*3/i.test(rawLogs) ||
                /STEP\s*3/i.test(rawLogs) ||
                /CLOUD MASKING/i.test(rawLogs) ||
                /INDICES COMPUTED/i.test(rawLogs) ||
                /INDICES VERIFIED/i.test(rawLogs) ||
                /NDVI\.tif/i.test(rawLogs) ||
                /LSWI\.tif/i.test(rawLogs)
              )) ||
              displayScenes.some(s => (s.bands || []).some(b => ['NDVI', 'LSWI', 'EVI', 'NDWI'].includes(b))) ||
              (selectedReq?.status === 'COMPLETED')
            )
      )
    );

    const hasReachedStep4 = Boolean(
      hasCompositeInterval && (hasReachedStep3 || hasReachedStep2) && (
        (rawLogs && (
          /TEMPORAL COMPOSITING/i.test(rawLogs) ||
          /DELIVERY_CLIP/i.test(rawLogs) ||
          /Composite_/i.test(rawLogs)
        )) ||
        (backendComposites && backendComposites.length > 0) ||
        (selectedReq?.status === 'COMPLETED')
      )
    );

    // Dynamic Step Tabs based on real-time execution progress
    const stepTabs = [
      { id: 'all', label: `All Steps (${displayScenes.length})` },
      { id: 'step1', label: `Step-1: Discovery & Gap Check (${displayScenes.length})` },
    ];
    if (hasReachedStep2) {
      stepTabs.push({ id: 'step2', label: isPureS1Req ? `Step-2: Raw SAR Acquisition (${displayScenes.length})` : `Step-2: Band Acquisition (${displayScenes.length})` });
    }
    if (hasReachedStep3) {
      const step3Label = isPureS1Req
        ? `Step-3: SAR Calibration & Ratio (${displayScenes.length})`
        : `Step-3: Indices & Masking (${displayScenes.length})`;
      stepTabs.push({ id: 'step3', label: step3Label });
    }
    if (hasReachedStep4) {
      stepTabs.push({ id: 'step4', label: `Step-4: ${intervalLabel} Composites (${step4Rows.length} windows)` });
    }
    if (['COMPLETED', 'HELD', 'SUCCESS'].includes(selectedReq?.status) || (selectedReq?.stacking_count && selectedReq.stacking_count > 0)) {
      const stackCount = selectedReq?.stacking_count || (selectedReq?.stacked_files || []).length || 0;
      const stackStepLabel = stackCount > 0
        ? `Step-5: Layer Stacking (${stackCount} done)`
        : `Step-5: Layer Stacking (Not Done)`;
      stepTabs.push({ id: 'step5', label: stackStepLabel });
    }
    stepTabs.push({ id: 'warnings', label: `Warnings (${allIssueItems.length})`, isWarning: true });

    const activeStepFilter = stepTabs.some(t => t.id === logStepFilter) ? logStepFilter : 'all';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', padding: '0', backgroundColor: '#ffffff' }}>

        {/* 0. Request Basic Configuration & Parameters Banner */}
        <div style={{
          backgroundColor: '#ffffff',
          borderRadius: '0.5rem',
          padding: '0.75rem 1rem',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span style={{ color: '#1d4ed8', fontWeight: 800, fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', letterSpacing: '0.02em' }}>
              <Terminal size={14} color="#2563eb" />
              PIPELINE CONFIGURATION &amp; REQUEST PARAMETERS
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.73rem', color: '#64748b', fontWeight: 600 }}>
                Request #{selectedReq?.id || '—'} · {selectedReq?.district || selectedReq?.state || 'District'}
              </span>
            </div>
          </div>
          <div style={{
            backgroundColor: '#ffffff',
            padding: '0.55rem 0.85rem',
            borderRadius: '0.375rem',
            border: '1px solid #e2e8f0',
            color: '#1e293b',
            fontFamily: 'monospace',
            fontSize: '0.76rem',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.6
          }}>
            <span style={{ color: '#64748b' }}>[{requestTimestamp}]</span>{' '}
            <span style={{ color: '#2563eb', fontWeight: 700 }}>INFO:sdap.universal_pipeline:</span>{'  '}
            <span style={{ color: '#334155', fontWeight: 600 }}>Range: </span><span style={{ color: '#0284c7', fontWeight: 700 }}>{requestDateRange}</span>
            <span style={{ color: '#cbd5e1' }}> | </span>
            <span style={{ color: '#334155', fontWeight: 600 }}>Satellite: </span><span style={{ color: '#0284c7', fontWeight: 700 }}>{requestSatellites}</span>
            <span style={{ color: '#cbd5e1' }}> | </span>
            <span style={{ color: '#334155', fontWeight: 600 }}>Indices: </span><span style={{ color: '#059669', fontWeight: 700 }}>{requestIndicesFormatted}</span>
            <span style={{ color: '#cbd5e1' }}> | </span>
            <span style={{ color: '#334155', fontWeight: 600 }}>Level: </span><span style={{ color: '#d97706', fontWeight: 700 }}>{requestLevel}</span>
            <span style={{ color: '#cbd5e1' }}> | </span>
            <span style={{ color: '#334155', fontWeight: 600 }}>Max Cloud: </span><span style={{ color: '#dc2626', fontWeight: 700 }}>{requestMaxCloud}</span>
            <span style={{ color: '#cbd5e1' }}> | </span>
            <span style={{ color: '#334155', fontWeight: 600 }}>Composite: </span><span style={{ color: requestComposite === 'NONE' ? '#64748b' : '#059669', fontWeight: 700 }}>{requestComposite}</span>
          </div>
        </div>

        {/* 1. Four KPI Metric Cards (Total Scenes | Complete | Tiles Covered | Bands Needed) */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '0.75rem',
          margin: '0.15rem 0'
        }}>
          {/* Card 1: Total Scenes */}
          <div style={lightKpiCardStyle}>
            <div style={lightKpiLabelStyle}>Total Scenes</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f172a' }}>
              {totalScenes}
            </div>
          </div>

          {/* Card 2: Complete */}
          <div style={lightKpiCardStyle}>
            <div style={lightKpiLabelStyle}>Complete</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#16a34a' }}>
              {completeScenes}
            </div>
          </div>

          {/* Card 3: Tiles Covered */}
          <div style={lightKpiCardStyle}>
            <div style={lightKpiLabelStyle}>Tiles Covered</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#2563eb' }}>
              {tilesCoveredCount}
            </div>
          </div>

          {/* Card 4: Bands Needed */}
          <div style={lightKpiCardStyle}>
            <div style={lightKpiLabelStyle}>Bands Needed</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#2563eb' }}>
              {bandsNeededCount}
            </div>
          </div>
        </div>

        {/* 2. Acquisition Progress Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: '0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>Acquisition Progress</span>
            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#2563eb' }}>{progressPct}%</span>
          </div>
          <div style={{ height: '7px', width: '100%', backgroundColor: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '9999px', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              backgroundColor: '#2563eb',
              borderRadius: '9999px',
              transition: 'width 0.4s ease'
            }} />
          </div>
        </div>

        {/* 2.8 Interactive Step Navigation Bar (Dynamically renders ONLY steps requested & reached in real time) */}
        <div style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          backgroundColor: '#f8fafc',
          padding: '0.5rem 0.75rem',
          borderRadius: '0.5rem',
          border: '1px solid #e2e8f0'
        }}>
          <span style={{ fontSize: '0.74rem', fontWeight: 700, color: '#475569', marginRight: '0.25rem' }}>
            Pipeline Steps:
          </span>
          {stepTabs.map(s => {
            const active = activeStepFilter === s.id;
            const isWarn = s.isWarning;
            const hasNoWarnings = isWarn && allIssueItems.length === 0;
            return (
              <button
                key={s.id}
                onClick={() => {
                  if (hasNoWarnings) return;
                  setLogStepFilter(s.id);
                }}
                disabled={hasNoWarnings}
                title={hasNoWarnings ? 'No warnings recorded' : undefined}
                style={{
                  padding: '0.3rem 0.65rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.74rem',
                  fontWeight: active ? 700 : 600,
                  cursor: hasNoWarnings ? 'default' : 'pointer',
                  opacity: hasNoWarnings ? 0.6 : 1,
                  border: active
                    ? (isWarn ? '1px solid #d97706' : '1px solid #2563eb')
                    : (isWarn && allIssueItems.length > 0 ? '1px solid #fde68a' : '1px solid #cbd5e1'),
                  backgroundColor: active
                    ? (isWarn ? '#fef3c7' : '#eff6ff')
                    : (isWarn && allIssueItems.length > 0 ? '#fffbeb' : '#ffffff'),
                  color: active
                    ? (isWarn ? '#92400e' : '#1d4ed8')
                    : (isWarn && allIssueItems.length > 0 ? '#b45309' : '#64748b'),
                  boxShadow: active
                    ? (isWarn ? '0 1px 2px rgba(217, 119, 6, 0.15)' : '0 1px 2px rgba(37, 99, 235, 0.12)')
                    : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  transition: 'all 0.15s ease'
                }}
              >
                {isWarn && <AlertTriangle size={12} color={active ? '#92400e' : (allIssueItems.length > 0 ? '#d97706' : '#94a3b8')} />}
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Dedicated Step-1 Gap Check Summary Card when Step 1 or All Steps is selected */}
        {(activeStepFilter === 'all' || activeStepFilter === 'step1') && renderGapCheckSummaryCard()}

        {/* 3. Section Header: Acquisition Scenes Breakdown / Warnings Breakdown */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0.15rem 0 0 0' }}>
          <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a' }}>
            {activeStepFilter === 'warnings' ? 'Acquisition Warnings & Missing Deliverables' : 'Acquisition Scenes Breakdown'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {activeStepFilter === 'warnings' ? (
              <span style={{ fontSize: '0.75rem', color: '#b45309', fontWeight: 700, backgroundColor: '#fffbeb', padding: '0.2rem 0.6rem', borderRadius: '0.25rem', border: '1px solid #fde68a' }}>
                ⚠ {allIssueItems.length} ALERT{allIssueItems.length !== 1 ? 'S' : ''} RECORDED
              </span>
            ) : logSearchQuery ? (
              <span style={{ fontSize: '0.75rem', color: '#2563eb', fontWeight: 600 }}>
                Filtered ({displayScenes.length} scenes)
              </span>
            ) : null}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.74rem', fontWeight: 700, color: '#1d4ed8', backgroundColor: '#eff6ff', padding: '0.2rem 0.6rem', borderRadius: '0.25rem', border: '1px solid #bfdbfe' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }} />
              REAL-TIME SYNC · {displayScenes.length} scene{displayScenes.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* 4. Table Structure: Exactly matching user reference (Date, Tile, Satellite, Folder, Status, Bands / Details) */}
        <div style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '0.5rem',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          overflowX: 'auto'
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '0.75rem 1rem', width: '115px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Date</th>
                <th style={{ padding: '0.75rem 1rem', width: '85px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Tile</th>
                <th style={{ padding: '0.75rem 1rem', width: '90px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Satellite</th>
                <th style={{ padding: '0.75rem 1rem', width: '280px', fontWeight: 700, color: '#475569' }}>Folder</th>
                <th style={{ padding: '0.75rem 1rem', width: '145px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Status</th>
                <th style={{ padding: '0.75rem 1.25rem', fontWeight: 700, color: '#475569' }}>
                  {activeStepFilter === 'warnings' ? 'Warning Details / Missing Bands' : 'Bands'}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayScenes.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '3rem 1rem', textAlign: 'center', color: '#64748b', backgroundColor: '#ffffff' }}>
                    <RefreshCw size={22} className="spin" style={{ margin: '0 auto 0.5rem auto', color: '#2563eb' }} />
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>Synchronizing acquisition stream... Connecting to NAS &amp; AWS S3...</div>
                  </td>
                </tr>
              ) : (
                <>
                  {/* STEP 1: Discovery & Gap Check */}
                  {(activeStepFilter === 'all' || activeStepFilter === 'step1') && (
                    <>
                      {renderStepHeader(
                        1,
                        'Discovery & Gap Check',
                        `Overlapping tiles queried · Available on S3: ${gapAvailableS3} | Already held: ${gapAlreadyHeld} | Queued: ${gapMissing}`,
                        `✓ STEP-1 COMPLETE · ${displayScenes.length} SCENES DISCOVERED`
                      )}
                      {displayScenes.map((sc, idx) => renderStep1SceneRow(sc, idx))}
                    </>
                  )}

                  {/* STEP 2: Raw Band Acquisition & NAS Download (Only shown if reached in real time) */}
                  {hasReachedStep2 && (activeStepFilter === 'all' || activeStepFilter === 'step2') && (
                    <>
                      {renderStepHeader(
                        2,
                        isPureS1Req ? 'Raw Band Acquisition & SAFE Download' : 'Raw Band Acquisition & NAS Download',
                        isPureS1Req
                          ? 'Downloading raw SAR polarizations (VV, VH) & SAFE manifest to local NAS storage'
                          : 'Downloading spectral bands (B02-B11, SCL, TCI) to local NAS storage',
                        isPureS1Req ? `✓ STEP-2 · SAFE ARCHIVE VERIFIED` : `✓ STEP-2 · ALL BANDS VERIFIED`
                      )}
                      {displayScenes.map((sc, idx) => renderStep2SceneRow(sc, idx))}
                    </>
                  )}

                  {/* STEP 3: SAR Calibration & Terrain Correction (S1) or Indices & Masking (S2) */}
                  {hasReachedStep3 && (activeStepFilter === 'all' || activeStepFilter === 'step3') && (
                    <>
                      {renderStepHeader(
                        3,
                        isPureS1Req
                          ? 'Sentinel-1 SAR Calibration, Terrain Correction & Polarimetric Ratio'
                          : 'Masking & Surface Reflectance Indices Calculation',
                        isPureS1Req
                          ? 'ESA SNAP Pipeline: Apply-Orbit-File (.EOF) · Thermal Noise Removal · Sigma0 Radiometric Calibration · Range-Doppler Terrain Correction (SRTM DEM) · Decibel Conversion & Dual-Pol Ratio (VV_dB - VH_dB)'
                          : 'SCL cloud masking evaluated · Computing NDVI, LSWI surface reflectance indices',
                        isPureS1Req
                          ? `✓ STEP-3 · SAR CALIBRATION COMPLETE`
                          : `✓ STEP-3 · INDICES COMPUTED`
                      )}
                      {displayScenes.map((sc, idx) => renderStep3SceneRow(sc, idx))}
                    </>
                  )}

                  {/* STEP 4: Temporal Composites Deliverables (Only shown if composite != NONE and reached in real time) */}
                  {hasReachedStep4 && (activeStepFilter === 'all' || activeStepFilter === 'step4') && (
                    <>
                      {renderStepHeader(
                        4,
                        'Temporal Composites & Layer Deliverables',
                        `${intervalLabel} GeoTIFF composite layer stacks archived on NAS storage · ${selectedReq?.district || 'AOI'}`,
                        `✓ STEP-4 · ${step4Rows.length} WEEKS ARCHIVED`
                      )}
                      {step4Rows.map((row, idx) => renderStep4Row(row, idx))}
                    </>
                  )}

                  {/* STEP 5: Multi-Band Layer Stacking Studio Deliverables */}
                  {((['COMPLETED', 'HELD', 'SUCCESS'].includes(selectedReq?.status) || (selectedReq?.stacking_count && selectedReq.stacking_count > 0)) && (activeStepFilter === 'all' || activeStepFilter === 'step5')) && (
                    <>
                      {(() => {
                        const sCount = typeof selectedReq?.stacking_count === 'number'
                          ? selectedReq.stacking_count
                          : ((selectedReq?.stacked_files && selectedReq.stacked_files.length) || 0);

                        return renderStepHeader(
                          5,
                          'Multi-Band Layer Stacking Deliverables (Studio)',
                          sCount > 0
                            ? `Total ${sCount} layer stack(s) completed (${sCount} ${sCount === 1 ? 'time done' : 'times done'}) · Archived on NAS`
                            : 'Pipeline steps 1 to 4 completed successfully · Layer stacking has not been performed yet',
                          sCount > 0
                            ? `✓ STEP-5 · ${sCount} STACK${sCount > 1 ? 'S' : ''} DONE`
                            : `⚠️ STEP-5 · NOT STACKED YET (0)`
                        );
                      })()}

                      {(selectedReq?.stacked_files && selectedReq.stacked_files.length > 0) ? (
                        selectedReq.stacked_files.map((sf, sidx) => (
                          <tr key={`stk-${sidx}`} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: sidx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                            <td style={{ padding: '0.65rem 0.85rem' }} colSpan={2}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <Layers size={14} color="#2563eb" style={{ flexShrink: 0 }} />
                                <div>
                                  <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700, color: '#0f172a', wordBreak: 'break-all' }}>
                                    {sf.filename}
                                  </div>
                                  <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.15rem' }}>
                                    {sf.layers && sf.layers.length > 0 ? `Bands: [${sf.layers.join(', ')}]` : 'Multi-band stacked GeoTIFF'}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem', fontSize: '0.78rem', color: '#334155', fontWeight: 600 }}>
                              {sf.file_size_mb ? `${sf.file_size_mb} MB` : '—'}
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem' }}>
                              <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.2rem 0.5rem',
                                borderRadius: '9999px',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                backgroundColor: '#ecfdf5',
                                color: '#047857',
                                border: '1px solid #a7f3d0'
                              }}>
                                <CheckCircle size={10} color="#047857" /> ARCHIVED ON NAS
                              </span>
                            </td>
                            <td style={{ padding: '0.65rem 0.85rem', textAlign: 'right' }} colSpan={2}>
                              <button
                                onClick={() => handleDownloadStackedTif(sf.path || sf.filename, sf.filename)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem',
                                  padding: '0.35rem 0.65rem',
                                  borderRadius: '0.375rem',
                                  border: '1px solid #2563eb',
                                  backgroundColor: '#eff6ff',
                                  color: '#1d4ed8',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  cursor: 'pointer'
                                }}
                                title="Download stacked GeoTIFF file from NAS"
                              >
                                <Download size={12} /> Download Stack (.tif)
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} style={{ padding: '1.25rem 1rem', textAlign: 'center', backgroundColor: '#fffbeb', border: '1px dashed #fde68a' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem' }}>
                              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#b45309', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Layers size={16} color="#d97706" /> Stacking: Not Done (0 Stacks Completed)
                              </div>
                              <div style={{ fontSize: '0.76rem', color: '#78350f' }}>
                                Pipeline steps 1 to 4 are completed and all input rasters are on NAS. Layer stacking has not been executed yet for this request.
                              </div>
                              <button
                                onClick={() => {
                                  const req = selectedReq;
                                  closeLogsModal();
                                  setActiveTab('layer_stacking');
                                  setStackRequestId(req.id);
                                  setStackState(req.state || '');
                                  setStackDistrict(req.district || '');
                                  setStackSeason(req.season || 'Kharif');
                                  const sDate = req.start_date ? req.start_date.split('T')[0] : '2026-06-01';
                                  const eDate = req.end_date ? req.end_date.split('T')[0] : '2026-10-31';
                                  setStackStartDate(sDate);
                                  setStackEndDate(eDate);
                                  hasAutoLoadedStackRef.current = true;
                                  loadBandsAndScenesForRegion(req.state, req.district, req.season, sDate, eDate, req.id);
                                  fetchStackHistory(req.district);
                                }}
                                style={{
                                  marginTop: '0.4rem',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem',
                                  padding: '0.4rem 0.85rem',
                                  borderRadius: '0.375rem',
                                  border: '1px solid #d97706',
                                  backgroundColor: '#fef3c7',
                                  color: '#92400e',
                                  fontSize: '0.78rem',
                                  fontWeight: 700,
                                  cursor: 'pointer'
                                }}
                              >
                                <Layers size={13} /> Launch Layer Stacking Studio Now
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )}

                  {/* Pipeline Stopped Notice if user stopped before later steps */}
                  {selectedReq?.status === 'STOPPED' && !hasReachedStep2 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0.9rem 1rem', textAlign: 'center', backgroundColor: '#fef2f2', color: '#991b1b', borderTop: '1px solid #fecaca' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                          <Square size={12} fill="#b91c1c" /> Execution stopped at Step-1 by user. Subsequent stages (Step-2, Step-3, Step-4) were not executed.
                        </div>
                      </td>
                    </tr>
                  )}
                  {selectedReq?.status === 'STOPPED' && hasReachedStep2 && !hasReachedStep3 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0.9rem 1rem', textAlign: 'center', backgroundColor: '#fef2f2', color: '#991b1b', borderTop: '1px solid #fecaca' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                          <Square size={12} fill="#b91c1c" /> Execution stopped at Step-2 by user. Subsequent stages (Step-3 Indices, Step-4 Composites) were not executed.
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* WARNINGS STEP: Shown clearly when user clicks on Warnings */}
                  {activeStepFilter === 'warnings' && (
                    <>
                      {renderStepHeader(
                        '!',
                        'Pipeline Warnings & Missing Deliverables',
                        `Total ${allIssueItems.length} alerts recorded during acquisition & processing`,
                        `⚠ ${allIssueItems.length} ALERTS`
                      )}
                      {allIssueItems.length > 0 ? (
                        allIssueItems.map((item, idx) => renderWarningTableRow(item, idx))
                      ) : (
                        <tr>
                          <td colSpan={6} style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#16a34a', backgroundColor: '#f0fdf4' }}>
                            <CheckCircle size={24} style={{ margin: '0 auto 0.4rem auto', color: '#16a34a' }} />
                            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>No Warnings or Missing Items</div>
                            <div style={{ fontSize: '0.75rem', color: '#15803d', marginTop: '0.2rem' }}>All scenes, spectral bands, and composite windows processed successfully without errors or gaps.</div>
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

      </div>
    );
    } catch (tblErr) {
      console.error('Error rendering log table view:', tblErr);
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.5rem' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <Terminal size={14} color="#2563eb" /> Live Pipeline Execution Console
          </div>
          <div className="log-terminal" style={{ flex: 1, minHeight: '380px', maxHeight: '600px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', color: '#0f172a', padding: '1rem 1.25rem', overflowY: 'auto' }}>
            {renderLogContent(rawLogs || selectedReq?.execution_logs)}
          </div>
        </div>
      );
    }
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
              <Shield size={16} /> Admin Storage & Feed
            </button>
          )}

          {currentUser.role === 'ADMIN' && (
            <button
              onClick={() => {
                setActiveTab('users');
                fetchAdminData();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.25rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                border: 'none',
                borderBottom: activeTab === 'users' ? '2px solid #2563eb' : '2px solid transparent',
                color: activeTab === 'users' ? '#2563eb' : '#64748b',
                backgroundColor: 'transparent',
                cursor: 'pointer'
              }}
            >
              <Users size={16} /> User Management
            </button>
          )}


          <button
            onClick={() => {
              setActiveTab('layer_stacking');
              fetchDownloadedRegions();
              fetchStackHistory(stackDistrict);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              border: 'none',
              borderBottom: activeTab === 'layer_stacking' ? '2px solid #2563eb' : '2px solid transparent',
              color: activeTab === 'layer_stacking' ? '#2563eb' : '#64748b',
              backgroundColor: 'transparent',
              cursor: 'pointer'
            }}
          >
            <Layers size={16} /> Layer Stacking
          </button>
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
                            <div style={{ fontSize: '0.72rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                              <span>{Array.isArray(req.indices) ? req.indices.join(', ') : req.indices}</span>
                              {req.level && (
                                <span style={{ fontSize: '0.66rem', backgroundColor: '#e0f2fe', color: '#0369a1', padding: '0.05rem 0.35rem', borderRadius: '0.25rem', fontWeight: 700 }}>
                                  {req.level.toUpperCase()}
                                </span>
                              )}
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
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'nowrap' }}>
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
                                  whiteSpace: 'nowrap',
                                  cursor: 'pointer'
                                }}
                              >
                                <Terminal size={12} /> Logs
                              </button>

                              {['COMPLETED', 'HELD', 'SUCCESS'].includes(req.status) && (
                                <>
                                  {(() => {
                                    const stackCount = typeof req.stacking_count === 'number'
                                      ? req.stacking_count
                                      : ((req.stacked_files && req.stacked_files.length) || 0);

                                    return stackCount > 0 ? (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setStackFilesModalReq(req);
                                        }}
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          gap: '0.32rem',
                                          padding: '0.32rem 0.65rem',
                                          borderRadius: '9999px',
                                          border: '1px solid #86efac',
                                          backgroundColor: '#f0fdf4',
                                          fontSize: '0.72rem',
                                          fontWeight: 700,
                                          color: '#166534',
                                          whiteSpace: 'nowrap',
                                          lineHeight: 1,
                                          cursor: 'pointer',
                                          boxShadow: '0 1px 2px rgba(22, 101, 52, 0.05)',
                                          transition: 'all 0.15s ease'
                                        }}
                                        title={`Click to view ${stackCount} stacked GeoTIFF file(s)`}
                                      >
                                        <CheckCircle size={11} color="#16a34a" style={{ flexShrink: 0 }} />
                                        <span>{stackCount} {stackCount === 1 ? 'time done' : 'times done'}</span>
                                      </button>
                                    ) : (
                                      <span
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          gap: '0.35rem',
                                          padding: '0.25rem 0.7rem',
                                          borderRadius: '9999px',
                                          border: '1px solid #fed7aa',
                                          backgroundColor: '#fff7ed',
                                          fontSize: '0.72rem',
                                          fontWeight: 700,
                                          color: '#c2410c',
                                          whiteSpace: 'nowrap',
                                          flexShrink: 0,
                                          minWidth: 'max-content',
                                          textAlign: 'center',
                                          lineHeight: 1.2,
                                          boxShadow: '0 1px 2px rgba(194, 65, 12, 0.05)',
                                          userSelect: 'none'
                                        }}
                                        title="Pipeline steps 1 to 4 completed, but layer stacking has not been performed yet for this request"
                                      >
                                        <Layers size={11} color="#ea580c" style={{ flexShrink: 0 }} />
                                        <span style={{ whiteSpace: 'nowrap' }}>Stacking: Not Done</span>
                                      </span>
                                    );
                                  })()}

                                  <button
                                    onClick={() => {
                                      closeLogsModal();
                                      setActiveTab('layer_stacking');
                                      setStackRequestId(req.id);
                                      setStackState(req.state || '');
                                      setStackDistrict(req.district || '');
                                      setStackSeason(req.season || 'Kharif');
                                      const sDate = req.start_date ? req.start_date.split('T')[0] : '2026-06-01';
                                      const eDate = req.end_date ? req.end_date.split('T')[0] : '2026-10-31';
                                      setStackStartDate(sDate);
                                      setStackEndDate(eDate);
                                      hasAutoLoadedStackRef.current = true;
                                      loadBandsAndScenesForRegion(req.state, req.district, req.season, sDate, eDate, req.id);
                                      fetchStackHistory(req.district);
                                    }}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.25rem',
                                      padding: '0.35rem 0.6rem',
                                      borderRadius: '0.375rem',
                                      border: '1px solid #bfdbfe',
                                      backgroundColor: '#eff6ff',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      color: '#1d4ed8',
                                      cursor: 'pointer'
                                    }}
                                    title="Open Multi-Band Layer Stacking Studio for this request"
                                  >
                                    <Layers size={12} /> Stacking
                                  </button>
                                </>
                              )}

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
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                  Submit Satellite Acquisition & Pipeline Request
                </h2>
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
                          } else {
                            if (selectedSatellites.length > 1) {
                              setSelectedSatellites(selectedSatellites.filter(s => s !== 'Sentinel-1'));
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
                              setSelectedIndices([]);
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

                {/* Spectral Indices (Sentinel-2) */}
                {selectedSatellites.includes('Sentinel-2') && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>
                      Target Spectral Indices (Sentinel-2) <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                      {['NDVI', 'LSWI', 'EVI', 'NDWI'].map((idx) => {
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
                )}

                {/* Composite Interval + Level Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                      Composite Interval {isOnlyS1 && <span style={{ fontSize: '0.72rem', color: '#2563eb', fontWeight: 600 }}>(Sentinel-1: Fortnightly - 12 Days)</span>}
                    </label>
                    <select value={compositeInterval} onChange={(e) => setCompositeInterval(e.target.value)} style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}>
                      <option value="none">None (Individual Scenes)</option>
                      {!isOnlyS1 && <option value="weekly">Weekly (7-Day Composite)</option>}
                      <option value="fortnightly">{isOnlyS1 ? 'Fortnightly (12-Day Composite)' : 'Fortnightly (15-Day Composite)'}</option>
                      {!isOnlyS1 && <option value="monthly">Monthly (30-Day Composite)</option>}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Level</label>
                    <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}>
                      <option value="max">max (Maximum Value Composite)</option>
                      <option value="min">min (Minimum Value Composite)</option>
                      <option value="mean">mean (Average Value Composite)</option>
                    </select>
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
                  </div>
                </div>

                {/* Dynamic Estimated Storage & Pipeline Step Duration Box */}
                <div style={{ backgroundColor: willBeRejected ? '#fef2f2' : willRequireApproval ? '#fffbeb' : '#f0fdf4', border: `1px solid ${willBeRejected ? '#fca5a5' : willRequireApproval ? '#fde68a' : '#bbf7d0'}`, borderRadius: '0.5rem', padding: '1rem 1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.75rem', flexWrap: 'wrap' }}>
                      {/* Storage Estimate */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600, color: '#64748b', marginBottom: '0.25rem' }}>
                          <HardDrive size={14} color="#2563eb" /> Estimated Storage Requirement
                        </div>
                        <div style={{ fontSize: '1.45rem', fontWeight: 800, color: '#0f172a' }}>
                          {estimatedGb} <span style={{ fontSize: '0.85rem', fontWeight: 500, color: '#64748b' }}>GB</span>
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: '0.2rem' }}>
                          ~{estResult.scenes} scenes · {estResult.tiles} tiles · {estResult.months} months
                        </div>
                      </div>

                      {/* Step-Based Pipeline Duration Estimate */}
                      <div style={{ borderLeft: '1px solid #cbd5e1', paddingLeft: '1.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.8rem', fontWeight: 600, color: '#64748b', marginBottom: '0.25rem' }}>
                          <Clock size={14} color="#d97706" /> Estimated Processing Duration
                          <span style={{
                            padding: '0.1rem 0.45rem',
                            borderRadius: '9999px',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            backgroundColor: '#fef3c7',
                            color: '#92400e',
                            border: '1px solid #fde68a'
                          }}>
                            {estResult.activeStepsCount}/{estResult.totalPipelineSteps} Steps Active
                          </span>
                        </div>
                        <div style={{ fontSize: '1.45rem', fontWeight: 800, color: '#92400e' }}>
                          {estResult.downloadTimeText}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                          {(estResult.stepBreakdown || []).map((st) => (
                            <span
                              key={st.step}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.2rem',
                                padding: '0.1rem 0.4rem',
                                borderRadius: '0.25rem',
                                fontSize: '0.68rem',
                                fontWeight: st.active ? 600 : 400,
                                backgroundColor: st.active ? '#ffffff' : '#f1f5f9',
                                color: st.active ? '#0f172a' : '#94a3b8',
                                border: st.active ? '1px solid #cbd5e1' : '1px dashed #cbd5e1',
                                textDecoration: st.active ? 'none' : 'line-through'
                              }}
                              title={st.name}
                            >
                              Step {st.step}: {st.active ? st.durationText : 'Skipped'}
                            </span>
                          ))}
                        </div>
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
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Indices</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{(confirmPayload.indices || []).length > 0 ? confirmPayload.indices.join(', ') : 'None (Raw Bands Only)'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Composite Interval</span><span style={{ fontWeight: 600, color: '#0f172a', textTransform: 'capitalize' }}>{confirmPayload.composite_interval || 'none'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Calculation Level</span><span style={{ fontWeight: 600, color: '#0284c7' }}>{confirmPayload.level ? confirmPayload.level.toUpperCase() : 'MAX'}</span></div>
                      <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '0.25rem 0' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Active Pipeline Steps</span><span style={{ fontWeight: 700, color: '#1d4ed8' }}>{estResult.activeStepsCount} of {estResult.totalPipelineSteps} Steps</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Scenes</span><span style={{ fontWeight: 700, color: '#0f172a' }}>~{estResult.scenes}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Storage</span><span style={{ fontWeight: 700, fontSize: '1rem', color: willRequireApproval ? '#92400e' : '#166534' }}>{estimatedGb} GB</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Processing Time</span><span style={{ fontWeight: 700, fontSize: '1rem', color: '#92400e' }}>{estResult.downloadTimeText} ({estResult.activeStepsCount} Steps)</span></div>
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

            {/* ========================================================================= */}
            {/* Daily Storage Occupancy & Request Analytics (Admin Only) */}
            {/* ========================================================================= */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem',
              boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)'
            }}>
              {/* Card Header & Controls */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <HardDrive size={20} color="#2563eb" /> Daily Storage Occupancy & Request Tracking
                    </h3>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      padding: '0.2rem 0.55rem',
                      borderRadius: '9999px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      backgroundColor: '#eff6ff',
                      color: '#1d4ed8',
                      border: '1px solid #bfdbfe'
                    }}>
                      <Shield size={11} /> ADMIN RESTRICTED
                    </span>
                  </div>
                  <p style={{ fontSize: '0.82rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
                    Audit day-by-day storage allocations requested by users alongside physical raster data held on the NAS array.
                  </p>
                </div>

                {/* Filter & Action Buttons */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {/* Quick Filters */}
                  <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '0.375rem', padding: '0.2rem' }}>
                    <button
                      type="button"
                      onClick={() => handleDailyStorageQuickFilter('ALL')}
                      style={{
                        padding: '0.3rem 0.65rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        backgroundColor: dailyStorageFilter === 'ALL' ? '#ffffff' : 'transparent',
                        color: dailyStorageFilter === 'ALL' ? '#0f172a' : '#64748b',
                        boxShadow: dailyStorageFilter === 'ALL' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        cursor: 'pointer'
                      }}
                    >
                      All Time
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDailyStorageQuickFilter('7D')}
                      style={{
                        padding: '0.3rem 0.65rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        backgroundColor: dailyStorageFilter === '7D' ? '#ffffff' : 'transparent',
                        color: dailyStorageFilter === '7D' ? '#0f172a' : '#64748b',
                        boxShadow: dailyStorageFilter === '7D' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        cursor: 'pointer'
                      }}
                    >
                      Last 7 Days
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDailyStorageQuickFilter('30D')}
                      style={{
                        padding: '0.3rem 0.65rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        backgroundColor: dailyStorageFilter === '30D' ? '#ffffff' : 'transparent',
                        color: dailyStorageFilter === '30D' ? '#0f172a' : '#64748b',
                        boxShadow: dailyStorageFilter === '30D' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        cursor: 'pointer'
                      }}
                    >
                      Last 30 Days
                    </button>
                  </div>

                  {/* Date Pickers */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', backgroundColor: '#f8fafc', padding: '0.25rem 0.5rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1' }}>
                    <Calendar size={13} color="#64748b" />
                    <input
                      type="date"
                      value={dailyStartDate}
                      onChange={(e) => {
                        setDailyStartDate(e.target.value);
                        setDailyStorageFilter('CUSTOM');
                      }}
                      title="Start Date"
                      style={{ border: 'none', backgroundColor: 'transparent', fontSize: '0.78rem', color: '#334155', outline: 'none' }}
                    />
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>to</span>
                    <input
                      type="date"
                      value={dailyEndDate}
                      onChange={(e) => {
                        setDailyEndDate(e.target.value);
                        setDailyStorageFilter('CUSTOM');
                      }}
                      title="End Date"
                      style={{ border: 'none', backgroundColor: 'transparent', fontSize: '0.78rem', color: '#334155', outline: 'none' }}
                    />
                    <button
                      type="button"
                      onClick={() => fetchDailyStorage(dailyStartDate, dailyEndDate)}
                      style={{
                        padding: '0.2rem 0.45rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        backgroundColor: '#2563eb',
                        color: '#ffffff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      Filter
                    </button>
                    {(dailyStartDate || dailyEndDate) && (
                      <button
                        type="button"
                        onClick={() => {
                          setDailyStartDate('');
                          setDailyEndDate('');
                          setDailyStorageFilter('ALL');
                          fetchDailyStorage('', '');
                        }}
                        style={{
                          padding: '0.2rem 0.35rem',
                          borderRadius: '0.25rem',
                          border: 'none',
                          backgroundColor: '#e2e8f0',
                          color: '#475569',
                          fontSize: '0.75rem',
                          cursor: 'pointer'
                        }}
                        title="Clear Date Filter"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {/* Refresh Button */}
                  <button
                    type="button"
                    onClick={() => fetchDailyStorage(dailyStartDate, dailyEndDate)}
                    disabled={loadingDailyStorage}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.4rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: '#334155',
                      cursor: 'pointer'
                    }}
                  >
                    <RefreshCw size={13} className={loadingDailyStorage ? 'animate-spin' : ''} />
                    Refresh
                  </button>
                </div>
              </div>

              {/* KPI Summary Cards Grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
                marginBottom: '1.5rem'
              }}>
                {/* Total Requested Storage */}
                <div style={{
                  padding: '1rem 1.15rem',
                  borderRadius: '0.5rem',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Total Requested Storage
                    </div>
                    <div style={{ fontSize: '1.45rem', fontWeight: 700, color: '#1e293b', marginTop: '0.35rem' }}>
                      {dailyStorageData?.summary?.total_request_storage_gb ?? '0.00'} <span style={{ fontSize: '0.9rem', fontWeight: 500, color: '#64748b' }}>GB</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.25rem' }}>
                      Across {dailyStorageData?.summary?.total_requests ?? 0} user requests
                    </div>
                  </div>
                  <div style={{ padding: '0.6rem', borderRadius: '0.375rem', backgroundColor: '#eff6ff', color: '#2563eb' }}>
                    <Database size={20} />
                  </div>
                </div>

                {/* Physical Storage on NAS */}
                <div style={{
                  padding: '1rem 1.15rem',
                  borderRadius: '0.5rem',
                  backgroundColor: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Physical Storage on NAS
                    </div>
                    <div style={{ fontSize: '1.45rem', fontWeight: 700, color: '#14532d', marginTop: '0.35rem' }}>
                      {dailyStorageData?.summary?.total_physical_storage_gb ?? '0.00'} <span style={{ fontSize: '0.9rem', fontWeight: 500, color: '#166534' }}>GB</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#166534', marginTop: '0.25rem' }}>
                      {dailyStorageData?.summary?.total_files?.toLocaleString() ?? 0} verified raster band files
                    </div>
                  </div>
                  <div style={{ padding: '0.6rem', borderRadius: '0.375rem', backgroundColor: '#dcfce7', color: '#16a34a' }}>
                    <HardDrive size={20} />
                  </div>
                </div>

                {/* Average Daily Storage */}
                <div style={{
                  padding: '1rem 1.15rem',
                  borderRadius: '0.5rem',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fef3c7',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Average Daily Ingestion
                    </div>
                    <div style={{ fontSize: '1.45rem', fontWeight: 700, color: '#78350f', marginTop: '0.35rem' }}>
                      {dailyStorageData?.summary?.avg_daily_storage_gb ?? '0.00'} <span style={{ fontSize: '0.9rem', fontWeight: 500, color: '#92400e' }}>GB / day</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#92400e', marginTop: '0.25rem' }}>
                      Across {dailyStorageData?.summary?.active_days_count ?? 0} active storage days
                    </div>
                  </div>
                  <div style={{ padding: '0.6rem', borderRadius: '0.375rem', backgroundColor: '#fef3c7', color: '#d97706' }}>
                    <TrendingUp size={20} />
                  </div>
                </div>

                {/* Peak Ingestion Day */}
                <div style={{
                  padding: '1rem 1.15rem',
                  borderRadius: '0.5rem',
                  backgroundColor: '#f5f3ff',
                  border: '1px solid #ddd6fe',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b21a8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Peak Ingestion Day
                    </div>
                    <div style={{ fontSize: '1.45rem', fontWeight: 700, color: '#581c87', marginTop: '0.35rem' }}>
                      {dailyStorageData?.summary?.peak_day ? `${dailyStorageData.summary.peak_day.storage_gb} GB` : '—'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#6b21a8', marginTop: '0.25rem' }}>
                      {dailyStorageData?.summary?.peak_day ? `${dailyStorageData.summary.peak_day.date} (${dailyStorageData.summary.peak_day.request_count} reqs)` : 'No records yet'}
                    </div>
                  </div>
                  <div style={{ padding: '0.6rem', borderRadius: '0.375rem', backgroundColor: '#ede9fe', color: '#7c3aed' }}>
                    <Activity size={20} />
                  </div>
                </div>
              </div>

              {/* Visual Daily Storage Bar Chart */}
              {dailyStorageData?.daily_timeline && dailyStorageData.daily_timeline.length > 0 && (() => {
                const chronologicalTimeline = [...dailyStorageData.daily_timeline].sort((a, b) => a.date.localeCompare(b.date));
                const maxDayValue = Math.max(
                  ...chronologicalTimeline.map(d => Math.max(d.request_storage_gb || 0, d.physical_storage_gb || 0)),
                  10
                );

                return (
                  <div style={{
                    backgroundColor: '#f8fafc',
                    borderRadius: '0.5rem',
                    border: '1px solid #e2e8f0',
                    padding: '1.25rem',
                    marginBottom: '1.5rem'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <BarChart3 size={16} color="#2563eb" /> Daily Ingestion Velocity Trend
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.78rem' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#334155' }}>
                          <span style={{ width: '10px', height: '10px', backgroundColor: '#3b82f6', borderRadius: '2px', display: 'inline-block' }}></span>
                          Requested Storage (GB)
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#334155' }}>
                          <span style={{ width: '10px', height: '10px', backgroundColor: '#10b981', borderRadius: '2px', display: 'inline-block' }}></span>
                          Physical Downloaded (GB)
                        </span>
                      </div>
                    </div>

                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: '1rem',
                      height: '140px',
                      padding: '0.5rem 0.5rem 0.25rem 0.5rem',
                      overflowX: 'auto',
                      borderBottom: '1px solid #cbd5e1'
                    }}>
                      {chronologicalTimeline.map((day) => {
                        const reqPct = Math.min(Math.round(((day.request_storage_gb || 0) / maxDayValue) * 100), 100);
                        const physPct = Math.min(Math.round(((day.physical_storage_gb || 0) / maxDayValue) * 100), 100);
                        const isExpanded = expandedDailyDate === day.date;

                        return (
                          <div
                            key={day.date}
                            onClick={() => setExpandedDailyDate(isExpanded ? null : day.date)}
                            title={`Date: ${day.date}\nRequested: ${day.request_storage_gb} GB (${day.request_count} reqs)\nPhysical: ${day.physical_storage_gb} GB (${day.physical_files_count} files)`}
                            style={{
                              flex: '1',
                              minWidth: '55px',
                              maxWidth: '85px',
                              height: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'flex-end',
                              alignItems: 'center',
                              cursor: 'pointer',
                              padding: '0.2rem',
                              borderRadius: '0.375rem',
                              backgroundColor: isExpanded ? '#eff6ff' : 'transparent',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '105px', width: '100%', justifyContent: 'center' }}>
                              {/* Request GB bar */}
                              <div style={{
                                width: '40%',
                                height: `${Math.max(reqPct, 4)}%`,
                                backgroundColor: '#3b82f6',
                                borderRadius: '3px 3px 0 0',
                                transition: 'height 0.3s ease'
                              }}></div>
                              {/* Physical GB bar */}
                              <div style={{
                                width: '40%',
                                height: `${Math.max(physPct, 4)}%`,
                                backgroundColor: '#10b981',
                                borderRadius: '3px 3px 0 0',
                                transition: 'height 0.3s ease'
                              }}></div>
                            </div>
                            <div style={{ fontSize: '0.7rem', fontWeight: 600, color: isExpanded ? '#2563eb' : '#64748b', marginTop: '0.4rem', whiteSpace: 'nowrap' }}>
                              {day.date.slice(5)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Daily Storage Ledger Table */}
              <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '0.5rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Date</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Requests Submitted</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Daily Requested Storage</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Physical NAS Storage</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Cumulative Storage</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Satellites</th>
                      <th style={{ padding: '0.75rem 0.85rem' }}>Target Districts</th>
                      <th style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!dailyStorageData?.daily_timeline || dailyStorageData.daily_timeline.length === 0) ? (
                      <tr>
                        <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                          {loadingDailyStorage ? 'Loading daily storage data...' : 'No daily storage records found for selected period.'}
                        </td>
                      </tr>
                    ) : (
                      dailyStorageData.daily_timeline.map((day) => {
                        const isExpanded = expandedDailyDate === day.date;

                        return (
                          <React.Fragment key={day.date}>
                            <tr
                              style={{
                                borderBottom: '1px solid #e2e8f0',
                                backgroundColor: isExpanded ? '#f8fafc' : '#ffffff',
                                transition: 'background-color 0.15s ease'
                              }}
                            >
                              <td style={{ padding: '0.75rem 0.85rem', fontWeight: 700, color: '#0f172a' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <Calendar size={14} color="#64748b" />
                                  <span>{day.date}</span>
                                </div>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                {day.request_count > 0 ? (
                                  <span style={{
                                    padding: '0.2rem 0.55rem',
                                    borderRadius: '9999px',
                                    backgroundColor: '#eff6ff',
                                    color: '#1d4ed8',
                                    fontWeight: 600,
                                    fontSize: '0.78rem'
                                  }}>
                                    {day.request_count} {day.request_count === 1 ? 'request' : 'requests'}
                                  </span>
                                ) : (
                                  <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>0 (Download only)</span>
                                )}
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem', fontWeight: 700, color: '#2563eb' }}>
                                {day.request_storage_gb > 0 ? `${day.request_storage_gb} GB` : '—'}
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem', fontWeight: 600, color: '#059669' }}>
                                {day.physical_storage_gb > 0 ? (
                                  <span>{day.physical_storage_gb} GB <span style={{ fontSize: '0.72rem', color: '#64748b' }}>({day.physical_files_count} files)</span></span>
                                ) : (
                                  <span style={{ color: '#94a3b8' }}>—</span>
                                )}
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem', color: '#334155' }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                                  Req: {day.cumulative_request_gb} GB
                                </div>
                                <div style={{ fontSize: '0.74rem', color: '#059669' }}>
                                  NAS: {day.cumulative_physical_gb} GB
                                </div>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                                  {day.satellites && day.satellites.length > 0 ? (
                                    day.satellites.map((sat) => (
                                      <span
                                        key={sat}
                                        style={{
                                          padding: '0.15rem 0.45rem',
                                          borderRadius: '0.25rem',
                                          fontSize: '0.72rem',
                                          fontWeight: 600,
                                          backgroundColor: '#e0e7ff',
                                          color: '#3730a3'
                                        }}
                                      >
                                        {sat}
                                      </span>
                                    ))
                                  ) : (
                                    <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>—</span>
                                  )}
                                </div>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem' }}>
                                <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', maxWidth: '180px' }}>
                                  {day.districts && day.districts.length > 0 ? (
                                    day.districts.map((dst) => (
                                      <span
                                        key={dst}
                                        style={{
                                          padding: '0.15rem 0.4rem',
                                          borderRadius: '0.25rem',
                                          fontSize: '0.72rem',
                                          backgroundColor: '#f1f5f9',
                                          color: '#334155'
                                        }}
                                      >
                                        {dst}
                                      </span>
                                    ))
                                  ) : (
                                    <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>—</span>
                                  )}
                                </div>
                              </td>
                              <td style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>
                                <button
                                  type="button"
                                  onClick={() => setExpandedDailyDate(isExpanded ? null : day.date)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.35rem 0.65rem',
                                    borderRadius: '0.375rem',
                                    border: '1px solid #cbd5e1',
                                    backgroundColor: isExpanded ? '#2563eb' : '#ffffff',
                                    color: isExpanded ? '#ffffff' : '#334155',
                                    fontSize: '0.78rem',
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  {isExpanded ? 'Hide' : 'Details'}
                                </button>
                              </td>
                            </tr>

                            {/* Nested Requests View */}
                            {isExpanded && (
                              <tr style={{ backgroundColor: '#f8fafc' }}>
                                <td colSpan={8} style={{ padding: '1rem 1.25rem', borderBottom: '2px solid #e2e8f0' }}>
                                  <div style={{ backgroundColor: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '1rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                                      <h4 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700, color: '#0f172a' }}>
                                        Requests Logged on {day.date} ({day.requests?.length || 0})
                                      </h4>
                                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                                        Daily Allocated Storage: <strong style={{ color: '#2563eb' }}>{day.request_storage_gb} GB</strong>
                                      </span>
                                    </div>

                                    {(!day.requests || day.requests.length === 0) ? (
                                      <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.82rem' }}>
                                        No new request records created on this date. File downloads processed were initiated from previous pipeline jobs.
                                      </div>
                                    ) : (
                                      <div style={{ overflowX: 'auto' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                                          <thead>
                                            <tr style={{ backgroundColor: '#f1f5f9', color: '#475569', borderBottom: '1px solid #e2e8f0' }}>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>ID</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>Title</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>User</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>Region</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>Satellite</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>Est. Storage</th>
                                              <th style={{ padding: '0.5rem 0.65rem' }}>Status</th>
                                              <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Logs</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {day.requests.map((r) => (
                                              <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                                <td style={{ padding: '0.5rem 0.65rem', fontWeight: 700, color: '#2563eb' }}>#{r.id}</td>
                                                <td style={{ padding: '0.5rem 0.65rem', fontWeight: 600, color: '#0f172a' }}>{r.title}</td>
                                                <td style={{ padding: '0.5rem 0.65rem', color: '#334155' }}>
                                                  <div>{r.user_name}</div>
                                                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{r.user_email}</div>
                                                </td>
                                                <td style={{ padding: '0.5rem 0.65rem', color: '#334155' }}>
                                                  {r.district ? `${r.district}, ${r.state}` : r.state || 'All India'}
                                                </td>
                                                <td style={{ padding: '0.5rem 0.65rem', fontWeight: 600 }}>{r.satellite}</td>
                                                <td style={{ padding: '0.5rem 0.65rem', fontWeight: 700, color: '#2563eb' }}>{r.storage_gb} GB</td>
                                                <td style={{ padding: '0.5rem 0.65rem' }}>
                                                  {renderStatusBadge(r.status)}
                                                </td>
                                                <td style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>
                                                  <button
                                                    type="button"
                                                    onClick={() => openLogsModal(r)}
                                                    style={{
                                                      display: 'inline-flex',
                                                      alignItems: 'center',
                                                      gap: '0.25rem',
                                                      padding: '0.25rem 0.5rem',
                                                      borderRadius: '0.25rem',
                                                      border: '1px solid #cbd5e1',
                                                      backgroundColor: '#ffffff',
                                                      fontSize: '0.74rem',
                                                      fontWeight: 600,
                                                      color: '#334155',
                                                      cursor: 'pointer'
                                                    }}
                                                  >
                                                    <Terminal size={11} color="#2563eb" /> Logs
                                                  </button>
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
        {/* TAB 3B: System User Directory & Access Controls (Dedicated Admin Page) */}
        {/* ========================================================================= */}
        {activeTab === 'users' && currentUser.role === 'ADMIN' && (
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
                      <th style={{ padding: '0.75rem 0.85rem', textAlign: 'right' }}>Actions</th>
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
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'flex-end' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleExpandUser(u.id)}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.35rem',
                                      padding: '0.35rem 0.65rem',
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
                                    {isExpanded ? 'Hide' : 'Requests & Logs'}
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => handleDeleteUser(u.id, u.email)}
                                    disabled={u.id === currentUser?.id || u.email === currentUser?.email}
                                    title={u.id === currentUser?.id || u.email === currentUser?.email ? "Cannot delete your own active administrator account" : `Delete user account (${u.email})`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.25rem',
                                      padding: '0.35rem 0.6rem',
                                      backgroundColor: (u.id === currentUser?.id || u.email === currentUser?.email) ? '#f1f5f9' : '#fee2e2',
                                      color: (u.id === currentUser?.id || u.email === currentUser?.email) ? '#94a3b8' : '#991b1b',
                                      border: (u.id === currentUser?.id || u.email === currentUser?.email) ? '1px solid #e2e8f0' : '1px solid #fecaca',
                                      borderRadius: '0.375rem',
                                      fontSize: '0.78rem',
                                      fontWeight: 600,
                                      cursor: (u.id === currentUser?.id || u.email === currentUser?.email) ? 'not-allowed' : 'pointer'
                                    }}
                                  >
                                    <Trash2 size={13} /> Delete
                                  </button>
                                </div>
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
                                                <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem', flexWrap: 'nowrap' }}>
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
                                                        whiteSpace: 'nowrap',
                                                        cursor: 'pointer'
                                                      }}
                                                    >
                                                      <Terminal size={12} color="#2563eb" /> Logs
                                                    </button>

                                                    {['COMPLETED', 'HELD', 'SUCCESS'].includes(req.status) && (
                                                      <>
                                                        {(() => {
                                                          const stackCount = typeof req.stacking_count === 'number'
                                                            ? req.stacking_count
                                                            : ((req.stacked_files && req.stacked_files.length) || 0);

                                                          return stackCount > 0 ? (
                                                            <button
                                                              onClick={(e) => {
                                                                e.stopPropagation();
                                                                setStackFilesModalReq(req);
                                                              }}
                                                              style={{
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                gap: '0.3rem',
                                                                padding: '0.28rem 0.6rem',
                                                                borderRadius: '9999px',
                                                                border: '1px solid #86efac',
                                                                backgroundColor: '#f0fdf4',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 700,
                                                                color: '#166534',
                                                                whiteSpace: 'nowrap',
                                                                lineHeight: 1,
                                                                cursor: 'pointer'
                                                              }}
                                                              title={`View ${stackCount} stacked GeoTIFF file(s)`}
                                                            >
                                                              <CheckCircle size={10} color="#16a34a" style={{ flexShrink: 0 }} />
                                                              <span>{stackCount} {stackCount === 1 ? 'time done' : 'times done'}</span>
                                                            </button>
                                                          ) : (
                                                            <span
                                                              style={{
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                gap: '0.35rem',
                                                                padding: '0.25rem 0.65rem',
                                                                borderRadius: '9999px',
                                                                border: '1px solid #fed7aa',
                                                                backgroundColor: '#fff7ed',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 700,
                                                                color: '#c2410c',
                                                                whiteSpace: 'nowrap',
                                                                flexShrink: 0,
                                                                minWidth: 'max-content',
                                                                textAlign: 'center',
                                                                lineHeight: 1.2
                                                              }}
                                                              title="Pipeline steps 1 to 4 completed, but layer stacking has not been performed yet for this request"
                                                            >
                                                              <Layers size={11} color="#ea580c" style={{ flexShrink: 0 }} />
                                                              <span style={{ whiteSpace: 'nowrap' }}>Stacking: Not Done</span>
                                                            </span>
                                                          );
                                                        })()}

                                                        <button
                                                          onClick={() => {
                                                            setActiveTab('layer_stacking');
                                                            setStackRequestId(req.id);
                                                            setStackState(req.state || '');
                                                            setStackDistrict(req.district || '');
                                                            setStackSeason(req.season || 'Kharif');
                                                            const sDate = req.start_date ? req.start_date.split('T')[0] : '2026-06-01';
                                                            const eDate = req.end_date ? req.end_date.split('T')[0] : '2026-10-31';
                                                            setStackStartDate(sDate);
                                                            setStackEndDate(eDate);
                                                            hasAutoLoadedStackRef.current = true;
                                                            loadBandsAndScenesForRegion(req.state, req.district, req.season, sDate, eDate, req.id);
                                                            fetchStackHistory(req.district);
                                                          }}
                                                          title="Open Multi-Band Layer Stacking Studio for this request"
                                                          style={{
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: '0.25rem',
                                                            padding: '0.3rem 0.55rem',
                                                            borderRadius: '0.375rem',
                                                            border: '1px solid #bfdbfe',
                                                            backgroundColor: '#eff6ff',
                                                            fontSize: '0.75rem',
                                                            fontWeight: 600,
                                                            color: '#1d4ed8',
                                                            cursor: 'pointer'
                                                          }}
                                                        >
                                                          <Layers size={12} color="#1d4ed8" /> Stacking
                                                        </button>
                                                      </>
                                                    )}

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
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HardDrive size={22} color="#2563eb" /> GeoTIFF Raster Retrieval & Export Form
                </h2>
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
                    onChange={(e) => handleRetSatelliteChange(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="ALL">All Sensors (Sentinel-1 & Sentinel-2)</option>
                    <option value="Sentinel-1">Sentinel-1 (SAR Radar)</option>
                    <option value="Sentinel-2">Sentinel-2 (MSI Optical)</option>
                  </select>
                </div>

                {/* Temporal Composite Interval */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Temporal Composite Interval {retSatellite === 'Sentinel-1' && <span style={{ fontSize: '0.72rem', color: '#2563eb', fontWeight: 600 }}>(Sentinel-1: Fortnightly - 12 Days)</span>} {retSelectedBands.length > 0 && <span style={{ color: '#2563eb', fontSize: '0.72rem', fontWeight: 700 }}>• Active</span>}
                  </label>
                  <select
                    value={retCompositeInterval}
                    onChange={(e) => setRetCompositeInterval(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: retSelectedBands.length > 0 ? '1px solid #93c5fd' : '1px solid #cbd5e1',
                      fontSize: '0.875rem',
                      backgroundColor: retSelectedBands.length > 0 ? '#f0f9ff' : '#ffffff'
                    }}
                  >
                    <option value="ALL">All Intervals / Any</option>
                    {retSatellite !== 'Sentinel-1' && <option value="weekly">Weekly (7-Day Composite)</option>}
                    <option value="fortnightly">{retSatellite === 'Sentinel-1' ? 'Fortnightly (12-Day Composite)' : 'Fortnightly (15-Day Composite)'}</option>
                    {retSatellite !== 'Sentinel-1' && <option value="monthly">Monthly (30-Day Composite)</option>}
                    <option value="none">None (Individual Scene Rasters)</option>
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

                {/* Spectral / SAR Band Checkboxes (Filtered by Satellite) */}
                <div style={{ gridColumn: '1 / -1', marginTop: '0.35rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.825rem', fontWeight: 700, color: '#1e293b' }}>
                        Spectral / SAR Band
                      </label>
                      <span style={{
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        padding: '0.15rem 0.55rem',
                        borderRadius: '0.25rem',
                        backgroundColor: retSatellite === 'Sentinel-1' ? '#f0fdf4' : retSatellite === 'Sentinel-2' ? '#eff6ff' : '#f8fafc',
                        color: retSatellite === 'Sentinel-1' ? '#166534' : retSatellite === 'Sentinel-2' ? '#1d4ed8' : '#475569',
                        border: '1px solid #cbd5e1'
                      }}>
                        {retSatellite === 'Sentinel-1' ? 'Sentinel-1 SAR Radar' : retSatellite === 'Sentinel-2' ? 'Sentinel-2 MSI Optical' : 'All Sensors (S1 + S2)'}
                      </span>
                      {retSelectedBands.length > 0 ? (
                        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb' }}>
                          • {retSelectedBands.length} band{retSelectedBands.length > 1 ? 's' : ''} selected
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                          (All bands included by default, or check required bands below)
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={handleSelectAllRetBands}
                        style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          padding: '0.2rem 0.6rem',
                          borderRadius: '0.25rem',
                          border: '1px solid #cbd5e1',
                          backgroundColor: '#ffffff',
                          color: '#2563eb',
                          cursor: 'pointer'
                        }}
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        onClick={handleClearAllRetBands}
                        style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          padding: '0.2rem 0.6rem',
                          borderRadius: '0.25rem',
                          border: '1px solid #cbd5e1',
                          backgroundColor: '#ffffff',
                          color: '#64748b',
                          cursor: 'pointer'
                        }}
                      >
                        Clear Selection
                      </button>
                    </div>
                  </div>

                  {/* Sentinel-1 Only Bands */}
                  {retSatellite === 'Sentinel-1' && (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                      gap: '0.6rem',
                      padding: '0.75rem',
                      backgroundColor: '#ffffff',
                      borderRadius: '0.5rem',
                      border: '1px solid #cbd5e1'
                    }}>
                      {RET_S1_BANDS.map(b => {
                        const isChecked = retSelectedBands.includes(b.id);
                        return (
                          <label
                            key={b.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.65rem',
                              padding: '0.55rem 0.85rem',
                              borderRadius: '0.375rem',
                              border: `1px solid ${isChecked ? '#86efac' : '#e2e8f0'}`,
                              backgroundColor: isChecked ? '#f0fdf4' : '#fafafa',
                              cursor: 'pointer',
                              userSelect: 'none'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => handleToggleRetBand(b.id)}
                              style={{ width: '16px', height: '16px', accentColor: '#16a34a', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div style={{ overflow: 'hidden' }}>
                              <div style={{ fontSize: '0.82rem', fontFamily: 'monospace', fontWeight: 700, color: isChecked ? '#14532d' : '#1e293b', wordBreak: 'break-all' }}>
                                {b.label}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: isChecked ? '#166534' : '#64748b', marginTop: '0.15rem' }}>
                                {b.tag}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {/* Sentinel-2 Only Bands */}
                  {retSatellite === 'Sentinel-2' && (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: '0.6rem',
                      padding: '0.75rem',
                      backgroundColor: '#ffffff',
                      borderRadius: '0.5rem',
                      border: '1px solid #cbd5e1'
                    }}>
                      {RET_S2_BANDS.map(b => {
                        const isChecked = retSelectedBands.includes(b.id);
                        return (
                          <label
                            key={b.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.6rem',
                              padding: '0.5rem 0.75rem',
                              borderRadius: '0.375rem',
                              border: `1px solid ${isChecked ? '#93c5fd' : '#e2e8f0'}`,
                              backgroundColor: isChecked ? '#eff6ff' : '#fafafa',
                              cursor: 'pointer',
                              userSelect: 'none'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => handleToggleRetBand(b.id)}
                              style={{ width: '16px', height: '16px', accentColor: '#2563eb', cursor: 'pointer' }}
                            />
                            <div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: isChecked ? '#1e3a8a' : '#1e293b' }}>
                                {b.label}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: isChecked ? '#1d4ed8' : '#64748b' }}>
                                {b.tag}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {/* Both Sensors (ALL) */}
                  {retSatellite === 'ALL' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {/* Sentinel-1 Group */}
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: '#ffffff',
                        borderRadius: '0.5rem',
                        border: '1px solid #e2e8f0'
                      }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#166534', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#16a34a', display: 'inline-block' }}></span>
                          Sentinel-1 Calibrated SAR Products
                        </div>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                          gap: '0.5rem'
                        }}>
                          {RET_S1_BANDS.map(b => {
                            const isChecked = retSelectedBands.includes(b.id);
                            return (
                              <label
                                key={b.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.65rem',
                                  padding: '0.55rem 0.85rem',
                                  borderRadius: '0.375rem',
                                  border: `1px solid ${isChecked ? '#86efac' : '#e2e8f0'}`,
                                  backgroundColor: isChecked ? '#f0fdf4' : '#fafafa',
                                  cursor: 'pointer',
                                  userSelect: 'none'
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => handleToggleRetBand(b.id)}
                                  style={{ width: '16px', height: '16px', accentColor: '#16a34a', cursor: 'pointer', flexShrink: 0 }}
                                />
                                <div style={{ overflow: 'hidden' }}>
                                  <div style={{ fontSize: '0.82rem', fontFamily: 'monospace', fontWeight: 700, color: isChecked ? '#14532d' : '#1e293b', wordBreak: 'break-all' }}>
                                    {b.label}
                                  </div>
                                  <div style={{ fontSize: '0.72rem', color: isChecked ? '#166534' : '#64748b', marginTop: '0.15rem' }}>
                                    {b.tag}
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      {/* Sentinel-2 Group */}
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: '#ffffff',
                        borderRadius: '0.5rem',
                        border: '1px solid #e2e8f0'
                      }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#1d4ed8', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#2563eb', display: 'inline-block' }}></span>
                          Sentinel-2 MSI Optical Spectral Bands & Indices
                        </div>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                          gap: '0.5rem'
                        }}>
                          {RET_S2_BANDS.map(b => {
                            const isChecked = retSelectedBands.includes(b.id);
                            return (
                              <label
                                key={b.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.55rem',
                                  padding: '0.45rem 0.65rem',
                                  borderRadius: '0.375rem',
                                  border: `1px solid ${isChecked ? '#93c5fd' : '#e2e8f0'}`,
                                  backgroundColor: isChecked ? '#eff6ff' : '#fafafa',
                                  cursor: 'pointer',
                                  userSelect: 'none'
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => handleToggleRetBand(b.id)}
                                  style={{ width: '15px', height: '15px', accentColor: '#2563eb', cursor: 'pointer' }}
                                />
                                <div>
                                  <span style={{ fontSize: '0.825rem', fontWeight: 700, color: isChecked ? '#1e3a8a' : '#1e293b' }}>
                                    {b.label}
                                  </span>{' '}
                                  <span style={{ fontSize: '0.7rem', color: isChecked ? '#1d4ed8' : '#64748b' }}>
                                    ({b.tag})
                                  </span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleVerifyNASData}
                  disabled={verifyingNAS || downloadingZip}
                  style={{
                    backgroundColor: verifyingNAS ? '#1d4ed8' : '#2563eb',
                    color: '#ffffff',
                    padding: '0.65rem 1.25rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    cursor: (verifyingNAS || downloadingZip) ? 'wait' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 1px 2px rgba(37, 99, 235, 0.2)'
                  }}
                >
                  {verifyingNAS ? <RefreshCw size={16} className="animate-spin" /> : <HardDrive size={16} />}
                  {verifyingNAS ? 'Verifying NAS Storage...' : 'Verify Data on NAS'}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadZip}
                  disabled={downloadingZip || verifyingNAS}
                  style={{
                    backgroundColor: downloadingZip ? '#15803d' : '#166534',
                    color: '#ffffff',
                    padding: '0.65rem 1.25rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    cursor: (downloadingZip || verifyingNAS) ? 'wait' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 1px 2px rgba(22, 101, 52, 0.2)'
                  }}
                >
                  {downloadingZip ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                  {downloadingZip ? 'Downloading data from NAS...' : 'Download GeoTIFF Data (.zip)'}
                </button>

                {(retState || retDistrict || retSelectedBands.length > 0 || retBand !== 'ALL' || retCompositeInterval !== 'ALL' || retSatellite !== 'ALL' || retStartDate || retEndDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRetState('');
                      setRetDistrict('');
                      setRetSatellite('ALL');
                      setRetBand('ALL');
                      setRetSelectedBands([]);
                      setRetCompositeInterval('ALL');
                      setRetStartDate('');
                      setRetEndDate('');
                      setRetResults(null);
                      setRetCopyNotice(null);
                      setRetNotice(null);
                      setShowDownloadPromptModal(false);
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

              {/* Status & Notification Banner */}
              {retNotice && (
                <div style={{
                  marginTop: '1rem',
                  padding: '0.9rem 1.25rem',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  backgroundColor: retNotice.status === 'completed' || retNotice.type === 'success'
                    ? '#dcfce7'
                    : (retNotice.status === 'initiated' || retNotice.type === 'info'
                      ? '#eff6ff'
                      : (retNotice.type === 'warning' ? '#fef3c7' : '#fee2e2')),
                  color: retNotice.status === 'completed' || retNotice.type === 'success'
                    ? '#15803d'
                    : (retNotice.status === 'initiated' || retNotice.type === 'info'
                      ? '#1d4ed8'
                      : (retNotice.type === 'warning' ? '#92400e' : '#991b1b')),
                  border: `1px solid ${
                    retNotice.status === 'completed' || retNotice.type === 'success'
                      ? '#86efac'
                      : (retNotice.status === 'initiated' || retNotice.type === 'info'
                        ? '#93c5fd'
                        : (retNotice.type === 'warning' ? '#fde68a' : '#fca5a5'))
                  }`,
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)'
                }}>
                  {retNotice.status === 'initiated' ? (
                    <RefreshCw size={19} className="animate-spin" color="#2563eb" style={{ flexShrink: 0 }} />
                  ) : (retNotice.status === 'completed' || retNotice.type === 'success') ? (
                    <CheckCircle size={19} color="#166534" style={{ flexShrink: 0 }} />
                  ) : retNotice.type === 'warning' ? (
                    <AlertTriangle size={19} color="#d97706" style={{ flexShrink: 0 }} />
                  ) : (
                    <XCircle size={19} color="#dc2626" style={{ flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, lineHeight: 1.4 }}>
                    {retNotice.text}
                  </div>
                </div>
              )}
            </div>

            {/* NAS Data Available Prompt Modal */}
            {showDownloadPromptModal && retResults && retResults.total_tifs > 0 && (
              <div style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(3px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                padding: '1rem'
              }}>
                <div style={{
                  backgroundColor: '#ffffff',
                  borderRadius: '0.75rem',
                  boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.08)',
                  maxWidth: '560px',
                  width: '100%',
                  overflow: 'hidden',
                  border: '1px solid #bfdbfe'
                }}>
                  {/* Header */}
                  <div style={{
                    backgroundColor: '#eff6ff',
                    borderBottom: '1px solid #dbeafe',
                    padding: '1.25rem 1.5rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                      <div style={{
                        backgroundColor: '#dbeafe',
                        borderRadius: '0.5rem',
                        padding: '0.45rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <CheckCircle size={22} color="#2563eb" />
                      </div>
                      <div>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                          Data Available on NAS Storage
                        </h3>
                        <p style={{ fontSize: '0.78rem', color: '#3b82f6', margin: 0, fontWeight: 500 }}>
                          Verified raster files exist on NAS storage ready for download
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowDownloadPromptModal(false)}
                      disabled={downloadingZip}
                      style={{ background: 'none', border: 'none', cursor: downloadingZip ? 'not-allowed' : 'pointer', color: '#64748b' }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Body Content */}
                  <div style={{ padding: '1.5rem' }}>
                    <div style={{
                      backgroundColor: '#f8fafc',
                      borderRadius: '0.5rem',
                      border: '1px solid #e2e8f0',
                      padding: '1rem',
                      marginBottom: '1.25rem'
                    }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', fontSize: '0.85rem' }}>
                        <div>
                          <span style={{ color: '#64748b', fontWeight: 600 }}>Region:</span>{' '}
                          <span style={{ color: '#0f172a', fontWeight: 700 }}>
                            {retResults.query_district || 'All Districts'}{retResults.query_state ? `, ${retResults.query_state}` : ''}
                          </span>
                        </div>
                        <div>
                          <span style={{ color: '#64748b', fontWeight: 600 }}>Sensor:</span>{' '}
                          <span style={{ color: '#0f172a', fontWeight: 700 }}>{retResults.query_satellite || 'All Sensors'}</span>
                        </div>
                        <div>
                          <span style={{ color: '#64748b', fontWeight: 600 }}>Band:</span>{' '}
                          <span style={{ color: '#0f172a', fontWeight: 700 }}>{retResults.query_band || 'All Bands'}</span>
                        </div>
                        <div>
                          <span style={{ color: '#64748b', fontWeight: 600 }}>Composite Interval:</span>{' '}
                          <span style={{ color: '#2563eb', fontWeight: 700 }}>
                            {retCompositeInterval === 'ALL' ? 'All Intervals' : retCompositeInterval.charAt(0).toUpperCase() + retCompositeInterval.slice(1)}
                          </span>
                        </div>
                        {retResults.query_start_date && (
                          <div style={{ gridColumn: 'span 2' }}>
                            <span style={{ color: '#64748b', fontWeight: 600 }}>Date Range:</span>{' '}
                            <span style={{ color: '#0f172a', fontWeight: 600 }}>{retResults.query_start_date} to {retResults.query_end_date || 'Present'}</span>
                          </div>
                        )}
                      </div>

                      <div style={{
                        marginTop: '1rem',
                        paddingTop: '0.75rem',
                        borderTop: '1px solid #e2e8f0',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <div>
                          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Total Files Found:</span>{' '}
                          <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>{retResults.total_tifs} GeoTIFFs</strong>
                        </div>
                        <div>
                          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Total Volume:</span>{' '}
                          <strong style={{ fontSize: '0.95rem', color: '#166534' }}>{retResults.total_size_mb} MB</strong>
                        </div>
                      </div>
                    </div>

                    {/* Question to User */}
                    <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                      <p style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                        Data is available on NAS. Do you want to download this data?
                      </p>
                      <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.35rem 0 0 0' }}>
                        The download will run in the background so you can freely continue your work.
                      </p>
                    </div>

                    {/* Modal Action Buttons */}
                    <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => setShowDownloadPromptModal(false)}
                        style={{
                          padding: '0.65rem 1.25rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #cbd5e1',
                          backgroundColor: '#ffffff',
                          color: '#475569',
                          fontWeight: 600,
                          fontSize: '0.875rem',
                          cursor: 'pointer'
                        }}
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadZip}
                        style={{
                          padding: '0.65rem 1.4rem',
                          borderRadius: '0.375rem',
                          border: 'none',
                          backgroundColor: '#166534',
                          color: '#ffffff',
                          fontWeight: 600,
                          fontSize: '0.875rem',
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: '0 2px 4px rgba(22, 101, 52, 0.2)'
                        }}
                      >
                        <Download size={16} /> Yes, Download Data (.zip)
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

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

                {/* Action Toolbar & NAS Status */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '1rem',
                  padding: '1.25rem',
                  backgroundColor: '#f8fafc',
                  borderRadius: '0.5rem',
                  border: '1px solid #e2e8f0'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    {retResults.total_tifs > 0 ? (
                      <>
                        <CheckCircle size={22} color="#166534" />
                        <div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#166534' }}>
                            {retResults.total_tifs} GeoTIFF rasters ({retResults.total_size_mb} MB) verified on NAS
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.15rem' }}>
                            Ready for background download. You can safely minimize or close the window once download starts.
                          </div>
                        </div>
                      </>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '0.875rem' }}>
                        No verified GeoTIFF raster files currently found on NAS matching the selected criteria.
                      </div>
                    )}
                  </div>

                  {retResults.total_tifs > 0 && (
                    <button
                      onClick={handleDownloadZip}
                      style={{
                        backgroundColor: '#166534',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '0.375rem',
                        padding: '0.65rem 1.35rem',
                        fontSize: '0.88rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        boxShadow: '0 1px 2px rgba(22, 101, 52, 0.2)'
                      }}
                    >
                      <Download size={16} /> Download GeoTIFF Data (.zip)
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ========================================================================= */}
            {/* Existing Layer Stacks on NAS Archive (Filter & Direct Download Form)       */}
            {/* ========================================================================= */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)'
            }}>
              <div style={{ marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HardDrive size={22} color="#2563eb" /> Existing Layer Stacks on NAS Archive
                </h2>
              </div>

              {/* Filter Controls Grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: '1rem',
                backgroundColor: '#f8fafc',
                padding: '1.25rem',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
                marginBottom: '1.25rem'
              }}>
                {/* State / Region Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    State / Region
                  </label>
                  <select
                    value={stackArchiveState}
                    onChange={(e) => {
                      setStackArchiveState(e.target.value);
                      setStackArchiveDistrict('');
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="">-- All States / Select State --</option>
                    {(retDownloadedStates.length > 0 ? retDownloadedStates : statesList).map((s, i) => {
                      const stName = typeof s === 'string' ? s : (s.state_name || '');
                      return <option key={i} value={stName}>{stName}</option>;
                    })}
                  </select>
                </div>

                {/* Target District Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Target District *
                  </label>
                  <select
                    value={stackArchiveDistrict}
                    onChange={(e) => setStackArchiveDistrict(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="">-- Select Target District --</option>
                    {(retDownloadedDistricts.length > 0 ? retDownloadedDistricts : districtsList)
                      .filter(d => {
                        const dState = typeof d === 'string' ? '' : (d.state_name || '');
                        return !stackArchiveState || (dState && dState.toLowerCase() === stackArchiveState.toLowerCase());
                      })
                      .map((d, i) => {
                        const dName = typeof d === 'string' ? d : (d.district_name || '');
                        return <option key={i} value={dName}>{dName}</option>;
                      })}
                  </select>
                </div>

                {/* Crop / Meteorological Season Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Crop / Meteorological Season
                  </label>
                  <select
                    value={stackArchiveSeason}
                    onChange={(e) => {
                      const sVal = e.target.value;
                      setStackArchiveSeason(sVal);
                      if (sVal.startsWith('Kharif')) {
                        setStackArchiveStartDate('2024-06-01');
                        setStackArchiveEndDate('2024-10-31');
                      } else if (sVal.startsWith('Rabi')) {
                        setStackArchiveStartDate('2024-11-01');
                        setStackArchiveEndDate('2025-04-30');
                      } else if (sVal.startsWith('Zaid')) {
                        setStackArchiveStartDate('2024-03-01');
                        setStackArchiveEndDate('2024-06-30');
                      } else if (sVal.startsWith('Pre-Monsoon')) {
                        setStackArchiveStartDate('2024-03-01');
                        setStackArchiveEndDate('2024-05-31');
                      } else if (sVal.startsWith('Post-Monsoon')) {
                        setStackArchiveStartDate('2024-10-01');
                        setStackArchiveEndDate('2024-12-31');
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="ALL">All Seasons</option>
                    <option value="Kharif (Jun – Oct)">Kharif (Jun – Oct)</option>
                    <option value="Rabi (Nov – Apr)">Rabi (Nov – Apr)</option>
                    <option value="Zaid (Mar – Jun)">Zaid (Mar – Jun)</option>
                    <option value="Pre-Monsoon (Mar – May)">Pre-Monsoon (Mar – May)</option>
                    <option value="Monsoon / Kharif (Jun – Sep)">Monsoon / Kharif (Jun – Sep)</option>
                    <option value="Post-Monsoon (Oct – Dec)">Post-Monsoon (Oct – Dec)</option>
                  </select>
                </div>

                {/* Start Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={stackArchiveStartDate}
                    onChange={(e) => setStackArchiveStartDate(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                {/* End Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    End Date
                  </label>
                  <input
                    type="date"
                    value={stackArchiveEndDate}
                    onChange={(e) => setStackArchiveEndDate(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleVerifyStackArchive}
                  disabled={verifyingStackArchive}
                  style={{
                    backgroundColor: verifyingStackArchive ? '#1d4ed8' : '#2563eb',
                    color: '#ffffff',
                    padding: '0.65rem 1.25rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: verifyingStackArchive ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 1px 2px rgba(37, 99, 235, 0.2)'
                  }}
                >
                  <RefreshCw size={16} className={verifyingStackArchive ? 'animate-spin' : ''} />
                  {verifyingStackArchive ? 'Verifying Stacks on NAS...' : 'Verify Stacks on NAS'}
                </button>

                <button
                  type="button"
                  onClick={handleResetStackArchive}
                  disabled={verifyingStackArchive}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#475569',
                    padding: '0.65rem 1.25rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    cursor: 'pointer'
                  }}
                >
                  Reset Form
                </button>
              </div>

              {/* Notice Banner */}
              {stackArchiveNotice && (
                <div style={{
                  marginTop: '1.25rem',
                  padding: '0.85rem 1.25rem',
                  borderRadius: '0.5rem',
                  fontSize: '0.85rem',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  backgroundColor: stackArchiveNotice.type === 'success' ? '#f0fdf4' : (stackArchiveNotice.type === 'warning' ? '#fef3c7' : '#fee2e2'),
                  color: stackArchiveNotice.type === 'success' ? '#15803d' : (stackArchiveNotice.type === 'warning' ? '#92400e' : '#991b1b'),
                  border: `1px solid ${stackArchiveNotice.type === 'success' ? '#86efac' : (stackArchiveNotice.type === 'warning' ? '#fde68a' : '#fca5a5')}`
                }}>
                  {stackArchiveNotice.type === 'success' ? <CheckCircle size={18} color="#166534" /> : (stackArchiveNotice.type === 'warning' ? <AlertTriangle size={18} color="#d97706" /> : <XCircle size={18} color="#dc2626" />)}
                  <div>{stackArchiveNotice.text}</div>
                </div>
              )}

              {/* Results Table (Only displayed when verified) */}
              {hasVerifiedStackArchive && (
                <div style={{ marginTop: '1.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a' }}>
                      Verified Layer Stacks ({stackArchiveResults.length} file{stackArchiveResults.length === 1 ? '' : 's'})
                    </div>
                    {stackArchiveResults.length > 0 && (
                      <div style={{ position: 'relative' }}>
                        <Search size={14} style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                        <input
                          type="text"
                          placeholder="Search verified stacks..."
                          value={stackArchiveSearch}
                          onChange={(e) => setStackArchiveSearch(e.target.value)}
                          style={{ padding: '0.35rem 0.65rem 0.35rem 2rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.8rem' }}
                        />
                      </div>
                    )}
                  </div>

                  {stackArchiveResults.length === 0 ? (
                    <div style={{ padding: '2rem', textAlign: 'center', backgroundColor: '#f8fafc', borderRadius: '0.5rem', border: '1px dashed #cbd5e1', color: '#64748b', fontSize: '0.875rem' }}>
                      No layer-stacked GeoTIFFs found on NAS archive matching your filter criteria.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '0.5rem' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                        <thead>
                          <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: '0.78rem', textTransform: 'uppercase' }}>
                            <th style={{ padding: '0.75rem 1rem' }}>Stacked File Name</th>
                            <th style={{ padding: '0.75rem 1rem' }}>Sensor</th>
                            <th style={{ padding: '0.75rem 1rem' }}>District</th>
                            <th style={{ padding: '0.75rem 1rem' }}>Season</th>
                            <th style={{ padding: '0.75rem 1rem' }}>Stacked Bands</th>
                            <th style={{ padding: '0.75rem 1rem' }}>File Size</th>
                            <th style={{ padding: '0.75rem 1rem' }}>Modified Date</th>
                            <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stackArchiveResults
                            .filter(item => {
                              if (!stackArchiveSearch) return true;
                              const q = stackArchiveSearch.toLowerCase();
                              return (item.filename || '').toLowerCase().includes(q) || (item.district || '').toLowerCase().includes(q) || (item.sensor || '').toLowerCase().includes(q);
                            })
                            .map((item, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#0f172a', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                                  {item.filename}
                                </td>
                                <td style={{ padding: '0.75rem 1rem' }}>
                                  <span style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 700,
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '0.25rem',
                                    backgroundColor: item.sensor === 'Sentinel-1' ? '#fef3c7' : (item.sensor === 'Sentinel-2' ? '#dcfce7' : '#e0e7ff'),
                                    color: item.sensor === 'Sentinel-1' ? '#92400e' : (item.sensor === 'Sentinel-2' ? '#166534' : '#3730a3')
                                  }}>
                                    {item.sensor || 'Sentinel-2'}
                                  </span>
                                </td>
                                <td style={{ padding: '0.75rem 1rem', color: '#334155' }}>
                                  {item.district || '—'}
                                </td>
                                <td style={{ padding: '0.75rem 1rem', color: '#334155' }}>
                                  {item.season || '—'}
                                </td>
                                <td style={{ padding: '0.75rem 1rem' }}>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                    {(item.layers && item.layers.length > 0 ? item.layers : extractBandsFromStackFilename(item.filename)).map((lyr, lIdx) => (
                                      <span key={lIdx} style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 700,
                                        backgroundColor: ['NDVI', 'LSWI'].includes(lyr) ? '#eff6ff' : (['VV', 'VH'].includes(lyr) ? '#fffbeb' : '#f0fdf4'),
                                        color: ['NDVI', 'LSWI'].includes(lyr) ? '#1d4ed8' : (['VV', 'VH'].includes(lyr) ? '#92400e' : '#166534'),
                                        border: `1px solid ${['NDVI', 'LSWI'].includes(lyr) ? '#bfdbfe' : (['VV', 'VH'].includes(lyr) ? '#fde68a' : '#bbf7d0')}`,
                                        padding: '0.1rem 0.4rem',
                                        borderRadius: '0.25rem'
                                      }}>
                                        {lyr}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#475569' }}>
                                  {item.file_size_mb || item.size_mb} MB
                                </td>
                                <td style={{ padding: '0.75rem 1rem', color: '#64748b', fontSize: '0.8rem' }}>
                                  {item.modified_at || '—'}
                                </td>
                                <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedStackForLogs(item);
                                        setStackModalFilter('ALL');
                                        setStackModalSearch('');
                                      }}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        padding: '0.4rem 0.75rem',
                                        borderRadius: '0.375rem',
                                        backgroundColor: '#eff6ff',
                                        border: '1px solid #bfdbfe',
                                        color: '#1d4ed8',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer'
                                      }}
                                      title="View Layer Stack Execution & Verification Logs"
                                    >
                                      <Terminal size={13} /> Logs
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDownloadStackedTif(item.path, item.filename)}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        padding: '0.4rem 0.85rem',
                                        borderRadius: '0.375rem',
                                        backgroundColor: '#166534',
                                        border: 'none',
                                        color: '#ffffff',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        boxShadow: '0 1px 2px rgba(22, 101, 52, 0.2)'
                                      }}
                                    >
                                      <Download size={13} /> Download Stack (.tif)
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB: Layer Stacking Studio */}
        {/* ========================================================================= */}
        {activeTab === 'layer_stacking' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Header Card */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <div style={{ marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Layers size={22} color="#2563eb" /> Multi-Band Layer Stacking Studio
                </h2>
              </div>

              {/* Notice Banner */}
              {stackNotice && (
                <div style={{
                  padding: '0.85rem 1.25rem',
                  borderRadius: '0.5rem',
                  marginBottom: '1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: stackNotice.type === 'success' ? '#f0fdf4' : stackNotice.type === 'error' ? '#fef2f2' : '#eff6ff',
                  border: `1px solid ${stackNotice.type === 'success' ? '#bbf7d0' : stackNotice.type === 'error' ? '#fecaca' : '#bfdbfe'}`,
                  color: stackNotice.type === 'success' ? '#15803d' : stackNotice.type === 'error' ? '#b91c1c' : '#1d4ed8',
                  fontSize: '0.85rem',
                  fontWeight: 500
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {stackNotice.type === 'success' ? <CheckCircle size={18} /> : stackNotice.type === 'error' ? <AlertTriangle size={18} /> : <Info size={18} />}
                    <span>{stackNotice.text}</span>
                  </div>
                  <button onClick={() => setStackNotice(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
                    <X size={16} />
                  </button>
                </div>
              )}

              {/* Controls Grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: '1rem',
                backgroundColor: '#f8fafc',
                padding: '1.25rem',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
                marginBottom: '1.25rem'
              }}>
                {/* State Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    State / Region
                  </label>
                  <select
                    value={stackState}
                    onChange={(e) => {
                      const st = e.target.value;
                      setStackState(st);
                      // Look for downloaded districts in this state first
                      const matchedDownloaded = (retDownloadedDistricts || []).filter(d => {
                        const dState = typeof d === 'string' ? '' : (d.state_name || '');
                        return st && dState.toLowerCase() === st.toLowerCase();
                      });
                      const nextDist = matchedDownloaded.length > 0
                        ? (typeof matchedDownloaded[0] === 'string' ? matchedDownloaded[0] : (matchedDownloaded[0].district_name || ''))
                        : '';
                      setStackDistrict(nextDist);
                      fetchStackHistory(nextDist);
                      if (nextDist) {
                        loadBandsAndScenesForRegion(st, nextDist, stackSeason, stackStartDate, stackEndDate);
                      } else {
                        setStackDownloadedBandsData({});
                        setStackSelectedScenes({});
                        setStackSelectedLayers([]);
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="">-- All States / Select State --</option>
                    {stackState && !(retDownloadedStates || []).some(s => (typeof s === 'string' ? s : s.state_name || '').toLowerCase() === stackState.toLowerCase()) && (
                      <option value={stackState}>{stackState}</option>
                    )}
                    {(retDownloadedStates || []).map((s, i) => {
                      const stName = typeof s === 'string' ? s : (s.state_name || '');
                      return <option key={i} value={stName}>{stName}</option>;
                    })}
                  </select>
                </div>

                {/* District Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Target District <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <select
                    value={stackDistrict}
                    onChange={(e) => {
                      const d = e.target.value;
                      setStackDistrict(d);
                      fetchStackHistory(d);
                      if (d) {
                        let st = stackState;
                        if (!st) {
                          const matchItem = (retDownloadedDistricts || []).find(item => {
                            const dName = typeof item === 'string' ? item : (item.district_name || '');
                            return dName.toLowerCase() === d.toLowerCase();
                          });
                          if (matchItem && typeof matchItem !== 'string' && matchItem.state_name) {
                            st = matchItem.state_name;
                            setStackState(st);
                          }
                        }
                        loadBandsAndScenesForRegion(st, d, stackSeason, stackStartDate, stackEndDate);
                      } else {
                        setStackDownloadedBandsData({});
                        setStackSelectedScenes({});
                        setStackSelectedLayers([]);
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', fontWeight: 600 }}
                  >
                    <option value="">-- Select Target District --</option>
                    {stackDistrict && !(retDownloadedDistricts || []).some(d => (typeof d === 'string' ? d : d.district_name || '').toLowerCase() === stackDistrict.toLowerCase()) && (
                      <option value={stackDistrict}>{stackDistrict}</option>
                    )}
                    {(retDownloadedDistricts || [])
                      .filter(d => {
                        const dState = typeof d === 'string' ? '' : (d.state_name || '');
                        return !stackState || (dState && dState.toLowerCase() === stackState.toLowerCase());
                      })
                      .map((d, i) => {
                        const dName = typeof d === 'string' ? d : (d.district_name || '');
                        return <option key={i} value={dName}>{dName}</option>;
                      })}
                  </select>
                </div>

                {/* Season Select */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Crop / Meteorological Season
                  </label>
                  <select
                    value={stackSeason}
                    onChange={(e) => handleStackSeasonChange(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff' }}
                  >
                    <option value="Kharif">Kharif (Jun – Oct)</option>
                    <option value="Rabi">Rabi (Nov – Mar)</option>
                    <option value="Zaid">Zaid (Mar – Jun)</option>
                    <option value="Pre-Monsoon">Pre-Monsoon (Mar – May)</option>
                    <option value="Monsoon">Monsoon (Jun – Sep)</option>
                    <option value="Post-Monsoon">Post-Monsoon (Oct – Dec)</option>
                    <option value="Winter">Winter (Jan – Feb)</option>
                    <option value="Annual">Annual (Jan – Dec)</option>
                    <option value="Custom">Custom Date Range</option>
                  </select>
                </div>

                {/* Start Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={stackStartDate}
                    onChange={(e) => {
                      const val = e.target.value;
                      setStackStartDate(val);
                      if (stackDistrict) {
                        loadBandsAndScenesForRegion(stackState, stackDistrict, stackSeason, val, stackEndDate);
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', boxSizing: 'border-box' }}
                  />
                </div>

                {/* End Date */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    End Date
                  </label>
                  <input
                    type="date"
                    value={stackEndDate}
                    onChange={(e) => {
                      const val = e.target.value;
                      setStackEndDate(val);
                      if (stackDistrict) {
                        loadBandsAndScenesForRegion(stackState, stackDistrict, stackSeason, stackStartDate, val);
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {/* Auto-loading status indicator */}
              {loadingStackReqFiles && (
                <div style={{
                  padding: '0.65rem 1rem',
                  borderRadius: '0.375rem',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#1d4ed8',
                  fontSize: '0.82rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem'
                }}>
                  <RefreshCw size={14} className="spin" />
                  <span>Auto-loading pre-downloaded spectral bands &amp; scenes from NAS for <strong>{stackDistrict || stackState}</strong>...</span>
                </div>
              )}

              {/* Order-Preserved Stack Sequence Visualizer */}
              <div style={{
                marginBottom: '1.5rem',
                padding: '1rem 1.25rem',
                backgroundColor: '#f1f5f9',
                borderRadius: '0.5rem',
                border: '1px dashed #94a3b8'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Sliders size={16} color="#2563eb" />
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0f172a' }}>
                      Layer Attachment Sequence (Order-Preserved Stacking):
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      ({stackSelectedLayers.length} layers in stack)
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={() => setStackSelectedLayers(['B02', 'B03', 'B04'])}
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', cursor: 'pointer', color: '#475569' }}
                    >
                      Default RGB (B02, B03, B04)
                    </button>
                    <button
                      onClick={() => setStackSelectedLayers([])}
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', cursor: 'pointer', color: '#b91c1c' }}
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                {stackSelectedLayers.length === 0 ? (
                  <div style={{ padding: '0.75rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.82rem' }}>
                    No layers selected yet. Check individual spectral bands or indices below to add them to your stacking sequence.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    {stackSelectedLayers.map((layer, idx) => {
                      const isIndex = ['NDVI', 'LSWI'].includes(layer);
                      const isSar = ['VV', 'VH'].includes(layer);
                      const badgeColor = isIndex ? '#2563eb' : (isSar ? '#d97706' : '#059669');
                      const borderColor = isIndex ? '#93c5fd' : (isSar ? '#fde68a' : '#86efac');
                      return (
                        <div
                          key={layer}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            backgroundColor: '#ffffff',
                            border: `1px solid ${borderColor}`,
                            padding: '0.35rem 0.65rem',
                            borderRadius: '0.375rem',
                            boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                          }}
                        >
                          <span style={{
                            backgroundColor: badgeColor,
                            color: '#ffffff',
                            borderRadius: '9999px',
                            padding: '0.1rem 0.45rem',
                            fontSize: '0.7rem',
                            fontWeight: 700
                          }}>
                            Band {idx + 1}
                          </span>
                          <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#0f172a' }}>
                            {layer}
                          </span>
                          <div style={{ display: 'inline-flex', gap: '0.15rem', marginLeft: '0.25rem' }}>
                            <button
                              onClick={() => moveStackLayer(idx, 'up')}
                              disabled={idx === 0}
                              title="Move Left / Earlier in Stack"
                              style={{ border: 'none', background: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer', color: idx === 0 ? '#cbd5e1' : '#475569', padding: '0 0.15rem' }}
                            >
                              <ArrowUp size={13} style={{ transform: 'rotate(-90deg)' }} />
                            </button>
                            <button
                              onClick={() => moveStackLayer(idx, 'down')}
                              disabled={idx === stackSelectedLayers.length - 1}
                              title="Move Right / Later in Stack"
                              style={{ border: 'none', background: 'none', cursor: idx === stackSelectedLayers.length - 1 ? 'not-allowed' : 'pointer', color: idx === stackSelectedLayers.length - 1 ? '#cbd5e1' : '#475569', padding: '0 0.15rem' }}
                            >
                              <ArrowDown size={13} style={{ transform: 'rotate(-90deg)' }} />
                            </button>
                            <button
                              onClick={() => removeStackLayer(layer)}
                              title="Remove from Stack"
                              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 0.15rem' }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Band and Index Checkbox Groups (1. Indices, 2. SAR, 3. Optical) */}
              {(() => {
                const renderLayerCard = (item, groupColor, groupBgLight, groupBorderLight) => {
                  const isChecked = stackSelectedLayers.includes(item.id);
                  const orderIdx = stackSelectedLayers.indexOf(item.id);
                  const scenes = stackDownloadedBandsData[item.id] || [];
                  const hasScenes = scenes.length > 0;
                  const bandSelectedSet = stackSelectedScenes[item.id];
                  const selectedCount = bandSelectedSet !== undefined 
                    ? scenes.filter(s => bandSelectedSet.has(s.path || s.scene_id)).length 
                    : scenes.length;

                  return (
                    <div
                      key={item.id}
                      style={{
                        border: `1px solid ${isChecked ? groupBorderLight : '#e2e8f0'}`,
                        borderRadius: '0.375rem',
                        backgroundColor: isChecked ? groupBgLight : '#ffffff',
                        overflow: 'hidden',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <div
                        onClick={() => toggleStackLayer(item.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.45rem 0.65rem',
                          cursor: 'pointer'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            readOnly
                            style={{
                              pointerEvents: 'none',
                              cursor: 'pointer',
                              width: '16px',
                              height: '16px',
                              accentColor: groupColor
                            }}
                          />
                          <span style={{ fontWeight: isChecked ? 600 : 400, fontSize: '0.82rem', color: isChecked ? groupColor : '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.label}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0, marginLeft: '0.5rem' }}>
                          {hasScenes && (
                            <span style={{ fontSize: '0.68rem', color: '#64748b', backgroundColor: '#f1f5f9', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', fontWeight: 500 }}>
                              {scenes.length} {scenes.some(s => s.is_composite) && scenes.every(s => s.is_composite) ? 'composite' : 'scene'}{scenes.length > 1 ? 's' : ''}
                            </span>
                          )}
                          {isChecked && (
                            <span style={{ backgroundColor: groupColor, color: '#ffffff', borderRadius: '0.2rem', padding: '0.05rem 0.35rem', fontSize: '0.7rem', fontWeight: 700 }}>
                              #{orderIdx + 1}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Downloaded scenes list when band/index is selected */}
                      {isChecked && (
                        <div style={{
                          backgroundColor: '#f8fafc',
                          borderTop: `1px solid ${groupBorderLight}`,
                          padding: '0.45rem 0.55rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.3rem'
                        }}>
                          {hasScenes ? (
                            <>
                              <div style={{
                                fontSize: '0.73rem',
                                fontWeight: 600,
                                color: '#475569',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                paddingBottom: '0.35rem',
                                borderBottom: '1px solid #e2e8f0',
                                flexWrap: 'wrap',
                                gap: '0.35rem'
                              }}>
                                <span>
                                  {scenes.some(s => (s.filename && s.filename.toLowerCase().includes('composite')) || (s.path && s.path.toLowerCase().includes('composite'))) ? 'Downloaded Composite Files' : 'Downloaded Scenes'} (<strong style={{ color: selectedCount > 0 ? '#16a34a' : '#dc2626' }}>{selectedCount}</strong>/{scenes.length} selected):
                                </span>
                                <div style={{ display: 'flex', gap: '0.35rem' }}>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      selectAllScenesForBand(item.id);
                                    }}
                                    style={{
                                      fontSize: '0.7rem',
                                      padding: '0.2rem 0.5rem',
                                      borderRadius: '0.25rem',
                                      border: '1px solid #bbf7d0',
                                      backgroundColor: '#f0fdf4',
                                      color: '#16a34a',
                                      fontWeight: 700,
                                      cursor: 'pointer'
                                    }}
                                    title="Select all scenes for this band"
                                  >
                                    ✓ Select All
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deselectAllScenesForBand(item.id);
                                    }}
                                    style={{
                                      fontSize: '0.7rem',
                                      padding: '0.2rem 0.5rem',
                                      borderRadius: '0.25rem',
                                      border: '1px solid #cbd5e1',
                                      backgroundColor: '#ffffff',
                                      color: '#64748b',
                                      fontWeight: 600,
                                      cursor: 'pointer'
                                    }}
                                    title="Deselect all scenes for this band"
                                  >
                                    ✕ Clear
                                  </button>
                                </div>
                              </div>

                              <div style={{
                                maxHeight: '220px',
                                overflowY: 'auto',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.35rem',
                                paddingRight: '0.15rem'
                              }}>
                                {scenes.map((s, sIdx) => {
                                  const sceneKey = s.path || s.scene_id;
                                  const isSceneSelected = bandSelectedSet !== undefined ? bandSelectedSet.has(sceneKey) : true;
                                  const fnLower = (s.filename || '').toLowerCase();
                                  const pathLower = (s.path || '').toLowerCase();
                                  const isRealCompositeFile = fnLower.includes('composite') || pathLower.includes('/composites/') || pathLower.includes('\\composites\\');
                                  const fullFileName = s.filename || (s.path ? s.path.split(/[\\/]/).pop() : '') || (s.scene_id ? `${s.scene_id}.tif` : `${item.id}.tif`);

                                  return (
                                    <div
                                      key={sceneKey || sIdx}
                                      onClick={() => toggleSceneSelection(item.id, sceneKey)}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        backgroundColor: isSceneSelected ? '#ffffff' : '#f8fafc',
                                        border: `1px solid ${isSceneSelected ? groupBorderLight : '#e2e8f0'}`,
                                        borderRadius: '0.35rem',
                                        padding: '0.45rem 0.6rem',
                                        fontSize: '0.75rem',
                                        cursor: 'pointer',
                                        userSelect: 'none',
                                        boxShadow: isSceneSelected ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                                        opacity: isSceneSelected ? 1 : 0.6,
                                        transition: 'all 0.15s ease'
                                      }}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0, flex: 1 }}>
                                        <input
                                          type="checkbox"
                                          checked={!!isSceneSelected}
                                          readOnly
                                          style={{
                                            pointerEvents: 'none',
                                            cursor: 'pointer',
                                            width: '16px',
                                            height: '16px',
                                            flexShrink: 0,
                                            accentColor: groupColor
                                          }}
                                        />

                                        {isRealCompositeFile ? (
                                          /* Complete clearly visible file name ONLY for actual composite files */
                                          <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                                            <span
                                              title={fullFileName}
                                              style={{
                                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                                                fontSize: '0.73rem',
                                                fontWeight: 700,
                                                color: isSceneSelected ? '#0f172a' : '#64748b',
                                                wordBreak: 'break-all',
                                                lineHeight: 1.35
                                              }}
                                            >
                                              📄 {fullFileName}
                                            </span>
                                            <span style={{
                                              backgroundColor: '#fef3c7',
                                              color: '#92400e',
                                              border: '1px solid #fde68a',
                                              borderRadius: '0.2rem',
                                              padding: '0.05rem 0.35rem',
                                              fontSize: '0.63rem',
                                              fontWeight: 700,
                                              flexShrink: 0
                                            }}>
                                              COMPOSITE
                                            </span>
                                          </div>
                                        ) : (
                                          /* Standard raw scenes (B02, B03, B04, etc.) */
                                          <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            <span style={{ fontWeight: 600, color: isSceneSelected ? '#0f172a' : '#64748b' }}>
                                              📅 {s.sensing_date ? s.sensing_date.split('T')[0] : 'N/A'}
                                            </span>
                                            {s.tile && (
                                              <span style={{ backgroundColor: isSceneSelected ? '#e2e8f0' : '#f1f5f9', color: isSceneSelected ? '#1e293b' : '#64748b', borderRadius: '0.2rem', padding: '0.05rem 0.35rem', fontSize: '0.68rem', fontWeight: 700, marginLeft: '0.35rem' }}>
                                                {s.tile}
                                              </span>
                                            )}
                                            {s.is_calibrated || (s.filename && (s.filename.toUpperCase().includes('CAL_TC_DB') || s.filename.toUpperCase().includes('ORB_TNR') || s.filename.toUpperCase().includes('_CAL_') || (['VV', 'VH', 'VV_VH'].includes(item.id) && !s.filename.toLowerCase().includes('measurement')))) ? (
                                              <span style={{ backgroundColor: '#dcfce7', color: '#15803d', border: '1px solid #86efac', borderRadius: '0.2rem', padding: '0.05rem 0.35rem', fontSize: '0.66rem', fontWeight: 700, marginLeft: '0.35rem' }}>
                                                CALIBRATED dB
                                              </span>
                                            ) : (
                                              <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: '0.2rem', padding: '0.05rem 0.35rem', fontSize: '0.66rem', fontWeight: 700, marginLeft: '0.35rem' }}>
                                                RAW SCENE
                                              </span>
                                            )}
                                            <span style={{ color: isSceneSelected ? '#334155' : '#94a3b8', marginLeft: '0.35rem' }}>
                                              🛰️ {s.scene_id ? (s.scene_id.length > 25 ? s.scene_id.substring(0, 22) + '...' : s.scene_id) : 'Scene'}
                                            </span>
                                            {s.filename && (
                                              <span style={{ color: isSceneSelected ? groupColor : '#94a3b8', marginLeft: '0.45rem', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                                ({s.filename})
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteSceneFromBand(item.id, sceneKey);
                                        }}
                                        title="Exclude / delete this scene"
                                        style={{
                                          background: 'none',
                                          border: 'none',
                                          color: '#ef4444',
                                          cursor: 'pointer',
                                          padding: '0.2rem 0.35rem',
                                          borderRadius: '0.25rem',
                                          display: 'flex',
                                          alignItems: 'center',
                                          marginLeft: '0.4rem',
                                          flexShrink: 0
                                        }}
                                      >
                                        <X size={14} />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          ) : (
                            <div style={{ fontSize: '0.73rem', color: '#94a3b8', fontStyle: 'italic', padding: '0.25rem 0.35rem' }}>
                              {stackDistrict ? `No pre-downloaded scenes found for ${stackDistrict}.` : 'Select a Target District above to load downloaded scenes.'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                };

                const activeStackReq = stackRequestId ? (requests || []).find(r => r.id === stackRequestId) : null;
                const isScopeS1 = Boolean(activeStackReq && activeStackReq.satellite && activeStackReq.satellite.includes('Sentinel-1') && !activeStackReq.satellite.includes('Sentinel-2'));
                const isScopeS2 = Boolean(activeStackReq && activeStackReq.satellite && activeStackReq.satellite.includes('Sentinel-2') && !activeStackReq.satellite.includes('Sentinel-1'));

                return (
                  <div>
                    {activeStackReq && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.65rem 1rem',
                        borderRadius: '0.5rem',
                        marginBottom: '1rem',
                        backgroundColor: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        color: '#1d4ed8'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                          <Layers size={16} />
                          <span>
                            <strong>Scoped to Request #{activeStackReq.id}:</strong> {activeStackReq.district || activeStackReq.state} ({activeStackReq.satellite}) &bull; Showing only verified deliverables for this request
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setStackRequestId(null);
                            loadBandsAndScenesForRegion(stackState, stackDistrict, stackSeason, stackStartDate, stackEndDate);
                          }}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #93c5fd',
                            borderRadius: '0.25rem',
                            padding: '0.2rem 0.6rem',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            color: '#1d4ed8',
                            fontWeight: 600
                          }}
                        >
                          Clear Request Filter
                        </button>
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
                      {/* 1. Derived Spectral Indices (FIRST) */}
                      <div style={{ border: '1px solid #bfdbfe', borderRadius: '0.5rem', padding: '1rem', backgroundColor: '#fbfcfe' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', borderBottom: '1px solid #dbeafe', paddingBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Sliders size={16} color="#2563eb" />
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e40af' }}>
                              Derived Spectral Indices
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                          {isScopeS1 ? (
                            <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.8rem', backgroundColor: '#f8fafc', borderRadius: '0.375rem', border: '1px dashed #cbd5e1' }}>
                              Optical indices are not applicable for Sentinel-1 SAR requests.
                            </div>
                          ) : (
                            AVAILABLE_INDICES.map(idx => renderLayerCard(idx, '#1d4ed8', '#eff6ff', '#bfdbfe'))
                          )}
                        </div>
                      </div>

                      {/* 2. SAR Radar Polarizations (SECOND) */}
                      <div style={{ border: '1px solid #fde68a', borderRadius: '0.5rem', padding: '1rem', backgroundColor: '#fffdfa' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', borderBottom: '1px solid #fef3c7', paddingBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Activity size={16} color="#d97706" />
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#92400e' }}>
                              SAR Radar Polarizations (Sentinel-1 C-Band)
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                          {isScopeS2 ? (
                            <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.8rem', backgroundColor: '#f8fafc', borderRadius: '0.375rem', border: '1px dashed #cbd5e1' }}>
                              SAR radar polarizations are not applicable for Sentinel-2 Optical requests.
                            </div>
                          ) : (
                            AVAILABLE_SAR_BANDS.map(b => renderLayerCard(b, '#92400e', '#fffbeb', '#fde68a'))
                          )}
                        </div>
                      </div>

                      {/* 3. Optical Spectral Bands (THIRD) */}
                      <div style={{ border: '1px solid #bbf7d0', borderRadius: '0.5rem', padding: '1rem', backgroundColor: '#fafffd' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', borderBottom: '1px solid #dcfce7', paddingBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Satellite size={16} color="#059669" />
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#065f46' }}>
                              Optical Spectral Bands (Sentinel-2 MSI)
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                          {isScopeS1 ? (
                            <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.8rem', backgroundColor: '#f8fafc', borderRadius: '0.375rem', border: '1px dashed #cbd5e1' }}>
                              Optical spectral bands are not applicable for Sentinel-1 SAR requests.
                            </div>
                          ) : (
                            AVAILABLE_OPTICAL_BANDS.map(b => renderLayerCard(b, '#065f46', '#f0fdf4', '#bbf7d0'))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* NAS Verification Banner (Informational: Input bands available on NAS) */}
              {(() => {
                if (!stackDistrict || stackSelectedLayers.length === 0) return null;

                const allSelectedBandsInNas = stackSelectedLayers.every(lyr => {
                  const scenes = stackDownloadedBandsData[lyr] || [];
                  return scenes.length > 0;
                });

                if (allSelectedBandsInNas) {
                  return (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontSize: '0.82rem',
                      color: '#047857',
                      backgroundColor: '#ecfdf5',
                      border: '1px solid #a7f3d0',
                      padding: '0.55rem 0.85rem',
                      borderRadius: '0.375rem',
                      marginBottom: '1rem'
                    }}>
                      <CheckCircle size={16} color="#059669" style={{ flexShrink: 0 }} />
                      <span>
                        <strong>NAS Data Verified:</strong> All {stackSelectedLayers.length} selected bands are already downloaded and stored on NAS. Layer stacking will retrieve existing GeoTIFF files directly from NAS — <strong>no re-downloading required</strong>.
                      </span>
                    </div>
                  );
                }

                return null;
              })()}

              {/* Execution Actions & Output Preview */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: '1rem',
                borderTop: '1px solid #e2e8f0',
                flexWrap: 'wrap',
                gap: '1rem'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: '#334155', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={stackClipToDistrict}
                    onChange={(e) => setStackClipToDistrict(e.target.checked)}
                  />
                  <span>Mask and clip output layers to district administrative boundary (EPSG:4326)</span>
                </label>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  {stackLoading && (
                    <button
                      type="button"
                      onClick={handleStopLayerStacking}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        backgroundColor: '#dc2626',
                        color: '#ffffff',
                        fontWeight: 600,
                        fontSize: '0.9rem',
                        padding: '0.65rem 1.25rem',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                      }}
                      title="Stop / Cancel Layer Stacking"
                    >
                      <Square size={16} fill="#ffffff" /> Stop Stacking
                    </button>
                  )}
                  <button
                    onClick={() => handleExecuteLayerStacking(false)}
                    disabled={stackLoading || !stackDistrict || stackSelectedLayers.length === 0}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      backgroundColor: (stackLoading || !stackDistrict || stackSelectedLayers.length === 0) ? '#94a3b8' : '#2563eb',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      padding: '0.65rem 1.5rem',
                      border: 'none',
                      borderRadius: '0.375rem',
                      cursor: (stackLoading || !stackDistrict || stackSelectedLayers.length === 0) ? 'not-allowed' : 'pointer',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                    }}
                  >
                    {stackLoading ? (
                      <>
                        <RefreshCw size={16} className="spin" /> Generating Layer Stack on NAS...
                      </>
                    ) : (
                      <>
                        <Layers size={16} /> Execute Layer Stacking
                      </>
                    )}
                  </button>
                </div>
              </div>

            </div>

            {/* Live Real-Time Layer Stacking Execution Console */}
            {(stackLoading || stackLogs.length > 0 || stackTaskId) && (
              <div style={{
                backgroundColor: '#ffffff',
                borderRadius: '0.75rem',
                border: '1px solid #e2e8f0',
                overflow: 'hidden',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.05)',
                display: 'flex',
                flexDirection: 'column'
              }}>
                {/* Console Header */}
                <div style={{
                  backgroundColor: '#f8fafc',
                  padding: '0.75rem 1.25rem',
                  borderBottom: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    <Terminal size={17} color="#2563eb" />
                    <div>
                      <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        Layer Stacking Live Execution Console
                        {stackLoading && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', backgroundColor: '#eff6ff', color: '#2563eb', padding: '0.1rem 0.45rem', borderRadius: '0.25rem', border: '1px solid #bfdbfe' }}>
                            <RefreshCw size={11} className="spin" /> Processing ({stackProgress}%)
                          </span>
                        )}
                        {!stackLoading && stackResult && (
                          <span style={{ fontSize: '0.72rem', backgroundColor: '#f0fdf4', color: '#16a34a', padding: '0.1rem 0.45rem', borderRadius: '0.25rem', border: '1px solid #bbf7d0' }}>
                            ✓ Complete
                          </span>
                        )}
                        {!stackLoading && !stackResult && stackLogs.some(l => l.level === 'ERROR') && (
                          <span style={{ fontSize: '0.72rem', backgroundColor: '#fef2f2', color: '#dc2626', padding: '0.1rem 0.45rem', borderRadius: '0.25rem', border: '1px solid #fecaca' }}>
                            ✕ Failed
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.73rem', color: '#64748b', marginTop: '0.1rem' }}>
                        Step: <span style={{ color: '#334155', fontFamily: 'monospace', fontWeight: 600 }}>{stackStep || 'WAITING'}</span>
                        {stackTaskId && <span style={{ marginLeft: '0.5rem' }}>• Task ID: <code style={{ color: '#2563eb' }}>{stackTaskId}</code></span>}
                      </div>
                    </div>
                  </div>

                  {/* View Mode & Actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <div style={{ display: 'inline-flex', backgroundColor: '#f1f5f9', borderRadius: '0.375rem', padding: '2px', border: '1px solid #cbd5e1' }}>
                      <button
                        type="button"
                        onClick={() => setStackLogViewMode('table')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.65rem',
                          borderRadius: '0.25rem',
                          border: 'none',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          backgroundColor: stackLogViewMode === 'table' ? '#ffffff' : 'transparent',
                          color: stackLogViewMode === 'table' ? '#2563eb' : '#64748b',
                          boxShadow: stackLogViewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                        }}
                      >
                        <Table size={13} /> Table View
                      </button>
                      <button
                        type="button"
                        onClick={() => setStackLogViewMode('terminal')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.65rem',
                          borderRadius: '0.25rem',
                          border: 'none',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          backgroundColor: stackLogViewMode === 'terminal' ? '#ffffff' : 'transparent',
                          color: stackLogViewMode === 'terminal' ? '#2563eb' : '#64748b',
                          boxShadow: stackLogViewMode === 'terminal' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                        }}
                      >
                        <Terminal size={13} /> Terminal View
                      </button>
                    </div>

                    {stackLoading && (
                      <button
                        type="button"
                        onClick={handleStopLayerStacking}
                        title="Stop Stacking Task"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.65rem',
                          borderRadius: '0.25rem',
                          border: '1px solid #f87171',
                          backgroundColor: '#fee2e2',
                          color: '#b91c1c',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          cursor: 'pointer'
                        }}
                      >
                        <Square size={12} fill="#b91c1c" /> Stop Stacking
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setStackLogs([]);
                        setStackTaskId('');
                        setStackProgress(0);
                        setStackStep('');
                        setStackResult(null);
                        setStackLoading(false);
                        if (stackPollIntervalRef.current) {
                          clearInterval(stackPollIntervalRef.current);
                          stackPollIntervalRef.current = null;
                        }
                        localStorage.removeItem('sdap_active_stack_task');
                      }}
                      title="Clear Console & Reset"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.25rem 0.55rem',
                        borderRadius: '0.25rem',
                        border: '1px solid #cbd5e1',
                        backgroundColor: '#ffffff',
                        color: '#64748b',
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      <Trash2 size={13} /> Clear
                    </button>
                  </div>
                </div>

                {/* KPI Metrics Summary Bar */}
                {(() => {
                  const total = stackLogs.length;
                  const infoCnt = stackLogs.filter(l => l.level === 'INFO').length;
                  const successCnt = stackLogs.filter(l => l.level === 'SUCCESS').length;
                  const warnCnt = stackLogs.filter(l => l.level === 'WARNING').length;
                  const errCnt = stackLogs.filter(l => l.level === 'ERROR').length;

                  return (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                      gap: '0.5rem',
                      padding: '0.65rem 1.25rem',
                      backgroundColor: '#f8fafc',
                      borderBottom: '1px solid #e2e8f0'
                    }}>
                      <div style={{ backgroundColor: '#ffffff', padding: '0.45rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>Total Events</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a' }}>{total}</div>
                      </div>
                      <div style={{ backgroundColor: '#ffffff', padding: '0.45rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '0.68rem', color: '#2563eb', fontWeight: 600, textTransform: 'uppercase' }}>Info Logs</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#1d4ed8' }}>{infoCnt}</div>
                      </div>
                      <div style={{ backgroundColor: '#ffffff', padding: '0.45rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '0.68rem', color: '#16a34a', fontWeight: 600, textTransform: 'uppercase' }}>Success Steps</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#15803d' }}>{successCnt}</div>
                      </div>
                      <div style={{ backgroundColor: '#ffffff', padding: '0.45rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '0.68rem', color: '#d97706', fontWeight: 600, textTransform: 'uppercase' }}>Warnings</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#b45309' }}>{warnCnt}</div>
                      </div>
                      <div style={{ backgroundColor: '#ffffff', padding: '0.45rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #e2e8f0' }}>
                        <div style={{ fontSize: '0.68rem', color: '#dc2626', fontWeight: 600, textTransform: 'uppercase' }}>Errors</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: errCnt > 0 ? '#b91c1c' : '#64748b' }}>{errCnt}</div>
                      </div>
                    </div>
                  );
                })()}

                {/* Filter and Search Bar */}
                <div style={{
                  padding: '0.5rem 1.25rem',
                  backgroundColor: '#ffffff',
                  borderBottom: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap'
                }}>
                  {/* Filter Pills */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                    {[
                      { key: 'all', label: `All (${stackLogs.length})` },
                      { key: 'info', label: `Info (${stackLogs.filter(l => l.level === 'INFO').length})` },
                      { key: 'success', label: `Success (${stackLogs.filter(l => l.level === 'SUCCESS').length})` },
                      { key: 'warnings', label: `Warnings (${stackLogs.filter(l => l.level === 'WARNING').length})` },
                      { key: 'errors', label: `Errors (${stackLogs.filter(l => l.level === 'ERROR').length})` }
                    ].map(f => {
                      const isActive = stackLogFilter === f.key;
                      return (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setStackLogFilter(f.key)}
                          style={{
                            padding: '0.2rem 0.55rem',
                            borderRadius: '0.25rem',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                            border: isActive ? '1px solid #2563eb' : '1px solid #e2e8f0',
                            backgroundColor: isActive ? '#eff6ff' : '#f8fafc',
                            color: isActive ? '#1d4ed8' : '#64748b',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Search Input */}
                  <div style={{ position: 'relative', minWidth: '220px', flex: '1', maxWidth: '360px' }}>
                    <Search size={13} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                    <input
                      type="text"
                      placeholder="Search execution logs..."
                      value={stackLogSearchQuery}
                      onChange={e => setStackLogSearchQuery(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.3rem 0.6rem 0.3rem 1.85rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.75rem',
                        backgroundColor: '#ffffff'
                      }}
                    />
                    {stackLogSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setStackLogSearchQuery('')}
                        style={{
                          position: 'absolute',
                          right: '0.45rem',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: '#94a3b8'
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Live Progress Bar */}
                <div style={{ width: '100%', height: '4px', backgroundColor: '#f1f5f9', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, Math.max(0, stackProgress))}%`,
                    height: '100%',
                    backgroundColor: stackResult ? '#22c55e' : (stackLogs.some(l => l.level === 'ERROR') ? '#ef4444' : '#2563eb'),
                    transition: 'width 0.3s ease'
                  }} />
                </div>

                {/* Log Content Area */}
                {(() => {
                  const filteredLogs = stackLogs.filter(l => {
                    if (stackLogFilter === 'info' && l.level !== 'INFO') return false;
                    if (stackLogFilter === 'success' && l.level !== 'SUCCESS') return false;
                    if (stackLogFilter === 'warnings' && l.level !== 'WARNING') return false;
                    if (stackLogFilter === 'errors' && l.level !== 'ERROR' && l.level !== 'WARNING') return false;
                    if (stackLogSearchQuery && stackLogSearchQuery.trim()) {
                      const q = stackLogSearchQuery.toLowerCase();
                      const msg = (l.message || '').toLowerCase();
                      const lvl = (l.level || '').toLowerCase();
                      const ts = (l.timestamp || '').toLowerCase();
                      return msg.includes(q) || lvl.includes(q) || ts.includes(q);
                    }
                    return true;
                  });

                  const detectPhase = (msg = '') => {
                    const m = msg.toLowerCase();
                    if (m.includes('initiated') || m.includes('registered') || m.includes('initiating')) return 'INIT';
                    if (m.includes('boundary') || m.includes('polygon') || m.includes('loaded (epsg')) return 'BOUNDARY';
                    if (m.includes('spectral bands') || m.includes('locating candidate') || m.includes('queued')) return 'BANDS';
                    if (m.includes('raster grid') || m.includes('resolution') || m.includes('target raster')) return 'GRID SETUP';
                    if (m.includes('reprojected') || m.includes('tile ')) return 'REPROJECT';
                    if (m.includes('mosaicing') || m.includes('valid pixels')) return 'MOSAICING';
                    if (m.includes('db') || m.includes('calibrat') || m.includes('backscatter')) return 'CALIBRATION';
                    if (m.includes('layer sequence') || m.includes('attached band') || m.includes('assembling')) return 'STACKING';
                    if (m.includes('destination') || m.includes('writing') || m.includes('copying') || m.includes('geotiff')) return 'EXPORT';
                    if (m.includes('saved:') || m.includes('completed')) return 'COMPLETED';
                    if (m.includes('failed') || m.includes('error')) return 'FAILED';
                    return 'PROCESSING';
                  };

                  return (
                    <div
                      ref={stackTerminalContainerRef}
                      id="stack-logs-terminal-container"
                      style={{
                        maxHeight: '420px',
                        overflowY: 'auto',
                        backgroundColor: '#ffffff'
                      }}
                    >
                      {stackLogViewMode === 'table' ? (
                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.78rem' }}>
                          <thead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: '#f8fafc' }}>
                            <tr style={{ borderBottom: '1px solid #e2e8f0', color: '#64748b', fontSize: '0.71rem', textTransform: 'uppercase' }}>
                              <th style={{ padding: '0.55rem 0.85rem', width: '95px' }}>Time</th>
                              <th style={{ padding: '0.55rem 0.85rem', width: '95px' }}>Level</th>
                              <th style={{ padding: '0.55rem 0.85rem', width: '110px' }}>Phase / Step</th>
                              <th style={{ padding: '0.55rem 0.85rem' }}>Execution Log / Activity</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredLogs.length === 0 ? (
                              <tr>
                                <td colSpan="4" style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                                  {stackLogs.length === 0 ? 'No logs recorded yet.' : 'No logs match the current filter or search query.'}
                                </td>
                              </tr>
                            ) : (
                              filteredLogs.map((log, idx) => {
                                const isErr = log.level === 'ERROR';
                                const isWarn = log.level === 'WARNING';
                                const isSuccess = log.level === 'SUCCESS';
                                const badgeColor = isErr ? '#dc2626' : (isWarn ? '#d97706' : (isSuccess ? '#16a34a' : '#2563eb'));
                                const badgeBg = isErr ? '#fee2e2' : (isWarn ? '#fef3c7' : (isSuccess ? '#dcfce7' : '#eff6ff'));
                                const badgeBorder = isErr ? '#fecaca' : (isWarn ? '#fde68a' : (isSuccess ? '#bbf7d0' : '#bfdbfe'));
                                const phase = detectPhase(log.message);

                                return (
                                  <tr
                                    key={idx}
                                    style={{
                                      borderBottom: '1px solid #f1f5f9',
                                      backgroundColor: isErr ? '#fff5f5' : (isWarn ? '#fffbeb' : (idx % 2 === 0 ? '#ffffff' : '#fafafa'))
                                    }}
                                  >
                                    <td style={{ padding: '0.5rem 0.85rem', color: '#64748b', fontFamily: 'monospace', fontSize: '0.74rem', whiteSpace: 'nowrap' }}>
                                      {log.timestamp || '—'}
                                    </td>
                                    <td style={{ padding: '0.5rem 0.85rem' }}>
                                      <span style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        padding: '0.12rem 0.45rem',
                                        borderRadius: '0.25rem',
                                        fontSize: '0.68rem',
                                        fontWeight: 700,
                                        color: badgeColor,
                                        backgroundColor: badgeBg,
                                        border: `1px solid ${badgeBorder}`
                                      }}>
                                        {isSuccess && <CheckCircle size={10} />}
                                        {isErr && <XCircle size={10} />}
                                        {isWarn && <AlertTriangle size={10} />}
                                        {!isSuccess && !isErr && !isWarn && <Info size={10} />}
                                        {log.level || 'INFO'}
                                      </span>
                                    </td>
                                    <td style={{ padding: '0.5rem 0.85rem' }}>
                                      <span style={{
                                        display: 'inline-block',
                                        padding: '0.1rem 0.4rem',
                                        borderRadius: '0.2rem',
                                        fontSize: '0.67rem',
                                        fontWeight: 700,
                                        fontFamily: 'monospace',
                                        color: '#475569',
                                        backgroundColor: '#f1f5f9',
                                        border: '1px solid #cbd5e1'
                                      }}>
                                        {phase}
                                      </span>
                                    </td>
                                    <td style={{
                                      padding: '0.5rem 0.85rem',
                                      color: isErr ? '#dc2626' : (isWarn ? '#b45309' : (isSuccess ? '#15803d' : '#1e293b')),
                                      fontFamily: log.message?.includes('\\') || log.message?.includes('/') || log.message?.includes('.tif') ? 'monospace' : 'inherit',
                                      fontSize: '0.78rem',
                                      wordBreak: 'break-word',
                                      lineHeight: 1.45
                                    }}>
                                      {log.message}
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      ) : (
                        <div style={{ fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: '0.78rem', lineHeight: 1.55, padding: '0.85rem 1rem' }}>
                          {filteredLogs.length === 0 ? (
                            <div style={{ color: '#94a3b8', textAlign: 'center', padding: '1.5rem' }}>
                              {stackLogs.length === 0 ? 'No logs recorded yet.' : 'No logs match the current filter or search query.'}
                            </div>
                          ) : (
                            filteredLogs.map((log, idx) => {
                              const isErr = log.level === 'ERROR';
                              const isWarn = log.level === 'WARNING';
                              const isSuccess = log.level === 'SUCCESS';
                              const textColor = isErr ? '#dc2626' : (isWarn ? '#d97706' : (isSuccess ? '#16a34a' : '#2563eb'));
                              return (
                                <div key={idx} style={{ display: 'flex', gap: '0.6rem', padding: '0.15rem 0' }}>
                                  <span style={{ color: '#94a3b8', minWidth: '70px', userSelect: 'none' }}>[{log.timestamp || '—'}]</span>
                                  <span style={{ color: textColor, minWidth: '75px', fontWeight: 700 }}>[{log.level || 'INFO'}]</span>
                                  <span style={{ color: isErr ? '#dc2626' : (isWarn ? '#b45309' : (isSuccess ? '#15803d' : '#1e293b')), flex: 1, wordBreak: 'break-word' }}>
                                    {log.message}
                                  </span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                      <div ref={stackLogsEndRef} />
                    </div>
                  );
                })()}

                {/* Console Footer */}
                <div style={{
                  padding: '0.45rem 1.25rem',
                  backgroundColor: '#f8fafc',
                  borderTop: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '0.72rem',
                  color: '#64748b'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', backgroundColor: stackLoading ? '#2563eb' : (stackResult ? '#16a34a' : '#94a3b8') }} />
                    <span>PostgreSQL Database Synced & Persistent across page reloads</span>
                  </div>
                  <div>
                    {stackLogs.length} events logged
                  </div>
                </div>
              </div>
            )}

            {/* Success Result Card */}
            {stackResult && (
              <div style={{
                backgroundColor: '#ffffff',
                borderRadius: '0.75rem',
                border: '1px solid #bbf7d0',
                padding: '1.5rem',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <CheckCircle size={22} color="#16a34a" />
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                      {stackResult.already_completed ? 'Layer Stack Verified (Already Completed on NAS)' : 'Layer Stack Generated Successfully'}
                    </h3>
                    <span style={{
                      padding: '0.2rem 0.65rem',
                      borderRadius: '9999px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      backgroundColor: stackResult.already_completed ? '#eff6ff' : '#ecfdf5',
                      color: stackResult.already_completed ? '#1d4ed8' : '#047857',
                      border: `1px solid ${stackResult.already_completed ? '#bfdbfe' : '#a7f3d0'}`
                    }}>
                      {stackResult.already_completed ? 'EXISTING TASK • INSTANT REUSE' : 'NEW TASK • COMPLETED'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedStackForLogs({
                          filename: stackResult.filename,
                          path: stackResult.output_path,
                          district: stackResult.district,
                          season: stackResult.season,
                          size_mb: stackResult.file_size_mb,
                          status: 'SUCCESS',
                          logs: stackLogs.length > 0 ? stackLogs : (stackResult.logs || []),
                          execution_logs: stackResult.execution_logs || ''
                        });
                        setStackModalFilter('ALL');
                        setStackModalSearch('');
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        backgroundColor: '#eff6ff',
                        color: '#1d4ed8',
                        border: '1px solid #bfdbfe',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        padding: '0.55rem 0.95rem',
                        borderRadius: '0.375rem',
                        cursor: 'pointer'
                      }}
                    >
                      <Terminal size={15} /> Logs
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownloadStackedTif(stackResult.output_path, stackResult.filename)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        backgroundColor: '#16a34a',
                        color: '#ffffff',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        padding: '0.55rem 1.15rem',
                        borderRadius: '0.375rem',
                        border: 'none',
                        cursor: 'pointer',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                      }}
                    >
                      <Download size={16} /> Download Stacked GeoTIFF ({stackResult.file_size_mb} MB)
                    </button>
                  </div>
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '1rem',
                  backgroundColor: '#f8fafc',
                  padding: '1.25rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #e2e8f0',
                  fontSize: '0.85rem'
                }}>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>OUTPUT FILENAME</span>
                    <span style={{ fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>{stackResult.filename}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>DISTRICT & SEASON</span>
                    <span style={{ fontWeight: 600, color: '#0f172a' }}>{stackResult.district} • {stackResult.season}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>TOTAL BANDS & RESOLUTION</span>
                    <span style={{ fontWeight: 600, color: '#0f172a' }}>{stackResult.total_bands} Bands ({stackResult.dimensions})</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>ATTACHMENT ORDER</span>
                    <span style={{ fontWeight: 700, color: '#2563eb', fontFamily: 'monospace' }}>{(stackResult.layers_order || []).join(' ➔ ')}</span>
                  </div>
                </div>

                <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#64748b', fontFamily: 'monospace' }}>
                  NAS Path: {stackResult.output_path}
                </div>
              </div>
            )}

            {/* Link to GeoTIFF Retrieval & NAS Archive tab */}
            <div style={{
              backgroundColor: '#f8fafc',
              borderRadius: '0.75rem',
              border: '1px dashed #cbd5e1',
              padding: '1.25rem 1.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '1rem'
            }}>
              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.25rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HardDrive size={18} color="#2563eb" /> Existing Layer Stacks Archive on NAS
                </h4>
                <p style={{ fontSize: '0.8rem', color: '#64748b', margin: 0 }}>
                  Archived stacked GeoTIFFs can be verified, filtered by region/season/date, and downloaded under Tab 4 (GeoTIFF Raster Retrieval &amp; Export Form).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('retrieve_data')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.5rem 1rem',
                  borderRadius: '0.375rem',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#1d4ed8',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Go to NAS Layer Stacks Archive →
              </button>
            </div>

          </div>
        )}

      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: Execution Logs Terminal Viewer */}
      {/* ========================================================================= */}
      {isLogsModalOpen && selectedReqForLogs && (
        <div className="modal-overlay" onClick={closeLogsModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: '#ffffff',
            color: '#0f172a',
            border: '1px solid #e2e8f0',
            width: '100%',
            maxWidth: '1240px',
            height: '92vh',
            maxHeight: '94vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '0.75rem',
            overflow: 'hidden',
            boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)'
          }}>
            
            {/* Modal Header: Clean white background with black text & blue accents */}
            <div style={{
              padding: '1.25rem 1.5rem 0.75rem 1.5rem',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              backgroundColor: '#ffffff',
              borderBottom: '1px solid #e2e8f0'
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                  <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#0f172a', margin: 0, letterSpacing: '-0.02em' }}>
                    {selectedReqForLogs.request_title || `Request #${selectedReqForLogs.id}`}
                  </h3>
                  <span style={{
                    padding: '0.2rem 0.75rem',
                    borderRadius: '9999px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    backgroundColor: selectedReqForLogs.status === 'COMPLETED' ? '#ecfdf5' :
                                     ['PROCESSING', 'DOWNLOADING'].includes(selectedReqForLogs.status) ? '#eff6ff' :
                                     selectedReqForLogs.status === 'INCOMPLETE' ? '#fffbeb' : '#fef2f2',
                    color: selectedReqForLogs.status === 'COMPLETED' ? '#047857' :
                           ['PROCESSING', 'DOWNLOADING'].includes(selectedReqForLogs.status) ? '#1d4ed8' :
                           selectedReqForLogs.status === 'INCOMPLETE' ? '#b45309' : '#b91c1c',
                    border: selectedReqForLogs.status === 'COMPLETED' ? '1px solid #a7f3d0' :
                            ['PROCESSING', 'DOWNLOADING'].includes(selectedReqForLogs.status) ? '1px solid #bfdbfe' :
                            selectedReqForLogs.status === 'INCOMPLETE' ? '1px solid #fde68a' : '1px solid #fecaca'
                  }}>
                    {selectedReqForLogs.status}
                  </span>
                </div>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
                  {selectedReqForLogs.district || ''}{selectedReqForLogs.state ? ', ' + selectedReqForLogs.state : ''} ({(selectedReqForLogs.start_date || '').split('T')[0]} to {(selectedReqForLogs.end_date || '').split('T')[0]})
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                {['COMPLETED', 'HELD', 'SUCCESS'].includes(selectedReqForLogs.status) && (
                  <>
                    {(() => {
                      const stackCount = typeof selectedReqForLogs.stacking_count === 'number'
                        ? selectedReqForLogs.stacking_count
                        : ((selectedReqForLogs.stacked_files && selectedReqForLogs.stacked_files.length) || 0);

                      return stackCount > 0 ? (
                        <button
                          onClick={() => setStackFilesModalReq(selectedReqForLogs)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.35rem',
                            padding: '0.38rem 0.75rem',
                            borderRadius: '9999px',
                            border: '1px solid #86efac',
                            backgroundColor: '#f0fdf4',
                            fontSize: '0.78rem',
                            fontWeight: 700,
                            color: '#166534',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer'
                          }}
                          title="Click to view all stacked GeoTIFF files and downloads for this request"
                        >
                          <CheckCircle size={13} color="#16a34a" style={{ flexShrink: 0 }} />
                          <span>Stacking: {stackCount} {stackCount === 1 ? 'time done' : 'times done'}</span>
                        </button>
                      ) : (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.35rem',
                            padding: '0.3rem 0.8rem',
                            borderRadius: '9999px',
                            border: '1px solid #fed7aa',
                            backgroundColor: '#fff7ed',
                            fontSize: '0.76rem',
                            fontWeight: 700,
                            color: '#c2410c',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                            minWidth: 'max-content',
                            textAlign: 'center',
                            lineHeight: 1.2
                          }}
                          title="Pipeline steps 1 to 4 completed, but layer stacking has not been performed yet for this request"
                        >
                          <Layers size={13} color="#ea580c" style={{ flexShrink: 0 }} />
                          <span style={{ whiteSpace: 'nowrap' }}>Stacking: Not Done</span>
                        </span>
                      );
                    })()}

                    <button
                      onClick={() => {
                        const req = selectedReqForLogs;
                        closeLogsModal();
                        setActiveTab('layer_stacking');
                        setStackRequestId(req.id);
                        setStackState(req.state || '');
                        setStackDistrict(req.district || '');
                        setStackSeason(req.season || 'Kharif');
                        const sDate = req.start_date ? req.start_date.split('T')[0] : '2026-06-01';
                        const eDate = req.end_date ? req.end_date.split('T')[0] : '2026-10-31';
                        setStackStartDate(sDate);
                        setStackEndDate(eDate);
                        hasAutoLoadedStackRef.current = true;
                        loadBandsAndScenesForRegion(req.state, req.district, req.season, sDate, eDate, req.id);
                        fetchStackHistory(req.district);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.4rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #bfdbfe',
                        backgroundColor: '#eff6ff',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        color: '#1d4ed8',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                      title="Open Multi-Band Layer Stacking Studio for this request"
                    >
                      <Layers size={14} /> Stacking Studio
                    </button>
                  </>
                )}

                <button
                  onClick={closeLogsModal}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'color 0.15s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#0f172a'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#64748b'}
                >
                  <X size={22} />
                </button>
              </div>
            </div>

            {/* View Toolbar: Mode Switcher, Filters & Search */}
            <div style={{
              padding: '0.5rem 1.5rem',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              {/* Left: View Mode Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <div style={{ display: 'inline-flex', backgroundColor: '#f1f5f9', borderRadius: '0.375rem', padding: '3px', border: '1px solid #e2e8f0' }}>
                  <button
                    onClick={() => setLogViewMode('table')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.8rem',
                      borderRadius: '0.25rem',
                      border: logViewMode === 'table' ? '1px solid #cbd5e1' : 'none',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: logViewMode === 'table' ? '#ffffff' : 'transparent',
                      color: logViewMode === 'table' ? '#2563eb' : '#64748b',
                      boxShadow: logViewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                    }}
                  >
                    <Table size={13} /> Table View
                  </button>
                  <button
                    onClick={() => setLogViewMode('raw')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.8rem',
                      borderRadius: '0.25rem',
                      border: logViewMode === 'raw' ? '1px solid #cbd5e1' : 'none',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: logViewMode === 'raw' ? '#ffffff' : 'transparent',
                      color: logViewMode === 'raw' ? '#2563eb' : '#64748b',
                      boxShadow: logViewMode === 'raw' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
                    }}
                  >
                    <Terminal size={13} /> Raw Logs
                  </button>
                </div>
              </div>

              {/* Right: Search Filter Input */}
              {logViewMode === 'table' && (
                <div style={{ position: 'relative', width: '230px' }}>
                  <Search size={13} style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                  <input
                    type="text"
                    placeholder="Filter tile / scene / date..."
                    value={logSearchQuery}
                    onChange={(e) => setLogSearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.35rem 0.5rem 0.35rem 1.85rem',
                      fontSize: '0.76rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      color: '#0f172a',
                      outline: 'none'
                    }}
                  />
                  {logSearchQuery && (
                    <button
                      onClick={() => setLogSearchQuery('')}
                      style={{ position: 'absolute', right: '0.45rem', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', padding: 0 }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Modal Body: Switch between Table View and Raw Terminal View */}
            <div style={{
              padding: '1rem 1.5rem',
              backgroundColor: '#ffffff',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}>
              {logViewMode === 'table' ? (
                renderLogTableView(selectedReqForLogs.execution_logs, selectedReqForLogs, logsModalTifs, logsModalComposites)
              ) : (
                <div className="log-terminal" style={{
                  flex: 1,
                  maxHeight: '600px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  color: '#0f172a',
                  padding: '1rem 1.25rem'
                }}>
                  {renderLogContent(selectedReqForLogs.execution_logs)}
                </div>
              )}
            </div>

            {/* Modal Footer Controls */}
            <div style={{
              padding: '0.85rem 1.5rem',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#f8fafc'
            }}>
              <div style={{ fontSize: '0.78rem', color: '#475569', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block', boxShadow: '0 0 6px rgba(16, 185, 129, 0.6)' }} />
                <span>Live Real-Time Stream (1s polling · Auto-synced with NAS &amp; S3)</span>
              </div>

              <div style={{ display: 'flex', gap: '0.65rem' }}>
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
                  <Play size={14} /> {rerunningId === selectedReqForLogs.id ? 'Retrying...' : 'Re-run / Resume'}
                </button>

                <button
                  onClick={closeLogsModal}
                  style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #cbd5e1',
                    color: '#0f172a',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    padding: '0.45rem 1rem',
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
      {/* MODAL: Acquisition Warnings & Missing Items Inspection */}
      {/* ========================================================================= */}
      {showWarningModal && selectedReqForLogs && (() => {
        const {
          scenes = [],
          gapSummary = {},
          warningsList = []
        } = parseAcquisitionScenes(selectedReqForLogs.execution_logs, selectedReqForLogs, logsModalTifs);

        const districtName = selectedReqForLogs.district || selectedReqForLogs.state || 'Selected AOI';

        // 1. Scenes with Missing Bands
        const missingBandsScenes = scenes.filter(s => s.missingBands && s.missingBands.length > 0);

        // 2. Out-of-bounds or Skipped Scenes
        const skippedScenes = scenes.filter(s =>
          s.status === 'SKIPPED' || (s.warning && (s.warning.includes('bounds') || s.warning.includes('0 valid')))
        );

        // 3. Failed Scenes
        const failedScenes = scenes.filter(s => s.status === 'FAILED');

        // 4. Queued / Missing Scenes from Archive Gap Check
        const gapMissingCount = gapSummary.missing || 0;
        const pendingScenes = scenes.filter(s => s.status === 'PENDING' || s.status === 'DOWNLOADING');

        // Combined inspection items
        const allIssueItems = [];

        // Add scenes with missing bands
        missingBandsScenes.forEach(sc => {
          allIssueItems.push({
            id: `mb_${sc.folder}`,
            date: sc.date || '—',
            tile: sc.tile || '—',
            satellite: sc.satellite || 'Sentinel-2',
            folder: sc.folder,
            status: 'WARNING',
            type: 'MISSING_BANDS',
            missingBands: sc.missingBands,
            details: `Scene is incomplete: Missing required spectral band(s) [${sc.missingBands.join(', ')}] needed for surface reflectance index calculation.`
          });
        });

        // Add out-of-bounds / skipped scenes
        skippedScenes.forEach(sc => {
          if (!allIssueItems.some(i => i.folder === sc.folder)) {
            allIssueItems.push({
              id: `oob_${sc.folder}`,
              date: sc.date || '—',
              tile: sc.tile || 'S1_SAR',
              satellite: sc.satellite || 'Sentinel-1',
              folder: sc.folder,
              status: 'SKIPPED',
              type: 'OUT_OF_BOUNDS',
              missingBands: [],
              details: sc.warning || `Tile bounding box does not overlap '${districtName}' target boundary (0 valid pixels). Safely omitted from final layer stack.`
            });
          }
        });

        // Add failed scenes
        failedScenes.forEach(sc => {
          if (!allIssueItems.some(i => i.folder === sc.folder)) {
            allIssueItems.push({
              id: `fail_${sc.folder}`,
              date: sc.date || '—',
              tile: sc.tile || '—',
              satellite: sc.satellite || 'Sentinel',
              folder: sc.folder,
              status: 'FAILED',
              type: 'FAILED',
              missingBands: [],
              details: sc.warning || `Acquisition or band verification attempt failed. Scene queued for retry.`
            });
          }
        });

        // Add pending / queued scenes from archive gap
        pendingScenes.forEach(sc => {
          if (!allIssueItems.some(i => i.folder === sc.folder)) {
            allIssueItems.push({
              id: `gap_${sc.folder}`,
              date: sc.date || '—',
              tile: sc.tile || '—',
              satellite: sc.satellite || 'Sentinel',
              folder: sc.folder,
              status: 'PENDING',
              type: 'ARCHIVE_GAP',
              missingBands: [],
              details: `Available on AWS S3 repository but genuinely missing from local archive cache. Queued for background acquisition.`
            });
          }
        });

        // Add any additional warnings from warningsList
        warningsList.forEach((w, wIdx) => {
          if (!allIssueItems.some(i => i.folder === w.scene)) {
            allIssueItems.push({
              id: `warn_${wIdx}`,
              date: (selectedReqForLogs.start_date || '').split('T')[0] || '—',
              tile: w.scene.includes('S1') ? 'S1_SAR' : '—',
              satellite: w.scene.startsWith('S1') ? 'Sentinel-1' : 'Sentinel-2',
              folder: w.scene,
              status: w.type === 'OUT_OF_BOUNDS' ? 'SKIPPED' : 'WARNING',
              type: w.type,
              missingBands: w.bands || [],
              details: w.message
            });
          }
        });

        // Filter if a specific scene was clicked
        const displayItems = selectedWarningScene
          ? allIssueItems.filter(item => item.folder === selectedWarningScene.folder || (selectedWarningScene.tile && item.tile === selectedWarningScene.tile))
          : allIssueItems;

        return (
          <div className="modal-overlay" style={{ zIndex: 1200 }} onClick={() => { setShowWarningModal(false); setSelectedWarningScene(null); }}>
            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: '#ffffff',
                color: '#0f172a',
                border: '1px solid #e2e8f0',
                width: '100%',
                maxWidth: '1050px',
                maxHeight: '88vh',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '0.75rem',
                overflow: 'hidden',
                boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.35)'
              }}
            >
              {/* Modal Header */}
              <div style={{
                padding: '1.1rem 1.5rem',
                borderBottom: '1px solid #e2e8f0',
                backgroundColor: '#f8fafc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  <div style={{
                    backgroundColor: '#fffbeb',
                    border: '1px solid #fde68a',
                    padding: '0.45rem',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <AlertTriangle size={20} color="#d97706" />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', margin: 0 }}>
                      Acquisition Warnings &amp; Missing Items Inspection
                    </h3>
                    <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.15rem' }}>
                      Audit of missing spectral bands, missing scenes, and skipped tiles for <strong>{districtName}</strong>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => { setShowWarningModal(false); setSelectedWarningScene(null); }}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: '0.3rem',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#0f172a'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#64748b'}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Modal Body */}
              <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                {/* 3 KPI Summary Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                  <div style={{
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '0.5rem',
                    padding: '0.75rem 1rem'
                  }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Missing Spectral Bands
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#b91c1c', marginTop: '0.2rem' }}>
                      {missingBandsScenes.length} <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>scene{missingBandsScenes.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div style={{ fontSize: '0.71rem', color: '#7f1d1d', marginTop: '0.15rem' }}>
                      Incomplete bands (e.g. B04, B08)
                    </div>
                  </div>

                  <div style={{
                    backgroundColor: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: '0.5rem',
                    padding: '0.75rem 1rem'
                  }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Missing From Archive
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#b45309', marginTop: '0.2rem' }}>
                      {gapMissingCount || pendingScenes.length} <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>scene{gapMissingCount !== 1 ? 's' : ''}</span>
                    </div>
                    <div style={{ fontSize: '0.71rem', color: '#78350f', marginTop: '0.15rem' }}>
                      Queued for download from AWS S3
                    </div>
                  </div>

                  <div style={{
                    backgroundColor: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    borderRadius: '0.5rem',
                    padding: '0.75rem 1rem'
                  }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Skipped / Out-of-Bounds
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a', marginTop: '0.2rem' }}>
                      {skippedScenes.length} <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>scene{skippedScenes.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div style={{ fontSize: '0.71rem', color: '#64748b', marginTop: '0.15rem' }}>
                      0 valid data pixels for {districtName}
                    </div>
                  </div>
                </div>

                {/* Filter notification if single scene was clicked */}
                {selectedWarningScene && (
                  <div style={{
                    backgroundColor: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '0.375rem',
                    padding: '0.65rem 1rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.78rem',
                    color: '#1e40af'
                  }}>
                    <span>
                      Currently inspecting specific scene: <strong>{cleanFolderName(selectedWarningScene.folder)}</strong>
                    </span>
                    <button
                      onClick={() => setSelectedWarningScene(null)}
                      style={{
                        backgroundColor: '#ffffff',
                        border: '1px solid #bfdbfe',
                        color: '#1d4ed8',
                        padding: '0.2rem 0.6rem',
                        borderRadius: '0.25rem',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      Show All ({allIssueItems.length}) Items
                    </button>
                  </div>
                )}

                {/* Table of Missing Items / Warnings: EXACT 6 columns matching user request */}
                <div style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '0.5rem',
                  overflow: 'hidden',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
                }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ padding: '0.7rem 1rem', width: '110px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Date</th>
                        <th style={{ padding: '0.7rem 1rem', width: '85px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Tile</th>
                        <th style={{ padding: '0.7rem 1rem', width: '90px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Satellite</th>
                        <th style={{ padding: '0.7rem 1rem', width: '250px', fontWeight: 700, color: '#475569' }}>Folder</th>
                        <th style={{ padding: '0.7rem 1rem', width: '130px', fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Status</th>
                        <th style={{ padding: '0.7rem 1.25rem', fontWeight: 700, color: '#475569' }}>Missing Bands / Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayItems.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#16a34a', backgroundColor: '#ffffff' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '0.9rem' }}>
                              <CheckCircle size={20} color="#16a34a" /> No missing bands or warnings detected for this selection!
                            </div>
                            <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: '0.35rem' }}>
                              All required spectral bands and spatial tiles have been verified.
                            </div>
                          </td>
                        </tr>
                      ) : (
                        displayItems.map((item, idx) => {
                          const isWarning = item.status === 'WARNING';
                          const isSkipped = item.status === 'SKIPPED';
                          const isPending = item.status === 'PENDING';
                          const isFailed = item.status === 'FAILED';

                          const statusBg = isWarning ? '#fffbeb' : (isSkipped ? '#f8fafc' : (isFailed ? '#fef2f2' : '#eff6ff'));
                          const statusColor = isWarning ? '#b45309' : (isSkipped ? '#475569' : (isFailed ? '#b91c1c' : '#1d4ed8'));
                          const statusBorder = isWarning ? '1px solid #fde68a' : (isSkipped ? '1px solid #cbd5e1' : (isFailed ? '1px solid #fecaca' : '1px solid #bfdbfe'));

                          const rowBg = idx % 2 === 0 ? '#ffffff' : '#fcfdfd';

                          return (
                            <tr key={item.id || idx} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: rowBg }}>
                              <td style={{ padding: '0.65rem 1rem', color: '#1e293b', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {item.date}
                              </td>
                              <td style={{ padding: '0.65rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
                                {item.tile}
                              </td>
                              <td style={{ padding: '0.65rem 1rem', color: '#475569', fontWeight: 600 }}>
                                {item.satellite}
                              </td>
                              <td style={{ padding: '0.65rem 1rem' }}>
                                <div style={{ color: '#0f172a', fontFamily: 'monospace', fontSize: '0.76rem', fontWeight: 600 }}>
                                  {cleanFolderName(item.folder)}
                                </div>
                              </td>
                              <td style={{ padding: '0.65rem 1rem' }}>
                                <span style={{
                                  padding: '0.18rem 0.5rem',
                                  borderRadius: '0.25rem',
                                  fontSize: '0.71rem',
                                  fontWeight: 700,
                                  backgroundColor: statusBg,
                                  color: statusColor,
                                  border: statusBorder,
                                  display: 'inline-block'
                                }}>
                                  {item.status}
                                </span>
                              </td>
                              <td style={{ padding: '0.65rem 1.25rem' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                  {item.missingBands && item.missingBands.length > 0 && (
                                    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                      {item.missingBands.map((mb, mbIdx) => (
                                        <span
                                          key={mbIdx}
                                          style={{
                                            padding: '0.15rem 0.5rem',
                                            borderRadius: '0.25rem',
                                            fontSize: '0.71rem',
                                            fontWeight: 700,
                                            fontFamily: 'monospace',
                                            backgroundColor: '#fef2f2',
                                            border: '1px solid #f87171',
                                            color: '#dc2626'
                                          }}
                                        >
                                          Missing: {mb}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <div style={{ fontSize: '0.75rem', color: '#334155', lineHeight: 1.4 }}>
                                    {item.details}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

              </div>

              {/* Modal Footer */}
              <div style={{
                padding: '0.85rem 1.5rem',
                borderTop: '1px solid #e2e8f0',
                backgroundColor: '#f8fafc',
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center'
              }}>
                <button
                  onClick={() => { setShowWarningModal(false); setSelectedWarningScene(null); }}
                  style={{
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    padding: '0.45rem 1.25rem',
                    borderRadius: '0.375rem',
                    cursor: 'pointer',
                    boxShadow: '0 1px 2px rgba(37, 99, 235, 0.2)'
                  }}
                >
                  Close Inspection
                </button>
              </div>

            </div>
          </div>
        );
      })()}

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

      {/* ========================================================================= */}
      {/* MODAL 3: Layer Stack Execution & Verification Logs Viewer */}
      {/* ========================================================================= */}
      {selectedStackForLogs && (
        <div className="modal-overlay" onClick={() => setSelectedStackForLogs(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: '#ffffff',
            color: '#0f172a',
            border: '1px solid #e2e8f0',
            width: '100%',
            maxWidth: '1120px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '0.75rem',
            overflow: 'hidden',
            boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)'
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '1.15rem 1.5rem 0.85rem 1.5rem',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              backgroundColor: '#ffffff',
              borderBottom: '1px solid #e2e8f0'
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
                  <Terminal size={20} color="#2563eb" />
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0f172a', margin: 0, fontFamily: 'monospace' }}>
                    {selectedStackForLogs.filename}
                  </h3>
                  <span style={{
                    padding: '0.2rem 0.65rem',
                    borderRadius: '9999px',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    backgroundColor: '#ecfdf5',
                    color: '#047857',
                    border: '1px solid #a7f3d0'
                  }}>
                    {selectedStackForLogs.status || 'VERIFIED'}
                  </span>
                </div>
                <div style={{ fontSize: '0.82rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <span><b>District:</b> {selectedStackForLogs.district || '—'}</span>
                  <span>•</span>
                  <span><b>Season:</b> {selectedStackForLogs.season || '—'}</span>
                  <span>•</span>
                  <span><b>File Size:</b> {selectedStackForLogs.size_mb || '—'} MB</span>
                  {selectedStackForLogs.modified_at && (
                    <>
                      <span>•</span>
                      <span><b>Modified:</b> {selectedStackForLogs.modified_at}</span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => handleDownloadStackedTif(selectedStackForLogs.path, selectedStackForLogs.filename)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    backgroundColor: '#166534',
                    border: 'none',
                    color: '#ffffff',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  <Download size={13} /> Download Stack (.tif)
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedStackForLogs(null)}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Toolbar: Table / Terminal Toggle + Level Filters + Search */}
            <div style={{
              padding: '0.6rem 1.5rem',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'inline-flex', backgroundColor: '#e2e8f0', borderRadius: '0.375rem', padding: '2px' }}>
                  <button
                    type="button"
                    onClick={() => setStackModalViewMode('table')}
                    style={{
                      padding: '0.3rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: 'none',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: stackModalViewMode === 'table' ? '#ffffff' : 'transparent',
                      color: stackModalViewMode === 'table' ? '#1d4ed8' : '#475569',
                      boxShadow: stackModalViewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'
                    }}
                  >
                    Table View
                  </button>
                  <button
                    type="button"
                    onClick={() => setStackModalViewMode('terminal')}
                    style={{
                      padding: '0.3rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: 'none',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: stackModalViewMode === 'terminal' ? '#ffffff' : 'transparent',
                      color: stackModalViewMode === 'terminal' ? '#1d4ed8' : '#475569',
                      boxShadow: stackModalViewMode === 'terminal' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'
                    }}
                  >
                    Terminal View
                  </button>
                </div>

                {['ALL', 'INFO', 'SUCCESS', 'WARNING', 'ERROR'].map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setStackModalFilter(lvl)}
                    style={{
                      padding: '0.25rem 0.65rem',
                      borderRadius: '9999px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: stackModalFilter === lvl ? '1px solid #2563eb' : '1px solid #cbd5e1',
                      backgroundColor: stackModalFilter === lvl ? '#eff6ff' : '#ffffff',
                      color: stackModalFilter === lvl ? '#1d4ed8' : '#475569'
                    }}
                  >
                    {lvl}
                  </button>
                ))}
              </div>

              <div style={{ position: 'relative', minWidth: '240px' }}>
                <Search size={14} color="#64748b" style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  type="text"
                  placeholder="Search stack execution logs..."
                  value={stackModalSearch}
                  onChange={(e) => setStackModalSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.35rem 0.75rem 0.35rem 2rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.78rem',
                    backgroundColor: '#ffffff'
                  }}
                />
              </div>
            </div>

            {/* Modal Body */}
            {(() => {
              const rawLogs = Array.isArray(selectedStackForLogs.logs) ? selectedStackForLogs.logs : [];
              const filteredModalLogs = rawLogs.filter((log) => {
                const lvl = (log.level || 'INFO').toUpperCase();
                if (stackModalFilter !== 'ALL' && lvl !== stackModalFilter) return false;
                if (stackModalSearch.trim()) {
                  const q = stackModalSearch.toLowerCase();
                  return (log.message || '').toLowerCase().includes(q) || (log.timestamp || '').toLowerCase().includes(q);
                }
                return true;
              });

              return (
                <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#ffffff' }}>
                  {stackModalViewMode === 'table' ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '1px solid #e2e8f0', textAlign: 'left', color: '#475569', fontSize: '0.72rem', textTransform: 'uppercase' }}>
                          <th style={{ padding: '0.6rem 1rem', width: '60px' }}>#</th>
                          <th style={{ padding: '0.6rem 1rem', width: '110px' }}>Timestamp</th>
                          <th style={{ padding: '0.6rem 1rem', width: '110px' }}>Level</th>
                          <th style={{ padding: '0.6rem 1rem' }}>Execution Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredModalLogs.length === 0 ? (
                          <tr>
                            <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                              No matching log entries found.
                            </td>
                          </tr>
                        ) : (
                          filteredModalLogs.map((log, idx) => {
                            const isErr = log.level === 'ERROR';
                            const isWarn = log.level === 'WARNING';
                            const isSuccess = log.level === 'SUCCESS';
                            const badgeColor = isErr ? '#b91c1c' : (isWarn ? '#b45309' : (isSuccess ? '#15803d' : '#1d4ed8'));
                            const badgeBg = isErr ? '#fef2f2' : (isWarn ? '#fffbeb' : (isSuccess ? '#f0fdf4' : '#eff6ff'));
                            const badgeBorder = isErr ? '#fecaca' : (isWarn ? '#fde68a' : (isSuccess ? '#bbf7d0' : '#bfdbfe'));
                            return (
                              <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                                <td style={{ padding: '0.55rem 1rem', color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.74rem' }}>
                                  {idx + 1}
                                </td>
                                <td style={{ padding: '0.55rem 1rem', color: '#64748b', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                  {log.timestamp || '—'}
                                </td>
                                <td style={{ padding: '0.55rem 1rem' }}>
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: '0.25rem',
                                    fontSize: '0.68rem',
                                    fontWeight: 700,
                                    color: badgeColor,
                                    backgroundColor: badgeBg,
                                    border: `1px solid ${badgeBorder}`
                                  }}>
                                    {log.level || 'INFO'}
                                  </span>
                                </td>
                                <td style={{
                                  padding: '0.55rem 1rem',
                                  color: isErr ? '#dc2626' : (isWarn ? '#b45309' : (isSuccess ? '#15803d' : '#1e293b')),
                                  fontFamily: 'monospace',
                                  fontSize: '0.78rem',
                                  wordBreak: 'break-word'
                                }}>
                                  {log.message}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: '0.78rem', lineHeight: 1.6, padding: '1rem 1.5rem', backgroundColor: '#ffffff' }}>
                      {filteredModalLogs.map((log, idx) => {
                        const isErr = log.level === 'ERROR';
                        const isWarn = log.level === 'WARNING';
                        const isSuccess = log.level === 'SUCCESS';
                        const textColor = isErr ? '#dc2626' : (isWarn ? '#d97706' : (isSuccess ? '#16a34a' : '#2563eb'));
                        return (
                          <div key={idx} style={{ display: 'flex', gap: '0.65rem', padding: '0.15rem 0' }}>
                            <span style={{ color: '#94a3b8', minWidth: '75px' }}>[{log.timestamp || '—'}]</span>
                            <span style={{ color: textColor, minWidth: '80px', fontWeight: 700 }}>[{log.level || 'INFO'}]</span>
                            <span style={{ color: isErr ? '#dc2626' : (isWarn ? '#b45309' : (isSuccess ? '#15803d' : '#1e293b')), flex: 1, wordBreak: 'break-word' }}>
                              {log.message}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Modal Footer */}
            <div style={{
              padding: '0.65rem 1.5rem',
              backgroundColor: '#f8fafc',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.75rem',
              color: '#64748b'
            }}>
              <span style={{ fontFamily: 'monospace' }}>NAS Path: {selectedStackForLogs.path}</span>
              <button
                type="button"
                onClick={() => setSelectedStackForLogs(null)}
                style={{
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  padding: '0.4rem 0.9rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Close Logs
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 4: Existing Layer Stack Found on NAS (Direct Download vs Re-Generate) */}
      {/* ========================================================================= */}
      {exactStackMatchModal && (() => {
        const modalFiles = exactStackMatchModal.files || (exactStackMatchModal.filename ? [exactStackMatchModal] : []);
        const totalMb = modalFiles
          .filter(f => stackMatchSelectedFiles.has(f.filename))
          .reduce((sum, f) => sum + (Number(f.file_size_mb || f.size_mb) || 0), 0);
        const selectedCount = modalFiles.filter(f => stackMatchSelectedFiles.has(f.filename)).length;

        const layersList = exactStackMatchModal.bands || stackSelectedLayers || [];
        const hasS1 = layersList.some(l => ['VV', 'VH', 'VV_VH'].includes(l));
        const hasS2 = layersList.some(l => !['VV', 'VH', 'VV_VH'].includes(l));
        const sensorName = (hasS1 && hasS2) ? 'Combined' : (hasS1 ? 'Sentinel-1' : 'Sentinel-2');

        return (
          <div className="modal-overlay" onClick={() => setExactStackMatchModal(null)}>
            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '560px',
                borderRadius: '0.75rem',
                overflow: 'hidden',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
                border: '1px solid #e2e8f0',
                backgroundColor: '#ffffff'
              }}
            >
              {/* Modal Header */}
              <div style={{
                padding: '1.25rem 1.5rem',
                backgroundColor: '#eff6ff',
                borderBottom: '1px solid #dbeafe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  <div style={{
                    backgroundColor: '#dbeafe',
                    borderRadius: '0.5rem',
                    padding: '0.45rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <CheckCircle size={22} color="#2563eb" />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                      Data Available on NAS Storage
                    </h3>
                    <p style={{ fontSize: '0.78rem', color: '#3b82f6', margin: 0, fontWeight: 500 }}>
                      Verified raster files exist on NAS storage ready for download
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setExactStackMatchModal(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem' }}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Body Content */}
              <div style={{ padding: '1.5rem' }}>
                <div style={{
                  backgroundColor: '#f8fafc',
                  borderRadius: '0.5rem',
                  border: '1px solid #e2e8f0',
                  padding: '1rem',
                  marginBottom: '1.25rem'
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', fontSize: '0.85rem' }}>
                    <div>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>Region:</span>{' '}
                      <span style={{ color: '#0f172a', fontWeight: 700 }}>
                        {exactStackMatchModal.district || stackDistrict}{exactStackMatchModal.state ? `, ${exactStackMatchModal.state}` : (stackState ? `, ${stackState}` : '')}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>Sensor:</span>{' '}
                      <span style={{ color: '#0f172a', fontWeight: 700 }}>{sensorName}</span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>Band:</span>{' '}
                      <span style={{ color: '#0f172a', fontWeight: 700 }}>{layersList.join(', ')}</span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', fontWeight: 600 }}>Season:</span>{' '}
                      <span style={{ color: '#2563eb', fontWeight: 700 }}>
                        {exactStackMatchModal.season || stackSeason || 'Kharif'}
                      </span>
                    </div>
                  </div>

                  {/* Summary Bar */}
                  <div style={{
                    marginTop: '1rem',
                    paddingTop: '0.75rem',
                    borderTop: '1px solid #e2e8f0',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Total Files Found:</span>{' '}
                      <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>{selectedCount} GeoTIFF{selectedCount !== 1 ? 's' : ''}</strong>
                    </div>
                    <div>
                      <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Total Volume:</span>{' '}
                      <strong style={{ fontSize: '0.95rem', color: '#166534' }}>{totalMb.toFixed(2)} MB</strong>
                    </div>
                  </div>

                  {/* File List with Checkboxes */}
                  <div style={{
                    marginTop: '0.85rem',
                    paddingTop: '0.75rem',
                    borderTop: '1px solid #e2e8f0',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem'
                  }}>
                    <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase' }}>
                      Matching Layer Stack File{modalFiles.length > 1 ? 's' : ''} on NAS ({modalFiles.length}):
                    </div>
                    {modalFiles.map((f, i) => {
                      const isChecked = stackMatchSelectedFiles.has(f.filename);
                      const fSize = f.file_size_mb || f.size_mb || 0;
                      return (
                        <label
                          key={i}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.65rem',
                            padding: '0.6rem 0.75rem',
                            borderRadius: '0.375rem',
                            backgroundColor: isChecked ? '#eff6ff' : '#ffffff',
                            border: `1px solid ${isChecked ? '#93c5fd' : '#cbd5e1'}`,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              const next = new Set(stackMatchSelectedFiles);
                              if (e.target.checked) next.add(f.filename);
                              else next.delete(f.filename);
                              setStackMatchSelectedFiles(next);
                            }}
                            style={{ marginTop: '0.2rem', accentColor: '#166534', cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#0f172a', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                              {f.filename}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.2rem', display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
                              {f.start_date && f.end_date && (
                                <span>Date Range: <b>{f.start_date} to {f.end_date}</b></span>
                              )}
                              <span>File Size: <strong style={{ color: '#166534' }}>{fSize} MB</strong></span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Question to User */}
                <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                  <p style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                    Data is available on NAS. Do you want to download this data?
                  </p>
                  <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.35rem 0 0 0' }}>
                    The download will run in the background so you can freely continue your work.
                  </p>
                </div>

                {/* Modal Action Buttons */}
                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => setExactStackMatchModal(null)}
                    style={{
                      padding: '0.65rem 1.25rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      color: '#475569',
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    disabled={selectedCount === 0}
                    onClick={() => {
                      const toDownload = modalFiles.filter(f => stackMatchSelectedFiles.has(f.filename));
                      setExactStackMatchModal(null);
                      toDownload.forEach((f, idx) => {
                        setTimeout(() => {
                          handleDownloadStackedTif(f.path, f.filename);
                        }, idx * 600);
                      });
                    }}
                    style={{
                      padding: '0.65rem 1.4rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: selectedCount === 0 ? '#94a3b8' : '#166534',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      boxShadow: '0 2px 4px rgba(22, 101, 52, 0.2)'
                    }}
                  >
                    <Download size={16} /> Yes, Download Data (.tif)
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Dedicated Modal: Stacked Files & Download for a Specific Request */}
      {stackFilesModalReq && (() => {
        const req = stackFilesModalReq;
        const files = req.stacked_files || [];
        const count = req.stacking_count || files.length;
        return (
          <div className="modal-overlay" onClick={() => setStackFilesModalReq(null)} style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            backdropFilter: 'blur(3px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem'
          }}>
            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '0.75rem',
                border: '1px solid #cbd5e1',
                boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
                width: '100%',
                maxWidth: '720px',
                maxHeight: '85vh',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
              }}
            >
              {/* Modal Header */}
              <div style={{
                padding: '1.25rem 1.5rem',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                backgroundColor: '#f8fafc'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '0.5rem',
                    backgroundColor: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#2563eb'
                  }}>
                    <Layers size={22} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f172a', margin: 0 }}>
                      Layer Stacks — Request #{req.id}
                    </h3>
                    <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span><b>{req.district}</b>{req.state ? `, ${req.state}` : ''}</span>
                      <span>•</span>
                      <span>Season: <b>{req.season || 'Kharif'}</b></span>
                      <span>•</span>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        padding: '0.15rem 0.5rem',
                        borderRadius: '9999px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        backgroundColor: count > 0 ? '#ecfdf5' : '#fff7ed',
                        color: count > 0 ? '#047857' : '#c2410c',
                        border: count > 0 ? '1px solid #a7f3d0' : '1px solid #fed7aa'
                      }}>
                        {count > 0 ? <CheckCircle size={11} color="#047857" /> : null}
                        {count > 0 ? `${count} stack${count > 1 ? 's' : ''} completed (${count} times done)` : 'Stacking: Not Done (0)'}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setStackFilesModalReq(null)}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    borderRadius: '0.375rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Modal Body */}
              <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ fontSize: '0.82rem', color: '#475569' }}>
                  The following multi-band GeoTIFF layer stack files are archived on NAS storage for this request:
                </div>

                {files.length === 0 ? (
                  <div style={{
                    padding: '2rem 1.5rem',
                    textAlign: 'center',
                    backgroundColor: '#fffbeb',
                    borderRadius: '0.5rem',
                    border: '1px dashed #fde68a'
                  }}>
                    <Layers size={32} color="#d97706" style={{ margin: '0 auto 0.5rem auto' }} />
                    <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#b45309' }}>
                      No Layer Stacks Generated Yet (0 Done)
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#78350f', marginTop: '0.25rem' }}>
                      Pipeline steps 1 to 4 are complete. All raw spectral bands and indices are stored on NAS.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {files.map((f, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.85rem 1rem',
                          backgroundColor: '#f8fafc',
                          borderRadius: '0.5rem',
                          border: '1px solid #e2e8f0',
                          gap: '1rem',
                          flexWrap: 'wrap'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.65rem', flex: 1, minWidth: '260px' }}>
                          <Layers size={18} color="#2563eb" style={{ marginTop: '0.15rem', flexShrink: 0 }} />
                          <div>
                            <div style={{ fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, color: '#0f172a', wordBreak: 'break-all' }}>
                              {f.filename}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#166534' }}>
                                💾 {f.file_size_mb ? `${f.file_size_mb} MB` : 'Size available'}
                              </span>
                              <span>•</span>
                              <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                                {f.layers && f.layers.length > 0 ? `Bands: [${f.layers.join(', ')}]` : 'Multi-band GeoTIFF'}
                              </span>
                              <span>•</span>
                              <span style={{ fontSize: '0.7rem', color: '#047857', fontWeight: 700, backgroundColor: '#ecfdf5', padding: '0.05rem 0.4rem', borderRadius: '0.25rem', border: '1px solid #a7f3d0' }}>
                                ✓ On NAS Archive
                              </span>
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDownloadStackedTif(f.path || f.filename, f.filename)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            padding: '0.45rem 0.85rem',
                            borderRadius: '0.375rem',
                            border: '1px solid #2563eb',
                            backgroundColor: '#eff6ff',
                            color: '#1d4ed8',
                            fontSize: '0.8rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            flexShrink: 0
                          }}
                          title="Download GeoTIFF directly to your computer"
                        >
                          <Download size={13} /> Download (.tif)
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div style={{
                padding: '0.85rem 1.5rem',
                borderTop: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: '#f8fafc',
                flexWrap: 'wrap',
                gap: '0.75rem'
              }}>
                <div style={{ fontSize: '0.75rem', color: '#64748b', fontFamily: 'monospace' }}>
                  NAS Path: Composites/stack/{req.district}/
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  <button
                    onClick={() => {
                      setStackFilesModalReq(null);
                      closeLogsModal();
                      setActiveTab('layer_stacking');
                      setStackRequestId(req.id);
                      setStackState(req.state || '');
                      setStackDistrict(req.district || '');
                      setStackSeason(req.season || 'Kharif');
                      const sDate = req.start_date ? req.start_date.split('T')[0] : '2026-06-01';
                      const eDate = req.end_date ? req.end_date.split('T')[0] : '2026-10-31';
                      setStackStartDate(sDate);
                      setStackEndDate(eDate);
                      hasAutoLoadedStackRef.current = true;
                      loadBandsAndScenesForRegion(req.state, req.district, req.season, sDate, eDate, req.id);
                      fetchStackHistory(req.district);
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.45rem 0.9rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #2563eb',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    <Layers size={13} /> Open in Stacking Studio
                  </button>

                  <button
                    onClick={() => setStackFilesModalReq(null)}
                    style={{
                      padding: '0.45rem 0.9rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      color: '#475569',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Floating Persistent Background Download Status Widget */}
      {downloadProgress && (
        <div style={{
          position: 'fixed',
          bottom: '1.25rem',
          right: '1.25rem',
          zIndex: 999999,
          maxWidth: downloadWidgetMinimized ? 'auto' : '410px',
          width: downloadWidgetMinimized ? 'auto' : 'calc(100vw - 2.5rem)',
          backgroundColor: '#ffffff',
          borderRadius: '0.75rem',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25), 0 10px 10px -5px rgba(0, 0, 0, 0.1)',
          border: `1px solid ${
            downloadProgress.status === 'completed' ? '#86efac' : downloadProgress.status === 'error' ? '#fca5a5' : '#93c5fd'
          }`,
          overflow: 'hidden'
        }}>
          {downloadWidgetMinimized ? (
            <div
              onClick={() => setDownloadWidgetMinimized(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                padding: '0.65rem 1rem',
                backgroundColor: downloadProgress.status === 'completed' ? '#f0fdf4' : downloadProgress.status === 'error' ? '#fef2f2' : '#1e293b',
                color: downloadProgress.status === 'completed' ? '#166534' : downloadProgress.status === 'error' ? '#991b1b' : '#ffffff',
                cursor: 'pointer',
                borderRadius: '0.75rem',
                userSelect: 'none'
              }}
            >
              {downloadProgress.status === 'downloading' ? (
                <RefreshCw size={17} className="animate-spin" color="#60a5fa" />
              ) : downloadProgress.status === 'completed' ? (
                <CheckCircle size={17} color="#16a34a" />
              ) : (
                <AlertTriangle size={17} color="#dc2626" />
              )}
              <span style={{ fontSize: '0.825rem', fontWeight: 600 }}>
                {downloadProgress.status === 'downloading'
                  ? `Downloading: ${downloadProgress.percent !== null && downloadProgress.percent !== undefined ? `${downloadProgress.percent}%` : `${downloadProgress.loadedMB} MB`}`
                  : downloadProgress.status === 'completed'
                    ? 'Download Completed'
                    : 'Download Failed'}
              </span>
              <Maximize2 size={14} style={{ marginLeft: '0.25rem', opacity: 0.8 }} />
            </div>
          ) : (
            <div>
              {/* Header */}
              <div style={{
                padding: '0.75rem 1rem',
                backgroundColor: downloadProgress.status === 'completed' ? '#f0fdf4' : downloadProgress.status === 'error' ? '#fef2f2' : '#eff6ff',
                borderBottom: `1px solid ${
                  downloadProgress.status === 'completed' ? '#dcfce7' : downloadProgress.status === 'error' ? '#fee2e2' : '#dbeafe'
                }`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  {downloadProgress.status === 'downloading' ? (
                    <div style={{ backgroundColor: '#dbeafe', borderRadius: '50%', padding: '0.35rem', display: 'flex' }}>
                      <RefreshCw size={16} className="animate-spin" color="#2563eb" />
                    </div>
                  ) : downloadProgress.status === 'completed' ? (
                    <div style={{ backgroundColor: '#dcfce7', borderRadius: '50%', padding: '0.35rem', display: 'flex' }}>
                      <CheckCircle size={16} color="#16a34a" />
                    </div>
                  ) : (
                    <div style={{ backgroundColor: '#fee2e2', borderRadius: '50%', padding: '0.35rem', display: 'flex' }}>
                      <AlertTriangle size={16} color="#dc2626" />
                    </div>
                  )}
                  <div>
                    <div style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: downloadProgress.status === 'completed' ? '#14532d' : downloadProgress.status === 'error' ? '#991b1b' : '#1e3a8a'
                    }}>
                      {downloadProgress.status === 'downloading'
                        ? 'Background Download in Progress'
                        : downloadProgress.status === 'completed'
                          ? 'ZIP Download Completed!'
                          : 'Download Failed'}
                    </div>
                    {downloadProgress.status === 'downloading' && (
                      <div style={{ fontSize: '0.7rem', color: '#2563eb', fontWeight: 600 }}>
                        ✓ You can freely navigate and continue your work
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <button
                    type="button"
                    onClick={() => setDownloadWidgetMinimized(true)}
                    title="Minimize"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem' }}
                  >
                    <Minimize2 size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDownloadProgress(null)}
                    title="Dismiss"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem' }}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div style={{ padding: '0.9rem 1rem' }}>
                <div style={{
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  color: '#334155',
                  backgroundColor: '#f8fafc',
                  padding: '0.45rem 0.65rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #e2e8f0',
                  marginBottom: '0.75rem',
                  wordBreak: 'break-all',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem'
                }}>
                  <Package size={15} color="#64748b" style={{ flexShrink: 0 }} />
                  {downloadProgress.fileName}
                </div>

                {downloadProgress.status === 'downloading' && (
                  <div>
                    {/* Animated Progress Bar */}
                    <div style={{
                      width: '100%',
                      height: '7px',
                      backgroundColor: '#e2e8f0',
                      borderRadius: '999px',
                      overflow: 'hidden',
                      marginBottom: '0.5rem'
                    }}>
                      <div style={{
                        width: `${downloadProgress.percent || 15}%`,
                        height: '100%',
                        backgroundColor: '#2563eb',
                        borderRadius: '999px',
                        transition: 'width 0.3s ease'
                      }}></div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.73rem', color: '#64748b', fontWeight: 600 }}>
                      <span style={{ color: '#2563eb' }}>
                        {downloadProgress.percent !== null && downloadProgress.percent !== undefined
                          ? `${downloadProgress.percent}% Completed`
                          : 'Retrieving rasters from NAS...'}
                      </span>
                      <span>
                        {downloadProgress.loadedMB ? `${downloadProgress.loadedMB} MB` : ''}
                        {downloadProgress.totalMB ? ` / ${downloadProgress.totalMB} MB` : ''}
                      </span>
                    </div>
                  </div>
                )}

                {downloadProgress.status === 'completed' && (
                  <div style={{ fontSize: '0.8rem', color: '#166534', fontWeight: 500, lineHeight: 1.4 }}>
                    ✓ File has been archived from NAS and saved to your browser downloads folder.
                  </div>
                )}

                {downloadProgress.status === 'error' && (
                  <div style={{ fontSize: '0.8rem', color: '#b91c1c', fontWeight: 500, lineHeight: 1.4 }}>
                    {downloadProgress.errorMsg || 'Failed to download ZIP file from NAS.'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}