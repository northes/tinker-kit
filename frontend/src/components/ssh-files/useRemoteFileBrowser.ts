import { Events } from '@wailsio/runtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CancelRemoteFileRequest,
  GetFileSources,
  GetRemoteCreationTimes,
  ListRemoteFiles,
  SearchRemoteFiles,
} from '../../../bindings/changeme/fileservice';
import type { RemoteFileEntry, SSHProfile } from '../../../bindings/changeme/models';
import {
  DIRECTORY_CACHE_TTL_MS,
  directoryListingKey,
  errorMessage,
  isRemotePathNotFound,
  normalizeRemotePath,
  sshProfileListingKey,
  type CachedDirectoryListing,
  type CancellableCall,
  type DirectoryLoadingPhase,
  type LoadingKind,
  type ManagedFileSource,
  type MissingFavoritePath,
  type RemoteSearchMode,
  type RemoteSearchScope,
} from './model';

// 目录浏览、搜索与来源加载共用修订号和取消边界，缓存同时供目录树使用。
export function useRemoteFileBrowser({
  active,
  profiles,
  manageOpen,
}: {
  active: boolean;
  profiles: SSHProfile[];
  manageOpen: boolean;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<ManagedFileSource[]>([]);
  const [sourceID, setSourceID] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathEditing, setPathEditing] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<RemoteSearchMode>('name');
  const [searchScope, setSearchScope] = useState<RemoteSearchScope>('current');
  const [searchActive, setSearchActive] = useState(false);
  const [searching, setSearching] = useState(false);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoryLoadingPhase, setDirectoryLoadingPhase] =
    useState<DirectoryLoadingPhase>('connecting');
  const [loadingSources, setLoadingSources] = useState(false);
  const [loadingCanceled, setLoadingCanceled] = useState<LoadingKind | null>(null);
  const [error, setError] = useState('');
  const [missingFavoritePath, setMissingFavoritePath] = useState<MissingFavoritePath | null>(null);
  const sourcesRequestRef = useRef(0);
  const directoryRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const loadingKindRef = useRef<LoadingKind | null>(null);
  const loadingCallsRef = useRef(new Set<CancellableCall>());
  const pendingFavoritePathRef = useRef<MissingFavoritePath | null>(null);
  const directoryLoadKeyRef = useRef('');
  const directoryCacheRef = useRef(new Map<string, CachedDirectoryListing>());
  const sourcesLoadedRef = useRef(false);
  const cancelLoading = useCallback(() => {
    const kind = loadingKindRef.current;
    if (!kind) return;
    const activeDirectoryRequestID = String(directoryRequestRef.current);
    // 目录加载被中断时清空已加载标记，返回该工具时会重新加载。
    if (kind === 'directory') directoryLoadKeyRef.current = '';
    sourcesRequestRef.current++;
    directoryRequestRef.current++;
    searchRequestRef.current++;
    const requests = Array.from(loadingCallsRef.current);
    loadingCallsRef.current.clear();
    loadingKindRef.current = null;
    if (kind === 'directory') {
      void CancelRemoteFileRequest(activeDirectoryRequestID).catch(() => undefined);
    } else {
      for (const request of requests) void request.cancel();
    }
    setLoadingSources(false);
    setLoading(false);
    setSearching(false);
    setError('');
    setLoadingCanceled(kind);
  }, []);

  useEffect(() => {
    return () => {
      const activeDirectoryRequestID = String(directoryRequestRef.current);
      if (loadingKindRef.current === 'directory')
        void CancelRemoteFileRequest(activeDirectoryRequestID).catch(() => undefined);
      sourcesRequestRef.current++;
      directoryRequestRef.current++;
      searchRequestRef.current++;
      const requests = Array.from(loadingCallsRef.current);
      loadingCallsRef.current.clear();
      if (loadingKindRef.current !== 'directory') {
        for (const request of requests) void request.cancel();
      }
    };
  }, []);
  const source = sources.find((item) => item.id === sourceID) ?? null;
  const favoritePaths = source?.favoritePaths ?? [];
  const isCurrentPathFavorite = favoritePaths.includes(currentPath);
  const activeSourceProfileID = source?.sshProfileID ?? '';
  const activeSourceProfile = profiles.find((item) => item.id === activeSourceProfileID);
  const sourceUsable = Boolean(source && activeSourceProfile);
  const sourceDefaultPath = source?.defaultPath ?? '';
  const loadingDirectoryPath = currentPath.trim()
    ? currentPath
    : sourceDefaultPath.trim()
      ? normalizeRemotePath(sourceDefaultPath)
      : t('sshFilesTool.remoteHome');
  const profileListingKey = useMemo(
    () => sshProfileListingKey(activeSourceProfile),
    [activeSourceProfile],
  );
  const directoryLoadKey = sourceID
    ? directoryListingKey(
        sourceID,
        activeSourceProfileID,
        profileListingKey,
        currentPath,
        showHidden,
      )
    : '';
  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean);
    return [
      { label: '/', path: '/' },
      ...parts.map((part, index) => ({
        label: part,
        path: `/${parts.slice(0, index + 1).join('/')}`,
      })),
    ];
  }, [currentPath]);
  const loadSources = useCallback(async () => {
    const requestID = ++sourcesRequestRef.current;
    loadingKindRef.current = 'sources';
    setLoadingCanceled(null);
    setLoadingSources(true);
    setError('');
    let sourceRequest: ReturnType<typeof GetFileSources> | null = null;
    try {
      sourceRequest = GetFileSources();
      loadingCallsRef.current.add(sourceRequest);
      const nextSources = await sourceRequest;
      if (requestID !== sourcesRequestRef.current) return;
      setSources(nextSources ?? []);
      setSourceID((current) =>
        nextSources?.some((item) => item.id === current) ? current : nextSources?.[0]?.id || '',
      );
      sourcesLoadedRef.current = true;
    } catch (reason) {
      if (requestID !== sourcesRequestRef.current) return;
      throw reason;
    } finally {
      if (sourceRequest) loadingCallsRef.current.delete(sourceRequest);
      if (requestID === sourcesRequestRef.current) {
        setLoadingSources(false);
        if (loadingKindRef.current === 'sources') loadingKindRef.current = null;
      }
    }
  }, []);
  const loadDirectory = useCallback(
    async (id: string, pathValue: string, hidden: boolean, forceReload = false) => {
      const requestID = ++directoryRequestRef.current;
      loadingKindRef.current = 'directory';
      setDirectoryLoadingPhase('connecting');
      setLoadingCanceled(null);
      const requested = pathValue.trim();
      const normalizedPath = requested ? normalizeRemotePath(requested) : '';
      const pendingFavoritePath =
        pendingFavoritePathRef.current?.sourceID === id &&
        pendingFavoritePathRef.current.path === normalizedPath
          ? pendingFavoritePathRef.current
          : null;
      pendingFavoritePathRef.current = null;
      setMissingFavoritePath(null);
      if (!id) {
        if (loadingKindRef.current === 'directory') loadingKindRef.current = null;
        setEntries([]);
        setSelected([]);
        setError('');
        setLoading(false);
        return;
      }
      const cacheKey = directoryListingKey(
        id,
        activeSourceProfileID,
        profileListingKey,
        normalizedPath,
        hidden,
      );
      const cacheScope = [id, activeSourceProfileID, profileListingKey].join('\0') + '\0';
      if (forceReload) {
        for (const [key, cached] of directoryCacheRef.current) {
          if (key.startsWith(cacheScope) && (key === cacheKey || cached.path === normalizedPath)) {
            directoryCacheRef.current.delete(key);
          }
        }
      }
      if (!forceReload) {
        const cached = directoryCacheRef.current.get(cacheKey);
        if (cached && Date.now() - cached.cachedAt < DIRECTORY_CACHE_TTL_MS) {
          const resolvedKey = directoryListingKey(
            id,
            activeSourceProfileID,
            profileListingKey,
            cached.path,
            hidden,
          );
          directoryLoadKeyRef.current = resolvedKey;
          setEntries(cached.entries);
          setSelected([]);
          setError('');
          setLoading(false);
          setCurrentPath(cached.path);
          setPathInput(cached.path);
          if (loadingKindRef.current === 'directory') loadingKindRef.current = null;
          return;
        }
        if (cached) {
          for (const [key, candidate] of directoryCacheRef.current) {
            if (candidate.requestID === cached.requestID) directoryCacheRef.current.delete(key);
          }
        }
      }
      setLoading(true);
      setError('');
      setEntries([]);
      setSelected([]);
      const request = ListRemoteFiles(id, normalizedPath, hidden, String(requestID));
      loadingCallsRef.current.add(request);
      try {
        const result = await request;
        if (requestID !== directoryRequestRef.current) return;
        const resolved = result.path ? normalizeRemotePath(result.path) : normalizedPath;
        const nextEntries = result.entries ?? [];
        const resolvedKey = directoryListingKey(
          id,
          activeSourceProfileID,
          profileListingKey,
          resolved,
          hidden,
        );
        const cachedListing: CachedDirectoryListing = {
          cachedAt: Date.now(),
          requestID,
          path: resolved,
          entries: nextEntries,
        };
        directoryCacheRef.current.set(cacheKey, cachedListing);
        directoryCacheRef.current.set(resolvedKey, cachedListing);
        setEntries(nextEntries);
        if (nextEntries.length) {
          const metadataRequest = GetRemoteCreationTimes(
            id,
            nextEntries.map((entry) => entry.path),
          );
          loadingCallsRef.current.add(metadataRequest);
          void metadataRequest
            .then((createdAt) => {
              if (!createdAt) return;
              const withCreationTimes = nextEntries.map((entry) => ({
                ...entry,
                createdAt: createdAt[entry.path] ?? entry.createdAt,
              }));
              for (const key of new Set([cacheKey, resolvedKey])) {
                const cached = directoryCacheRef.current.get(key);
                if (cached?.requestID === requestID) {
                  directoryCacheRef.current.set(key, { ...cached, entries: withCreationTimes });
                }
              }
              if (requestID === directoryRequestRef.current) setEntries(withCreationTimes);
            })
            .catch(() => undefined)
            .finally(() => loadingCallsRef.current.delete(metadataRequest));
        }
        if (resolved) {
          directoryLoadKeyRef.current = resolvedKey;
          setCurrentPath(resolved);
          setPathInput(resolved);
        }
      } catch (reason) {
        if (requestID !== directoryRequestRef.current) return;
        setEntries([]);
        const message = errorMessage(reason);
        setError(message);
        if (pendingFavoritePath && isRemotePathNotFound(reason)) {
          setMissingFavoritePath(pendingFavoritePath);
        }
      } finally {
        loadingCallsRef.current.delete(request);
        if (requestID === directoryRequestRef.current) {
          setLoading(false);
          if (loadingKindRef.current === 'directory') loadingKindRef.current = null;
        }
      }
    },
    [activeSourceProfileID, profileListingKey],
  );
  const resetSearchState = useCallback(() => {
    searchRequestRef.current++;
    setSearchInput('');
    setSearchQuery('');
    setSearchActive(false);
    setSearching(false);
  }, []);
  const executeSearch = async (queryValue = searchInput) => {
    if (!sourceUsable || searching) return;
    const query = queryValue.trim();
    if (!query) {
      resetSearchState();
      if (sourceID) await loadDirectory(sourceID, currentPath, showHidden);
      return;
    }

    const requestID = ++searchRequestRef.current;
    directoryRequestRef.current++;
    loadingKindRef.current = 'search';
    setLoadingCanceled(null);
    setSearchInput(query);
    setSearchQuery(query);
    setSearchActive(true);
    setSearching(true);
    setLoading(true);
    setError('');
    setEntries([]);
    setSelected([]);
    const request = SearchRemoteFiles(
      sourceID,
      currentPath,
      query,
      searchMode,
      searchScope,
      showHidden,
    );
    loadingCallsRef.current.add(request);
    try {
      const result = await request;
      if (requestID !== searchRequestRef.current) return;
      setEntries(result ?? []);
    } catch (reason) {
      if (requestID !== searchRequestRef.current) return;
      setEntries([]);
      setError(errorMessage(reason));
    } finally {
      loadingCallsRef.current.delete(request);
      if (requestID === searchRequestRef.current) {
        setLoading(false);
        setSearching(false);
        if (loadingKindRef.current === 'search') loadingKindRef.current = null;
      }
    }
  };
  const retryCanceledLoading = () => {
    const kind = loadingCanceled;
    setLoadingCanceled(null);
    setError('');
    if (kind === 'sources') {
      void loadSources().catch((reason) => setError(errorMessage(reason)));
    } else if (kind === 'search' && searchQuery) {
      void executeSearch(searchQuery);
    } else if (sourceID) {
      void loadDirectory(sourceID, currentPath, showHidden);
    }
  };
  const reloadCurrentView = () => {
    if (searchActive && searchQuery) {
      void executeSearch(searchQuery);
    } else if (sourceID) {
      void loadDirectory(sourceID, currentPath, showHidden, true);
    }
  };
  const clearSearch = () => {
    const shouldReload = searchActive || Boolean(searchQuery);
    resetSearchState();
    if (shouldReload && sourceID) {
      void loadDirectory(sourceID, currentPath, showHidden);
    } else if (shouldReload) {
      setEntries([]);
      setSelected([]);
      setError('');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      cancelLoading();
      return;
    }
    if (sourcesLoadedRef.current) return;
    resetSearchState();
    void loadSources().catch((reason) => setError(errorMessage(reason)));
  }, [active, cancelLoading, loadSources, resetSearchState]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => void loadSources().catch((reason) => setError(errorMessage(reason)));
    window.addEventListener('tinkerkit:config-replaced', refresh);
    return () => window.removeEventListener('tinkerkit:config-replaced', refresh);
  }, [active, loadSources]);

  useEffect(() => {
    if (!active) return;
    const offDirectoryLoading = Events.On('ssh-files:directory-loading', (event) => {
      const payload = event.data as { requestID?: string; phase?: string };
      if (
        payload.requestID !== String(directoryRequestRef.current) ||
        loadingKindRef.current !== 'directory'
      ) {
        return;
      }
      if (payload.phase === 'connecting' || payload.phase === 'loadingDirectory') {
        setDirectoryLoadingPhase(payload.phase);
      }
    });

    return () => offDirectoryLoading();
  }, [active]);

  useEffect(() => {
    if (!active || !sourceID) return;
    if (manageOpen) return;
    if (!sourceUsable) {
      directoryLoadKeyRef.current = directoryLoadKey;
      resetSearchState();
      setEntries([]);
      setLoading(false);
      setError(t('sshFilesTool.sshProfileMissing'));
      return;
    }
    const nextPath = sourceDefaultPath
      ? currentPath === '/' || !currentPath.trim()
        ? normalizeRemotePath(sourceDefaultPath)
        : normalizeRemotePath(currentPath)
      : currentPath.trim()
        ? normalizeRemotePath(currentPath)
        : '';
    if (nextPath !== currentPath) {
      setCurrentPath(nextPath);
      setPathInput(nextPath);
      return;
    }
    setPathInput(currentPath);
    if (directoryLoadKeyRef.current === directoryLoadKey) return;
    directoryLoadKeyRef.current = directoryLoadKey;
    resetSearchState();
    void loadDirectory(sourceID, currentPath, showHidden);
  }, [
    active,
    currentPath,
    directoryLoadKey,
    loadDirectory,
    manageOpen,
    resetSearchState,
    showHidden,
    sourceDefaultPath,
    sourceID,
    sourceUsable,
    t,
  ]);
  const navigate = (nextPath: string, navigationSource: 'favorite' | 'normal' = 'normal') => {
    const normalizedPath = normalizeRemotePath(nextPath);
    pendingFavoritePathRef.current =
      navigationSource === 'favorite' && sourceID
        ? { sourceID, path: normalizedPath, previousPath: currentPath }
        : null;
    resetSearchState();
    setPathEditing(false);
    setEntries([]);
    setSelected([]);
    setError('');
    setLoading(true);
    if (normalizedPath === currentPath) {
      void loadDirectory(sourceID, normalizedPath, showHidden);
      return;
    }
    setCurrentPath(normalizedPath);
  };

  return {
    currentPath,
    sourceID,
    activeSourceProfileID,
    profileListingKey,
    reloadCurrentView,
    sourceUsable,
    loadingSources,
    loading,
    searching,
    setError,
    resetSearchState,
    loadDirectory,
    showHidden,
    selected,
    entries,
    setSelected,
    source,
    favoritePaths,
    sources,
    setSources,
    missingFavoritePath,
    setMissingFavoritePath,
    navigate,
    searchActive,
    setEntries,
    setSourceID,
    searchMode,
    searchScope,
    setLoading,
    setPathEditing,
    setCurrentPath,
    setShowHidden,
    executeSearch,
    searchInput,
    setSearchInput,
    clearSearch,
    setSearchMode,
    setSearchScope,
    pathEditing,
    pathInput,
    setPathInput,
    breadcrumbs,
    isCurrentPathFavorite,
    cancelLoading,
    directoryLoadingPhase,
    loadingDirectoryPath,
    loadingCanceled,
    retryCanceledLoading,
    error,
    directoryCache: directoryCacheRef.current,
  };
}
