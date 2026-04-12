import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Input,
  InputNumber,
  Tooltip,
  Spin,
  Alert,
  type InputRef,
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
} from "@ant-design/icons";
import { useVirtualizer } from "@tanstack/react-virtual";

import FileViewer from "./FileViewer";
import FileViewerFull from "./FileViewerFull";
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

interface SearchResponse {
  results: MergedSearchResult[];
  total_count: number;
  elapsed_ms?: number;
  is_truncated?: boolean;
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

const App: React.FC = () => {
  const [searchParams, setSearchParams] = useState<SearchParams>({
    directory: "",
    query: "",
    case_sensitive: false,
    is_regex: false,
    include_patterns: [],
    exclude_patterns: [],
    max_results: 200,
  });

  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
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

  // Viewer states
  const [viewerState, setViewerState] = useState<{
    visible: boolean;
    filePath: string | null;
    initialLine: number | null;
  }>({ visible: false, filePath: null, initialLine: null });

  const [fileViewerState, setFileViewerState] = useState<{
    visible: boolean;
    filePath: string | null;
  }>({ visible: false, filePath: null });

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

  // Active filter count indicator
  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (includeText.trim()) count++;
    if (excludeText.trim()) count++;
    if (searchParams.max_results !== 200) count++;
    return count;
  }, [includeText, excludeText, searchParams.max_results]);

  const handleDirectorySelect = async () => {
    try {
      setLoading(true);
      const result = await invoke<string | null>("select_directory");
      if (result) {
        setSearchParams((prev) => ({ ...prev, directory: result }));
        setError(null);
      }
    } catch (err) {
      setError(`选择目录时出错: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchParams.directory) {
      setError("请先选择要搜索的日志目录");
      return;
    }
    if (!searchParams.query.trim()) {
      setError("请输入搜索关键词 (支持管道多条件，如 error | timeout)");
      return;
    }

    try {
      setLoading(true);
      setError(null);

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
      setHasSearched(true);
      setCollapsedFiles(new Set()); // reset collapsed state for new search
    } catch (err) {
      setError(`搜索出错: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [searchParams, includeText, excludeText]);

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

  const totalMatchedBlocks = useMemo(() => {
    return fileGroups.reduce((acc, g) => acc + g.blocks.length, 0);
  }, [fileGroups]);

  const totalHits = useMemo(() => {
    return fileGroups.reduce((acc, g) => acc + g.totalMatches, 0);
  }, [fileGroups]);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="app-topbar">
        <div className="topbar-brand">
          <div className="brand-icon">IL</div>
          <span className="brand-title">Insight Log</span>
          <span className="brand-tag">7z+zip</span>
        </div>

        <div className="topbar-center">
          {searchParams.directory ? (
            <Tooltip title={`当前目录: ${searchParams.directory} (点击更换)`}>
              <div className="directory-badge" onClick={handleDirectorySelect}>
                <FolderOpenOutlined style={{ color: "#1677ff" }} />
                <span className="directory-path">{searchParams.directory}</span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>更换</span>
              </div>
            </Tooltip>
          ) : (
            <Button
              type="dashed"
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={handleDirectorySelect}
            >
              选择日志目录
            </Button>
          )}
        </div>

        <div className="topbar-actions">
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
                setFileViewerState({ visible: true, filePath });
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
                  placeholder="搜索日志内容 (支持管道多条件，如 error | timeout)"
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
              </div>

              <Button
                type="primary"
                size="large"
                icon={<SearchOutlined />}
                loading={loading}
                disabled={!searchParams.directory || !searchParams.query.trim()}
                onClick={handleSearch}
                style={{ fontWeight: 600, padding: "0 22px" }}
              >
                搜索
              </Button>

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
                {searchStats.isTruncated && (
                  <span className="stat-badge-truncated">
                    已达上限 {searchParams.max_results} 条 (部分结果已截断)
                  </span>
                )}
                {fileGroups.length > 0 && (
                  <span style={{ marginLeft: 6, display: "flex", gap: 6 }}>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={handleCollapseAll}>
                      全部折叠
                    </Button>
                    <span style={{ color: "#cbd5e1" }}>|</span>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={handleExpandAll}>
                      全部展开
                    </Button>
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
                  支持普通文本日志以及 ZIP、TAR、GZ、7z 压缩包内容的快速检索与行级查看
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
                            <Tooltip title="在完整查看器中浏览此文件">
                              <Button
                                type="text"
                                size="small"
                                icon={<EyeOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFileViewerState({
                                    visible: true,
                                    filePath: item.filePath,
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
                      <div className="match-block">
                        <div className="block-header">
                          <span className="block-line-range">
                            第 {item.block.start_line} - {item.block.end_line} 行
                          </span>
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

      {/* Target Result Viewer */}
      <FileViewer
        visible={viewerState.visible}
        onClose={() => setViewerState({ visible: false, filePath: null, initialLine: null })}
        filePath={viewerState.filePath}
        initialLine={viewerState.initialLine}
      />

      {/* Full File Viewer (From FileTree or Header Action) */}
      <FileViewerFull
        visible={fileViewerState.visible}
        onClose={() => setFileViewerState({ visible: false, filePath: null })}
        filePath={fileViewerState.filePath}
      />
    </div>
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
