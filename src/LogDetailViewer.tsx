import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Modal, Spin, message, Button, Space, Select, Alert, InputNumber } from "antd";
import CodeMirror from "@uiw/react-codemirror";
import {
  lineNumbers,
  EditorView,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { search } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";

export type LogDetailViewerProps = {
  visible: boolean;
  onClose: () => void;
  filePath: string | null;
  initialLine?: number | null;
  query?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
};

type LoadedRange = {
  start: number;
  end: number;
  content: string;
};

interface FileInfo {
  size: number;
  is_archive: boolean;
  archive_contents?: string[];
}

const errorDeco = Decoration.mark({ class: "cm-log-error" });
const warnDeco = Decoration.mark({ class: "cm-log-warn" });
const infoDeco = Decoration.mark({ class: "cm-log-info" });
const debugDeco = Decoration.mark({ class: "cm-log-debug" });

const logSyntaxHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }
    buildDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const regex =
          /\b(FATAL|ERROR|SEVERE)\b|\b(WARN|WARNING)\b|\b(INFO)\b|\b(DEBUG|TRACE)\b/gi;
        let match;
        while ((match = regex.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          const upper = match[0].toUpperCase();
          if (upper === "FATAL" || upper === "ERROR" || upper === "SEVERE") {
            builder.add(start, end, errorDeco);
          } else if (upper === "WARN" || upper === "WARNING") {
            builder.add(start, end, warnDeco);
          } else if (upper === "INFO") {
            builder.add(start, end, infoDeco);
          } else {
            builder.add(start, end, debugDeco);
          }
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

const setPulseLine = StateEffect.define<number | null>();
const pulseField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPulseLine)) {
        if (e.value == null) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          deco = Decoration.set([
            Decoration.line({ class: "cm-pulse-line" }).range(line.from),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const pulseLineTheme = EditorView.baseTheme({
  ".cm-pulse-line": {
    backgroundColor: "rgba(250, 204, 21, 0.45)",
    transition: "background-color 1.2s ease-out",
  },
  ".cm-search-hit": {
    backgroundColor: "#fde047",
    borderRadius: "2px",
  },
});

function buildQueryHighlighter(
  query: string,
  isRegex: boolean,
  caseSensitive: boolean
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const deco = Decoration.mark({ class: "cm-search-hit" });
        if (!query.trim()) return builder.finish();
        let regex: RegExp | null = null;
        try {
          if (isRegex) {
            regex = new RegExp(query, caseSensitive ? "g" : "gi");
          } else {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
          }
        } catch {
          return builder.finish();
        }
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(text)) !== null) {
            if (match[0].length === 0) {
              regex.lastIndex++;
              continue;
            }
            const start = from + match.index;
            builder.add(start, start + match[0].length, deco);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export default function LogDetailViewer({
  visible,
  onClose,
  filePath,
  initialLine = null,
  query = "",
  isRegex = false,
  caseSensitive = false,
}: LogDetailViewerProps) {
  const [loadedRanges, setLoadedRanges] = useState<LoadedRange[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalLines, setTotalLines] = useState(0);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [showLargeFileWarning, setShowLargeFileWarning] = useState(false);
  const [selectedInnerPath, setSelectedInnerPath] = useState<string | null>(null);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const didScrollRef = useRef(false);
  const maxLinesPerLoad = 1000;
  const LARGE_FILE_SIZE = 50 * 1024 * 1024;

  const [actualPath, initialInnerPath] = useMemo(() => {
    if (!filePath) return ["", null as string | null];
    if (filePath.includes(" → ")) {
      const parts = filePath.split(" → ");
      return [parts[0].trim(), parts[1].trim()];
    }
    return [filePath, null];
  }, [filePath]);

  const modalTitle = useMemo(() => {
    if (!filePath) return "";
    const activeInner = selectedInnerPath || initialInnerPath;
    const base = activeInner ? `${actualPath} → ${activeInner}` : actualPath;
    return initialLine ? `${base} (第 ${initialLine} 行)` : base;
  }, [filePath, actualPath, initialInnerPath, selectedInnerPath, initialLine]);

  const virtualPath = useMemo(() => {
    if (!actualPath) return null;
    if (selectedInnerPath) return `${actualPath} → ${selectedInnerPath}`;
    if (initialInnerPath) return `${actualPath} → ${initialInnerPath}`;
    return actualPath;
  }, [actualPath, selectedInnerPath, initialInnerPath]);

  const loadFileInfo = useCallback(
    async (path: string) => {
      try {
        setLoading(true);
        const info: FileInfo = await invoke("get_file_info", { filePath: path });
        setFileInfo(info);
        if (info.is_archive) {
          try {
            const contents: string[] = await invoke("get_archive_contents", {
              archivePath: path,
            });
            setFileInfo((prev) =>
              prev ? { ...prev, archive_contents: contents } : null
            );
            const toSelect =
              initialInnerPath || (contents.length === 1 ? contents[0] : null);
            if (toSelect) setSelectedInnerPath(toSelect);
          } catch (err) {
            console.error(err);
            message.error("获取压缩文件内容列表失败");
          }
        }
        setShowLargeFileWarning(info.size > LARGE_FILE_SIZE);
      } catch (error) {
        console.error(error);
        message.error("获取文件信息失败");
      } finally {
        setLoading(false);
      }
    },
    [initialInnerPath]
  );

  const fetchContent = useCallback(
    async (
      path: string,
      startLine: number,
      endLine: number | null = null,
      innerPath: string | null = null
    ) => {
      if (!path) return;
      setLoading(true);
      try {
        let result: unknown;
        const readPath = innerPath ? `${path} → ${innerPath}` : path;
        // Prefer unified read_file_content which understands virtual archive paths
        result = await invoke("read_file_content", {
          filePath: readPath,
          startLine,
          endLine: endLine || null,
        });

        let parsedResult: {
          content: string;
          startLine: number;
          endLine: number;
          totalLines: number;
        };
        if (typeof result === "string") {
          parsedResult = JSON.parse(result);
        } else if (typeof result === "object" && result !== null) {
          parsedResult = result as typeof parsedResult;
        } else {
          throw new Error("Invalid result format");
        }

        const newRange: LoadedRange = {
          start: parsedResult.startLine,
          end: parsedResult.endLine,
          content: parsedResult.content,
        };

        setLoadedRanges((prev) => {
          const existingIndex = prev.findIndex(
            (range) =>
              range.start === newRange.start && range.end === newRange.end
          );
          if (existingIndex !== -1) {
            const updated = [...prev];
            updated[existingIndex] = newRange;
            return updated;
          }
          return [...prev, newRange];
        });
        setTotalLines(parsedResult.totalLines);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "加载文件内容失败";
        message.error(msg);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (visible && actualPath) {
      setLoadedRanges([]);
      setTotalLines(0);
      setFileInfo(null);
      setSelectedInnerPath(null);
      setShowLargeFileWarning(false);
      didScrollRef.current = false;
      setJumpLine(initialLine);
      void loadFileInfo(actualPath);
    } else if (!visible) {
      setLoadedRanges([]);
      setTotalLines(0);
      setFileInfo(null);
      setSelectedInnerPath(null);
      setShowLargeFileWarning(false);
      didScrollRef.current = false;
    }
  }, [visible, actualPath, loadFileInfo, initialLine]);

  useEffect(() => {
    if (!visible || !fileInfo || !actualPath) return;
    if (fileInfo.is_archive) {
      if (!selectedInnerPath) return;
      setLoadedRanges([]);
      setTotalLines(0);
      didScrollRef.current = false;
      if (initialLine && initialLine > 0) {
        const start = Math.max(0, initialLine - 1);
        void fetchContent(actualPath, start, start + maxLinesPerLoad, selectedInnerPath);
      } else {
        void fetchContent(actualPath, 0, maxLinesPerLoad, selectedInnerPath);
      }
    } else if (loadedRanges.length === 0) {
      if (initialLine && initialLine > 0) {
        const start = Math.max(0, initialLine - 1);
        void fetchContent(actualPath, start, start + maxLinesPerLoad);
      } else {
        void fetchContent(actualPath, 0, maxLinesPerLoad);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileInfo, selectedInnerPath, visible, actualPath]);

  const { combinedContent, lineIndexToPhysicalLine } = useMemo(() => {
    if (loadedRanges.length === 0) {
      return { combinedContent: "", lineIndexToPhysicalLine: [] as number[] };
    }
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    const lineNumbersList: number[] = [];
    const contents: string[] = [];

    sortedRanges.forEach((range, rangeIdx) => {
      if (rangeIdx > 0) {
        const prevRange = sortedRanges[rangeIdx - 1];
        if (range.start > prevRange.end) {
          contents.push(
            `--- [省略了第 ${prevRange.end + 1} 至 ${range.start} 行] ---`
          );
          lineNumbersList.push(0);
        }
      }
      const lines = range.content.split("\n");
      lines.forEach((_, idx) => {
        lineNumbersList.push(range.start + 1 + idx);
      });
      contents.push(range.content);
    });

    return {
      combinedContent: contents.join("\n"),
      lineIndexToPhysicalLine: lineNumbersList,
    };
  }, [loadedRanges]);

  const loadedRange = useMemo(() => {
    if (loadedRanges.length === 0) return { start: 0, end: 0 };
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    return {
      start: sortedRanges[0].start,
      end: sortedRanges[sortedRanges.length - 1].end,
    };
  }, [loadedRanges]);

  const extensions = useMemo(() => {
    return [
      lineNumbers({
        formatNumber: (n: number) => {
          const physical = lineIndexToPhysicalLine[n - 1];
          if (physical !== undefined && physical > 0) return String(physical);
          return "...";
        },
      }),
      logSyntaxHighlighter,
      buildQueryHighlighter(query, isRegex, caseSensitive),
      pulseLineTheme,
      pulseField,
      search({ top: true }),
      EditorView.updateListener.of((update) => {
        editorViewRef.current = update.view;
      }),
    ];
  }, [lineIndexToPhysicalLine, query, isRegex, caseSensitive]);

  useEffect(() => {
    if (!visible) {
      didScrollRef.current = false;
      return;
    }
    if (didScrollRef.current || !initialLine || loadedRanges.length === 0) return;
    const timer = window.setTimeout(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const docLineIndex = lineIndexToPhysicalLine.findIndex(
        (n) => n === initialLine
      );
      if (docLineIndex < 0) return;
      const cmLine = docLineIndex + 1;
      if (cmLine < 1 || cmLine > view.state.doc.lines) return;
      const line = view.state.doc.line(cmLine);
      view.dispatch({
        selection: { anchor: line.from },
        effects: [
          EditorView.scrollIntoView(line.from, { y: "center" }),
          setPulseLine.of(cmLine),
        ],
      });
      window.setTimeout(() => {
        editorViewRef.current?.dispatch({ effects: setPulseLine.of(null) });
      }, 1400);
      didScrollRef.current = true;
    }, 80);
    return () => window.clearTimeout(timer);
  }, [visible, initialLine, loadedRanges, lineIndexToPhysicalLine, combinedContent]);

  const loadPrevious = () => {
    const newEnd = loadedRange.start;
    const newStart = Math.max(0, newEnd - maxLinesPerLoad);
    if (newStart < loadedRange.start) {
      void fetchContent(
        actualPath,
        newStart,
        newEnd,
        selectedInnerPath || initialInnerPath
      );
    }
  };

  const loadNext = () => {
    const newStart = loadedRange.end;
    if (newStart < totalLines) {
      const newEnd = Math.min(totalLines, newStart + maxLinesPerLoad);
      void fetchContent(
        actualPath,
        newStart,
        newEnd,
        selectedInnerPath || initialInnerPath
      );
    } else {
      message.info("已到达文件末尾");
    }
  };

  const handleJump = async () => {
    if (!jumpLine || jumpLine < 1 || !actualPath) return;
    const start = Math.max(0, jumpLine - 1);
    const end = start + maxLinesPerLoad;
    // If already covered, just scroll
    const covered = loadedRanges.some(
      (r) => jumpLine >= r.start + 1 && jumpLine <= r.end
    );
    if (!covered) {
      didScrollRef.current = false;
      await fetchContent(
        actualPath,
        start,
        end,
        selectedInnerPath || initialInnerPath
      );
    }
    // Force scroll to jumpLine
    didScrollRef.current = false;
    window.setTimeout(() => {
      const view = editorViewRef.current;
      if (!view) return;
      // After fetch, mapping may update on next render; dispatch with approximate
      const targetPhysical = jumpLine;
      const idx = lineIndexToPhysicalLine.findIndex((n) => n === targetPhysical);
      const cmLine = (idx >= 0 ? idx : jumpLine - loadedRange.start - 1) + 1;
      if (cmLine < 1 || cmLine > view.state.doc.lines) return;
      const line = view.state.doc.line(Math.min(cmLine, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: line.from },
        effects: [
          EditorView.scrollIntoView(line.from, { y: "center" }),
          setPulseLine.of(Math.min(cmLine, view.state.doc.lines)),
        ],
      });
      window.setTimeout(() => {
        editorViewRef.current?.dispatch({ effects: setPulseLine.of(null) });
      }, 1400);
      didScrollRef.current = true;
    }, 120);
  };

  return (
    <Modal
      open={visible}
      onCancel={onClose}
      width="80%"
      title={modalTitle}
      footer={
        <Space wrap>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#64748b", fontSize: 12 }}>跳转到行</span>
            <InputNumber
              size="small"
              min={1}
              max={totalLines || undefined}
              value={jumpLine || undefined}
              onChange={(v) => setJumpLine(typeof v === "number" ? v : null)}
              onPressEnter={() => void handleJump()}
            />
            <Button size="small" onClick={() => void handleJump()}>
              Go
            </Button>
          </span>
          <Button onClick={loadPrevious} disabled={loadedRange.start <= 0}>
            加载前1000行
          </Button>
          <Button onClick={loadNext} disabled={loadedRange.end >= totalLines}>
            加载后1000行
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </Space>
      }
      destroyOnClose
    >
      <Spin spinning={loading}>
        {fileInfo?.is_archive && fileInfo.archive_contents && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <strong>压缩包内文件:</strong>
            </div>
            <Select
              style={{ width: "100%" }}
              placeholder="选择要查看的文件"
              value={selectedInnerPath || undefined}
              onChange={(value) => {
                didScrollRef.current = false;
                setSelectedInnerPath(value);
              }}
              options={fileInfo.archive_contents.map((path) => ({
                label: path,
                value: path,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </div>
        )}

        {showLargeFileWarning && (
          <Alert
            message="大文件警告"
            description={`当前文件大小为 ${(
              (fileInfo?.size || 0) /
              (1024 * 1024)
            ).toFixed(2)} MB，加载可能需要一些时间。`}
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {virtualPath && (
          <div style={{ marginBottom: 16 }}>
            行号范围: {loadedRange.start + 1} - {loadedRange.end} / 共{" "}
            {totalLines} 行 (已加载 {loadedRanges.length} 段)
            {fileInfo && !fileInfo.is_archive && (
              <span>
                {" "}
                | 文件大小: {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB
              </span>
            )}
          </div>
        )}

        <CodeMirror
          value={combinedContent}
          height="60vh"
          extensions={extensions}
          readOnly
        />
      </Spin>
    </Modal>
  );
}
