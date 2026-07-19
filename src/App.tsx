import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Button,
  Input,
  InputNumber,
  Tooltip,
  Spin,
  Alert,
  Modal,
  Dropdown,
  Switch,
  message,
  type InputRef,
  type MenuProps,
  ConfigProvider,
  theme as antdTheme,
} from "antd";
import {
  FolderOpenOutlined,
  SearchOutlined,
  ClearOutlined,
  FilterOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DownOutlined,
  RightOutlined,
  EyeOutlined,
  InboxOutlined,
  FileTextOutlined,
  FileZipOutlined,
  CloseOutlined,
  HistoryOutlined,
  DeleteOutlined,
  CopyOutlined,
  ExportOutlined,
  LinkOutlined,
  BulbOutlined,
  MoonOutlined,
  DesktopOutlined,
  FolderViewOutlined,
} from "@ant-design/icons";
import { useVirtualizer } from "@tanstack/react-virtual";

import LogDetailViewer from "./LogDetailViewer";
import FileTree from "./FileTree";
import "./App.css";

interface LineResult {
  line_number: number;
  content: string;
  is_match: boolean;
  match_ranges: [number, number][] | null;
}

interface MergedSearchResult {
  file_path: string;
  start_line: number;
  end_line: number;
  lines: LineResult[];
  match_count: number;
}

interface SearchParams {
  directory: string;
  query: string;
  case_sensitive: boolean;
  is_regex: boolean;
  include_patterns: string[];
  exclude_patterns: string[];
  max_results: number;
}

interface SkippedFileInfo {
  path: string;
  reason: string;
}

interface DroppedPathInfo {
  root_directory: string;
  is_directory: boolean;
  file_name: string | null;
  is_archive: boolean;
}

const RECENT_PATHS_KEY = "insight-log:recent-paths";
const RESTORE_DIR_KEY = "insight-log:restore-last-dir";
const LAST_DIR_KEY = "insight-log:last-directory";
const MAX_RECENT = 5;

function loadRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecentPaths(paths: string[]) {
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(paths.slice(0, MAX_RECENT)));
}

function loadRestorePreference(): boolean {
  const raw = localStorage.getItem(RESTORE_DIR_KEY);
  if (raw === null) return true;
  return raw === "true";
}

interface SearchResponse {
  results: MergedSearchResult[];
  total_count: number;
  elapsed_ms?: number;
  is_truncated?: boolean;
  skipped_files?: SkippedFileInfo[];
  cancelled?: boolean;
}

interface FileGroup {
  filePath: string;
  blocks: MergedSearchResult[];
  totalMatches: number;
}

type FlatItem =
  | {
      type: "file_header";
      key: string;
      filePath: string;
      totalMatches: number;
      blockCount: number;
      isCollapsed: boolean;
    }
  | {
      type: "block";
      key: string;
      filePath: string;
      block: MergedSearchResult;
      isFirstInFile: boolean;
      isLastInFile: boolean;
    };


function formatBlockMarkdown(filePath: string, block: MergedSearchResult): string {
  const body = block.lines.map((l) => l.content).join("\n");
  return `> ${filePath}:${block.start_line}-${block.end_line}\n\`\`\`log\n${body}\n\`\`\`\n`;
}

function formatResultsMarkdown(groups: FileGroup[]): string {
  const parts: string[] = ["# Insight Log 搜索结果导出", ""];
  for (const g of groups) {
    parts.push(`## ${g.filePath}`, "");
    for (const block of g.blocks) {
      parts.push(formatBlockMarkdown(g.filePath, block));
    }
  }
  return parts.join("\n");
}

function formatResultsPlain(groups: FileGroup[]): string {
  const parts: string[] = [];
  for (const g of groups) {
    parts.push(`===== ${g.filePath} =====`);
    for (const block of g.blocks) {
      parts.push(`--- lines ${block.start_line}-${block.end_line} ---`);
      for (const line of block.lines) {
        parts.push(`${line.line_number}| ${line.content}`);
      }
      parts.push("");
    }
  }
  return parts.join("\n");
}

async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(okMsg);
  } catch (err) {
    message.error(`复制失败: ${err}`);
  }
}


type ThemeMode = "light" | "dark" | "system";

const PREFS_KEY = "insight-log:search-prefs";

type PersistedPrefs = {
  max_results?: number;
  includeText?: string;
  excludeText?: string;
  case_sensitive?: boolean;
  is_regex?: boolean;
  theme?: ThemeMode;
  restoreLastDir?: boolean;
};

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPrefs;
  } catch {
    return {};
  }
}

function savePrefs(partial: PersistedPrefs) {
  const next = { ...loadPrefs(), ...partial };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}


function resolveRevealPath(filePath: string): string {
  if (filePath.includes(" → ")) {
    return filePath.split(" → ")[0].trim();
  }
  return filePath;
}

