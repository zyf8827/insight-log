import { useState, useEffect, useMemo, useCallback } from 'react';
import { Modal, Spin, message, Alert, Select } from 'antd';
import { EditorView, lineNumbers } from '@codemirror/view';
import { search } from '@codemirror/search';
import CodeMirror from '@uiw/react-codemirror';
import { invoke } from '@tauri-apps/api/core';

type FileViewerFullProps = {
  visible: boolean;
  onClose: () => void;
  filePath: string | null;
  initialLine?: number | null;
};

type LoadedRange = {
  start: number;
  end: number;
  content: string;
};

interface FileInfo {
  size: number;
  is_archive: boolean;
  archive_contents?: string[]; // 压缩文件内的文件列表
}





const FileViewerFull: React.FC<FileViewerFullProps> = ({ visible, onClose, filePath, initialLine = null }) => {
  const [loadedRanges, setLoadedRanges] = useState<LoadedRange[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalLines, setTotalLines] = useState(0);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [showLargeFileWarning, setShowLargeFileWarning] = useState(false);
  const [selectedInnerPath, setSelectedInnerPath] = useState<string | null>(null);
  const maxLinesPerLoad = 10000; // 增加到10000行
  const LARGE_FILE_SIZE = 50 * 1024 * 1024; // 50MB threshold

  const [actualPath, initialInnerPath] = useMemo(() => {
    if (!filePath) return ['', null];
    if (filePath.includes(' → ')) {
      const parts = filePath.split(' → ');
      return [parts[0].trim(), parts[1].trim()];
    }
    return [filePath, null];
  }, [filePath]);

  const modalTitle = useMemo(() => {
    if (!filePath) return '';
    const activeInner = selectedInnerPath || initialInnerPath;
    if (activeInner) {
      return `${actualPath} → ${activeInner}`;
    }
    return actualPath;
  }, [filePath, actualPath, initialInnerPath, selectedInnerPath]);

  // 获取文件信息
  const loadFileInfo = useCallback(async (path: string) => {
    try {
      setLoading(true);
      const info: FileInfo = await invoke('get_file_info', { filePath: path });
      setFileInfo(info);
      
      // 如果是压缩文件，获取其内容列表
      if (info.is_archive) {
        try {
          const contents: string[] = await invoke('get_archive_contents', { archivePath: path });
          // 更新状态，包括压缩包内的文件列表
          setFileInfo(prev => prev ? { ...prev, archive_contents: contents } : null);
          
          const toSelect = initialInnerPath || (contents.length === 1 ? contents[0] : null);
          if (toSelect) {
            setSelectedInnerPath(toSelect);
          }
        } catch (err) {
          console.error('获取压缩文件内容列表失败:', err);
          message.error('获取压缩文件内容列表失败');
        }
      }
      
      // 如果文件很大，显示警告
      if (info.size > LARGE_FILE_SIZE) {
        setShowLargeFileWarning(true);
      } else {
        setShowLargeFileWarning(false);
      }
    } catch (error) {
      console.error('获取文件信息失败:', error);
      message.error('获取文件信息失败');
    } finally {
      setLoading(false);
    }
  }, [initialInnerPath]);

  // 获取文件内容
  const fetchContent = useCallback(async (path: string, startLine: number, endLine: number | null = null, innerPath: string | null = null) => {
    if (!path) return;

    setLoading(true);
    try {
      let result: unknown;
      
      if (fileInfo?.is_archive && innerPath) {
        // 从压缩文件中读取内容
        result = await invoke('read_archive_file_content', {
          archivePath: path,
          innerPath,
          startLine,
          endLine: endLine || null
        });
      } else {
        // 读取普通文件内容
        result = await invoke('read_file_content', {
          filePath: path,
          startLine,
          endLine: endLine || null
        });
      }

      // Ensure result is parsed correctly
      let parsedResult: { content: string; startLine: number; endLine: number; totalLines: number };
      if (typeof result === 'string') {
        parsedResult = JSON.parse(result);
      } else if (typeof result === 'object' && result !== null) {
        parsedResult = result as { content: string; startLine: number; endLine: number; totalLines: number };
      } else {
        throw new Error('Invalid result format from read operation');
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
      
      // 只在初始加载时设置总行数
      if (totalLines === 0) {
        setTotalLines(parsedResult.totalLines);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载文件内容失败';
      message.error(msg);
      console.error('获取文件内容时出错:', err);
    } finally {
      setLoading(false);
    }
  }, [fileInfo, totalLines]);



  // 当选中内部路径变化时，加载其内容
  useEffect(() => {
    if (selectedInnerPath && actualPath && fileInfo?.is_archive) {
      setLoadedRanges([]);
      setTotalLines(0);
      setShowLargeFileWarning(false);
      
      // 加载所选内部文件的前10000行
      void fetchContent(actualPath, 0, maxLinesPerLoad, selectedInnerPath);
    }
  }, [selectedInnerPath, actualPath, fileInfo, fetchContent]);

  // 当组件显示时加载文件信息
  useEffect(() => {
    if (visible && actualPath) {
      // 重置状态
      setLoadedRanges([]);
      setTotalLines(0);
      setFileInfo(null);
      setSelectedInnerPath(null);
      setShowLargeFileWarning(false);
      
      void loadFileInfo(actualPath);
    } else if (!visible) {
      // 组件隐藏时重置状态
      setLoadedRanges([]);
      setTotalLines(0);
      setFileInfo(null);
      setSelectedInnerPath(null);
      setShowLargeFileWarning(false);
    }
  }, [visible, actualPath, loadFileInfo]);

  // 当文件信息加载完成且不是压缩文件时，或者压缩文件中只有一个文件时，加载内容
  useEffect(() => {
    if (fileInfo && !fileInfo.is_archive && actualPath && visible && loadedRanges.length === 0) {
      // 加载普通文件内容，根据是否有初始行号决定加载哪一部分
      if (initialLine !== null && initialLine !== undefined && initialLine > 0) {
        const start = Math.max(0, initialLine - 1);
        const end = Math.min(start + maxLinesPerLoad, Number.MAX_SAFE_INTEGER);
        void fetchContent(actualPath, start, end);
      } else {
        void fetchContent(actualPath, 0, maxLinesPerLoad);
      }
    }
  }, [fileInfo, actualPath, visible, initialLine, loadedRanges.length, fetchContent]);

  // Combine all loaded ranges in order
  const combinedContent = useMemo(() => {
    // Sort ranges by start line and combine them in order
    const sortedRanges = [...loadedRanges].sort((a, b) => a.start - b.start);
    return sortedRanges.map(range => range.content).join('\n');
  }, [loadedRanges]);

  // Create a custom line number extension that shows actual file line numbers
  const extensions = useMemo(() => {
    const baseExtensions = [
      lineNumbers({
        formatNumber: (n: number) => String(n) // 简化行号格式以提升性能
      }),
      // 启用搜索功能，包括 Ctrl+F 快捷键
      search({ top: true })
    ];
    
    // 根据文件大小决定是否启用语法高亮以优化性能 (用户要求禁用高亮)
    // 不添加语法高亮
    // combinedContent.length < 200000 ? javascript({ jsx: true }) : [], // 200KB以下启用语法高亮
    
    baseExtensions.push(
      EditorView.theme({
        // 优化性能的样式
        '&': {
          fontSize: '12px',
        },
        '.cm-content': {
          minHeight: '200px',
          overflowX: 'auto',  // Enable horizontal scrolling for long lines
          whiteSpace: 'pre-wrap',  // Enable line wrapping
          wordWrap: 'break-word',  // Break long words if needed
        },
        '.cm-scroller': {
          lineHeight: '1.2',
        }
      })
    );

    return baseExtensions;
  }, [combinedContent]);

  return (
    <Modal
      open={visible}
      onCancel={onClose}
      width="80%"
      title={modalTitle}
      footer={null}
      destroyOnClose
    >
      <Spin spinning={loading}>
        {fileInfo?.is_archive && fileInfo.archive_contents && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <strong>压缩包内文件:</strong>
            </div>
            <Select
              style={{ width: '100%' }}
              placeholder="选择要查看的文件"
              value={selectedInnerPath || undefined}
              onChange={(value) => setSelectedInnerPath(value)}
              options={fileInfo.archive_contents.map(path => ({ 
                label: path, 
                value: path 
              }))}
            />
          </div>
        )}
        
        {showLargeFileWarning && (
          <Alert
            message="大文件警告"
            description={`当前文件大小为 ${((fileInfo?.size || 0) / (1024 * 1024)).toFixed(2)} MB，加载可能需要一些时间。`}
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        
        {(fileInfo?.is_archive ? selectedInnerPath : filePath) && (
          <div style={{ marginBottom: 16 }}>
            行号范围: 1 - {totalLines || '?'} 行 (已加载 {loadedRanges.length} 段)
            {fileInfo && !fileInfo.is_archive && (
              <span> | 文件大小: {(fileInfo.size / (1024 * 1024)).toFixed(2)} MB</span>
            )}
          </div>
        )}
        
        <CodeMirror
          value={combinedContent}
          height="60vh"
          extensions={extensions}
          readOnly={true}
          theme="light"
          basicSetup={{ 
            lineNumbers: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            foldGutter: false,
            searchKeymap: true, // Enable search keymap (Ctrl+F)
            defaultKeymap: true 
          }}
        />
      </Spin>
    </Modal>
  );
};

export default FileViewerFull;