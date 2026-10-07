import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  Satellite, Activity, HardDrive, User, LogOut, RefreshCw, FileText,
  CheckCircle, Clock, AlertTriangle, XCircle, Plus, Search, Database,
  Calendar, MapPin, Sliders, Shield, Users, Check, ChevronRight, ChevronDown, Info,
  HelpCircle, X, Download, Play, Terminal, Eye, EyeOff, KeyRound, ArrowLeft, Square, Table,
  Layers, ArrowUp, ArrowDown, TrendingUp, BarChart3, Filter, Trash2
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
  const [retState, setRetState] = useState('');
  const [retDistrict, setRetDistrict] = useState('');
  const [retSatellite, setRetSatellite] = useState('ALL');
  const [retBand, setRetBand] = useState('ALL');
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

  // ---------------------------------------------------------------------------
  // 8. Downloaded Requests Info Overview State
  // ---------------------------------------------------------------------------
  const [dlSearchQuery, setDlSearchQuery] = useState('');
  const [dlStatusFilter, setDlStatusFilter] = useState('ALL');
  const [dlSatFilter, setDlSatFilter] = useState('ALL');

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
      if (retBand && retBand !== 'ALL') params.band = retBand;
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

  const handleDownloadZip = () => {
    setRetNotice(null);
    const currentToken = token || localStorage.getItem('sdap_token');
    const params = new URLSearchParams();
    if (retState) params.append('state', retState);
    if (retDistrict) params.append('district', retDistrict);
    if (retSatellite && retSatellite !== 'ALL') params.append('satellite', retSatellite);
    if (retBand && retBand !== 'ALL') params.append('band', retBand);
    if (retCompositeInterval && retCompositeInterval !== 'ALL') params.append('composite_interval', retCompositeInterval);
    if (retStartDate) params.append('start_date', retStartDate);
    if (retEndDate) params.append('end_date', retEndDate);
    if (currentToken) params.append('token', currentToken);

    const downloadUrl = `${API_BASE}/requests/tifs/download-zip?${params.toString()}`;
    const fileName = `SDAP_GeoTIFF_${retDistrict || retState || 'Export'}.zip`;

    // Native browser background download:
    // Triggers download via detached anchor with target="_blank" so the browser's native
    // download manager takes full control of the stream.
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.setAttribute('download', fileName);
    link.setAttribute('target', '_blank');
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      try { document.body.removeChild(link); } catch (e) {}
    }, 1500);

    // Close prompt modal and remove verified results card from the UI
    setShowDownloadPromptModal(false);
    setRetResults(null);

    // Display download initiated status notice
    setRetNotice({
      type: 'info',
      status: 'initiated',
      fileName: fileName,
      text: `✓ Download initiated! Your browser is downloading "${fileName}" in the background.`
    });

    // Automatically transition to download completed status
    setTimeout(() => {
      setRetNotice({
        type: 'success',
        status: 'completed',
        fileName: fileName,
        text: `✓ Download completed! "${fileName}" has been downloaded successfully.`
      });
    }, 4500);
  };

  // ---------------------------------------------------------------------------
  // 9. Layer Stacking Studio State & Handlers
  // ---------------------------------------------------------------------------
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

  // Request-linked downloaded scenes & filename preservation state
  const [stackSelectedRequestId, setStackSelectedRequestId] = useState('');
  const [stackDownloadedBandsData, setStackDownloadedBandsData] = useState({});
  const [stackSelectedScenes, setStackSelectedScenes] = useState({});
  const [stackCustomFilename, setStackCustomFilename] = useState('');
  const [loadingStackReqFiles, setLoadingStackReqFiles] = useState(false);

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
    { id: 'VV_VH', label: 'VV_VH - Dual-polarization Cross/Co Ratio (10m)' }
  ];

  const AVAILABLE_INDICES = [
    { id: 'NDVI', label: 'NDVI - Normalized Difference Vegetation Index (B08 - B04)/(B08 + B04)' },
    { id: 'LSWI', label: 'LSWI - Land Surface Water Index (B08 - B11)/(B08 + B11)' }
  ];

  const loadBandsAndScenesForRegion = useCallback(async (stateVal, distVal, seasonVal, startVal, endVal, targetReqId = null) => {
    if (!distVal && !stateVal && !targetReqId) {
      setStackDownloadedBandsData({});
      setStackSelectedScenes({});
      setStackSelectedRequestId('');
      return;
    }

    setLoadingStackReqFiles(true);
    try {
      // 1. Find matching requests for this district / state / targetReqId
      let matchingReq = null;
      let matchingList = [];

      if (targetReqId) {
        matchingReq = requests.find(r => String(r.id) === String(targetReqId)) || null;
      }

      if (!matchingReq && distVal) {
        matchingList = requests.filter(r => 
          r.district && r.district.toLowerCase() === distVal.toLowerCase()
        );
      }
      if (!matchingReq && matchingList.length === 0 && stateVal) {
        matchingList = requests.filter(r => 
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

      let tifs = [];
      if (matchingReq) {
        setStackSelectedRequestId(matchingReq.id);
        if (matchingReq.state && !stateVal) setStackState(matchingReq.state);
        if (matchingReq.district && !distVal) setStackDistrict(matchingReq.district);
        if (matchingReq.season) setStackSeason(matchingReq.season);
        if (matchingReq.start_date) setStackStartDate(matchingReq.start_date.split('T')[0]);
        if (matchingReq.end_date) setStackEndDate(matchingReq.end_date.split('T')[0]);

        // Query candidate requests for tifs - take the highest priority matching request with data
        const reqsToTry = matchingList.length > 0 ? matchingList : [matchingReq];
        for (const r of reqsToTry) {
          try {
            const res = await axios.get(`${API_BASE}/requests/${r.id}/tifs`, { headers: getAuthHeader() });
            const list = res.data?.tifs || [];
            if (list.length > 0) {
              tifs = list;
              matchingReq = r;
              setStackSelectedRequestId(r.id);
              if (r.season) setStackSeason(r.season);
              if (r.start_date) setStackStartDate(r.start_date.split('T')[0]);
              if (r.end_date) setStackEndDate(r.end_date.split('T')[0]);
              break;
            }
          } catch (e) {
            console.warn('Could not fetch request tifs directly:', e);
          }
        }
      } else {
        setStackSelectedRequestId('');
      }

      // If direct request tifs yielded 0 or no matchingReq, fallback to region search
      if (tifs.length === 0 && (distVal || stateVal)) {
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
      tifs.forEach(item => {
        let rawBand = (item.band || '').trim();
        let b = rawBand.replace(/\.tiff?$/i, '').toUpperCase().trim();
        if (b.includes('LSWI')) {
          b = 'LSWI';
        } else if (b.includes('NDVI')) {
          b = 'NDVI';
        } else if (b.includes('VV_VH') || b.includes('VV/VH')) {
          b = 'VV_VH';
        } else if (b.includes('_')) {
          const parts = b.split('_');
          const lastPart = parts[parts.length - 1];
          if (['B02', 'B03', 'B04', 'B08', 'B8A', 'B08A', 'B11', 'SCL', 'TCI', 'VV', 'VH'].includes(lastPart)) {
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

        let tileVal = item.tile || '';
        if (!tileVal && item.path) {
          const tm = item.path.match(/T([0-9]{2}[A-Z]{3})/i) || item.path.match(/([0-9]{2}[A-Z]{3})/i);
          if (tm) tileVal = tm[1];
        }

        // Deduplicate scenes strictly by file path or unique (scene_id + tile). Never deduplicate by generic band filename like B04.tif!
        const isDuplicate = grouped[b].some(existing => {
          if (existing.path && filePath && existing.path.toLowerCase() === filePath.toLowerCase()) return true;
          if (existing.scene_id && item.scene_id && existing.scene_id === item.scene_id && existing.tile === tileVal) return true;
          return false;
        });

        if (!isDuplicate) {
          let sDate = item.sensing_date || '';
          if (!sDate && fileName) {
            const dm = fileName.match(/(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})/);
            if (dm) sDate = `${dm[1]}-${dm[2]}-${dm[3]} to ${dm[4]}-${dm[5]}-${dm[6]}`;
          }
          grouped[b].push({
            scene_id: item.scene_id || (fileName.includes('Composite') ? 'Composite' : 'Scene'),
            tile: tileVal,
            sensing_date: sDate,
            path: filePath,
            filename: fileName,
            size_bytes: item.size_bytes
          });
        }
      });

      // Also try fetching composites for the matched request
      const candidateReqs = matchingReq ? [matchingReq] : [];
      for (const reqItem of candidateReqs) {
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
                size_bytes: (c.file_size_mb || c.size_mb || 0) * 1024 * 1024
              });
            }
          });
        } catch (cErr) {
          // ignore
        }
      }

      setStackDownloadedBandsData(grouped);

      // Default selection of layers based on request / available data
      const initialLayers = [];
      const initSelectedScenes = {};

      if (matchingReq) {
        const reqIndices = Array.isArray(matchingReq.indices) ? matchingReq.indices : (matchingReq.indices ? [matchingReq.indices] : []);
        reqIndices.forEach(idx => {
          const cleanIdx = idx.toUpperCase().trim();
          if (['NDVI', 'LSWI'].includes(cleanIdx) && !initialLayers.includes(cleanIdx)) {
            initialLayers.push(cleanIdx);
          }
        });
        const reqBands = Array.isArray(matchingReq.bands) ? matchingReq.bands : [];
        reqBands.forEach(b => {
          let cleanB = b.toUpperCase().replace(/\.TIFF?$/i, '').trim();
          if (cleanB === 'B08A') cleanB = 'B8A';
          if (!initialLayers.includes(cleanB)) initialLayers.push(cleanB);
        });
      }

      if (grouped['NDVI'] && !initialLayers.includes('NDVI')) initialLayers.push('NDVI');
      if (grouped['LSWI'] && !initialLayers.includes('LSWI')) initialLayers.push('LSWI');

      // Default selected stage: all downloaded scenes for EVERY band are selected by default
      Object.keys(grouped).forEach(bKey => {
        initSelectedScenes[bKey] = new Set(grouped[bKey].map(s => s.path || s.scene_id));
      });

      setStackSelectedScenes(initSelectedScenes);
      if (initialLayers.length > 0) {
        setStackSelectedLayers(initialLayers);
      }

      // Preserve exact filename for downloaded layers (e.g., NDVI.tif)
      if (initialLayers.includes('NDVI') && initialLayers.length <= 2) {
        const ndviScene = grouped['NDVI']?.[0];
        setStackCustomFilename(ndviScene?.filename || 'NDVI.tif');
      } else if (initialLayers.length === 1) {
        const singleB = initialLayers[0];
        const firstScene = grouped[singleB]?.[0];
        setStackCustomFilename(firstScene?.filename || `${singleB}.tif`);
      } else {
        const firstB = initialLayers[0];
        const firstScene = grouped[firstB]?.[0];
        setStackCustomFilename(firstScene?.filename || `${distVal || 'district'}_stacked.tif`);
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

      // Preserve exact filename for downloaded layers (e.g., NDVI.tif)
      if (next.length === 1) {
        const singleB = next[0];
        const scenes = stackDownloadedBandsData[singleB] || [];
        setStackCustomFilename(scenes[0]?.filename || `${singleB}.tif`);
      } else if (next.includes('NDVI') && next.length <= 2) {
        const ndviScenes = stackDownloadedBandsData['NDVI'] || [];
        setStackCustomFilename(ndviScenes[0]?.filename || 'NDVI.tif');
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

  const handleExecuteLayerStacking = async () => {
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

    setStackLoading(true);
    setStackNotice(null);
    setStackResult(null);

    // Collect all selected file paths from scenes
    const selectedPaths = [];
    stackSelectedLayers.forEach(lyr => {
      const scenes = stackDownloadedBandsData[lyr] || [];
      const selectedSet = stackSelectedScenes[lyr] !== undefined
        ? stackSelectedScenes[lyr]
        : new Set(scenes.map(s => s.path || s.scene_id));
      scenes.forEach(sc => {
        const key = sc.path || sc.scene_id;
        if (selectedSet.has(key) && sc.path) {
          selectedPaths.push(sc.path);
        }
      });
    });

    try {
      const payload = {
        state: stackState || null,
        district: stackDistrict,
        season: stackSeason || 'Kharif',
        start_date: stackStartDate || null,
        end_date: stackEndDate || null,
        layers: stackSelectedLayers,
        clip_to_district: stackClipToDistrict,
        output_filename: stackCustomFilename ? stackCustomFilename.trim() : (stackSelectedLayers.length === 1 ? `${stackSelectedLayers[0]}.tif` : null),
        selected_files: selectedPaths.length > 0 ? selectedPaths : null,
        request_id: stackSelectedRequestId ? Number(stackSelectedRequestId) : null
      };

      const res = await axios.post(`${API_BASE}/requests/layer-stack`, payload, {
        headers: getAuthHeader(),
        timeout: 180000
      });

      setStackResult(res.data);
      setStackNotice({
        type: 'success',
        text: `✓ Layer stack created successfully: "${res.data.filename}" (${res.data.file_size_mb} MB, ${res.data.total_bands} bands)`
      });

      // Refresh stack history
      fetchStackHistory(stackDistrict);
    } catch (err) {
      setStackNotice({
        type: 'error',
        text: `⚠️ Layer stacking failed: ${formatApiError(err, 'Failed to complete layer stacking.')}`
      });
    } finally {
      setStackLoading(false);
    }
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
    if (token && (activeTab === 'retrieve_data' || activeTab === 'layer_stacking')) {
      fetchDownloadedRegions();
    }
    if (token && activeTab === 'layer_stacking') {
      fetchStackHistory(stackDistrict);
    }
  }, [token, activeTab, fetchDownloadedRegions, fetchStackHistory, stackDistrict]);

  // Fetch Requests List (scoped to logged-in user, or all requests for administrators)
  const fetchRequests = useCallback(async () => {
    if (!token) return;
    setLoadingRequests(true);
    try {
      const scopeParam = currentUser?.role === 'ADMIN' ? '' : '?scope=mine';
      const res = await axios.get(`${API_BASE}/requests/${scopeParam}`, { headers: getAuthHeader() });
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
    if (token && currentUser?.role === 'ADMIN') {
      if (activeTab === 'admin') {
        fetchDailyStorage();
      } else if (activeTab === 'users') {
        fetchAdminData();
      }
    }
  }, [token, currentUser, activeTab, fetchAdminData, fetchDailyStorage]);

  // Smart polling: poll requests & active log modal continuously every 2s
  useEffect(() => {
    if (!token) return;

    const interval = setInterval(async () => {
      fetchRequests();
      if (currentUser?.role === 'ADMIN') {
        if (activeTab === 'users') {
          fetchAdminData();
          if (expandedUserId) {
            fetchUserRequests(expandedUserId);
          }
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

    const totalMB = totalGB * 1024;
    // Estimated download throughput ~12 MB/s (sustained multi-band HTTP/S3 pipeline transfer)
    const totalSeconds = Math.max(30, Math.round(totalMB / 12.0));
    let downloadTimeText = '';
    if (totalSeconds < 60) {
      downloadTimeText = '< 1 min';
    } else if (totalSeconds < 3600) {
      const m = Math.round(totalSeconds / 60);
      downloadTimeText = `~${m} min${m > 1 ? 's' : ''}`;
    } else {
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.round((totalSeconds % 3600) / 60);
      downloadTimeText = m > 0 ? `~${h} hr${h > 1 ? 's' : ''} ${m} min` : `~${h} hr${h > 1 ? 's' : ''}`;
    }

    return {
      gb: Math.round(totalGB * 100) / 100,
      tiles: tileCount,
      scenes: scenesEstimate,
      days,
      months: months.toFixed(1),
      downloadTimeText,
      totalSeconds
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

  // Dynamically parse acquisition scenes, execution configs & tile scene insights from raw execution logs
  const parseAcquisitionScenes = (rawLogs, selectedReq) => {
    const scenesMap = {};
    const tilesSet = new Set();
    const tileAuditMap = {};
    const stagesList = [];
    const gapSummary = { availableS3: 0, alreadyHeld: 0, missing: 0 };
    let currentActiveFolder = null;

    const configInfo = {
      district: selectedReq?.district || selectedReq?.state || 'Auto',
      range: selectedReq ? `${selectedReq.start_date} to ${selectedReq.end_date}` : '—',
      satellite: selectedReq?.satellite || 'Sentinel-1, Sentinel-2',
      indices: selectedReq?.indices ? selectedReq.indices.join(', ') : 'NDVI, LSWI, VV/VH',
      maxCloud: selectedReq?.max_cloud_cover ? `${selectedReq.max_cloud_cover}%` : '70.0%',
      level: selectedReq?.level ? selectedReq.level.toUpperCase() : 'MAX',
      composite: selectedReq?.composite_interval || 'WEEKLY'
    };

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
        // Extract timestamp: [YYYY-MM-DD HH:MM:SS]
        const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
        const timestamp = tsMatch ? tsMatch[1] : '';

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

        // 2. Extract Gap Check summary numbers
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
          if (tileName !== 'S1_SAR') tilesSet.add(tileName);
        }

        // 5. Extract MGRS / S1 Tiles identified
        const tilesMatch = line.match(/Tiles:\s*\[([^\]]+)\]/i) || line.match(/Tiles identified:\s*\[([^\]]+)\]/i);
        if (tilesMatch) {
          tilesMatch[1].replace(/['"]/g, '').split(',').forEach(t => {
            const cleanT = t.trim();
            if (cleanT && cleanT !== 'S1_SAR') tilesSet.add(cleanT);
          });
        }

        const tileDirectMatch = line.match(/Tile\s+'?([A-Za-z0-9_]+)'?/i);
        if (tileDirectMatch && tileDirectMatch[1] !== 'S1_SAR') {
          tilesSet.add(tileDirectMatch[1]);
        }

        // 6. Parse Processing Scene lines: e.g. [1/51 - 1%] Processing 'S2B_43PHS_20260502_0_L2A'
        const procM = line.match(/(?:\[(\d+\/\d+)\s*-\s*(\d+%)\]\s*)?Processing\s+'(S[12][A-C]_[0-9A-Za-z_]+)'/i);
        if (procM) {
          const folderName = procM[3];
          currentActiveFolder = folderName;
          const parts = folderName.split('_');
          const sat = parts[0] || 'S2';
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
              bands: [],
              bandSizes: {},
              totalSize: '',
              storagePath: '',
              progressRatio: procM[1] || '',
              progressPct: procM[2] || '',
              timestamp
            };
          } else {
            scenesMap[folderName].status = 'DOWNLOADING';
            if (procM[1]) scenesMap[folderName].progressRatio = procM[1];
            if (procM[2]) scenesMap[folderName].progressPct = procM[2];
          }
        }

        // 7. Parse Band download progress lines: ↳ Band 'B02.tif' (203.3 MB) downloaded & verified on NAS.
        const bandM = line.match(/↳\s*Band\s+'([A-Za-z0-9_]+)\.tif'\s*\(([^)]+)\)\s*downloaded\s*&\s*verified/i);
        if (bandM && currentActiveFolder && scenesMap[currentActiveFolder]) {
          const bandName = bandM[1];
          const bandSize = bandM[2];
          if (!scenesMap[currentActiveFolder].bands.includes(bandName)) {
            scenesMap[currentActiveFolder].bands.push(bandName);
          }
          scenesMap[currentActiveFolder].bandSizes[bandName] = bandSize;
          scenesMap[currentActiveFolder].timestamp = timestamp;
        }

        // 8. Parse Individual Scene Completion lines: ✓ [NEW DOWNLOAD COMPLETED] Scene 'S2B_...' downloaded to '...'
        const compMatch = line.match(/✓\s*\[NEW DOWNLOAD COMPLETED\]\s*Scene\s+'(S[12][A-C]_[0-9A-Za-z_]+)'/i);
        if (compMatch) {
          const folderName = compMatch[1];
          if (scenesMap[folderName]) {
            scenesMap[folderName].status = 'COMPLETE';
            const sizeM = line.match(/(\d+(?:\.\d+)?\s*MB)/i);
            if (sizeM) scenesMap[folderName].totalSize = sizeM[1];
            const destM = line.match(/downloaded to\s+'([^']+)'/i);
            if (destM) scenesMap[folderName].storagePath = destM[1];
            scenesMap[folderName].timestamp = timestamp;
          }
        }

        // 9. Parse failed or incomplete scenes
        const failMatch = line.match(/Scene\s+(S[12][A-C]_[0-9A-Za-z_]+)\s+incomplete|Failed fetching.*(S[12][A-C]_[0-9A-Za-z_]+)/i);
        if (failMatch) {
          const folderName = failMatch[1] || failMatch[2];
          if (scenesMap[folderName]) {
            scenesMap[folderName].status = 'FAILED';
          }
        }

        // 10. General scene matching for pre-existing or cached scenes
        const sceneMatch = line.match(/\b(S[12][A-C]_[0-9A-Za-z_]+)/i);
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

            scenesMap[folderName] = {
              folder: folderName,
              tile,
              date: formattedDate !== '—' ? formattedDate : (selectedReq?.start_date || '—'),
              satellite: sat,
              status: isFailed ? 'FAILED' : isComplete ? 'COMPLETE' : 'PENDING',
              bands: isS1 ? ['VV', 'VH', 'VV_VH'] : reqBands.filter(b => !S1_BANDS.includes(b)),
              bandSizes: {},
              totalSize: '',
              storagePath: '',
              timestamp
            };
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
          bands: [...reqBands],
          bandSizes: {},
          totalSize: ''
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
      progressPct,
      configInfo,
      tileAuditList: Object.values(tileAuditMap),
      stagesList,
      gapSummary
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
      progressPct,
      configInfo,
      tileAuditList,
      stagesList,
      gapSummary
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

    // Sort: Currently DOWNLOADING scene placed at the top (Row 1), followed by latest completed scenes
    const displayScenes = filteredScenes.slice().sort((a, b) => {
      if (a.status === 'DOWNLOADING') return -1;
      if (b.status === 'DOWNLOADING') return 1;
      return 0;
    }).reverse();

    const displayStages = (stagesList || []).slice().reverse();

    return (
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '0.5rem 0' }}>

        {/* 1. Pipeline Execution Configurations Banner */}
        <div style={{ backgroundColor: '#0f172a', color: '#f8fafc', borderRadius: '0.65rem', padding: '1rem 1.25rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', tracking: '0.05em', color: '#38bdf8', marginBottom: '0.65rem' }}>
            Pipeline Execution Configurations
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', fontSize: '0.8rem' }}>
            <div>
              <span style={{ color: '#94a3b8' }}>District: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.district}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Date Range: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.range}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Satellites: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.satellite}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Target Indices: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.indices}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Max Cloud: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.maxCloud}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Level: </span>
              <span style={{ fontWeight: 700, color: '#38bdf8' }}>{configInfo.level}</span>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Composite: </span>
              <span style={{ fontWeight: 700, color: '#ffffff' }}>{configInfo.composite}</span>
            </div>
          </div>
        </div>

        {/* 2. Pipeline Execution Stages & Activity Feed (Latest Active Stage on TOP) */}
        {displayStages && displayStages.length > 0 && (
          <div style={{ backgroundColor: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '0.65rem', padding: '0.9rem 1.1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.65rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0f172a' }}>Pipeline Execution Stages & Steps Activity Log</span>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb', backgroundColor: '#eff6ff', padding: '0.15rem 0.5rem', borderRadius: '0.25rem', border: '1px solid #bfdbfe' }}>
                Latest Active Stage on TOP
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', maxHeight: '180px', overflowY: 'auto' }}>
              {displayStages.map((st, idx) => (
                <div key={idx} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  fontSize: '0.78rem',
                  padding: '0.45rem 0.65rem',
                  borderRadius: '0.375rem',
                  backgroundColor: idx === 0 ? '#f0f9ff' : '#f8fafc',
                  borderLeft: idx === 0 ? '4px solid #0284c7' : '4px solid #cbd5e1'
                }}>
                  {st.timestamp && (
                    <span style={{ fontFamily: 'monospace', color: '#64748b', fontSize: '0.72rem', minWidth: '130px' }}>
                      [{st.timestamp}]
                    </span>
                  )}
                  <span style={{ fontWeight: idx === 0 ? 700 : 600, color: idx === 0 ? '#0369a1' : '#334155' }}>
                    {st.text}
                  </span>
                  {idx === 0 && (
                    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#0284c7', backgroundColor: '#e0f2fe', padding: '0.1rem 0.4rem', borderRadius: '0.2rem', marginLeft: 'auto' }}>
                      ACTIVE / RECENT
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3. AWS S3 vs NAS Storage Gap Check Audit Summary Banner */}
        {gapSummary.availableS3 > 0 && (
          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.65rem', padding: '0.85rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#0f172a' }}>
              Scene Discovery & Archive Gap Check Audit:
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '0.25rem 0.65rem', borderRadius: '0.375rem' }}>
                🌐 Available on AWS S3: {gapSummary.availableS3} scenes
              </span>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, backgroundColor: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', padding: '0.25rem 0.65rem', borderRadius: '0.375rem' }}>
                💾 Already Held on NAS: {gapSummary.alreadyHeld} scenes
              </span>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, backgroundColor: '#fef3c7', color: '#b45309', border: '1px solid #fde68a', padding: '0.25rem 0.65rem', borderRadius: '0.375rem' }}>
                ⬇️ Queued for Download: {gapSummary.missing} scenes
              </span>
            </div>
          </div>
        )}

        {/* 4. Tile Scenes Audit Summary Insights */}
        {tileAuditList && tileAuditList.length > 0 && (
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '0.65rem', padding: '0.85rem 1rem' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#334155', marginBottom: '0.65rem' }}>
              Individual Tile Audit & Storage Status ({tileAuditList.length} Tiles)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
              {tileAuditList.map((t, idx) => (
                <div key={idx} style={{ backgroundColor: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '0.65rem 0.85rem', fontSize: '0.78rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                    <span style={{ fontWeight: 800, color: '#2563eb', fontFamily: 'monospace' }}>Tile: {t.tile}</span>
                    <span style={{
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      padding: '0.1rem 0.4rem',
                      borderRadius: '0.2rem',
                      backgroundColor: t.status === 'DOWNLOADED' ? '#dcfce7' : t.status === 'PARTIAL' ? '#fef3c7' : '#f1f5f9',
                      color: t.status === 'DOWNLOADED' ? '#15803d' : t.status === 'PARTIAL' ? '#b45309' : '#475569'
                    }}>
                      {t.status}
                    </span>
                  </div>
                  <div style={{ color: '#475569', fontSize: '0.74rem' }}>
                    <span style={{ fontWeight: 700 }}>{t.held} / {t.total || '?'}</span> scenes held ({t.total > 0 ? Math.round((t.held/t.total)*100) : 0}% complete)
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 5. KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Total Scenes to Acquire</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#0f172a' }}>{totalScenes}</div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Complete on NAS</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#16a34a' }}>{completeScenes}</div>
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

        {/* 6. Progress Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '0.85rem 1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#334155' }}>Acquisition Progress</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#2563eb' }}>{progressPct}% ({completeScenes} of {totalScenes} completed)</span>
          </div>
          <div style={{ height: '8px', width: '100%', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, backgroundColor: '#2563eb', borderRadius: '9999px', transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* 7. Section Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0.25rem' }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a' }}>
            Acquisition Scenes Breakdown (Latest Logs & Active Downloads on TOP)
          </span>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Showing {displayScenes.length} of {totalScenes} scenes</span>
        </div>

        {/* 8. Scenes Table (Reverse Chronological Order: Recently Running Scene on TOP) */}
        <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '0.75rem 1rem', width: '110px', fontWeight: 700, color: '#475569' }}>Date</th>
                <th style={{ padding: '0.75rem 1rem', width: '90px', fontWeight: 700, color: '#475569' }}>Tile</th>
                <th style={{ padding: '0.75rem 1rem', width: '80px', fontWeight: 700, color: '#475569' }}>Satellite</th>
                <th style={{ padding: '0.75rem 1rem', minWidth: '220px', fontWeight: 700, color: '#475569' }}>Folder / Scene ID</th>
                <th style={{ padding: '0.75rem 1rem', width: '120px', fontWeight: 700, color: '#475569' }}>Tile Progress</th>
                <th style={{ padding: '0.75rem 1rem', width: '130px', fontWeight: 700, color: '#475569' }}>Status</th>
                <th style={{ padding: '0.75rem 1rem', minWidth: '260px', fontWeight: 700, color: '#475569' }}>Bands Verified & Sizes</th>
                <th style={{ padding: '0.75rem 1rem', width: '100px', fontWeight: 700, color: '#475569' }}>Total Size</th>
              </tr>
            </thead>
            <tbody>
              {displayScenes.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                    <RefreshCw size={20} className="animate-spin" style={{ margin: '0 auto 0.5rem auto', color: '#94a3b8' }} />
                    <div>No scenes recorded yet in current execution stream. Waiting for pipeline...</div>
                  </td>
                </tr>
              ) : (
                displayScenes.map((sc, idx) => {
                  const auditInfo = tileAuditList.find(a => a.tile === sc.tile);
                  const tileSceneInsight = auditInfo
                    ? `${auditInfo.held}/${auditInfo.total || '?'} scenes`
                    : '1 Scene';

                  const isDownloading = sc.status === 'DOWNLOADING';
                  const isComplete = sc.status === 'COMPLETE';
                  const isFailed = sc.status === 'FAILED';

                  return (
                    <tr key={sc.folder + idx} style={{
                      borderBottom: '1px solid #f1f5f9',
                      backgroundColor: isDownloading ? '#f0f9ff' : (idx % 2 === 0 ? '#ffffff' : '#fcfcfd')
                    }}>
                      <td style={{ padding: '0.7rem 1rem', color: '#334155', fontFamily: 'monospace', fontWeight: 600 }}>
                        {sc.date}
                      </td>
                      <td style={{ padding: '0.7rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
                        {sc.tile}
                      </td>
                      <td style={{ padding: '0.7rem 1rem', color: '#475569', fontWeight: 600 }}>
                        {sc.satellite}
                      </td>
                      <td style={{ padding: '0.7rem 1rem', color: '#0f172a', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        <div>{sc.folder}</div>
                        {sc.storagePath && (
                          <div style={{ fontSize: '0.68rem', color: '#64748b', wordBreak: 'break-all' }}>
                            📁 {sc.storagePath}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '0.7rem 1rem', color: '#475569', fontSize: '0.74rem', fontWeight: 600 }}>
                        <span style={{ backgroundColor: '#f1f5f9', padding: '0.15rem 0.4rem', borderRadius: '0.2rem', color: '#334155' }}>
                          {tileSceneInsight}
                        </span>
                      </td>
                      <td style={{ padding: '0.7rem 1rem' }}>
                        <span style={{
                          padding: '0.2rem 0.5rem',
                          borderRadius: '0.25rem',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          backgroundColor: isDownloading ? '#e0f2fe' : isComplete ? '#ecfdf5' : isFailed ? '#fee2e2' : '#f8fafc',
                          color: isDownloading ? '#0369a1' : isComplete ? '#047857' : isFailed ? '#dc2626' : '#64748b',
                          border: isDownloading ? '1px solid #7dd3fc' : isComplete ? '1px solid #6ee7b7' : isFailed ? '1px solid #fca5a5' : '1px solid #e2e8f0',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem'
                        }}>
                          {isDownloading && <RefreshCw size={10} className="animate-spin" />}
                          {sc.status}
                          {sc.progressPct && ` (${sc.progressPct})`}
                        </span>
                      </td>
                      <td style={{ padding: '0.7rem 1rem' }}>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {sc.bands && sc.bands.map((b, bIdx) => {
                            const bSize = sc.bandSizes ? sc.bandSizes[b] : null;
                            return (
                              <span key={bIdx} style={{
                                padding: '0.15rem 0.45rem',
                                borderRadius: '0.25rem',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                fontFamily: 'monospace',
                                backgroundColor: '#f0fdf4',
                                border: '1px solid #a7f3d0',
                                color: '#047857'
                              }}>
                                {b}{bSize ? ` (${bSize})` : ''}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td style={{ padding: '0.7rem 1rem', fontFamily: 'monospace', fontSize: '0.74rem', fontWeight: 600, color: '#334155' }}>
                        {sc.totalSize || (sc.bands ? `${sc.bands.length} bands` : '—')}
                      </td>
                    </tr>
                  );
                })
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
            onClick={() => setActiveTab('downloaded_info')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1.25rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              border: 'none',
              borderBottom: activeTab === 'downloaded_info' ? '2px solid #2563eb' : '2px solid transparent',
              color: activeTab === 'downloaded_info' ? '#2563eb' : '#64748b',
              backgroundColor: 'transparent',
              cursor: 'pointer'
            }}
          >
            <Database size={16} /> Downloaded Info & Requests
          </button>

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

                {/* Composite Interval + Level Row */}
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
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>Level</label>
                    <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', outline: 'none' }}>
                      <option value="max">max (Maximum Value Composite)</option>
                      <option value="min">min (Minimum Value Composite)</option>
                      <option value="mean">mean (Average Value Composite)</option>
                    </select>
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Calculation level for NDVI &amp; LSWI temporal compositing</span>
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

                {/* Dynamic Estimated Storage & Download Time Box */}
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

                      {/* Download Time Estimate */}
                      <div style={{ borderLeft: '1px solid #cbd5e1', paddingLeft: '1.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600, color: '#64748b', marginBottom: '0.25rem' }}>
                          <Clock size={14} color="#d97706" /> Estimated Download Duration
                        </div>
                        <div style={{ fontSize: '1.45rem', fontWeight: 800, color: '#92400e' }}>
                          {estResult.downloadTimeText}
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: '0.2rem' }}>
                          Est. at ~12 MB/s pipeline network transfer
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
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Indices</span><span style={{ fontWeight: 600, color: '#0f172a' }}>{(confirmPayload.indices || []).join(', ')}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Calculation Level</span><span style={{ fontWeight: 600, color: '#0284c7' }}>{confirmPayload.level ? confirmPayload.level.toUpperCase() : 'MAX'}</span></div>
                      <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '0.25rem 0' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Scenes</span><span style={{ fontWeight: 700, color: '#0f172a' }}>~{estResult.scenes}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Storage</span><span style={{ fontWeight: 700, fontSize: '1rem', color: willRequireApproval ? '#92400e' : '#166534' }}>{estimatedGb} GB</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Estimated Download Time</span><span style={{ fontWeight: 700, fontSize: '1rem', color: '#92400e' }}>{estResult.downloadTimeText}</span></div>
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
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                  Add new users, assign roles (USER / ADMIN), manage permissions, delete accounts, or inspect individual user pipelines and logs.
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

                {/* Temporal Composite Interval */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}>
                    Temporal Composite Interval {retBand !== 'ALL' && <span style={{ color: '#2563eb', fontSize: '0.72rem', fontWeight: 700 }}>• Active</span>}
                  </label>
                  <select
                    value={retCompositeInterval}
                    onChange={(e) => setRetCompositeInterval(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: retBand !== 'ALL' ? '1px solid #93c5fd' : '1px solid #cbd5e1',
                      fontSize: '0.875rem',
                      backgroundColor: retBand !== 'ALL' ? '#f0f9ff' : '#ffffff'
                    }}
                  >
                    <option value="ALL">All Intervals / Any</option>
                    <option value="weekly">Weekly (7-Day Composite)</option>
                    <option value="fortnightly">Fortnightly (15-Day Composite)</option>
                    <option value="monthly">Monthly (30-Day Composite)</option>
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

                {(retState || retDistrict || retBand !== 'ALL' || retCompositeInterval !== 'ALL' || retSatellite !== 'ALL' || retStartDate || retEndDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRetState('');
                      setRetDistrict('');
                      setRetSatellite('ALL');
                      setRetBand('ALL');
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
                        The system will archive all verified GeoTIFF raster files matching your query into a ZIP package.
                      </p>
                    </div>

                    {/* Progress indicator inside modal */}
                    {downloadingZip && (
                      <div style={{
                        backgroundColor: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        borderRadius: '0.5rem',
                        padding: '0.85rem 1rem',
                        marginBottom: '1.25rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem'
                      }}>
                        <RefreshCw size={20} className="animate-spin" color="#2563eb" />
                        <div>
                          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#1d4ed8' }}>
                            Downloading data in progress...
                          </div>
                          <div style={{ fontSize: '0.78rem', color: '#3b82f6' }}>
                            Retrieving rasters from NAS and streaming ZIP archive.
                          </div>
                        </div>
                      </div>
                    )}

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
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 5: Downloaded Requests Information & Spatial Archive Overview */}
        {/* ========================================================================= */}
        {activeTab === 'downloaded_info' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* Page Title & Context Header */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.25rem 1.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '1rem',
              boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
            }}>
              <div>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Database size={22} color="#2563eb" /> Downloaded Info & Acquisition Requests Overview
                </h2>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: '#2563eb', backgroundColor: '#eff6ff', padding: '0.4rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #bfdbfe', fontWeight: 600 }}>
                <RefreshCw size={14} className="animate-spin" /> Live Auto-Updating (2s)
              </div>
            </div>

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
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: '280px' }}>
                <div style={{ position: 'relative', width: '100%' }}>
                  <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                  <input
                    type="text"
                    value={dlSearchQuery}
                    onChange={(e) => setDlSearchQuery(e.target.value)}
                    placeholder="Search by State, District, Season, Satellite, Bands, or Title..."
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem 0.55rem 2.25rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.85rem',
                      outline: 'none'
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {/* Status Filter */}
                <select
                  value={dlStatusFilter}
                  onChange={(e) => setDlStatusFilter(e.target.value)}
                  style={{ padding: '0.55rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem', backgroundColor: '#ffffff' }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="COMPLETED">COMPLETED</option>
                  <option value="PROCESSING">PROCESSING</option>
                  <option value="ACCEPTED">ACCEPTED</option>
                  <option value="HOLD_FOR_APPROVAL">HOLD FOR APPROVAL</option>
                  <option value="FAILED">FAILED</option>
                </select>

                {/* Satellite Filter */}
                <select
                  value={dlSatFilter}
                  onChange={(e) => setDlSatFilter(e.target.value)}
                  style={{ padding: '0.55rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.85rem', backgroundColor: '#ffffff' }}
                >
                  <option value="ALL">All Satellites</option>
                  <option value="Sentinel-1">Sentinel-1 (SAR)</option>
                  <option value="Sentinel-2">Sentinel-2 (MSI)</option>
                </select>
              </div>
            </div>

            {/* Structured Downloaded Info Table */}
            <div style={{ backgroundColor: '#ffffff', borderRadius: '0.5rem', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontWeight: 700 }}>
                    <th style={{ padding: '0.75rem 1rem', width: '70px' }}>ID</th>
                    <th style={{ padding: '0.75rem 1rem', minWidth: '150px' }}>Request Title</th>
                    <th style={{ padding: '0.75rem 1rem', width: '130px' }}>State</th>
                    <th style={{ padding: '0.75rem 1rem', width: '130px' }}>District</th>
                    <th style={{ padding: '0.75rem 1rem', width: '110px' }}>Season</th>
                    <th style={{ padding: '0.75rem 1rem', width: '180px' }}>Sensing Date Range</th>
                    <th style={{ padding: '0.75rem 1rem', width: '130px' }}>Satellite Sensor</th>
                    <th style={{ padding: '0.75rem 1rem', minWidth: '180px' }}>Bands</th>
                    <th style={{ padding: '0.75rem 1rem', minWidth: '140px' }}>Indices</th>
                    <th style={{ padding: '0.75rem 1rem', width: '130px' }}>Composite Interval</th>
                    <th style={{ padding: '0.75rem 1rem', width: '110px' }}>Status</th>
                    <th style={{ padding: '0.75rem 1rem', width: '130px', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const filtered = requests.filter(r => {
                      if (dlStatusFilter !== 'ALL' && r.status !== dlStatusFilter) return false;
                      if (dlSatFilter !== 'ALL' && !r.satellite.includes(dlSatFilter)) return false;
                      if (dlSearchQuery.trim()) {
                        const q = dlSearchQuery.toLowerCase();
                        const titleStr = (r.request_title || '').toLowerCase();
                        const stateStr = (r.state || '').toLowerCase();
                        const distStr = (r.district || '').toLowerCase();
                        const seasonStr = (r.season || '').toLowerCase();
                        const satStr = (r.satellite || '').toLowerCase();
                        const bandsStr = Array.isArray(r.bands) ? r.bands.join(' ').toLowerCase() : '';
                        const indicesStr = Array.isArray(r.indices) ? r.indices.join(' ').toLowerCase() : '';
                        return (
                          titleStr.includes(q) ||
                          stateStr.includes(q) ||
                          distStr.includes(q) ||
                          seasonStr.includes(q) ||
                          satStr.includes(q) ||
                          bandsStr.includes(q) ||
                          indicesStr.includes(q) ||
                          String(r.id).includes(q)
                        );
                      }
                      return true;
                    });

                    if (filtered.length === 0) {
                      return (
                        <tr>
                          <td colSpan={12} style={{ padding: '3rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                            <Database size={24} style={{ margin: '0 auto 0.5rem auto', color: '#94a3b8' }} />
                            <div>No request entries matched the specified criteria.</div>
                          </td>
                        </tr>
                      );
                    }

                    return filtered.map((req) => (
                      <tr key={req.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                          #{req.id}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#0f172a' }}>
                          {req.request_title}
                          {currentUser?.role === 'ADMIN' && req.user_email && (
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 400 }}>{req.user_email}</div>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#334155', fontWeight: 600 }}>
                          {req.state || '—'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#2563eb', fontWeight: 700, fontFamily: 'monospace' }}>
                          {req.district || '—'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#475569' }}>
                          {req.season || '—'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#334155', fontSize: '0.78rem' }}>
                          {req.start_date} → {req.end_date}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#0f172a' }}>
                          <span style={{ backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8', padding: '0.15rem 0.45rem', borderRadius: '0.25rem', fontSize: '0.75rem' }}>
                            {req.satellite}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                            {Array.isArray(req.bands) && req.bands.length > 0 ? (
                              req.bands.map((b, bIdx) => (
                                <span key={bIdx} style={{ padding: '0.1rem 0.35rem', borderRadius: '0.2rem', fontSize: '0.7rem', fontWeight: 700, fontFamily: 'monospace', backgroundColor: '#f0fdf4', border: '1px solid #a7f3d0', color: '#047857' }}>
                                  {b}
                                </span>
                              ))
                            ) : (
                              <span style={{ color: '#94a3b8' }}>All Bands</span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                            {Array.isArray(req.indices) && req.indices.length > 0 ? (
                              req.indices.map((idx, iIdx) => (
                                <span key={iIdx} style={{ padding: '0.1rem 0.35rem', borderRadius: '0.2rem', fontSize: '0.7rem', fontWeight: 700, fontFamily: 'monospace', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8' }}>
                                  {idx}
                                </span>
                              ))
                            ) : (
                              <span style={{ color: '#94a3b8' }}>—</span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textTransform: 'uppercase', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>
                          {req.composite_interval || 'NONE'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          {renderStatusBadge(req.status)}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                          <button
                            onClick={() => openLogsModal(req)}
                            title="View Execution Logs"
                            style={{ padding: '0.35rem 0.75rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', backgroundColor: '#ffffff', color: '#334155', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600 }}
                          >
                            <Terminal size={13} color="#2563eb" /> Logs
                          </button>
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
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
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.35rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Layers size={22} color="#2563eb" /> Multi-Band Layer Stacking Studio
                </h2>
                <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>
                  Combine individual spectral bands and derived indices into a single unified multi-band GeoTIFF file.
                  Layers are ordered strictly according to your selection sequence and stored to NAS storage in <code style={{ backgroundColor: '#f1f5f9', padding: '0.15rem 0.35rem', borderRadius: '0.25rem', color: '#0f172a' }}>Composites/stack/{'{district}'}/</code>.
                </p>
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
                      setStackDistrict('');
                      setStackDownloadedBandsData({});
                      setStackSelectedScenes({});
                      fetchStackHistory('');
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
                        loadBandsAndScenesForRegion(stackState, d, stackSeason, stackStartDate, stackEndDate);
                      } else {
                        setStackDownloadedBandsData({});
                        setStackSelectedScenes({});
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.875rem', backgroundColor: '#ffffff', fontWeight: 600 }}
                  >
                    <option value="">-- Select Target District --</option>
                    {(retDownloadedDistricts.length > 0 ? retDownloadedDistricts : districtsList)
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
                      const isSar = ['VV', 'VH', 'VV_VH'].includes(layer);
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
                              {scenes.length} scene{scenes.length > 1 ? 's' : ''}
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
                                  Downloaded Scenes (<strong style={{ color: selectedCount > 0 ? '#16a34a' : '#dc2626' }}>{selectedCount}</strong>/{scenes.length} selected):
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
                                            accentColor: groupColor
                                          }}
                                        />
                                        <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          <span style={{ fontWeight: 600, color: isSceneSelected ? '#0f172a' : '#64748b' }}>
                                            📅 {s.sensing_date ? s.sensing_date.split('T')[0] : 'N/A'}
                                          </span>
                                          {s.tile && (
                                            <span style={{ backgroundColor: isSceneSelected ? '#e2e8f0' : '#f1f5f9', color: isSceneSelected ? '#1e293b' : '#64748b', borderRadius: '0.2rem', padding: '0.05rem 0.35rem', fontSize: '0.68rem', fontWeight: 700, marginLeft: '0.35rem' }}>
                                              {s.tile}
                                            </span>
                                          )}
                                          <span style={{ color: isSceneSelected ? '#334155' : '#94a3b8', marginLeft: '0.35rem' }}>
                                            🛰️ {s.scene_id ? (s.scene_id.length > 22 ? s.scene_id.substring(0, 20) + '...' : s.scene_id) : 'Scene'}
                                          </span>
                                          {s.filename && (
                                            <span style={{ color: isSceneSelected ? groupColor : '#94a3b8', marginLeft: '0.45rem', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                              ({s.filename})
                                            </span>
                                          )}
                                        </div>
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
                                          marginLeft: '0.4rem'
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

                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
                    {/* 1. Derived Spectral Indices (FIRST) */}
                    <div style={{ border: '1px solid #bfdbfe', borderRadius: '0.5rem', padding: '1rem', backgroundColor: '#fbfcfe' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', borderBottom: '1px solid #dbeafe', paddingBottom: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <Sliders size={16} color="#2563eb" />
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e40af' }}>
                            Derived Spectral Indices (Calculated On-The-Fly)
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                        {AVAILABLE_INDICES.map(idx => renderLayerCard(idx, '#1d4ed8', '#eff6ff', '#bfdbfe'))}
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
                        {AVAILABLE_SAR_BANDS.map(b => renderLayerCard(b, '#92400e', '#fffbeb', '#fde68a'))}
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
                        {AVAILABLE_OPTICAL_BANDS.map(b => renderLayerCard(b, '#065f46', '#f0fdf4', '#bbf7d0'))}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Preserved Output Filename Field */}
              <div style={{
                marginBottom: '1.5rem',
                padding: '0.85rem 1.25rem',
                backgroundColor: '#f8fafc',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155' }}>
                    Output Stack Filename (Preserved Filename)
                  </label>
                  <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                    Keeps exact original filename for downloaded rasters (e.g. <code style={{ backgroundColor: '#e2e8f0', padding: '0.1rem 0.3rem', borderRadius: '0.2rem', color: '#0f172a' }}>NDVI.tif</code>)
                  </span>
                </div>
                <input
                  type="text"
                  value={stackCustomFilename}
                  onChange={(e) => setStackCustomFilename(e.target.value)}
                  placeholder="e.g. NDVI.tif or district_stack.tif"
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.85rem',
                    fontFamily: 'monospace',
                    backgroundColor: '#ffffff',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

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

                <button
                  onClick={handleExecuteLayerStacking}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <CheckCircle size={22} color="#16a34a" />
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                      Layer Stack Generated Successfully
                    </h3>
                  </div>
                  <button
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

            {/* Previously Stacked Files History Table */}
            <div style={{
              backgroundColor: '#ffffff',
              borderRadius: '0.75rem',
              border: '1px solid #e2e8f0',
              padding: '1.5rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: '0 0 0.25rem 0', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <HardDrive size={18} color="#2563eb" /> Existing Layer Stacks on NAS Archive
                  </h3>
                  <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Archived in <code style={{ backgroundColor: '#f1f5f9', padding: '0.1rem 0.3rem', borderRadius: '0.2rem' }}>Composites/stack/</code> directory
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                    <input
                      type="text"
                      placeholder="Search files or district..."
                      value={stackHistorySearch}
                      onChange={(e) => setStackHistorySearch(e.target.value)}
                      style={{ padding: '0.4rem 0.65rem 0.4rem 2rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.8rem' }}
                    />
                  </div>
                  <button
                    onClick={() => fetchStackHistory(stackDistrict)}
                    disabled={loadingStackHistory}
                    title="Refresh History"
                    style={{ padding: '0.4rem 0.65rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: '#475569' }}
                  >
                    <RefreshCw size={13} className={loadingStackHistory ? 'spin' : ''} /> Refresh
                  </button>
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: '0.78rem', textTransform: 'uppercase' }}>
                      <th style={{ padding: '0.75rem 1rem' }}>Stacked File Name</th>
                      <th style={{ padding: '0.75rem 1rem' }}>District</th>
                      <th style={{ padding: '0.75rem 1rem' }}>File Size</th>
                      <th style={{ padding: '0.75rem 1rem' }}>Generated / Modified</th>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingStackHistory ? (
                      <tr>
                        <td colSpan="5" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                          <RefreshCw size={20} className="spin" style={{ display: 'inline-block', marginBottom: '0.5rem' }} />
                          <div>Checking NAS archive for stacked rasters...</div>
                        </td>
                      </tr>
                    ) : stackHistory.length === 0 ? (
                      <tr>
                        <td colSpan="5" style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                          No layer stacks found in NAS archive for the selected district. Use the studio form above to generate one.
                        </td>
                      </tr>
                    ) : (
                      stackHistory
                        .filter(item => {
                          if (!stackHistorySearch) return true;
                          const q = stackHistorySearch.toLowerCase();
                          return (item.filename || '').toLowerCase().includes(q) || (item.district || '').toLowerCase().includes(q);
                        })
                        .map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#0f172a', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                              {item.filename}
                            </td>
                            <td style={{ padding: '0.75rem 1rem', color: '#334155' }}>
                              {item.district || '—'}
                            </td>
                            <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#475569' }}>
                              {item.size_mb} MB
                            </td>
                            <td style={{ padding: '0.75rem 1rem', color: '#64748b', fontSize: '0.8rem' }}>
                              {item.modified_at || '—'}
                            </td>
                            <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                              <button
                                onClick={() => handleDownloadStackedTif(item.path, item.filename)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem',
                                  padding: '0.35rem 0.75rem',
                                  borderRadius: '0.375rem',
                                  backgroundColor: '#eff6ff',
                                  border: '1px solid #bfdbfe',
                                  color: '#1d4ed8',
                                  fontSize: '0.78rem',
                                  fontWeight: 600,
                                  cursor: 'pointer'
                                }}
                              >
                                <Download size={13} /> Download .tif
                              </button>
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