const App: React.FC = () => {
  const initialPrefs = useMemo(() => loadPrefs(), []);
  const [searchParams, setSearchParams] = useState<SearchParams>({
    directory: "",
    query: "",
    case_sensitive: initialPrefs.case_sensitive ?? false,
    is_regex: initialPrefs.is_regex ?? false,
    include_patterns: [],
    exclude_patterns: [],
    max_results: initialPrefs.max_results ?? 200,
  });

  const [includeText, setIncludeText] = useState(initialPrefs.includeText ?? "");
  const [excludeText, setExcludeText] = useState(initialPrefs.excludeText ?? "");
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialPrefs.theme ?? "system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(initialPrefs.theme ?? "system")
  );
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [results, setResults] = useState<MergedSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchStats, setSearchStats] = useState<{
    elapsedMs?: number;
    isTruncated?: boolean;
    totalCount?: number;
  }>({});

  const [secondaryFilter, setSecondaryFilter] = useState("");
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [skippedFiles, setSkippedFiles] = useState<SkippedFileInfo[]>([]);
  const [isSkippedModalOpen, setIsSkippedModalOpen] = useState(false);
  const [searchCancelled, setSearchCancelled] = useState(false);
  const [activeBlockKey, setActiveBlockKey] = useState<string | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>(() => loadRecentPaths());
  const [restoreLastDir, setRestoreLastDir] = useState<boolean>(() => loadRestorePreference());
  const [isDragging, setIsDragging] = useState(false);

  // Unified detail viewer
  const [viewerState, setViewerState] = useState<{
    visible: boolean;
    filePath: string | null;
    initialLine: number | null;
  }>({ visible: false, filePath: null, initialLine: null });

  const searchInputRef = useRef<InputRef>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const rememberDirectory = useCallback(async (dir: string, focusedFile?: string | null) => {
    if (!dir) return;
    try {
      await invoke("set_search_root", { directory: dir });
    } catch {
      // ignore if command unavailable during early boot
    }
    setSearchParams((prev) => {
      const next = { ...prev, directory: dir };
      if (focusedFile) {
        // Prefer focusing the dropped file via include glob when useful
        return next;
      }
      return next;
    });
    if (focusedFile) {
      setIncludeText(`**/${focusedFile}`);
      setIsFilterOpen(true);
    }
    setRecentPaths((prev) => {
      const next = [dir, ...prev.filter((p) => p !== dir)].slice(0, MAX_RECENT);
      saveRecentPaths(next);
      return next;
    });
    localStorage.setItem(LAST_DIR_KEY, dir);
    setError(null);
  }, []);

  // Cold-start restore last directory
  useEffect(() => {
    if (!restoreLastDir) return;
    const last = localStorage.getItem(LAST_DIR_KEY);
    if (!last) return;
    void (async () => {
      try {
        await invoke("set_search_root", { directory: last });
        setSearchParams((prev) => ({ ...prev, directory: last }));
      } catch {
        // path may no longer exist
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native drag-drop of folders / log archives
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDragging(true);
          } else if (event.payload.type === "leave") {
            setIsDragging(false);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            const paths = event.payload.paths || [];
            if (!paths.length) return;
            try {
              const info = await invoke<DroppedPathInfo>("resolve_dropped_path", {
                droppedPath: paths[0],
              });
              await rememberDirectory(
                info.root_directory,
                info.is_directory ? null : info.file_name
              );
              message.success(
                info.is_directory
                  ? `已切换到目录: ${info.root_directory}`
                  : `已定位到文件: ${info.file_name}`
              );
            } catch (err) {
              message.error(`无法打开拖入路径: ${err}`);
            }
          }
        });
      } catch {
        // browser / non-tauri env
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [rememberDirectory]);

  // Persist search preferences
  useEffect(() => {
    savePrefs({
      max_results: searchParams.max_results,
      includeText,
      excludeText,
      case_sensitive: searchParams.case_sensitive,
      is_regex: searchParams.is_regex,
      theme: themeMode,
      restoreLastDir,
    });
  }, [
    searchParams.max_results,
    searchParams.case_sensitive,
    searchParams.is_regex,
    includeText,
    excludeText,
    themeMode,
    restoreLastDir,
  ]);

  // Apply theme to document + antd
  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(themeMode);
      setResolvedTheme(next);
      document.documentElement.setAttribute("data-theme", next);
    };
    apply();
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => apply();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeMode]);


  // Active filter count indicator
  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (includeText.trim()) count++;
    if (excludeText.trim()) count++;
    if (searchParams.max_results !== 200) count++;
    return count;
  }, [includeText, excludeText, searchParams.max_results]);

  const regexError = useMemo(() => {
    if (!searchParams.is_regex || !searchParams.query.trim()) {
      return null;
    }
    try {
      new RegExp(searchParams.query);
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg;
    }
  }, [searchParams.is_regex, searchParams.query]);

  const handleDirectorySelect = async () => {
    try {
      setLoading(true);
      const result = await invoke<string | null>("select_directory");
      if (result) {
        await rememberDirectory(result);
      }
    } catch (err) {
      setError(`选择目录时出错: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePickRecent = async (dir: string) => {
    try {
      await rememberDirectory(dir);
      message.success(`已切换到: ${dir}`);
    } catch (err) {
      message.error(`无法打开目录: ${err}`);
    }
  };

  const handleClearRecent = () => {
    setRecentPaths([]);
    saveRecentPaths([]);
    message.info("已清除最近路径");
  };

  const recentMenuItems: MenuProps["items"] = [
    ...recentPaths.map((p) => ({
      key: p,
      label: p,
      onClick: () => void handlePickRecent(p),
    })),
    ...(recentPaths.length
      ? [{ type: "divider" as const }, { key: "__clear__", label: "清除最近记录", danger: true, icon: <DeleteOutlined />, onClick: handleClearRecent }]
      : [{ key: "__empty__", label: "暂无最近路径", disabled: true }]),
    { type: "divider" as const },
    {
      key: "__restore__",
      label: (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }} onClick={(e) => e.stopPropagation()}>
          <span>启动时恢复上次目录</span>
          <Switch
            size="small"
            checked={restoreLastDir}
            onChange={(checked) => {
              setRestoreLastDir(checked);
              localStorage.setItem(RESTORE_DIR_KEY, String(checked));
            }}
          />
        </div>
      ),
    },
  ];

  const handleSearch = useCallback(async () => {
    if (!searchParams.directory) {
      setError("请先选择要搜索的日志目录");
      return;
    }
    if (!searchParams.query.trim()) {
      setError("请输入搜索关键词 (支持管道多条件，如 error | timeout)");
      return;
    }
    if (regexError) {
      setError(`正则表达式语法错误: ${regexError}`);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSearchCancelled(false);

      const parsedIncludes = includeText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const parsedExcludes = excludeText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const response: SearchResponse = await invoke("search_logs", {
        searchParams: {
          ...searchParams,
          include_patterns: parsedIncludes,
          exclude_patterns: parsedExcludes,
        },
      });

      setResults(response.results);
      setSearchStats({
        elapsedMs: response.elapsed_ms,
        isTruncated: response.is_truncated,
        totalCount: response.total_count,
      });
      setSkippedFiles(response.skipped_files || []);
      setSearchCancelled(!!response.cancelled);
      setHasSearched(true);
      setCollapsedFiles(new Set()); // reset collapsed state for new search
      setActiveBlockKey(null);
    } catch (err) {
      setError(`搜索出错: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [searchParams, includeText, excludeText, regexError]);

  const handleCancelSearch = useCallback(async () => {
    try {
      await invoke("cancel_search");
      setSearchCancelled(true);
      message.info("正在停止搜索…");
    } catch (err) {
      message.error(`停止失败: ${err}`);
    }
  }, []);

  const handleRevealInFolder = useCallback(async (filePath: string) => {
    const target = resolveRevealPath(filePath);
    try {
      await revealItemInDir(target);
    } catch (err) {
      message.error(`无法在系统文件夹中显示: ${err}`);
    }
  }, []);

  const handleClear = () => {
    setSearchParams((prev) => ({
      ...prev,
      query: "",
    }));
    setResults([]);
    setError(null);
    setHasSearched(false);
    setSecondaryFilter("");
    setSearchStats({});
    setSkippedFiles([]);
    setSearchCancelled(false);
  };

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleCollapseAll = () => {
    const all = new Set(fileGroups.map((g) => g.filePath));
    setCollapsedFiles(all);
  };

  const handleExpandAll = () => {
    setCollapsedFiles(new Set());
  };

  const handleExportResults = async (format: "md" | "txt") => {
    if (fileGroups.length === 0) {
      message.warning("当前没有可导出的结果");
      return;
    }
    const content =
      format === "md" ? formatResultsMarkdown(fileGroups) : formatResultsPlain(fileGroups);
    const defaultName =
      format === "md" ? "insight-log-results.md" : "insight-log-results.txt";
    try {
      const saved = await invoke<string | null>("save_text_file", {
        defaultName,
        content,
      });
      if (saved) {
        message.success(`已导出到: ${saved}`);
      }
    } catch (err) {
      message.error(`导出失败: ${err}`);
    }
  };

  const exportMenuItems: MenuProps["items"] = [
    { key: "md", label: "导出为 Markdown (.md)", onClick: () => void handleExportResults("md") },
    { key: "txt", label: "导出为纯文本 (.txt)", onClick: () => void handleExportResults("txt") },
  ];

  // Group and secondary filter
  const fileGroups = useMemo<FileGroup[]>(() => {
    const term = secondaryFilter.trim().toLowerCase();
    const filteredResults = term
      ? results.filter((res) => {
          if (res.file_path.toLowerCase().includes(term)) return true;
          return res.lines.some((l) => l.content.toLowerCase().includes(term));
        })
      : results;

    const map = new Map<string, MergedSearchResult[]>();
    for (const item of filteredResults) {
      const list = map.get(item.file_path) || [];
      list.push(item);
      map.set(item.file_path, list);
    }

    const groups: FileGroup[] = [];
    map.forEach((blocks, filePath) => {
      const totalMatches = blocks.reduce((acc, b) => acc + b.match_count, 0);
      groups.push({ filePath, blocks, totalMatches });
    });

    return groups;
  }, [results, secondaryFilter]);

  // Flatten for virtualization
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const group of fileGroups) {
      const isCollapsed = collapsedFiles.has(group.filePath);
      items.push({
        type: "file_header",
        key: `header-${group.filePath}`,
        filePath: group.filePath,
        totalMatches: group.totalMatches,
        blockCount: group.blocks.length,
        isCollapsed,
      });

      if (!isCollapsed) {
        group.blocks.forEach((block, idx) => {
          items.push({
            type: "block",
            key: `block-${group.filePath}-${block.start_line}-${block.end_line}`,
            filePath: group.filePath,
            block,
            isFirstInFile: idx === 0,
            isLastInFile: idx === group.blocks.length - 1,
          });
        });
      }
    }
    return items;
  }, [fileGroups, collapsedFiles]);

  const rowVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => {
      const item = flatItems[index];
      if (!item) return 40;
      if (item.type === "file_header") return 42;
      return 36 + item.block.lines.length * 21;
    },
    overscan: 6,
  });


  // Keyboard navigation across result blocks
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || el.isContentEditable) return true;
      return !!el.closest(".ant-input, .ant-input-number, .cm-editor, [contenteditable=true]");
    };

    const blockKeys = flatItems.filter((i) => i.type === "block").map((i) => i.key);

    const handleKeyDown = (e: KeyboardEvent) => {
      // Esc: close viewer first, else clear secondary filter / blur
      if (e.key === "Escape") {
        if (viewerState.visible) {
          e.preventDefault();
          setViewerState({ visible: false, filePath: null, initialLine: null });
          return;
        }
        if (isSkippedModalOpen) {
          e.preventDefault();
          setIsSkippedModalOpen(false);
          return;
        }
        if (secondaryFilter) {
          e.preventDefault();
          setSecondaryFilter("");
          return;
        }
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        return;
      }

      if (!blockKeys.length) return;

      const typing = isTypingTarget(e.target);
      // Arrow keys: allow even from input if not composing query? Prompt: don't hijack letters when in input
      const isNavKey =
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        (!typing && (e.key === "j" || e.key === "k"));

      if (!isNavKey) return;
      if (typing && (e.key === "j" || e.key === "k")) return;
      // Allow arrows/enter outside inputs; for Enter only when not typing
      if (typing && e.key === "Enter") return;
      if (viewerState.visible) return;

      const currentIdx = activeBlockKey ? blockKeys.indexOf(activeBlockKey) : -1;

      if (e.key === "ArrowDown" || (!typing && e.key === "j")) {
        e.preventDefault();
        const next = Math.min(blockKeys.length - 1, currentIdx + 1);
        const key = blockKeys[next < 0 ? 0 : next];
        setActiveBlockKey(key);
        const flatIdx = flatItems.findIndex((i) => i.key === key);
        if (flatIdx >= 0) rowVirtualizer.scrollToIndex(flatIdx, { align: "auto" });
        return;
      }
      if (e.key === "ArrowUp" || (!typing && e.key === "k")) {
        e.preventDefault();
        const next = Math.max(0, currentIdx <= 0 ? 0 : currentIdx - 1);
        const key = blockKeys[next];
        setActiveBlockKey(key);
        const flatIdx = flatItems.findIndex((i) => i.key === key);
        if (flatIdx >= 0) rowVirtualizer.scrollToIndex(flatIdx, { align: "auto" });
        return;
      }
      if (e.key === "Enter" && activeBlockKey) {
        const item = flatItems.find((i) => i.key === activeBlockKey);
        if (item && item.type === "block") {
          e.preventDefault();
          setViewerState({
            visible: true,
            filePath: item.filePath,
            initialLine: item.block.start_line,
          });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    flatItems,
    activeBlockKey,
    viewerState.visible,
    isSkippedModalOpen,
    secondaryFilter,
    rowVirtualizer,
  ]);

  const totalMatchedBlocks = useMemo(() => {
    return fileGroups.reduce((acc, g) => acc + g.blocks.length, 0);
  }, [fileGroups]);

  const totalHits = useMemo(() => {
    return fileGroups.reduce((acc, g) => acc + g.totalMatches, 0);
  }, [fileGroups]);

  return (
    <ConfigProvider
      theme={{
        algorithm:
          resolvedTheme === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
      }}
    >
    <div className={`app-container ${isDragging ? "is-dragging" : ""}`}>
      {isDragging && (
        <div className="drag-overlay">松开以设置为搜索根目录</div>
      )}
      {/* Top Navigation Bar */}
      <header className="app-topbar">
        <div className="topbar-brand">
          <div className="brand-icon">IL</div>
          <span className="brand-title">Insight Log</span>
          <span className="brand-tag">7z+zip</span>
        </div>

        <div className="topbar-center">
          {searchParams.directory ? (
            <div className="directory-badge-group">
              <Tooltip title={`当前目录: ${searchParams.directory} (点击更换)`}>
                <div className="directory-badge" onClick={handleDirectorySelect}>
                  <FolderOpenOutlined style={{ color: "#1677ff" }} />
                  <span className="directory-path">{searchParams.directory}</span>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>更换</span>
                </div>
              </Tooltip>
              <Dropdown menu={{ items: recentMenuItems }} trigger={["click"]} placement="bottomRight">
                <Button size="small" type="text" icon={<HistoryOutlined />} className="recent-paths-btn" />
              </Dropdown>
            </div>
          ) : (
            <div className="directory-badge-group">
              <Button
                type="dashed"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={handleDirectorySelect}
              >
                选择日志目录
              </Button>
              <Dropdown menu={{ items: recentMenuItems }} trigger={["click"]} placement="bottomRight">
                <Button size="small" type="text" icon={<HistoryOutlined />} className="recent-paths-btn" />
              </Dropdown>
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <Dropdown
            menu={{
              items: [
                { key: "light", label: "浅色", icon: <BulbOutlined />, onClick: () => setThemeMode("light") },
                { key: "dark", label: "深色", icon: <MoonOutlined />, onClick: () => setThemeMode("dark") },
                { key: "system", label: "跟随系统", icon: <DesktopOutlined />, onClick: () => setThemeMode("system") },
              ],
              selectedKeys: [themeMode],
            }}
            placement="bottomRight"
          >
            <Button
              size="small"
              icon={resolvedTheme === "dark" ? <MoonOutlined /> : <BulbOutlined />}
            >
              主题
            </Button>
          </Dropdown>
          <Tooltip title={isSidebarOpen ? "收起文件树" : "展开文件树浏览"}>
            <Button
              size="small"
              icon={isSidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              type={isSidebarOpen ? "primary" : "default"}
              ghost={isSidebarOpen}
            >
              文件树
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* Workspace */}
      <div className="app-workspace">
        {/* Collapsible File Tree Sidebar */}
        <aside className={`file-tree-sidebar ${isSidebarOpen ? "" : "collapsed"}`}>
          <div className="sidebar-header">
            <span>文件结构</span>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={() => setIsSidebarOpen(false)}
            />
          </div>
          <div className="sidebar-body">
            <FileTree
              directory={searchParams.directory}
              onFileDoubleClick={(filePath) => {
                setViewerState({ visible: true, filePath, initialLine: null });
              }}
            />
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="main-content">
          {/* Primary Search Hero */}
          <div className="search-hero">
            <div className="search-bar-row">
              <div className="search-input-wrapper">
                <Input
                  ref={searchInputRef}
                  className="main-search-input"
                  size="large"
                  status={regexError ? "error" : undefined}
                  placeholder={
                    searchParams.is_regex
                      ? "输入正则表达式 (如 (NullPointer|IndexOutOfBounds)Exception)"
                      : "搜索日志内容 (管道多条件如 error | timeout，支持 \\| 转义)"
                  }
                  prefix={<SearchOutlined style={{ color: "#94a3b8", marginRight: 4 }} />}
                  value={searchParams.query}
                  onChange={(e) =>
                    setSearchParams((prev) => ({ ...prev, query: e.target.value }))
                  }
                  onPressEnter={handleSearch}
                  allowClear
                  suffix={
                    <div className="search-toggle-pills">
                      <Tooltip title="大小写敏感开关 (Match Case)">
                        <span
                          className={`toggle-pill ${searchParams.case_sensitive ? "active" : ""}`}
                          onClick={() =>
                            setSearchParams((prev) => ({
                              ...prev,
                              case_sensitive: !prev.case_sensitive,
                            }))
                          }
                        >
                          Aa
                        </span>
                      </Tooltip>
                      <Tooltip title="正则表达式开关 (Use Regular Expression)">
                        <span
                          className={`toggle-pill ${searchParams.is_regex ? "active" : ""}`}
                          onClick={() =>
                            setSearchParams((prev) => ({
                              ...prev,
                              is_regex: !prev.is_regex,
                            }))
                          }
                        >
                          .*
                        </span>
                      </Tooltip>
                      <Tooltip title="高级筛选 (包含/排除模式、最大结果数)">
                        <span
                          className={`toggle-pill ${isFilterOpen || activeFiltersCount > 0 ? "active" : ""}`}
                          onClick={() => setIsFilterOpen(!isFilterOpen)}
                        >
                          <FilterOutlined style={{ marginRight: 2 }} />
                          {activeFiltersCount > 0 ? activeFiltersCount : "筛选"}
                        </span>
                      </Tooltip>
                    </div>
                  }
                />
                {regexError && (
                  <div className="regex-error-hint">
                    ⚠️ 正则语法错误: {regexError}
                  </div>
                )}
              </div>

              {loading ? (
                <Button
                  danger
                  type="primary"
                  size="large"
                  onClick={() => void handleCancelSearch()}
                  style={{ fontWeight: 600, padding: "0 22px" }}
                >
                  停止
                </Button>
              ) : (
                <Button
                  type="primary"
                  size="large"
                  icon={<SearchOutlined />}
                  disabled={!searchParams.directory || !searchParams.query.trim() || !!regexError}
                  onClick={handleSearch}
                  style={{ fontWeight: 600, padding: "0 22px" }}
                >
                  搜索
                </Button>
              )}

              <Button
                size="large"
                icon={<ClearOutlined />}
                onClick={handleClear}
                disabled={loading || (!searchParams.query && results.length === 0)}
              >
                清空
              </Button>
            </div>

            {/* Expandable Advanced Filter Panel */}
            {isFilterOpen && (
              <div className="filter-panel">
                <div className="filter-item">
                  <span className="filter-label">包含模式 (Glob 逗号分隔)</span>
                  <Input
                    size="small"
                    placeholder="例如: **/*.log, **/catalina-*.out"
                    value={includeText}
                    onChange={(e) => setIncludeText(e.target.value)}
                    allowClear
                  />
                </div>
                <div className="filter-item">
                  <span className="filter-label">排除模式 (Glob 逗号分隔)</span>
                  <Input
                    size="small"
                    placeholder="例如: **/node_modules/**, *.tmp, **/.git/**"
                    value={excludeText}
                    onChange={(e) => setExcludeText(e.target.value)}
                    allowClear
                  />
                </div>
                <div className="filter-item" style={{ width: 140 }}>
                  <span className="filter-label">最大结果数</span>
                  <InputNumber
                    size="small"
                    min={10}
                    max={10000}
                    step={100}
                    value={searchParams.max_results}
                    onChange={(v) =>
                      setSearchParams((prev) => ({ ...prev, max_results: v || 200 }))
                    }
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Error Banner */}
          {error && (
            <Alert
              message={error}
              type="error"
              showIcon
              closable
              onClose={() => setError(null)}
              style={{ margin: "10px 20px 0" }}
            />
          )}

          {/* Results Summary Bar (Shown when search has executed) */}
          {hasSearched && (
            <div className="results-summary-bar">
              <div className="summary-stats">
                <span className="stat-item">
                  命中文件: <span className="stat-value">{fileGroups.length}</span>
                </span>
                <span className="stat-item">
                  匹配块: <span className="stat-value">{totalMatchedBlocks}</span>
                </span>
                <span className="stat-item">
                  命中行: <span className="stat-value">{totalHits}</span>
                </span>
                {searchStats.elapsedMs !== undefined && (
                  <span className="stat-item">
                    耗时: <span className="stat-value">{searchStats.elapsedMs} ms</span>
                  </span>
                )}
                {searchCancelled && (
                  <span className="stat-badge-truncated" style={{ background: "#fee2e2", color: "#b91c1c" }}>
                    已取消 — 显示停止前已收集的结果
                  </span>
                )}
                {searchStats.isTruncated && !searchCancelled && (
                  <span className="stat-badge-truncated">
                    已达上限 {searchParams.max_results} 条 (部分结果已截断)
                  </span>
                )}
                {skippedFiles.length > 0 && (
                  <Tooltip title="点击查看因超限或异常跳过的文件详情">
                    <span
                      className="stat-badge-skipped"
                      onClick={() => setIsSkippedModalOpen(true)}
                      role="button"
                      tabIndex={0}
                    >
                      ⚠️ 跳过了 {skippedFiles.length} 个超限/损坏文件 (点击查看)
                    </span>
                  </Tooltip>
                )}
                {fileGroups.length > 0 && (
                  <span style={{ marginLeft: 6, display: "flex", gap: 6, alignItems: "center" }}>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={handleCollapseAll}>
                      全部折叠
                    </Button>
                    <span style={{ color: "#cbd5e1" }}>|</span>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={handleExpandAll}>
                      全部展开
                    </Button>
                    <span style={{ color: "#cbd5e1" }}>|</span>
                    <Dropdown menu={{ items: exportMenuItems }} placement="bottomRight">
                      <Button type="link" size="small" style={{ padding: 0 }} icon={<ExportOutlined />}>
                        导出
                      </Button>
                    </Dropdown>
                  </span>
                )}
              </div>

              {results.length > 0 && (
                <div className="secondary-filter-input">
                  <Input
                    size="small"
                    placeholder="结果内二次过滤 (路径/内容)..."
                    prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
                    value={secondaryFilter}
                    onChange={(e) => setSecondaryFilter(e.target.value)}
                    allowClear
                  />
                </div>
              )}
            </div>
          )}

          {/* Results Viewport */}
          <div className="results-viewport" ref={viewportRef}>
            {loading ? (
              <div className="loading-state-wrapper">
                <Spin size="large" />
                <span>正在检索日志与压缩包条目...</span>
              </div>
            ) : !searchParams.directory ? (
              // Empty State 1: No Directory
              <div className="empty-state-wrapper">
                <FolderOpenOutlined className="empty-state-icon" style={{ color: "#3b82f6" }} />
                <div className="empty-state-title">请先选择日志工作目录</div>
                <div className="empty-state-desc">
                  支持普通文本日志以及 ZIP、TAR、GZ、7z 压缩包内容的快速检索与行级查看。也可直接把文件夹或日志/归档拖入窗口。
                </div>
                <Button type="primary" icon={<FolderOpenOutlined />} onClick={handleDirectorySelect}>
                  选择日志目录
                </Button>
              </div>
            ) : !hasSearched ? (
              // Empty State 2: Ready to search
              <div className="empty-state-wrapper">
                <SearchOutlined className="empty-state-icon" />
                <div className="empty-state-title">输入关键词开始检索日志</div>
                <div className="empty-state-desc">
                  当前工作目录：<code>{searchParams.directory}</code>
                </div>
                <div className="empty-state-tip">
                  提示：支持多关键词同行过滤 <code>error | timeout | 500</code>（逻辑 AND）
                </div>
              </div>
            ) : flatItems.length === 0 ? (
              // Empty State 3: No Results Found
              <div className="empty-state-wrapper">
                <InboxOutlined className="empty-state-icon" />
                <div className="empty-state-title">未找到匹配日志</div>
                <div className="empty-state-desc">
                  {secondaryFilter
                    ? `二次过滤关键词 "${secondaryFilter}" 无匹配`
                    : `在当前目录下未检索到匹配 "${searchParams.query}" 的日志行`}
                </div>
                <div className="empty-state-tip">
                  建议检查大小写敏感、正则表达式开关，或调整包含/排除模式
                </div>
              </div>
            ) : (
              // Virtualized Results List
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const item = flatItems[virtualItem.index];
                  if (!item) return null;

                  if (item.type === "file_header") {
                    return (
                      <div
                        key={item.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                      >
                        <div
                          className={`file-group-header ${item.isCollapsed ? "collapsed" : ""}`}
                        >
                          <div
                            className="file-header-left"
                            onClick={() => toggleFileCollapse(item.filePath)}
                          >
                            {item.isCollapsed ? (
                              <RightOutlined style={{ fontSize: 11, color: "#94a3b8" }} />
                            ) : (
                              <DownOutlined style={{ fontSize: 11, color: "#94a3b8" }} />
                            )}
                            {item.filePath.includes(" → ") ? (
                              <FileZipOutlined style={{ color: "#0284c7" }} />
                            ) : (
                              <FileTextOutlined style={{ color: "#64748b" }} />
                            )}
                            <span className="file-header-title">
                              {renderFormattedFilePath(item.filePath)}
                            </span>
                            <span className="match-count-badge">
                              {item.totalMatches} 命中
                            </span>
                          </div>

                          <div className="file-header-actions">
                            <Tooltip title="复制文件路径">
                              <Button
                                type="text"
                                size="small"
                                icon={<LinkOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void copyText(item.filePath, "路径已复制");
                                }}
                              >
                                复制路径
                              </Button>
                            </Tooltip>
                            <Tooltip title="在系统文件夹中显示（归档则定位母包）">
                              <Button
                                type="text"
                                size="small"
                                icon={<FolderViewOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleRevealInFolder(item.filePath);
                                }}
                              >
                                显示
                              </Button>
                            </Tooltip>
                            <Tooltip title="在完整查看器中浏览此文件">
                              <Button
                                type="text"
                                size="small"
                                icon={<EyeOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setViewerState({
                                    visible: true,
                                    filePath: item.filePath,
                                    initialLine: null,
                                  });
                                }}
                              >
                                打开文件
                              </Button>
                            </Tooltip>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Render match block
                  return (
                    <div
                      key={item.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <div
                        className={`match-block ${activeBlockKey === item.key ? "match-block--active" : ""}`}
                        onClick={() => setActiveBlockKey(item.key)}
                      >
                        <div className="block-header">
                          <span className="block-line-range">
                            第 {item.block.start_line} - {item.block.end_line} 行
                          </span>
                          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <Button
                              type="link"
                              size="small"
                              style={{ fontSize: 11, padding: 0 }}
                              icon={<CopyOutlined />}
                              onClick={() => {
                                void copyText(
                                  formatBlockMarkdown(item.filePath, item.block),
                                  "匹配块已复制为 Markdown"
                                );
                              }}
                            >
                              复制
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              style={{ fontSize: 11, padding: 0 }}
                              onClick={() => {
                                setViewerState({
                                  visible: true,
                                  filePath: item.filePath,
                                  initialLine: item.block.start_line,
                                });
                              }}
                            >
                              定位查看
                            </Button>
                          </span>
                        </div>

                        <pre className="log-snippet">
                          {item.block.lines.map((line) => (
                            <div
                              key={line.line_number}
                              className={`log-line ${line.is_match ? "log-line--match" : ""}`}
                            >
                              <span className="log-line-num">{line.line_number}</span>
                              <span className="log-line-text">
                                {renderLineSegments(line)}
                              </span>
                            </div>
                          ))}
                        </pre>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      <LogDetailViewer
        visible={viewerState.visible}
        onClose={() => setViewerState({ visible: false, filePath: null, initialLine: null })}
        filePath={viewerState.filePath}
        initialLine={viewerState.initialLine}
        query={searchParams.query}
        isRegex={searchParams.is_regex}
        caseSensitive={searchParams.case_sensitive}
      />

      {/* Skipped Oversized / Corrupted Files Modal */}
      <Modal
        title="⚠️ 跳过的文件与异常列表"
        open={isSkippedModalOpen}
        onCancel={() => setIsSkippedModalOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setIsSkippedModalOpen(false)}>
            我知道了
          </Button>,
        ]}
        width={720}
      >
        <Alert
          message="文件读取与性能安全限额说明"
          description="为防止超大文件或恶意压缩炸弹引发内存溢出 (OOM)，系统设置了防护硬限：单文件上限 100MB，归档单条目上限 20MB，归档总解压上限 100MB。超限、无读取权限或解析异常的文件已被自动跳过。"
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>文件路径</th>
                <th style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0", width: 220 }}>跳过原因</th>
              </tr>
            </thead>
            <tbody>
              {skippedFiles.map((file, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", wordBreak: "break-all" }}>
                    {file.path}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#b45309" }}>{file.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
    </ConfigProvider>
  );
};

function renderFormattedFilePath(filePath: string): React.ReactNode {
  if (filePath.includes(" → ")) {
    const [archive, inner] = filePath.split(" → ");
    const archiveName = archive.split(/[/\\]/).pop() || archive;
    const ext = archiveName.split(".").pop()?.toUpperCase() || "ARCHIVE";
    return (
      <>
        <span className="archive-tag">{ext}</span>{" "}
        <span style={{ color: "#64748b" }}>{archiveName} →</span>{" "}
        <span style={{ color: "#0f172a" }}>{inner}</span>
      </>
    );
  }

  const parts = filePath.split(/[/\\]/);
  const fileName = parts.pop() || filePath;
  const dirPath = parts.join("/");

  return (
    <>
      {dirPath && <span style={{ color: "#94a3b8", fontWeight: 400 }}>{dirPath}/</span>}
      <span style={{ color: "#0f172a" }}>{fileName}</span>
    </>
  );
}

function renderLineSegments(line: LineResult): React.ReactNode {
  const { content, match_ranges } = line;
  if (!match_ranges || match_ranges.length === 0) {
    return content;
  }

  const segments: React.ReactNode[] = [];
  let lastIndex = 0;

  match_ranges.forEach((range, index) => {
    const [start, end] = range;
    if (start > lastIndex) {
      segments.push(
        <span key={`text-${index}`}>{content.slice(lastIndex, start)}</span>
      );
    }
    segments.push(
      <mark key={`mark-${index}`} className="search-highlight">
        {content.slice(start, end)}
      </mark>
    );
    lastIndex = end;
  });

  if (lastIndex < content.length) {
    segments.push(<span key="text-tail">{content.slice(lastIndex)}</span>);
  }

  return segments;
}

export default App;
