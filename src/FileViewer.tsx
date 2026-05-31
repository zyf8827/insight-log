import { useState, useEffect, useMemo } from 'react';
import { Modal, Spin, message, Button, Space } from 'antd';
import CodeMirror from '@uiw/react-codemirror';
import { lineNumbers, EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';

type FileViewerProps = {
  visible: boolean;
  onClose: () => void;
  filePath: string | null;
  initialLine: number | null;
};

type LoadedRange = {
  start: number;
  end: number;
  content: string;
};

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
        const regex = /\b(FATAL|ERROR|SEVERE)\b|\b(WARN|WARNING)\b|\b(INFO)\b|\b(DEBUG|TRACE)\b/gi;
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
  {
    decorations: (v) => v.decorations,
  }
);

export default function FileViewer({ visible, onClose, filePath, initialLine }: FileViewerProps) {
  const [loadedRanges, setLoadedRanges] = useState<LoadedRange[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalLines, setTotalLines] = useState(0);
  const maxLinesPerLoad = 1000;
  
  const modalTitle = useMemo(() => {
    if (!filePath) {
      return '';
    }
    return initialLine ? `${filePath} (第 ${initialLine} 行)` : filePath;
  }, [filePath, initialLine]);

  // Fetch file content with line range via Tauri command
  const fetchContent = async (startLine: number, endLine: number | null = null) => {
    if (!filePath) {
      return;
    }

    setLoading(true);
    try {
      // Use Tauri command to read file content
      const result: unknown = await invoke('read_file_content', {
        filePath,
        startLine,
        endLine: endLine || null
      });

      // Ensure result is parsed correctly
      let parsedResult: { content: string; startLine: number; endLine: number; totalLines: number };
      if (typeof result === 'string') {
        parsedResult = JSON.parse(result);
      } else if (typeof result === 'object' && result !== null) {
        parsedResult = result as { content: string; startLine: number; endLine: number; totalLines: number };
      } else {
        throw new Error('Invalid result format from read_file_content');
      }

      const newRange: LoadedRange = {
        start: parsedResult.startLine,
        end: parsedResult.endLine,
        content: parsedResult.content
      };
      
      setLoadedRanges(prev => {
        // Check if this range is already loaded (avoid duplicates)
        const existingIndex = prev.findIndex(range => 
          range.start === newRange.start && range.end === newRange.end
        );
        
        if (existingIndex !== -1) {
          const updated = [...prev];
          updated[existingIndex] = newRange;
          return updated;
        } else {
          return [...prev, newRange];
        }
      });
      
      setTotalLines(parsedResult.totalLines);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载文件内容失败';
      message.error(msg);
      console.error('获取文件内容时出错:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!visible || !filePath) {
      return;
    }

    setLoadedRanges([]);
    
    if (initialLine !== null && initialLine > 0) {
      const start = Math.max(0, initialLine - 1);
      const end = start + maxLinesPerLoad;
      void fetchContent(start, end);
    } else {
      void fetchContent(0, maxLinesPerLoad);
    }
  }, [visible, filePath, initialLine]);

  useEffect(() => {
    if (!visible) {
      setLoadedRanges([]);
      setTotalLines(0);
    }
  }, [visible]);

  // Combine loaded ranges and calculate physical line mapping
  const { combinedContent, lineIndexToPhysicalLine } = useMemo(() => {
    if (loadedRanges.length === 0) {
      return { combinedContent: '', lineIndexToPhysicalLine: [] as number[] };
    }
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    const lineNumbersList: number[] = [];
    const contents: string[] = [];

    sortedRanges.forEach((range, rangeIdx) => {
      if (rangeIdx > 0) {
        const prevRange = sortedRanges[rangeIdx - 1];
        if (range.start > prevRange.end) {
          contents.push(`--- [省略了第 ${prevRange.end + 1} 至 ${range.start} 行] ---`);
          lineNumbersList.push(0);
        }
      }
      const lines = range.content.split('\n');
      lines.forEach((_, idx) => {
        lineNumbersList.push(range.start + 1 + idx);
      });
      contents.push(range.content);
    });

    return {
      combinedContent: contents.join('\n'),
      lineIndexToPhysicalLine: lineNumbersList,
    };
  }, [loadedRanges]);

  // Calculate the full range of loaded content
  const loadedRange = useMemo(() => {
    if (loadedRanges.length === 0) return { start: 0, end: 0 };
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    return {
      start: sortedRanges[0].start,
      end: sortedRanges[sortedRanges.length - 1].end
    };
  }, [loadedRanges]);

  // Create a custom line number extension that ALWAYS shows actual physical file line numbers
  const extensions = useMemo(() => {
    return [
      lineNumbers({
        formatNumber: (n: number) => {
          const physical = lineIndexToPhysicalLine[n - 1];
          if (physical !== undefined && physical > 0) {
            return String(physical);
          }
          return '...';
        },
      }),
      logSyntaxHighlighter,
    ];
  }, [lineIndexToPhysicalLine]);

  // Load previous 1000 lines
  const loadPrevious = () => {
    const newEnd = loadedRange.start; // Load content that ends where current loaded content starts
    const newStart = Math.max(0, newEnd - maxLinesPerLoad);
    
    if (newStart < loadedRange.start) { // Only load if there's content to load before the current range
      void fetchContent(newStart, newEnd);
    }
  };

  // Load next 1000 lines
  const loadNext = () => {
    const newStart = loadedRange.end; // Load content that starts where current loaded content ends
    
    if (newStart < totalLines) { // Only load if there's content after the current range
      const newEnd = Math.min(totalLines, newStart + maxLinesPerLoad);
      void fetchContent(newStart, newEnd);
    } else {
      message.info('已到达文件末尾');
    }
  };

  return (
    <Modal
      open={visible}
      onCancel={onClose}
      width="80%"
      title={modalTitle}
      footer={
        <Space>
          <Button 
            onClick={loadPrevious} 
            disabled={loadedRange.start <= 0}
          >
            加载前1000行
          </Button>
          <Button 
            onClick={loadNext} 
            disabled={loadedRange.end >= totalLines}
          >
            加载后1000行
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </Space>
      }
      destroyOnClose
    >
      <Spin spinning={loading}>
        <div style={{ marginBottom: 16 }}>
          行号范围: {loadedRange.start + 1} - {loadedRange.end} / 共 {totalLines} 行 (已加载 {loadedRanges.length} 段)
        </div>
        <CodeMirror
          value={combinedContent}
          height="60vh"
          extensions={extensions} // Use the dynamically created extension
          readOnly
        />
      </Spin>
    </Modal>
  );
}