import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { lineNumbers } from '@codemirror/view';

interface LogLine {
  line_number: number;
  content: string;
  is_match: boolean;
  match_ranges: [number, number][] | null;
}

interface LogViewerProps {
  lines: LogLine[];
  startLine: number;
  endLine: number;
  file_path: string;
}

const LogViewer: React.FC<LogViewerProps> = ({ lines, startLine, endLine, file_path }) => {
  // Combine all lines into a single string for CodeMirror
  const fullContent = useMemo(() => {
    return lines.map(line => line.content).join('\n');
  }, [lines]);

  // Calculate the offset for line numbers to show the actual file line numbers
  const lineOffset = useMemo(() => {
    return startLine - 1;
  }, [startLine]);

  // Create custom line number extension to show actual file line numbers
  const extensions = useMemo(() => {
    return [
      lineNumbers({
        formatNumber: (n: number) => String(n + lineOffset)
      }),
      javascript({ jsx: true })
    ];
  }, [lineOffset]);

  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: '12px', color: '#666' }}>
        显示行号: {startLine} - {endLine} | 文件: {file_path}
      </div>
      <CodeMirror
        value={fullContent}
        height="300px"
        extensions={extensions}
        readOnly
        theme="light"
      />
    </div>
  );
};

export default LogViewer;