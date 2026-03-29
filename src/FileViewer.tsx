import { useState, useEffect, useMemo } from 'react';
import { Modal, Spin, message, Button, Space } from 'antd';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { lineNumbers } from '@codemirror/view';
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
          // If already exists, update it
          const updated = [...prev];
          updated[existingIndex] = newRange;
          return updated;
        } else {
          // Otherwise, add the new range
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

    // Clear previous ranges when opening a new file
    setLoadedRanges([]);
    
    // Determine the initial line range to load
    if (initialLine !== null && initialLine > 0) {
      // For search results: load from initialLine - 1, up to initialLine + 999 (1000 lines total)
      const start = Math.max(0, initialLine - 1); // Convert to 0-based and ensure non-negative
      const end = Math.min(start + maxLinesPerLoad, totalLines || start + maxLinesPerLoad);
      void fetchContent(start, end);
    } else {
      // For file list: load first 1000 lines
      void fetchContent(0, maxLinesPerLoad);
    }
  }, [visible, filePath, initialLine, totalLines]);

  useEffect(() => {
    if (!visible) {
      setLoadedRanges([]);
      setTotalLines(0);
    }
  }, [visible]);

  // Combine all loaded ranges in order
  const combinedContent = useMemo(() => {
    // Sort ranges by start line and combine them in order
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    return sortedRanges.map(range => range.content).join('\n');
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

  // Create a custom line number extension that shows actual file line numbers
  const extensions = useMemo(() => {
    // If we only have one range loaded, use custom line numbers starting from the correct line
    if (loadedRanges.length === 1 && loadedRanges[0]) {
      const startLineNum = loadedRanges[0].start + 1; // Convert to 1-based
      return [
        lineNumbers({
          formatNumber: (n: number) => String(n + startLineNum - 1)
        }),
        javascript({ jsx: true })
      ];
    } 
    // For multiple ranges, we keep the default numbering since displaying absolute line numbers 
    // across fragmented content in a single editor view is complex
    return [lineNumbers(), javascript({ jsx: true })];
  }, [loadedRanges]);

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